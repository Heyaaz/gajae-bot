import type {
  AgentEvent,
  AgentSession,
  BackendConnection,
  CreateSessionInput,
  MessageInput,
  ToolDecision,
  TranscriptChange,
  TranscriptItem,
} from "./types";
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
  QuestionSubmission,
  SubagentSnapshot,
} from "../../shared/agent-contract";
import type { ForkSessionInput } from "../../shared/agent-contract";
import type { RemoteAccessBridge } from "../../shared/remote-protocol";

export interface AgentBackend {
  /**
   * Present only on a backend reached through the remote access server. The shell
   * uses it to show remote connection state and to withhold control affordances a
   * view-only device may not use.
   */
  readonly remoteAccess?: RemoteAccessBridge;
  getConnection(): Promise<BackendConnection>;
  listSessions(): Promise<AgentSession[]>;
  createSession(input: CreateSessionInput): Promise<AgentSession>;
  forkSession(input: ForkSessionInput): Promise<AgentSession>;
  resumeSession(sessionId: string): Promise<AgentSession>;
  listHistorySessions(): Promise<HistorySession[]>;
  openHistorySession(sessionId: string): Promise<AgentSession>;
  renameSession(sessionId: string, title: string): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
  hideSession(sessionId: string): Promise<void>;
  getTranscript(sessionId: string): Promise<TranscriptItem[]>;
  /**
   * Safety-net read that returns changed rows when the caller already has the
   * conversation. Omitted backends still use `getTranscript`.
   */
  getTranscriptChanges?(sessionId: string): Promise<TranscriptChange>;
  /**
   * Cheap revision of the selected transcript. The same value means the body has
   * not changed, so the safety net skips the read. A backend that omits it falls
   * back to reading the body and keeping the previous state when the rows match.
   */
  getTranscriptRevision?(sessionId: string): Promise<string | undefined>;
  /**
   * Sessions a replay gap may reload: the one on screen and any transcript this
   * window already cached. Unset means every session, which is the fallback for a
   * caller that has not reported a cache yet.
   */
  watchTranscripts?(sessionIds: readonly string[]): void;
  /** Loads command/todo context once when a session is opened, never on a poll. */
  refreshSessionContext?(sessionId: string): Promise<void>;
  setSessionConfig(
    sessionId: string,
    configId: string,
    value: string,
  ): Promise<void>;
  cycleThinking(sessionId: string): Promise<string | undefined>;
  compactSession(sessionId: string): Promise<void>;
  queueFollowUp(sessionId: string, input: MessageInput): Promise<void>;
  listQueuedMessages(sessionId: string): Promise<QueuedMessage[]>;
  flushQueuedNow(sessionId: string): Promise<boolean>;
  steerSession(sessionId: string, input: MessageInput): Promise<void>;
  sendMessage(sessionId: string, input: MessageInput): Promise<MessageDelivery>;
  cancelRun(sessionId: string): Promise<void>;
  resolveToolCall(toolId: string, decision: ToolDecision): Promise<void>;
  answerQuestion(
    sessionId: string,
    gateId: string,
    submission: QuestionSubmission,
    idempotencyKey: string,
  ): Promise<void>;
  markSessionRead(sessionId: string): Promise<void>;
  getDiff(sessionId: string): Promise<DiffSnapshot>;
  readArtifact(sessionId: string, artifactId: string): Promise<ArtifactContent>;
  previewFile(
    sessionId: string,
    filePath: string,
  ): Promise<GeneratedFilePreview>;
  getGoal(sessionId: string): Promise<GoalSnapshot>;
  operateGoal(
    sessionId: string,
    operation: GoalOperation,
  ): Promise<GoalSnapshot>;
  listSubagents(sessionId: string): Promise<SubagentSnapshot[]>;
  refreshRuntimeState(sessionId: string): Promise<EffectiveRuntimeState>;
  reconnect(): Promise<BackendConnection>;
  getGitStatus(sessionId: string): Promise<GitStatusSnapshot>;
  stageFiles(sessionId: string, paths: string[]): Promise<GitStatusSnapshot>;
  unstageFiles(sessionId: string, paths: string[]): Promise<GitStatusSnapshot>;
  commitChanges(sessionId: string, message: string): Promise<GitStatusSnapshot>;
  pushChanges(sessionId: string): Promise<GitStatusSnapshot>;
  subscribe(listener: (event: AgentEvent) => void): () => void;
  dispose(): void;
}
