import type { CliQuestionAnswer, QuestionActivity } from "./agent-contract.js";

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Project one session-bound public ask interaction without changing answer values. */
export function questionFromInteractiveRecord(sessionId: string, input: unknown): QuestionActivity | undefined {
  const row = record(input);
  if (!row || !nonempty(sessionId) || row.sessionId !== sessionId ||
      !nonempty(row.id) || !nonempty(row.questionId) || !nonempty(row.question) ||
      (row.interaction !== "selector" && row.interaction !== "custom_editor" && row.interaction !== "clarification_editor") ||
      !Array.isArray(row.options) || !row.options.every((value: unknown) => typeof value === "string") ||
      !Array.isArray(row.controls) ||
      (row.multi !== undefined && typeof row.multi !== "boolean")) return undefined;
  const options: string[] = row.options;
  const selected = row.selectedOptions === undefined ? [] : row.selectedOptions;
  if (!Array.isArray(selected) || !selected.every((value: unknown) => typeof value === "string")) return undefined;
  const controls: { id: string; label: string; enabled: boolean }[] = [];
  for (const inputControl of row.controls) {
    const control = record(inputControl);
    if (!control || !nonempty(control.id) || !nonempty(control.kind) || !nonempty(control.label) ||
        typeof control.enabled !== "boolean" || controls.some((entry) => entry.id === control.id)) return undefined;
    controls.push({ id: control.id, label: control.label, enabled: control.enabled });
  }
  const editor = row.editor === undefined ? undefined : record(row.editor);
  if (row.editor !== undefined && (!editor || typeof editor.title !== "string" ||
      (editor.prefill !== undefined && typeof editor.prefill !== "string"))) return undefined;
  const recommendedIndex = row.recommendedIndex;
  if (recommendedIndex !== undefined && (!Number.isInteger(recommendedIndex) ||
      (recommendedIndex as number) < 0 || (recommendedIndex as number) >= options.length)) return undefined;
  return {
    id: `cli-ask:${row.questionId}`,
    kind: "question",
    sessionId,
    question: row.question,
    options: options.map((label, index) => ({ label, ...(index === recommendedIndex ? { recommended: true } : {}) })),
    multi: row.multi === true,
    status: "pending",
    createdAt: "",
    answerable: true,
    tag: "pending",
    expectedSessionId: sessionId,
    cli: {
      requestId: row.id,
      interaction: row.interaction,
      selectedOptions: selected,
      controls,
      ...(editor ? { editor: { title: editor.title as string, ...(typeof editor.prefill === "string" ? { prefill: editor.prefill } : {}) } } : {}),
    },
  };
}

/** Validate against the interaction actually displayed, preserving exact values. */
export function validInteractiveAnswer(question: QuestionActivity, answer: unknown): answer is CliQuestionAnswer {
  const value = record(answer);
  const cli = question.cli;
  if (!value || !cli) return false;
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes("kind")) return false;
  if (value.kind === "control")
    return keys.includes("controlId") && typeof value.controlId === "string" && cli.controls.some((control) => control.id === value.controlId && control.enabled);
  if (value.kind !== "value" || !keys.includes("value") || typeof value.value !== "string") return false;
  return cli.interaction === "selector"
    ? question.options.some((option) => option.label === value.value)
    : /\S/u.test(value.value);
}
