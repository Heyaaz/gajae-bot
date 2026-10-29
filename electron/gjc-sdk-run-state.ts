import { open, stat } from "node:fs/promises";
import { type FSWatcher, watch } from "node:fs";
import type { AgentEvent, AgentSession } from "../shared/agent-contract.js";
import {
  LIVE_EVIDENCE_GRACE_MS,
  PENDING_ASYNC_RECONCILE_INTERVAL_MS,
  persistedTurnState,
  readTranscriptTail,
} from "./gjc-sdk-foundation.js";
import { locateSharedTranscriptFile } from "./gjc-sdk-files.js";
import path from "node:path";

/** The controller members run-state verdicts and their watchers read and write. */
export interface RunStateHost {
  locateSharedTranscriptFile(
    sessionId: string,
  ): Promise<string | undefined>;
  readonly discoveredRunStates: Map<string, { size: number; status: AgentSession["status"]; runningJobIds?: string[] }>;
  readonly pendingAsyncWorkSessions: Map<string, string[]>;
  readonly asyncJobReconciliations: Map<string, { checkedAt: number; deadJobIds: Set<string>; checkedJobIds: Set<string>; querySucceeded: boolean; }>;
  readonly sessions: Map<string, AgentSession>;
  readonly liveRunningSessions: Set<string>;
  readonly transcriptRunningSessions: Set<string>;
  readonly locallyAbortedSessions: Set<string>;
  currentRunRevision(sessionId: string): number;
  readonly idleTranscriptBaselines: Map<string, { revision: number; size: number }>;
  readonly workingPhaseSessions: Set<string>;
  readonly runtimeIdleSessions: Set<string>;
  readonly liveEvidenceAt: Map<string, number>;
  readonly liveRunningDigests: Map<string, number>;
  readonly compactingSessions: Set<string>;
  readonly compactionRecordBaseline: Map<string, number>;
  readonly compactionStartedAt: Map<string, number>;
  readonly activePromptSessions: Set<string>;
  advanceRunRevision(sessionId: string): number;
  readonly emitEvent: (event: AgentEvent) => void;
  querySessionItems(
    sessionId: string,
    query: string,
    input?: Record<string, unknown>,
    options?: { strict?: boolean },
  ): Promise<unknown[]>;
  readonly disposed: boolean;
  readonly runStateWatchers: Map<string, FSWatcher>;
  readonly runStateTimers: Map<string, NodeJS.Timeout>;
  readonly sharedSessionWatchers: Map<string, FSWatcher>;
  readonly generation: number;
  lastDiscovered: AgentSession[];
}

/**
 * Run state for a session discovery is listing, read from its transcript.
 *
 * Discovery covers every session the broker knows, so this must not turn a list
 * refresh into hundreds of full file reads. Only the tail of the file is parsed,
 * and the result is cached against the file's size so an unchanged transcript is
 * answered without touching the disk again.
 */
