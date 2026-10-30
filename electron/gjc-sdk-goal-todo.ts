import type { AgentEvent, AgentSession, GoalOperation, GoalSnapshot, SessionProgress, SystemNoticeActivity, TranscriptItem } from "../shared/agent-contract.js";
import { parseSessionProgress } from "../shared/session-progress.js";
import {
  boundedJson,
  cloneTranscriptItem,
  nowLabel,
  sameTranscriptItem,
  todoQueryErrorText,
  todoSnapshotPhases,
  todoSnapshotRowId,
  TodoSnapshotState,
} from "./gjc-sdk-foundation.js";

/** Fallback todo read when the session has no live todo event channel. */
export const TODO_EVENT_POLL_BASE_MS = 30_000;

export const TODO_EVENT_POLL_MAX_MS = 120_000;

/**
 * `session.progress` reads. A tool end, a gate or a turn end asks for one, and
 * those are coalesced to at most one read per interval. Without such an event
 * the goal poll re-reads a snapshot only after it has been stale this long.
 */
export const PROGRESS_REFRESH_MIN_MS = 4_000;

export const PROGRESS_STALE_MS = 30_000;

/**
 * How long after its last goal read a session still counts as watched. The
 * slowest goal poll is 30s, so a watched session never lapses between polls.
 */
export const PROGRESS_WATCH_MS = 60_000;

/** The controller members the goal, progress and todo reads touch. */
export interface GoalTodoHost {
  querySessionItems(
    sessionId: string,
    query: string,
    input?: Record<string, unknown>,
    options?: { strict?: boolean },
  ): Promise<unknown[]>;
  readonly sessionSdkOperations: Map<string, Set<string>>;
  readonly progressWatchedAt: Map<string, number>;
  readonly sessionProgress: Map<string, { progress: SessionProgress | undefined; readAt: number }>;
  readonly disposed: boolean;
  readonly progressTimers: Map<string, ReturnType<typeof setTimeout>>;
  readonly progressReads: Map<string, Promise<void>>;
  readonly sessions: Map<string, AgentSession>;
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
  readonly sessionTodoSnapshots: Map<string, TodoSnapshotState>;
  readonly attachedSessions: Set<string>;
  readonly todoPollTimers: Map<string, ReturnType<typeof setTimeout>>;
  readonly todoPollAttempts: Map<string, number>;
  readonly todoReads: Map<string, Promise<unknown[] | undefined>>;
  markTranscriptRowDirty(sessionId: string, rowId: string): void;
  readonly transcripts: Map<string, TranscriptItem[]>;
  noteTranscriptEpoch(sessionId: string): void;
  readonly emitEvent: (event: AgentEvent) => void;
}

export async function getGoal(host: GoalTodoHost, sessionId: string): Promise<GoalSnapshot> {
  // The todo read is shared with the transcript snapshot row, so the counters here
  // and the row a user can expand are the same observation of the same store.
  // A live tail already re-reads the store when a todo tool finishes, so this
  // poll must not call `todo.list` on the goal cadence. Without that channel the
  // fallback below is a long backoff, not another 4s/10s query.
  const [goalRows, todoRows, progress] = await Promise.all([
    host.querySessionItems(sessionId, "goal.list/get"),
    todoRowsForGoal(host, sessionId),
    progressForGoal(host, sessionId),
  ]);
  const state =
    goalRows[0] &&
    typeof goalRows[0] === "object" &&
    !Array.isArray(goalRows[0])
      ? (goalRows[0] as Record<string, unknown>)
      : undefined;
  const goal =
    state?.goal &&
    typeof state.goal === "object" &&
    !Array.isArray(state.goal)
      ? (state.goal as Record<string, unknown>)
      : undefined;
  const tasks = (todoRows ?? [])
    .flatMap((row) => {
      if (!row || typeof row !== "object" || Array.isArray(row)) return [];
      const value = row as Record<string, unknown>;
      return Array.isArray(value.tasks) ? value.tasks : [value];
    })
    .filter(
      (task): task is Record<string, unknown> =>
        Boolean(task) && typeof task === "object" && !Array.isArray(task),
    );
  const enabled = state?.enabled === true && Boolean(goal);
  const status =
    typeof goal?.status === "string"
      ? goal.status
      : typeof state?.mode === "string"
        ? state.mode
        : undefined;
  // A dropped goal is discarded, so it must not occupy the progress row. It used
  // to arrive as enabled with no mode, which the inspector rendered as an active
  // goal because it only checks `enabled` and `objective`.
  const live = enabled && status !== "dropped";
  return {
    enabled: live,
    ...(live &&
    (status === "active" || status === "paused" || status === "complete")
      ? { mode: status }
      : {}),
    ...(live && typeof goal?.objective === "string"
      ? { objective: goal.objective }
      : {}),
    completed: tasks.filter((task) => task.status === "completed").length,
    total: tasks.length,
    ...(live && tasks.length > 0
      ? {
          tasks: tasks.flatMap((task) =>
            typeof task.content === "string"
              ? [{
                  content: task.content,
                  ...(typeof task.status === "string" ? { status: task.status } : {}),
                }]
              : [],
          ),
        }
      : {}),
    ...(progress ? { progress } : {}),
  };
}

