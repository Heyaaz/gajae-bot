import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { type FSWatcher, type Stats, watch } from "node:fs";
import type { AgentEvent, AgentSession, NoticeActivity, PlanActivity, QuestionActivity, ToolActivity, TranscriptChange, TranscriptItem, TranscriptPage, TranscriptPageRequest } from "../shared/agent-contract.js";
import { transcriptDelivery } from "../shared/transcript-item-equal.js";
import { selectTranscriptPage, transcriptSyncWindow } from "../shared/transcript-page.js";
import { ImageDataUrlCache } from "./image-data-cache.js";
import {
  cloneTranscriptItem,
  compactionRecordCount,
  composeTranscriptRows,
  durableTurnEnded,
  durableTwinOf,
  isLiveOnlyRow,
  lastReportedModel,
  lifecycleUncertainError,
  LIVE_TOOL_STATUSES,
  missingSessionError,
  persistedModelState,
  persistedTurnState,
  precedingSharedRow,
  readableModelLabel,
  sameTranscriptItem,
  sharedTranscriptItems,
  TodoSnapshotState,
  TRANSCRIPT_RESCAN_WINDOW,
} from "./gjc-sdk-foundation.js";
import { ensureAttached, refreshTranscriptAttachment, scheduleDetach } from "./gjc-sdk-attach.js";
import { removeLocalSession } from "./gjc-sdk-lifecycle.js";
import {
  reconciledAsyncJobIds,
  recordPendingAsyncWork,
  republishRunState,
  transcriptStartedNewWork,
} from "./gjc-sdk-run-state.js";
import { locateSharedTranscriptFile, readTranscriptEnvelopes, statsRevision } from "./gjc-sdk-files.js";
import { patchSessionRuntime, refreshContextUsage } from "./gjc-sdk-session-config.js";
import { projectTranscriptItemForDelivery } from "./transcript-body-preview.js";
import path from "node:path";

/** The controller members transcript reads, installs and sync publication touch. */
export interface TranscriptStoreHost {
  readonly activePromptSessions: Set<string>;
  readPersistedTranscript(
    sessionId: string,
  ): Promise<TranscriptItem[] | undefined>;
  installTranscript(
    sessionId: string,
    items: TranscriptItem[],
  ): TranscriptItem[];
  readonly terminalOnlySessions: Set<string>;
  readSharedTranscript(
    sessionId: string,
  ): Promise<TranscriptItem[]>;
  refreshTranscriptAttachment(sessionId: string): void;
  terminalOnlyNotice(sessionId: string): NoticeActivity;
  ensureAttached(
    sessionId: string,
    replay: boolean,
  ): Promise<void>;
  readonly sessions: Map<string, AgentSession>;
  readonly emitEvent: (event: AgentEvent) => void;
  lifecycleUncertainNotice(sessionId: string): NoticeActivity;
  removeLocalSession(sessionId: string, hide: boolean): void;
  readonly transcripts: Map<string, TranscriptItem[]>;
  getTranscript(sessionId: string): Promise<TranscriptItem[]>;
  readonly desktopTranscriptBaselines: Map<string, TranscriptItem[]>;
  readonly toolRowIndices: Map<string, Map<string, number>>;
  readonly dirtyTranscriptRows: Map<string, Set<string>>;
  currentRunRevision(sessionId: string): number;
  readonly transcriptEpoch: Map<string, number>;
  locateSharedTranscriptFile(
    sessionId: string,
  ): Promise<string | undefined>;
  querySessionItems(
    sessionId: string,
    query: string,
    input?: Record<string, unknown>,
    options?: { strict?: boolean },
  ): Promise<unknown[]>;
  readonly generation: number;
  watchSharedTranscript(sessionId: string, filePath: string): void;
  readTranscriptEnvelopes(
    filePath: string,
    info: Stats,
  ): Promise<Record<string, unknown>[]>;
  readonly compactionRecordWatermark: Map<string, number>;
  reconciledAsyncJobIds(
    sessionId: string,
    jobIds: readonly string[],
  ): Promise<string[]>;
  readonly asyncJobReconciliations: Map<string, { checkedAt: number; deadJobIds: Set<string>; checkedJobIds: Set<string>; querySucceeded: boolean; }>;
  readonly workingPhaseSessions: Set<string>;
  readonly compactionRecordBaseline: Map<string, number>;
  readonly compactingSessions: Set<string>;
  readonly compactionStartedAt: Map<string, number>;
  readonly runtimeIdleSessions: Set<string>;
  readonly liveRunningDigests: Map<string, number>;
  readonly liveRunningSessions: Set<string>;
  readonly liveEvidenceAt: Map<string, number>;
  readonly transcriptRunningSessions: Set<string>;
  readonly discoveredRunStates: Map<string, { size: number; status: AgentSession["status"]; runningJobIds?: string[] }>;
  patchSessionRuntime(
    sessionId: string,
    patch: Partial<
      Pick<
        AgentSession,
        | "phase"
        | "status"
        | "mode"
        | "model"
        | "modelDisplay"
        | "thinking"
        | "serviceTier"
        | "usagePercent"
        | "usagePending"
      >
    >,
  ): void;
  recordPendingAsyncWork(
    sessionId: string,
    jobIds: readonly string[],
  ): void;
  transcriptStartedNewWork(
    sessionId: string,
    size: number,
    transcriptRunning: boolean,
  ): boolean;
  updateSessionStatus(
    sessionId: string,
    status: AgentSession["status"],
    options?: { announce?: boolean },
  ): void;
  readonly locallyAbortedSessions: Set<string>;
  readonly sharedSessionFiles: Map<string, string>;
  readonly sharedSessionWatchers: Map<string, FSWatcher>;
  readonly disposed: boolean;
  readonly sharedSessionRefreshTimers: Map<string, ReturnType<typeof setTimeout>>;
  publishTranscriptSync(
    sessionId: string,
    previous: TranscriptItem[] | undefined,
    items: TranscriptItem[],
  ): void;
  refreshContextUsage(
    sessionId: string,
    options?: { force?: boolean },
  ): Promise<void>;
  republishRunState(sessionId: string): Promise<void>;
  readonly toolSnapshots: Map<string, Map<string, ToolActivity>>;
  readonly imageDataUrls: ImageDataUrlCache;
  readonly sessionPlans: Map<string, PlanActivity>;
  readonly sessionTodoSnapshots: Map<string, TodoSnapshotState>;
  readonly activeAssistantMessages: Map<string, string>;
  readonly activeThoughts: Map<string, string>;
  readonly sessionQuestions: Map<string, Map<string, QuestionActivity>>;
  watchedTranscripts: Set<string> | undefined;
  readonly detachTimers: Map<string, ReturnType<typeof setTimeout>>;
  readonly attachedSessions: Set<string>;
  scheduleDetach(sessionId: string): void;
}

