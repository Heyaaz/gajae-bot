import { describe, expect, it, vi } from "vitest";
import { questionFromInteractiveRecord, validInteractiveAnswer } from "../shared/interactive-question.js";
import { answerQuestion, listPendingQuestions, questionById, settleOpenQuestions, type QuestionHost } from "./gjc-sdk-questions.js";

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "request-1", questionId: "logical-1", sessionId: "s1", question: "Pick",
    options: [" A ", "B"], interaction: "selector", multi: false,
    controls: [{ id: "done", kind: "navigation_forward", label: "Done", enabled: true },
      { id: "back", kind: "navigation_back", label: "Back", enabled: false }],
    answerSchema: {}, selectedOptions: [], recommendedIndex: 1,
    ...overrides,
  };
}

function harness() {
  let asks: unknown[] = [row()];
  let gates: unknown[] = [];
  const querySessionItems = vi.fn(async (_session: string, query: string) =>
    query === "workflow.gates.list" ? gates : asks);
  const sdkOperations = vi.fn(async () => new Set(["ask.requests.list"]));
  const currentRunRevision = vi.fn(() => 0);
  const controlSession = vi.fn(async (_session: string, _operation: string, input: Record<string, unknown>): Promise<Record<string, unknown>> =>
    ({ id: input.id, sessionId: "s1", settlement: { kind: "commit" } }));
  const host: QuestionHost = {
    sessionQuestions: new Map(), questionRefreshes: new Map(), questionAnswers: new Map(),
    disposed: false, generation: 0, currentRunRevision, querySessionItems, sdkOperations, observedQuestions: new Set(), acceptedQuestions: new Set(),
    transcripts: new Map(), locallyAbortedSessions: new Set(), noteTranscriptEpoch: vi.fn(), emitEvent: vi.fn(),
    markTranscriptRowDirty: vi.fn(), emitActivity: vi.fn(), sessions: new Map(), cancellingSessions: new Set(),
    updateSessionStatus: vi.fn(), controlSession,
  };
  return { host, querySessionItems, sdkOperations, controlSession, currentRunRevision,
    setAsks: (value: unknown[]) => { asks = value; }, setGates: (value: unknown[]) => { gates = value; } };
}

const id = "cli-ask:logical-1";
const submit = (requestId: string, answer: { kind: "value"; value: string } | { kind: "control"; controlId: string }) =>
  ({ selected: [], cli: { requestId, answer } });

function gate() {
  return { gate_id: "g1", kind: "question", tag: "pending", context: { title: "Gate" }, options: [] };
}

describe("ordinary interactive question projection", () => {
  it("preserves exact values and separates logical and interaction identifiers", () => {
    const question = questionFromInteractiveRecord("s1", row());
    expect(question).toMatchObject({ id, question: "Pick", options: [{ label: " A " }, { label: "B", recommended: true }],
      cli: { requestId: "request-1", interaction: "selector" } });
    expect(validInteractiveAnswer(question!, { kind: "value", value: " A " })).toBe(true);
    expect(validInteractiveAnswer(question!, { kind: "value", value: "A" })).toBe(false);
    expect(validInteractiveAnswer(question!, { kind: "control", controlId: "back" })).toBe(false);
    expect(validInteractiveAnswer(question!, { kind: "value", value: "B", controlId: "done" })).toBe(false);
    expect(validInteractiveAnswer(question!, { kind: "control", controlId: "done", extra: true })).toBe(false);
  });

  it("rejects wrong session, invalid identifiers, malformed controls and interactions", () => {
    for (const invalid of [row({ sessionId: "s2" }), row({ id: " " }), row({ questionId: "" }),
      row({ interaction: "unknown" }), row({ options: [2] }), row({ controls: [{ id: "x", label: "X", enabled: true }] }),
      row({ controls: [{ id: "x", kind: "back", label: "X", enabled: "yes" }] })])
      expect(questionFromInteractiveRecord("s1", invalid)).toBeUndefined();
    const editor = questionFromInteractiveRecord("s1", row({ interaction: "custom_editor", editor: { title: "Write", prefill: " hi " } }));
    expect(editor?.id).toBe(id);
    expect(validInteractiveAnswer(editor!, { kind: "value", value: "  " })).toBe(false);
    expect(validInteractiveAnswer(editor!, { kind: "value", value: " hi " })).toBe(true);
    expect(questionFromInteractiveRecord("s1", row({ interaction: "clarification_editor" }))).toBeDefined();
  });
});

