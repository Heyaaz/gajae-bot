/**
 * @vitest-environment happy-dom
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  Automation,
  AutomationDesktopBridge,
  AutomationRun,
} from "../../shared/automation-ipc";
import type { TranscriptPageRequest } from "../../shared/agent-contract";
import { selectTranscriptPage } from "../../shared/transcript-page";
import type { AgentEvent, AgentSession } from "../backend/types";
import { InboxView } from "./inbox-view";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const probe = vi.hoisted(() => ({
  transcript: null as null | { sessionId: string },
  markRead: [] as string[],
  cancelled: [] as string[],
  sessions: [] as AgentSession[],
}));

function session(overrides: Partial<AgentSession>): AgentSession {
  return {
    id: "session",
    title: "Session",
    subtitle: "",
    workspace: "/work/alpha",
    runtime: "gjc",
    status: "idle",
    updatedAt: "now",
    pinned: false,
    unread: false,
    accent: "#ff8a34",
    ownership: "gajae",
    attachment: "attached",
    ...overrides,
  };
}

vi.mock("../backend/use-agent-backend", () => {
  const backend = new Proxy(
    {
      remoteAccess: undefined,
      getConnection: async () => ({
        state: "connected" as const,
        backend: "gjc" as const,
        label: "GJC",
        detail: "ready",
        workspace: "/work/alpha",
      }),
      listSessions: async () => probe.sessions.map((row) => ({ ...row })),
      getTranscript: async () => [],
      getTranscriptPage: async (_id: string, request?: TranscriptPageRequest) =>
        selectTranscriptPage([], request),
      getTranscriptRevision: async () => undefined,
      getTranscriptChanges: async () => ({ kind: "patch" as const, items: [] }),
      subscribe: (_listener: (event: AgentEvent) => void) => () => undefined,
      markSessionRead: async (sessionId: string) => {
        probe.markRead.push(sessionId);
      },
      cancelRun: async (sessionId: string) => {
        probe.cancelled.push(sessionId);
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

vi.mock("./composer", () => ({
  Composer: () => null,
  subscribeComposerReleaseRetry: () => () => undefined,
  releaseQueuedSession: async () => undefined,
}));
vi.mock("./transcript", () => ({
  ApprovalBanner: () => null,
  ConversationFindBar: () => null,
  RecentRequestStrip: () => null,
  Transcript: (props: { sessionId: string }) => {
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
vi.mock("./remote", () => ({
  RemoteGate: () => null,
  RemoteStrip: () => null,
  remoteGateNeeded: () => false,
}));

import App from "./shell";

let root: Root | undefined;
let host: HTMLDivElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
  probe.transcript = null;
  probe.markRead = [];
  probe.cancelled = [];
  probe.sessions = [];
});

async function mount(node: ReturnType<typeof createElement>): Promise<HTMLDivElement> {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(node);
  });
  return host;
}

function inbox(): HTMLElement | null {
  return document.querySelector<HTMLElement>("main.inbox-view");
}

function sectionRows(sectionId: string): string[] {
  return [
    ...(inbox()?.querySelectorAll<HTMLElement>(
      `[data-section="${sectionId}"] .inbox-row strong`,
    ) ?? []),
  ].map((node) => node.textContent ?? "");
}

function rowButton(title: string): HTMLButtonElement {
  const row = [
    ...inbox()!.querySelectorAll<HTMLButtonElement>(".inbox-row__button"),
  ].find((button) => button.querySelector("strong")?.textContent === title);
  if (!row) throw new Error(`no inbox row titled ${title}`);
  return row;
}

describe("Inbox inside the shell", () => {
  it("lists every project's sessions by group, opens the clicked one and marks it read", async () => {
    probe.sessions = [
      session({ id: "a-run", title: "알파 작업", status: "running", workspace: "/work/alpha", updatedAtMs: 4 }),
      session({ id: "a-wait", title: "알파 승인", status: "waiting", workspace: "/work/alpha", updatedAtMs: 3 }),
      session({ id: "b-fail", title: "베타 실패", status: "failed", workspace: "/work/beta", updatedAtMs: 2 }),
      session({ id: "c-done", title: "감마 완료", status: "idle", unread: true, workspace: "/work/gamma", updatedAtMs: 1 }),
      session({ id: "c-read", title: "감마 읽음", status: "idle", workspace: "/work/gamma", updatedAtMs: 0 }),
    ];
    await mount(createElement(App));
    await vi.waitFor(() => expect(probe.transcript).not.toBeNull());
    const before = probe.transcript!.sessionId;

    const entry = document.querySelector<HTMLButtonElement>(".inbox-entry");
    expect(entry?.querySelector(".inbox-entry__count")?.textContent).toBe("3");
    await act(async () => entry!.click());
    await vi.waitFor(() => expect(inbox()).not.toBeNull());
    await vi.waitFor(() => expect(sectionRows("waiting")).toEqual(["알파 승인"]));
    expect(sectionRows("failed")).toEqual(["베타 실패"]);
    expect(sectionRows("completed")).toEqual(["감마 완료"]);
    expect(sectionRows("working")).toEqual(["알파 작업"]);
    expect(inbox()!.textContent).not.toContain("감마 읽음");
    const projects = [
      ...inbox()!.querySelectorAll(".inbox-row__project"),
    ].map((node) => node.textContent);
    expect(projects).toEqual(["alpha", "beta", "gamma", "alpha"]);

    const target = before === "c-done" ? "베타 실패" : "감마 완료";
    const targetId = before === "c-done" ? "b-fail" : "c-done";
    await act(async () => rowButton(target).click());

    await vi.waitFor(() => expect(probe.transcript?.sessionId).toBe(targetId));
    expect(inbox()).toBeNull();
    await vi.waitFor(() => expect(probe.markRead).toContain(targetId));
  });

  it("marks the already selected session read when its row is opened", async () => {
    probe.sessions = [
      session({ id: "only", title: "단독 완료", status: "idle", unread: true }),
    ];
    await mount(createElement(App));
    await vi.waitFor(() => expect(probe.transcript?.sessionId).toBe("only"));
    probe.markRead = [];

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "¨", code: "KeyU", metaKey: true, altKey: true }),
      );
    });
    await vi.waitFor(() => expect(inbox()).not.toBeNull());
    await vi.waitFor(() => expect(sectionRows("completed")).toEqual(["단독 완료"]));
    await act(async () => rowButton("단독 완료").click());

    expect(inbox()).toBeNull();
    expect(probe.markRead).toEqual(["only"]);
  });

  it("toggles with ⌥⌘U and leaves on Escape without touching the run behind it", async () => {
    probe.sessions = [session({ id: "s", status: "running" })];
    await mount(createElement(App));
    await vi.waitFor(() => expect(probe.transcript).not.toBeNull());
    const press = (init: KeyboardEventInit) =>
      act(async () => {
        window.dispatchEvent(new KeyboardEvent("keydown", init));
      });

    await press({ key: "u", code: "KeyU", metaKey: true });
    expect(inbox()).toBeNull();
    await press({ key: "¨", code: "KeyU", metaKey: true, altKey: true });
    await vi.waitFor(() => expect(inbox()).not.toBeNull());
    await press({ key: "¨", code: "KeyU", metaKey: true, altKey: true });
    expect(inbox()).toBeNull();

    await press({ key: "¨", code: "KeyU", metaKey: true, altKey: true });
    await vi.waitFor(() => expect(inbox()).not.toBeNull());
    await press({ key: "Escape", code: "Escape" });
    expect(inbox()).toBeNull();
    expect(probe.cancelled).toEqual([]);

    // The same key in the conversation is still the abort gesture.
    await press({ key: "Escape", code: "Escape" });
    expect(probe.cancelled).toEqual(["s"]);
  });
});

describe("InboxView automation runs", () => {
  const nightly: Automation = {
    id: "auto-1",
    name: "야간 점검",
    prompt: "check",
    workspace: "/work/beta",
    schedule: { kind: "daily", time: "09:00" },
    enabled: true,
    worktree: true,
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
    nextRunAt: null,
  };

  function runOf(overrides: Partial<AutomationRun>): AutomationRun {
    const finished = new Date(Date.now() - 5 * 60_000).toISOString();
    return {
      id: "run",
      automationId: "auto-1",
      status: "completed",
      startedAt: finished,
      finishedAt: finished,
      exitCode: 0,
      output: "",
      error: "",
      ...overrides,
    };
  }

  function bridge(runs: AutomationRun[]): AutomationDesktopBridge {
    return {
      list: async () => [nightly],
      listRuns: async () => runs,
      create: vi.fn(),
      updateEnabled: vi.fn(),
      delete: vi.fn(),
      runNow: vi.fn(),
    };
  }

  it("shows finished runs as inbox rows whose output unfolds in place", async () => {
    await mount(
      createElement(InboxView, {
        sessions: [],
        projects: [],
        transcripts: {},
        automations: bridge([
          runOf({ id: "bad", status: "failed", error: "gjc exited 1", output: "partial" }),
          runOf({ id: "ok", status: "completed", output: "모두 통과" }),
        ]),
        onOpenSession: vi.fn(),
        onClose: vi.fn(),
      }),
    );

    await vi.waitFor(() => expect(sectionRows("failed")).toEqual(["야간 점검"]));
    expect(sectionRows("completed")).toEqual(["야간 점검"]);
    const failedRow = inbox()!.querySelector<HTMLElement>('[data-section="failed"] .inbox-row')!;
    expect(failedRow.querySelector(".inbox-row__preview")?.textContent).toBe("gjc exited 1");
    expect(failedRow.querySelector(".inbox-row__project")?.textContent).toBe("beta");

    const button = failedRow.querySelector<HTMLButtonElement>("button")!;
    expect(button.getAttribute("aria-expanded")).toBe("false");
    await act(async () => button.click());
    expect(failedRow.querySelector(".inbox-row__output")?.textContent).toBe(
      "gjc exited 1\n\npartial",
    );
  });

  it("renders sessions alone when there is no automation bridge", async () => {
    await mount(
      createElement(InboxView, {
        sessions: [session({ id: "w", title: "대기", status: "waiting" })],
        projects: [],
        transcripts: {},
        onOpenSession: vi.fn(),
        onClose: vi.fn(),
      }),
    );
    await vi.waitFor(() => expect(sectionRows("waiting")).toEqual(["대기"]));
    expect(inbox()!.querySelectorAll('[data-kind="automation-run"]')).toHaveLength(0);
  });
});