export async function getTranscript(host: TranscriptStoreHost, sessionId: string): Promise<TranscriptItem[]> {
  // A prompt owned by this window still writes its durable transcript. Reading
  // only the memory cache here made the safety net certify stale rows with the
  // file's new revision after a watcher notification was missed. Keep the live
  // rows through installTranscript, but actually read the file on this path too.
  if (host.activePromptSessions.has(sessionId)) {
    const persisted = await host.readPersistedTranscript(sessionId);
    if (persisted)
      return host.installTranscript(sessionId, persisted).map(cloneTranscriptItem);
  }
  const externallyDriven = !host.activePromptSessions.has(sessionId);
  if (host.terminalOnlySessions.has(sessionId) || externallyDriven) {
    try {
      const shared = await host.readSharedTranscript(sessionId);
      if (shared.length > 0) {
        const installed = host.installTranscript(sessionId, shared);
        // Local history is readable before the runtime finishes inspecting its
        // endpoint, profiles and settings. Hydrate those independently.
        host.refreshTranscriptAttachment(sessionId);
        return installed.map(cloneTranscriptItem);
      }
      if (host.terminalOnlySessions.has(sessionId))
        return [host.terminalOnlyNotice(sessionId)];
    } catch {
      if (host.terminalOnlySessions.has(sessionId))
        return [host.terminalOnlyNotice(sessionId)];
    }
  }
  try {
    await host.ensureAttached(sessionId, true);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      /no current Router attachment|provider_lease_conflict/iu.test(message)
    ) {
      host.terminalOnlySessions.add(sessionId);
      const session = host.sessions.get(sessionId);
      if (session) {
        session.attachment = "terminal-only";
        session.ownership = "external";
        host.emitEvent({ type: "session.updated", session: { ...session } });
      }
      return [host.terminalOnlyNotice(sessionId)];
    }
    if (lifecycleUncertainError(error)) {
      const session = host.sessions.get(sessionId);
      if (session) {
        session.attachment = "recovering";
        session.status = "failed";
        host.emitEvent({ type: "session.updated", session: { ...session } });
      }
      return [host.lifecycleUncertainNotice(sessionId)];
    }
    if (!missingSessionError(error)) throw error;
    host.removeLocalSession(sessionId, true);
    return [];
  }
  // Model profiles are loaded when the session is attached. Reading them again
  // here made every safety-net body fetch spawn `models.profiles.list`.
  return (host.transcripts.get(sessionId) ?? []).map(cloneTranscriptItem);
}

