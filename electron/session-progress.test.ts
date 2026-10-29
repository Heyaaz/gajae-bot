import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GjcSdkController,
  PROGRESS_REFRESH_MIN_MS,
  PROGRESS_STALE_MS,
} from "./gjc-sdk-controller.js";
import { parseSessionProgress } from "../shared/session-progress.js";

/**
 * Every field `toProjectProgressSnapshot` writes in gjc 0.19.0
 * (progress/progress-snapshot.ts, typed by progress/progress-contract.ts
 * `ProjectProgressSnapshot`), for an ultragoal run with a ralplan and an
 * autoresearch HUD active.
 */
function progressSnapshotV1(): Record<string, unknown> {
  return {
    schema: "gjc.project_progress.v1",
    state: "in-progress",
    completion: {
      basis: "ultragoal-stories",
      done: 1,
      total: 4,
      percent: 25,
      allUnitsDone: false,
      complete: false,
      explanation: "1 of 4 ultragoal stories complete",
    },
    execution: {
      goal: { objective: "Ship workflow cards", status: "active", timeUsedSeconds: 312 },
      ultragoal: {
        objective: "Ship workflow cards",
        counts: { total: 4, complete: 1, active: 1, pending: 1, blocked: 1, superseded: 0 },
        stories: [
          { id: "S1", title: "Parse the snapshot", status: "complete", verificationReceipt: true },
          { id: "S2", title: "Render the cards", status: "active", verificationReceipt: false },
          { id: "S3", title: "Refresh on events", status: "pending", verificationReceipt: false },
          { id: "S4", title: "Upstream ledger query", status: "review_blocked", verificationReceipt: false },
        ],
        omittedStories: 0,
      },
      todos: {
        counts: { total: 2, completed: 1, inProgress: 1, pending: 0, abandoned: 0 },
        items: [
          { content: "write parser", status: "completed" },
          { content: "write cards", status: "in_progress" },
        ],
        omittedItems: 0,
      },
    },
    activeWork: {
      story: { id: "S2", title: "Render the cards" },
      todo: "write cards",
      workflows: [
        {
          skill: "ralplan",
          phase: "critic-review",
          summary: "Planner pass 2 under review",
          chips: [
            { label: "pass", value: "2", severity: null },
            { label: "verdict", value: "ITERATE", severity: "warning" },
            { label: "pending", value: "approval", severity: "warning" },
          ],
        },
        {
          skill: "autoresearch",
          phase: "evaluating",
          summary: null,
          chips: [
            { label: "run", value: "3/5", severity: "info" },
            { label: "metric", value: "p95 412ms", severity: "success" },
            { label: "blocked", value: null, severity: "blocked" },
          ],
        },
      ],
      omittedWorkflows: 0,
      agents: { total: 1, running: 1, waiting: 0, completed: 0, failed: 0, cancelled: 0 },
    },
    verification: {
      storyReceipts: { complete: 1, withReceipt: 1, withoutReceipt: 0 },
      reviewVerdicts: [{ skill: "ralplan", verdict: "ITERATE" }],
    },
    attention: [
      { kind: "blocker", source: "ultragoal", ref: "S4", text: "Story S4 is review blocked: Upstream ledger query" },
    ],
    omittedAttention: 0,
    sources: {
      sessionStateRead: true,
      unreadable: [],
      recovered: [],
      discarded: [],
      unresolved: [],
    },
  };
}