/**
 * The progress snapshot the goal row shows.
 *
 * Only the capability set already cached from the palette read decides
 * whether the session has `session.progress`: a CLI-primary session does not,
 * and the goal poll must not add a `runtime.capabilities` read to find out.
 */
async function progressForGoal(
  host: GoalTodoHost,
  sessionId: string,
): Promise<SessionProgress | undefined> {
  if (!host.sessionSdkOperations.get(sessionId)?.has("session.progress"))
    return undefined;
  host.progressWatchedAt.set(sessionId, Date.now());
  const cached = host.sessionProgress.get(sessionId);
  if (!cached) {
    await readProgress(host, sessionId);
    return host.sessionProgress.get(sessionId)?.progress;
  }
  if (Date.now() - cached.readAt >= PROGRESS_STALE_MS)
    requestProgressRefresh(host, sessionId);
  return cached.progress;
}

/**
 * Coalesces refresh requests into at most one read per interval. Only a session
 * a goal row is polling is read: the answer reaches the screen through that
 * poll, so for any other session the read would be wasted.
 */
export function requestProgressRefresh(host: GoalTodoHost, sessionId: string): void {
  if (
    host.disposed ||
    host.progressTimers.has(sessionId) ||
    !host.sessionSdkOperations.get(sessionId)?.has("session.progress") ||
    Date.now() - (host.progressWatchedAt.get(sessionId) ?? -Infinity) >
      PROGRESS_WATCH_MS
  )
    return;
  const readAt = host.sessionProgress.get(sessionId)?.readAt ?? 0;
  const delay = Math.max(0, readAt + PROGRESS_REFRESH_MIN_MS - Date.now());
  const timer = setTimeout(() => {
    host.progressTimers.delete(sessionId);
    void readProgress(host, sessionId);
  }, delay);
  host.progressTimers.set(sessionId, timer);
}

function readProgress(host: GoalTodoHost, sessionId: string): Promise<void> {
  const inflight = host.progressReads.get(sessionId);
  if (inflight) return inflight;
  const read = (async () => {
    let progress: SessionProgress | undefined;
    let failed = false;
    try {
      const items = await host.querySessionItems(
        sessionId,
        "session.progress",
        {},
        { strict: true },
      );
      progress = items
        .map(parseSessionProgress)
        .find((item): item is SessionProgress => item !== undefined);
    } catch {
      failed = true;
    }
    if (host.disposed || !host.sessions.has(sessionId)) return;
    const previous = host.sessionProgress.get(sessionId);
    host.sessionProgress.set(sessionId, {
      progress: failed ? previous?.progress : progress,
      readAt: Date.now(),
    });
  })().finally(() => {
    if (host.progressReads.get(sessionId) === read)
      host.progressReads.delete(sessionId);
  });
  host.progressReads.set(sessionId, read);
  return read;
}