export async function getTranscriptPage(
  host: TranscriptStoreHost,
  sessionId: string,
  request?: TranscriptPageRequest,
): Promise<TranscriptPage> {
  const page = selectTranscriptPage(await host.getTranscript(sessionId), request);
  return {
    ...page,
    items: page.items.map(projectTranscriptItemForDelivery),
  };
}

/** Safety-net read using the session's bounded desktop snapshot as its baseline. */
export async function getTranscriptChanges(host: TranscriptStoreHost, sessionId: string): Promise<TranscriptChange> {
  const items = await host.getTranscript(sessionId);
  const previous = host.desktopTranscriptBaselines.get(sessionId);
  const next = transcriptSyncWindow(items, previous).map(
    projectTranscriptItemForDelivery,
  );
  const change = transcriptDelivery(previous, next);
  if (host.sessions.has(sessionId))
    host.desktopTranscriptBaselines.set(sessionId, next);
  else host.desktopTranscriptBaselines.delete(sessionId);
  return change;
}

export function reindexToolRows(
  host: TranscriptStoreHost,
  sessionId: string,
  items: readonly TranscriptItem[],
): void {
  const indices = new Map<string, number>();
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]!;
    if (item.kind === "tool") indices.set(item.id, index);
  }
  host.toolRowIndices.set(sessionId, indices);
}

export function markTranscriptRowDirty(host: TranscriptStoreHost, sessionId: string, rowId: string): void {
  let rows = host.dirtyTranscriptRows.get(sessionId);
  if (!rows) host.dirtyTranscriptRows.set(sessionId, (rows = new Set()));
  rows.add(rowId);
}

export function invalidateDesktopTranscript(host: TranscriptStoreHost, sessionId: string): void {
  host.dirtyTranscriptRows.delete(sessionId);
  host.desktopTranscriptBaselines.delete(sessionId);
  host.emitEvent({ type: "transcript.invalidated", sessionId });
}

/**
 * Revision of the transcript the safety net compares.
 *
 * The file half is a stat: inode, size, nanosecond mtime, and ctime. The tail
 * is this process's run generation and transcript epoch, so an in-memory plan,
 * todo, or streamed row changes the revision before the file does. A stat alone
 * pinned the old body to a new mtime when the sample happened after the read,
 * and it missed memory that had moved on while the file had not. ctime is what
 * catches an in-place rewrite that restores both size and mtime.
 */
export async function getTranscriptRevision(host: TranscriptStoreHost, sessionId: string): Promise<string | undefined> {
  const memory = `${host.currentRunRevision(sessionId)}:${host.transcriptEpoch.get(sessionId) ?? 0}`;
  const filePath = await host.locateSharedTranscriptFile(sessionId);
  if (!filePath) return `mem:${memory}`;
  try {
    const info = await stat(filePath);
    if (!info.isFile()) return `mem:${memory}`;
    return `${statsRevision(info)}:${memory}`;
  } catch {
    return `mem:${memory}`;
  }
}

/** Marks an in-memory transcript change the durable file has not caught up to. */
export function noteTranscriptEpoch(host: TranscriptStoreHost, sessionId: string): void {
  host.transcriptEpoch.set(
    sessionId,
    (host.transcriptEpoch.get(sessionId) ?? 0) + 1,
  );
}

export async function readSharedTranscript(
  host: TranscriptStoreHost,
  sessionId: string,
): Promise<TranscriptItem[]> {
  const persisted = await host.readPersistedTranscript(sessionId);
  if (persisted) return persisted;
  // No session file yet: ask the session for its retained transcript instead. The
  // file is the durable account and wins whenever it exists.
  const rows = await host.querySessionItems(
    sessionId,
    "transcript.list",
    {},
    { strict: true },
  );
  return sharedTranscriptItems(sessionId, rows);
}

