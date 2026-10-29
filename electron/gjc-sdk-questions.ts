import type { AgentEvent, AgentSession, QuestionActivity, QuestionSubmission, TranscriptItem } from "../shared/agent-contract.js";
import {
  buildGateAnswer,
  gateAnswerRejection,
  questionAnswerSummary,
  questionFromGateRecord,
  workflowGateRecord,
} from "../shared/workflow-question.js";
import { cloneTranscriptItem, nowLabel, sameTranscriptItem, transcriptTime } from "./gjc-sdk-foundation.js";

/** The controller members the workflow question projection reads and writes. */
export interface QuestionHost {
  readonly sessionQuestions: Map<string, Map<string, QuestionActivity>>;
  readonly questionRefreshes: Map<string, Promise<void>>;
  readonly disposed: boolean;
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
    operation:
      | "turn.prompt"
      | "turn.steer"
      | "turn.follow_up"
      | "turn.abort"
      | "queue.message.remove"
      | "compaction.run"
      | "mode.goal.operate"
      | "mode.plan.set"
      | "thinking.set"
      | "thinking.cycle"
      | "model.profile.set"
      | "permission_mode.set"
      | "config.patch"
      | "service_tier.set"
      | "session.export_html"
      | "context.clear"
      | "session.rename"
      | "session.cwd.move"
      | "retry.last"
      | "bash.background"
      | "runtime.reload"
      | "auth.login"
      | "btw.ask"
      | "workflow.gate_answer",
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
 * Re-reads `workflow.gates.list` and projects question rows.
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
  let rows: unknown[] = [];
  try {
    rows = await host.querySessionItems(
      sessionId,
      "workflow.gates.list",
      {},
      { strict: true },
    );
  } catch {
    return;
  }
  if (host.disposed) return;
  const incoming = rows.flatMap((row) => {
    const question = questionFromGateRecord(sessionId, row);
    return question ? [withQuestionClock(question)] : [];
  });
  applyQuestionSnapshot(host, sessionId, incoming);
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
): void {
  const seen = new Set<string>();
  for (const row of incoming) {
    seen.add(row.id);
    const key = questionKey(sessionId, row.id);
    host.observedQuestions.delete(key);
    const previous = questionById(host, sessionId, row.id);
    let next: QuestionActivity = previous
      ? {
          ...row,
          createdAt: previous.createdAt,
          ...(previous.answerSummary
            ? { answerSummary: previous.answerSummary }
            : {}),
        }
      : row;
    if (
      previous?.status === "rejected" &&
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
    if (host.acceptedQuestions.has(key) && row.tag === "pending") {
      next = {
        ...next,
        status: "answered",
        answerable: false,
        error: undefined,
        ...(previous?.answerSummary
          ? { answerSummary: previous.answerSummary }
          : {}),
      };
    }
    if (row.tag !== "pending") host.acceptedQuestions.delete(key);
    writeQuestion(host, next, {
      announce:
        !previous && next.answerable && next.status === "pending",
    });
  }
  for (const previous of host.sessionQuestions.get(sessionId)?.values() ?? []) {
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
    const status = questionAbsenceStatus(host, sessionId);
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

export async function submitQuestionAnswer(
  host: QuestionHost,
  sessionId: string,
  gateId: string,
  submission: QuestionSubmission,
  idempotencyKey: string,
): Promise<void> {
  const question = questionById(host, sessionId, gateId);
  if (!question) throw new Error("질문을 찾지 못했습니다.");
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
