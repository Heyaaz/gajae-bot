import type { SdkControlOperation } from "./gjc-sdk-control.js";
import type { AgentEvent, AgentSession, QuestionActivity, QuestionSubmission, TranscriptItem } from "../shared/agent-contract.js";
import { questionFromInteractiveRecord, validInteractiveAnswer } from "../shared/interactive-question.js";
import {
  buildGateAnswer,
  gateAnswerRejection,
  questionAnswerSummary,
  questionFromGateRecord,
  workflowGateRecord,
} from "../shared/workflow-question.js";
import { cloneTranscriptItem, nowLabel, sameTranscriptItem, transcriptTime } from "./gjc-sdk-foundation.js";
import { LIVE_TOOL_STATUSES } from "./gjc-sdk-transcript.js";

/** The controller members the workflow question projection reads and writes. */
export interface QuestionHost {
  readonly sessionQuestions: Map<string, Map<string, QuestionActivity>>;
  readonly questionRefreshes: Map<string, Promise<void>>;
  readonly questionAnswers: Map<string, Promise<void>>;
  readonly disposed: boolean;
  readonly generation: number;
  currentRunRevision(sessionId: string): number;
  sdkOperations(sessionId: string, options?: { strict?: boolean }): Promise<Set<string>>;
  querySessionItems(
    sessionId: string,
    query: string,
    input?: Record<string, unknown>,
    options?: { strict?: boolean },
  ): Promise<unknown[]>;
  readonly observedQuestions: Set<string>;
  readonly acceptedQuestions: Set<string>;
  readonly transcripts: Map<string, TranscriptItem[]>;
  readonly locallyAbortedSessions: Set<string>;
  noteTranscriptEpoch(sessionId: string): void;
  readonly emitEvent: (event: AgentEvent) => void;
  markTranscriptRowDirty(sessionId: string, rowId: string): void;
  emitActivity(
    sessionId: string,
    category: Extract<AgentEvent, { type: "session.activity" }>["category"],
  ): void;
  readonly sessions: Map<string, AgentSession>;
  readonly cancellingSessions: Set<string>;
  updateSessionStatus(
    sessionId: string,
    status: AgentSession["status"],
    options?: { announce?: boolean },
  ): void;
  controlSession(
    sessionId: string,
    operation: SdkControlOperation,
    input: Record<string, unknown>,
    options?: { confirm?: boolean; idempotencyKey?: string; timeoutMs?: number },
  ): Promise<Record<string, unknown> | undefined>;
}

export function questionKey(sessionId: string, gateId: string): string {
  return `${sessionId}\0${gateId}`;
}

export function questionById(
  host: QuestionHost,
  sessionId: string,
  gateId: string,
): QuestionActivity | undefined {
  return host.sessionQuestions.get(sessionId)?.get(gateId);
}

export function hasAnswerableQuestion(host: QuestionHost, sessionId: string): boolean {
  for (const question of host.sessionQuestions.get(sessionId)?.values() ?? []) {
    if (
      question.answerable &&
      (question.status === "pending" || question.status === "rejected")
    )
      return true;
  }
  return false;
}

/**
 * Re-reads workflow gates and advertised ordinary CLI asks independently.
 *
 * Overlapping reads share one request. A failure leaves the cards already
 * on screen; the next event or attach tries again.
 */
export function refreshWorkflowQuestions(host: QuestionHost, sessionId: string): Promise<void> {
  const inflight = host.questionRefreshes.get(sessionId);
  if (inflight) return inflight;
  const run = loadWorkflowQuestions(host, sessionId).finally(() => {
    if (host.questionRefreshes.get(sessionId) === run)
      host.questionRefreshes.delete(sessionId);
  });
  host.questionRefreshes.set(sessionId, run);
  return run;
}

