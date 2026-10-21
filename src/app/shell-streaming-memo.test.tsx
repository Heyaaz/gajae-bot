/**
 * @vitest-environment happy-dom
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TranscriptPageRequest } from "../../shared/agent-contract";
import { selectTranscriptPage } from "../../shared/transcript-page";
import type { AgentEvent, AgentSession, TranscriptItem } from "../backend/types";

const probe = vi.hoisted(() => ({
  sidebar: null as null | Record<string, unknown>,
  composer: null as null | Record<string, unknown>,
  transcript: null as null | Record<string, unknown>,
  renders: 0,
  listeners: new Set<(event: AgentEvent) => void>(),
}));

vi.mock("../backend/use-agent-backend", () => {
  const session: AgentSession = {
    id: "s-1",
    title: "세션",
    subtitle: "gajae-bot",
    workspace: "/tmp/gajae-bot",
    runtime: "gjc",
    status: "running",
    updatedAt: "10:00",
    updatedAtMs: 1,
    pinned: false,
    unread: false,
    accent: "#ff8a34",
    ownership: "gajae",
    attachment: "attached",
  };
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
      listSessions: async () => [session],
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
  NewSessionDialog: () => null,
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
});
