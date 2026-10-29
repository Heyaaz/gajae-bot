import { describe, expect, it } from "vitest";
import type { Automation, AutomationRun } from "../../shared/automation-ipc";
import { summarizeSessionAttention } from "../../shared/desktop-integration";
import type { AgentSession, TranscriptItem } from "../backend/types";
import {
  AUTOMATION_RUN_WINDOW_MS,
  buildInbox,
  elapsedLabel,
  lastReplyLine,
  type InboxSection,
} from "./inbox-model";
import { buildProjectGroups } from "./project-model";
import { sessionGroupOf } from "./sidebar-model";

const NOW = Date.parse("2026-10-29T12:00:00Z");

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
    accent: "#ffffff",
    ownership: "gajae",
    attachment: "attached",
    ...overrides,
  } as AgentSession;
}

function automation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: "auto-1",
    name: "Nightly triage",
    prompt: "triage",
    workspace: "/work/beta",
    schedule: { kind: "daily", time: "09:00" },
    enabled: true,
    worktree: true,
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
    nextRunAt: null,
    ...overrides,
  };
}

function run(overrides: Partial<AutomationRun>): AutomationRun {
  return {
    id: "run-1",
    automationId: "auto-1",
    status: "completed",
    startedAt: "2026-10-29T10:00:00Z",
    finishedAt: "2026-10-29T10:05:00Z",
    exitCode: 0,
    output: "",
    error: "",
    ...overrides,
  };
}

function inbox(
  sessions: AgentSession[],
  extra: Partial<Parameters<typeof buildInbox>[0]> = {},
): InboxSection[] {
  return buildInbox({
    sessions,
    projects: buildProjectGroups(sessions, []),
    now: NOW,
    ...extra,
  });
}

/** Section id -> item keys, which is what the view renders in order. */
function layout(sections: InboxSection[]): Record<string, string[]> {
  return Object.fromEntries(
    sections.map((section) => [
      section.id,
      section.items.map((item) => item.key),
    ]),
  );
}