async function loadWorkflowQuestions(host: QuestionHost, sessionId: string): Promise<void> {
  if (host.disposed) return;
  const generation = host.generation;
  let revision = host.currentRunRevision(sessionId);
  const isCurrent = () => !host.disposed && generation === host.generation && revision === host.currentRunRevision(sessionId);
  try {
    const rows = await host.querySessionItems(
      sessionId,
      "workflow.gates.list",
      {},
      { strict: true },
    );
    if (!isCurrent()) return;
    const incoming = rows.flatMap((row) => {
      const question = questionFromGateRecord(sessionId, row);
      return question ? [withQuestionClock(question)] : [];
    });
    applyQuestionSnapshot(host, sessionId, incoming, "workflow");
    revision = host.currentRunRevision(sessionId);
  } catch {
    // Preserve the workflow snapshot on failure.
  }
  if (!isCurrent()) return;
  try {
    const operations = await host.sdkOperations(sessionId, { strict: true });
    if (!operations.has("ask.requests.list")) return;
    const rows = await host.querySessionItems(sessionId, "ask.requests.list", {}, { strict: true });
    if (!isCurrent()) return;
    const incoming: QuestionActivity[] = [];
    for (const row of rows) {
      const question = questionFromInteractiveRecord(sessionId, row);
      if (!question || incoming.some((item) => item.id === question.id)) return;
      incoming.push(withQuestionClock(question));
    }
    applyQuestionSnapshot(host, sessionId, incoming, "cli");
  } catch {
    // Capability and ordinary ask failures preserve the ordinary snapshot.
  }
}

/** Waits between gate-list reads while an ask runs without a question on screen. */
const ASK_GATE_RETRY_MS = [0, 250, 500, 1_000, 2_000, 4_000, 8_000];

function toolRunning(host: QuestionHost, sessionId: string, toolCallId: string): boolean {
  return (host.transcripts.get(sessionId) ?? []).some(
    (item) => item.kind === "tool" && item.id === toolCallId && LIVE_TOOL_STATUSES.has(item.status),
  );
}

/**
 * Reads the gate list after an ask starts until its question is on screen.
 *
 * GJC 0.19.3 does not relay `workflow_gate` to the observer, so the ask's own
 * start is the only signal, and the gate is written a moment after it.
 */
export async function followAskGate(
  host: QuestionHost,
  sessionId: string,
  toolCallId: string,
): Promise<void> {
  for (const delay of ASK_GATE_RETRY_MS) {
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    if (
      host.disposed ||
      !toolRunning(host, sessionId, toolCallId) ||
      hasAnswerableQuestion(host, sessionId)
    )
      return;
    await refreshWorkflowQuestions(host, sessionId);
  }
}

function withQuestionClock(question: QuestionActivity): QuestionActivity {
  return {
    ...question,
    createdAt: question.createdAt
      ? transcriptTime(question.createdAt)
      : nowLabel(),
  };
}

function applyQuestionSnapshot(
  host: QuestionHost,
  sessionId: string,
  incoming: readonly QuestionActivity[],
  domain: "workflow" | "cli",
): void {
  const seen = new Set<string>();
  for (const row of incoming) {
    seen.add(row.id);
    const key = questionKey(sessionId, row.id);
    const acceptanceKey = row.cli ? questionKey(sessionId, `${row.id}\0${row.cli.requestId}`) : key;
    host.observedQuestions.delete(key);
    const previous = questionById(host, sessionId, row.id);
    const sameInteraction = !row.cli || previous?.cli?.requestId === row.cli.requestId;
    let next: QuestionActivity = previous
      ? {
          ...row,
          createdAt: previous.createdAt,
          ...(sameInteraction && previous.answerSummary
            ? { answerSummary: previous.answerSummary }
            : {}),
        }
      : row;
    if (sameInteraction && next.cli && previous?.cli?.rejectionRevision !== undefined) {
      next = { ...next, cli: { ...next.cli, rejectionRevision: previous.cli.rejectionRevision } };
    }
    if (
      previous?.status === "rejected" &&
      sameInteraction &&
      row.tag === "pending" &&
      row.answerable
    ) {
      next = {
        ...next,
        status: "rejected",
        answerable: true,
        ...(previous.error ? { error: previous.error } : {}),
      };
    }
    // A read already in flight when the question closes must not resurrect the
    // same interaction. A new CLI interaction ID can reopen a revisited question.
    if (previous && sameInteraction && !previous.answerable && row.tag === "pending" &&
        (previous.status === "cancelled" || previous.status === "timeout" || previous.status === "closed")) {
      next = { ...next, status: previous.status, answerable: false, error: undefined };
    }
    if (host.acceptedQuestions.has(acceptanceKey) && row.tag === "pending") {
      next = {
        ...next,
        status: "answered",
        answerable: false,
        error: undefined,
        ...(sameInteraction && previous?.answerSummary
          ? { answerSummary: previous.answerSummary }
          : {}),
      };
    }
    if (row.tag !== "pending") host.acceptedQuestions.delete(acceptanceKey);
    writeQuestion(host, next, {
      announce:
        !previous && next.answerable && next.status === "pending",
    });
  }
  for (const previous of host.sessionQuestions.get(sessionId)?.values() ?? []) {
    if ((previous.cli ? "cli" : "workflow") !== domain) continue;
    if (seen.has(previous.id)) continue;
    if (
      !previous.answerable &&
      previous.status !== "pending" &&
      previous.status !== "rejected"
    )
      continue;
    const key = questionKey(sessionId, previous.id);
    if (host.observedQuestions.has(key)) {
      host.observedQuestions.delete(key);
      continue;
    }
    const status = previous.cli ? "closed" : questionAbsenceStatus(host, sessionId);
    writeQuestion(host, {
      ...previous,
      status,
      answerable: false,
      error: undefined,
    });
  }
  syncQuestionWait(host, sessionId);
}

