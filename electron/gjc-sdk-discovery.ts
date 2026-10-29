import { rename, stat } from "node:fs/promises";
import { homedir } from "node:os";
import type { AgentSession } from "../shared/agent-contract.js";
import type { SessionMetadataStore } from "./session-metadata-store.js";
import { GjcSdkCli, isSessionUnreachable, type SdkSessionRow } from "./gjc-sdk-cli.js";
import {
  ATTACH_RETRY_INTERVAL_MS,
  historySessionSummary,
  parentSessionOf,
  SessionInfo,
  sessionInfoToAgentSession,
  transcriptHeadLines,
} from "./gjc-sdk-foundation.js";
import {
  discoveredRunState,
  liveEvidenceQuiet,
  settleQuietRunningRow,
  syncRunStateWatchers,
} from "./gjc-sdk-run-state.js";
import { locateSharedTranscriptFile, statsRevision } from "./gjc-sdk-files.js";
import path from "node:path";

/** Agent dir the broker and `getAgentDir()` share (`GJC_CODING_AGENT_DIR` or `~/.gjc/agent`). */
export function codingAgentDir(): string {
  return path.resolve(
    process.env.GJC_CODING_AGENT_DIR ?? path.join(homedir(), ".gjc/agent"),
  );
}

/**
 * Durable broker session index and its compaction snapshot.
 *
 * GJC 0.18.12 writes both under `<agentDir>/sdk/sessions/`
 * (`packages/coding-agent/src/sdk/broker/session-index.ts`: `dirFor`, `logFor`,
 * `snapshotFor`). `Broker` is constructed with that agent dir
 * (`packages/coding-agent/src/commands/sdk.ts`, falling back to `getAgentDir()`).
 * Transcript files stay in `<agentDir>/sessions/`; that tree has no index.
 * An append grows the log, and compaction rename-replaces the snapshot, so a
 * discovery poll has to see both.
 */
export function brokerSessionIndexPath(): string {
  return path.join(codingAgentDir(), "sdk", "sessions", "index.jsonl");
}

export function brokerSessionSnapshotPath(): string {
  return path.join(codingAgentDir(), "sdk", "sessions", "index.snapshot.json");
}

/** The controller members session discovery and the broker index cache read and write. */
export interface DiscoveryHost {
  brokerSessions(options?: {
    scope?: "repo" | "cwd" | "worktree" | "all";
    initialDiscovery?: boolean;
  }): Promise<SdkSessionRow[] | undefined>;
  lastDiscovered: AgentSession[];
  readonly sessionMetadata: SessionMetadataStore | undefined;
  liveRouteReachable(row: SdkSessionRow): Promise<boolean>;
  readonly terminalOnlySessions: Set<string>;
  readonly sessions: Map<string, AgentSession>;
  lastLiveFingerprint: string | undefined;
  readonly workspace: string;
  readonly activePromptSessions: Set<string>;
  readonly liveRunningSessions: Set<string>;
  readonly pendingAsyncWorkSessions: Map<string, string[]>;
  syncRunStateWatchers(sessionIds: readonly string[]): Promise<void>;
  discoveredRunState(
    sessionId: string,
  ): Promise<AgentSession["status"] | undefined>;
  readonly workingPhaseSessions: Set<string>;
  liveEvidenceQuiet(sessionId: string): boolean;
  locateSharedTranscriptFile(
    sessionId: string,
  ): Promise<string | undefined>;
  readonly attachedSessions: Set<string>;
  currentRunRevision(sessionId: string): number;
  settleQuietRunningRow(
    sessionId: string,
    transcriptStatus: AgentSession["status"] | undefined,
    currentSession: AgentSession | undefined,
  ): boolean;
  readonly runtimeIdleSessions: Set<string>;
  readonly locallyAbortedSessions: Set<string>;
  sessionParentId(
    sessionId: string,
  ): Promise<string | undefined>;
  advanceRunRevision(sessionId: string): number;
  readonly sessionCwds: Map<string, string>;
  readonly routeProbes: Map<string, { at: number; reachable: boolean }>;
  requireCli(): Promise<GjcSdkCli>;
  readonly disposed: boolean;
  startupSessionRows: SdkSessionRow[] | undefined;
  cachedBrokerRows: SdkSessionRow[] | undefined;
  cachedBrokerRevision: string | undefined;
  readonly sessionParents: Map<string, string | null>;
}

