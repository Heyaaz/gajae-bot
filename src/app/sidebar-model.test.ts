import { describe, expect, it } from "vitest";
import type { ParallelGroup } from "../../shared/parallel-run";
import type { AgentSession } from "../backend/types";
import {
  SESSION_GROUP_LABELS,
  parallelGroupIdOf,
  parallelHeadId,
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
    expect(model.pinned.map((row) => row.session.id)).toEqual(["pinned"]);
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
    expect(model.pinned.map((row) => row.session.id)).toEqual([
      "pin-new",
      "pin-old",
    ]);
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

  it("brings a fork into the pinned section when its head is pinned", () => {
    const model = sessionListModel([
      session({ id: "head", pinned: true, status: "idle", updatedAtMs: 9_000 }),
      fork("kid", "head", { status: "idle", updatedAtMs: 8_000 }),
    ]);
    // The pin holds the family together: the fork renders under its head instead of
    // becoming a top-level row in whichever group it would have reached.
    expect(model.pinned.map((node) => node.session.id)).toEqual(["head", "kid"]);
    expect(model.pinned.map((node) => node.depth)).toEqual([0, 1]);
    expect(model.pinned[0].familyHead).toBe(true);
    expect(rowsOf(model)).toEqual([]);
  });

  it("keeps a pinned fork out of its head's family", () => {
    const model = sessionListModel([
      session({ id: "head", status: "idle", updatedAtMs: 9_000 }),
      fork("pinned-kid", "head", {
        pinned: true,
        status: "idle",
        updatedAtMs: 8_000,
      }),
      fork("kid", "head", { status: "idle", updatedAtMs: 7_000 }),
    ]);
    // A pinned fork is a row of the pinned section; its head keeps the rest.
    expect(model.pinned.map((node) => node.session.id)).toEqual(["pinned-kid"]);
    expect(rowsOf(model)).toEqual(["head", "kid"]);
  });

  it("counts a family as one slot against the group cap", () => {    const rows = [
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

  it("keeps the family of the row being read past the cap", () => {
    const rows = [
      ...Array.from({ length: 5 }, (_, index) =>
        session({ id: `solo${index}`, status: "idle", updatedAtMs: 9_000 - index }),
      ),
      session({ id: "head", status: "idle", updatedAtMs: 1_000 }),
      fork("kid1", "head", { status: "idle", updatedAtMs: 900 }),
      fork("kid2", "head", { status: "idle", updatedAtMs: 800 }),
    ];
    const model = sessionListModel(rows, { selectedId: "kid2" });
    const [group] = model.groups;
    // The cap decides which families the group leads with, not whether the row the
    // user is reading is on the rail: its whole family comes along.
    expect(group.rows.map((node) => node.session.id)).toEqual([
      "solo0",
      "solo1",
      "solo2",
      "solo3",
      "solo4",
      "head",
      "kid1",
      "kid2",
    ]);
    expect(group.rows.slice(5).map((node) => node.depth)).toEqual([0, 1, 1]);
    // Every root is on screen, so there is nothing left to open.
    expect(group.overflow).toBe(0);
    // The kept family sits past the cap and takes no digit from the capped rows.
    expect(model.shortcuts.map((row) => row.id)).toEqual([
      "solo0",
      "solo1",
      "solo2",
      "solo3",
      "solo4",
    ]);
  });

  it("keeps a selected root on the rail when the cap would drop it", () => {
    const rows = Array.from({ length: 7 }, (_, index) =>
      session({ id: `s${index}`, status: "idle", updatedAtMs: 7_000 - index }),
    );
    const model = sessionListModel(rows, { selectedId: "s6" });
    const [group] = model.groups;
    expect(group.rows.map((node) => node.session.id)).toEqual([
      "s0",
      "s1",
      "s2",
      "s3",
      "s4",
      "s6",
    ]);
    // s5 is still behind 더 보기, so the count is the row that is missing.
    expect(group.overflow).toBe(1);
    expect(model.shortcuts.map((row) => row.id)).toEqual([
      "s0",
      "s1",
      "s2",
      "s3",
      "s4",
    ]);
  });

  it("moves the forks below a pinned fork into the pinned section with it", () => {
    const model = sessionListModel([
      session({ id: "a", status: "idle", updatedAtMs: 3_000 }),
      fork("b", "a", { pinned: true, status: "idle", updatedAtMs: 2_000 }),
      fork("c", "b", { status: "idle", updatedAtMs: 1_000 }),
    ]);
    // The pin is where the branch heads now: b draws c instead of leaving it at
    // depth 2 under a, where its own fork no longer sits beside it.
    expect(model.pinned.map((node) => node.session.id)).toEqual(["b", "c"]);
    expect(model.pinned.map((node) => node.depth)).toEqual([0, 1]);
    expect(model.pinned[0].familyHead).toBe(true);
    expect(rowsOf(model)).toEqual(["a"]);
  });

  it("leaves the forks above a pinned fork in the group", () => {
    const model = sessionListModel([
      session({ id: "a", status: "idle", updatedAtMs: 4_000 }),
      fork("b", "a", { status: "idle", updatedAtMs: 3_000 }),
      fork("c", "b", { pinned: true, status: "idle", updatedAtMs: 2_000 }),
      fork("d", "c", { status: "idle", updatedAtMs: 1_000 }),
    ]);
    // Only the pinned fork and what hangs below it move: the rest of the chain keeps
    // its nesting, and no row is drawn twice.
    expect(model.pinned.map((node) => node.session.id)).toEqual(["c", "d"]);
    expect(model.pinned.map((node) => node.depth)).toEqual([0, 1]);
    expect(rowsOf(model)).toEqual(["a", "b"]);
    expect(model.groups[0].rows.map((node) => node.depth)).toEqual([0, 1]);
  });

  it("keeps a pinned fork inside the family of the pinned head above it", () => {
    const model = sessionListModel([
      session({ id: "head", pinned: true, status: "idle", updatedAtMs: 4_000 }),
      fork("kid", "head", { pinned: true, status: "idle", updatedAtMs: 3_000 }),
      fork("grandkid", "kid", { status: "idle", updatedAtMs: 2_000 }),
    ]);
    // The outermost pin owns the branch: the pin below it renders as a row of that
    // family instead of starting a second one.
    expect(model.pinned.map((node) => node.session.id)).toEqual([
      "head",
      "kid",
      "grandkid",
    ]);
    expect(model.pinned.map((node) => node.depth)).toEqual([0, 1, 2]);
    expect(model.pinned.filter((node) => node.familyHead)).toHaveLength(1);
    expect(rowsOf(model)).toEqual([]);
  });

  it("places a family by the members it still draws", () => {
    const model = sessionListModel([
      session({ id: "a", status: "idle", updatedAtMs: 3_000 }),
      fork("b", "a", { pinned: true, status: "running", updatedAtMs: 2_000 }),
      fork("c", "b", { status: "running", updatedAtMs: 1_000 }),
    ]);
    // b and c render in 고정됨, so the work below the pin cannot be the reason a
    // lands in 작업 중 while its own row belongs in 완료.
    expect(model.groups.map((group) => group.id)).toEqual(["completed"]);
    expect(rowsOf(model)).toEqual(["a"]);
  });

  it("keeps a pinned row of a cycle out of a family", () => {
    const model = sessionListModel([
      session({
        id: "left",
        parentId: "right",
        pinned: true,
        status: "idle",
        updatedAtMs: 2_000,
      }),
      session({
        id: "right",
        parentId: "left",
        status: "idle",
        updatedAtMs: 1_000,
      }),
    ]);
    // A cycle has no head, so the pin moves the one row it always did instead of
    // turning the pair into a family and dragging right along.
    expect(model.pinned.map((node) => node.session.id)).toEqual(["left"]);
    expect(model.pinned[0].familyHead).toBe(false);
    expect(rowsOf(model)).toEqual(["right"]);
  });

  it("moves the forks below a pinned row whose own parent is missing", () => {
    const model = sessionListModel([
      fork("orphan", "gone", {
        pinned: true,
        status: "idle",
        updatedAtMs: 2_000,
      }),
      fork("kid", "orphan", { status: "idle", updatedAtMs: 1_000 }),
    ]);
    expect(model.pinned.map((node) => node.session.id)).toEqual(["orphan", "kid"]);
    expect(model.pinned.map((node) => node.depth)).toEqual([0, 1]);
    expect(rowsOf(model)).toEqual([]);
  });
});

describe("parallel groups", () => {
  const group: ParallelGroup = {
    id: "g1",
    title: "로그인 고치기",
    prompt: "로그인 버그를 고쳐 줘",
    workspace: "/tmp/project",
    createdAt: 1,
    state: { kind: "running" },
    attempts: [
      { id: "1", preset: "codex-pro", branch: "b-1", state: { kind: "started", sessionId: "a1", worktreePath: "/wt/1" } },
      { id: "2", preset: "codex-eco", branch: "b-2", state: { kind: "failed", reason: "x" } },
      { id: "3", preset: "codex-medium", branch: "b-3", state: { kind: "started", sessionId: "a3", worktreePath: "/wt/3" } },
    ],
  };

  it("nests the attempts under one group row, with a fork of an attempt below it", () => {
    const rows = [
      session({ id: "a1", updatedAtMs: 30 }),
      session({ id: "a3", updatedAtMs: 20 }),
      session({ id: "fork", parentId: "a1", updatedAtMs: 10 }),
      session({ id: "solo", updatedAtMs: 5 }),
    ];
    const model = sessionListModel(rows, { parallelGroups: [group] });
    const nodes = model.groups.flatMap((block) => block.rows);
    expect(nodes.map((node) => [node.session.id, node.depth])).toEqual([
      [parallelHeadId("g1"), 0],
      ["a1", 1],
      ["fork", 2],
      ["a3", 1],
      ["solo", 0],
    ]);
    expect(nodes[0]!.parallelGroup).toBe(group);
    expect(nodes[0]!.familyHead).toBe(true);
    expect(model.shortcuts.map((row) => row.id)).toEqual([parallelHeadId("g1"), "solo"]);
    expect(parallelGroupIdOf(model.shortcuts[0]!.id)).toBe("g1");
    expect(parallelGroupIdOf("a1")).toBeUndefined();
  });

  it("places the group by its most actionable attempt and keeps it closed on request", () => {
    const rows = [
      session({ id: "a1", status: "running" }),
      session({ id: "a3", status: "waiting" }),
    ];
    const open = sessionListModel(rows, { parallelGroups: [group] });
    expect(open.groups.map((block) => block.id)).toEqual(["needs-input"]);

    const closed = sessionListModel(rows, {
      parallelGroups: [group],
      collapsedFamilies: new Set([parallelHeadId("g1")]),
    });
    // The approval wait stays on screen; the running attempt is counted on the head.
    expect(rowsOf(closed)).toEqual([parallelHeadId("g1"), "a3"]);
    expect(closed.groups[0]!.rows[0]!.hiddenSummary).toEqual({
      failed: 0,
      unread: 0,
      working: 1,
    });
  });

  it("keeps a row for a group whose attempts all failed to be created, until they are cleaned up", () => {
    const failed: ParallelGroup = {
      ...group,
      attempts: group.attempts.map((attempt) => ({
        ...attempt,
        state: { kind: "failed" as const, reason: "x" },
      })),
    };
    const model = sessionListModel([session({ id: "solo" })], { parallelGroups: [failed] });
    expect(rowsOf(model)).toContain(parallelHeadId("g1"));
    const removed: ParallelGroup = {
      ...failed,
      state: { kind: "discarded" },
      attempts: failed.attempts.map((attempt) => ({ ...attempt, state: { kind: "removed" as const } })),
    };
    expect(rowsOf(sessionListModel([session({ id: "solo" })], { parallelGroups: [removed] }))).toEqual(["solo"]);
  });

  it("draws no group row once none of its attempts is listed", () => {
    const model = sessionListModel([session({ id: "solo" })], { parallelGroups: [group] });
    expect(rowsOf(model)).toEqual(["solo"]);
  });
});

describe("sessionListModel by project", () => {
  const projects: Record<string, { id: string; name: string }> = {
    "/work/zeta": { id: "/work/zeta", name: "zeta" },
    "/work/alpha": { id: "/work/alpha", name: "alpha" },
  };
  const projectOf = (row: AgentSession) => projects[row.workspace];

  it("keeps waiting rows on top and sections the rest by project, working first", () => {
    const model = sessionListModel(
      [
        session({ id: "z-done", workspace: "/work/zeta", updatedAtMs: 5 }),
        session({ id: "z-run", workspace: "/work/zeta", status: "running", updatedAtMs: 1 }),
        session({ id: "a-wait", workspace: "/work/alpha", status: "waiting" }),
        session({ id: "a-done", workspace: "/work/alpha" }),
      ],
      { projectOf },
    );
    expect(model.groups.map((group) => [group.label, group.rows.map((row) => row.session.id)])).toEqual([
      [SESSION_GROUP_LABELS["needs-input"], ["a-wait"]],
      ["alpha", ["a-done"]],
      ["zeta", ["z-run", "z-done"]],
    ]);
    expect(model.shortcuts.map((row) => row.id)).toEqual(["a-wait", "a-done", "z-run", "z-done"]);
  });

  it("folds a project to its header and keeps its working count", () => {
    const model = sessionListModel(
      [
        session({ id: "z-run", workspace: "/work/zeta", status: "running" }),
        session({ id: "z-done", workspace: "/work/zeta" }),
        session({ id: "a-done", workspace: "/work/alpha" }),
      ],
      { projectOf, collapsedProjects: new Set(["/work/zeta"]) },
    );
    const zeta = model.groups.find((group) => group.label === "zeta")!;
    expect(zeta.rows).toEqual([]);
    expect(zeta.project).toEqual({ collapsed: true, working: 1 });
    // A folded project's rows take no ⌘ digit: the digit would open a row nobody sees.
    expect(model.shortcuts.map((row) => row.id)).toEqual(["a-done"]);
  });
});
