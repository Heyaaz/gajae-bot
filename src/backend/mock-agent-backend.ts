import type { AgentBackend } from "./agent-backend";
import type {
  AgentEvent,
  AgentSession,
  BackendConnection,
  ChatMessage,
  CreateSessionInput,
  ForkSessionInput,
  MessageInput,
  ToolActivity,
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
  QueuedMessage,
  SubagentSnapshot,
} from "../../shared/agent-contract";
import { transcriptDelivery } from "../../shared/transcript-item-equal";
import {
  selectTranscriptPage,
  transcriptSyncWindow,
} from "../../shared/transcript-page";

const mockModelOptions = [
  {
    value: "GOAT",
    name: "GOAT",
    group: "Custom profiles",
    description: "From ~/.gjc/agent/models.yml",
  },
  { value: "codex-eco", name: "Codex Eco", group: "Built-in profiles" },
  { value: "codex-medium", name: "Codex Medium", group: "Built-in profiles" },
  { value: "codex-pro", name: "Codex Pro", group: "Built-in profiles" },
];

const sessions: AgentSession[] = [
  {
    id: "agent-control",
    title: "Gajae UI",
    subtitle: "React shell and backend boundary",
    workspace: "/tmp",
    runtime: "gjc",
    status: "idle",
    updatedAt: "now",
    pinned: true,
    unread: false,
    accent: "#ff8a34",
    ownership: "gajae",
    attachment: "attached",
    worktree: {
      sourceWorkspace: "/tmp",
      path: "/tmp",
      branch: "main",
      managed: true,
    },
    runtimeState: {
      permissionHandling: "prompt",
      mcpServers: ["filesystem"],
      skills: ["deep-interview"],
      rules: [],
      tools: ["shell"],
      refreshedAt: "now",
    },
    usagePercent: 22.2,
    modelDisplay: "GPT-5.6 Sol",
  },
  {
    id: "hermes-mobile",
    title: "Hermes mobile gateway",
    subtitle: "Remote event bridge design",
    workspace: "/tmp/hermes-mobile",
    runtime: "hermes",
    status: "waiting",
    updatedAt: "8m",
    pinned: true,
    unread: true,
    accent: "#83d9c8",
    ownership: "external",
    attachment: "attachable",
  },
  {
    id: "m1-box",
    title: "M1 Air box health",
    subtitle: "Docker and external SSD checks",
    workspace: "/tmp/m1-box",
    runtime: "hermes",
    status: "idle",
    updatedAt: "42m",
    pinned: false,
    unread: false,
    accent: "#f0aa72",
    ownership: "available",
    attachment: "terminal-only",
  },
  {
    id: "codex-router",
    title: "Codex router cleanup",
    subtitle: "Provider session investigation",
    workspace: "/tmp/codex-router",
    runtime: "gjc",
    status: "running",
    updatedAt: "2h",
    pinned: false,
    unread: false,
    accent: "#70b8f7",
    ownership: "gajae",
    attachment: "attached",
  },
];