export async function discoveredRunState(
  host: RunStateHost,
  sessionId: string,
): Promise<AgentSession["status"] | undefined> {
  try {
    const filePath = await host.locateSharedTranscriptFile(sessionId);
    if (!filePath) return undefined;
    const info = await stat(filePath);
    if (!info.isFile() || info.size > 64 * 1024 * 1024) return undefined;
    const cached = host.discoveredRunStates.get(sessionId);
    if (cached && cached.size === info.size) {
      const markers = cached.runningJobIds ?? [];
      const latched = host.pendingAsyncWorkSessions.get(sessionId) ?? [];
      if (markers.length === 0 && latched.length === 0)
        return effectiveTranscriptRunState(host, sessionId, cached.status);
      // The transcript cannot move while its size is unchanged, so the only part
      // of this verdict that still can is the detached work it rested on: a job
      // paused or cancelled from outside writes no release row, and nothing else
      // in the read path asks the runtime about it again. A latch is asked about
      // here too: it outlives the cached verdict, and a verdict taken from a tail
      // window can carry no marker at all while a full-history read left one.
      const surviving = await reconcilePendingAsyncWork(host,
        sessionId,
        markers,
        latched,
      );
      // A verdict this size rests entirely on markers reads idle once they are
      // gone. One that rested on the rows themselves keeps what they said. A
      // confirmed surviving latch holds it running; an unanswered lookup does not
      // replace that row-derived running verdict.
      const querySucceeded =
        host.asyncJobReconciliations.get(sessionId)?.querySucceeded === true;
      // No stored markers means the cached verdict came from the rows themselves.
      // A failed lookup of an inherited latch must not hide that foreground work.
      const rowsRunning = markers.length === 0 && cached.status === "running";
      const status = rowsRunning
        ? ("running" as const)
        : surviving.length > 0
          ? querySucceeded
            ? ("running" as const)
            : ("unknown" as const)
          : markers.length > 0
            ? ("idle" as const)
            : cached.status === "unknown"
              ? "idle"
              : cached.status;
      host.discoveredRunStates.set(sessionId, {
        size: info.size,
        status,
        // Keep a row-derived running verdict distinguishable from one that rests
        // on markers. Storing the latch here would let the next failed lookup
        // replace foreground work with `unknown`.
        ...(rowsRunning || surviving.length === 0
          ? {}
          : { runningJobIds: surviving }),
      });
      return effectiveTranscriptRunState(host, sessionId, status);
    }
    // Never parse whole transcripts here. Measured across 399 local sessions
    // (640MB), a full parse of each costs ~23s, which would stall every list
    // refresh. Run state only depends on how the newest rows end, so a bounded
    // tail is read instead.
    // Expanding is only needed for a running -> idle decision whose user boundary
    // fell outside the first window. Ordinary discovery stays at 256KB, preserving
    // the measured ~30ms all-session scan instead of regressing toward full parses.
    const envelopes = await readTranscriptTail(
      filePath,
      info.size,
      host.sessions.get(sessionId)?.status === "running" ||
        host.liveRunningSessions.has(sessionId),
    );
    if (!envelopes) return undefined;
    const turn = persistedTurnState(envelopes);
    const latched = host.pendingAsyncWorkSessions.get(sessionId) ?? [];
    let runningJobIds: string[] | undefined;
    let running = turn.running;
    if (turn.pendingAsyncWorkOnly) {
      // The one verdict a transcript cannot settle alone. A detached task that is
      // paused, cancelled, or lost with its process writes no release row, so its
      // launch marker stays in the file long after the work ended. The runtime's
      // own job list decides -- and it is asked only when nothing else in the
      // transcript keeps the session running.
      runningJobIds = await reconcilePendingAsyncWork(host,
        sessionId,
        turn.pendingAsyncJobIds,
        latched,
      );
      running = host.asyncJobReconciliations.get(sessionId)?.querySucceeded === true &&
        runningJobIds.length > 0;
    } else if (!running && latched.length > 0) {
      // This window names no launch marker and the rows read settled, but an
      // earlier full-history read left detached work latched whose launch rows sit
      // behind every window this read parses. Nothing here can retire those, and a
      // window that cannot see a marker is not evidence the work ended: a real
      // detached job outlives the turn that launched it. So the latch's markers go
      // to the runtime, which is the only authority on whether the job is still
      // alive, and an unanswered query keeps them. Leaving them unasked is what
      // held a finished task-heavy session at 작업 중 -- every read computed idle
      // and the stale latch turned it back into running.
      const surviving = await reconcilePendingAsyncWork(host,
        sessionId,
        [],
        latched,
      );
      running = host.asyncJobReconciliations.get(sessionId)?.querySucceeded === true &&
        surviving.length > 0;
      // Only a surviving latch is recorded: nothing in these rows rests on the
      // markers, so an idle verdict here is the window's own account.
      if (running) runningJobIds = surviving;
    }
    const uncertainPendingJobs =
      !running &&
      (host.pendingAsyncWorkSessions.get(sessionId)?.length ?? 0) > 0 &&
      host.asyncJobReconciliations.get(sessionId)?.querySucceeded === false;
    const status = running
      ? ("running" as const)
      : uncertainPendingJobs
        ? ("unknown" as const)
        : ("idle" as const);
    if (status === "running") host.transcriptRunningSessions.add(sessionId);
    else host.transcriptRunningSessions.delete(sessionId);
    host.discoveredRunStates.set(sessionId, {
      size: info.size,
      status,
      ...(runningJobIds ? { runningJobIds } : {}),
    });
    return effectiveTranscriptRunState(host, sessionId, status);
  } catch {
    return undefined;
  }
}