describe("session.progress parser", () => {
  it("parses a gjc 0.19.0 progress/progress-snapshot.ts snapshot", () => {
    expect(parseSessionProgress(progressSnapshotV1())).toEqual({
      ultragoal: {
        objective: "Ship workflow cards",
        counts: { total: 4, complete: 1, active: 1, pending: 1, blocked: 1, superseded: 0 },
        stories: [
          { id: "S1", title: "Parse the snapshot", status: "complete", verificationReceipt: true },
          { id: "S2", title: "Render the cards", status: "active", verificationReceipt: false },
          { id: "S3", title: "Refresh on events", status: "pending", verificationReceipt: false },
          { id: "S4", title: "Upstream ledger query", status: "review_blocked", verificationReceipt: false },
        ],
        omittedStories: 0,
        current: { id: "S2", title: "Render the cards" },
      },
      workflows: [
        {
          skill: "ralplan",
          phase: "critic-review",
          summary: "Planner pass 2 under review",
          chips: [
            { label: "pass", value: "2", severity: null },
            { label: "verdict", value: "ITERATE", severity: "warning" },
            { label: "pending", value: "approval", severity: "warning" },
          ],
          verdict: "ITERATE",
        },
        {
          skill: "autoresearch",
          phase: "evaluating",
          summary: null,
          chips: [
            { label: "run", value: "3/5", severity: "info" },
            { label: "metric", value: "p95 412ms", severity: "success" },
            { label: "blocked", value: null, severity: "blocked" },
          ],
          verdict: null,
        },
      ],
      omittedWorkflows: 0,
    });
  });

  it("rejects another schema and drops only the malformed parts", () => {
    expect(parseSessionProgress({ ...progressSnapshotV1(), schema: "gjc.project_progress.v2" })).toBeUndefined();
    expect(parseSessionProgress(null)).toBeUndefined();
    expect(parseSessionProgress([progressSnapshotV1()])).toBeUndefined();

    const snapshot = progressSnapshotV1();
    const execution = snapshot.execution as Record<string, any>;
    const activeWork = snapshot.activeWork as Record<string, any>;
    execution.ultragoal.stories.push({ id: "S5", status: "pending" }, "junk");
    execution.ultragoal.stories.push({ id: "S6", title: "New status", status: "parked", verificationReceipt: "yes" });
    activeWork.workflows.push({ skill: "deep-interview" }, { skill: "x", phase: "y", chips: [{ value: "no label" }, { label: "odd", severity: "panic" }] });
    activeWork.omittedWorkflows = 3;
    const parsed = parseSessionProgress(snapshot)!;
    expect(parsed.ultragoal?.stories.map((story) => story.id)).toEqual(["S1", "S2", "S3", "S4", "S6"]);
    expect(parsed.ultragoal?.stories.at(-1)).toEqual({
      id: "S6",
      title: "New status",
      status: "parked",
      verificationReceipt: false,
    });
    expect(parsed.workflows.map((workflow) => workflow.skill)).toEqual(["ralplan", "autoresearch", "x"]);
    expect(parsed.workflows[2]!.chips).toEqual([{ label: "odd", value: null, severity: null }]);
    expect(parsed.omittedWorkflows).toBe(3);

    execution.ultragoal.counts.blocked = -1;
    expect(parseSessionProgress(snapshot)?.ultragoal).toBeNull();
    execution.ultragoal = null;
    activeWork.story = null;
    expect(parseSessionProgress(snapshot)).toMatchObject({ ultragoal: null, workflows: expect.any(Array) });
  });
});

const session = () => ({
  id: "s1",
  title: "Test",
  subtitle: "repo",
  workspace: "/repo",
  runtime: "gjc",
  status: "running" as const,
  updatedAt: "now",
  pinned: false,
  unread: false,
  accent: "#ff8a34",
  ownership: "gajae",
  attachment: "attached",
});

function harness(operations: string[] | undefined) {
  const controller = new GjcSdkController({
    workspace: "/repo",
    emit: vi.fn(),
    artifactDirectory: path.join(tmpdir(), "gajae-progress-artifacts"),
  } as never);
  const queryItems = vi.fn(async (_sessionId: string, query: string) => {
    if (query === "session.progress") return [progressSnapshotV1()];
    if (query === "goal.list/get")
      return [{ enabled: true, goal: { objective: "Ship workflow cards", status: "active" } }];
    return [];
  });
  const internals = controller as any;
  internals.cli = { queryItems, rawQuery: vi.fn(async () => ({ items: [] })) };
  internals.startup = Promise.resolve();
  internals.generation = 1;
  internals.sessions.set("s1", session());
  internals.attachedSessions.add("s1");
  internals.sessionTodoSnapshots.set("s1", { rows: [], observedAt: "now" });
  if (operations) internals.sessionSdkOperations.set("s1", new Set(operations));
  const progressReads = () =>
    queryItems.mock.calls.filter(([, query]) => query === "session.progress").length;
  return { controller, internals, queryItems, progressReads };
}

