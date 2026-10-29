/**
 * @vitest-environment happy-dom
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TranscriptPageRequest } from "../../shared/agent-contract";
import type { SessionShortcut } from "../../shared/settings-ipc";
import { selectTranscriptPage } from "../../shared/transcript-page";
import type { AgentEvent, AgentSession, TranscriptItem } from "../backend/types";
import type { ParallelGroup } from "../../shared/parallel-run";

const probe = vi.hoisted(() => ({
  sidebar: null as null | Record<string, unknown>,
  composer: null as null | Record<string, unknown>,
  transcript: null as null | Record<string, unknown>,
  renders: 0,
  listeners: new Set<(event: AgentEvent) => void>(),
  sessions: [] as AgentSession[],
  initialSession: null as AgentSession | null,
  newSessionDialog: null as null | Record<string, unknown>,
  parallelView: null as null | Record<string, unknown>,
  createSession: vi.fn(),
  prefillComposerDraft: vi.fn(),
}));

vi.mock("../backend/use-agent-backend", () => {
  const session: AgentSession = {
    id: "s-1",
    title: "세션",
    subtitle: "gajae-bot",
    workspace: "/tmp/gajae-bot",
    runtime: "gjc",
    status: "running",
    runRevision: 1,
    updatedAt: "10:00",
    updatedAtMs: 1,
    pinned: false,
    unread: false,
    accent: "#ff8a34",
    ownership: "gajae",
    attachment: "attached",
  };
  probe.initialSession = session;
  probe.sessions = [session];
  const items: TranscriptItem[] = [
    {
      id: "u-1",
      sessionId: "s-1",
      kind: "message",
      role: "user",
      content: "해 줘",
      createdAt: "now",
    },
    {
      id: "m-1",
      sessionId: "s-1",
      kind: "message",
      role: "assistant",
      content: "시작",
      streaming: true,
      createdAt: "now",
    },
  ];
  const backend = new Proxy(
    {
      remoteAccess: undefined,
      getConnection: async () => ({
        state: "connected" as const,
        backend: "gjc" as const,
        label: "GJC",
        detail: "ready",
        workspace: "/tmp/gajae-bot",
      }),
      listSessions: async () => probe.sessions,
      getTranscript: async () => items.map((item) => ({ ...item })),
      getTranscriptPage: async (
        _sessionId: string,
        request?: TranscriptPageRequest,
      ) => selectTranscriptPage(items, request),
      getTranscriptRevision: async () => undefined,
      getTranscriptChanges: async () => ({ kind: "patch" as const, items: [] }),
      subscribe: (listener: (event: AgentEvent) => void) => {
        probe.listeners.add(listener);
        return () => probe.listeners.delete(listener);
      },
      markSessionRead: async () => undefined,
      createSession: (input: { title: string; workspace: string }) => {
        probe.createSession(input);
        return Promise.resolve({ ...session, id: "s-created", title: input.title, status: "idle" });
      },
      getGoal: async () => ({ enabled: false, completed: 0, total: 0 }),
    },
    {
      get(target, prop, receiver) {
        if (Reflect.has(target, prop)) return Reflect.get(target, prop, receiver);
        return () => Promise.resolve(undefined);
      },
    },
  );
  return { useAgentBackend: () => backend };
});

vi.mock("./sidebar", () => ({
  Sidebar: (props: Record<string, unknown>) => {
    probe.sidebar = props;
    probe.renders += 1;
    return null;
  },
}));
vi.mock("./composer", () => ({
  Composer: (props: Record<string, unknown>) => {
    probe.composer = props;
    return null;
  },
  subscribeComposerReleaseRetry: () => () => undefined,
  releaseQueuedSession: async () => undefined,
  prefillComposerDraft: probe.prefillComposerDraft,
}));
vi.mock("./transcript", () => ({
  ApprovalBanner: () => null,
  ConversationFindBar: () => null,
  RecentRequestStrip: () => null,
  Transcript: (props: Record<string, unknown>) => {
    probe.transcript = props;
    return null;
  },
}));
vi.mock("./dialogs", () => ({
  DeleteSessionDialog: () => null,
  GlobalSearchDialog: () => null,
  NewSessionDialog: (props: Record<string, unknown>) => {
    probe.newSessionDialog = props;
    return null;
  },
  ResumeSessionDialog: () => null,
}));
vi.mock("./inspector", () => ({
  DiffPanel: () => null,
  GoalProgressRow: () => null,
  Inspector: () => null,
}));
vi.mock("./settings", () => ({ SettingsDialog: () => null }));
vi.mock("./repo-view", () => ({ RepoView: () => null }));
vi.mock("./parallel-view", () => ({
  ParallelView: (props: Record<string, unknown>) => {
    probe.parallelView = props;
    return null;
  },
}));
vi.mock("./project-list", () => ({ ProjectList: () => null }));
vi.mock("./remote", () => ({
  RemoteGate: () => null,
  RemoteStrip: () => null,
  remoteGateNeeded: () => false,
}));

import App from "./shell";

const composerFns = [
  "onSend",
  "onCancel",
  "onFlushQueued",
  "onCompact",
  "onNewSession",
  "onWorkspaceChange",
  "onConfigChange",
  "onCycleThinking",
] as const;

describe("streaming does not rebuild sidebar or composer props", () => {
  let root: Root | undefined;
  let host: HTMLDivElement | undefined;

  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    probe.sidebar = null;
    probe.composer = null;
    probe.transcript = null;
    probe.renders = 0;
    probe.listeners.clear();
    probe.sessions = probe.initialSession ? [probe.initialSession] : [];
  });

  it("keeps memo inputs stable across a message delta", async () => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(createElement(App));
    });
    await vi.waitFor(() => {
      expect(probe.sidebar).not.toBeNull();
      expect(probe.composer).not.toBeNull();
      expect(probe.transcript?.autoDenyHint).toEqual(
        expect.objectContaining({ message: expect.any(String) }),
      );
    });

    const sidebar = probe.sidebar!;
    const composer = probe.composer!;
    const transcript = probe.transcript!;
    const renders = probe.renders;

    await act(async () => {
      for (const listener of probe.listeners) {
        listener({
          type: "message.delta",
          sessionId: "s-1",
          messageId: "m-1",
          delta: " 이어서",
          streaming: true,
        });
      }
    });
    await vi.waitFor(() => expect(probe.renders).toBeGreaterThan(renders));

    expect(probe.sidebar!.onHide).toBe(sidebar.onHide);
    expect(probe.sidebar!.sessions).toBe(sidebar.sessions);
    expect(probe.sidebar!.onSelect).toBe(sidebar.onSelect);
    for (const name of composerFns) {
      expect(probe.composer![name]).toBe(composer[name]);
    }
    expect(probe.composer!.commands).toBe(composer.commands);
    expect(probe.composer!.configOptions).toBe(composer.configOptions);
    expect(probe.composer!.workspaces).toBe(composer.workspaces);
    expect(probe.composer!.running).toBe(true);
    expect(probe.transcript!.onRevealInspector).toBe(transcript.onRevealInspector);
    expect(probe.transcript!.onRetryLastRequest).toBe(transcript.onRetryLastRequest);
    expect(probe.transcript!.autoDenyHint).toBe(transcript.autoDenyHint);
    expect(probe.transcript!.onResolveTool).toBe(transcript.onResolveTool);
  });

  it("rejects stale session updates but accepts equal and newer revisions", async () => {
    probe.sessions = [
      {
        id: "s-1",
        title: "idle N",
        subtitle: "gajae-bot",
        workspace: "/tmp/gajae-bot",
        runtime: "gjc",
        status: "idle",
        runRevision: 4,
        updatedAt: "10:00",
        updatedAtMs: 1,
        pinned: false,
        unread: false,
        accent: "#ff8a34",
        ownership: "gajae",
        attachment: "attached",
      },
    ];
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(createElement(App));
    });
    await vi.waitFor(() => {
      expect(probe.sidebar?.sessions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ status: "idle", runRevision: 4 }),
        ]),
      );
    });

    const emit = async (session: AgentSession): Promise<void> => {
      await act(async () => {
        for (const listener of probe.listeners)
          listener({ type: "session.updated", session });
      });
    };
    const update = (
      status: AgentSession["status"],
      runRevision: number,
      title: string,
    ): AgentSession => ({
      ...probe.sessions[0]!,
      status,
      runRevision,
      title,
    });

    await emit(update("running", 3, "stale"));
    expect(probe.sidebar!.sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "idle",
          runRevision: 4,
          title: "idle N",
        }),
      ]),
    );

    await emit(update("idle", 4, "equal revision title"));
    expect(probe.sidebar!.sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "idle",
          runRevision: 4,
          title: "equal revision title",
        }),
      ]),
    );

    await emit(update("running", 5, "new running"));
    expect(probe.sidebar!.sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "running",
          runRevision: 5,
          title: "new running",
        }),
      ]),
    );
  });
});

describe("session shortcuts from the main process", () => {
  let root: Root | undefined;
  let host: HTMLDivElement | undefined;
  let shortcut: ((value: SessionShortcut) => void) | undefined;

  beforeEach(() => {
    probe.sessions = [
      probe.initialSession!,
      { ...probe.initialSession!, id: "s-2", title: "두 번째", status: "idle" },
    ];
    // Every settings call stays pending: these tests only drive the shortcut
    // channel, and a resolved undefined would replace the shell's preferences.
    const pending = new Proxy({}, { get: () => () => new Promise(() => undefined) });
    Object.assign(window, {
      agentControlDesktop: {
        settings: pending,
        onAbortRun: () => () => undefined,
        onSessionShortcut: (listener: (value: SessionShortcut) => void) => {
          shortcut = listener;
          return () => undefined;
        },
      },
    });
  });

  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    delete (window as { agentControlDesktop?: unknown }).agentControlDesktop;
    shortcut = undefined;
    probe.sidebar = null;
    probe.composer = null;
    probe.newSessionDialog = null;
    probe.createSession.mockClear();
    probe.prefillComposerDraft.mockClear();
    probe.listeners.clear();
    probe.sessions = probe.initialSession ? [probe.initialSession] : [];
  });

  async function mountApp(): Promise<void> {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root!.render(createElement(App)));
    await vi.waitFor(() => {
      expect(probe.composer?.sessionId).toBe("s-1");
      expect(shortcut).toBeDefined();
    });
  }

  // A function read, so the null written below does not narrow the probe for the checks after it.
  const shownSession = () => probe.composer?.sessionId;

  const notice = () => host?.querySelector(".app-error span")?.textContent ?? null;

  it("opens a known session from another screen and reports an unknown id", async () => {
    await mountApp();
    await act(async () => (probe.sidebar!.onOpenProjects as () => void)());
    probe.composer = null;

    await act(async () => shortcut!({ type: "open", sessionId: "missing" }));
    expect(shownSession()).toBeUndefined();
    expect(host!.querySelector(".workspace--empty")).toBeNull();
    expect(notice()).toBe("링크가 가리키는 세션을 찾지 못했습니다.");

    await act(async () => shortcut!({ type: "open", sessionId: "s-2" }));
    expect(shownSession()).toBe("s-2");
  });

  it("holds a session link that arrives before the session list", async () => {
    let releaseList: (sessions: AgentSession[]) => void = () => undefined;
    const listed = new Promise<AgentSession[]>((resolve) => (releaseList = resolve));
    const loaded = probe.sessions;
    probe.sessions = listed as unknown as AgentSession[];
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root!.render(createElement(App)));
    await vi.waitFor(() => expect(shortcut).toBeDefined());

    await act(async () => shortcut!({ type: "open", sessionId: "s-2" }));
    expect(notice()).toBeNull();

    await act(async () => releaseList(loaded));
    await vi.waitFor(() => expect(shownSession()).toBe("s-2"));
    expect(notice()).toBeNull();
  });

  it("tells the user why a link was refused and opens nothing", async () => {
    await mountApp();
    await act(async () =>
      shortcut!({ type: "invalidLink", reason: { kind: "path", path: "/no/such/folder" } }),
    );
    expect(notice()).toContain("/no/such/folder");
    expect(probe.newSessionDialog).toBeNull();
    expect(probe.createSession).not.toHaveBeenCalled();
    expect(shownSession()).toBe("s-1");
  });

  it("creates at once for a plain new and waits for confirmation with a prefill", async () => {
    await mountApp();
    await act(async () => shortcut!({ type: "new" }));
    expect(probe.createSession).toHaveBeenCalledOnce();
    expect(probe.newSessionDialog).toBeNull();
    probe.createSession.mockClear();

    const prefill = { workspace: "/tmp/other", prompt: "이슈 내용" };
    await act(async () => shortcut!({ type: "new", prefill }));
    expect(probe.newSessionDialog?.prefill).toEqual(prefill);
    expect(probe.createSession).not.toHaveBeenCalled();
    expect(probe.prefillComposerDraft).not.toHaveBeenCalled();

    await act(async () =>
      (probe.newSessionDialog!.onCreate as (input: unknown) => void)({
        title: "새 Gajae 세션",
        workspace: "/tmp/other",
        isolation: "workspace",
        initialPrompt: "이슈 내용",
      }),
    );
    expect(probe.createSession).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ workspace: "/tmp/other" }),
    );
    expect(probe.prefillComposerDraft).toHaveBeenCalledExactlyOnceWith("s-created", "이슈 내용", undefined);
    expect(probe.composer?.sessionId).toBe("s-created");
  });
});

describe("parallel runs from the new-session dialog", () => {
  let root: Root | undefined;
  let host: HTMLDivElement | undefined;
  let shortcut: ((value: SessionShortcut) => void) | undefined;
  let changed: ((groups: ParallelGroup[]) => void) | undefined;
  const group: ParallelGroup = {
    id: "g1",
    title: "로그인 고치기",
    prompt: "로그인 버그를 고쳐 줘",
    workspace: "/tmp/gajae-bot",
    createdAt: 1,
    state: { kind: "draft" },
    attempts: [
      { id: "1", preset: "codex-pro", branch: "feat/login-1", state: { kind: "started", sessionId: "s-2", worktreePath: "/wt/1" } },
      { id: "2", preset: "codex-eco", branch: "feat/login-2", state: { kind: "creating" } },
    ],
  };
  const start = vi.fn(async () => group);

  beforeEach(() => {
    probe.sessions = [
      probe.initialSession!,
      { ...probe.initialSession!, id: "s-2", title: "시도 1", status: "idle" },
    ];
    const pending = new Proxy({}, { get: () => () => new Promise(() => undefined) });
    Object.assign(window, {
      agentControlDesktop: {
        settings: pending,
        parallel: {
          list: async () => [],
          start,
          adopt: vi.fn(),
          discard: vi.fn(),
          cleanup: vi.fn(),
          onChanged: (listener: (groups: ParallelGroup[]) => void) => {
            changed = listener;
            return () => undefined;
          },
        },
        onAbortRun: () => () => undefined,
        onSessionShortcut: (listener: (value: SessionShortcut) => void) => {
          shortcut = listener;
          return () => undefined;
        },
      },
    });
  });

  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    delete (window as { agentControlDesktop?: unknown }).agentControlDesktop;
    shortcut = undefined;
    changed = undefined;
    start.mockClear();
    probe.sidebar = null;
    probe.composer = null;
    probe.newSessionDialog = null;
    probe.parallelView = null;
    probe.createSession.mockClear();
    probe.listeners.clear();
    probe.sessions = probe.initialSession ? [probe.initialSession] : [];
  });

  it("starts the group through the parallel bridge, opens its comparison, and reaches it again by ⌘ digit", async () => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root!.render(createElement(App)));
    await vi.waitFor(() => {
      expect(probe.composer?.sessionId).toBe("s-1");
      expect(shortcut).toBeDefined();
    });

    await act(async () => shortcut!({ type: "new", prefill: { workspace: "/tmp/gajae-bot" } }));
    expect(probe.newSessionDialog?.parallel).toEqual({
      presets: expect.arrayContaining(["codex-medium", "codex-pro", "codex-eco"]),
      defaultPreset: "codex-medium",
    });
    await act(async () =>
      (probe.newSessionDialog!.onCreate as (input: unknown) => void)({
        title: "로그인 고치기",
        workspace: "/tmp/gajae-bot",
        isolation: "worktree",
        worktreeBranch: "feat/login",
        initialPrompt: "로그인 버그를 고쳐 줘",
        parallelPresets: ["codex-pro", "codex-eco"],
      }),
    );
    expect(start).toHaveBeenCalledExactlyOnceWith({
      title: "로그인 고치기",
      workspace: "/tmp/gajae-bot",
      prompt: "로그인 버그를 고쳐 줘",
      branch: "feat/login",
      presets: ["codex-pro", "codex-eco"],
    });
    expect(probe.createSession).not.toHaveBeenCalled();
    await vi.waitFor(() => expect((probe.parallelView?.group as ParallelGroup | undefined)?.id).toBe("g1"));

    const running = { ...group, state: { kind: "running" as const } };
    await act(async () => changed!([running]));
    expect(probe.sidebar?.parallelGroups).toEqual([running]);
    expect(probe.sidebar?.openParallelGroupId).toBe("g1");
    expect(probe.parallelView?.group).toEqual(running);

    await act(async () => (probe.sidebar!.onSelect as (id: string) => void)("s-1"));
    expect(probe.sidebar?.openParallelGroupId).toBeNull();
    probe.parallelView = null;
    // s-1 is working and leads the rail; the group, placed by its idle attempt, is next.
    await act(async () => shortcut!({ type: "select", index: 1 }));
    await vi.waitFor(() => expect((probe.parallelView?.group as ParallelGroup | undefined)?.id).toBe("g1"));
  });
});