export async function discoverSessions(host: DiscoveryHost): Promise<AgentSession[]> {
  const liveRanks = new Map<string, number>();
  // Every live GJC session is worth controlling from this window, so discovery
  // follows the broker's own repositories instead of only folders this app has
  // opened. Without it a session started by the CLI elsewhere stayed invisible.
  const liveWorkspaces = new Set<string>();
  const deadSessionIds = new Set<string>();
  // Not cleared here. A rescan re-derives terminal-only from broker liveness,
  // but a session that already failed a control operation is proven
  // uncontrollable by evidence the index does not carry -- discarding that made
  // the row advertise controls that fail again on the next click. Entries are
  // dropped when the session row itself goes away (removeLocalSession).
  const brokerRows = await host.brokerSessions({ initialDiscovery: true });
  // Without the index there is no liveness or placeholder evidence, so the
  // previous result stands rather than republishing every historical session.
  if (!brokerRows)
    return host.lastDiscovered.map((session) => ({ ...session }));
  // The broker index is the full set of session ids that still exist anywhere. A
  // hidden id outside it has nothing left to hide, so it is dropped instead of
  // being carried in the metadata file for the life of the install.
  host.sessionMetadata?.forgetHiddenOutside(
    new Set(brokerRows.map((session) => session.sessionId)),
  );
  const liveRows: SdkSessionRow[] = [];
  for (const session of brokerRows) {
    if (!session.live || session.deleted || host.sessionMetadata?.isHidden(session.sessionId)) {
      // The broker keeps every historical session id. Only live ones can be
      // controlled or replayed from here, so a dead id must not become a row.
      deadSessionIds.add(session.sessionId);
      continue;
    }
    liveRows.push(session);
  }
  // Broker liveness is not a usable route. A live row whose public endpoint is
  // proven stale cannot be controlled or even followed, so it is not listed; its
  // saved history stays reachable from the history picker.
  const reachable = await Promise.all(
    liveRows.map((session) => host.liveRouteReachable(session)),
  );
  liveRows.forEach((session, index) => {
    if (!reachable[index]) {
      deadSessionIds.add(session.sessionId);
      return;
    }
    const attachable = (session.endpointGeneration ?? 0) > 0;
    liveRanks.set(session.sessionId, attachable ? 2 : 1);
    if (attachable && host.terminalOnlySessions.has(session.sessionId)) {
      // A positive probe above is the evidence that clears a recorded route failure.
      host.terminalOnlySessions.delete(session.sessionId);
      const cached = host.sessions.get(session.sessionId);
      if (cached) cached.attachment = "attachable";
      host.lastLiveFingerprint = undefined;
    }
    if (session.repo) liveWorkspaces.add(session.repo);
  });
  // The host's activity report is the live signal while a turn is running and
  // the transcript has not grown yet. Keep the state, not the heartbeat clock:
  // an idle heartbeat must not trigger a rescan every few seconds.
  const brokerActivity = new Map(
    liveRows.map((row) => [row.sessionId, row.activityState ?? ""]),
  );
  const workspaces = [
    ...new Set([
      host.workspace,
      ...(host.sessionMetadata?.listWorkspaces() ?? []),
      ...liveWorkspaces,
    ]),
  ];
  // The broker index only grows, so a scan costs the same whether or not
  // anything changed. When the live session set and its repositories are
  // identical to the previous scan there is nothing new to list, so the
  // per-workspace stage is skipped and the previous result is reused.
  //
  // Session identity alone is not enough to decide that: an agent starting or
  // finishing work changes no id and no repository, so a list whose rows were
  // first seen idle was replayed unchanged for the rest of the session and the
  // transcript was never consulted again. The transcript sizes of the rows this
  // window is not driving are part of what the answer depends on, so they are
  // part of the fingerprint.
  const observedSessionIds = [...liveRanks.keys()].filter(
    (sessionId) =>
      !host.activePromptSessions.has(sessionId) &&
      (!host.liveRunningSessions.has(sessionId) ||
        host.pendingAsyncWorkSessions.has(sessionId)),
  );
  // Polling/fingerprint eligibility intentionally excludes a live signal: its
  // transcript may still be the pre-start snapshot. Watcher eligibility is
  // broader, though. A live signal without a matching idle report still needs
  // the transcript watcher to notice the eventual terminal row.
  const watchedSessionIds = [...liveRanks.keys()].filter(
    (sessionId) => !host.activePromptSessions.has(sessionId),
  );
  // Reconcile watchers before the fingerprint fast path. A session can become
  // watchable after an earlier scan failed to locate its transcript, even when
  // all polling inputs remain unchanged.
  await host.syncRunStateWatchers(watchedSessionIds);
  const runStates = await Promise.all(
    observedSessionIds
      .slice()
      .sort()
      .map(async (sessionId) => [
        sessionId,
        await host.discoveredRunState(sessionId),
      ]),
  );
  // `failed` and `starting` are written by this window rather than derived from
  // the transcript, so neither changes an id, a repository, or a transcript size.
  // Without them here a runtime failure could leave the fingerprint untouched and
  // replay previous rows, hiding the disconnect already recorded by the window.
  const ownStatuses = observedSessionIds
    .slice()
    .sort()
    .map((sessionId) => {
      const status = host.sessions.get(sessionId)?.status;
      return [
        sessionId,
        status === "failed" || status === "starting" ? status : "",
      ];
    })
    .filter(([, status]) => status !== "");
  // A latched session without detached work is left out of `runStates`, so nothing
  // in the fingerprint moves when the only thing that changes about it is that its
  // reports stopped -- the one event that has to re-derive the row. Naming quiet
  // latches makes that scan differ from the previous one; sessions with pending
  // detached work stay observed so each discovery can consult the throttled runtime
  // reconciliation even when all transcript inputs are unchanged.
  const quietLatchedSessionIds = [
    ...new Set([...host.liveRunningSessions, ...host.workingPhaseSessions]),
  ]
    .filter((sessionId) => host.liveEvidenceQuiet(sessionId))
    .sort();
  const liveFingerprint = JSON.stringify([
    [...liveRanks.entries()].sort(),
    [...brokerActivity.entries()].sort(),
    workspaces.slice().sort(),
    runStates,
    ownStatuses,
    quietLatchedSessionIds,
  ]);
  if (
    host.lastDiscovered.length > 0 &&
    liveFingerprint === host.lastLiveFingerprint
  )
    return host.lastDiscovered.map((session) => ({ ...session }));
  host.lastLiveFingerprint = liveFingerprint;
  // Group the broker index by resolved repository once. Scanning every row for
  // every workspace made discovery O(workspaces × sessions) on each scan.
  const rowsByWorkspace = new Map<string, SdkSessionRow[]>();
  for (const row of brokerRows) {
    if (!row.repo || !liveRanks.has(row.sessionId)) continue;
    const repo = path.resolve(row.repo);
    const rows = rowsByWorkspace.get(repo);
    if (rows) rows.push(row);
    else rowsByWorkspace.set(repo, [row]);
  }
  const pages = await Promise.all(
    workspaces.map(async (cwd) => {
      try {
        // Sessions for this workspace come from the broker index, which already
        // carries every session id and repository; the session file supplies the
        // title and last activity.
        const sessions: SessionInfo[] = [];
        for (const row of rowsByWorkspace.get(path.resolve(cwd)) ?? []) {
          const filePath = await host.locateSharedTranscriptFile(
            row.sessionId,
          );
          let title: string | undefined;
          let updatedAt: string | undefined;
          if (filePath) {
            try {
              const summary = historySessionSummary(
                await transcriptHeadLines(filePath),
              );
              title = summary?.title;
              const info = await stat(filePath);
              updatedAt = new Date(info.mtimeMs).toISOString();
            } catch {
              /* an unreadable file still lists as a session */
            }
          }
          sessions.push({
            sessionId: row.sessionId,
            cwd: row.repo,
            ...(title ? { title } : {}),
            ...(updatedAt ? { updatedAt } : {}),
          });
        }
        return sessions;
      } catch (error) {
        if (cwd === host.workspace) throw error;
        return [];
      }
    }),
  );
  const listed = [
    ...new Map(
      pages.flat().map((session) => [session.sessionId, session]),
    ).values(),
  ]
    .filter((session) => !host.sessionMetadata?.isHidden(session.sessionId))
    .filter((session) => !deadSessionIds.has(session.sessionId))
    .sort(
      (left, right) =>
        (liveRanks.get(right.sessionId) ?? 0) -
          (liveRanks.get(left.sessionId) ?? 0) ||
        (Date.parse(right.updatedAt ?? "") || 0) -
          (Date.parse(left.updatedAt ?? "") || 0),
    );

  for (const info of listed) {
    const existing = host.sessions.get(info.sessionId);
    const persistedOwnership = host.sessionMetadata?.getOwnership(
      info.sessionId,
    );
    const ownership =
      persistedOwnership ??
      (existing?.ownership === "gajae"
        ? "gajae"
        : (liveRanks.get(info.sessionId) ?? 0) >= 2
          ? "available"
          : "external");
    const attachment = host.attachedSessions.has(info.sessionId)
      ? ("attached" as const)
      : host.terminalOnlySessions.has(info.sessionId)
        ? ("terminal-only" as const)
        : ("attachable" as const);
    const listedSession = sessionInfoToAgentSession(info);
    // Discovery metadata says nothing about whether the agent is working, and a
    // session this window has never opened has no other source, so it used to
    // default to idle -- work started from a terminal listed as finished. The
    // persisted transcript is the one account that exists for those sessions.
    const statusRevision = host.currentRunRevision(info.sessionId);
    const transcriptStatus = await host.discoveredRunState(info.sessionId);
    const currentSession = host.sessions.get(info.sessionId) ?? existing;
    const brokerActive = brokerActivity.get(info.sessionId) === "active";
    const revisionChanged =
      statusRevision !== host.currentRunRevision(info.sessionId);
    // A row the live latch left running is settled here instead of by the status
    // chain below: that chain preserves a running status for a latched session by
    // design, and the latch has no other consumer once its reports stop. The
    // revision the report advanced is only consumed by a transcript read that
    // agrees it is still current, so a read it deferred never re-derives the row
    // either -- this reconciliation has to stand on its own.
    const quietSettle = !brokerActive && host.settleQuietRunningRow(
      info.sessionId,
      transcriptStatus,
      currentSession,
    );
    const runningStatus =
      currentSession?.status === "failed" ||
      currentSession?.status === "starting"
        ? currentSession.status
        : ("running" as const);
    const runningEvidence =
      host.activePromptSessions.has(info.sessionId) ||
      (host.liveRunningSessions.has(info.sessionId) &&
        !host.liveEvidenceQuiet(info.sessionId)) ||
      (host.workingPhaseSessions.has(info.sessionId) &&
        !host.runtimeIdleSessions.has(info.sessionId) &&
        !host.liveEvidenceQuiet(info.sessionId)) ||
      transcriptStatus === "running";
    const discoveredStatus = quietSettle
      ? "idle"
      : host.locallyAbortedSessions.has(info.sessionId)
        ? "idle"
        : brokerActive
          ? runningStatus
          : revisionChanged && currentSession
            ? currentSession.status
            : runningEvidence
              ? runningStatus
              : currentSession?.status === "failed" ||
                  currentSession?.status === "starting"
                ? currentSession.status
                : (transcriptStatus ?? currentSession?.status ?? "idle");
    // Lineage is not on the broker row this loop is reading, so it comes from the
    // session's own envelope.
    const parentId = await host.sessionParentId(info.sessionId);
    if (
      !revisionChanged &&
      currentSession &&
      currentSession.status !== discoveredStatus
    )
      host.advanceRunRevision(info.sessionId);
    // Session discovery only carries identity/cwd metadata. Replacing the whole row
    // here erased model, thinking, context usage, phase, and status that transcript
    // replay had just restored, so the UI drifted again after every list refresh.
    const session = {
      ...currentSession,
      ...listedSession,
      // Only a turn this window is actually driving keeps the status its own round
      // trip maintains. Being attached is not enough: attachment happens just by
      // opening a session, while the live `session_info_update` that would move the
      // status only arrives for prompts this process sent. A session someone else is
      // driving is attached, silent, and described solely by its transcript.
      //
      // `failed` and `starting` outrank the transcript. Both describe this window's
      // runtime rather than the turn: `failed` is written after a runtime error,
      // and `starting` covers a session whose first round trip has not landed. A
      // transcript that ended cleanly long ago would
      // otherwise report `idle` and erase a disconnect the user has not seen yet.
      status: discoveredStatus,
      runRevision: host.currentRunRevision(info.sessionId),
      phase: currentSession?.phase,
      mode: currentSession?.mode,
      model: currentSession?.model,
      modelDisplay: currentSession?.modelDisplay,
      thinking: currentSession?.thinking,
      usagePercent: currentSession?.usagePercent,
      usagePending: currentSession?.usagePending,
      ownership,
      attachment,
      unread:
        host.sessionMetadata?.getUnread(info.sessionId) ??
        currentSession?.unread ??
        false,
      worktree: host.sessionMetadata?.getWorktree(info.sessionId),
      workLink: host.sessionMetadata?.getWorkLink(info.sessionId),
      parentId: parentId ?? currentSession?.parentId,
    };
    session.title =
      host.sessionMetadata?.getAlias(session.id) ?? session.title;
    host.sessions.set(session.id, session);
    if (info.cwd) host.sessionCwds.set(session.id, info.cwd);
  }

  host.lastDiscovered = listed.map((info) => ({
    ...host.sessions.get(info.sessionId)!,
  }));
  return host.lastDiscovered.map((session) => ({ ...session }));
}