function questionAbsenceStatus(
  host: QuestionHost,
  sessionId: string,
): "answered" | "cancelled" | "timeout" {
  const items = host.transcripts.get(sessionId) ?? [];
  const askFailed = items.some(
    (item) =>
      item.kind === "tool" &&
      item.name.toLowerCase() === "ask" &&
      item.status === "failed" &&
      (item.output ?? "").includes("gjc.ask.timeout"),
  );
  if (askFailed) return "timeout";
  const askAborted =
    host.locallyAbortedSessions.has(sessionId) ||
    items.some(
      (item) =>
        item.kind === "tool" &&
        item.name.toLowerCase() === "ask" &&
        (item.status === "cancelled" ||
          (item.output ?? "").includes("ToolAbortError")),
    );
  if (askAborted) return "cancelled";
  return "answered";
}

function writeQuestion(
  host: QuestionHost,
  question: QuestionActivity,
  options?: { announce?: boolean },
): void {
  const stored: QuestionActivity = {
    ...question,
    options: question.options.map((option) => ({ ...option })),
  };
  const items = host.transcripts.get(question.sessionId) ?? [];
  const index = items.findIndex(
    (item) => item.kind === "question" && item.id === question.id,
  );
  if (index < 0) {
    items.push(stored);
    host.transcripts.set(question.sessionId, items);
    host.noteTranscriptEpoch(question.sessionId);
    host.emitEvent({
      type: "transcript.appended",
      item: cloneTranscriptItem(stored),
    });
  } else if (!sameTranscriptItem(items[index]!, stored)) {
    items[index] = stored;
    host.noteTranscriptEpoch(question.sessionId);
    host.emitEvent({
      type: "question.updated",
      question: cloneTranscriptItem(stored) as QuestionActivity,
    });
  } else {
    items[index] = stored;
  }
  let known = host.sessionQuestions.get(question.sessionId);
  if (!known) {
    known = new Map();
    host.sessionQuestions.set(question.sessionId, known);
  }
  known.set(question.id, stored);
  host.markTranscriptRowDirty(question.sessionId, question.id);
  if (options?.announce) {
    host.emitActivity(question.sessionId, "permission");
    syncQuestionWait(host, question.sessionId);
  }
}

function syncQuestionWait(host: QuestionHost, sessionId: string): void {
  const session = host.sessions.get(sessionId);
  if (!session || host.cancellingSessions.has(sessionId)) return;
  const waiting = hasAnswerableQuestion(host, sessionId);
  if (waiting && session.status !== "waiting" && session.status !== "failed")
    host.updateSessionStatus(sessionId, "waiting");
  else if (!waiting && session.status === "waiting")
    host.updateSessionStatus(sessionId, "running");
}

