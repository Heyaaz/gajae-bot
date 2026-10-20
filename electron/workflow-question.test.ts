import { describe, expect, it, vi } from "vitest";
import type { QuestionSubmission } from "../shared/agent-contract.js";
import { GjcSdkController } from "./gjc-sdk-controller.js";
import {
  buildGateAnswer,
  gateAnswerRejection,
  questionAnswerSummary,
  questionFromGateRecord,
  workflowGateRecord,
} from "../shared/workflow-question.js";

const session = (id = "s1") => ({
  id,
  title: "Test",
  subtitle: "repo",
  workspace: "/repo",
  runtime: "gjc",
  status: "idle" as const,
  updatedAt: "now",
  pinned: false,
  unread: false,
  accent: "#ff8a34",
  ownership: "gajae",
  attachment: "attached",
});

function gateRow(overrides: Record<string, unknown> = {}) {
  return {
    type: "workflow_gate",
    gate_id: "g1",
    stage: "deep-interview",
    kind: "question",
    schema: {},
    schema_hash: "h",
    options: [
      { value: "Yes", label: "Yes", description: "recommended" },
      { value: "No", label: "No" },
    ],
    context: {
      title: "Ship it?",
      prompt: "ignored when title is set",
      stage_state: { multi: false },
    },
    created_at: "2026-10-20T00:00:00.000Z",
    required: true,
    id: "pending:g1",
    tag: "pending",
    answer_recorded: false,
    ...overrides,
  };
}

function harness(gates: unknown[] = [gateRow()]) {
  const emit = vi.fn();
  const controller = new GjcSdkController({
    workspace: "/repo",
    emit,
  } as never);
  const cli = {
    listSessions: vi.fn(async () => []),
    inspectSession: vi.fn(async () => ({ live: true, repo: "/repo" })),
    rawGlobal: vi.fn(async () => ({ ok: true })),
    rawControl: vi.fn(async () => ({ status: "accepted" })),
    rawQuery: vi.fn(async () => ({ items: [] })),
    queryItems: vi.fn(async (_id: string, query: string) =>
      query === "workflow.gates.list" ? gates : [],
    ),
    send: vi.fn(async () => ({ status: "accepted" })),
    promptStatus: vi.fn(async () => ({ status: "completed" })),
    tail: vi.fn(async () => ({ source: "offline", terminal: true, items: [] })),
    observeTools: vi.fn(async () => undefined),
  };
  const internals = controller as any;
  internals.cli = cli;
  internals.startup = Promise.resolve();
  internals.generation = 1;
  internals.sessions.set("s1", session());
  return { controller, cli, internals, emit };
}

describe("workflow question mapping", () => {
  it("maps a pending question gate onto a card", () => {
    const question = questionFromGateRecord("s1", gateRow());
    expect(question).toMatchObject({
      id: "g1",
      kind: "question",
      sessionId: "s1",
      question: "Ship it?",
      options: [
        { label: "Yes", recommended: true },
        { label: "No" },
      ],
      multi: false,
      status: "pending",
      answerable: true,
      tag: "pending",
      expectedSessionId: "s1",
    });
    expect(question?.options[1]).not.toHaveProperty("recommended");
  });

  it("reads a one-line prompt, multi, and diagnostic tags", () => {
    expect(
      questionFromGateRecord("s1", gateRow({
        context: { prompt: "  Ship\nit?  ", stage_state: { multi: true } },
        options: [{ label: "A" }, { label: "B" }],
      }))?.question,
    ).toBe("Ship it?");
    expect(
      questionFromGateRecord("s1", gateRow({
        context: { title: "Pick", stage_state: { multi: true } },
      }))?.multi,
    ).toBe(true);
    expect(questionFromGateRecord("s1", gateRow({ tag: "quarantined" }))).toMatchObject({
      status: "cancelled",
      answerable: false,
      tag: "quarantined",
    });
    expect(questionFromGateRecord("s1", gateRow({ tag: "accepted" }))).toMatchObject({
      status: "answered",
      answerable: false,
    });
    expect(questionFromGateRecord("s1", gateRow({ kind: "approval" }))).toBeUndefined();
    expect(questionFromGateRecord("s1", gateRow({ gate_id: "  " }))).toBeUndefined();
    expect(questionFromGateRecord("s1", gateRow({ tag: "other" }))).toBeUndefined();
    expect(questionFromGateRecord("s1", gateRow({ context: {} }))).toBeUndefined();
    const untagged = { ...gateRow() } as Record<string, unknown>;
    delete untagged.tag;
    expect(questionFromGateRecord("s1", untagged)?.tag).toBe("pending");
  });

  it("accepts a bare gate and a tool-style event wrapper", () => {
    const bare = gateRow();
    expect(workflowGateRecord(bare)?.gate_id).toBe("g1");
    expect(workflowGateRecord({ event: bare, capabilities: [] })?.gate_id).toBe("g1");
    expect(workflowGateRecord(null)).toBeUndefined();
  });

  it("builds the three answer shapes and rejects a bad selection", () => {
    const single = { multi: false, options: [{ label: "Yes" }, { label: "No" }] };
    const multi = { multi: true, options: [{ label: "Yes" }, { label: "No" }] };
    expect(buildGateAnswer({ selected: ["Yes"] }, single)).toEqual({
      selected: ["Yes"],
      action: "answer",
    });
    expect(buildGateAnswer({ selected: ["Yes", "No"] }, multi)).toEqual({
      selected: ["Yes", "No"],
      action: "answer",
    });
    expect(buildGateAnswer({ selected: [], custom: " later " }, single)).toEqual({
      selected: [],
      other: true,
      custom: "later",
      action: "answer",
    });
    expect(buildGateAnswer({ selected: ["Yes"], custom: "also" }, multi)).toEqual({
      selected: ["Yes"],
      other: true,
      custom: "also",
      action: "answer",
    });
    expect(buildGateAnswer({ selected: [], clarify: " why? " }, single)).toEqual({
      action: "clarify",
      question: "why?",
    });
    expect(() => buildGateAnswer({ selected: ["Maybe"] }, single)).toThrow("알 수 없는 선택지");
    expect(() => buildGateAnswer({ selected: ["Yes", "Yes"] }, multi)).toThrow("두 번");
    expect(() => buildGateAnswer({ selected: ["Yes", "No"] }, single)).toThrow("하나만");
    expect(() => buildGateAnswer({ selected: ["Yes"], custom: "x" }, single)).toThrow("하나만");
    expect(() => buildGateAnswer({ selected: [], custom: "   " }, single)).toThrow("공백");
    expect(() => buildGateAnswer({ selected: [] }, single)).toThrow("선택하거나");
    expect(questionAnswerSummary({ selected: ["Yes", "No"] })).toBe("Yes, No");
    expect(questionAnswerSummary({ selected: [], custom: "typed" })).toBe("typed");
    expect(gateAnswerRejection({ status: "accepted" })).toBeUndefined();
    expect(
      gateAnswerRejection({
        status: "rejected",
        error: { errors: [{ message: "must NOT have more than 1 items" }] },
      }),
    ).toBe("must NOT have more than 1 items");
    expect(gateAnswerRejection({ status: "rejected" })).toBe(
      "답이 거부되었습니다. 다시 입력해 주세요.",
    );
  });
});

