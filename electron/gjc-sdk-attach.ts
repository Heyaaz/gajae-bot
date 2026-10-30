import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import type { FSWatcher } from "node:fs";
import type { AgentCommand, AgentControlPreferences, AgentEvent, AgentSession, HistorySession, TranscriptItem } from "../shared/agent-contract.js";
import type { SessionMetadataStore } from "./session-metadata-store.js";
import { GjcSdkCli, isSessionUnreachable, SdkCliError, type SdkSessionRow } from "./gjc-sdk-cli.js";
import {
  ATTACH_RETRY_INTERVAL_MS,
  GJC_ACCENT,
  historySessionSummary,
  lifecycleUncertainError,
  parentSessionOf,
  readableSessionTitle,
  recentLabel,
  sessionCwdFromLines,
  transcriptHeadLines,
  UNWATCHED_DETACH_GRACE_MS,
} from "./gjc-sdk-foundation.js";
import path from "node:path";

/** The controller members history open, resume and attach/detach read and write. */
export interface AttachHost {
  brokerSessions(options?: {
    scope?: "repo" | "cwd" | "worktree" | "all";
    initialDiscovery?: boolean;
    reuseUnchangedIndex?: boolean;
  }): Promise<SdkSessionRow[] | undefined>;
  readonly historySummaryCache: Map<string, { mtimeMs: number; size: number; summary: NonNullable<ReturnType<typeof historySessionSummary>>; parentId?: string; }>;
  readonly sessions: Map<string, AgentSession>;
  locateSharedTranscriptFile(
    sessionId: string,
  ): Promise<string | undefined>;
  readonly workspace: string;
  readonly sessionMetadata: SessionMetadataStore | undefined;
  readonly sessionCwds: Map<string, string>;
  readonly emitEvent: (event: AgentEvent) => void;
  readonly generation: number;
  resumeSession(sessionId: string): Promise<AgentSession>;
  readPersistedTranscript(
    sessionId: string,
  ): Promise<TranscriptItem[] | undefined>;
  readonly disposed: boolean;
  markTerminalOnly(sessionId: string): void;
  installTranscript(
    sessionId: string,
    items: TranscriptItem[],
  ): TranscriptItem[];
  discoveredRunState(
    sessionId: string,
  ): Promise<AgentSession["status"] | undefined>;
  advanceRunRevision(sessionId: string): number;
  invalidateDesktopTranscript(sessionId: string): void;
  readonly terminalOnlySessions: Set<string>;
  stopTailFollower(sessionId: string): void;
  readonly attachedSessions: Set<string>;
  readonly attachAttempts: Map<string, number>;
  ensureAttached(
    sessionId: string,
    replay: boolean,
  ): Promise<void>;
  refreshSessionSettings(sessionId: string): Promise<void>;
  startTailFollower(sessionId: string): void;
  requireCli(): Promise<GjcSdkCli>;
  repoFor(sessionId: string): string;
  readonly messageKeys: Map<string, Map<string, string>>;
  readonly modelPreset: AgentControlPreferences["modelPreset"];
  readonly windowHostedSessions: Set<string>;
  readonly sharedSessionFiles: Map<string, string>;
  applyPermissionMode(sessionId: string): Promise<void>;
  refreshSdkCommands(
    sessionId: string,
    advertised?: AgentCommand[],
  ): Promise<void>;
  refreshSessionConfigOptions(sessionId: string): Promise<void>;
  readSharedTranscript(
    sessionId: string,
  ): Promise<TranscriptItem[]>;
  finalizeAllMessages(sessionId: string): void;
  readonly watchedTranscripts: Set<string> | undefined;
  watchSharedTranscript(sessionId: string, filePath: string): void;
  refreshContextUsage(
    sessionId: string,
    options?: { force?: boolean },
  ): Promise<void>;
  readonly detachTimers: Map<string, ReturnType<typeof setTimeout>>;
  readonly activePromptSessions: Set<string>;
  readonly workingPhaseSessions: Set<string>;
  readonly sharedSessionWatchers: Map<string, FSWatcher>;
  readonly sharedSessionRefreshTimers: Map<string, ReturnType<typeof setTimeout>>;
  readonly transcripts: Map<string, TranscriptItem[]>;
  readonly toolRowIndices: Map<string, Map<string, number>>;
  readonly dirtyTranscriptRows: Map<string, Set<string>>;
  readonly desktopTranscriptBaselines: Map<string, TranscriptItem[]>;
  readonly activeAssistantMessages: Map<string, string>;
  readonly activeThoughts: Map<string, string>;
  readonly sessionSdkOperations: Map<string, Set<string>>;
  readonly contextUsageObservedAt: Map<string, number>;
  readonly transcriptAttachments: Map<string, Promise<void>>;
  readonly cli: GjcSdkCli | undefined;
  recovery: Promise<void> | undefined;
}