export function settleOpenQuestions(
  host: QuestionHost,
  sessionId: string,
  status: "cancelled" | "timeout",
): void {
  for (const question of [
    ...(host.sessionQuestions.get(sessionId)?.values() ?? []),
  ]) {
    if (
      !question.answerable ||
      (question.status !== "pending" && question.status !== "rejected")
    )
      continue;
    host.acceptedQuestions.delete(questionKey(sessionId, question.id));
    writeQuestion(host, {
      ...question,
      status,
      answerable: false,
      error: undefined,
    });
  }
  syncQuestionWait(host, sessionId);
}

export function projectWorkflowGate(
  host: QuestionHost,
  sessionId: string,
  payload: Record<string, unknown>,
): void {
  const record = workflowGateRecord(payload);
  const question = record
    ? questionFromGateRecord(sessionId, record)
    : undefined;
  if (question) {
    host.observedQuestions.add(questionKey(sessionId, question.id));
    const previous = questionById(host, sessionId, question.id);
    const formatted = withQuestionClock(question);
    writeQuestion(host,
      previous
        ? {
            ...formatted,
            createdAt: previous.createdAt,
            ...(previous.answerSummary
              ? { answerSummary: previous.answerSummary }
              : {}),
            ...(previous.status === "rejected"
              ? { status: "rejected" as const, error: previous.error }
              : {}),
          }
        : formatted,
      {
        announce:
          !previous && formatted.answerable && formatted.status === "pending",
      },
    );
  }
  void refreshWorkflowQuestions(host, sessionId);
}

async function refreshAfterInteractiveAnswer(host: QuestionHost, sessionId: string): Promise<void> {
  const inflight = host.questionRefreshes.get(sessionId);
  if (inflight) await inflight;
  await refreshWorkflowQuestions(host, sessionId);
}

function rejectInteractiveAnswer(host: QuestionHost, question: QuestionActivity, error: string): void {
  if (!question.cli || !question.answerable) return;
  writeQuestion(host, {
    ...question,
    status: "rejected",
    answerable: true,
    error,
    cli: { ...question.cli, rejectionRevision: (question.cli.rejectionRevision ?? 0) + 1 },
  });
  syncQuestionWait(host, question.sessionId);
}

async function submitInteractiveAnswer(
  host: QuestionHost,
  question: QuestionActivity,
  submission: QuestionSubmission,
  idempotencyKey: string,
): Promise<void> {
  const { sessionId, id } = question;
  const requestId = question.cli!.requestId;
  if (!submission.cli || submission.cli.requestId !== requestId) {
    await refreshAfterInteractiveAnswer(host, sessionId);
    return;
  }
  if (!question.answerable || (question.status !== "pending" && question.status !== "rejected")) return;
  if (!validInteractiveAnswer(question, submission.cli.answer)) {
    rejectInteractiveAnswer(host, question, "유효한 답변을 선택해 주세요.");
    return;
  }
  const answer = submission.cli.answer;
  try {
    const result = await host.controlSession(sessionId, "ask.answer", { id: requestId, answer }, { idempotencyKey });
    const settlement = result?.settlement;
    const resolution = settlement && typeof settlement === "object" && !Array.isArray(settlement)
      ? settlement as Record<string, unknown> : undefined;
    const current = questionById(host, sessionId, id);
    if (result?.id === requestId && result.sessionId === sessionId && resolution?.kind === "commit") {
      host.acceptedQuestions.add(questionKey(sessionId, `${id}\0${requestId}`));
      if (current?.cli?.requestId === requestId) {
        writeQuestion(host, {
          ...current,
          status: "answered",
          answerable: false,
          error: undefined,
          answerSummary: answer.kind === "value" ? answer.value : current.cli.selectedOptions.join(", "),
        });
        syncQuestionWait(host, sessionId);
      }
    } else if (result?.id === requestId && result.sessionId === sessionId && resolution?.kind === "invalid" && current?.cli?.requestId === requestId) {
      rejectInteractiveAnswer(host, current,
        typeof resolution.reason === "string" ? resolution.reason : "답이 거부되었습니다. 다시 입력해 주세요.");
    }
  } catch (error) {
    const current = questionById(host, sessionId, id);
    if (current?.cli?.requestId === requestId && current.answerable) {
      rejectInteractiveAnswer(host, current, error instanceof Error ? error.message : String(error));
    }
  }
  await refreshAfterInteractiveAnswer(host, sessionId);
}