export function clearProgress(host: GoalTodoHost, sessionId: string): void {
  const timer = host.progressTimers.get(sessionId);
  if (timer) clearTimeout(timer);
  host.progressTimers.delete(sessionId);
  host.sessionProgress.delete(sessionId);
  host.progressReads.delete(sessionId);
  host.progressWatchedAt.delete(sessionId);
}

export async function operateGoal(
  host: GoalTodoHost,
  sessionId: string,
  operation: GoalOperation,
): Promise<GoalSnapshot> {
  await host.controlSession(sessionId, "mode.goal.operate", {
    op: operation,
  });
  return getGoal(host, sessionId);
}

/**
 * Read the runtime's todo store and publish it as one transcript row.
 *
 * `todo.list` is the only todo source this window has: the tail protocol carries
 * no todo event and the returned records have no documented schema beyond rows
 * that may be wrapped in `tasks`. They are therefore retained and shown as data
 * rather than reduced into task state this window would have to invent, and the
 * query is strict -- a runtime that cannot answer is recorded as unreadable,
 * which is not the same thing as an empty list.
 */
/**
 * Todo rows for the goal counters.
 *
 * An attached session hears todo changes from the tail (`todo_write` reads the
 * store back). Polling `todo.list` on the goal interval repeated that read.
 * A session with no tail still needs a fallback, and that fallback waits longer
 * after each quiet pass.
 */
async function todoRowsForGoal(host: GoalTodoHost, sessionId: string): Promise<unknown[]> {
  const snapshot = host.sessionTodoSnapshots.get(sessionId);
  if (host.attachedSessions.has(sessionId)) {
    clearTodoPoll(host, sessionId);
    if (snapshot) return snapshot.rows ?? [];
    return (await readTodoRecords(host, sessionId)) ?? [];
  }
  // A failed read still leaves a snapshot, and that must not turn the goal
  // poll back into a `todo.list` on every pass. The backoff timer retries it.
  if (snapshot) {
    armTodoPoll(host, sessionId);
    return snapshot.rows ?? [];
  }
  const rows = (await readTodoRecords(host, sessionId)) ?? [];
  armTodoPoll(host, sessionId);
  return rows;
}

function armTodoPoll(host: GoalTodoHost, sessionId: string): void {
  if (
    host.disposed ||
    host.attachedSessions.has(sessionId) ||
    !host.sessions.has(sessionId) ||
    host.todoPollTimers.has(sessionId)
  )
    return;
  const attempt = host.todoPollAttempts.get(sessionId) ?? 0;
  const delay = Math.min(
    TODO_EVENT_POLL_MAX_MS,
    TODO_EVENT_POLL_BASE_MS * 2 ** attempt,
  );
  const timer = setTimeout(() => {
    host.todoPollTimers.delete(sessionId);
    if (
      host.disposed ||
      !host.sessions.has(sessionId) ||
      host.attachedSessions.has(sessionId)
    )
      return;
    host.todoPollAttempts.set(sessionId, attempt + 1);
    void readTodoRecords(host, sessionId).finally(() => {
      if (
        !host.disposed &&
        host.sessions.has(sessionId) &&
        !host.attachedSessions.has(sessionId)
      )
        armTodoPoll(host, sessionId);
    });
  }, delay);
  host.todoPollTimers.set(sessionId, timer);
}

export function clearTodoPoll(host: GoalTodoHost, sessionId: string): void {
  const timer = host.todoPollTimers.get(sessionId);
  if (timer) clearTimeout(timer);
  host.todoPollTimers.delete(sessionId);
  host.todoPollAttempts.delete(sessionId);
}

export async function readTodoRecords(
  host: GoalTodoHost,
  sessionId: string,
): Promise<unknown[] | undefined> {
  const pending = host.todoReads.get(sessionId);
  if (pending) return pending;
  const read = queryTodoRecords(host, sessionId);
  host.todoReads.set(sessionId, read);
  try {
    return await read;
  } finally {
    if (host.todoReads.get(sessionId) === read) host.todoReads.delete(sessionId);
  }
}

