import {
  eventSessionId,
  type ArtifactContent,
  type DiffSnapshot,
  type EffectiveRuntimeState,
  type GeneratedFilePreview,
  type GitStatusSnapshot,
  type GoalOperation,
  type GoalSnapshot,
  type HistorySession,
  type MessageDelivery,
  type QueuedMessage,
  type SubagentSnapshot,
} from "../../shared/agent-contract";
import type { ForkSessionInput } from "../../shared/agent-contract";
import type { RemoteAccessBridge, RemoteClientStatus } from "../../shared/remote-protocol";
import type { AgentBackend } from "./agent-backend";
import type {
  AgentEvent,
  AgentSession,
  BackendConnection,
  CreateSessionInput,
  MessageInput,
  ToolDecision,
  TranscriptItem,
} from "./types";
import { RemoteClient, type RemoteClientOptions } from "../remote/client";
import { StreamDeltaCoalescer } from "./stream-delta-coalescer";
import { t } from "../i18n";


/**
 * The browser's real backend.
 *
 * It speaks to the host over the remote API instead of faking a runtime, which
 * is what the browser used to do. Everything the remote surface does not expose
 * (creating sessions, deletion, compaction, git writes, file previews) fails
 * with a reason instead of an empty result, so a phone never looks like it did
 * something the host never did.
 */

function desktopOnlyError(): string {
  return t("이 작업은 Gajae 데스크톱 앱에서만 할 수 있습니다.");
}

export class RemoteAgentBackend implements AgentBackend {
  readonly client: RemoteClient;
  readonly remoteAccess: RemoteAccessBridge;
  private readonly listeners = new Set<(event: AgentEvent) => void>();
  /** Same 16ms join the desktop uses, so a remote chunk does not parse on its own. */
  private readonly coalescer = new StreamDeltaCoalescer((event) => {
    this.publish(event);
  });

  private lastConnection?: BackendConnection;
  private replayRepair?: Promise<void>;
  private repairRequested = false;
  /**
   * Sessions the shell is showing or has cached. A gap reloads only these.
   * Unset until the shell reports, so a repair that races the first paint still
   * covers every session in the snapshot.
   */
  private watchedTranscriptIds?: ReadonlySet<string>;
  private watchedTranscriptKey?: string;

  constructor(options: RemoteClientOptions = {}) {
    this.client = new RemoteClient({
      ...options,
      onEvent: (event) => this.ingest(event),
      onResync: () => this.requestReplayRepair(),
    });
    this.remoteAccess = {
      getStatus: async () => this.client.getStatus(),
      subscribe: (listener: (status: RemoteClientStatus) => void) =>
        this.client.subscribe(listener),
      pair: async (code: string) => {
        await this.client.pair(code);
        await this.refreshSnapshot();
        this.client.startRealtime();
      },
      forget: () => {
        this.client.forget();
      },
      refresh: async () => {
        await this.refreshSnapshot();
        this.client.startRealtime();
      },
    };
    this.client.startRealtime();
  }

  /** Bumped by every live event, so a replay read can see whether it went stale. */
  private readonly eventVersions = new Map<string, number>();

  /**
   * Counts the event as soon as it arrives, then publishes text on the frame clock.
   *
   * Replay repair treats any live event during a transcript read as stale. Waiting
   * to count until the joined delta is published would let that read land, and the
   * delta that followed would append onto the snapshot it had just replaced.
   */
  private ingest(event: AgentEvent): void {
    const sessionId = eventSessionId(event);
    if (sessionId)
      this.eventVersions.set(
        sessionId,
        (this.eventVersions.get(sessionId) ?? 0) + 1,
      );
    this.coalescer.receive(event);
  }

