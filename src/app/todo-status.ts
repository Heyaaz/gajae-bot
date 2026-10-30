// The todo card prints the runtime's own status vocabulary, so a status outside it is
// rendered as itself (and counted as other) rather than mapped onto one of these.
export const TODO_STATUS_MARKERS = {
  in_progress: "◐",
  pending: "○",
  completed: "✓",
  abandoned: "⊘",
} as const;

export const TODO_STATUS_LABELS = {
  in_progress: "in progress",
  pending: "pending",
  completed: "completed",
  abandoned: "abandoned",
} as const;

export type TodoStatus = keyof typeof TODO_STATUS_MARKERS;

const TODO_STATUS_ORDER: readonly TodoStatus[] = [
  "in_progress",
  "pending",
  "completed",
  "abandoned",
];
export const TODO_UNKNOWN_MARKER = "•";

// What the counts line can name, in the order it lists them. A status outside this list
// is counted at the end, as other.
export const TODO_COUNT_KEYS: readonly (TodoStatus | "other")[] = [
  ...TODO_STATUS_ORDER,
  "other",
];

// A set rather than `in`: a status is data from the runtime, and `"constructor" in {}` is
// true, which would have classified a task named after a prototype key as a known status.
const TODO_STATUS_KEYS: ReadonlySet<string> = new Set(TODO_STATUS_ORDER);

export function todoStatusKey(status: string | undefined): TodoStatus | undefined {
  const value = status?.trim().toLowerCase();
  return value && TODO_STATUS_KEYS.has(value) ? (value as TodoStatus) : undefined;
}

/** The todo card's marker and class suffix for one task, shared with the goal row. */
export function todoStatusView(status: string | undefined): { marker: string; key: string } {
  const key = todoStatusKey(status);
  return key
    ? { marker: TODO_STATUS_MARKERS[key], key }
    : { marker: TODO_UNKNOWN_MARKER, key: "unknown" };
}