/**
 * Whether an idle row's transcript has started work since the row settled.
 *
 * A settled row is lifted only by rows written after it settled. A transcript that
 * merely still reads running -- a turn that died mid-tool without a stop row -- is
 * the same snapshot the idle verdict already overruled, so the size at that verdict
 * is the baseline, and it is taken per run revision: any later status change
 * starts a new baseline instead of comparing against an older settle.
 */
export function transcriptStartedNewWork(
  host: RunStateHost,
  sessionId: string,
  size: number,
  transcriptRunning: boolean,
): boolean {
  if (host.sessions.get(sessionId)?.status !== "idle") return false;
  if (host.locallyAbortedSessions.has(sessionId)) return false;
  const revision = host.currentRunRevision(sessionId);
  const baseline = host.idleTranscriptBaselines.get(sessionId);
  if (!baseline || baseline.revision !== revision) {
    host.idleTranscriptBaselines.set(sessionId, { revision, size });
    return false;
  }
  return transcriptRunning && size > baseline.size;
}

function effectiveTranscriptRunState(
  host: RunStateHost,
  sessionId: string,
  status: AgentSession["status"],
): AgentSession["status"] {
  if (
    (status === "idle" || status === "unknown") &&
    ((host.workingPhaseSessions.has(sessionId) &&
      !host.runtimeIdleSessions.has(sessionId) &&
      // A phase report ages like every other live signal. A 'working' phase with
      // no report after it held a settled row running for the life of the process,
      // and nothing else re-derives a verdict for a session a latch still names.
      !liveEvidenceQuiet(host, sessionId)))
  )
    return "running";
  if (
    status === "idle" &&
    host.pendingAsyncWorkSessions.has(sessionId)
  ) {
    return host.asyncJobReconciliations.get(sessionId)?.querySucceeded === false
      ? "unknown"
      : "running";
  }
  return status;
}

/**
 * Records that a live report for this session confirmed work just now.
 *
 * Called from every path that accepts live evidence of work, never from a read of
 * the transcript: this is the clock that decides when the transcript is the newer
 * account.
 */
export function recordLiveEvidence(host: RunStateHost, sessionId: string): void {
  host.liveEvidenceAt.set(sessionId, Date.now());
}

/** True when no live work signal arrived for this session inside the grace. */
export function liveEvidenceQuiet(host: RunStateHost, sessionId: string): boolean {
  const lastReportedAt = host.liveEvidenceAt.get(sessionId);
  // A latch with no recorded report is quiet rather than forever fresh: every path
  // that arms one records evidence, so an unrecorded latch describes work this
  // process holds no live account of -- the state a settled transcript settles.
  return (
    lastReportedAt === undefined ||
    Date.now() - lastReportedAt > LIVE_EVIDENCE_GRACE_MS
  );
}

/**
 * Drops every latch that can hold a settled row in the working group.
 *
 * One list for both callers, so a latch added later is released by each: the live
 * idle report in patchSessionInfo, and the quiet-evidence reconciliation in
 * discovery. The compaction entries stay dormant behind both callers' own
 * compaction guards -- GJC's durable record is what ends compaction, never a
 * transcript that merely reads idle -- but they belong to the same list.
 */