export async function readPersistedTranscript(
  host: TranscriptStoreHost,
  sessionId: string,
): Promise<TranscriptItem[] | undefined> {
  const generation = host.generation;
  const revision = host.currentRunRevision(sessionId);
  const filePath = await host.locateSharedTranscriptFile(sessionId);
  if (!filePath) return undefined;
  host.watchSharedTranscript(sessionId, filePath);
  try {
    const info = await stat(filePath);
    if (!info.isFile() || info.size > 64 * 1024 * 1024) return undefined;
    const envelopes = await host.readTranscriptEnvelopes(filePath, info);
    const rows = envelopes.flatMap((envelope) => {
      if (
        envelope.type === "compaction" ||
        envelope.type === "branch_summary" ||
        envelope.type === "custom_message"
      ) {
        return [
          {
            ...envelope,
            ts:
              typeof envelope.timestamp === "string"
                ? envelope.timestamp
                : envelope.ts,
          },
        ];
      }
      if (
        envelope.type !== "message" ||
        !envelope.message ||
        typeof envelope.message !== "object" ||
        Array.isArray(envelope.message)
      )
        return [];
      const message = envelope.message as Record<string, unknown>;
      return [
        {
          ...message,
          id: typeof envelope.id === "string" ? envelope.id : message.id,
          ts:
            typeof envelope.timestamp === "string"
              ? envelope.timestamp
              : message.timestamp,
        },
      ];
    });
    const compactionTimestamps = envelopes
      .filter((envelope) => envelope.type === "compaction")
      .map((envelope) =>
        typeof envelope.timestamp === "string"
          ? Date.parse(envelope.timestamp)
          : typeof envelope.ts === "string"
            ? Date.parse(envelope.ts)
            : NaN,
      )
      .filter((timestamp) => Number.isFinite(timestamp));
    const latestCompactionTimestamp =
      compactionTimestamps.length > 0
        ? Math.max(...compactionTimestamps)
        : undefined;
    if (
      latestCompactionTimestamp !== undefined &&
      generation === host.generation &&
      host.sessions.has(sessionId)
    ) {
      // This is a monotonic fact from the durable transcript, not a verdict about
      // the active run revision. Record it before any await so an older live phase
      // arriving from live events cannot overtake the file completion receipt.
      const previous = host.compactionRecordWatermark.get(sessionId);
      if (
        previous === undefined ||
        latestCompactionTimestamp > previous
      )
        host.compactionRecordWatermark.set(
          sessionId,
          latestCompactionTimestamp,
        );
    }
    const persistedTurn = persistedTurnState(envelopes);
    // A full read is the only read that sees every launch row and every release row,
    // so it is where a session's detached work is settled: a job paused, cancelled,
    // or taken down with its process writes no release row, and its launch marker
    // would otherwise stay in the file forever. The bounded run-state read may never
    // meet the rows that name those markers, so nothing else asks about them.
    const pendingAsyncJobIds = await host.reconciledAsyncJobIds(
      sessionId,
      persistedTurn.pendingAsyncJobIds,
    );
    // A marker a reconciliation retired is not work again just because this read met
    // the same rows, and a marker it kept is still work however settled the rows here
    // look -- only the runtime can say that job ended.
    const jobsQuerySucceeded =
      host.asyncJobReconciliations.get(sessionId)?.querySucceeded === true;
    const unverifiedPendingMarkers =
      persistedTurn.pendingAsyncWorkOnly &&
      pendingAsyncJobIds.length > 0 &&
      !jobsQuerySucceeded;
    const pendingAsyncUnknown =
      unverifiedPendingMarkers &&
      !host.activePromptSessions.has(sessionId) &&
      !host.workingPhaseSessions.has(sessionId);
    const transcriptRunning = persistedTurn.pendingAsyncWorkOnly
      ? jobsQuerySucceeded && pendingAsyncJobIds.length > 0
      : persistedTurn.running;
    // A new compaction record is the durable completion receipt for the requested
    // cycle. It outranks a live `compacting` phase because that phase can remain
    // stuck in the in-memory marker when no separate idle update is delivered.
    // A stale launch marker the runtime has already retired is not a live turn, and
    // an older compaction record is not a receipt for the cycle that just started.
    // An unanswered job list is not a receipt either: compaction stays up until the
    // background work can be checked.
    const baseline = host.compactionRecordBaseline.get(sessionId);
    const compactionCompleted =
      host.compactingSessions.has(sessionId) &&
      baseline !== undefined &&
      compactionRecordCount(envelopes) > baseline &&
      (host.compactionStartedAt.get(sessionId) === undefined ||
        (latestCompactionTimestamp !== undefined &&
          latestCompactionTimestamp >
            host.compactionStartedAt.get(sessionId)!)) &&
      !transcriptRunning &&
      !unverifiedPendingMarkers;
    const turnRunning =
      transcriptRunning ||
      host.activePromptSessions.has(sessionId) ||
      (host.workingPhaseSessions.has(sessionId) &&
        !host.runtimeIdleSessions.has(sessionId) &&
        !compactionCompleted);
    // A transcript that has not changed since the live signal reported work is the
    // same snapshot that signal already superseded, so it carries no news. Once the
    // file grows and still reports no active turn, it has observed the work end and
    // becomes the newer account. A terminal-owned session never sends
    // gjcRunning:false, so this is sufficient evidence for that kind of session. A
    // cycle that did emit a working phase also needs runtime idle before it settles.
    const seenSize = host.liveRunningDigests.get(sessionId);
    const transcriptAdvanced =
      seenSize !== undefined && info.size !== seenSize;
    const items = sharedTranscriptItems(sessionId, rows, { turnRunning });
    await resolveToolImages(host, items);
    const lifecycleCurrent =
      generation === host.generation &&
      revision === host.currentRunRevision(sessionId);
    if (lifecycleCurrent) {
      if (compactionCompleted) {
        host.compactingSessions.delete(sessionId);
        host.compactionRecordBaseline.delete(sessionId);
        host.compactionStartedAt.delete(sessionId);
        host.liveRunningSessions.delete(sessionId);
        host.liveRunningDigests.delete(sessionId);
        host.liveEvidenceAt.delete(sessionId);
        host.transcriptRunningSessions.delete(sessionId);
        host.discoveredRunStates.delete(sessionId);
        host.workingPhaseSessions.delete(sessionId);
        host.runtimeIdleSessions.delete(sessionId);
        host.patchSessionRuntime(sessionId, { phase: undefined });
      }
      // This read saw every row, so its account of what the session still owes
      // replaces the latch rather than merging with it: a marker these rows no
      // longer name has been released, and a bounded read must not resurrect it.
      host.recordPendingAsyncWork(sessionId, pendingAsyncJobIds);
    }
    const effectiveModel = persistedModelState(envelopes);
    if (
      effectiveModel.model ||
      effectiveModel.thinking ||
      Object.hasOwn(effectiveModel, "serviceTier")
    ) {
      host.patchSessionRuntime(sessionId, effectiveModel);
    }
    // A terminal-owned session gets no live phase report, so the transcript is the
    // only place its finished compaction is recorded.
    // `compactionCompleted` was handled before computing turnRunning so the
    // completion receipt can settle status in this same transcript read.
    // Read before any branch below so every read of an idle row records the size
    // it settled at, whichever branch then runs.
    const startedNewWork =
      lifecycleCurrent &&
      host.transcriptStartedNewWork(sessionId, info.size, transcriptRunning);
    if (lifecycleCurrent && !host.activePromptSessions.has(sessionId)) {
      const status = turnRunning
          ? "running"
          : pendingAsyncUnknown
            ? "unknown"
            : "idle";
      const current = host.sessions.get(sessionId)?.status;
      if (status === "unknown") {
        if (current !== "unknown") host.updateSessionStatus(sessionId, "unknown");
      } else if (status === "idle") {
        // The transcript is written after the fact, so it reads idle for the gap
        // between a turn starting and its first row reaching disk. That snapshot is
        // older than the live signal and must not overrule it.
        //
        // A transcript that records the turn's own stop reason is different: it is
        // evidence the turn ended, not evidence it never started. A terminal-owned
        // session never receives gjcRunning:false, so refusing this too left the row
        // running for the rest of the session.
        // The terminal row predates a newly accepted compaction. Only a new
        // compaction record or a live non-compacting phase can release it.
        if (
          (!host.compactingSessions.has(sessionId) || compactionCompleted) &&
          (transcriptAdvanced || !host.liveRunningSessions.has(sessionId))
        ) {
          host.liveRunningSessions.delete(sessionId);
          host.liveRunningDigests.delete(sessionId);
          host.liveEvidenceAt.delete(sessionId);
          host.transcriptRunningSessions.delete(sessionId);
          host.discoveredRunStates.delete(sessionId);
          // The transcript has observed the work end, which outranks the last phase
          // GJC reported: leaving the marker set would keep rejecting every later
          // idle report and strand the row at 진행 중.
          host.workingPhaseSessions.delete(sessionId);
          host.runtimeIdleSessions.delete(sessionId);
          host.updateSessionStatus(sessionId, "idle");
        }
      } else if (
        current !== "idle" &&
        !host.locallyAbortedSessions.has(sessionId)
      ) {
        host.updateSessionStatus(sessionId, status);
      } else if (startedNewWork) {
        host.updateSessionStatus(sessionId, "running");
      }
    } else if (startedNewWork) {
      // A prompt this window sent owns the row's status, but only for work it can
      // see. A turn that started while it waits -- a steer, or work typed into the
      // terminal -- reports no live start under gjc/0.18.12, so nothing else lifts
      // a row settled idle before it: the progress row then followed each tool
      // card in and out, reading 완료 between them for the whole turn.
      host.updateSessionStatus(sessionId, "running");
    }
    // A session owned by a terminal never attaches here, so its own transcript is the
    // only place that states which model it is actually running.
    const model = lastReportedModel(rows);
    if (model && host.sessions.get(sessionId)?.modelDisplay !== model) {
      host.patchSessionRuntime(sessionId, {
        modelDisplay: readableModelLabel(model),
      });
    }
    return items;
  } catch {
    host.sharedSessionFiles.delete(sessionId);
    return undefined;
  }
}