/**
 * Past sessions on disk, newest first.
 *
 * Discovery only lists sessions the broker still reports as live, so everything
 * else is unreachable from the window even though `gjc --resume <id>` opens it
 * fine. The session files are the authority on what exists.
 */
export async function listHistorySessions(host: AttachHost): Promise<HistorySession[]> {
  const agentDirectory = path.resolve(
    process.env.GJC_CODING_AGENT_DIR ?? path.join(homedir(), ".gjc/agent"),
  );
  const sessionsDirectory = path.join(agentDirectory, "sessions");
  // Liveness is decoration here; the files still list fine without it.
  const liveIds = new Set(
    ((await host.brokerSessions()) ?? [])
      .filter((session) => session.live)
      .map((session) => session.sessionId),
  );
  const files: Array<{
    path: string;
    id: string;
    modified: number;
    size: number;
  }> = [];
  try {
    for (const bucket of await readdir(sessionsDirectory, {
      withFileTypes: true,
    })) {
      if (!bucket.isDirectory()) continue;
      const directory = path.join(sessionsDirectory, bucket.name);
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
        const id = entry.name.slice(0, -".jsonl".length).split("_").at(-1);
        if (!id) continue;
        const filePath = path.join(directory, entry.name);
        try {
          const info = await stat(filePath);
          // A huge transcript is still listed, but its summary is read from a
          // bounded head rather than the whole file.
          files.push({
            path: filePath,
            id,
            modified: info.mtimeMs,
            size: info.size,
          });
        } catch {
          /* the file went away between listing and reading */
        }
      }
    }
  } catch {
    return [];
  }
  files.sort((left, right) => right.modified - left.modified);
  // Every saved session is reachable. The head reads are bounded per file and run
  // with a small worker pool, so a large history costs latency proportional to the
  // files but does not open thousands of descriptors at once.
  const sessions: Array<HistorySession | undefined> = new Array(files.length);
  let next = 0;
  const read = async (): Promise<void> => {
    while (true) {
      const index = next;
      next += 1;
      const file = files[index];
      if (!file) return;
      try {
        const cached = host.historySummaryCache.get(file.path);
        let summary = cached?.summary;
        let parentId = cached?.parentId;
        if (!cached || cached.mtimeMs !== file.modified || cached.size !== file.size) {
          const headLines = await transcriptHeadLines(file.path);
          summary = historySessionSummary(headLines);
          if (!summary) {
            host.historySummaryCache.delete(file.path);
            continue;
          }
          parentId = parentSessionOf(headLines[0], file.id);
          host.historySummaryCache.set(file.path, {
            mtimeMs: file.modified,
            size: file.size,
            summary,
            ...(parentId ? { parentId } : {}),
          });
        }
        if (!summary) continue;
        const workspace = summary.cwd ?? "";
        sessions[index] = {
          id: file.id,
          title: summary.title ?? readableSessionTitle(file.id, undefined),
          workspace,
          updatedAt: recentLabel(new Date(file.modified).toISOString()),
          messageCount: summary.messageCount,
          live: liveIds.has(file.id),
          // The same envelope line the summary already reads, so a fork is marked
          // by having been read rather than by a second pass over the file.
          parentId,
        };
      } catch {
        /* the file went away or is not a readable transcript */
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(8, files.length) }, read),
  );
  const present = new Set(files.map((file) => file.path));
  for (const filePath of host.historySummaryCache.keys()) {
    if (!present.has(filePath)) host.historySummaryCache.delete(filePath);
  }
  return sessions.filter(
    (session): session is HistorySession => session !== undefined,
  );
}

