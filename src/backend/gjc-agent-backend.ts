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
  QueuedMessage,
  SubagentSnapshot,
} from "../../shared/agent-contract";
import type { ForkSessionInput } from "../../shared/agent-contract";

export class GjcAgentBackend implements AgentBackend {
  private readonly bridge: GjcDesktopBridge;
  private readonly listeners = new Set<(event: AgentEvent) => void>();
  private readonly unsubscribeBridge: () => void;
  private readonly pendingDeltas = new Map<
    string,
    Extract<AgentEvent, { type: "message.delta" | "thought.delta" }>
  >();
  private flushTimer?: ReturnType<typeof setTimeout>;
  private disposed = false;

  constructor(bridge: GjcDesktopBridge) {
    this.bridge = bridge;
    this.unsubscribeBridge = bridge.onEvent((event) => {
      this.receiveEvent(event);
    });
  }

  private receiveEvent(event: AgentEvent): void {
    if (event.type !== "message.delta" && event.type !== "thought.delta") {
      this.flushPendingDeltas();
      this.emit(event);
      return;
    }

    const itemId =
      event.type === "message.delta" ? event.messageId : event.thoughtId;
    const key = `${event.type}:${event.sessionId}:${itemId}`;
    const pending = this.pendingDeltas.get(key);
    const combined =
      pending && pending.type === event.type
        ? { ...event, delta: pending.delta + event.delta }
        : event;
    this.pendingDeltas.set(key, combined);

    if (!event.streaming) {
      this.flushPendingDeltas();
      return;
    }
    if (this.flushTimer) return;
    // ACP can deliver many tiny chunks per frame. Rendering every chunk makes the
    // desktop fall behind the CLI, especially while a long Markdown response grows.
    this.flushTimer = setTimeout(() => this.flushPendingDeltas(), 16);
  }

  private flushPendingDeltas(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    const events = [...this.pendingDeltas.values()];
    this.pendingDeltas.clear();
    for (const event of events) this.emit(event);
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

  deleteSession(sessionId: string): Promise<void> {
    return this.bridge.deleteSession(sessionId);
  }

  getTranscript(sessionId: string): Promise<TranscriptItem[]> {
    return this.bridge.getTranscript(sessionId);
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

  sendMessage(sessionId: string, input: MessageInput): Promise<void> {
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
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    this.pendingDeltas.clear();
    this.listeners.clear();
  }
}