export function clearRunningLatches(host: RunStateHost, sessionId: string): void {
  host.liveRunningSessions.delete(sessionId);
  host.liveRunningDigests.delete(sessionId);
  host.liveEvidenceAt.delete(sessionId);
  host.transcriptRunningSessions.delete(sessionId);
  host.workingPhaseSessions.delete(sessionId);
  host.runtimeIdleSessions.delete(sessionId);
  host.discoveredRunStates.delete(sessionId);
  host.compactingSessions.delete(sessionId);
  host.compactionRecordBaseline.delete(sessionId);
  host.compactionStartedAt.delete(sessionId);
}

/**
 * Settles a row the live signal left running once the evidence behind it ran out.
 *
 * Only the transcript's own verdict settles a row here, so this is reached only
 * when the file says the turn ended and nothing disagrees: this window is not
 * driving the session, no live report has been accepted inside the grace, and no
 * compaction is standing on GJC's durable receipt. The run revision advances with
 * the status because the renderer keeps the revision it already holds over a lower
 * one, and a row that kept its revision would stay exactly where it was.
 *
 * Nothing is announced as completed: this reconciliation can settle a turn that
 * ended hours ago, while the live report path is what announces a turn that just
 * finished.
 *
 * @returns true when the row was settled, so its status is now `idle`.
 */
export function settleQuietRunningRow(
  host: RunStateHost,
  sessionId: string,
  transcriptStatus: AgentSession["status"] | undefined,
  currentSession: AgentSession | undefined,
): boolean {
  if (transcriptStatus !== "idle") return false;
  if (currentSession?.status !== "running") return false;
  if (host.activePromptSessions.has(sessionId)) return false;
  // Compaction is released by its own durable record or by a non-compacting
  // phase, never by a transcript that reads idle while the history is still being
  // rewritten under it.
  if (host.compactingSessions.has(sessionId)) return false;
  if (!liveEvidenceQuiet(host, sessionId)) return false;
  clearRunningLatches(host, sessionId);
  host.advanceRunRevision(sessionId);
  currentSession.status = "idle";
  host.emitEvent({ type: "session.updated", session: { ...currentSession } });
  return true;
}

/**
 * The markers among `observed` and `inherited` the runtime still reports running.
 *
 * Two reads disagree about a long transcript and neither is wrong: the full-history
 * read that installs a session can name every launch row the file still owes, while
 * the bounded run-state read only ever sees the tail. `observed` is what the read at
 * hand could see; `inherited` is what an earlier read latched and this one is not
 * allowed to see -- a bounded window that lacks a launch row is not evidence that
 * the work ended, so those markers are put to the runtime rather than dropped. A
 * read that saw the whole file passes no inherited markers: a marker its rows no
 * longer owe has been released, and merging it back would resurrect it.
 *
 * Only an answer from `runtime.jobs.list` retires a marker, and a query that could
 * not be answered retires nothing. The answer is recorded as this session's latch,
 * so what is left of these markers is what later reads put back to the runtime.
 */
async function reconcilePendingAsyncWork(
  host: RunStateHost,
  sessionId: string,
  observed: readonly string[],
  inherited: readonly string[],
): Promise<string[]> {
  const candidates = new Set(observed);
  for (const jobId of inherited) candidates.add(jobId);
  const surviving = await reconciledAsyncJobIds(host, sessionId, [...candidates]);
  recordPendingAsyncWork(host, sessionId, surviving);
  return surviving;
}

/** Remembers the detached work a session still owes, or drops the latch when none is left. */
export function recordPendingAsyncWork(
  host: RunStateHost,
  sessionId: string,
  jobIds: readonly string[],
): void {
  if (jobIds.length > 0) host.pendingAsyncWorkSessions.set(sessionId, [...jobIds]);
  else host.pendingAsyncWorkSessions.delete(sessionId);
}