/**
 * Open saved history and try to restore control independently. An unreachable
 * runtime must not make a readable transcript fail to open.
 */
export async function openHistorySession(host: AttachHost, sessionId: string): Promise<AgentSession> {
  if (host.sessions.has(sessionId)) return openHistoryWithControl(host, sessionId);
  const filePath = await host.locateSharedTranscriptFile(sessionId);
  if (!filePath)
    throw new Error(`세션 기록을 찾지 못했습니다: ${sessionId}`);
  let cwd: string | undefined;
  try {
    // The envelope is in the head. The body is read later, when the transcript
    // itself is opened, so picking a session does not load the whole JSONL.
    cwd = sessionCwdFromLines(await transcriptHeadLines(filePath));
  } catch {
    /* the workspace falls back below */
  }
  const workspace = cwd ?? host.workspace;
  const session: AgentSession = {
    id: sessionId,
    title: readableSessionTitle(sessionId, undefined),
    subtitle: path.basename(workspace) || workspace,
    workspace,
    runtime: "gjc",
    status: "idle",
    updatedAt: "now",
    updatedAtMs: Date.now(),
    pinned: false,
    unread: false,
    accent: GJC_ACCENT,
    ownership: host.sessionMetadata?.getOwnership(sessionId) ?? "external",
    attachment: "recovering",
  };
  host.sessions.set(sessionId, session);
  host.sessionCwds.set(sessionId, workspace);
  host.sessionMetadata?.setWorkspace(sessionId, workspace);
  host.emitEvent({ type: "session.created", session: { ...session } });
  return openHistoryWithControl(host, sessionId);
}

async function openHistoryWithControl(host: AttachHost, sessionId: string): Promise<AgentSession> {
  const generation = host.generation;
  try {
    return await host.resumeSession(sessionId);
  } catch (error) {
    if (!isSessionUnreachable(error)) throw error;
    // Only a real persisted read authorizes history-only opening. Never
    // fabricate an empty conversation or re-host a live CLI after this refusal.
    const items = await host.readPersistedTranscript(sessionId);
    if (items === undefined) throw error;
    if (host.disposed || generation !== host.generation || !host.sessions.has(sessionId))
      throw new Error("GJC session history opening was cancelled");
    host.markTerminalOnly(sessionId);
    host.installTranscript(sessionId, items);
    // The row is not discovered, so nothing else describes its run state. The
    // transcript is the only account of a CLI that is still working, and the
    // freshly opened row must not claim it finished.
    const status = await host.discoveredRunState(sessionId);
    const opened = host.sessions.get(sessionId);
    if (
      opened &&
      status &&
      opened.status !== status &&
      opened.status !== "failed" &&
      opened.status !== "starting"
    ) {
      host.advanceRunRevision(sessionId);
      opened.status = status;
      host.emitEvent({ type: "session.updated", session: { ...opened } });
    }
    host.invalidateDesktopTranscript(sessionId);
    return { ...host.sessions.get(sessionId)! };
  }
}

/**
 * Re-attach a session this window lost control of.
 *
 * A session goes `terminal-only` when a terminal held the lease, and
 * `recovering` when a reconnect could not resume it. Both states are dead ends
 * in the window: the transcript is readable but nothing can be sent. Attaching
 * again is the only recovery, and it has to be user-driven because the lease
 * may still be held -- retrying on a timer would just fail repeatedly.
 */