describe("buildInbox", () => {
  it("collects sessions from every project into one grouped list", () => {
    const sessions = [
      session({ id: "a-wait", status: "waiting", workspace: "/work/alpha" }),
      session({ id: "b-fail", status: "failed", workspace: "/work/beta" }),
      session({ id: "c-done", status: "idle", unread: true, workspace: "/work/gamma" }),
      session({ id: "a-run", status: "running", workspace: "/work/alpha" }),
      session({ id: "b-read", status: "idle", unread: false, workspace: "/work/beta" }),
    ];

    const sections = inbox(sessions);

    expect(layout(sections)).toEqual({
      waiting: ["session:a-wait"],
      failed: ["session:b-fail"],
      completed: ["session:c-done"],
      working: ["session:a-run"],
    });
    const projects = sections.flatMap((section) =>
      section.items.map((item) => item.project),
    );
    expect(projects).toEqual(["alpha", "beta", "gamma", "alpha"]);
  });

  it("leaves out a finished session the user already read", () => {
    expect(inbox([session({ id: "read", status: "idle", unread: false })])).toEqual(
      [],
    );
  });

  it("files a compacting session under 실행 중 even when it reports idle", () => {
    const sections = inbox([
      session({ id: "compact", status: "idle", phase: "compacting", unread: true }),
    ]);
    expect(layout(sections)).toEqual({ working: ["session:compact"] });
  });

  it("agrees with the rail group and the shared attention count", () => {
    const sessions = [
      session({ id: "1", status: "waiting" }),
      session({ id: "2", status: "failed", unread: true }),
      session({ id: "3", status: "idle", unread: true }),
      session({ id: "4", status: "idle" }),
      session({ id: "5", status: "running", unread: true }),
      session({ id: "6", status: "starting" }),
      session({ id: "7", status: "idle", phase: "compacting" }),
      session({ id: "8", status: "unknown", unread: true }),
    ];
    const sections = inbox(sessions);

    const railGroup = { waiting: "needs-input", failed: "needs-input", completed: "completed", working: "working" } as const;
    for (const section of sections)
      for (const item of section.items)
        if (item.kind === "session")
          expect(sessionGroupOf(item.session)).toBe(railGroup[section.id]);

    const attention = summarizeSessionAttention(sessions);
    const count = (id: string) =>
      sections.find((section) => section.id === id)?.items.length ?? 0;
    expect(count("waiting") + count("failed")).toBe(attention.needsInput);
    expect(count("completed")).toBe(attention.unreadCompleted);
    expect(count("working")).toBe(attention.working);
  });

  it("orders each section newest first and keeps untimed rows in place", () => {
    const sections = inbox([
      session({ id: "old", status: "waiting", updatedAtMs: NOW - 60_000 }),
      session({ id: "new", status: "waiting", updatedAtMs: NOW - 1_000 }),
    ]);
    expect(layout(sections).waiting).toEqual(["session:new", "session:old"]);

    const untimed = inbox([
      session({ id: "first", status: "waiting" }),
      session({ id: "second", status: "waiting" }),
    ]);
    expect(layout(untimed).waiting).toEqual(["session:first", "session:second"]);
  });

  it("previews the newest assistant reply from a transcript this window holds", () => {
    const transcript: TranscriptItem[] = [
      { id: "m1", kind: "message", sessionId: "done", role: "assistant", content: "older", createdAt: "" },
      { id: "u1", kind: "message", sessionId: "done", role: "user", content: "again", createdAt: "" },
      {
        id: "m2",
        kind: "message",
        sessionId: "done",
        role: "assistant",
        content: "\n## 테스트 통과\n\n세부 내용",
        createdAt: "",
      },
    ];
    const sections = inbox(
      [
        session({ id: "done", status: "idle", unread: true }),
        session({ id: "cold", status: "waiting" }),
      ],
      { transcripts: { done: transcript } },
    );
    const items = sections.flatMap((section) => section.items);
    expect(items.find((item) => item.key === "session:done")?.preview).toBe(
      "테스트 통과",
    );
    expect(items.find((item) => item.key === "session:cold")?.preview).toBe(
      undefined,
    );
  });

  it("adds finished automation runs from the last day to 실패 and 완료", () => {
    const sections = inbox([session({ id: "w", status: "waiting" })], {
      automations: [automation()],
      runs: [
        run({ id: "ok", status: "completed", output: "line one\nsummary line\n" }),
        run({ id: "bad", status: "failed", error: "gjc exited 1\nstack", finishedAt: "2026-10-29T11:00:00Z" }),
        run({ id: "live", status: "running", finishedAt: null }),
        run({ id: "skip", status: "skipped" }),
        run({
          id: "stale",
          status: "failed",
          finishedAt: new Date(NOW - AUTOMATION_RUN_WINDOW_MS - 1).toISOString(),
        }),
        run({ id: "orphan", automationId: "deleted", status: "failed" }),
      ],
    });

    expect(layout(sections)).toEqual({
      waiting: ["session:w"],
      failed: ["automation-run:bad"],
      completed: ["automation-run:ok"],
    });
    const items = sections.flatMap((section) => section.items);
    const failed = items.find((item) => item.key === "automation-run:bad");
    expect(failed).toMatchObject({
      kind: "automation-run",
      title: "Nightly triage",
      project: "beta",
      preview: "gjc exited 1",
    });
    expect(items.find((item) => item.key === "automation-run:ok")?.preview).toBe(
      "summary line",
    );
  });

  it("puts sessions and runs that share a section in one recency order", () => {
    const sections = inbox(
      [
        session({ id: "s", status: "failed", updatedAtMs: Date.parse("2026-10-29T10:30:00Z") }),
      ],
      {
        automations: [automation()],
        runs: [run({ id: "r", status: "failed", finishedAt: "2026-10-29T11:00:00Z" })],
      },
    );
    expect(layout(sections).failed).toEqual(["automation-run:r", "session:s"]);
  });
});

describe("lastReplyLine", () => {
  it("skips code fences and empty replies", () => {
    expect(
      lastReplyLine([
        { id: "a", kind: "message", sessionId: "s", role: "assistant", content: "```ts\ncode", createdAt: "" },
        { id: "b", kind: "message", sessionId: "s", role: "assistant", content: "   ", createdAt: "" },
      ]),
    ).toBe("code");
    expect(lastReplyLine(undefined)).toBe(undefined);
  });
});

describe("elapsedLabel", () => {
  it("uses the rail's units", () => {
    expect(elapsedLabel(NOW - 30_000, NOW)).toBe("now");
    expect(elapsedLabel(NOW - 8 * 60_000, NOW)).toBe("8m");
    expect(elapsedLabel(NOW - 2 * 3_600_000, NOW)).toBe("2h");
    expect(elapsedLabel(NOW - 3 * 86_400_000, NOW)).toBe("3d");
  });
});
