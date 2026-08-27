import type {
  AgentEvent,
  AgentSession,
  BackendConnection,
  CreateSessionInput,
  MessageInput,
  ToolDecision,
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
  QueuedMessage,
  SubagentSnapshot,
} from "../../shared/agent-contract";
import type { ForkSessionInput } from "../../shared/agent-contract";

export interface AgentBackend {
  getConnection(): Promise<BackendConnection>;
  listSessions(): Promise<AgentSession[]>;
  createSession(input: CreateSessionInput): Promise<AgentSession>;
  forkSession(input: ForkSessionInput): Promise<AgentSession>;
  renameSession(sessionId: string, title: string): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
  getTranscript(sessionId: string): Promise<TranscriptItem[]>;
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
  sendMessage(sessionId: string, input: MessageInput): Promise<void>;
  cancelRun(sessionId: string): Promise<void>;
  resolveToolCall(toolId: string, decision: ToolDecision): Promise<void>;
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