export function watchSharedTranscript(host: TranscriptStoreHost, sessionId: string, filePath: string): void {
  if (host.sharedSessionWatchers.has(sessionId) || host.disposed) return;
  try {
    const fileName = path.basename(filePath);
    const watcher = watch(
      path.dirname(filePath),
      { persistent: false },
      (_event, changedFile) => {
        if (changedFile && changedFile.toString() !== fileName) return;
        const previous = host.sharedSessionRefreshTimers.get(sessionId);
        if (previous) clearTimeout(previous);
        host.sharedSessionRefreshTimers.set(
          sessionId,
          setTimeout(() => {
            host.sharedSessionRefreshTimers.delete(sessionId);
            if (host.disposed) return;
            // A detach closes this watcher; a callback already queued must not
            // resurrect the transcript it just released.
            if (host.sharedSessionWatchers.get(sessionId) !== watcher) return;
            const previousItems = host.transcripts.get(sessionId);
            void host.readPersistedTranscript(sessionId).then((items) => {
              if (!items || host.disposed) return;
              const installed = host.installTranscript(sessionId, items);
              host.publishTranscriptSync(sessionId, previousItems, installed);
              // External terminal sessions do not publish usage events to this
              // renderer. Re-query after transcript changes so the first response
              // following compaction replaces the pending usage indicator immediately.
              void host.refreshContextUsage(sessionId);
              // A terminal-only row outside discovery has no run-state watcher of
              // its own, and the transcript read above never promotes idle to
              // running. Without this its status stays where it was opened.
              if (host.terminalOnlySessions.has(sessionId))
                void host.republishRunState(sessionId);
            });
          }, 25),
        );
      },
    );
    watcher.on("error", () => {
      watcher.close();
      host.sharedSessionWatchers.delete(sessionId);
    });
    host.sharedSessionWatchers.set(sessionId, watcher);
  } catch {
    // Initial transcript loading still works when the filesystem cannot be watched.
  }
}

