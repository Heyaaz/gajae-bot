import { describe, expect, it, vi } from "vitest";
import { GjcAgentBackend } from "./gjc-agent-backend";
import type {
  AgentEvent,
  AgentSession,
  BackendConnection,
  CreateSessionInput,
  GjcDesktopBridge,
  MessageInput,
  ToolDecision,
  TranscriptItem,
} from "./types";
import type {
  ForkSessionInput,
  GitStatusSnapshot,
} from "../../shared/agent-contract";

class FakeGjcBridge implements GjcDesktopBridge {
  previewFile = vi
    .fn()
    .mockResolvedValue({
      path: "/tmp/file.md",
      name: "file.md",
      kind: "markdown",
      mimeType: "text/markdown",
      content: "# Preview",
      size: 9,
    });
  getGoal = vi
    .fn()
    .mockResolvedValue({ enabled: false, completed: 0, total: 0 });
  operateGoal = vi
    .fn()
    .mockResolvedValue({ enabled: false, completed: 0, total: 0 });
  listSubagents = vi.fn().mockResolvedValue([]);
  readonly created: AgentSession[] = [];
  readonly listeners = new Set<(event: AgentEvent) => void>();
  readonly renamed: Array<{ sessionId: string; title: string }> = [];
  readonly deleted: string[] = [];
  createCalls = 0;

  async getConnection(): Promise<BackendConnection> {
    return {
      state: "connected",
      backend: "gjc",
      label: "Gajae Code",
      detail: "ACP connected",
      workspace: "/tmp/project",
      version: "0.15.0",
    };
  }

  async listSessions(): Promise<AgentSession[]> {
    return this.created.map((session) => ({ ...session }));
  }

  async createSession(input: CreateSessionInput): Promise<AgentSession> {
    this.createCalls += 1;
    await Promise.resolve();
    const session: AgentSession = {
      id: `gjc-${this.createCalls}`,
      title: input.title ?? "New Gajae session",
      subtitle: "project",
      workspace: input.workspace,
      runtime: "gjc",
      status: "idle",
      updatedAt: "now",
      pinned: false,
      unread: false,
      accent: "#ff8a34",
      ownership: "gajae",
      attachment: "attached",
    };
    this.created.push(session);
    return { ...session };
  }
  async forkSession(input: ForkSessionInput): Promise<AgentSession> {
    return this.createSession({
      runtime: "gjc",
      workspace: "/tmp/project",
      isolation: "workspace",
      title: input.title,
    });
  }

  async getTranscript(_sessionId: string): Promise<TranscriptItem[]> {
    return [];
  }
  async setSessionConfig(
    _sessionId: string,
    _configId: string,
    _value: string,
  ): Promise<void> {}
  async cycleThinking(_sessionId: string): Promise<string | undefined> {
    return undefined;
  }
  async compactSession(_sessionId: string): Promise<void> {}
  async queueFollowUp(
    _sessionId: string,
    _input: MessageInput,
  ): Promise<void> {}
  async listQueuedMessages(_sessionId: string): Promise<[]> {
    return [];
  }
  async flushQueuedNow(_sessionId: string): Promise<boolean> {
    return false;
  }
  async steerSession(_sessionId: string, _input: MessageInput): Promise<void> {}
  async renameSession(sessionId: string, title: string): Promise<void> {
    this.renamed.push({ sessionId, title });
  }
  async deleteSession(sessionId: string): Promise<void> {
    this.deleted.push(sessionId);
  }
  async sendMessage(_sessionId: string, _input: MessageInput): Promise<void> {}
  async cancelRun(_sessionId: string): Promise<void> {}
  async resolveToolCall(
    _toolId: string,
    _decision: ToolDecision,
  ): Promise<void> {}
  async markSessionRead(_sessionId: string): Promise<void> {}
  async getDiff(sessionId: string) {
    return {
      sessionId,
      workspace: "/tmp/project",
      files: [],
      refreshedAt: "now",
    };
  }
  async readArtifact(_sessionId: string, artifactId: string) {
    return { artifactId, text: "", complete: true, totalBytes: 0 };
  }
  async refreshRuntimeState(_sessionId: string) {
    return {
      permissionHandling: "prompt" as const,
      mcpServers: [],
      skills: [],
      rules: [],
      tools: [],
      refreshedAt: "now",
    };
  }
  async reconnect() {
    return this.getConnection();
  }
  async getGitStatus(_sessionId: string): Promise<GitStatusSnapshot> {
    return {
      workspace: "/tmp/project",
      branch: "main",
      ahead: 0,
      behind: 0,
      files: [],
    };
  }
  async stageFiles(
    sessionId: string,
    _paths: string[],
  ): Promise<GitStatusSnapshot> {
    return this.getGitStatus(sessionId);
  }
  async unstageFiles(
    sessionId: string,
    _paths: string[],
  ): Promise<GitStatusSnapshot> {
    return this.getGitStatus(sessionId);
  }
  async commitChanges(
    sessionId: string,
    _message: string,
  ): Promise<GitStatusSnapshot> {
    return this.getGitStatus(sessionId);
  }
  async pushChanges(sessionId: string): Promise<GitStatusSnapshot> {
    return this.getGitStatus(sessionId);
  }