describe("workflow question controller", () => {
  it("lists a pending question and marks the session waiting", async () => {
    const { controller, cli, internals, emit } = harness();
    try {
      const pending = await controller.listPendingQuestions("s1");
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({
        id: "g1",
        question: "Ship it?",
        answerable: true,
        status: "pending",
        expectedSessionId: "s1",
      });
      expect(cli.queryItems).toHaveBeenCalledWith(
        "s1",
        "workflow.gates.list",
        {},
        expect.anything(),
      );
      expect(internals.sessions.get("s1").status).toBe("waiting");
      expect(emit.mock.calls.map(([event]) => event.type)).toContain("session.activity");
      expect(
        internals.transcripts.get("s1").some((item: { kind: string }) => item.kind === "question"),
      ).toBe(true);
    } finally {
      controller.dispose();
    }
  });

  it("answers through workflow.gate_answer with the bare gate id", async () => {
    const { controller, cli, internals } = harness();
    try {
      await controller.listPendingQuestions("s1");
      await controller.answerQuestion(
        "s1",
        "g1",
        { selected: ["Yes"] },
        "gajae-gate-12345678",
      );
      expect(cli.rawControl).toHaveBeenCalledWith(
        "s1",
        "workflow.gate_answer",
        {
          id: "g1",
          response: { selected: ["Yes"], action: "answer" },
          expectedSessionId: "s1",
        },
        expect.objectContaining({ idempotencyKey: "gajae-gate-12345678" }),
      );
      expect(internals.questionById("s1", "g1")).toMatchObject({
        status: "answered",
        answerable: false,
        answerSummary: "Yes",
      });
      expect(await controller.listPendingQuestions("s1")).toEqual([]);
    } finally {
      controller.dispose();
    }
  });

  it("keeps a rejected answer on the card", async () => {
    const { controller, cli, internals } = harness();
    cli.rawControl.mockResolvedValue({
      status: "rejected",
      error: {
        code: "invalid_workflow_gate_answer",
        errors: [{ path: "/selected", keyword: "maxItems", message: "too many" }],
      },
    });
    try {
      await controller.listPendingQuestions("s1");
      await controller.answerQuestion("s1", "g1", { selected: ["Yes"] }, "gajae-gate-12345678");
      expect(internals.questionById("s1", "g1")).toMatchObject({
        status: "rejected",
        answerable: true,
        error: "too many",
      });
      expect(await controller.listPendingQuestions("s1")).toHaveLength(1);
    } finally {
      controller.dispose();
    }
  });

  it("lets the first in-flight answer win", async () => {
    const { controller, cli } = harness();
    let release: (value: Record<string, unknown>) => void = () => undefined;
    cli.rawControl.mockImplementation(
      () => new Promise((resolve) => {
        release = resolve;
      }),
    );
    try {
      await controller.listPendingQuestions("s1");
      const first = controller.answerQuestion(
        "s1",
        "g1",
        { selected: ["Yes"] },
        "gajae-gate-aaaaaaaa",
      );
      const second = controller.answerQuestion(
        "s1",
        "g1",
        { selected: ["No"] },
        "gajae-gate-bbbbbbbb",
      );
      await vi.waitFor(() => expect(cli.rawControl).toHaveBeenCalledTimes(1));
      expect(cli.rawControl.mock.calls[0]?.[3]).toMatchObject({
        idempotencyKey: "gajae-gate-aaaaaaaa",
      });
      release({ status: "accepted" });
      await first;
      await second;
      expect(cli.rawControl).toHaveBeenCalledTimes(1);
    } finally {
      controller.dispose();
    }
  });

  it("projects a workflow_gate event and keeps one empty-list grace", async () => {
    const { controller, cli, internals } = harness([]);
    let release: (value: unknown[]) => void = () => undefined;
    const queryStarted = new Promise<void>((resolve) => {
      cli.queryItems.mockImplementation(
        () =>
          new Promise((done) => {
            release = done;
            resolve();
          }),
      );
    });
    try {
      internals.projectToolStream("s1", "workflow_gate", gateRow());
      expect(internals.questionById("s1", "g1")).toMatchObject({
        status: "pending",
        answerable: true,
        question: "Ship it?",
      });
      await queryStarted;
      release([]);
      await vi.waitFor(() => expect(internals.questionRefreshes.size).toBe(0));
      expect(internals.questionById("s1", "g1").status).toBe("pending");
      cli.queryItems.mockResolvedValue([]);
      expect(await controller.listPendingQuestions("s1")).toEqual([]);
      expect(internals.questionById("s1", "g1").status).toBe("answered");
    } finally {
      controller.dispose();
    }
  });

  it("keeps question rows across a durable transcript reload and a fresh controller", async () => {
    const first = harness();
    try {
      await first.controller.listPendingQuestions("s1");
      first.internals.transcripts.set("s1", []);
      const reloaded = first.internals.installTranscript("s1", [
        {
          id: "m1",
          sessionId: "s1",
          kind: "message",
          role: "user",
          content: "hi",
          createdAt: "now",
        },
      ]);
      expect(reloaded.map((item: { kind: string }) => item.kind)).toEqual([
        "message",
        "question",
      ]);
    } finally {
      first.controller.dispose();
    }

    const restarted = harness();
    try {
      const pending = await restarted.controller.listPendingQuestions("s1");
      expect(pending.map((question) => question.id)).toEqual(["g1"]);
      expect(pending[0]?.status).toBe("pending");
    } finally {
      restarted.controller.dispose();
    }
  });

  it("settles an open question on ask timeout and on cancel", async () => {
    const { controller, internals } = harness();
    internals.fireAbort = vi.fn(async () => "plain");
    try {
      await controller.listPendingQuestions("s1");
      internals.projectToolStream("s1", "tool_execution_end", {
        event: {
          type: "tool_execution_end",
          toolCallId: "ask-1",
          toolName: "ask",
          isError: true,
          result: { content: [{ type: "text", text: "gjc.ask.timeout" }] },
        },
      });
      expect(internals.questionById("s1", "g1")).toMatchObject({
        status: "timeout",
        answerable: false,
      });

      internals.sessionQuestions.get("s1").set("g1", {
        ...internals.questionById("s1", "g1"),
        status: "pending",
        answerable: true,
      });
      await controller.cancelRun("s1");
      expect(internals.questionById("s1", "g1")).toMatchObject({
        status: "cancelled",
        answerable: false,
      });
    } finally {
      controller.dispose();
    }
  });

  it("shows a local schema error without calling the runtime", async () => {
    const { controller, cli, internals } = harness();
    try {
      await controller.listPendingQuestions("s1");
      await controller.answerQuestion(
        "s1",
        "g1",
        { selected: ["Maybe"] },
        "gajae-gate-12345678",
      );
      expect(cli.rawControl).not.toHaveBeenCalled();
      expect(internals.questionById("s1", "g1")).toMatchObject({
        status: "rejected",
        answerable: true,
      });
    } finally {
      controller.dispose();
    }
  });

  it("refreshes when the gate is no longer answerable", async () => {
    const { controller, cli, internals } = harness();
    cli.rawControl.mockRejectedValue(new Error("resource_gone"));
    try {
      await controller.listPendingQuestions("s1");
      await controller.answerQuestion("s1", "g1", { selected: ["Yes"] }, "gajae-gate-12345678");
      expect(internals.questionById("s1", "g1")).toMatchObject({
        status: "pending",
        error: undefined,
      });
      expect(cli.queryItems.mock.calls.filter((call) => call[1] === "workflow.gates.list").length).toBeGreaterThan(1);
    } finally {
      controller.dispose();
    }
  });
});
