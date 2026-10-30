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
  deleteSession: vi.fn(),
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
      confirmSessionRemoval: async () => true,
      deleteSession: (sessionId: string) => probe.deleteSession(sessionId),
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

  it("gives back the screenshots of a quick input request that a newer one replaces", async () => {
    const discardAttachments = vi.fn(async () => undefined);
    (window as unknown as { agentControlDesktop: { settings: unknown } }).agentControlDesktop.settings =
      new Proxy({}, {
        get: (_target, name) =>
          name === "discardAttachments" ? discardAttachments : () => new Promise(() => undefined),
      });
    await mountApp();
    const image = (token: string) => ({
      id: token, name: "capture.png", mimeType: "image/png", token, data: "AAAA",
    });
    await act(async () =>
      shortcut!({ type: "new", prefill: { workspace: "/tmp/a", images: [image("a".repeat(43))] } }),
    );
    expect(discardAttachments).not.toHaveBeenCalled();
    await act(async () =>
      shortcut!({ type: "new", prefill: { workspace: "/tmp/b", images: [image("b".repeat(43))] } }),
    );
    expect(discardAttachments).toHaveBeenCalledExactlyOnceWith(["a".repeat(43)]);
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

describe("a deleted row stays gone while the backend works", () => {
  let root: Root | undefined;
  let host: HTMLDivElement | undefined;

  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    probe.sidebar = null;
    probe.listeners.clear();
    probe.deleteSession.mockReset();
    probe.sessions = probe.initialSession ? [probe.initialSession] : [];
  });

  it("does not bring the row back when the window refocuses mid-delete", async () => {
    let finish!: () => void;
    probe.deleteSession.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(createElement(App));
    });
    const rowIds = () =>
      (probe.sidebar!.sessions as AgentSession[]).map((session) => session.id);
    await vi.waitFor(() => expect(rowIds()).toEqual(["s-1"]));

    await act(async () => {
      (probe.sidebar!.onDelete as (session: AgentSession) => void)(
        probe.initialSession!,
      );
    });
    await vi.waitFor(() => expect(probe.deleteSession).toHaveBeenCalledWith("s-1"));
    expect(rowIds()).toEqual([]);

    // Closing the host's confirm window refocuses this one, and the broker still
    // lists the session until its delete lands.
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await act(async () => undefined);
    expect(rowIds()).toEqual([]);

    probe.sessions = [];
    await act(async () => finish());
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(rowIds()).toEqual([]);
  });
});
