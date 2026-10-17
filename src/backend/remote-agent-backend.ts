import type {
  ArtifactContent,
  DiffSnapshot,
  EffectiveRuntimeState,
  GeneratedFilePreview,
  GitStatusSnapshot,
  GoalOperation,
  GoalSnapshot,
  HistorySession,
  MessageDelivery,
  QueuedMessage,
  SubagentSnapshot,
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

/**
 * The browser's real backend.
 *
 * It speaks to the host over the remote API instead of faking a runtime, which
 * is what the browser used to do. Everything the remote surface does not expose
 * (creating sessions, deletion, compaction, git writes, file previews) fails
 * with a reason instead of an empty result, so a phone never looks like it did
 * something the host never did.
 */

const DESKTOP_ONLY = "이 작업은 Gajae 데스크톱 앱에서만 할 수 있습니다.";

export class RemoteAgentBackend implements AgentBackend {
  readonly client: RemoteClient;
  readonly remoteAccess: RemoteAccessBridge;
  private readonly listeners = new Set<(event: AgentEvent) => void>();

  constructor(options: RemoteClientOptions = {}) {
    this.client = new RemoteClient({
      ...options,
      onEvent: (event) => this.emit(event),
      onResync: () => {
        void this.reconcileReplayGap();
      },
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

  private emit(event: AgentEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private async refreshSnapshot(): Promise<void> {
    await this.client.snapshot().catch(() => undefined);
  }

  private async reconcileReplayGap(): Promise<void> {
    const snapshot = await this.client.snapshot().catch(() => undefined);
    if (!snapshot) return;
    await Promise.all(snapshot.sessions.map(async (session) => {
      const items = await this.client.transcript(session.id).catch(() => undefined);
      if (items) this.emit({ type: "transcript.synced", sessionId: session.id, items: items as TranscriptItem[] });
    }));
  }

  async getConnection(): Promise<BackendConnection> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const snapshot = await this.client.snapshot();
        return snapshot.connection;
      } catch (error) {
        if (attempt === 1) throw error;
      }
    }
    throw new Error("호스트에 연결할 수 없습니다.");
  }

  async listSessions(): Promise<AgentSession[]> {
    const snapshot = await this.client.snapshot();
    return snapshot.sessions;
  }

  getTranscript(sessionId: string): Promise<TranscriptItem[]> {
    return this.client.transcript(sessionId) as Promise<TranscriptItem[]>;
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
    this.client.dispose();
    this.listeners.clear();
  }

  private async desktopOnly<T>(): Promise<T> {
    throw new Error(DESKTOP_ONLY);
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