  onEvent(listener: (event: AgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: AgentEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

describe("GjcAgentBackend", () => {
  it("uses the real ACP bridge connection metadata", async () => {
    const bridge = new FakeGjcBridge();
    const backend = new GjcAgentBackend(bridge);

    await expect(backend.getConnection()).resolves.toMatchObject({
      state: "connected",
      backend: "gjc",
      version: "0.15.0",
    });
    backend.dispose();
  });

  it("does not create a session while listing an empty runtime", async () => {
    const bridge = new FakeGjcBridge();
    const backend = new GjcAgentBackend(bridge);

    const [first, second] = await Promise.all([
      backend.listSessions(),
      backend.listSessions(),
    ]);

    expect(bridge.createCalls).toBe(0);
    expect(first).toEqual([]);
    expect(second).toEqual([]);
    backend.dispose();
  });

  it("forwards live ACP events and detaches on dispose", () => {
    const bridge = new FakeGjcBridge();
    const backend = new GjcAgentBackend(bridge);
    const listener = vi.fn();
    backend.subscribe(listener);
    const event: AgentEvent = {
      type: "connection.updated",
      connection: {
        state: "connected",
        backend: "gjc",
        label: "GJC",
        detail: "ACP connected",
        workspace: "/tmp/project",
      },
    };

    bridge.emit(event);
    expect(listener).toHaveBeenCalledWith(event);

    backend.dispose();
    bridge.emit(event);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("coalesces streaming deltas into one renderer update per frame", () => {
    vi.useFakeTimers();
    const bridge = new FakeGjcBridge();
    const backend = new GjcAgentBackend(bridge);
    const listener = vi.fn();
    backend.subscribe(listener);

    bridge.emit({
      type: "message.delta",
      sessionId: "s",
      messageId: "m",
      delta: "one ",
      streaming: true,
    });
    bridge.emit({
      type: "message.delta",
      sessionId: "s",
      messageId: "m",
      delta: "two",
      streaming: true,
    });

    expect(listener).not.toHaveBeenCalled();
    vi.advanceTimersByTime(16);
    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith({
      type: "message.delta",
      sessionId: "s",
      messageId: "m",
      delta: "one two",
      streaming: true,
    });

    backend.dispose();
    vi.useRealTimers();
  });

  it("flushes buffered text immediately when a stream finishes", () => {
    vi.useFakeTimers();
    const bridge = new FakeGjcBridge();
    const backend = new GjcAgentBackend(bridge);
    const listener = vi.fn();
    backend.subscribe(listener);

    bridge.emit({
      type: "thought.delta",
      sessionId: "s",
      thoughtId: "t",
      delta: "thinking",
      streaming: true,
    });
    bridge.emit({
      type: "thought.delta",
      sessionId: "s",
      thoughtId: "t",
      delta: "",
      streaming: false,
    });

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith({
      type: "thought.delta",
      sessionId: "s",
      thoughtId: "t",
      delta: "thinking",
      streaming: false,
    });

    backend.dispose();
    vi.useRealTimers();
  });

  it("rejects Hermes session creation on the GJC-only bridge", async () => {
    const backend = new GjcAgentBackend(new FakeGjcBridge());
    await expect(
      backend.createSession({
        runtime: "hermes",
        workspace: "/tmp/project",
        isolation: "workspace",
      }),
    ).rejects.toThrow("Hermes is not connected yet");
    backend.dispose();
  });

  it("delegates session rename and deletion to the desktop bridge", async () => {
    const bridge = new FakeGjcBridge();
    const backend = new GjcAgentBackend(bridge);

    await backend.renameSession("session-1", "Renamed");
    await backend.deleteSession("session-1");

    expect(bridge.renamed).toEqual([
      { sessionId: "session-1", title: "Renamed" },
    ]);
    expect(bridge.deleted).toEqual(["session-1"]);
    backend.dispose();
  });

  it("delegates runtime, diff, artifact, and read operations", async () => {
    const bridge = new FakeGjcBridge();
    const backend = new GjcAgentBackend(bridge);
    await expect(backend.getDiff("s")).resolves.toMatchObject({
      sessionId: "s",
    });
    await expect(backend.readArtifact("s", "a")).resolves.toMatchObject({
      artifactId: "a",
    });
    await expect(backend.refreshRuntimeState("s")).resolves.toMatchObject({
      permissionHandling: "prompt",
    });
    await expect(backend.markSessionRead("s")).resolves.toBeUndefined();
    await expect(backend.reconnect()).resolves.toMatchObject({
      backend: "gjc",
    });
    backend.dispose();
  });

  it("delegates fork and git operations", async () => {
    const bridge = new FakeGjcBridge();
    const backend = new GjcAgentBackend(bridge);
    await backend.forkSession({ sourceSessionId: "s", title: "Fork" });
    await expect(backend.getGitStatus("s")).resolves.toMatchObject({
      branch: "main",
    });
    await expect(backend.stageFiles("s", ["a"])).resolves.toMatchObject({
      files: [],
    });
    await expect(backend.unstageFiles("s", ["a"])).resolves.toMatchObject({
      files: [],
    });
    await expect(backend.commitChanges("s", "msg")).resolves.toMatchObject({
      files: [],
    });
    await expect(backend.pushChanges("s")).resolves.toMatchObject({
      files: [],
    });
    backend.dispose();
  });
});