const transcripts: Record<string, TranscriptItem[]> = {
  "agent-control": [
    {
      id: "message-1",
      kind: "message",
      sessionId: "agent-control",
      role: "user",
      content:
        "Grok Bot처럼 에이전트 상태와 작업 내역을 한 화면에서 관리할 수 있게 만들어줘.",
      createdAt: "10:42",
    },
    {
      id: "message-2",
      kind: "message",
      sessionId: "agent-control",
      role: "assistant",
      content:
        "### Runtime boundary\n\n별도 프로젝트에 런타임 중립 인터페이스를 두고 UI를 구성했습니다.\n\n| Runtime | Transport |\n| --- | --- |\n| GJC | SDK session CLI |\n| Hermes | Gateway |",
      createdAt: "10:43",
    },
    {
      id: "thought-1",
      kind: "thought",
      sessionId: "agent-control",
      content:
        "Planning the runtime-neutral bridge and desktop verification path.",
      createdAt: "10:43",
      streaming: false,
    },
    {
      id: "plan-1",
      kind: "plan",
      sessionId: "agent-control",
      entries: [
        { content: "Define the backend contract", status: "completed" },
        { content: "Connect GJC over the SDK session CLI", status: "completed" },
        { content: "Verify the desktop shell", status: "in_progress" },
      ],
      createdAt: "10:44",
    },
    {
      id: "tool-1",
      kind: "tool",
      sessionId: "agent-control",
      name: "Write files",
      description: "Created the initial React workspace",
      command: "npm create vite@latest agent-control -- --template react-ts",
      status: "completed",
      output: JSON.stringify({
        content: [
          {
            type: "text",
            text: Array.from(
              { length: 16 },
              (_, index) =>
                `build output row-${String(index + 1).padStart(2, "0")}`,
            ).join("\n"),
          },
        ],
      }),
      createdAt: "10:44",
    },
    {
      id: "notice-1",
      kind: "notice",
      sessionId: "agent-control",
      title: "Runtime boundary ready",
      content:
        "The UI no longer assumes Cursor, Sand, Hermes, or GJC-specific message types.",
      tone: "success",
      createdAt: "10:45",
    },
    {
      id: "tool-subagent-1",
      kind: "tool",
      sessionId: "agent-control",
      name: "task",
      description: "UI 검토",
      command: JSON.stringify({ role: "critic", description: "UI 검토" }),
      status: "completed",
      createdAt: "10:45",
    },
    {
      id: "tool-edit-1",
      kind: "tool",
      sessionId: "agent-control",
      name: "edit",
      description: "src/App.tsx 수정",
      targetPath: "src/App.tsx",
      diff: "@@ -10,6 +10,7 @@\n 10|  Command,\n+11|  GitFork,\n 12|  ListChecks,\n-13|  Legacy,\n",
      status: "completed",
      createdAt: "10:45",
    },
    {
      id: "tool-read-image-1",
      kind: "tool",
      sessionId: "agent-control",
      name: "read",
      description: "스크린샷 읽기",
      targetPath: "docs/shot.png",
      images: [
        {
          mimeType: "image/png",
          dataUrl:
            "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        },
      ],
      status: "completed",
      createdAt: "10:45",
    },
    {
      id: "tool-approval-1",
      kind: "tool",
      sessionId: "agent-control",
      name: "Start desktop preview",
      description: "Run the local Vite preview server",
      command: "npm run dev -- --host 127.0.0.1",
      status: "approval-required",
      createdAt: "10:46",
      permissionOptions: [
        { optionId: "allow_once", kind: "allow_once", name: "이번만 허용" },
        { optionId: "allow_always", kind: "allow_always", name: "항상 허용" },
        { optionId: "reject_once", kind: "reject_once", name: "이번만 거부" },
        { optionId: "reject_always", kind: "reject_always", name: "항상 거부" },
      ],
    },
  ],
  "hermes-mobile": [
    {
      id: "hermes-message-1",
      kind: "message",
      sessionId: "hermes-mobile",
      role: "assistant",
      content:
        "The mobile client can reuse the same event protocol. The M1 bridge keeps provider credentials and execution capabilities off the phone.",
      createdAt: "10:31",
    },
  ],
  "m1-box": [
    {
      id: "m1-message-1",
      kind: "message",
      sessionId: "m1-box",
      role: "assistant",
      content:
        "M1 Air is reachable over the private network. Docker health data will appear here after the bridge is connected.",
      createdAt: "09:58",
    },
  ],
  "codex-router": [],
};

function cloneSession(session: AgentSession): AgentSession {
  return {
    ...session,
    worktree: session.worktree ? { ...session.worktree } : undefined,
    runtimeState: session.runtimeState
      ? {
          ...session.runtimeState,
          mcpServers: [...session.runtimeState.mcpServers],
          skills: [...session.runtimeState.skills],
          rules: [...session.runtimeState.rules],
          tools: [...session.runtimeState.tools],
        }
      : undefined,
  };
}

function cloneItem(item: TranscriptItem): TranscriptItem {
  if (item.kind === "plan")
    return { ...item, entries: item.entries.map((entry) => ({ ...entry })) };
  if (item.kind === "question")
    return { ...item, options: item.options.map((option) => ({ ...option })) };
  if (item.kind !== "message" || !item.images) return { ...item };
  return { ...item, images: item.images.map((image) => ({ ...image })) };
}

export class MockAgentBackend implements AgentBackend {
  private readonly listeners = new Set<(event: AgentEvent) => void>();
  private readonly sessionStore = sessions.map(cloneSession);
  private readonly queuedStore = new Map<string, QueuedMessage[]>();
  private readonly transcriptStore = new Map(
    Object.entries(transcripts).map(([sessionId, items]) => [
      sessionId,
      items.map(cloneItem),
    ]),
  );
  private readonly transcriptChangeBaselines = new Map<string, TranscriptItem[]>();
  private readonly timers = new Map<
    string,
    Set<ReturnType<typeof setTimeout>>
  >();
  private nextId = 100;
  private capabilitiesEmitted = new Set<string>();
  private readonly gitStores = new Map<string, GitStatusSnapshot>();

  /**
   * Pads the first session to `count` entries.
   *
   * Virtualization only shows up on a session big enough that mounting every row would
   * be obvious, and the canned transcripts are a handful of items. The smoke asks for
   * this explicitly through `?seedTranscript=`; nothing else calls it.
   */
  seedLargeTranscript(count: number): void {
    const sessionId = this.sessionStore[0]?.id;
    if (!sessionId) return;
    const items = this.transcriptStore.get(sessionId) ?? [];
    const createdAt = new Date().toISOString();
    const sentence =
      "이 줄은 읽기 컬럼의 폭에 따라 줄바꿈 위치가 달라지도록 충분히 길게 작성된 본문이며, 세션 정보 패널을 여닫을 때 다시 측정되어야 하는 대상입니다.";
    while (items.length < count) {
      const index = items.length;
      // Heights have to vary wildly, not just exceed one line. A real session measured
      // 61px to 1415px per block, and it is that spread against the fixed estimate that
      // makes the scroll height wrong enough to expose scroll-restore bugs. Uniform rows
      // sat close to the estimate and hid them.
      const bulk = (index % 7) * (index % 3);
      // Alternate messages with tool calls, the way a real turn does. Grouping collapses
      // consecutive tool calls into one block, so this produces the message/tool-run
      // alternation where per-card bottom margins made spacing jump between 20px and 40px.
      if (index % 3 === 1) {
        items.push(
          cloneItem({
            id: `seeded-${index}`,
            sessionId,
            kind: "tool",
            name: "bash",
            description: `샘프 명령 ${index}`,
            command: `echo ${index}`,
            status: "completed",
            createdAt,
          } as never),
        );
        continue;
      }
      items.push(
        cloneItem({
          id: `seeded-${index}`,
          sessionId,
          kind: "message",
          role: index % 2 === 0 ? "assistant" : "user",
          content: `${index} 번째 메시지입니다. ${sentence.repeat(1 + bulk)}`,
          createdAt,
        } as never),
      );
    }
    this.transcriptStore.set(sessionId, items);
  }

  async getConnection(): Promise<BackendConnection> {
    return {
      state: "connected",
      backend: "mock",
      // Every session and reply this backend serves is invented, so the label says so
      // rather than reading as a runtime that is genuinely attached.
      label: "샘해데이턼 (Mock)",
      detail: "UI 미리보기욨 가짜 데이턼입니다. 실제 GJC에 연결되지 않았습니다.",
      workspace: "agent-control",
      modelPreset: "codex-medium",
    };
  }

  async listSessions(): Promise<AgentSession[]> {
    return this.sessionStore.map(cloneSession);
  }

  async createSession(input: CreateSessionInput): Promise<AgentSession> {
    const id = `session-${this.nextId++}`;
    const session: AgentSession = {
      id,
      title: input.title?.trim() || "New Gajae session",
      subtitle:
        input.workspace.split("/").filter(Boolean).at(-1) || input.workspace,
      workspace: input.workspace,
      runtime: input.runtime,
      status: "idle",
      updatedAt: "now",
      pinned: false,
      unread: false,
      accent: input.runtime === "gjc" ? "#ff8a34" : "#83d9c8",
      ownership: "gajae",
      attachment: input.isolation === "worktree" ? "attached" : "attached",
      ...(input.isolation === "worktree"
        ? {
            worktree: {
              sourceWorkspace: input.workspace,
              path: `${input.workspace}/.gajae-worktrees/${input.worktreeBranch ?? id}`,
              branch: input.worktreeBranch ?? id,
              managed: true as const,
            },
          }
        : {}),
      runtimeState: {
        permissionHandling: "prompt",
        mcpServers: [],
        skills: [],
        rules: [],
        tools: [],
        refreshedAt: "now",
      },
    };

    this.sessionStore.unshift(session);
    this.transcriptStore.set(id, []);
    this.gitStores.set(id, {
      workspace: input.workspace,
      branch: "main",
      ahead: 0,
      behind: 0,
      files: [
        { path: "README.md", index: " ", workingTree: "M" },
        { path: "src/App.tsx", index: " ", workingTree: "M" },
      ],
    });
    this.emit({ type: "session.created", session: cloneSession(session) });
    return cloneSession(session);
  }

  async forkSession(input: ForkSessionInput): Promise<AgentSession> {
    const source = this.sessionStore.find(
      (candidate) => candidate.id === input.sourceSessionId,
    );
    if (!source) throw new Error(`Unknown session: ${input.sourceSessionId}`);
    const session = await this.createSession({
      runtime: source.runtime,
      workspace: source.workspace,
      isolation: "workspace",
      title: input.title ?? `${source.title} (fork)`,
    });
    const parentNotice: TranscriptItem = {
      id: `notice-${this.nextId++}`,
      kind: "notice",
      sessionId: session.id,
      title: "Forked session",
      content: `Forked from ${source.id} (${source.title})`,
      tone: "neutral",
      createdAt: "now",
    };
    this.append(parentNotice);
    return session;
  }

  async listHistorySessions(): Promise<HistorySession[]> {
    return this.sessionStore.map((session) => ({
      id: session.id,
      title: session.title,
      workspace: session.workspace,
      updatedAt: session.updatedAt,
      messageCount: this.transcriptStore.get(session.id)?.length ?? 0,
      live: session.attachment === "attached",
    }));
  }

  async openHistorySession(sessionId: string): Promise<AgentSession> {
    return this.resumeSession(sessionId);
  }

  async resumeSession(sessionId: string): Promise<AgentSession> {
    const session = this.sessionStore.find(
      (candidate) => candidate.id === sessionId,
    );
    if (!session) throw new Error(`Unknown session: ${sessionId}`);
    session.attachment = "attached";
    session.ownership = "gajae";
    if (session.status === "failed") session.status = "idle";
    session.updatedAt = "now";
    this.emit({ type: "session.updated", session: cloneSession(session) });
    return cloneSession(session);
  }

  async renameSession(sessionId: string, title: string): Promise<void> {
    const session = this.sessionStore.find(
      (candidate) => candidate.id === sessionId,
    );
    const value = title.trim();
    if (!session || !value) throw new Error("Session and title are required");
    session.title = value;
    session.updatedAt = "now";
    this.emit({ type: "session.updated", session: cloneSession(session) });
  }

  async hideSession(sessionId: string): Promise<void> {
    await this.deleteSession(sessionId);
  }

  async deleteSession(sessionId: string): Promise<void> {
    const index = this.sessionStore.findIndex(
      (candidate) => candidate.id === sessionId,
    );
    if (index < 0) return;
    this.sessionStore.splice(index, 1);
    this.transcriptStore.delete(sessionId);
    this.transcriptChangeBaselines.delete(sessionId);
    this.clearTimers(sessionId);
    this.emit({ type: "session.deleted", sessionId });
  }

  async getTranscriptPage(sessionId: string, request?: TranscriptPageRequest): Promise<TranscriptPage> {
    return selectTranscriptPage(await this.getTranscript(sessionId), request);
  }

  async getTranscript(sessionId: string): Promise<TranscriptItem[]> {
    if (!this.capabilitiesEmitted.has(sessionId)) {
      this.capabilitiesEmitted.add(sessionId);
      queueMicrotask(() => {
        this.emit({
          type: "session.commands",
          sessionId,
          commands: [
            {
              name: "context",
              description: "Show active context token usage",
            },
            {
              name: "fast",
              description: "Toggle fast mode",
              hint: "[on|off]",
            },
            {
              name: "skill:deep-interview",
              description: "Clarify requirements before implementation",
              hint: "[request]",
            },
            {
              name: "skill:ralplan",
              description: "Build a consensus implementation plan",
              hint: "[request]",
            },
            {
              name: "skill:ultragoal",
              description: "Execute work against a durable goal",
              hint: "[request]",
            },
            {
              name: "skill:autoresearch",
              description: "Run a goal-directed research mission",
              hint: "[request]",
            },
          ],
        });
        this.emit({
          type: "session.config",
          sessionId,
          options: [
            {
              id: "mode",
              name: "Mode",
              category: "mode",
              type: "select",
              currentValue: "default",
              options: [
                { value: "default", name: "Default" },
                { value: "plan", name: "Plan" },
              ],
            },
            {
              id: "model",
              name: "Preset",
              category: "model",
              type: "select",
              currentValue: "codex-medium",
              options: mockModelOptions,
            },
            {
              id: "thinking",
              name: "Thinking",
              category: "thought_level",
              type: "select",
              currentValue: "medium",
              options: [
                { value: "off", name: "off" },
                { value: "low", name: "low" },
                { value: "medium", name: "medium" },
                { value: "high", name: "high" },
                { value: "xhigh", name: "xhigh" },
              ],
            },
          ],
        });
      });
    }
    return (this.transcriptStore.get(sessionId) ?? []).map(cloneItem);
  }

  async getTranscriptChanges(sessionId: string): Promise<TranscriptChange> {
    const previous = this.transcriptChangeBaselines.get(sessionId);
    const items = await this.getTranscript(sessionId);
    const next = transcriptSyncWindow(items, previous);
    const change = transcriptDelivery(previous, next);
    this.transcriptChangeBaselines.set(sessionId, next.map(cloneItem));
    return change;
  }

  async cycleThinking(sessionId: string): Promise<string | undefined> {
    const session = this.sessionStore.find(
      (candidate) => candidate.id === sessionId,
    );
    if (!session) throw new Error(`Unknown session: ${sessionId}`);
    const levels = ["low", "medium", "high", "xhigh"];
    const current = session.thinking ?? "medium";
    const next =
      levels[(Math.max(0, levels.indexOf(current)) + 1) % levels.length]!;
    await this.setSessionConfig(sessionId, "thinking", next);
    return next;
  }

  async setSessionConfig(
    sessionId: string,
    configId: string,
    value: string,
  ): Promise<void> {
    const session = this.sessionStore.find(
      (candidate) => candidate.id === sessionId,
    );
    if (!session) throw new Error(`Unknown session: ${sessionId}`);
    if (configId === "model") session.model = value;
    if (configId === "thinking") session.thinking = value;
    if (configId === "mode") session.mode = value;
    this.emit({ type: "session.updated", session: cloneSession(session) });
    this.emit({
      type: "session.config",
      sessionId,
      options: [
        {
          id: "mode",
          name: "Mode",
          category: "mode",
          type: "select",
          currentValue: session.mode ?? "default",
          options: [
            { value: "default", name: "Default" },
            { value: "plan", name: "Plan" },
          ],
        },
        {
          id: "model",
          name: "Preset",
          category: "model",
          type: "select",
          currentValue: session.model ?? "codex-medium",
          options: mockModelOptions,
        },
        {
          id: "thinking",
          name: "Thinking",
          category: "thought_level",
          type: "select",
          currentValue: session.thinking ?? "medium",
          options: [
            { value: "off", name: "off" },
            { value: "low", name: "low" },
            { value: "medium", name: "medium" },
            { value: "high", name: "high" },
            { value: "xhigh", name: "xhigh" },
          ],
        },
      ],
    });
  }

  async compactSession(sessionId: string): Promise<void> {
    const session = this.sessionStore.find(
      (candidate) => candidate.id === sessionId,
    );
    if (!session) throw new Error(`Unknown session: ${sessionId}`);
    session.phase = "compacting";
    session.status = "running";
    this.emit({ type: "session.updated", session: cloneSession(session) });
    await new Promise((resolve) => setTimeout(resolve, 40));
    session.usagePercent = 8.4;
    session.usagePending = false;
    session.phase = undefined;
    session.status = "idle";
    this.emit({ type: "session.updated", session: cloneSession(session) });
  }

  async steerSession(sessionId: string, input: MessageInput): Promise<void> {
    const session = this.sessionStore.find(
      (candidate) => candidate.id === sessionId,
    );
    if (!session || session.status !== "running")
      throw new Error("No active run to steer");
    const queue = this.queuedStore.get(sessionId) ?? [];
    queue.push({
      id: `steer:${queue.length + 1}`,
      text: input.text.replace(/^\/steer(?:\s+|$)/u, "").trim(),
      mode: "steer",
      label: "Steer",
    });
    this.queuedStore.set(sessionId, queue);
  }

  async listQueuedMessages(sessionId: string): Promise<QueuedMessage[]> {
    return (this.queuedStore.get(sessionId) ?? []).map((entry) => ({
      ...entry,
    }));
  }

  async flushQueuedNow(sessionId: string): Promise<boolean> {
    const queued = this.queuedStore.get(sessionId) ?? [];
    if (queued.length === 0) return false;
    this.queuedStore.set(sessionId, []);
    await this.cancelRun(sessionId);
    for (const entry of queued) {
      this.append({
        id: `message-${this.nextId++}`,
        kind: "message",
        sessionId,
        role: "user",
        content: entry.text,
        createdAt: "now",
      });
    }
    return true;
  }

  async queueFollowUp(sessionId: string, input: MessageInput): Promise<void> {
    const session = this.sessionStore.find(
      (candidate) => candidate.id === sessionId,
    );
    if (!session || session.status !== "running")
      throw new Error("No active run to queue behind");
    const queue = this.queuedStore.get(sessionId) ?? [];
    queue.push({
      id: `followUp:${queue.length + 1}`,
      text: input.text,
      mode: "followUp",
      label: "Queued",
    });
    this.queuedStore.set(sessionId, queue);
  }

  async sendMessage(sessionId: string, input: MessageInput): Promise<"prompt"> {
    const value = input.text.trim();
    if (!value && input.images.length === 0 && input.files.length === 0)
      return "prompt";

    if (value === "/fast on" || value === "/fast off") {
      const session = this.sessionStore.find(
        (candidate) => candidate.id === sessionId,
      );
      if (session) {
        session.serviceTier = value === "/fast on" ? "priority" : "default";
        session.updatedAt = "now";
        this.emit({ type: "session.updated", session: cloneSession(session) });
      }
    }

    const userMessage: ChatMessage = {
      id: `message-${this.nextId++}`,
      kind: "message",
      sessionId,
      role: "user",
      content: value,
      images: input.images.map((image) => ({ ...image })),
      ...(input.files.length
        ? {
            content: `${value}\n\n[Files: ${input.files.map((file) => `${file.name} (${file.size} bytes)`).join(", ")}]`,
          }
        : {}),
      createdAt: "now",
    };
    this.append(userMessage);
    this.updateStatus(sessionId, "running");

    const assistantMessage: ChatMessage = {
      id: `message-${this.nextId++}`,
      kind: "message",
      sessionId,
      role: "assistant",
      content: "",
      createdAt: "now",
      streaming: true,
    };

    this.schedule(sessionId, 360, () => this.append(assistantMessage));

    const chunks = [
      "확인했습니다. ",
      "이 화면은 공통 backend 이벤트만 사용하므로 ",
      "GJC와 Hermes Gateway를 같은 UI에 연결할 수 있습니다.",
    ];

    chunks.forEach((delta, index) => {
      this.schedule(sessionId, 650 + index * 420, () => {
        const transcript = this.transcriptStore.get(sessionId);
        const message = transcript?.find(
          (item) => item.id === assistantMessage.id,
        );
        if (message?.kind !== "message") return;
        message.content += delta;
        message.streaming = index < chunks.length - 1;
        this.emit({
          type: "message.delta",
          sessionId,
          messageId: message.id,
          delta,
          streaming: message.streaming,
        });
        if (!message.streaming) {
          this.updateStatus(sessionId, "idle");
          const session = this.sessionStore.find(
            (candidate) => candidate.id === sessionId,
          );
          if (session) {
            session.unread = true;
            this.emit({
              type: "session.updated",
              session: cloneSession(session),
            });
            this.emit({
              type: "session.activity",
              sessionId,
              title: session.title,
              unread: true,
              category: "completed",
            });
          }
        }
      });
    });
    return "prompt";
  }

  async cancelRun(sessionId: string): Promise<void> {
    this.clearTimers(sessionId);
    this.updateStatus(sessionId, "idle");
  }

  async answerQuestion(
    sessionId: string,
    gateId: string,
    submission: { selected: string[]; custom?: string; clarify?: string },
  ): Promise<void> {
    const items = this.transcriptStore.get(sessionId);
    const question = items?.find((item) => item.kind === "question" && item.id === gateId);
    if (question?.kind !== "question" || !question.answerable) return;
    const summary = submission.clarify?.trim() || submission.custom?.trim() || submission.selected.join(", ");
    question.status = "answered";
    question.answerable = false;
    question.answerSummary = summary;
    question.error = undefined;
    this.emit({ type: "question.updated", question: cloneItem(question) as typeof question });
  }

  async resolveToolCall(toolId: string, decision: ToolDecision): Promise<void> {
    for (const items of this.transcriptStore.values()) {
      const tool = items.find((item) => item.id === toolId);
      if (tool?.kind !== "tool") continue;

      const approved = decision.optionId.startsWith("allow_");
      tool.status = approved ? "approved" : "denied";
      tool.output = approved ? "Approved for this run" : "Denied by user";
      this.emit({
        type: "tool.updated",
        tool: cloneItem(tool) as ToolActivity,
      });
      return;
    }
  }

  async markSessionRead(sessionId: string): Promise<void> {
    const session = this.sessionStore.find(
      (candidate) => candidate.id === sessionId,
    );
    if (!session) throw new Error(`Unknown session: ${sessionId}`);
    session.unread = false;
    this.emit({ type: "session.updated", session: cloneSession(session) });
    this.emit({
      type: "session.activity",
      sessionId,
      title: session.title,
      unread: false,
      category: "message",
    });
  }

  async getDiff(sessionId: string): Promise<DiffSnapshot> {
    const session = this.sessionStore.find(
      (candidate) => candidate.id === sessionId,
    );
    if (!session) throw new Error(`Unknown session: ${sessionId}`);
    return {
      sessionId,
      workspace: session.workspace,
      refreshedAt: "now",
      files: [
        {
          id: `${sessionId}-diff-1`,
          path: "README.md",
          patch: "--- a/README.md\n+++ b/README.md\n@@\n+# Gajae\n",
        },
      ],
    };
  }

  async readArtifact(
    sessionId: string,
    artifactId: string,
  ): Promise<ArtifactContent> {
    if (!this.sessionStore.some((session) => session.id === sessionId))
      throw new Error(`Unknown session: ${sessionId}`);
    const text =
      artifactId === "tool-output-1"
        ? "build output row-01\nbuild output row-02\nbuild output row-03"
        : `Artifact ${artifactId} for ${sessionId}`;
    return {
      artifactId,
      text,
      complete: true,
      totalBytes: new TextEncoder().encode(text).byteLength,
    };
  }

  async previewFile(
    _sessionId: string,
    filePath: string,
  ): Promise<GeneratedFilePreview> {
    return {
      path: filePath,
      name: filePath.split("/").at(-1) ?? filePath,
      kind: "markdown",
      mimeType: "text/markdown",
      content: "# Generated preview",
      size: 19,
    };
  }

  async getGoal(sessionId: string): Promise<GoalSnapshot> {
    if (!this.sessionStore.some((session) => session.id === sessionId))
      throw new Error(`Unknown session: ${sessionId}`);
    return {
      enabled: true,
      mode: "active",
      objective: "Gajae 데스크톱 경험 완성",
      completed: 2,
      total: 4,
    };
  }

  async operateGoal(
    sessionId: string,
    operation: GoalOperation,
  ): Promise<GoalSnapshot> {
    const goal = await this.getGoal(sessionId);
    if (operation === "drop") return { enabled: false, completed: 0, total: 0 };
    return {
      ...goal,
      mode:
        operation === "pause"
          ? "paused"
          : operation === "complete"
            ? "complete"
            : "active",
    };
  }

  async listSubagents(sessionId: string): Promise<SubagentSnapshot[]> {
    if (!this.sessionStore.some((session) => session.id === sessionId))
      throw new Error(`Unknown session: ${sessionId}`);
    return [
      {
        id: "mock-executor",
        label: "executor",
        status: "running",
        detail: "UI 구현 중",
      },
    ];
  }

  async refreshRuntimeState(sessionId: string): Promise<EffectiveRuntimeState> {
    const session = this.sessionStore.find(
      (candidate) => candidate.id === sessionId,
    );
    if (!session) throw new Error(`Unknown session: ${sessionId}`);
    const runtimeState: EffectiveRuntimeState = {
      ...(session.runtimeState ?? {
        permissionHandling: "prompt",
        mcpServers: [],
        skills: [],
        rules: [],
        tools: [],
      }),
      refreshedAt: "now",
    };
    session.runtimeState = runtimeState;
    this.emit({
      type: "runtime.updated",
      sessionId,
      runtimeState: {
        ...runtimeState,
        mcpServers: [...runtimeState.mcpServers],
        skills: [...runtimeState.skills],
        rules: [...runtimeState.rules],
        tools: [...runtimeState.tools],
      },
    });
    return {
      ...runtimeState,
      mcpServers: [...runtimeState.mcpServers],
      skills: [...runtimeState.skills],
      rules: [...runtimeState.rules],
      tools: [...runtimeState.tools],
    };
  }

  async reconnect(): Promise<BackendConnection> {
    const connection = await this.getConnection();
    const refreshed = {
      ...connection,
      generation: (connection.generation ?? 0) + 1,
    };
    this.emit({ type: "connection.updated", connection: refreshed });
    return refreshed;
  }

  async getGitStatus(sessionId: string): Promise<GitStatusSnapshot> {
    const session = this.sessionStore.find(
      (candidate) => candidate.id === sessionId,
    );
    if (!session) throw new Error(`Unknown session: ${sessionId}`);
    const status = this.gitStores.get(sessionId) ?? {
      workspace: session.workspace,
      branch: "main",
      ahead: 0,
      behind: 0,
      files: [{ path: "README.md", index: " ", workingTree: "M" }],
    };
    this.gitStores.set(sessionId, status);
    return { ...status, files: status.files.map((file) => ({ ...file })) };
  }

  async stageFiles(
    sessionId: string,
    paths: string[],
  ): Promise<GitStatusSnapshot> {
    return this.updateGit(sessionId, paths, true);
  }
  async unstageFiles(
    sessionId: string,
    paths: string[],
  ): Promise<GitStatusSnapshot> {
    return this.updateGit(sessionId, paths, false);
  }
  async commitChanges(
    sessionId: string,
    message: string,
  ): Promise<GitStatusSnapshot> {
    if (!message.trim()) throw new Error("Commit message is required");
    const status = await this.getGitStatus(sessionId);
    status.files = status.files.filter((file) => file.index === " ");
    status.ahead += 1;
    this.gitStores.set(sessionId, status);
    return status;
  }
  async pushChanges(sessionId: string): Promise<GitStatusSnapshot> {
    const status = await this.getGitStatus(sessionId);
    status.behind = 0;
    status.ahead = 0;
    this.gitStores.set(sessionId, status);
    return status;
  }

  subscribe(listener: (event: AgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    for (const sessionId of this.timers.keys()) this.clearTimers(sessionId);
    this.listeners.clear();
  }

  private append(item: TranscriptItem): void {
    const items = this.transcriptStore.get(item.sessionId) ?? [];
    items.push(item);
    this.transcriptStore.set(item.sessionId, items);
    this.emit({ type: "transcript.appended", item: cloneItem(item) });
  }

  private async updateGit(
    sessionId: string,
    paths: string[],
    staged: boolean,
  ): Promise<GitStatusSnapshot> {
    const status = await this.getGitStatus(sessionId);
    const selected = new Set(paths);
    status.files = status.files.map((file) =>
      selected.has(file.path) ? { ...file, index: staged ? "M" : " " } : file,
    );
    this.gitStores.set(sessionId, status);
    return status;
  }

  private updateStatus(
    sessionId: string,
    status: AgentSession["status"],
  ): void {
    const session = this.sessionStore.find(
      (candidate) => candidate.id === sessionId,
    );
    if (!session) return;
    session.status = status;
    session.updatedAt = "now";
    this.emit({ type: "session.updated", session: cloneSession(session) });
  }

  private schedule(sessionId: string, delay: number, task: () => void): void {
    const timer = setTimeout(() => {
      this.timers.get(sessionId)?.delete(timer);
      task();
    }, delay);
    const timers = this.timers.get(sessionId) ?? new Set();
    timers.add(timer);
    this.timers.set(sessionId, timers);
  }

  private clearTimers(sessionId: string): void {
    const timers = this.timers.get(sessionId);
    if (!timers) return;
    for (const timer of timers) clearTimeout(timer);
    this.timers.delete(sessionId);
  }

  private emit(event: AgentEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