/** The launch markers a reconciliation has not retired. */
function unreconciledAsyncJobIds(
  host: RunStateHost,
  sessionId: string,
  jobIds: readonly string[],
): string[] {
  const dead = host.asyncJobReconciliations.get(sessionId)?.deadJobIds;
  if (!dead || dead.size === 0) return [...jobIds];
  return jobIds.filter((jobId) => !dead.has(jobId));
}

/**
 * The launch markers among `jobIds` the runtime still reports as running.
 *
 * A marker the runtime no longer lists was finished, paused, cancelled, or taken
 * down with its process, and none of those are work in progress. A query that
 * cannot be answered is not evidence the work ended, so every marker survives it --
 * but the markers the attempt covered are remembered either way, so the run-state
 * read path never turns into a query loop over a runtime that cannot answer while a
 * marker nobody has asked about still gets an answer of its own.
 */
export async function reconciledAsyncJobIds(
  host: RunStateHost,
  sessionId: string,
  jobIds: readonly string[],
): Promise<string[]> {
  const pending = unreconciledAsyncJobIds(host, sessionId, jobIds);
  if (pending.length === 0) return pending;
  const record = host.asyncJobReconciliations.get(sessionId);
  const asked = record?.checkedJobIds;
  const now = Date.now();
  if (
    record &&
    pending.every((jobId) => asked?.has(jobId)) &&
    now - record.checkedAt < PENDING_ASYNC_RECONCILE_INTERVAL_MS
  )
    return pending;
  const dead = record?.deadJobIds ?? new Set<string>();
  const live = await runningAsyncJobIds(host, sessionId);
  host.asyncJobReconciliations.set(sessionId, {
    checkedAt: now,
    deadJobIds: dead,
    checkedJobIds: new Set([...(asked ?? []), ...pending]),
    querySucceeded: live !== undefined,
  });
  if (!live) return pending;
  for (const jobId of pending) if (!live.has(jobId)) dead.add(jobId);
  return pending.filter((jobId) => live.has(jobId));
}

/**
 * The jobs a session's runtime currently reports as running, or undefined when it
 * did not answer.
 *
 * `runtime.jobs.list` answers one wrapper row holding `running`, the entries the
 * runtime still considers alive, next to `recent` and `delivery` bookkeeping. Only
 * that list can retire a launch marker, and an empty answer is never fabricated:
 * it resolves every marker as dead, so a runtime that could not be reached must
 * not be reported as one that answered nothing.
 */
async function runningAsyncJobIds(
  host: RunStateHost,
  sessionId: string,
): Promise<Set<string> | undefined> {
  let rows: unknown[];
  try {
    rows = await host.querySessionItems(sessionId, "runtime.jobs.list", {}, {
      strict: true,
    });
  } catch {
    return undefined;
  }
  let answered = false;
  const running = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const entries = (row as Record<string, unknown>).running;
    if (!Array.isArray(entries)) continue;
    answered = true;
    for (const entry of entries) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const job = entry as Record<string, unknown>;
      // An entry the runtime still carries with a status of its own -- paused, or
      // cancelled and not yet reaped -- is not work in progress. A missing status
      // is not evidence of an end either: the live list itself is the authority.
      if (typeof job.id !== "string") continue;
      if (job.status === undefined || job.status === "running")
        running.add(job.id);
    }
  }
  return answered ? running : undefined;
}

/**
 * Keeps a run-state watcher for exactly the sessions handed in.
 *
 * A watcher is cheap next to a poll -- it reads only when the file changes -- but it
 * is still one file descriptor per session, so the set is bounded to the live rows
 * and pruned as soon as a session leaves them.
 */