describe("session.progress reads", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not ask a session that lacks the capability, and does not probe for it", async () => {
    const { controller, queryItems, progressReads } = harness([
      "goal.list/get",
      "workflow.gates.list",
    ]);
    try {
      const goal = await controller.getGoal("s1");
      expect(goal.enabled).toBe(true);
      expect(goal).not.toHaveProperty("progress");
      expect(progressReads()).toBe(0);
      expect(queryItems.mock.calls.map(([, query]) => query)).not.toContain("runtime.capabilities");
    } finally {
      controller.dispose();
    }
    const unknown = harness(undefined);
    try {
      expect(await unknown.controller.getGoal("s1")).not.toHaveProperty("progress");
      expect(unknown.queryItems.mock.calls.map(([, query]) => query)).toEqual(["goal.list/get"]);
    } finally {
      unknown.controller.dispose();
    }
  });

  it("attaches the parsed snapshot and reuses it on the goal cadence", async () => {
    const { controller, progressReads } = harness(["goal.list/get", "session.progress"]);
    try {
      const goal = await controller.getGoal("s1");
      expect(goal.progress?.ultragoal?.current).toEqual({ id: "S2", title: "Render the cards" });
      expect(goal.progress?.workflows.map((workflow) => workflow.skill)).toEqual([
        "ralplan",
        "autoresearch",
      ]);
      await controller.getGoal("s1");
      await controller.getGoal("s1");
      expect(progressReads()).toBe(1);
    } finally {
      controller.dispose();
    }
  });

  it("coalesces tool, gate and turn-end refreshes into one bounded read", async () => {
    vi.useFakeTimers();
    const { controller, internals, progressReads } = harness(["session.progress"]);
    try {
      await controller.getGoal("s1");
      expect(progressReads()).toBe(1);
      internals.projectToolStream("s1", "tool_execution_end", {
        event: { type: "tool_execution_end", toolCallId: "t1", toolName: "bash", result: {} },
      });
      internals.projectToolStream("s1", "workflow_gate", { type: "workflow_gate", gate_id: "g1" });
      internals.projectTailItems("s1", [{ kind: "turn_end", generation: 1, seq: 9, payload: {} }]);
      await vi.advanceTimersByTimeAsync(PROGRESS_REFRESH_MIN_MS - 1);
      expect(progressReads()).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(progressReads()).toBe(2);
      await vi.advanceTimersByTimeAsync(PROGRESS_REFRESH_MIN_MS * 5);
      expect(progressReads()).toBe(2);

      const triggers = [
        () =>
          internals.projectToolStream("s1", "tool_execution_end", {
            event: { type: "tool_execution_end", toolCallId: "t2", toolName: "bash", result: {} },
          }),
        () => internals.projectToolStream("s1", "workflow_gate", { type: "workflow_gate", gate_id: "g2" }),
        () => internals.projectTailItems("s1", [{ kind: "agent_end", generation: 1, seq: 10, payload: {} }]),
      ];
      for (const [index, trigger] of triggers.entries()) {
        trigger();
        await vi.advanceTimersByTimeAsync(PROGRESS_REFRESH_MIN_MS);
        expect(progressReads()).toBe(3 + index);
      }
    } finally {
      controller.dispose();
    }
  });

  it("leaves a session nobody polls out of event-driven reads", async () => {
    // A background session's tool, gate and turn events each queued a
    // session.progress read whose answer nothing would ever show.
    vi.useFakeTimers();
    const { controller, internals, progressReads } = harness(["session.progress"]);
    const events = (call: string) => {
      internals.projectToolStream("s1", "tool_execution_end", {
        event: { type: "tool_execution_end", toolCallId: `t-${call}`, toolName: "bash", result: {} },
      });
      internals.projectToolStream("s1", "workflow_gate", { type: "workflow_gate", gate_id: `g-${call}` });
      internals.projectTailItems("s1", [{ kind: "turn_end", generation: 1, seq: Number(call), payload: {} }]);
    };
    try {
      events("1");
      await vi.advanceTimersByTimeAsync(PROGRESS_REFRESH_MIN_MS * 3);
      expect(progressReads()).toBe(0);

      await controller.getGoal("s1");
      expect(progressReads()).toBe(1);
      // The goal row stops polling once the user selects another session.
      await vi.advanceTimersByTimeAsync(PROGRESS_STALE_MS * 3);
      events("2");
      await vi.advanceTimersByTimeAsync(PROGRESS_REFRESH_MIN_MS * 3);
      expect(progressReads()).toBe(1);
    } finally {
      controller.dispose();
    }
  });

  it("refreshes a stale snapshot in the background and keeps it through a failed read", async () => {
    vi.useFakeTimers();
    const { controller, queryItems, progressReads } = harness(["session.progress"]);
    try {
      await controller.getGoal("s1");
      queryItems.mockImplementation(async (_sessionId: string, query: string) => {
        if (query === "session.progress") throw new Error("operation_failed");
        return [];
      });
      await vi.advanceTimersByTimeAsync(PROGRESS_STALE_MS);
      const stale = await controller.getGoal("s1");
      expect(stale.progress?.workflows).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(0);
      expect(progressReads()).toBe(2);
      expect((await controller.getGoal("s1")).progress?.workflows).toHaveLength(2);
      expect(progressReads()).toBe(2);
    } finally {
      controller.dispose();
    }
  });
});
