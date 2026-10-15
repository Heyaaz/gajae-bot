import { describe, expect, it } from "vitest";
import type { AgentSession } from "../backend/types";
import {
  SESSION_GROUP_LABELS,
  sessionGroupOf,
  sessionListModel,
} from "./sidebar-model";

/** The session ids a model would render, in order, across every group. */
function rowsOf(model: ReturnType<typeof sessionListModel>): string[] {
  return model.groups.flatMap((group) =>
    group.rows.map((row) => row.session.id),
  );
}

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
    expect(rowsOf(model)).toEqual(["other"]);
  });

  it("sorts newest first inside a group and inside the pinned section", () => {
    const model = sessionListModel([
      session({ id: "old", status: "idle", updatedAtMs: 1_000 }),
      session({ id: "new", status: "idle", updatedAtMs: 3_000 }),
      session({ id: "mid", status: "idle", updatedAtMs: 2_000 }),
      session({ id: "pin-old", pinned: true, updatedAtMs: 1_000 }),
      session({ id: "pin-new", pinned: true, updatedAtMs: 5_000 }),
    ]);
    expect(rowsOf(model)).toEqual(["new", "mid", "old"]);
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
    expect(rowsOf(model)).toEqual(["a", "b", "c"]);
  });

  it("caps a group at five rows and reports the rest as overflow", () => {
    const rows = Array.from({ length: 7 }, (_, index) =>
      session({ id: `s${index}`, status: "idle", updatedAtMs: 7_000 - index }),
    );
    const model = sessionListModel(rows);
    const [group] = model.groups;
    expect(group.rows).toHaveLength(5);
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
    expect(opened.groups[0].rows).toHaveLength(7);
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

describe("session families", () => {
  const fork = (id: string, parentId: string, overrides: Partial<AgentSession> = {}) =>
    session({ id, parentId, ...overrides });

  it("nests a fork under the session it came from", () => {
    const model = sessionListModel([
      session({ id: "parent", status: "idle", updatedAtMs: 2_000 }),
      fork("child", "parent", { status: "idle", updatedAtMs: 1_000 }),
    ]);
    const nodes = model.groups[0].rows;
    expect(nodes.map((node) => node.session.id)).toEqual(["parent", "child"]);
    expect(nodes.map((node) => node.depth)).toEqual([0, 1]);
    expect(nodes[0].familyHead).toBe(true);
    expect(nodes[1].familyHead).toBe(false);
  });

  it("places a family by its most actionable member", () => {
    // The parent finished, the fork is waiting on an approval: the family belongs
    // where its fork is, or the row that needs an answer sits in 완료.
    const model = sessionListModel([
      session({ id: "parent", status: "idle", updatedAtMs: 2_000 }),
      fork("child", "parent", { status: "waiting", updatedAtMs: 1_000 }),
    ]);
    expect(model.groups.map((group) => group.id)).toEqual(["needs-input"]);
    expect(rowsOf(model)).toEqual(["parent", "child"]);
  });

  it("flattens a chain onto one head and keeps parents before their children", () => {
    const model = sessionListModel([
      // Recency runs the other way on purpose: depth ordering is not a recency sort.
      session({ id: "a", status: "idle", updatedAtMs: 1_000 }),
      fork("b", "a", { status: "idle", updatedAtMs: 3_000 }),
      fork("c", "b", { status: "idle", updatedAtMs: 2_000 }),
    ]);
    expect(rowsOf(model)).toEqual(["a", "b", "c"]);
    expect(model.groups[0].rows.map((node) => node.depth)).toEqual([0, 1, 2]);
    // One head for the whole chain, so the family cannot split across groups.
    expect(model.groups[0].rows.filter((node) => node.familyHead)).toHaveLength(1);
  });

  it("leaves a row top-level when its parent is not in the list", () => {
    const model = sessionListModel([
      fork("orphan", "filtered-out", { status: "idle" }),
    ]);
    const [node] = model.groups[0].rows;
    expect(node.depth).toBe(0);
    expect(node.familyHead).toBe(false);
  });

  it("refuses a self-reference and a pair that names each other", () => {
    const model = sessionListModel([
      session({ id: "self", parentId: "self", status: "idle", updatedAtMs: 3_000 }),
      session({ id: "left", parentId: "right", status: "idle", updatedAtMs: 2_000 }),
      session({ id: "right", parentId: "left", status: "idle", updatedAtMs: 1_000 }),
    ]);
    // A cycle has no head, so both stay where they are rather than becoming each
    // other's child and rendering twice.
    expect(rowsOf(model)).toEqual(["self", "left", "right"]);
    expect(model.groups[0].rows.every((node) => node.depth === 0)).toBe(true);
  });

  it("hides a closed family's members but keeps approvals and the row being read", () => {
    const model = sessionListModel(
      [
        session({ id: "head", status: "idle", updatedAtMs: 9_000 }),
        fork("waiting", "head", { status: "waiting", updatedAtMs: 5_000 }),
        fork("selected", "head", { status: "idle", updatedAtMs: 6_000 }),
        fork("broken", "head", { status: "failed", unread: true, updatedAtMs: 4_000 }),
        fork("busy", "head", { status: "running", updatedAtMs: 3_000 }),
      ],
      { selectedId: "selected", collapsedFamilies: new Set(["head"]) },
    );
    const nodes = model.groups[0].rows;
    expect(nodes.map((node) => node.session.id)).toEqual([
      "head",
      "selected",
      "waiting",
    ]);
    expect(nodes[0].familyHead).toBe(true);
    expect(nodes[0].hidden).toBe(2);
    // What is behind the count, most actionable first: the failure and the running
    // fork. The approval wait is not counted because it was not hidden.
    expect(nodes[0].hiddenSummary).toEqual({ failed: 1, unread: 1, working: 1 });
  });

  it("shows every member of an opened family and drops the count", () => {
    const rows = [
      session({ id: "head", status: "idle", updatedAtMs: 9_000 }),
      fork("one", "head", { status: "idle", updatedAtMs: 2_000 }),
      fork("two", "head", { status: "failed", updatedAtMs: 1_000 }),
    ];
    // Open is the default: a fork is only hidden once the user closes it.
    const opened = sessionListModel(rows);
    const closed = sessionListModel(rows, {
      collapsedFamilies: new Set(["head"]),
    });
    expect(opened.groups[0].rows.map((node) => node.session.id)).toEqual([
      "head",
      "one",
      "two",
    ]);
    expect(opened.groups[0].rows[0].hidden).toBe(0);
    expect(opened.groups[0].rows[0].hiddenSummary).toBeNull();
    expect(closed.groups[0].rows.map((node) => node.session.id)).toEqual([
      "head",
    ]);
    expect(closed.groups[0].rows[0].hidden).toBe(2);
  });

  it("counts a family as one slot against the group cap", () => {
    const rows = [
      ...Array.from({ length: 5 }, (_, index) =>
        session({ id: `solo${index}`, status: "idle", updatedAtMs: 9_000 - index }),
      ),
      session({ id: "head", status: "idle", updatedAtMs: 1_000 }),
      fork("kid1", "head", { status: "idle", updatedAtMs: 900 }),
      fork("kid2", "head", { status: "idle", updatedAtMs: 800 }),
    ];
    const model = sessionListModel(rows);
    const [group] = model.groups;
    // Six roots, five slots: the family waits behind 더 보기, and its two members
    // come along with its head rather than consuming slots of their own.
    expect(group.overflow).toBe(1);
    expect(group.rows.some((node) => node.session.id === "head")).toBe(false);
    expect(model.shortcuts.map((row) => row.id)).toEqual([
      "solo0",
      "solo1",
      "solo2",
      "solo3",
      "solo4",
    ]);
  });
});