/**
 * Publish a transcript rescan as the items that actually changed.
 *
 * Ordinary changes go out as individual rows. When a rescan cannot be expressed
 * as appended or changed rows, invalidate the renderer's bounded snapshot so it
 * can reload a fresh page instead of shipping the full history over IPC.
 */
export function publishTranscriptSync(
  host: TranscriptStoreHost,
  sessionId: string,
  previous: TranscriptItem[] | undefined,
  items: TranscriptItem[],
): void {
  const invalidate = (): void => invalidateDesktopTranscript(host, sessionId);

  // No prior history, or a shorter one because compaction rewrote it.
  if (!previous || previous.length > items.length) {
    invalidate();
    return;
  }
  const dirtyRows = host.dirtyTranscriptRows.get(sessionId);
  const snapshots = host.toolSnapshots.get(sessionId);

  // A row can also disappear without the history getting shorter: a live row the
  // rebuild recorded under its own id, or one the ended turn never recorded. An
  // appended event cannot take a row away, so a history that dropped one must
  // invalidate the renderer's snapshot and let it reload a bounded page.
  const present = new Set(items.map((item) => item.id));
  if (previous.some((item) => !present.has(item.id))) {
    invalidate();
    return;
  }

  // Rows already published can still change -- a tool call gains its result, a
  // streamed message settles -- and parallel calls settle out of order, so an
  // unchanged row after a changed one proves nothing. The scan checks every row
  // in the bounded window and collects each difference instead of stopping at
  // the first row that happens to still match.
  const shared = Math.min(previous.length, items.length);
  const windowStart = Math.max(0, shared - TRANSCRIPT_RESCAN_WINDOW);
  const changedIndices: number[] = [];
  // The durable transcript is append-only. A row can still change in place when
  // a tool result lands on an old call row, so an id-only tail check missed
  // parallel completions (#97). Compare a bounded recent window plus rows that
  // live edits marked dirty or that still have a live tool snapshot; every
  // other row is immutable once written. Identity changes cannot be expressed
  // as appended items, so they still invalidate the whole view.
  for (let index = 0; index < shared; index += 1) {
    const before = previous[index];
    const after = items[index];
    if (!before || !after) break;
    if (before.id !== after.id) {
      invalidate();
      return;
    }
    if (index < windowStart) {
      const mayChange =
        dirtyRows?.has(before.id) === true ||
        snapshots?.has(before.id) === true ||
        (before.kind === "tool" && LIVE_TOOL_STATUSES.has(before.status));
      if (!mayChange) continue;
    }
    if (!sameTranscriptItem(before, after)) changedIndices.push(index);
  }
  // Additions after the shared prefix are always new rows.
  for (let index = shared; index < items.length; index += 1)
    changedIndices.push(index);
  if (changedIndices.length === 0) {
    host.dirtyTranscriptRows.delete(sessionId);
    return;
  }
  // For many changed rows, invalidation avoids a burst of events.
  if (changedIndices.length > 16) {
    invalidate();
    return;
  }
  changedIndices.sort((left, right) => left - right);
  for (const index of changedIndices) {
    host.emitEvent({
      type: "transcript.appended",
      item: cloneTranscriptItem(items[index]!),
    });
  }
  host.dirtyTranscriptRows.delete(sessionId);
}

