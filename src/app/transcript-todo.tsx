import type { TodoSnapshotTask } from "../../shared/agent-contract";
import type { TranscriptItem } from "../backend/types";
import { ChevronRight, ListChecks } from "lucide-react";
import { useState } from "react";
import { t } from "../i18n";
import { MarkdownBody } from "./transcript-markdown";

// Constructing a DateTimeFormat costs more than formatting with one, and every todo
// snapshot carries the observation time it was read at. Same 24-hour shape the
// controller labels its own observations with, so the two read alike.
const TODO_CLOCK_LABEL = new Intl.DateTimeFormat("en", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

// The todo card prints the runtime's own status vocabulary, so a status outside it is
// rendered as itself (and counted as other) rather than mapped onto one of these.
const TODO_STATUS_MARKERS = {
  in_progress: "◐",
  pending: "○",
  completed: "✓",
  abandoned: "⊘",
} as const;

const TODO_STATUS_LABELS = {
  in_progress: "in progress",
  pending: "pending",
  completed: "completed",
  abandoned: "abandoned",
} as const;

type TodoStatus = keyof typeof TODO_STATUS_MARKERS;

const TODO_STATUS_ORDER: readonly TodoStatus[] = [
  "in_progress",
  "pending",
  "completed",
  "abandoned",
];
const TODO_UNKNOWN_MARKER = "•";

// What the counts line can name, in the order it lists them. A status outside this list
// is counted at the end, as other.
const TODO_COUNT_KEYS: readonly (TodoStatus | "other")[] = [
  ...TODO_STATUS_ORDER,
  "other",
];

// A set rather than `in`: a status is data from the runtime, and `"constructor" in {}` is
// true, which would have classified a task named after a prototype key as a known status.
const TODO_STATUS_KEYS: ReadonlySet<string> = new Set(TODO_STATUS_ORDER);

function todoStatusKey(status: string | undefined): TodoStatus | undefined {
  const value = status?.trim().toLowerCase();
  return value && TODO_STATUS_KEYS.has(value) ? (value as TodoStatus) : undefined;
}

/**
 * The compact counts line: only the statuses the runtime actually reported, and a status
 * this window cannot name counted as other instead of being folded into one of the four.
 */
function todoCountsText(tasks: TodoSnapshotTask[]): string {
  const counts = new Map<TodoStatus | "other", number>();
  for (const task of tasks) {
    const key = todoStatusKey(task.status) ?? "other";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return TODO_COUNT_KEYS.flatMap((key) => {
    const value = counts.get(key) ?? 0;
    if (value === 0) return [];
    const label = key === "other" ? "other" : TODO_STATUS_LABELS[key];
    return [`${label} ${value}`];
  }).join(" · ");
}

/** 24-hour clock time of an observation, in the same format the controller labels
 * observations with. A stamp that does not parse labels nothing rather than throwing
 * inside a transcript row. */
function todoObservedLabel(observedAt: string | undefined): string {
  const parsed = observedAt ? Date.parse(observedAt) : Number.NaN;
  return Number.isFinite(parsed) ? TODO_CLOCK_LABEL.format(parsed) : "";
}

/**
 * The app-owned todo snapshot (`sourceType: "todo.list"`) as a checklist.
 *
 * The row used to render the controller's report of itself -- source, observation time,
 * how many records came back -- plus the snapshot's JSON, which said nothing about the
 * work. Each item is a row here, marked by the status the runtime gave it, and the
 * snapshot text stays behind 더 보기 so the record itself is not hidden. A task's
 * notes are a running log the agent appends to, so a row shows only the task and
 * opens its notes on demand.
 */
export function TodoCard({
  item,
}: {
  item: Extract<TranscriptItem, { kind: "system" }>;
}) {
  const [expanded, setExpanded] = useState(false);
  // A phase the runtime reported empty is dropped: it would be a heading with nothing
  // under it, and a snapshot with no items at all gets one line instead of a list.
  const phases = (item.todoPhases ?? []).filter(
    (phase) => (phase.tasks ?? []).length > 0,
  );
  const tasks = phases.flatMap((phase) => phase.tasks ?? []);
  const counts = todoCountsText(tasks);
  const observed = todoObservedLabel(item.observedAt);
  const source = item.sourceType?.trim() || "todo.list";
  const hasRaw = item.content.trim().length > 0;
  return (
    <article className="system-card todo-card">
      <header>
        <ListChecks size={15} />
        <strong>{item.title}</strong>
        {counts && <span className="todo-card-counts">{counts}</span>}
      </header>
      <div className="system-card-body todo-card-body">
        {tasks.length === 0 ? (
          <p className="todo-empty">
            No todos{observed ? ` · observed ${observed}` : ""}
          </p>
        ) : (
          <div className="todo-phases">
            {phases.map((phase, phaseIndex) => (
              <section
                className="todo-phase"
                key={`${phase.name ?? "phase"}-${phaseIndex}`}
              >
                {phase.name ? (
                  <h4 className="todo-phase-name">{phase.name}</h4>
                ) : null}
                <ul className="todo-tasks">
                  {phase.tasks.map((task, taskIndex) => {
                    const status = todoStatusKey(task.status);
                    const notes = (task.notes ?? []).filter(
                      (note) => note.trim().length > 0,
                    );
                    return (
                      <li
                        className={`todo-task ${
                          status
                            ? `todo-task--${status}`
                            : "todo-task--unknown"
                        }`}
                        key={`${task.content}-${taskIndex}`}
                      >
                        <span className="todo-task-marker" aria-hidden>
                          {status ? TODO_STATUS_MARKERS[status] : TODO_UNKNOWN_MARKER}
                        </span>
                        {notes.length === 0 ? (
                          <div className="todo-task-body">
                            <span className="todo-task-content">{task.content}</span>
                          </div>
                        ) : (
                          <details className="todo-task-body">
                            <summary>
                              <span className="todo-task-content">{task.content}</span>
                              <span className="todo-task-note-count">
                                <ChevronRight size={11} aria-hidden />
                                {notes.length}
                              </span>
                            </summary>
                            {notes.map((note, noteIndex) => (
                              <span
                                className="todo-task-note"
                                key={noteIndex}
                                title={note}
                              >
                                {note.split("\n")[0]}
                              </span>
                            ))}
                          </details>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </div>
        )}
        {expanded && (
          <div className="todo-card-raw markdown-body">
            <MarkdownBody>{item.content}</MarkdownBody>
          </div>
        )}
      </div>
      {hasRaw && (
        <button
          type="button"
          className="compaction-toggle"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? t("접기") : t("더 보기")}
        </button>
      )}
      <footer className="todo-provenance">
        {observed ? `observed ${observed} · ${source}` : source}
      </footer>
    </article>
  );
}
