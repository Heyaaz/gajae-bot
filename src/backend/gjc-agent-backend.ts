import type { AgentBackend } from "./agent-backend";
import type {
  AgentEvent,
  AgentSession,
  BackendConnection,
  CreateSessionInput,
  MessageInput,
  GjcDesktopBridge,
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
  HistorySession,
  MessageDelivery,
  QueuedMessage,
  SubagentSnapshot,
} from "../../shared/agent-contract";
import type { ForkSessionInput } from "../../shared/agent-contract";
import { StreamDeltaCoalescer } from "./stream-delta-coalescer";

export class GjcAgentBackend implements AgentBackend {
  private readonly bridge: GjcDesktopBridge;
  private readonly listeners = new Set<(event: AgentEvent) => void>();
  private readonly unsubscribeBridge: () => void;
  private readonly coalescer = new StreamDeltaCoalescer((event) => {
    this.emit(event);
  });
  private disposed = false;

  constructor(bridge: GjcDesktopBridge) {
    this.bridge = bridge;
    this.unsubscribeBridge = bridge.onEvent((event) => {
      this.coalescer.receive(event);
    });
  }

  private emit(event: AgentEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  getConnection(): Promise<BackendConnection> {
    return this.bridge.getConnection();
  }

  listSessions(): Promise<AgentSession[]> {
    return this.bridge.listSessions();
  }

  createSession(input: CreateSessionInput): Promise<AgentSession> {
    if (input.runtime !== "gjc")
      return Promise.reject(new Error("Hermes is not connected yet"));
    return this.bridge.createSession(input);
  }
  forkSession(input: ForkSessionInput): Promise<AgentSession> {
    return this.bridge.forkSession(input);
  }

  renameSession(sessionId: string, title: string): Promise<void> {
    return this.bridge.renameSession(sessionId, title);
  }

  resumeSession(sessionId: string): Promise<AgentSession> {
    return this.bridge.resumeSession(sessionId);
  }

  listHistorySessions(): Promise<HistorySession[]> {
    return this.bridge.listHistorySessions();
  }

  openHistorySession(sessionId: string): Promise<AgentSession> {
    return this.bridge.openHistorySession(sessionId);
  }

  deleteSession(sessionId: string): Promise<void> {
    return this.bridge.deleteSession(sessionId);
  }

  hideSession(sessionId: string): Promise<void> {
    return this.bridge.hideSession(sessionId);
  }

  getTranscript(sessionId: string): Promise<TranscriptItem[]> {
    return this.bridge.getTranscript(sessionId);
  }

  getTranscriptRevision(sessionId: string): Promise<string | undefined> {
    return this.bridge.getTranscriptRevision(sessionId);
  }

  refreshSessionContext(sessionId: string): Promise<void> {
    return this.bridge.refreshSessionContext(sessionId);
  }

  setSessionConfig(
    sessionId: string,
    configId: string,
    value: string,
  ): Promise<void> {
    return this.bridge.setSessionConfig(sessionId, configId, value);
  }

  cycleThinking(sessionId: string): Promise<string | undefined> {
    return this.bridge.cycleThinking(sessionId);
  }

  compactSession(sessionId: string): Promise<void> {
    return this.bridge.compactSession(sessionId);
  }

  queueFollowUp(sessionId: string, input: MessageInput): Promise<void> {
    return this.bridge.queueFollowUp(sessionId, input);
  }

  listQueuedMessages(sessionId: string): Promise<QueuedMessage[]> {
    return this.bridge.listQueuedMessages(sessionId);
  }

  flushQueuedNow(sessionId: string): Promise<boolean> {
    return this.bridge.flushQueuedNow(sessionId);
  }

  steerSession(sessionId: string, input: MessageInput): Promise<void> {
    return this.bridge.steerSession(sessionId, input);
  }

  sendMessage(
    sessionId: string,
    input: MessageInput,
  ): Promise<MessageDelivery> {
    return this.bridge.sendMessage(sessionId, input);
  }

  cancelRun(sessionId: string): Promise<void> {
    return this.bridge.cancelRun(sessionId);
  }

  resolveToolCall(toolId: string, decision: ToolDecision): Promise<void> {
    return this.bridge.resolveToolCall(toolId, decision);
  }

  markSessionRead(sessionId: string): Promise<void> {
    return this.bridge.markSessionRead(sessionId);
  }
  getDiff(sessionId: string): Promise<DiffSnapshot> {
    return this.bridge.getDiff(sessionId);
  }
  readArtifact(
    sessionId: string,
    artifactId: string,
  ): Promise<ArtifactContent> {
    return this.bridge.readArtifact(sessionId, artifactId);
  }
  previewFile(
    sessionId: string,
    filePath: string,
  ): Promise<GeneratedFilePreview> {
    return this.bridge.previewFile(sessionId, filePath);
  }
  getGoal(sessionId: string): Promise<GoalSnapshot> {
    return this.bridge.getGoal(sessionId);
  }
  operateGoal(
    sessionId: string,
    operation: GoalOperation,
  ): Promise<GoalSnapshot> {
    return this.bridge.operateGoal(sessionId, operation);
  }
  listSubagents(sessionId: string): Promise<SubagentSnapshot[]> {
    return this.bridge.listSubagents(sessionId);
  }
  refreshRuntimeState(sessionId: string): Promise<EffectiveRuntimeState> {
    return this.bridge.refreshRuntimeState(sessionId);
  }
  reconnect(): Promise<BackendConnection> {
    return this.bridge.reconnect();
  }
  getGitStatus(sessionId: string): Promise<GitStatusSnapshot> {
    return this.bridge.getGitStatus(sessionId);
  }
  stageFiles(sessionId: string, paths: string[]): Promise<GitStatusSnapshot> {
    return this.bridge.stageFiles(sessionId, paths);
  }
  unstageFiles(sessionId: string, paths: string[]): Promise<GitStatusSnapshot> {
    return this.bridge.unstageFiles(sessionId, paths);
  }
  commitChanges(
    sessionId: string,
    message: string,
  ): Promise<GitStatusSnapshot> {
    return this.bridge.commitChanges(sessionId, message);
  }
  pushChanges(sessionId: string): Promise<GitStatusSnapshot> {
    return this.bridge.pushChanges(sessionId);
  }

  subscribe(listener: (event: AgentEvent) => void): () => void {
    if (this.disposed) throw new Error("GJC backend is disposed");
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeBridge();
    this.coalescer.dispose();
    this.listeners.clear();
  }
}