  private publish(event: AgentEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private async refreshSnapshot(): Promise<void> {
    await this.client.snapshot().catch(() => undefined);
  }

  /**
   * Repairs replay gaps one at a time.
   *
   * A gap that arrives while a repair is already reading marks another round
   * instead of being ignored, and a failed round is retried before the incomplete
   * cache is reported: a host that is merely busy should not look disconnected.
   */
  private requestReplayRepair(): void {
    this.repairRequested = true;
    if (this.replayRepair) return;
    this.replayRepair = this.reconcileReplayGap().finally(() => {
      this.replayRepair = undefined;
      if (this.repairRequested) this.requestReplayRepair();
    });
  }

  private async reconcileReplayGap(): Promise<void> {
    while (this.repairRequested) {
      this.repairRequested = false;
      if (await this.repairReplayOnce()) continue;
      // The live stream may still be delivering events, but the cache cannot be
      // trusted to contain the missed window. Say so instead of reporting success.
      this.reportIncompleteRepair();
      return;
    }
  }

  private async repairReplayOnce(): Promise<boolean> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const snapshot = await this.client.snapshot().catch(() => undefined);
      if (snapshot) {
        this.lastConnection = snapshot.connection;
        const watched = this.watchedTranscriptIds;
        const sessions = watched
          ? snapshot.sessions.filter((session) => watched.has(session.id))
          : snapshot.sessions;
        const applied = await Promise.all(
          sessions.map(async (session) => {
            // A transcript read can take long enough for the live stream to deliver
            // newer deltas. Replacing the cache with that older read erased them, so
            // a read is only applied when its session saw no live event meanwhile.
            const version = this.eventVersions.get(session.id) ?? 0;
            const items = await this.client.transcript(session.id).catch(() => undefined);
            if (!items) return false;
            // Discarding the stale read is not a repair. Leave the session
            // unrepaired so this attempt fails and retries; treating it as applied
            // reported success while the gap's history was still missing.
            if ((this.eventVersions.get(session.id) ?? 0) !== version) return false;
            this.ingest({
              type: "transcript.synced",
              sessionId: session.id,
              items: items as TranscriptItem[],
            });
            return true;
          }),
        );
        if (applied.every(Boolean)) return true;
      }
      if (attempt < 2)
        await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
    }
    return false;
  }

  private reportIncompleteRepair(): void {
    const connection = this.lastConnection;
    if (!connection) return;
    this.ingest({
      type: "connection.updated",
      connection: {
        ...connection,
        state: "error",
        detail:
          t("원격 대화 동기화에 실패했습니다. 다시 연결한 뒤 대화를 확인해 주세요."),
      },
    });
  }

  async getConnection(): Promise<BackendConnection> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const snapshot = await this.client.snapshot();
        this.lastConnection = snapshot.connection;
        return snapshot.connection;
      } catch (error) {
        if (attempt === 1) throw error;
      }
    }
    throw new Error(t("호스트에 연결할 수 없습니다."));
  }

  async listSessions(): Promise<AgentSession[]> {
    const snapshot = await this.client.snapshot();
    this.lastConnection = snapshot.connection;
    return snapshot.sessions;
  }

  getTranscript(sessionId: string): Promise<TranscriptItem[]> {
    return this.client.transcript(sessionId) as Promise<TranscriptItem[]>;
  }

  getTranscriptRevision(sessionId: string): Promise<string | undefined> {
    return this.client.transcriptRevision(sessionId);
  }

  watchTranscripts(sessionIds: readonly string[]): void {
    const key = sessionIds.join("\0");
    if (key === this.watchedTranscriptKey) return;
    this.watchedTranscriptKey = key;
    this.watchedTranscriptIds = new Set(sessionIds);
  }

  async refreshSessionContext(sessionId: string): Promise<void> {
    await this.client.context(sessionId);
  }

  async listHistorySessions(): Promise<HistorySession[]> {
    return (await this.client.historySessions()) as HistorySession[];
  }

  async listQueuedMessages(sessionId: string): Promise<QueuedMessage[]> {
    return (await this.client.queued(sessionId)) as QueuedMessage[];
  }

  async getGoal(sessionId: string): Promise<GoalSnapshot> {
    return (await this.client.goal(sessionId)) as GoalSnapshot;
  }

  async listSubagents(sessionId: string): Promise<SubagentSnapshot[]> {
    return (await this.client.subagents(sessionId)) as SubagentSnapshot[];
  }

  async getGitStatus(sessionId: string): Promise<GitStatusSnapshot> {
    return (await this.client.gitStatus(sessionId)) as GitStatusSnapshot;
  }

  async getDiff(sessionId: string): Promise<DiffSnapshot> {
    return (await this.client.diff(sessionId)) as DiffSnapshot;
  }

  async readArtifact(sessionId: string, artifactId: string): Promise<ArtifactContent> {
    return (await this.client.artifact(sessionId, artifactId)) as ArtifactContent;
  }

  async sendMessage(sessionId: string, input: MessageInput): Promise<MessageDelivery> {
    return this.client.sendMessage(sessionId, input);
  }

  async steerSession(sessionId: string, input: MessageInput): Promise<void> {
    await this.client.steer(sessionId, input);
  }

  async queueFollowUp(sessionId: string, input: MessageInput): Promise<void> {
    await this.client.queueFollowUp(sessionId, input);
  }

  async flushQueuedNow(sessionId: string): Promise<boolean> {
    return this.client.flushFollowUps(sessionId);
  }

  async cancelRun(sessionId: string): Promise<void> {
    await this.client.cancelRun(sessionId);
  }

  async resolveToolCall(toolId: string, decision: ToolDecision): Promise<void> {
    await this.client.resolveToolCall(toolId, decision.optionId);
  }

  async markSessionRead(sessionId: string): Promise<void> {
    await this.client.markRead(sessionId);
  }

  async reconnect(): Promise<BackendConnection> {
    await this.client.resume();
    return this.getConnection();
  }

  subscribe(listener: (event: AgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.coalescer.dispose();
    this.client.dispose();
    this.listeners.clear();
  }

  private async desktopOnly<T>(): Promise<T> {
    throw new Error(desktopOnlyError());
  }

  createSession(_input: CreateSessionInput): Promise<AgentSession> {
    return this.desktopOnly();
  }

  forkSession(_input: ForkSessionInput): Promise<AgentSession> {
    return this.desktopOnly();
  }

  resumeSession(_sessionId: string): Promise<AgentSession> {
    return this.desktopOnly();
  }

  openHistorySession(_sessionId: string): Promise<AgentSession> {
    return this.desktopOnly();
  }

  renameSession(_sessionId: string, _title: string): Promise<void> {
    return this.desktopOnly();
  }

  deleteSession(_sessionId: string): Promise<void> {
    return this.desktopOnly();
  }

  hideSession(_sessionId: string): Promise<void> {
    return this.desktopOnly();
  }

  setSessionConfig(_sessionId: string, _configId: string, _value: string): Promise<void> {
    return this.desktopOnly();
  }

  cycleThinking(_sessionId: string): Promise<string | undefined> {
    return this.desktopOnly();
  }

  compactSession(_sessionId: string): Promise<void> {
    return this.desktopOnly();
  }

  previewFile(_sessionId: string, _filePath: string): Promise<GeneratedFilePreview> {
    return this.desktopOnly();
  }

  operateGoal(_sessionId: string, _operation: GoalOperation): Promise<GoalSnapshot> {
    return this.desktopOnly();
  }

  refreshRuntimeState(_sessionId: string): Promise<EffectiveRuntimeState> {
    return this.desktopOnly();
  }

  stageFiles(_sessionId: string, _paths: string[]): Promise<GitStatusSnapshot> {
    return this.desktopOnly();
  }

  unstageFiles(_sessionId: string, _paths: string[]): Promise<GitStatusSnapshot> {
    return this.desktopOnly();
  }

  commitChanges(_sessionId: string, _message: string): Promise<GitStatusSnapshot> {
    return this.desktopOnly();
  }

  pushChanges(_sessionId: string): Promise<GitStatusSnapshot> {
    return this.desktopOnly();
  }
}
