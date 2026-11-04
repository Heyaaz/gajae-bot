/**
 * @vitest-environment happy-dom
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TranscriptPageRequest } from "../../shared/agent-contract";
import { selectTranscriptPage } from "../../shared/transcript-page";
import { transcriptDelivery } from "../../shared/transcript-item-equal";
import type { AgentEvent, AgentSession, ChatMessage, TranscriptItem } from "../backend/types";
import { recentUserRequests } from "../transcript-utils";

// A stand-in for the controller's delivery contract: `sendMessage` echoes the
// prompt as `local-prompt-<n>`, the durable file later holds the same request
// under a `shared-message-` id (the echo is gone from the controller's own list),
// and the safety net reads the change against whatever baseline it handed out last.
const server = vi.hoisted(() => ({
  transcript: null as null | Record<string, unknown>,
  composer: null as null | Record<string, unknown>,
  listeners: new Set<(event: AgentEvent) => void>(),
  items: [] as TranscriptItem[],
  baseline: undefined as TranscriptItem[] | undefined,
  revision: 1,
  nextId: 1,
}));

vi.mock("../backend/use-agent-backend", () => {
  const session: AgentSession = {
    id: "s-1",
    title: "세션",
    subtitle: "gajae-bot",
    workspace: "/tmp/gajae-bot",
    runtime: "gjc",
    status: "idle",
    runRevision: 1,
    updatedAt: "10:00",
    updatedAtMs: 1,
    pinned: false,
    unread: false,
    accent: "#ff8a34",
    ownership: "gajae",
    attachment: "attached",
  };
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
      getTranscript: async () => server.items.map((item) => ({ ...item })),
      getTranscriptPage: async (_id: string, request?: TranscriptPageRequest) =>
        selectTranscriptPage(server.items, request),
      getTranscriptRevision: async () => String(server.revision),
      getTranscriptChanges: async () => {
        const next = server.items.map((item) => ({ ...item }));
        const change = transcriptDelivery(server.baseline, next);
        server.baseline = next;
        return change;
      },
      subscribe: (listener: (event: AgentEvent) => void) => {
        server.listeners.add(listener);
        return () => server.listeners.delete(listener);
      },
      markSessionRead: async () => undefined,
      getGoal: async () => ({ enabled: false, completed: 0, total: 0 }),
      sendMessage: async (_id: string, input: { text: string }) => {
        const echo: TranscriptItem = {
          id: `local-prompt-${server.nextId++}`,
          kind: "message",
          sessionId: "s-1",
          role: "user",
          content: input.text,
          createdAt: "12:51",
          streaming: false,
        };
        server.items = [...server.items, echo];
        for (const listener of server.listeners)
          listener({ type: "transcript.appended", item: echo });
        return "prompt" as const;
      },
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
vi.mock("./sidebar", () => ({ Sidebar: () => null }));
vi.mock("./composer", () => ({
  Composer: (props: Record<string, unknown>) => {
    server.composer = props;
    return null;
  },
  subscribeComposerReleaseRetry: () => () => undefined,
  releaseQueuedSession: async () => undefined,
  prefillComposerDraft: () => undefined,
}));
vi.mock("./transcript", () => ({
  ApprovalBanner: () => null,
  ConversationFindBar: () => null,
  RecentRequestStrip: () => null,
  Transcript: (props: Record<string, unknown>) => {
    server.transcript = props;
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
vi.mock("./parallel-view", () => ({ ParallelView: () => null }));
vi.mock("./project-list", () => ({ ProjectList: () => null }));
vi.mock("./remote", () => ({
  RemoteGate: () => null,
  RemoteStrip: () => null,
  remoteGateNeeded: () => false,
}));

import App from "./shell";

function message(
  id: string,
  role: "user" | "assistant",
  content: string,
  streaming = false,
): ChatMessage {
  return { id, kind: "message", sessionId: "s-1", role, content, createdAt: "12:00", streaming };
}

function shown(): TranscriptItem[] {
  return (server.transcript?.items ?? []) as TranscriptItem[];
}

function userTexts(): string[] {
  return shown().flatMap((item) =>
    item.kind === "message" && item.role === "user" ? [item.content] : [],
  );
}

function recentTexts(): string[] {
  return recentUserRequests(shown()).map((request) => request.text);
}

describe("a request sent while the turn runs shows once", () => {
  let root: Root | undefined;
  let host: HTMLDivElement | undefined;

  const emit = async (event: AgentEvent): Promise<void> => {
    await act(async () => {
      for (const listener of server.listeners) listener(event);
    });
  };
  const settle = async (): Promise<void> => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
    });
  };
  const send = async (text: string): Promise<void> => {
    await act(async () => {
      await (server.composer!.onSend as (input: unknown) => Promise<unknown>)({
        text,
        images: [],
        files: [],
      });
    });
  };
  /** The durable file takes the request; the controller's own echo is gone. */
  const persist = (text: string): TranscriptItem => {
    const row = message(`shared-message-${server.nextId++}`, "user", text);
    const echoIndex = server.items.findIndex(
      (item) => item.id.startsWith("local-prompt-") && item.kind === "message" && item.content === text,
    );
    server.items =
      echoIndex >= 0
        ? server.items.filter((_, index) => index !== echoIndex).concat(row)
        : [...server.items, row];
    server.revision += 1;
    return row;
  };
  /** One safety-net beat against a baseline taken before the request was sent. */
  const pollAgainstBaseline = async (before: TranscriptItem[]): Promise<void> => {
    server.baseline = before.map((item) => ({ ...item }));
    await emit({ type: "transcript.invalidated", sessionId: "s-1" });
    await settle();
  };

  beforeEach(async () => {
    server.items = [
      message("shared-message-u0", "user", "earlier"),
      message("shared-message-a0", "assistant", "reply"),
    ];
    server.baseline = undefined;
    server.revision = 1;
    server.nextId = 1;
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(createElement(App));
    });
    await vi.waitFor(() => expect(shown()).toHaveLength(2));
    await emit({ type: "transcript.invalidated", sessionId: "s-1" });
    await settle();
  });

  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    server.listeners.clear();
    server.transcript = null;
    server.composer = null;
  });

  it("keeps one user row and one recent request from the send to the end of the turn", async () => {
    const before = server.items;
    await send("이슈 올려");
    expect(userTexts()).toEqual(["earlier", "이슈 올려"]);

    persist("이슈 올려");
    await pollAgainstBaseline(before);
    expect(userTexts()).toEqual(["earlier", "이슈 올려"]);
    expect(recentTexts()).toEqual(["이슈 올려", "earlier"]);

    await emit({
      type: "transcript.appended",
      item: message("gjc-message-9", "assistant", "작업 중", true),
    });
    expect(userTexts()).toEqual(["earlier", "이슈 올려"]);

    server.items = [...server.items, message("shared-message-a1", "assistant", "작업 중")];
    server.revision += 1;
    server.baseline = undefined;
    await emit({ type: "transcript.invalidated", sessionId: "s-1" });
    await settle();
    expect(userTexts()).toEqual(["earlier", "이슈 올려"]);
    expect(recentTexts()).toEqual(["이슈 올려", "earlier"]);
  });

  it("settles on one row whichever of the event and the snapshot arrives first", async () => {
    const before = server.items;
    await send("이슈 올려");
    const durable = persist("이슈 올려");

    await emit({ type: "transcript.appended", item: durable });
    await pollAgainstBaseline(before.concat(durable));
    expect(userTexts()).toEqual(["earlier", "이슈 올려"]);

    await send("두 번째");
    const second = persist("두 번째");
    await pollAgainstBaseline(server.items.filter((item) => item !== second));
    await emit({ type: "transcript.appended", item: second });
    expect(userTexts()).toEqual(["earlier", "이슈 올려", "두 번째"]);
  });

  it("keeps the same words sent twice as two requests", async () => {
    let before = server.items;
    await send("계속");
    persist("계속");
    await pollAgainstBaseline(before);

    before = server.items;
    await send("계속");
    expect(userTexts()).toEqual(["earlier", "계속", "계속"]);
    persist("계속");
    await pollAgainstBaseline(before);
    expect(userTexts()).toEqual(["earlier", "계속", "계속"]);
    expect(recentTexts()).toEqual(["계속", "계속", "earlier"]);
  });

  it("does not bring the previous request back in a following turn", async () => {
    let before = server.items;
    await send("첫 요청");
    persist("첫 요청");
    await pollAgainstBaseline(before);

    before = server.items;
    await send("다음 요청");
    persist("다음 요청");
    await pollAgainstBaseline(before);
    expect(userTexts()).toEqual(["earlier", "첫 요청", "다음 요청"]);
    expect(recentTexts()).toEqual(["다음 요청", "첫 요청", "earlier"]);
  });
});