/**
 * Whether a broker-live row still answers the public metadata route.
 *
 * Only a session this window is not already driving needs the probe, and only a
 * row whose route is unproven: a generation-zero host, or one that failed an
 * operation before. Only an unreachable-endpoint error counts as proof; a timeout
 * or any other failure keeps the row listed. Results are cached for one retry
 * interval so a scan does not spawn a CLI per row.
 */
export async function liveRouteReachable(host: DiscoveryHost, row: SdkSessionRow): Promise<boolean> {
  const sessionId = row.sessionId;
  const attachable = (row.endpointGeneration ?? 0) > 0;
  if (
    host.attachedSessions.has(sessionId) ||
    host.activePromptSessions.has(sessionId) ||
    (attachable && !host.terminalOnlySessions.has(sessionId))
  )
    return true;
  const cached = host.routeProbes.get(sessionId);
  if (cached && Date.now() - cached.at < ATTACH_RETRY_INTERVAL_MS) return cached.reachable;
  let reachable = true;
  try {
    const cli = await host.requireCli();
    await cli.queryItems(sessionId, "session.metadata", {}, { repo: row.repo ?? host.workspace });
  } catch (error) {
    if (!isSessionUnreachable(error)) return true;
    reachable = false;
  }
  if (!host.disposed) host.routeProbes.set(sessionId, { at: Date.now(), reachable });
  return reachable;
}

