import type {
  SessionProgress,
  UltragoalProgress,
  UltragoalStory,
  WorkflowChip,
  WorkflowChipSeverity,
  WorkflowStatus,
} from "./agent-contract.js";

export const SESSION_PROGRESS_SCHEMA = "gjc.project_progress.v1";

const SEVERITIES = new Set<unknown>([
  "info",
  "warning",
  "blocked",
  "error",
  "success",
] satisfies WorkflowChipSeverity[]);

type Row = Record<string, unknown>;

function record(value: unknown): Row | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Row;
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const line = value.replace(/\s+/gu, " ").trim();
  return line || undefined;
}

function count(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? (value as number)
    : undefined;
}

function rows<T>(value: unknown, parse: (row: Row) => T | undefined): T[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const row = record(entry);
    const parsed = row ? parse(row) : undefined;
    return parsed === undefined ? [] : [parsed];
  });
}

function story(row: Row): UltragoalStory | undefined {
  const id = text(row.id);
  const title = text(row.title);
  const status = text(row.status);
  if (!id || !title || !status) return undefined;
  return { id, title, status, verificationReceipt: row.verificationReceipt === true };
}

const COUNT_KEYS = [
  "total",
  "complete",
  "active",
  "pending",
  "blocked",
  "superseded",
] as const;

function ultragoal(value: unknown, activeStory: unknown): UltragoalProgress | null {
  const row = record(value);
  const objective = text(row?.objective);
  const rawCounts = record(row?.counts);
  if (!row || !objective || !rawCounts) return null;
  const counts = {} as UltragoalProgress["counts"];
  for (const key of COUNT_KEYS) {
    const value = count(rawCounts[key]);
    if (value === undefined) return null;
    counts[key] = value;
  }
  const current = record(activeStory);
  const currentId = text(current?.id);
  const currentTitle = text(current?.title);
  return {
    objective,
    counts,
    stories: rows(row.stories, story),
    omittedStories: count(row.omittedStories) ?? 0,
    current: currentId && currentTitle ? { id: currentId, title: currentTitle } : null,
  };
}

function chip(row: Row): WorkflowChip | undefined {
  const label = text(row.label);
  if (!label) return undefined;
  return {
    label,
    value: text(row.value) ?? null,
    severity: SEVERITIES.has(row.severity) ? (row.severity as WorkflowChipSeverity) : null,
  };
}

/**
 * One `session.progress` page item, or undefined when it is not a
 * `gjc.project_progress.v1` snapshot.
 *
 * Shape: gjc 0.19.0 `progress/progress-snapshot.ts` (`toProjectProgressSnapshot`).
 * A malformed story, workflow or chip is dropped on its own and the rest of the
 * snapshot still counts. Malformed ultragoal counts drop the whole ledger, since
 * a partial count would misstate progress.
 */
export function parseSessionProgress(value: unknown): SessionProgress | undefined {
  const snapshot = record(value);
  if (!snapshot || snapshot.schema !== SESSION_PROGRESS_SCHEMA) return undefined;
  const execution = record(snapshot.execution);
  const activeWork = record(snapshot.activeWork);
  const verdicts = new Map<string, string>();
  for (const row of rows(record(snapshot.verification)?.reviewVerdicts, (entry) => entry)) {
    const skill = text(row.skill);
    const verdict = text(row.verdict);
    if (skill && verdict) verdicts.set(skill, verdict);
  }
  const workflows = rows(activeWork?.workflows, (row): WorkflowStatus | undefined => {
    const skill = text(row.skill);
    const phase = text(row.phase);
    if (!skill || !phase) return undefined;
    return {
      skill,
      phase,
      summary: text(row.summary) ?? null,
      chips: rows(row.chips, chip),
      verdict: verdicts.get(skill) ?? null,
    };
  });
  return {
    ultragoal: ultragoal(execution?.ultragoal, activeWork?.story),
    workflows,
    omittedWorkflows: count(activeWork?.omittedWorkflows) ?? 0,
  };
}