export async function resumeSession(host: AttachHost, sessionId: string): Promise<AgentSession> {
  const session = host.sessions.get(sessionId);
  if (!session) throw new Error(`Unknown GJC session: ${sessionId}`);
  // The refusal that produced terminal-only is not permanent, so the flag is
  // cleared before retrying or ensureAttached would be skipped entirely.
  host.terminalOnlySessions.delete(sessionId);
  host.stopTailFollower(sessionId);
  host.attachedSessions.delete(sessionId);
  host.attachAttempts.delete(sessionId);
  try {
    await host.ensureAttached(sessionId, true);
    await host.refreshSessionSettings(sessionId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/no current Router attachment|provider_lease_conflict/iu.test(message)) {
      host.terminalOnlySessions.add(sessionId);
      session.attachment = "terminal-only";
      session.ownership = "external";
      host.emitEvent({ type: "session.updated", session: { ...session } });
      throw new Error(
        "다른 터미널이 이 세션을 잡고 있어 이어서 진행할 수 없습니다. 해당 GJC를 종료한 뒤 다시 시도하세요.",
      );
    }
    // A lifecycle receipt is evidence that the attach was recorded, not whether
    // it happened. The transcript is read from the session file either way, so
    // an unverifiable receipt leaves the session readable instead of failing
    // the resume outright -- it only means live control is not guaranteed.
    if (!lifecycleUncertainError(error)) throw error;
    host.attachedSessions.delete(sessionId);
    session.attachment = "recovering";
    host.emitEvent({ type: "session.updated", session: { ...session } });
  }
  const resumed = host.sessions.get(sessionId);
  if (!resumed) throw new Error(`Unknown GJC session: ${sessionId}`);
  // The renderer reloads a bounded page after this invalidation, rather than
  // receiving the entire transcript over IPC.
  host.invalidateDesktopTranscript(sessionId);
  return { ...resumed };
}

/**
 * Makes a session controllable from this window.
 *
 * An SDK session that is already live needs no attach: the broker routes control
 * to its host and this window is just another client. Only a session with no live
 * endpoint is resumed, which is what re-hosts it. `replay` reloads the transcript
 * from the session file rather than asking a connection to stream it back.
 */
export async function ensureAttached(
  host: AttachHost,
  sessionId: string,
  replay: boolean,
): Promise<void> {
  if (host.attachedSessions.has(sessionId)) {
    // Attachment and the tail reader are separate lives. A reader that died on
    // a transient broker error left the session attached, so every later use
    // took this early return and the follower was never restarted.
    host.startTailFollower(sessionId);
    return;
  }
  const cli = await host.requireCli();
  const generation = host.generation;
  const wasListed = host.sessions.has(sessionId);
  const requireCurrentAttachment = (): void => {
    if (host.disposed || generation !== host.generation || (wasListed && !host.sessions.has(sessionId)))
      throw new Error("GJC session attachment was cancelled");
  };
  requireCurrentAttachment();
  const cwd = host.repoFor(sessionId);
  if (replay) {
    host.installTranscript(sessionId, []);
    host.messageKeys.set(sessionId, new Map());
  }
  const row = await cli.inspectSession(sessionId, { repo: cwd });
  requireCurrentAttachment();
  if (row?.deleted)
    throw new SdkCliError(
      "session_deleted",
      `Session ${sessionId} was deleted.`,
    );
  // A live terminal host can serve several clients. Probe its public route;
  // generation zero is not proof of an exclusive terminal lease.
  if (row?.live === true)
    await cli.queryItems(sessionId, "session.metadata", {}, { repo: cwd });
  let rehosted = false;
  if (!row?.live) {
    // Resume re-hosts a session whose endpoint is gone. `sessionPath` is passed
    // when known so the host adopts this exact transcript rather than resolving a
    // same-id file elsewhere.
    const sessionPath = await host.locateSharedTranscriptFile(sessionId);
    requireCurrentAttachment();
    await cli.rawGlobal(
      "session.resume",
      {
        sessionId,
        cwd,
        ...(sessionPath ? { sessionPath } : {}),
        modelPreset: host.modelPreset,
      },
      { repo: cwd },
    );
    rehosted = true;
    host.windowHostedSessions.add(sessionId);
    // The re-host writes a new timestamped session file. Drop the path this window
    // cached, or the next lifecycle call (delete especially) hands GJC the previous
    // generation's file and the operation comes back with an unknown outcome.
    host.sharedSessionFiles.delete(sessionId);
  }
  // Only a session this window hosts may have its permission handling applied.
  // A session already live in another host belongs to that host, and rewriting its
  // policy changes how *that* agent runs tools: the desktop smoke attached to a
  // live session to read its model profiles, set the app's fail-closed `deny`, and
  // left the session rejecting every tool call afterwards. Reading a session is not
  // authority over it.
  const owned = rehosted || host.sessions.get(sessionId)?.ownership === "gajae";
  requireCurrentAttachment();
  if (owned) await host.applyPermissionMode(sessionId);
  // Command discovery is independent of the config surface and is what the
  // palette needs first. Start it alongside the config reads instead of after
  // them: each CLI query costs a process, and the old order made a fresh
  // session spend seconds on model profiles before skills could appear.
  void host.refreshSdkCommands(sessionId);
  await host.refreshSessionConfigOptions(sessionId);
  requireCurrentAttachment();
  if (replay) {
    const restored = await host.readSharedTranscript(sessionId).catch(() => []);
    if (restored.length > 0) host.installTranscript(sessionId, restored);
    host.finalizeAllMessages(sessionId);
  }
  host.attachedSessions.add(sessionId);
  host.terminalOnlySessions.delete(sessionId);
  host.startTailFollower(sessionId);
  if (
    host.watchedTranscripts !== undefined &&
    !host.watchedTranscripts.has(sessionId)
  )
    scheduleDetach(host, sessionId);
  // The session file is the live account now that no connection streams updates.
  const watched = await host.locateSharedTranscriptFile(sessionId);
  if (watched) host.watchSharedTranscript(sessionId, watched);
  const session = host.sessions.get(sessionId);
  if (session) {
    if (rehosted) {
      session.ownership = "gajae";
      host.sessionMetadata?.setOwnership(sessionId, "gajae");
    }
    session.attachment = "attached";
    // A successful attach clears the failure this window recorded, but it does not
    // observe the turn. Opening a session someone else is driving must not report
    // that work as finished, so the transcript answers and `idle` is the fallback.
    if (session.status === "failed")
      session.status = (await host.discoveredRunState(sessionId)) ?? "idle";
    host.emitEvent({ type: "session.updated", session: { ...session } });
  }
  void host.refreshContextUsage(sessionId, { force: true });
}

