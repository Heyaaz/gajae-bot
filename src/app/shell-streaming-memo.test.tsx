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

  it("opens a known session from another screen and ignores an unknown id", async () => {
    await mountApp();
    await act(async () => (probe.sidebar!.onOpenProjects as () => void)());
    probe.composer = null;

    await act(async () => shortcut!({ type: "open", sessionId: "missing" }));
    expect(shownSession()).toBeUndefined();
    expect(host!.querySelector(".workspace--empty")).toBeNull();

    await act(async () => shortcut!({ type: "open", sessionId: "s-2" }));
    expect(shownSession()).toBe("s-2");
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
    expect(probe.prefillComposerDraft).toHaveBeenCalledExactlyOnceWith("s-created", "이슈 내용");
    expect(probe.composer?.sessionId).toBe("s-created");
  });
});