export async function syncRunStateWatchers(host: RunStateHost, sessionIds: readonly string[]): Promise<void> {
  if (host.disposed) return;
  const wanted = new Set(sessionIds);
  for (const [sessionId, watcher] of host.runStateWatchers) {
    if (wanted.has(sessionId)) continue;
    watcher.close();
    host.runStateWatchers.delete(sessionId);
    const timer = host.runStateTimers.get(sessionId);
    if (timer) clearTimeout(timer);
    host.runStateTimers.delete(sessionId);
  }
  for (const sessionId of wanted) {
    if (host.runStateWatchers.has(sessionId)) continue;
    // An already-open transcript has its own watcher doing strictly more work, so a
    // second one here would read the same file twice for the same change.
    if (host.sharedSessionWatchers.has(sessionId)) continue;
    // The first scan may have had no transcript yet. Retry resolution on every
    // reconciliation so an unchanged discovery fingerprint does not strand a
    // live session without a watcher.
    const filePath = await host.locateSharedTranscriptFile(sessionId);
    if (!filePath) continue;
    try {
      const fileName = path.basename(filePath);
      const watcher = watch(
        path.dirname(filePath),
        { persistent: false },
        (_event, changedFile) => {
          if (changedFile && changedFile.toString() !== fileName) return;
          const previous = host.runStateTimers.get(sessionId);
          if (previous) clearTimeout(previous);
          host.runStateTimers.set(
            sessionId,
            setTimeout(() => {
              host.runStateTimers.delete(sessionId);
              void republishRunState(host, sessionId);
            }, 150),
          );
        },
      );
      watcher.on("error", () => {
        watcher.close();
        host.runStateWatchers.delete(sessionId);
      });
      host.runStateWatchers.set(sessionId, watcher);
    } catch {
      // Polling still covers the row when the filesystem cannot be watched.
    }
  }
}

/** Re-reads one session's run state and publishes the row if it moved. */
export async function republishRunState(host: RunStateHost, sessionId: string): Promise<void> {
  if (host.disposed) return;
  if (host.activePromptSessions.has(sessionId)) return;
  const generation = host.generation;
  const revision = host.currentRunRevision(sessionId);
  // A session enters liveRunningSessions on gjcRunning:true and only leaves it on a
  // matching gjcRunning:false. A terminal-owned session never sends that close, and
  // a completion report is lost outright across a disconnect, so excluding the whole
  // set here stopped run-state reads for the rest of the process and pinned the row
  // to whatever it was left with.
  //
  // The transcript is still older than the live signal for the gap between a turn
  // starting and its first row reaching disk, so it only overrules that signal once
  // the file has grown past the size recorded when the work was reported -- the same
  // rule readSharedTranscript uses. Without a baseline the transcript wins, matching
  // rememberLiveRunningTranscriptSize's own fallback.
  if (host.liveRunningSessions.has(sessionId)) {
    const seenSize = host.liveRunningDigests.get(sessionId);
    if (seenSize !== undefined) {
      const filePath = await host.locateSharedTranscriptFile(sessionId);
      if (!filePath) return;
      try {
        if (
          (await stat(filePath)).size === seenSize &&
          !host.pendingAsyncWorkSessions.has(sessionId)
        )
          return;
      } catch {
        return;
      }
    }
  }
  const status = await discoveredRunState(host, sessionId);
  if (
    generation !== host.generation ||
    revision !== host.currentRunRevision(sessionId)
  )
    return;
  if (!status) return;
  if (status === "idle") {
    host.liveRunningSessions.delete(sessionId);
    host.liveRunningDigests.delete(sessionId);
    host.liveEvidenceAt.delete(sessionId);
    host.transcriptRunningSessions.delete(sessionId);
    host.workingPhaseSessions.delete(sessionId);
    host.runtimeIdleSessions.delete(sessionId);
  }
  const session = host.sessions.get(sessionId);
  if (!session || session.status === status) return;
  if (session.status === "failed" || session.status === "starting") return;
  host.advanceRunRevision(sessionId);
  session.status = status;
  host.lastDiscovered = host.lastDiscovered.map((row) =>
    row.id === sessionId
      ? { ...row, status, runRevision: session.runRevision }
      : row,
  );
  host.emitEvent({ type: "session.updated", session: { ...session } });
}