export function scheduleDetach(host: AttachHost, sessionId: string): void {
  if (
    host.disposed ||
    host.detachTimers.has(sessionId) ||
    host.watchedTranscripts?.has(sessionId)
  )
    return;
  const timer = setTimeout(() => {
    host.detachTimers.delete(sessionId);
    if (host.disposed || host.watchedTranscripts?.has(sessionId)) return;
    if (!host.attachedSessions.has(sessionId)) return;
    const session = host.sessions.get(sessionId);
    if (
      host.activePromptSessions.has(sessionId) ||
      host.workingPhaseSessions.has(sessionId) ||
      session?.status === "running"
    ) {
      scheduleDetach(host, sessionId);
      return;
    }
    detachSession(host, sessionId);
  }, UNWATCHED_DETACH_GRACE_MS);
  timer.unref?.();
  host.detachTimers.set(sessionId, timer);
}

function detachSession(host: AttachHost, sessionId: string): void {
  if (!host.attachedSessions.has(sessionId)) return;
  const session = host.sessions.get(sessionId);
  if (
    host.activePromptSessions.has(sessionId) ||
    host.workingPhaseSessions.has(sessionId) ||
    session?.status === "running"
  )
    return;
  host.stopTailFollower(sessionId);
  host.attachedSessions.delete(sessionId);
  const watcher = host.sharedSessionWatchers.get(sessionId);
  watcher?.close();
  host.sharedSessionWatchers.delete(sessionId);
  const refreshTimer = host.sharedSessionRefreshTimers.get(sessionId);
  if (refreshTimer) clearTimeout(refreshTimer);
  host.sharedSessionRefreshTimers.delete(sessionId);
  host.transcripts.delete(sessionId);
  host.toolRowIndices.delete(sessionId);
  host.dirtyTranscriptRows.delete(sessionId);
  host.desktopTranscriptBaselines.delete(sessionId);
  host.messageKeys.delete(sessionId);
  host.activeAssistantMessages.delete(sessionId);
  host.activeThoughts.delete(sessionId);
  host.sessionSdkOperations.delete(sessionId);
  host.contextUsageObservedAt.delete(sessionId);
  if (session) {
    session.attachment = "attachable";
    host.emitEvent({ type: "session.updated", session: { ...session } });
  }
}