export async function submitQuestionAnswer(
  host: QuestionHost,
  sessionId: string,
  gateId: string,
  submission: QuestionSubmission,
  idempotencyKey: string,
): Promise<void> {
  const question = questionById(host, sessionId, gateId);
  if (!question) throw new Error("질문을 찾지 못했습니다.");
  if (question.cli) return submitInteractiveAnswer(host, question, submission, idempotencyKey);
  if (submission.cli) throw new Error("질문 유형이 일치하지 않습니다.");
  if (
    !question.answerable ||
    (question.status !== "pending" && question.status !== "rejected")
  )
    return;
  let response: Record<string, unknown>;
  try {
    response = buildGateAnswer(submission, question);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeQuestion(host, {
      ...question,
      status: "rejected",
      answerable: true,
      error: message,
    });
    syncQuestionWait(host, sessionId);
    return;
  }
  try {
    const result = await host.controlSession(
      sessionId,
      "workflow.gate_answer",
      {
        id: gateId,
        response,
        expectedSessionId: question.expectedSessionId || sessionId,
      },
      { idempotencyKey },
    );
    const rejection = gateAnswerRejection(result);
    if (rejection) {
      writeQuestion(host, {
        ...question,
        status: "rejected",
        answerable: true,
        error: rejection,
      });
      syncQuestionWait(host, sessionId);
      return;
    }
    host.acceptedQuestions.add(questionKey(sessionId, gateId));
    writeQuestion(host, {
      ...question,
      status: "answered",
      answerable: false,
      error: undefined,
      answerSummary: questionAnswerSummary(submission),
    });
    syncQuestionWait(host, sessionId);
    void refreshWorkflowQuestions(host, sessionId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      /no longer answerable|resource_gone|does not match this endpoint|Workflow gates are unavailable/iu.test(
        message,
      )
    ) {
      await refreshWorkflowQuestions(host, sessionId);
      return;
    }
    writeQuestion(host, {
      ...question,
      status: "rejected",
      answerable: true,
      error: message,
    });
    syncQuestionWait(host, sessionId);
  }
}

/**
 * Pending and rejected ask cards for one session.
 *
 * The public workflow/ask lists are authoritative. Events and the attached
 * observer only wake these reads; tool input is never an answer binding.
 */
export async function listPendingQuestions(host: QuestionHost, sessionId: string): Promise<QuestionActivity[]> {
  await refreshWorkflowQuestions(host, sessionId);
  return [...(host.sessionQuestions.get(sessionId)?.values() ?? [])].filter(
    (question) =>
      question.answerable &&
      (question.status === "pending" || question.status === "rejected"),
  );
}

/**
 * Answers a workflow gate or an exact ordinary CLI interaction.
 *
 * The first submission for a gate wins. A second caller waits for that
 * attempt and then sees the settled card, so a desktop click and a remote
 * click cannot both commit. CLI requests are fenced by interaction, not logical
 * card: a newly published toggle/editor may arrive before the old ACK returns.
 * A `rejected` resolution stays on the card.
 */
export function answerQuestion(
  host: QuestionHost,
  sessionId: string,
  gateId: string,
  submission: QuestionSubmission,
  idempotencyKey: string,
): Promise<void> {
  const key = questionKey(sessionId, submission.cli ? `${gateId}\0${submission.cli.requestId}` : gateId);
  const inflight = host.questionAnswers.get(key);
  if (inflight) return inflight;
  const run = submitQuestionAnswer(
    host,
    sessionId,
    gateId,
    submission,
    idempotencyKey,
  );
  host.questionAnswers.set(key, run);
  return run.finally(() => {
    if (host.questionAnswers.get(key) === run) host.questionAnswers.delete(key);
  });
}
