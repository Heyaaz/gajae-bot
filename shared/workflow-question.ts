import type {
  QuestionActivity,
  QuestionGateTag,
  QuestionOption,
  QuestionStatus,
  QuestionSubmission,
} from "./agent-contract.js";

/**
 * gjc `workflow.gates.list` rows and `workflow_gate` events, mapped onto the
 * question card.
 *
 * Pending rows (`tag: "pending"`) are the ones a person can answer. Quarantined
 * and accepted rows are diagnostic: they stay visible and cannot be answered.
 * The answer body is one of the three shapes `buildAskGateAnswerSchema` accepts.
 *
 * Two kinds reach the card: `question`, and the ralplan final-plan `approval`.
 * gjc 0.19.0 opens the approval through the ask tool (`questionToGate`), so it
 * carries the same ask schema and `stage_state.question_id`. An approval
 * without that ask shape, and every other kind, is not mapped.
 */

const GATE_TAGS = new Set<QuestionGateTag>(["pending", "quarantined", "accepted"]);

function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function oneLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function statusForTag(tag: QuestionGateTag): QuestionStatus {
  if (tag === "accepted") return "answered";
  if (tag === "quarantined") return "cancelled";
  return "pending";
}

function optionFrom(value: unknown): QuestionOption | undefined {
  const row = record(value);
  if (!row || typeof row.label !== "string") return undefined;
  const label = oneLine(row.label);
  if (!label) return undefined;
  return {
    label,
    ...(row.description === "recommended" ? { recommended: true } : {}),
  };
}

/**
 * The gate object inside an observer frame.
 *
 * Tool frames wrap the event. A workflow gate is published as the payload
 * itself (`{ kind: "workflow_gate", payload: gate }`). Either shape is accepted.
 */
export function workflowGateRecord(payload: unknown): Record<string, unknown> | undefined {
  const body = record(payload);
  if (!body) return undefined;
  const nested = record(body.event);
  if (nested && (nested.type === "workflow_gate" || typeof nested.gate_id === "string"))
    return nested;
  if (body.type === "workflow_gate" || typeof body.gate_id === "string") return body;
  return undefined;
}

/** One gates.list row or gate event, or undefined when it is not a question. */
export function questionFromGateRecord(
  sessionId: string,
  row: unknown,
): QuestionActivity | undefined {
  const value = record(row);
  if (!value) return undefined;
  const context = record(value.context) ?? {};
  const stage = record(context.stage_state) ?? {};
  const approval =
    value.kind === "approval" &&
    value.stage === "ralplan" &&
    typeof stage.question_id === "string";
  if (value.kind !== "question" && !approval) return undefined;
  const gateId = typeof value.gate_id === "string" ? value.gate_id.trim() : "";
  if (!gateId) return undefined;
  const tagValue = typeof value.tag === "string" ? value.tag : "pending";
  if (!GATE_TAGS.has(tagValue as QuestionGateTag)) return undefined;
  const tag = tagValue as QuestionGateTag;
  const title = typeof context.title === "string" ? context.title : "";
  const prompt = typeof context.prompt === "string" ? context.prompt : "";
  const question = oneLine(title || prompt);
  if (!question) return undefined;
  const options = Array.isArray(value.options)
    ? value.options.flatMap((entry) => {
        const option = optionFrom(entry);
        return option ? [option] : [];
      })
    : [];
  return {
    id: gateId,
    kind: "question",
    sessionId,
    question,
    options,
    multi: stage.multi === true,
    status: statusForTag(tag),
    createdAt: typeof value.created_at === "string" ? value.created_at : "",
    answerable: tag === "pending",
    tag,
    expectedSessionId: sessionId,
    ...(approval ? { approval: true as const } : {}),
    ...(typeof value.runtime_turn_id === "string"
      ? { runtimeTurnId: value.runtime_turn_id }
      : {}),
  };
}

function uniqueLabels(
  selected: readonly string[],
  labels: ReadonlySet<string>,
): string[] {
  const chosen: string[] = [];
  const seen = new Set<string>();
  for (const label of selected) {
    const text = label.trim();
    if (!labels.has(text))
      throw new Error("알 수 없는 선택지입니다.");
    if (seen.has(text))
      throw new Error("같은 선택지를 두 번 고를 수 없습니다.");
    seen.add(text);
    chosen.push(text);
  }
  return chosen;
}

/**
 * The `workflow.gate_answer` response body.
 *
 * A single-select question sends at most one label. Free text cannot be
 * whitespace. Clarification is a separate shape and does not carry a selection.
 */
export function buildGateAnswer(
  submission: QuestionSubmission,
  question: { multi: boolean; options: readonly { label: string }[] },
): Record<string, unknown> {
  const clarify = submission.clarify?.trim() ?? "";
  if (submission.clarify !== undefined && submission.clarify.length > 0) {
    if (!/\S/u.test(clarify))
      throw new Error("확인 질문을 입력해 주세요.");
    return { action: "clarify", question: clarify };
  }
  const labels = new Set(question.options.map((option) => option.label));
  const customRaw = submission.custom ?? "";
  if (customRaw.length > 0) {
    const custom = customRaw.trim();
    if (!/\S/u.test(custom))
      throw new Error("직접 입력은 공백만으로 채울 수 없습니다.");
    if (!question.multi && submission.selected.length > 0)
      throw new Error("하나만 선택할 수 있습니다.");
    const selected = question.multi ? uniqueLabels(submission.selected, labels) : [];
    return { selected, other: true, custom, action: "answer" };
  }
  const selected = uniqueLabels(submission.selected, labels);
  if (!question.multi && selected.length > 1)
    throw new Error("하나만 선택할 수 있습니다.");
  if (selected.length === 0)
    throw new Error("선택하거나 직접 입력해 주세요.");
  return { selected, action: "answer" };
}

/** Text the collapsed card shows after this window accepted an answer. */
export function questionAnswerSummary(submission: QuestionSubmission): string {
  const clarify = submission.clarify?.trim();
  if (clarify) return clarify;
  const custom = submission.custom?.trim();
  if (custom) return custom;
  return submission.selected.map((label) => label.trim()).filter(Boolean).join(", ");
}

/**
 * A `rejected` resolution from `workflow.gate_answer`, or undefined when the
 * host accepted the answer.
 */
export function gateAnswerRejection(
  result: Record<string, unknown> | undefined,
): string | undefined {
  if (!result || result.status !== "rejected") return undefined;
  const error = record(result.error);
  const errors = Array.isArray(error?.errors) ? error.errors : [];
  for (const entry of errors) {
    const message = record(entry)?.message;
    if (typeof message === "string" && message.trim()) return message.trim();
  }
  const message = error?.message;
  if (typeof message === "string" && message.trim()) return message.trim();
  return "답이 거부되었습니다. 다시 입력해 주세요.";
}