export function refreshTranscriptAttachment(host: AttachHost, sessionId: string): void {
  if (
    !host.disposed &&
    host.sessions.get(sessionId)?.attachment === "attachable" &&
    !host.terminalOnlySessions.has(sessionId) &&
    !host.attachedSessions.has(sessionId) &&
    !host.transcriptAttachments.has(sessionId)
  ) {
    const lastAttempt = host.attachAttempts.get(sessionId) ?? 0;
    if (Date.now() - lastAttempt > ATTACH_RETRY_INTERVAL_MS) {
      host.attachAttempts.set(sessionId, Date.now());
      const generation = host.generation;
      const refresh = (async () => {
        try {
          await host.ensureAttached(sessionId, false);
          if (!host.disposed && generation === host.generation && host.sessions.has(sessionId))
            await host.refreshSessionSettings(sessionId);
        } catch {
          // Readable history does not establish runtime control. Required control
          // operations still report their own attachment errors.
        }
      })().finally(() => {
        if (host.transcriptAttachments.get(sessionId) === refresh)
          host.transcriptAttachments.delete(sessionId);
      });
      host.transcriptAttachments.set(sessionId, refresh);
    }
  }
}

/**
 * Re-attaches owned sessions after a reconnect.
 *
 * Called from both the startup microtask and the reconnect retry, so concurrent
 * calls share one pass. Idle sessions the renderer is not showing are left for
 * their next selection: reattaching every recorded session at once started a
 * tail reader, a tool observer, and several config/command queries per session
 * before the first screen was interactive.
 */
export function recoverOwnedSessions(host: AttachHost): Promise<void> {
  if (!host.cli) return Promise.resolve();
  if (host.recovery) return host.recovery;
  const pass = recoverOwnedSessionsOnce(host).finally(() => {
    if (host.recovery === pass) host.recovery = undefined;
  });
  host.recovery = pass;
  return pass;
}

async function recoverOwnedSessionsOnce(host: AttachHost): Promise<void> {
  const watched = host.watchedTranscripts;
  const candidates = [...host.sessions.values()]
    .filter((session) => {
      if (
        session.ownership !== "gajae" ||
        host.attachedSessions.has(session.id) ||
        !host.sessionCwds.get(session.id)
      )
        return false;
      if (!watched) return true;
      return (
        watched.has(session.id) ||
        session.status === "running" ||
        host.activePromptSessions.has(session.id) ||
        host.workingPhaseSessions.has(session.id)
      );
    })
    .sort(
      (left, right) =>
        Number(right.status === "running") -
        Number(left.status === "running"),
    );
  let next = 0;
  const recoverOne = async (): Promise<void> => {
    while (true) {
      const session = candidates[next];
      next += 1;
      if (!session) return;
      try {
        await host.ensureAttached(session.id, false);
        session.attachment = "attached";
        // Re-attaching says this window can talk to the session again, not that its
        // turn ended. Another process may have kept working through the disconnect,
        // so the transcript decides; `idle` is only the answer when it has none.
        session.status = (await host.discoveredRunState(session.id)) ?? "idle";
        session.unread = true;
        host.sessionMetadata?.setUnread(session.id, true);
        host.emitEvent({ type: "session.updated", session: { ...session } });
        host.emitEvent({
          type: "session.activity",
          sessionId: session.id,
          title: session.title,
          unread: true,
          category: "recovered",
        });
      } catch {
        session.attachment = "recovering";
        session.status = "failed";
        host.emitEvent({ type: "session.updated", session: { ...session } });
      }
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(2, candidates.length) },
      () => recoverOne(),
    ),
  );
}