/**
 * The broker's session index, or undefined when it could not be read in full.
 *
 * Liveness classification comes only from this index. An empty result on failure
 * would read as "nothing is dead", which republishes every historical session as
 * a live row, so an incomplete scan is reported as unusable instead.
 *
 * Continuation cursors are drained inside the CLI client: the broker keeps only a
 * small pool of cursors for a limited window, and a walk that stops early strands
 * one for every other caller.
 */
export async function brokerSessions(host: DiscoveryHost, options?: {
  scope?: "repo" | "cwd" | "worktree" | "all";
  initialDiscovery?: boolean;
}): Promise<SdkSessionRow[] | undefined> {
  try {
    const cli = await host.requireCli();
    if (options?.initialDiscovery && host.startupSessionRows !== undefined) {
      const rows = host.startupSessionRows;
      host.startupSessionRows = undefined;
      return rows;
    }
    // Lifecycle reads (delete, fork recovery, create) always ask the broker.
    // Discovery is the 15s poll: an unchanged index file has nothing new to list.
    if (options?.initialDiscovery && (await brokerIndexUnchanged(host)))
      return host.cachedBrokerRows!.map((row) => ({ ...row }));
    const before = options?.initialDiscovery
      ? await brokerIndexRevision()
      : undefined;
    const rows = await cli.listSessions({
      scope: options?.scope ?? "all",
    });
    if (options?.initialDiscovery)
      noteBrokerIndex(host, rows, before, await brokerIndexRevision());
    return rows;
  } catch {
    return undefined;
  }
}