describe("ordinary interactive question backend", () => {
  it.each(["gjc.ask.timeout", "ToolAbortError"])("does not infer a CLI outcome from historical %s", async (output) => {
    const h = harness();
    await listPendingQuestions(h.host, "s1");
    h.host.transcripts.get("s1")!.push({ id: "past", kind: "tool", sessionId: "s1", name: "ask", description: "Past question", status: "failed", output, createdAt: "t" });
    h.setAsks([]);
    await listPendingQuestions(h.host, "s1");
    expect(questionById(h.host, "s1", id)?.status).toBe("closed");
  });

  it.each(["request-1", "request-2"])("discards a pre-stop snapshot containing %s after confirmed cancellation", async (requestId) => {
    const h = harness();
    await listPendingQuestions(h.host, "s1");
    let release!: (rows: unknown[]) => void;
    h.querySessionItems.mockImplementation(async (_session, query) => query === "workflow.gates.list" ? [] : new Promise<unknown[]>((resolve) => { release = resolve; }));
    const refresh = listPendingQuestions(h.host, "s1");
    await vi.waitFor(() => expect(h.querySessionItems.mock.lastCall?.[1]).toBe("ask.requests.list"));
    settleOpenQuestions(h.host, "s1", "cancelled");
    h.host.locallyAbortedSessions.add("s1");
    h.currentRunRevision.mockReturnValue(1);
    release([row({ id: requestId })]);
    expect(await refresh).toEqual([]);
    expect(questionById(h.host, "s1", id)).toMatchObject({ status: "cancelled", answerable: false, cli: { requestId: "request-1" } });
  });

  it("publishes every completed rejection even when its reason repeats", async () => {
    const h = harness();
    await listPendingQuestions(h.host, "s1");
    h.controlSession.mockResolvedValue({ id: "request-1", sessionId: "s1", settlement: { kind: "invalid", reason: "invalid" } });
    for (const revision of [1, 2]) {
      await answerQuestion(h.host, "s1", id, submit("request-1", { kind: "value", value: "B" }), `key-${revision}`);
      expect(questionById(h.host, "s1", id)).toMatchObject({ status: "rejected", error: "invalid", cli: { rejectionRevision: revision } });
    }
    expect(h.host.emitEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "question.updated", question: expect.objectContaining({ cli: expect.objectContaining({ rejectionRevision: 2 }) }) }));
  });

  it("does not reopen a cancelled question when its old answer is rejected late", async () => {
    const h = harness();
    await listPendingQuestions(h.host, "s1");
    let release!: (result: Record<string, unknown>) => void;
    h.controlSession.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const answer = answerQuestion(h.host, "s1", id, submit("request-1", { kind: "value", value: "B" }), "late");
    settleOpenQuestions(h.host, "s1", "cancelled");
    h.currentRunRevision.mockReturnValue(1);
    h.setAsks([]);
    release({ id: "request-1", sessionId: "s1", settlement: { kind: "invalid", reason: "too late" } });
    await answer;
    expect(questionById(h.host, "s1", id)).toMatchObject({ status: "cancelled", answerable: false });
  });
  it("commits only the exact current interaction and retains completion after disappearance", async () => {
    const h = harness();
    await listPendingQuestions(h.host, "s1");
    h.setAsks([]);
    await answerQuestion(h.host, "s1", id, submit("request-1", { kind: "value", value: " A " }), "key");
    expect(h.controlSession).toHaveBeenCalledWith("s1", "ask.answer", { id: "request-1", answer: { kind: "value", value: " A " } }, { idempotencyKey: "key" });
    expect(questionById(h.host, "s1", id)).toMatchObject({ status: "answered", answerSummary: " A " });
  });

  it("keeps the logical card open through a multi toggle and editor transition", async () => {
    const h = harness();
    h.setAsks([row({ multi: true })]);
    await listPendingQuestions(h.host, "s1");
    h.setAsks([row({ id: "request-2", multi: true, options: [" A ", "Other (type your own)"], selectedOptions: [" A "] })]);
    h.controlSession.mockResolvedValue({ id: "request-1", sessionId: "s1", settlement: { kind: "resolve_without_commit", reason: "toggle" } });
    await answerQuestion(h.host, "s1", id, submit("request-1", { kind: "value", value: " A " }), "key");
    expect(questionById(h.host, "s1", id)).toMatchObject({ status: "pending", cli: { requestId: "request-2", selectedOptions: [" A "] } });
    h.setAsks([row({ id: "request-3", interaction: "custom_editor", editor: { title: "Other" } })]);
    h.controlSession.mockResolvedValue({ id: "request-2", sessionId: "s1", settlement: { kind: "resolve_without_commit", reason: "other_transition" } });
    await answerQuestion(h.host, "s1", id, submit("request-2", { kind: "value", value: "Other (type your own)" }), "key2");
    expect(questionById(h.host, "s1", id)).toMatchObject({ status: "pending", cli: { requestId: "request-3", interaction: "custom_editor" } });
  });

  it("commits a multi-selection only when the enabled navigation control commits", async () => {
    const h = harness();
    h.setAsks([row({ multi: true, selectedOptions: [" A ", "B"] })]);
    await listPendingQuestions(h.host, "s1");
    await answerQuestion(h.host, "s1", id, submit("request-1", { kind: "control", controlId: "done" }), "key");
    expect(questionById(h.host, "s1", id)).toMatchObject({ status: "answered", answerSummary: " A , B" });
  });

  it("rejects unoffered values and disabled controls locally; old request ids refresh without dispatch", async () => {
    const h = harness();
    await listPendingQuestions(h.host, "s1");
    await answerQuestion(h.host, "s1", id, submit("request-1", { kind: "control", controlId: "back" }), "key");
    expect(questionById(h.host, "s1", id)?.status).toBe("rejected");
    await listPendingQuestions(h.host, "s1");
    expect(questionById(h.host, "s1", id)?.status).toBe("rejected");
    await answerQuestion(h.host, "s1", id, submit("request-1", { kind: "value", value: "A" }), "key2");
    h.setAsks([row({ id: "request-2" })]);
    await answerQuestion(h.host, "s1", id, submit("old", { kind: "value", value: "B" }), "key3");
    expect(h.controlSession).not.toHaveBeenCalled();
    expect(questionById(h.host, "s1", id)).toMatchObject({ status: "pending", cli: { requestId: "request-2" } });
    expect(questionById(h.host, "s1", id)?.error).toBeUndefined();
  });

  it("rejects extra answer fields before dispatch", async () => {
    const h = harness();
    await listPendingQuestions(h.host, "s1");
    await answerQuestion(h.host, "s1", id, submit("request-1", { kind: "value", value: "B", controlId: "done" } as { kind: "value"; value: string }), "key");
    expect(h.controlSession).not.toHaveBeenCalled();
    expect(questionById(h.host, "s1", id)).toMatchObject({ status: "rejected", answerable: true });
  });

  it("preserves each domain independently on read failure and does not query unadvertised asks", async () => {
    const h = harness();
    h.setGates([gate()]);
    await listPendingQuestions(h.host, "s1");
    h.querySessionItems.mockImplementation(async (_session, query) => {
      if (query === "workflow.gates.list") throw new Error("offline");
      return [];
    });
    await listPendingQuestions(h.host, "s1");
    expect(questionById(h.host, "s1", "g1")?.status).toBe("pending");
    expect(questionById(h.host, "s1", id)?.status).toBe("closed");
    h.querySessionItems.mockImplementation(async (_session, query) => {
      if (query === "ask.requests.list") throw new Error("offline");
      return [gate()];
    });
    h.setAsks([row({ id: "request-2" })]);
    h.querySessionItems.mockImplementationOnce(async () => [gate()]).mockImplementationOnce(async () => [row({ id: "request-2" })]);
    await listPendingQuestions(h.host, "s1");
    await listPendingQuestions(h.host, "s1");
    expect(questionById(h.host, "s1", id)).toMatchObject({ status: "pending", cli: { requestId: "request-2" } });
    h.sdkOperations.mockResolvedValue(new Set());
    h.querySessionItems.mockClear();
    await listPendingQuestions(h.host, "s1");
    expect(h.querySessionItems.mock.calls.some((call) => call[1] === "ask.requests.list")).toBe(false);
    expect(questionById(h.host, "s1", id)?.status).toBe("pending");
  });

  it("refreshes invalid and uncertain outcomes without replay, clearing errors on a new interaction", async () => {
    const h = harness();
    await listPendingQuestions(h.host, "s1");
    h.controlSession.mockResolvedValueOnce({ id: "request-1", sessionId: "s1", settlement: { kind: "invalid", reason: "stale_request" } });
    await answerQuestion(h.host, "s1", id, submit("request-1", { kind: "value", value: "B" }), "key");
    expect(questionById(h.host, "s1", id)).toMatchObject({ status: "rejected", error: "stale_request" });
    h.setAsks([row({ id: "request-2" })]);
    h.controlSession.mockRejectedValueOnce(new Error("uncertain transport"));
    await answerQuestion(h.host, "s1", id, submit("request-1", { kind: "value", value: "B" }), "key2");
    expect(questionById(h.host, "s1", id)).toMatchObject({ status: "pending", cli: { requestId: "request-2" } });
    expect(h.controlSession).toHaveBeenCalledTimes(2);
  });

  it("does not accept a commit with the wrong response binding or a malformed snapshot", async () => {
    const h = harness();
    await listPendingQuestions(h.host, "s1");
    h.controlSession.mockResolvedValueOnce({ id: "request-1", sessionId: "s2", settlement: { kind: "commit" } });
    h.setAsks([row({ sessionId: "s2" })]);
    await answerQuestion(h.host, "s1", id, submit("request-1", { kind: "value", value: "B" }), "key");
    expect(questionById(h.host, "s1", id)).toMatchObject({ status: "pending", cli: { requestId: "request-1" } });
    expect(h.controlSession).toHaveBeenCalledTimes(1);
  });

  it("does not reopen a closed interaction but accepts a genuinely new one", async () => {
    const h = harness();
    await listPendingQuestions(h.host, "s1");
    h.setAsks([]);
    await listPendingQuestions(h.host, "s1");
    expect(questionById(h.host, "s1", id)?.status).toBe("closed");
    h.setAsks([row()]);
    expect(await listPendingQuestions(h.host, "s1")).toEqual([]);
    expect(questionById(h.host, "s1", id)?.status).toBe("closed");
    h.setAsks([row({ id: "request-2" })]);
    expect(await listPendingQuestions(h.host, "s1")).toMatchObject([{ id, cli: { requestId: "request-2" } }]);
  });

  it("accepts the next authoritative interaction while the previous acknowledgement is still in flight", async () => {
    const h = harness();
    await listPendingQuestions(h.host, "s1");
    let release!: (result: Record<string, unknown>) => void;
    h.controlSession.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const first = answerQuestion(h.host, "s1", id, submit("request-1", { kind: "value", value: " A " }), "key1");
    h.setAsks([row({ id: "request-2", selectedOptions: [" A "] })]);
    await listPendingQuestions(h.host, "s1");
    h.controlSession.mockResolvedValueOnce({ id: "request-2", sessionId: "s1", settlement: { kind: "commit" } });
    h.setAsks([]);
    const second = answerQuestion(h.host, "s1", id, submit("request-2", { kind: "value", value: "B" }), "key2");
    release({ id: "request-1", sessionId: "s1", settlement: { kind: "resolve_without_commit", reason: "toggle" } });
    await Promise.all([first, second]);
    expect(h.controlSession).toHaveBeenCalledTimes(2);
    expect(h.controlSession).toHaveBeenLastCalledWith("s1", "ask.answer", {
      id: "request-2", answer: { kind: "value", value: "B" },
    }, { idempotencyKey: "key2" });
    expect(questionById(h.host, "s1", id)?.status).toBe("answered");
  });

  it("does not let a late old commit fence a revisited interaction or replay concurrent answers", async () => {
    const h = harness();
    await listPendingQuestions(h.host, "s1");
    let release!: (result: Record<string, unknown>) => void;
    h.controlSession.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const first = answerQuestion(h.host, "s1", id, submit("request-1", { kind: "value", value: "B" }), "key");
    const second = answerQuestion(h.host, "s1", id, submit("request-1", { kind: "value", value: " A " }), "key2");
    h.setAsks([row({ id: "request-2" })]);
    await listPendingQuestions(h.host, "s1");
    release({ id: "request-1", sessionId: "s1", settlement: { kind: "commit" } });
    await Promise.all([first, second]);
    expect(h.controlSession).toHaveBeenCalledTimes(1);
    expect(questionById(h.host, "s1", id)).toMatchObject({ status: "pending", cli: { requestId: "request-2" } });
  });
});