/** Inline the GJC blob store bytes so a read image renders in the transcript. */
export async function resolveToolImages(host: TranscriptStoreHost, items: TranscriptItem[]): Promise<void> {
  const blobDirectory = path.join(
    path.resolve(
      process.env.GJC_CODING_AGENT_DIR ?? path.join(homedir(), ".gjc/agent"),
    ),
    "blobs",
  );
  await Promise.all(
    items.map(async (item) => {
      if (item.kind !== "tool" || !item.images) return;
      item.images = (
        await Promise.all(
          item.images.map(async (image) => {
            if (image.dataUrl || !image.blobId) return image;
              const cached = host.imageDataUrls.get(image.blobId);
              if (cached) return { mimeType: image.mimeType, dataUrl: cached };
            try {
              const file = path.join(blobDirectory, image.blobId);
              const info = await stat(file);
              if (!info.isFile() || info.size > 12 * 1024 * 1024)
                return undefined;
              const dataUrl = `data:${image.mimeType};base64,${(await readFile(file)).toString("base64")}`;
              host.imageDataUrls.set(image.blobId, dataUrl);
              return { mimeType: image.mimeType, dataUrl };
            } catch {
              return undefined;
            }
          }),
        )
      ).filter(
        (image): image is NonNullable<typeof image> => image !== undefined,
      );
      if (item.images.length === 0) delete item.images;
    }),
  );
}

/**
 * Install a transcript read as this session's account, keeping what only this
 * process observed.
 *
 * A durable read is authoritative over recorded rows, but it cannot speak for a
 * live plan, for a todo snapshot this window queried, or for a row the live wire
 * produced while the file that records it was still behind: a streamed reply, a
 * reasoning block, or a tool card whose call has not been written yet. Replacing
 * the transcript wholesale deleted those rows, and the sync that followed carried
 * a shorter history -- which the renderer reads as a rewrite -- so a streamed
 * block vanished until the turn that produced it finished and the file caught up.
 *
 * A retained row goes back to the position it held, is retired rather than
 * duplicated the moment the read accounts for its block, and is dropped when the
 * read shows the turn it belongs to ended without recording it.
 */