export function invalidateBrokerIndexCache(host: DiscoveryHost): void {
  host.cachedBrokerRows = undefined;
  host.cachedBrokerRevision = undefined;
}

export async function brokerIndexRevision(): Promise<string | undefined> {
  try {
    const log = await stat(brokerSessionIndexPath());
    if (!log.isFile()) return undefined;
    const snapshot = await stat(brokerSessionSnapshotPath()).catch(
      () => undefined,
    );
    const snapshotRevision = snapshot?.isFile()
      ? statsRevision(snapshot)
      : "absent";
    return `${statsRevision(log)}|${snapshotRevision}`;
  } catch {
    return undefined;
  }
}

async function brokerIndexUnchanged(host: DiscoveryHost): Promise<boolean> {
  if (!host.cachedBrokerRevision || !host.cachedBrokerRows) return false;
  return (await brokerIndexRevision()) === host.cachedBrokerRevision;
}

/**
 * Keeps a discovery list only when the index file did not move during the read.
 *
 * A revision that changes mid-scan belongs to a newer index than the rows just
 * returned, so the next poll has to read again instead of treating them as current.
 */
export function noteBrokerIndex(
  host: DiscoveryHost,
  rows: readonly SdkSessionRow[],
  before: string | undefined,
  after: string | undefined,
): void {
  if (before && before === after) {
    host.cachedBrokerRevision = after;
    host.cachedBrokerRows = rows.map((row) => ({ ...row }));
    return;
  }
  invalidateBrokerIndexCache(host);
}

/**
 * The session a row was forked from, read from its transcript envelope.
 *
 * The broker's session list carries identity and liveness only, so lineage comes
 * from the same session file the history scan already reads a bounded head of.
 * A session whose file is not on disk yet answers with the id it already carries,
 * which keeps a fork this window made from losing its link to a slow write.
 */
export async function sessionParentId(
  host: DiscoveryHost,
  sessionId: string,
): Promise<string | undefined> {
  const cached = host.sessionParents.get(sessionId);
  if (cached !== undefined) return cached ?? undefined;
  try {
    const filePath = await host.locateSharedTranscriptFile(sessionId);
    if (!filePath) return host.sessions.get(sessionId)?.parentId;
    const id = parentSessionOf(
      (await transcriptHeadLines(filePath))[0],
      sessionId,
    );
    host.sessionParents.set(sessionId, id ?? null);
    return id;
  } catch {
    // An unreadable transcript is not evidence of a root: keep whatever the row
    // already reports rather than erasing a link we had.
    return host.sessions.get(sessionId)?.parentId;
  }
}