async function queryTodoRecords(
  host: GoalTodoHost,
  sessionId: string,
): Promise<unknown[] | undefined> {
  const observedAt = nowLabel();
  let rows: unknown[] | undefined;
  let failure: string | undefined;
  try {
    rows = await host.querySessionItems(
      sessionId,
      "todo.list",
      {},
      { strict: true },
    );
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }
  // A session this controller no longer holds must not have its row resurrected
  // by a read that was already in flight when the session was removed.
  if (host.disposed || !host.sessions.has(sessionId)) return undefined;
  if (rows === undefined)
    publishTodoSnapshot(host, sessionId, { error: failure, observedAt });
  else publishTodoSnapshot(host, sessionId, { rows, observedAt });
  return rows;
}

/**
 * Record what the todo store held, or that it could not be read.
 *
 * A failed read keeps the last successful snapshot on screen and says it is
 * stale; with no earlier success it says the store is unavailable. Neither case
 * may render as an empty list.
 */
function publishTodoSnapshot(
  host: GoalTodoHost,
  sessionId: string,
  observed:
    | { rows: unknown[]; observedAt: string }
    | { error: string | undefined; observedAt: string },
): void {
  const previous = host.sessionTodoSnapshots.get(sessionId);
  const header = ["- source: todo.list (strict read)"];
  let rows = previous?.rows;
  let json = previous?.json;
  let observedAt = previous?.observedAt;
  if ("rows" in observed) {
    const nextJson = boundedJson(observed.rows) ?? "[]";
    if (previous?.json === nextJson) return;
    rows = observed.rows;
    observedAt = observed.observedAt;
    json = nextJson;
    header.push(
      `- observed: ${observed.observedAt}`,
      `- records: ${observed.rows.length}`,
    );
  } else if (json !== undefined) {
    header.push(
      `- last success: ${observedAt ?? "unknown"}`,
      `- read failed: ${todoQueryErrorText(observed.error)}`,
      "- state: showing the last successful snapshot (stale)",
    );
  } else {
    header.push(
      `- observed: ${observed.observedAt}`,
      `- read failed: ${todoQueryErrorText(observed.error)}`,
      "- state: the todo store could not be read (this is not an empty list)",
    );
  }
  const row: SystemNoticeActivity = {
    id: todoSnapshotRowId(sessionId),
    kind: "system",
    sessionId,
    title: "Todos",
    content: [
      ...header,
      ...(json === undefined ? [] : ["```json", json, "```"]),
    ].join("\n"),
    createdAt: previous?.row.createdAt ?? nowLabel(),
    sourceType: "todo.list",
    // Phases are attached only when the store answered: a row without them falls
    // back to the text card that already says the snapshot is stale or unreadable,
    // because a checklist drawn from an older read would claim it is current.
    ...("rows" in observed
      ? {
          todoPhases: todoSnapshotPhases(observed.rows),
          observedAt: observed.observedAt,
        }
      : {}),
  };
  host.sessionTodoSnapshots.set(sessionId, {
    row,
    ...(rows === undefined ? {} : { rows }),
    ...(json === undefined ? {} : { json }),
    ...(observedAt === undefined ? {} : { observedAt }),
  });
  publishAppRow(host, sessionId, row);
}

/**
 * Put an app-owned row into a session's transcript.
 *
 * A row that has not changed is not republished: the goal panel and a transcript
 * bootstrap both read the same store, and each read would otherwise emit an IPC
 * row with identical content. A session with no installed transcript keeps the row
 * in its snapshot state, and the next install composes it in.
 */
function publishAppRow(host: GoalTodoHost, sessionId: string, row: SystemNoticeActivity): void {
  host.markTranscriptRowDirty(sessionId, row.id);
  const items = host.transcripts.get(sessionId);
  if (items) {
    const index = items.findIndex((item) => item.id === row.id);
    const existing = index >= 0 ? items[index] : undefined;
    if (existing && sameTranscriptItem(existing, row)) return;
    if (index >= 0) items[index] = row;
    else items.push(row);
  }
  host.noteTranscriptEpoch(sessionId);
  host.emitEvent({
    type: "transcript.appended",
    item: cloneTranscriptItem(row),
  });
}