export function installTranscript(
  host: TranscriptStoreHost,
  sessionId: string,
  items: TranscriptItem[],
): TranscriptItem[] {
  const snapshots = host.toolSnapshots.get(sessionId);
  if (snapshots) {
    items = items.map((item) => {
      const snapshot = snapshots.get(item.id);
      if (item.kind !== "tool" || !snapshot) return item;
      if (
        !LIVE_TOOL_STATUSES.has(item.status) &&
        !(item.status === "cancelled" && !item.output)
      ) {
        snapshots.delete(item.id);
        return item;
      }
      return { ...item, ...snapshot };
    });
    for (const snapshot of snapshots.values()) {
      if (!items.some((item) => item.id === snapshot.id))
        items.push({ ...snapshot });
    }
  }
  const previous = host.transcripts.get(sessionId) ?? [];
  const ids = new Set(items.map((item) => item.id));
  // App-owned views the durable read never carries: the plan the runtime reported
  // and the todo snapshot this window queried.
  const appOwned = [
    host.sessionPlans.get(sessionId),
    host.sessionTodoSnapshots.get(sessionId)?.row,
  ];
  const retained: Array<{
    row: TranscriptItem;
    afterId: string | undefined;
  }> = [];
  for (let index = 0; index < previous.length; index += 1) {
    const row = previous[index]!;
    const isAppOwned =
      row.kind === "question" ||
      (row.kind === "notice" &&
        (row.id.startsWith("gjc-cancelled-") || row.id.startsWith("gjc-error-"))) ||
      appOwned.some(
        (view) => view !== undefined && view.id === row.id,
      );
    if (isAppOwned) {
      if (!ids.has(row.id))
        retained.push({
          row,
          afterId: precedingSharedRow(previous, index, ids)?.id,
        });
      continue;
    }
    const pendingUserEcho = row.kind === "message" && row.role === "user" && row.id.startsWith("local-prompt-");
    if (!isLiveOnlyRow(row) && !pendingUserEcho) continue;
    const twin = durableTwinOf(items, row);
    if (twin) {
      // The block this row streamed is now recorded under the read's own id, so
      // the deltas still addressed to the id the wire invented are handed to the
      // row that holds it. Without that they would find no row to append to and
      // the rest of the block would be dropped.
      if (host.activeAssistantMessages.get(sessionId) === row.id)
        host.activeAssistantMessages.set(sessionId, twin.id);
      if (host.activeThoughts.get(sessionId) === row.id)
        host.activeThoughts.set(sessionId, twin.id);
      continue;
    }
    const anchor = precedingSharedRow(previous, index, ids);
    if (!pendingUserEcho && durableTurnEnded(items, anchor)) continue;
    retained.push({ row, afterId: anchor?.id });
  }
  const composed = composeTranscriptRows(items, retained);
  for (const question of host.sessionQuestions.get(sessionId)?.values() ?? []) {
    if (!composed.some((item) => item.id === question.id))
      composed.push(cloneTranscriptItem(question));
  }
  if (host.terminalOnlySessions.has(sessionId) && !composed.some((item) => item.id === `terminal-only-${sessionId}`))
    composed.push(host.terminalOnlyNotice(sessionId));
  host.transcripts.set(sessionId, composed);
  reindexToolRows(host, sessionId, composed);
  return composed;
}

export async function refreshTranscriptFromFile(host: TranscriptStoreHost, sessionId: string): Promise<void> {
  const previous = host.transcripts.get(sessionId);
  const items = await host.readPersistedTranscript(sessionId).catch(
    () => undefined,
  );
  if (!items || host.disposed) return;
  const installed = host.installTranscript(sessionId, items);
  host.publishTranscriptSync(sessionId, previous, installed);
}

/**
 * Notes the transcript size at the moment live work was reported. A read failure
 * leaves no baseline, which makes the next transcript snapshot authoritative --
 * the safe direction, since the alternative is a row stuck on running.
 */
export async function rememberLiveRunningTranscriptSize(
  host: TranscriptStoreHost,
  sessionId: string,
): Promise<void> {
  try {
    const filePath = await host.locateSharedTranscriptFile(sessionId);
    if (!filePath) return;
    const info = await stat(filePath);
    if (host.liveRunningSessions.has(sessionId))
      host.liveRunningDigests.set(sessionId, info.size);
  } catch {
    // No baseline recorded: the transcript wins next time.
  }
}

/** Counts compactions already recorded on disk, or reports an unavailable baseline. */
export async function persistedCompactionCount(
  host: TranscriptStoreHost,
  sessionId: string,
): Promise<number | undefined> {
  try {
    const filePath = await host.locateSharedTranscriptFile(sessionId);
    if (!filePath) return undefined;
    const info = await stat(filePath);
    return compactionRecordCount(
      await host.readTranscriptEnvelopes(filePath, info),
    );
  } catch {
    // Zero means the transcript was read and contained no compactions. Treating
    // an I/O failure as zero lets any historical record falsely finish new work.
    return undefined;
  }
}

/**
 * The transcripts the renderer currently holds.
 *
 * Opening a session attaches it and starts a tail reader and a tool observer.
 * The renderer keeps only three transcripts, so sessions outside this set are
 * released after a grace period instead of keeping those processes for the rest
 * of the app's lifetime. A running turn is always retained.
 */
export function watchTranscripts(host: TranscriptStoreHost, sessionIds: readonly string[]): void {
  const next = new Set(
    sessionIds.filter((sessionId): sessionId is string =>
      typeof sessionId === "string" && sessionId.length > 0,
    ),
  );
  host.watchedTranscripts = next;
  for (const [sessionId, timer] of host.detachTimers) {
    if (!next.has(sessionId)) continue;
    clearTimeout(timer);
    host.detachTimers.delete(sessionId);
  }
  for (const sessionId of host.attachedSessions) {
    if (next.has(sessionId)) continue;
    host.scheduleDetach(sessionId);
  }
}
