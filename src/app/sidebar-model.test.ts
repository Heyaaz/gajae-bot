import { describe, expect, it } from "vitest";
import type { AgentSession } from "../backend/types";
import {
  SESSION_GROUP_LABELS,
  sessionGroupOf,
  sessionListModel,
} from "./sidebar-model";

function session(overrides: Partial<AgentSession>): AgentSession {
  return {
    id: "session",
    title: "Session",
    subtitle: "",
    workspace: "/tmp/project",
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

describe("sessionGroupOf", () => {
  it("sends approval waits and failures to 확인 필요", () => {
    expect(sessionGroupOf(session({ status: "waiting" }))).toBe("needs-input");
    expect(sessionGroupOf(session({ status: "failed" }))).toBe("needs-input");
  });

  it("keeps running and starting sessions in 작업 중", () => {
    expect(sessionGroupOf(session({ status: "running" }))).toBe("working");
    // A draft row is starting before the backend answers; it is being created, not
    // finished, so it must not open the list in 완료.
    expect(sessionGroupOf(session({ status: "starting" }))).toBe("working");
  });

  it("treats compaction as work even when the status reads idle", () => {
    // GJC reports the turn finished and compacts after it. Ranking that row 완료
    // moved it out of a finished group a moment later, so the phase wins.
    expect(sessionGroupOf(session({ status: "idle", phase: "compacting" }))).toBe(
      "working",
    );
  });

  it("leaves idle sessions in 완료", () => {
    expect(sessionGroupOf(session({ status: "idle" }))).toBe("completed");
  });
});

describe("sessionListModel", () => {
  it("orders groups by what the user has to act on, and drops empty ones", () => {
    const model = sessionListModel([
      session({ id: "done", status: "idle" }),
      session({ id: "busy", status: "running" }),
      session({ id: "asking", status: "waiting" }),
    ]);
    expect(model.groups.map((group) => group.id)).toEqual([
      "needs-input",
      "working",
      "completed",
    ]);
    expect(model.groups.map((group) => group.label)).toEqual([
      SESSION_GROUP_LABELS["needs-input"],
      SESSION_GROUP_LABELS.working,
      SESSION_GROUP_LABELS.completed,
    ]);
    expect(sessionListModel([session({ status: "idle" })]).groups.map((g) => g.id))
      .toEqual(["completed"]);
  });

  it("keeps pinned rows out of the state groups", () => {
    const model = sessionListModel([
      session({ id: "pinned", pinned: true, status: "idle" }),
      session({ id: "other", status: "idle" }),
    ]);
    expect(model.pinned.map((row) => row.id)).toEqual(["pinned"]);
    expect(model.groups.flatMap((group) => group.sessions).map((r) => r.id)).toEqual([
      "other",
    ]);
  });

  it("sorts newest first inside a group and inside the pinned section", () => {
    const model = sessionListModel([
      session({ id: "old", status: "idle", updatedAtMs: 1_000 }),
      session({ id: "new", status: "idle", updatedAtMs: 3_000 }),
      session({ id: "mid", status: "idle", updatedAtMs: 2_000 }),
      session({ id: "pin-old", pinned: true, updatedAtMs: 1_000 }),
      session({ id: "pin-new", pinned: true, updatedAtMs: 5_000 }),
    ]);
    expect(model.groups[0].sessions.map((row) => row.id)).toEqual([
      "new",
      "mid",
      "old",
    ]);
    expect(model.pinned.map((row) => row.id)).toEqual(["pin-new", "pin-old"]);
  });

  it("keeps backend order when a row has no sortable timestamp", () => {
    // The mock backend and drafts ship a display label only. Sorting those to the
    // bottom would reorder the rail for no reason, so they stay where they were.
    const model = sessionListModel([
      session({ id: "a", updatedAtMs: 1_000 }),
      session({ id: "b", updatedAt: "now" }),
      session({ id: "c", updatedAtMs: 2_000 }),
    ]);
    expect(model.groups[0].sessions.map((row) => row.id)).toEqual(["a", "b", "c"]);
  });

  it("caps a group at five rows and reports the rest as overflow", () => {
    const rows = Array.from({ length: 7 }, (_, index) =>
      session({ id: `s${index}`, status: "idle", updatedAtMs: 7_000 - index }),
    );
    const model = sessionListModel(rows);
    const [group] = model.groups;
    expect(group.sessions).toHaveLength(5);
    expect(group.overflow).toBe(2);
    // A digit always opens a row that is on screen, so a capped group hands out
    // five numbers and the sixth row waits behind 더 보기 rather than behind ⌘6.
    expect(model.shortcuts.map((row) => row.id)).toEqual([
      "s0",
      "s1",
      "s2",
      "s3",
      "s4",
    ]);
  });

  it("reveals every row of an expanded group without renumbering the digits", () => {
    const rows = Array.from({ length: 7 }, (_, index) =>
      session({ id: `s${index}`, status: "idle", updatedAtMs: 7_000 - index }),
    );
    const collapsed = sessionListModel(rows);
    const opened = sessionListModel(rows, {
      expanded: new Set(["completed"] as const),
    });
    expect(opened.groups[0].sessions).toHaveLength(7);
    expect(opened.groups[0].overflow).toBe(2);
    expect(opened.shortcuts).toEqual(collapsed.shortcuts);
  });

  it("numbers pinned rows first and keeps counting into the next group", () => {
    const rows = [
      session({ id: "pinned", pinned: true, updatedAtMs: 9_000 }),
      ...Array.from({ length: 5 }, (_, index) =>
        session({ id: `run${index}`, status: "running", updatedAtMs: 8_000 - index }),
      ),
      ...Array.from({ length: 5 }, (_, index) =>
        session({ id: `idle${index}`, status: "idle", updatedAtMs: 7_000 - index }),
      ),
    ];
    const model = sessionListModel(rows);
    expect(model.shortcuts).toHaveLength(9);
    expect(model.shortcuts.map((row) => row.id)).toEqual([
      "pinned",
      "run0",
      "run1",
      "run2",
      "run3",
      "run4",
      "idle0",
      "idle1",
      "idle2",
    ]);
  });
});
