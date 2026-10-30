import type { AgentBackend } from "./agent-backend";
import type {
  AgentEvent,
  AgentSession,
  BackendConnection,
  CreateSessionInput,
  MessageInput,
  GjcDesktopBridge,
  ToolDecision,
  TranscriptChange,
  TranscriptItem,
  TranscriptPage,
  TranscriptPageRequest,
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
import {
  isTerminalSessionId,
  type TerminalDesktopBridge,
} from "../../shared/terminal-ipc";
import { StreamDeltaCoalescer } from "./stream-delta-coalescer";

export class GjcAgentBackend implements AgentBackend {
  private readonly bridge: GjcDesktopBridge;
  private readonly terminal: TerminalDesktopBridge | undefined;
  private readonly listeners = new Set<(event: AgentEvent) => void>();
  private readonly unsubscribeBridge: () => void;
  private readonly coalescer = new StreamDeltaCoalescer((event) => {
    this.emit(event);
  });
  private disposed = false;

  /**
   * Terminal sessions live in the app, not in GJC, so their list, rename, and
   * delete go to the terminal bridge; every other call is a GJC session's.
   */
  constructor(bridge: GjcDesktopBridge, terminal?: TerminalDesktopBridge) {
    this.bridge = bridge;
    this.terminal = terminal;
    this.unsubscribeBridge = bridge.onEvent((event) => {
      this.coalescer.receive(event);
    });
  }

  get terminalSessions(): boolean {
    return Boolean(this.terminal);
  }

  private emit(event: AgentEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  getConnection(): Promise<BackendConnection> {
    return this.bridge.getConnection();
  }

  async listSessions(): Promise<AgentSession[]> {
    const [sessions, terminals] = await Promise.all([
      this.bridge.listSessions(),
      this.terminal?.listSessions().catch(() => []) ?? [],
    ]);
    return [...sessions, ...terminals];
  }

  createSession(input: CreateSessionInput): Promise<AgentSession> {
    if (input.runtime === "terminal") {
      if (!this.terminal) return Promise.reject(new Error("Terminal sessions need the desktop app"));
      return this.terminal.createSession({ title: input.title ?? "", workspace: input.workspace });
    }
    if (input.runtime !== "gjc")
      return Promise.reject(new Error("Hermes is not connected yet"));
    return this.bridge.createSession(input);
  }
  forkSession(input: ForkSessionInput): Promise<AgentSession> {
    return this.bridge.forkSession(input);
  }

  renameSession(sessionId: string, title: string): Promise<void> {
    if (this.terminal && isTerminalSessionId(sessionId))
      return this.terminal.renameSession(sessionId, title);
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

  confirmSessionRemoval(sessionId: string, action: "delete" | "hide"): Promise<boolean> {
    // A terminal session has no history to keep, so hiding one is deleting it.
    if (this.terminal && isTerminalSessionId(sessionId))
      return this.terminal.confirmSessionRemoval(sessionId);
    return this.bridge.confirmSessionRemoval(sessionId, action);
  }

  deleteSession(sessionId: string): Promise<void> {
    if (this.terminal && isTerminalSessionId(sessionId))
      return this.terminal.deleteSession(sessionId);
    return this.bridge.deleteSession(sessionId);
  }

  hideSession(sessionId: string): Promise<void> {
    if (this.terminal && isTerminalSessionId(sessionId))
      return this.terminal.deleteSession(sessionId);
    return this.bridge.hideSession(sessionId);
  }

  getTranscript(sessionId: string): Promise<TranscriptItem[]> {
    return this.bridge.getTranscript(sessionId);
  }

  getTranscriptPage(sessionId: string, request?: TranscriptPageRequest): Promise<TranscriptPage> {
    return this.bridge.getTranscriptPage(sessionId, request);
  }

  getTranscriptChanges(sessionId: string): Promise<TranscriptChange> {
    return this.bridge.getTranscriptChanges(sessionId);
  }

  getTranscriptRevision(sessionId: string): Promise<string | undefined> {
    return this.bridge.getTranscriptRevision(sessionId);
  }

  watchTranscripts(sessionIds: readonly string[]): void {
    this.bridge.watchTranscripts(sessionIds);
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

  queueFollowUp(sessionId: string, input: MessageInput): Promise<MessageDelivery> {
    return this.bridge.queueFollowUp(sessionId, input);
  }

  listQueuedMessages(sessionId: string): Promise<QueuedMessage[]> {
    return this.bridge.listQueuedMessages(sessionId);
  }

  flushQueuedNow(sessionId: string): Promise<boolean> {
    return this.bridge.flushQueuedNow(sessionId);
  }

  steerSession(sessionId: string, input: MessageInput): Promise<MessageDelivery> {
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

  answerQuestion(
    sessionId: string,
    gateId: string,
    submission: QuestionSubmission,
    idempotencyKey: string,
  ): Promise<void> {
    return this.bridge.answerQuestion(sessionId, gateId, submission, idempotencyKey);
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
