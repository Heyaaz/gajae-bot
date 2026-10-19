import {
  access,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { execFile as execFileCb } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { constants, realpathSync, watch, type FSWatcher, type Stats } from "node:fs";
import type {
  AgentEvent,
  AgentSession,
  AgentControlPreferences,
  AgentCommand,
  AgentConfigOption,
  AgentConfigOptionValue,
  BackendConnection,
  ChatMessage,
  CreateSessionInput,
  MessageDelivery,
  NoticeActivity,
  PlanActivity,
  ToolActivity,
  ToolDecision,
  ThoughtActivity,
  TranscriptItem,
  ArtifactContent,
  DiffSnapshot,
  EffectiveRuntimeState,
  GeneratedFilePreview,
  GitStatusSnapshot,
  GoalOperation,
  GoalSnapshot,
  HistorySession,
  QueuedMessage,
  SubagentSnapshot,
  SystemNoticeActivity,
} from "../shared/agent-contract.js";
import { DEFAULT_MODEL_PRESET } from "../shared/agent-contract.js";
import type { SessionMetadataStore } from "./session-metadata-store.js";
import { gjcPathCandidates, runtimeEnvironment } from "./runtime-path.js";
import {
  GjcSdkCli,
  SdkCliError,
  brokerExec,
  freshOperationRef,
  isLifecycleUncertain,
  isSessionMissing,
  isSessionUnreachable,
  type SdkSessionRow,
} from "./gjc-sdk-cli.js";


/**
 * Transcript and event shapes.
 *
 * Gajae reads these updates from the session's own file under
 * `~/.gjc/agent/sessions/` and from `gjc sdk session tail` frames, so the shapes
 * are declared here instead of imported from a protocol package. The field names
 * match what GJC persists, which is what both sources carry.
 */

import {
  ABANDONED_STOP_REASONS,
  ATTACH_RETRY_INTERVAL_MS,
  AvailableCommand,
  CLOCK_LABEL,
  ContentBlock,
  EFFORT_LEVELS,
  GJC_ACCENT,
  GjcControllerOptions,
  HISTORY_SUMMARY_HEAD_BYTES,
  LIFECYCLE_RECOVERY_ATTEMPTS,
  LIFECYCLE_RECOVERY_CLOCK_SLACK_MS,
  LIFECYCLE_RECOVERY_INTERVAL_MS,
  LIVE_EVIDENCE_GRACE_MS,
  LIVE_MESSAGE_PREFIXES,
  LIVE_THOUGHT_PREFIX,
  LIVE_TOOL_STATUSES,
  MAX_TOOL_TEXT,
  OWNED_STOP_UNAVAILABLE_MESSAGE,
  OwnedStopUnavailableError,
  PENDING_ASYNC_RECONCILE_INTERVAL_MS,
  PROMPT_SETTLE_ATTEMPTS,
  PROMPT_SETTLE_INTERVAL_MS,
  PendingPermission,
  PersistedTurnState,
  PlanEntry,
  RUN_STATE_TAIL_BYTES,
  ResolvedMessageInput,
  SDK_FAST_SERVICE_TIERS,
  SDK_RELOAD_COMPONENTS,
  SDK_SCOPED_FAST_SERVICE_TIERS,
  SDK_SERVICE_TIER_OFF,
  SDK_SLASH_COMMAND_SPECS,
  SHARED_ROUTE_UNAVAILABLE_MESSAGE,
  STARTUP_TIMEOUT_MS,
  SdkSlashCommandSpec,
  SendMessageOptions,
  SessionConfigOption,
  SessionInfo,
  SessionNotification,
  SessionUpdate,
  TAIL_RETRY_BASE_MS,
  TAIL_RETRY_MAX_MS,
  TAIL_WINDOW_MS,
  TERMINAL_STOP_REASONS,
  TRANSCRIPT_RESCAN_WINDOW,
  TodoSnapshotState,
  ToolCallFields,
  ToolCallStatus,
  agentCommands,
  agentConfigOptions,
  artifactReferences,
  attachedPathsText,
  boundedJson,
  brokerFailureMessage,
  busyPromptError,
  cancelledOperationError,
  canonicalWorkspace,
  cloneTranscriptItem,
  compactionRecordCount,
  comparableRowText,
  composeTranscriptRows,
  configOptionValues,
  configuredProfileDefaultThinking,
  customMessageTitle,
  destructiveSlashAction,
  destructiveSlashMessage,
  durableTurnEnded,
  durableTwinOf,
  execFile,
  gitBranchFromHeader,
  hasLivePrefix,
  historySessionSummary,
  imageFromContent,
  inferToolName,
  isLiveOnlyRow,
  lastReportedModel,
  lifecycleInputRefused,
  lifecycleLegacyHistoryAmbiguous,
  lifecycleUncertainError,
  liveSessionDeleteError,
  markUpdated,
  messageTextWithFiles,
  missingLifecycleSessionError,
  missingSessionError,
  normalizeQueuedRequestText,
  nowLabel,
  parentSessionOf,
  persistedModelState,
  persistedTranscriptRunning,
  persistedTurnState,
  precedingSharedRow,
  profileDefaultModelLabel,
  readTranscriptTail,
  readableModelLabel,
  readableSessionTitle,
  receiptSubagentStatus,
  recentLabel,
  redactSensitiveText,
  safeGitPath,
  sameTranscriptItem,
  sanitizeLocalAttachmentBlocks,
  sdkSlashCommandsForOperations,
  sessionInfoToAgentSession,
  sharedContentText,
  sharedTranscriptItems,
  skillsDisabledByConfig,
  tailReadPause,
  tailRetryPause,
  taskStatus,
  taskSubagents,
  textFromContent,
  thinkingOptionsForModelCatalog,
  timestampMs,
  todoQueryErrorText,
  todoSnapshotPhases,
  todoSnapshotRowId,
  todoSnapshotTask,
  toolDiffText,
  toolImageRefs,
  toolResultText,
  toolStatus,
  transcriptHeadLines,
  transcriptTime,
  uncertainAfterSendError,
  uncertainLifecycleOutcomeError,
} from "./gjc-sdk-foundation.js";

import { previewGeneratedFile } from "./gjc-sdk-file-preview.js";

export * from "./gjc-sdk-foundation.js";

/** Fallback todo read when the session has no live todo event channel. */
export const TODO_EVENT_POLL_BASE_MS = 30_000;
export const TODO_EVENT_POLL_MAX_MS = 120_000;
/** Command palette refresh after a failed read, doubled until the cap. */
export const COMMAND_REFRESH_RETRY_BASE_MS = 1_000;
export const COMMAND_REFRESH_RETRY_MAX_MS = 30_000;

/**
 * Durable broker session index.
 *
 * `gjc sdk session list` projects this file. Its device, inode, size, and
 * mtime are the revision a discovery poll compares so an unchanged index does
 * not spawn another list process.
 */
function brokerSessionIndexPath(): string {
  return path.join(
    path.resolve(
      process.env.GJC_CODING_AGENT_DIR ?? path.join(homedir(), ".gjc/agent"),
    ),
    "sessions",
    "index.jsonl",
  );
}

function commandPublicationKey(commands: readonly AgentCommand[]): string {
  return commands
    .map(
      (command) =>
        `${command.name}\0${command.description}\0${command.hint ?? ""}`,
    )
    .join("\n");
}

export class GjcSdkController {
  private workspace: string;
  private configuredExecutable?: string;
  private modelPreset: AgentControlPreferences["modelPreset"];
  private modelPresetThinking?: string;
  private permissionHandling: AgentControlPreferences["permissionHandling"];
  private readonly sessionMetadata?: SessionMetadataStore;
  private readonly emitEvent: (event: AgentEvent) => void;
  private readonly artifactDirectory: string;
  private readonly sessions = new Map<string, AgentSession>();
  private readonly sessionCwds = new Map<string, string>();
  private readonly attachedSessions = new Set<string>();
  private readonly transcripts = new Map<string, TranscriptItem[]>();
  private readonly messageKeys = new Map<string, Map<string, string>>();
  private readonly activeAssistantMessages = new Map<string, string>();
  private readonly activeThoughts = new Map<string, string>();
  private readonly activePromptSessions = new Set<string>();
  private readonly activePromptAdmissions = new Map<string, symbol>();
  private readonly cancellationWatermarks = new Map<string, number>();
  private readonly cancellingSessions = new Set<string>();
  private readonly cancellationPromises = new Map<string, Promise<void>>();
  private readonly flushingSessions = new Set<string>();
  private readonly pendingSteers = new Map<string, Promise<void>>();
  private readonly suppressedUserMessageKeys = new Map<string, Set<string>>();
  // A prompt renders its own user bubble immediately so an ordinary chat message
  // appears without waiting for the agent round trip. GJC echoes the same prompt
  // back as a user update, so the first echo of each text is dropped.
  private readonly echoedPromptTexts = new Map<string, string[]>();
  private readonly locallyAbortedSessions = new Set<string>();
  /** Compaction is finished only when GJC says so, never when the request returns. */
  private readonly compactingSessions = new Set<string>();
  // How many compaction records the transcript held when compaction started. A
  // terminal-owned session never receives session_info_update, so the live signal
  // cannot release the phase for it; a new record appearing is the evidence that
  // GJC finished. Without this the indicator stayed up for the rest of the session.
  private readonly compactionRecordBaseline = new Map<string, number>();
  // Latest durable compaction record timestamp observed for each session. Live
  // phase updates at or before this watermark are delayed stale delivery.
  private readonly compactionRecordWatermark = new Map<string, number>();
  // Timestamped compacting phases start a distinct cycle. A durable record older
  // than this boundary belongs to the preceding cycle and cannot finish this one.
  private readonly compactionStartedAt = new Map<string, number>();
  // Sessions live SDK evidence currently reports as working. The persisted
  // transcript lags behind that signal, so it is not allowed to report one of
  // these idle until GJC itself says the turn ended.
  private readonly liveRunningSessions = new Set<string>();
  // Transcript size at the moment the live signal reported work, keyed by session.
  // Anything at that size is the snapshot the signal already superseded; a larger
  // file is a newer account.
  private readonly liveRunningDigests = new Map<string, number>();
  // When the newest live work signal for a session was accepted, keyed by session.
  // Every latch below is armed by a report and released by a report, so a session
  // whose reports stop has nothing left to age it out -- one held a finished row in
  // the working group for 16 hours. This is that clock: in-memory, one number per
  // session that ever reported work, consulted only when a transcript verdict
  // already disagrees with the row.
  private readonly liveEvidenceAt = new Map<string, number>();
  /**
   * Sessions whose running state was read out of their transcript.
   *
   * Attaching to a session makes GJC publish a bootstrap `gjcRunning:false` about
   * this connection's own prompt state. For a session another process is driving that
   * report is uninformative, and taking it as a completion flipped the row to 완료 the
   * moment it was clicked. Remembering where the running state came from is what
   * tells that report apart from a real one.
   */
  private readonly transcriptRunningSessions = new Set<string>();
  /**
   * Sessions whose current work cycle GJC confirmed with a non-idle phase.
   *
   * The marker survives runtime idle until the transcript confirms the final assistant
   * row. The phase is the only signal that separates a turn waiting on a tool result
   * from one that ended, because `gjcRunning:false` also describes this connection's
   * idle prompt slot while a steer drives the actual work.
   */
  private readonly workingPhaseSessions = new Set<string>();
  /**
   * Sessions whose runtime has reported a real idle transition after a working phase.
   *
   * Neither side closes a cycle alone. Runtime idle can arrive while the model is
   * still responding after a tool, and the transcript can contain a `stop` row before
   * more tool calls are appended. A session that emitted a working phase settles only
   * after this marker and a terminal transcript agree.
   */
  private readonly runtimeIdleSessions = new Set<string>();
  /**
   * Sessions with detached work no row has released yet, keyed by the launch markers
   * that latch rests on.
   *
   * The markers are the reason this is a map rather than a set. A bounded run-state
   * read parses only the tail of the transcript, so the launch rows that armed the
   * latch can sit behind every window it is allowed to parse -- 01a13f2e had two of
   * them megabytes behind the terminal row that ended the turn. Nothing in those rows
   * can retire the marker, and a marker the runtime no longer runs must not hold the
   * row open, so the ids are kept here for a read that cannot see them to put back to
   * `runtime.jobs.list`.
   */
  private readonly pendingAsyncWorkSessions = new Map<string, string[]>();
  /**
   * Launch markers a session's transcript carried when the runtime was last asked
   * which jobs it still has running.
   *
   * `runtime.jobs.list` is the only authority that can retire a marker whose job was
   * paused, cancelled, or taken down with its process -- none of those deliver the
   * `async-result` release a completed detached task writes. A retired marker is
   * remembered because the transcript rows that wrote it never change: without that,
   * every later read of the same file would re-arm the latch it belongs to.
   *
   * `checkedJobIds` is what makes that memory age the right way: the throttle covers
   * the markers the last attempt actually asked about, never one nobody has asked
   * about, so a latch armed later still gets its own query instead of inheriting an
   * older answer that never mentioned it.
   */
  private readonly asyncJobReconciliations = new Map<
    string,
    { checkedAt: number; deadJobIds: Set<string>; checkedJobIds: Set<string> }
  >();
  /** Monotonic per-session lifecycle generation for async status reads and IPC merges. */
  private readonly runRevisions = new Map<string, number>();
  /**
   * Transcript-derived run state per session, keyed by the file size it was read at.
   *
   * `runningJobIds` records the launch markers the verdict at that size rests on,
   * so a size-unchanged read can still notice that the job behind them ended.
   */
  private readonly discoveredRunStates = new Map<
    string,
    { size: number; status: AgentSession["status"]; runningJobIds?: string[] }
  >();
  /** Delay between broker polls while recovering a fork's session id. */
  private forkRecoveryIntervalMs = 250;
  private readonly sessionCommands = new Map<string, AgentCommand[]>();
  /** Last command palette actually handed to the renderer, so an identical reopen is silent. */
  private readonly publishedCommandKeys = new Map<string, string>();
  private readonly commandRefreshTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly commandRefreshAttempts = new Map<string, number>();
  /** Long todo reads used only while a session has no live todo event channel. */
  private readonly todoPollTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly todoPollAttempts = new Map<string, number>();
  /**
   * Commands the runtime itself advertised (`available_commands_update`).
   *
   * This is the authoritative set and is replaced wholesale on every event, so a
   * command the runtime withdraws disappears from the palette. It is kept apart
   * from the merged cache because that cache is also fed by this window's adapter
   * specs and by runtime state discovery, and neither of those may speak for GJC.
   */
  private readonly sessionAdvertisedCommands = new Map<string, AgentCommand[]>();
  /**
   * Dynamic commands discovered from runtime state on attach/create rather than
   * from an `available_commands_update`. Replaced wholesale by each discovery pass.
   */
  private readonly sessionDiscoveredCommands = new Map<string, AgentCommand[]>();
  private readonly sessionSdkOperations = new Map<string, Set<string>>();
  private readonly sessionConfig = new Map<string, AgentConfigOption[]>();
  /**
   * The last plan the runtime reported for a session.
   *
   * `sessionUpdate=plan` is the only plan source, and the durable session file does
   * not record plans. A rescan therefore replaced the transcript array with file
   * rows and the plan of a session that was still running it disappeared, so the
   * row is retained here and composed back into every install of that transcript.
   */
  private readonly sessionPlans = new Map<string, PlanActivity>();
  /** The runtime's todo store as this window last observed it, per session. */
  private readonly sessionTodoSnapshots = new Map<string, TodoSnapshotState>();
  /**
   * The in-flight todo read per session.
   *
   * Nothing pushes todo changes, so reads are event-driven: a transcript bootstrap
   * and an observed todo tool completion. Sharing the pending promise keeps a burst
   * of those from becoming a burst of runtime calls, and no timer polls it.
   */
  private readonly todoReads = new Map<string, Promise<unknown[] | undefined>>();
  private readonly terminalOnlySessions = new Set<string>();
  private readonly modelProfiles = new Map<string, AgentConfigOptionValue[]>();
  private readonly explicitSessionThinking = new Map<string, string>();
  private readonly pendingPermissions = new Map<string, PendingPermission>();
  private readonly artifactWrites = new Map<string, Promise<void>>();
  private readonly artifactSessionIds = new Map<string, Set<string>>();
  private readonly deletingSessions = new Set<string>();
  private readonly deletionPromises = new Map<string, Promise<void>>();
  private readonly sharedSessionFiles = new Map<string, string>();
  // A transcript is append-only, so a rescan only has to parse the bytes added
  // since the last one. Device/inode identify the file so a compaction that
  // rewrites or truncates it is detected and falls back to a full parse.
  //
  // Every entry retains the file's parsed envelopes, so the map is held to the
  // transcripts actually being re-read. Measured at 6.3MB per entry, an unbounded
  // map reached 372MB across 60 transcripts and would pass 2GB across the 400 on
  // this machine. Insertion order makes it an LRU: the oldest key is evicted first.
  private static readonly SHARED_TRANSCRIPT_CACHE_LIMIT = 8;
  private readonly sharedTranscriptReads = new Map<
    string,
    {
      device: number;
      inode: number;
      size: number;
      envelopes: Record<string, unknown>[];
      partial: string;
    }
  >();
  private readonly sharedSessionWatchers = new Map<string, FSWatcher>();
  private readonly sharedSessionRefreshTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly imageDataUrls = new Map<string, string>();
  private readonly attachAttempts = new Map<string, number>();
  private readonly contextUsageQueries = new Map<string, Promise<void>>();

  private connectionState: BackendConnection;
  /**
   * The `gjc sdk session` client.
   *
   * There is no resident agent process and no connection object: each call is its
   * own short-lived CLI invocation. `readiness` only memoises resolving the
   * executable and reading the broker index once per start, so the window can
   * report a real state instead of pretending to be connected.
   */
  private cli?: GjcSdkCli;
  private startup?: Promise<void>;
  private disposed = false;
  private nextLocalId = 1;
  private generation = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private reconnectAttempt = 0;
  /** Sessions whose permission mode has been applied for this runtime generation. */
  private readonly permissionModeApplied = new Set<string>();
  /** Live tail catch-up reads in flight, keyed by session. */
  private readonly tailReads = new Map<string, Promise<void>>();
  /** Abort handles for the short-lived tail CLI child currently reading a session. */
  private readonly tailControllers = new Map<string, AbortController>();
  /** Latest tail checkpoint claim per session, so a re-read resumes rather than rewinds. */
  private readonly tailCheckpoints = new Map<string, string>();
  /** Sessions this window resumed, and therefore may close before deleting. */
  private readonly windowHostedSessions = new Set<string>();
  /** Public observer connections that replace tool output with the newest snapshot. */
  private readonly toolObservers = new Map<string, AbortController>();
  /** The latest streamed tool rows, kept over a stale durable read. */
  private readonly toolSnapshots = new Map<string, Map<string, ToolActivity>>();

  constructor(options: GjcControllerOptions) {
    this.workspace = canonicalWorkspace(options.workspace);
    this.configuredExecutable = options.executable;
    this.modelPreset = options.modelPreset ?? DEFAULT_MODEL_PRESET;
    this.permissionHandling = options.permissionHandling ?? "prompt";
    this.sessionMetadata = options.sessionMetadata;
    this.emitEvent = options.emit;
    this.artifactDirectory = path.resolve(
      options.artifactDirectory ??
        path.join(this.workspace, ".gajae-artifacts"),
    );
    this.connectionState = {
      state: "disconnected",
      backend: "gjc",
      label: "GJC",
      detail: "Not connected",
      workspace: this.workspace,
      modelPreset: this.modelPreset,
    };
  }

  async getConnection(): Promise<BackendConnection> {
    try {
      await this.ensureStarted();
    } catch (error) {
      this.setConnection({
        state: "error",
        backend: "gjc",
        label: "GJC unavailable",
        detail: error instanceof Error ? error.message : String(error),
        workspace: this.workspace,
        modelPreset: this.modelPreset,
      });
    }
    return { ...this.connectionState };
  }

  async reconfigure(preferences: AgentControlPreferences): Promise<boolean> {
    const workspace = canonicalWorkspace(preferences.workspace);
    const executable = preferences.gjcExecutable || undefined;
    const runtimeChanged =
      this.configuredExecutable !== executable ||
      this.modelPreset !== preferences.modelPreset ||
      this.permissionHandling !== preferences.permissionHandling;
    this.workspace = workspace;
    this.configuredExecutable = executable;
    this.modelPreset = preferences.modelPreset;
    this.permissionHandling = preferences.permissionHandling;
    if (!runtimeChanged) {
      this.setConnection({ ...this.connectionState, workspace });
      return false;
    }

    for (const pending of this.pendingPermissions.values())
      pending.resolve({ outcome: { outcome: "cancelled" } });
    this.pendingPermissions.clear();
    // No resident process to stop: dropping the client is the whole teardown, and
    // the next call rebuilds it against the new runtime.
    this.cli = undefined;
    this.startup = undefined;
    this.routeProbes.clear();
    this.permissionModeApplied.clear();
    for (const sessionId of this.toolObservers.keys())
      this.stopTailFollower(sessionId);
    for (const sessionId of this.tailControllers.keys())
      this.stopTailFollower(sessionId);
    this.attachedSessions.clear();
    this.windowHostedSessions.clear();
    // The new runtime re-attaches from scratch, so last run's throttle stamps must
    // not delay the first attempt against it.
    this.attachAttempts.clear();
    this.transcriptAttachments.clear();
    this.activePromptSessions.clear();
    this.activePromptAdmissions.clear();
    this.cancellationWatermarks.clear();
    this.liveRunningSessions.clear();
    this.liveRunningDigests.clear();
    this.liveEvidenceAt.clear();
    this.transcriptRunningSessions.clear();
    this.workingPhaseSessions.clear();
    this.runtimeIdleSessions.clear();
    this.pendingAsyncWorkSessions.clear();
    this.asyncJobReconciliations.clear();
    this.discoveredRunStates.clear();
    this.compactingSessions.clear();
    this.compactionRecordBaseline.clear();
    this.compactionRecordWatermark.clear();
    this.compactionStartedAt.clear();
    this.activeAssistantMessages.clear();
    this.activeThoughts.clear();
    this.suppressedUserMessageKeys.clear();
    this.echoedPromptTexts.clear();
    this.sessionSdkOperations.clear();
    await this.ensureStarted();
    return true;
  }

  async listSessions(): Promise<AgentSession[]> {
    // Yield during the short steering request, not the whole prompt lifetime.
    // A prompt can run for minutes; freezing discovery for that entire interval
    // hides every CLI session opened while the desktop is working.
    if (this.lastDiscovered.length > 0 && this.pendingSteers.size > 0)
      return this.lastDiscovered.map((session) => ({ ...session }));
    if (this.discoveryInFlight) return this.discoveryInFlight;
    const discovery = this.discoverSessions().finally(() => {
      this.discoveryInFlight = undefined;
    });
    this.discoveryInFlight = discovery;
    return discovery;
  }

  private discoveryInFlight: Promise<AgentSession[]> | undefined;
  // The startup reachability check is also the first complete global index.
  // Only discovery consumes it; lifecycle operations always ask for fresh evidence.
  private startupSessionRows: SdkSessionRow[] | undefined;
  /** Last full broker list whose index file revision was stable across the read. */
  private cachedBrokerRows: SdkSessionRow[] | undefined;
  private cachedBrokerRevision: string | undefined;
  // The session map is a durable cache keyed by every id ever seen, including
  // rows discovery later filtered out. Yielding must replay the last discovered
  // list instead, or skipping a scan resurrects dead sessions in the sidebar.
  private lastDiscovered: AgentSession[] = [];
  private lastLiveFingerprint: string | undefined;

  private async discoverSessions(): Promise<AgentSession[]> {
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
    const brokerRows = await this.brokerSessions({ initialDiscovery: true });
    // Without the index there is no liveness or placeholder evidence, so the
    // previous result stands rather than republishing every historical session.
    if (!brokerRows)
      return this.lastDiscovered.map((session) => ({ ...session }));
    // The broker index is the full set of session ids that still exist anywhere. A
    // hidden id outside it has nothing left to hide, so it is dropped instead of
    // being carried in the metadata file for the life of the install.
    this.sessionMetadata?.forgetHiddenOutside(
      new Set(brokerRows.map((session) => session.sessionId)),
    );
    const liveRows: SdkSessionRow[] = [];
    for (const session of brokerRows) {
      if (!session.live || session.deleted || this.sessionMetadata?.isHidden(session.sessionId)) {
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
      liveRows.map((session) => this.liveRouteReachable(session)),
    );
    liveRows.forEach((session, index) => {
      if (!reachable[index]) {
        deadSessionIds.add(session.sessionId);
        return;
      }
      const attachable = (session.endpointGeneration ?? 0) > 0;
      liveRanks.set(session.sessionId, attachable ? 2 : 1);
      if (attachable && this.terminalOnlySessions.has(session.sessionId)) {
        // A positive probe above is the evidence that clears a recorded route failure.
        this.terminalOnlySessions.delete(session.sessionId);
        const cached = this.sessions.get(session.sessionId);
        if (cached) cached.attachment = "attachable";
        this.lastLiveFingerprint = undefined;
      }
      if (session.repo) liveWorkspaces.add(session.repo);
    });
    const workspaces = [
      ...new Set([
        this.workspace,
        ...(this.sessionMetadata?.listWorkspaces() ?? []),
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
        !this.activePromptSessions.has(sessionId) &&
        !this.liveRunningSessions.has(sessionId),
    );
    // Polling/fingerprint eligibility intentionally excludes a live signal: its
    // transcript may still be the pre-start snapshot. Watcher eligibility is
    // broader, though. A live signal without a matching idle report still needs
    // the transcript watcher to notice the eventual terminal row.
    const watchedSessionIds = [...liveRanks.keys()].filter(
      (sessionId) => !this.activePromptSessions.has(sessionId),
    );
    // Reconcile watchers before the fingerprint fast path. A session can become
    // watchable after an earlier scan failed to locate its transcript, even when
    // all polling inputs remain unchanged.
    await this.syncRunStateWatchers(watchedSessionIds);
    const runStates = await Promise.all(
      observedSessionIds
        .slice()
        .sort()
        .map(async (sessionId) => [
          sessionId,
          await this.discoveredRunState(sessionId),
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
        const status = this.sessions.get(sessionId)?.status;
        return [
          sessionId,
          status === "failed" || status === "starting" ? status : "",
        ];
      })
      .filter(([, status]) => status !== "");
    // A latched session is left out of `runStates`, so nothing in the fingerprint
    // moves when the only thing that changes about it is that its reports stopped --
    // the one event that has to re-derive the row. Naming the latches whose evidence
    // has gone quiet makes that scan differ from the previous one, and the settled
    // scan drops back to the base fingerprint.
    const quietLatchedSessionIds = [
      ...new Set([...this.liveRunningSessions, ...this.workingPhaseSessions]),
    ]
      .filter((sessionId) => this.liveEvidenceQuiet(sessionId))
      .sort();
    const liveFingerprint = JSON.stringify([
      [...liveRanks.entries()].sort(),
      workspaces.slice().sort(),
      runStates,
      ownStatuses,
      quietLatchedSessionIds,
    ]);
    if (
      this.lastDiscovered.length > 0 &&
      liveFingerprint === this.lastLiveFingerprint
    )
      return this.lastDiscovered.map((session) => ({ ...session }));
    this.lastLiveFingerprint = liveFingerprint;
    const pages = await Promise.all(
      workspaces.map(async (cwd) => {
        try {
          // Sessions for this workspace come from the broker index, which already
          // carries every session id and repository; the session file supplies the
          // title and last activity.
          const sessions: SessionInfo[] = [];
          for (const row of brokerRows) {
            if (!row.repo || path.resolve(row.repo) !== path.resolve(cwd))
              continue;
            // Excluded rows must not scan the session directories or read history.
            if (!liveRanks.has(row.sessionId)) continue;
            const filePath = await this.locateSharedTranscriptFile(
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
          if (cwd === this.workspace) throw error;
          return [];
        }
      }),
    );
    const listed = [
      ...new Map(
        pages.flat().map((session) => [session.sessionId, session]),
      ).values(),
    ]
      .filter((session) => !this.sessionMetadata?.isHidden(session.sessionId))
      .filter((session) => !deadSessionIds.has(session.sessionId))
      .sort(
        (left, right) =>
          (liveRanks.get(right.sessionId) ?? 0) -
            (liveRanks.get(left.sessionId) ?? 0) ||
          (Date.parse(right.updatedAt ?? "") || 0) -
            (Date.parse(left.updatedAt ?? "") || 0),
      );

    for (const info of listed) {
      const existing = this.sessions.get(info.sessionId);
      const persistedOwnership = this.sessionMetadata?.getOwnership(
        info.sessionId,
      );
      const ownership =
        persistedOwnership ??
        (existing?.ownership === "gajae"
          ? "gajae"
          : (liveRanks.get(info.sessionId) ?? 0) >= 2
            ? "available"
            : "external");
      const attachment = this.attachedSessions.has(info.sessionId)
        ? ("attached" as const)
        : this.terminalOnlySessions.has(info.sessionId)
          ? ("terminal-only" as const)
          : ("attachable" as const);
      const listedSession = sessionInfoToAgentSession(info);
      // Discovery metadata says nothing about whether the agent is working, and a
      // session this window has never opened has no other source, so it used to
      // default to idle -- work started from a terminal listed as finished. The
      // persisted transcript is the one account that exists for those sessions.
      const statusRevision = this.currentRunRevision(info.sessionId);
      const transcriptStatus = await this.discoveredRunState(info.sessionId);
      const currentSession = this.sessions.get(info.sessionId) ?? existing;
      const revisionChanged =
        statusRevision !== this.currentRunRevision(info.sessionId);
      // A row the live latch left running is settled here instead of by the status
      // chain below: that chain preserves a running status for a latched session by
      // design, and the latch has no other consumer once its reports stop. The
      // revision the report advanced is only consumed by a transcript read that
      // agrees it is still current, so a read it deferred never re-derives the row
      // either -- this reconciliation has to stand on its own.
      const quietSettle = this.settleQuietRunningRow(
        info.sessionId,
        transcriptStatus,
        currentSession,
      );
      const discoveredStatus = quietSettle
        ? "idle"
        : this.locallyAbortedSessions.has(info.sessionId)
          ? "idle"
          : revisionChanged && currentSession
          ? currentSession.status
          : this.activePromptSessions.has(info.sessionId) ||
              this.liveRunningSessions.has(info.sessionId)
            ? (currentSession?.status ?? "idle")
            : currentSession?.status === "failed" ||
                currentSession?.status === "starting"
              ? currentSession.status
              : (transcriptStatus ?? currentSession?.status ?? "idle");
      // Lineage is not on the broker row this loop is reading, so it comes from the
      // session's own envelope.
      const parentId = await this.sessionParentId(info.sessionId);
      if (
        !revisionChanged &&
        currentSession &&
        currentSession.status !== discoveredStatus
      )
        this.advanceRunRevision(info.sessionId);
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
        runRevision: this.currentRunRevision(info.sessionId),
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
          this.sessionMetadata?.getUnread(info.sessionId) ??
          currentSession?.unread ??
          false,
        worktree: this.sessionMetadata?.getWorktree(info.sessionId),
        parentId: parentId ?? currentSession?.parentId,
      };
      session.title =
        this.sessionMetadata?.getAlias(session.id) ?? session.title;
      this.sessions.set(session.id, session);
      if (info.cwd) this.sessionCwds.set(session.id, info.cwd);
    }

    this.lastDiscovered = listed.map((info) => ({
      ...this.sessions.get(info.sessionId)!,
    }));
    return this.lastDiscovered.map((session) => ({ ...session }));
  }

  private readonly routeProbes = new Map<string, { at: number; reachable: boolean }>();

  /**
   * Whether a broker-live row still answers the public metadata route.
   *
   * Only a session this window is not already driving needs the probe, and only a
   * row whose route is unproven: a generation-zero host, or one that failed an
   * operation before. Only an unreachable-endpoint error counts as proof; a timeout
   * or any other failure keeps the row listed. Results are cached for one retry
   * interval so a scan does not spawn a CLI per row.
   */
  private async liveRouteReachable(row: SdkSessionRow): Promise<boolean> {
    const sessionId = row.sessionId;
    const attachable = (row.endpointGeneration ?? 0) > 0;
    if (
      this.attachedSessions.has(sessionId) ||
      this.activePromptSessions.has(sessionId) ||
      (attachable && !this.terminalOnlySessions.has(sessionId))
    )
      return true;
    const cached = this.routeProbes.get(sessionId);
    if (cached && Date.now() - cached.at < ATTACH_RETRY_INTERVAL_MS) return cached.reachable;
    let reachable = true;
    try {
      const cli = await this.requireCli();
      await cli.queryItems(sessionId, "session.metadata", {}, { repo: row.repo ?? this.workspace });
    } catch (error) {
      if (!isSessionUnreachable(error)) return true;
      reachable = false;
    }
    if (!this.disposed) this.routeProbes.set(sessionId, { at: Date.now(), reachable });
    return reachable;
  }

  private readonly runStateWatchers = new Map<string, FSWatcher>();
  private readonly runStateTimers = new Map<string, NodeJS.Timeout>();

  /**
   * Keeps a run-state watcher for exactly the sessions handed in.
   *
   * A watcher is cheap next to a poll -- it reads only when the file changes -- but it
   * is still one file descriptor per session, so the set is bounded to the live rows
   * and pruned as soon as a session leaves them.
   */
  private async syncRunStateWatchers(sessionIds: readonly string[]): Promise<void> {
    if (this.disposed) return;
    const wanted = new Set(sessionIds);
    for (const [sessionId, watcher] of this.runStateWatchers) {
      if (wanted.has(sessionId)) continue;
      watcher.close();
      this.runStateWatchers.delete(sessionId);
      const timer = this.runStateTimers.get(sessionId);
      if (timer) clearTimeout(timer);
      this.runStateTimers.delete(sessionId);
    }
    for (const sessionId of wanted) {
      if (this.runStateWatchers.has(sessionId)) continue;
      // An already-open transcript has its own watcher doing strictly more work, so a
      // second one here would read the same file twice for the same change.
      if (this.sharedSessionWatchers.has(sessionId)) continue;
      // The first scan may have had no transcript yet. Retry resolution on every
      // reconciliation so an unchanged discovery fingerprint does not strand a
      // live session without a watcher.
      const filePath = await this.locateSharedTranscriptFile(sessionId);
      if (!filePath) continue;
      try {
        const fileName = path.basename(filePath);
        const watcher = watch(
          path.dirname(filePath),
          { persistent: false },
          (_event, changedFile) => {
            if (changedFile && changedFile.toString() !== fileName) return;
            const previous = this.runStateTimers.get(sessionId);
            if (previous) clearTimeout(previous);
            this.runStateTimers.set(
              sessionId,
              setTimeout(() => {
                this.runStateTimers.delete(sessionId);
                void this.republishRunState(sessionId);
              }, 150),
            );
          },
        );
        watcher.on("error", () => {
          watcher.close();
          this.runStateWatchers.delete(sessionId);
        });
        this.runStateWatchers.set(sessionId, watcher);
      } catch {
        // Polling still covers the row when the filesystem cannot be watched.
      }
    }
  }

  /** Re-reads one session's run state and publishes the row if it moved. */
  private async republishRunState(sessionId: string): Promise<void> {
    if (this.disposed) return;
    if (this.activePromptSessions.has(sessionId)) return;
    const generation = this.generation;
    const revision = this.currentRunRevision(sessionId);
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
    if (this.liveRunningSessions.has(sessionId)) {
      const seenSize = this.liveRunningDigests.get(sessionId);
      if (seenSize !== undefined) {
        const filePath = await this.locateSharedTranscriptFile(sessionId);
        if (!filePath) return;
        try {
          if ((await stat(filePath)).size === seenSize) return;
        } catch {
          return;
        }
      }
    }
    const status = await this.discoveredRunState(sessionId);
    if (
      generation !== this.generation ||
      revision !== this.currentRunRevision(sessionId)
    )
      return;
    if (!status) return;
    if (status === "idle") {
      this.liveRunningSessions.delete(sessionId);
      this.liveRunningDigests.delete(sessionId);
      this.liveEvidenceAt.delete(sessionId);
      this.transcriptRunningSessions.delete(sessionId);
      this.workingPhaseSessions.delete(sessionId);
      this.runtimeIdleSessions.delete(sessionId);
    }
    const session = this.sessions.get(sessionId);
    if (!session || session.status === status) return;
    if (session.status === "failed" || session.status === "starting") return;
    this.advanceRunRevision(sessionId);
    session.status = status;
    this.lastDiscovered = this.lastDiscovered.map((row) =>
      row.id === sessionId
        ? { ...row, status, runRevision: session.runRevision }
        : row,
    );
    this.emitEvent({ type: "session.updated", session: { ...session } });
  }

  /**
   * Parent session ids, keyed by session id, with `null` for a transcript that was
   * read and named no source.
   *
   * A fork writes the link into the new session's envelope when it creates the
   * file and never revises it, so one read per session is enough -- and the negative
   * answer has to be cached too, or every discovery pass would re-read the head of
   * every root session in the list.
   */
  private readonly sessionParents = new Map<string, string | null>();

  /**
   * The session a row was forked from, read from its transcript envelope.
   *
   * The broker's session list carries identity and liveness only, so lineage comes
   * from the same session file the history scan already reads a bounded head of.
   * A session whose file is not on disk yet answers with the id it already carries,
   * which keeps a fork this window made from losing its link to a slow write.
   */
  private async sessionParentId(
    sessionId: string,
  ): Promise<string | undefined> {
    const cached = this.sessionParents.get(sessionId);
    if (cached !== undefined) return cached ?? undefined;
    try {
      const filePath = await this.locateSharedTranscriptFile(sessionId);
      if (!filePath) return this.sessions.get(sessionId)?.parentId;
      const id = parentSessionOf(
        (await transcriptHeadLines(filePath))[0],
        sessionId,
      );
      this.sessionParents.set(sessionId, id ?? null);
      return id;
    } catch {
      // An unreadable transcript is not evidence of a root: keep whatever the row
      // already reports rather than erasing a link we had.
      return this.sessions.get(sessionId)?.parentId;
    }
  }

  /**
   * Run state for a session discovery is listing, read from its transcript.
   *
   * Discovery covers every session the broker knows, so this must not turn a list
   * refresh into hundreds of full file reads. Only the tail of the file is parsed,
   * and the result is cached against the file's size so an unchanged transcript is
   * answered without touching the disk again.
   */
  private async discoveredRunState(
    sessionId: string,
  ): Promise<AgentSession["status"] | undefined> {
    try {
      const filePath = await this.locateSharedTranscriptFile(sessionId);
      if (!filePath) return undefined;
      const info = await stat(filePath);
      if (!info.isFile() || info.size > 64 * 1024 * 1024) return undefined;
      const cached = this.discoveredRunStates.get(sessionId);
      if (cached && cached.size === info.size) {
        const markers = cached.runningJobIds ?? [];
        const latched = this.pendingAsyncWorkSessions.get(sessionId) ?? [];
        if (markers.length === 0 && latched.length === 0)
          return this.effectiveTranscriptRunState(sessionId, cached.status);
        // The transcript cannot move while its size is unchanged, so the only part
        // of this verdict that still can is the detached work it rested on: a job
        // paused or cancelled from outside writes no release row, and nothing else
        // in the read path asks the runtime about it again. A latch is asked about
        // here too: it outlives the cached verdict, and a verdict taken from a tail
        // window can carry no marker at all while a full-history read left one.
        const surviving = await this.reconcilePendingAsyncWork(
          sessionId,
          markers,
          latched,
        );
        // A verdict this size rests entirely on markers reads idle once they are
        // gone; one that rested on the rows themselves keeps what they said, and a
        // surviving latch holds it running whatever they said.
        const status =
          surviving.length > 0
            ? ("running" as const)
            : markers.length > 0
              ? ("idle" as const)
              : cached.status;
        this.discoveredRunStates.set(sessionId, {
          size: info.size,
          status,
          ...(surviving.length > 0 ? { runningJobIds: surviving } : {}),
        });
        return this.effectiveTranscriptRunState(sessionId, status);
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
        this.sessions.get(sessionId)?.status === "running" ||
          this.liveRunningSessions.has(sessionId),
      );
      if (!envelopes) return undefined;
      const turn = persistedTurnState(envelopes);
      const latched = this.pendingAsyncWorkSessions.get(sessionId) ?? [];
      let runningJobIds: string[] | undefined;
      let running = turn.running;
      if (turn.pendingAsyncWorkOnly) {
        // The one verdict a transcript cannot settle alone. A detached task that is
        // paused, cancelled, or lost with its process writes no release row, so its
        // launch marker stays in the file long after the work ended. The runtime's
        // own job list decides -- and it is asked only when nothing else in the
        // transcript keeps the session running.
        runningJobIds = await this.reconcilePendingAsyncWork(
          sessionId,
          turn.pendingAsyncJobIds,
          latched,
        );
        running = runningJobIds.length > 0;
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
        const surviving = await this.reconcilePendingAsyncWork(
          sessionId,
          [],
          latched,
        );
        running = surviving.length > 0;
        // Only a surviving latch is recorded: nothing in these rows rests on the
        // markers, so an idle verdict here is the window's own account.
        if (running) runningJobIds = surviving;
      }
      const status = running ? ("running" as const) : ("idle" as const);
      if (status === "running") this.transcriptRunningSessions.add(sessionId);
      else this.transcriptRunningSessions.delete(sessionId);
      this.discoveredRunStates.set(sessionId, {
        size: info.size,
        status,
        ...(runningJobIds ? { runningJobIds } : {}),
      });
      return this.effectiveTranscriptRunState(sessionId, status);
    } catch {
      return undefined;
    }
  }

  private effectiveTranscriptRunState(
    sessionId: string,
    status: AgentSession["status"],
  ): AgentSession["status"] {
    if (
      status === "idle" &&
      ((this.workingPhaseSessions.has(sessionId) &&
        !this.runtimeIdleSessions.has(sessionId) &&
        // A phase report ages like every other live signal. A 'working' phase with
        // no report after it held a settled row running for the life of the process,
        // and nothing else re-derives a verdict for a session a latch still names.
        !this.liveEvidenceQuiet(sessionId)) ||
        this.pendingAsyncWorkSessions.has(sessionId))
    )
      return "running";
    return status;
  }

  /**
   * Records that a live report for this session confirmed work just now.
   *
   * Called from every path that accepts live evidence of work, never from a read of
   * the transcript: this is the clock that decides when the transcript is the newer
   * account.
   */
  private recordLiveEvidence(sessionId: string): void {
    this.liveEvidenceAt.set(sessionId, Date.now());
  }

  /** True when no live work signal arrived for this session inside the grace. */
  private liveEvidenceQuiet(sessionId: string): boolean {
    const lastReportedAt = this.liveEvidenceAt.get(sessionId);
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
  private clearRunningLatches(sessionId: string): void {
    this.liveRunningSessions.delete(sessionId);
    this.liveRunningDigests.delete(sessionId);
    this.liveEvidenceAt.delete(sessionId);
    this.transcriptRunningSessions.delete(sessionId);
    this.workingPhaseSessions.delete(sessionId);
    this.runtimeIdleSessions.delete(sessionId);
    this.discoveredRunStates.delete(sessionId);
    this.compactingSessions.delete(sessionId);
    this.compactionRecordBaseline.delete(sessionId);
    this.compactionStartedAt.delete(sessionId);
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
  private settleQuietRunningRow(
    sessionId: string,
    transcriptStatus: AgentSession["status"] | undefined,
    currentSession: AgentSession | undefined,
  ): boolean {
    if (transcriptStatus !== "idle") return false;
    if (currentSession?.status !== "running") return false;
    if (this.activePromptSessions.has(sessionId)) return false;
    // Compaction is released by its own durable record or by a non-compacting
    // phase, never by a transcript that reads idle while the history is still being
    // rewritten under it.
    if (this.compactingSessions.has(sessionId)) return false;
    if (!this.liveEvidenceQuiet(sessionId)) return false;
    this.clearRunningLatches(sessionId);
    this.advanceRunRevision(sessionId);
    currentSession.status = "idle";
    this.emitEvent({ type: "session.updated", session: { ...currentSession } });
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
  private async reconcilePendingAsyncWork(
    sessionId: string,
    observed: readonly string[],
    inherited: readonly string[],
  ): Promise<string[]> {
    const candidates = new Set(observed);
    for (const jobId of inherited) candidates.add(jobId);
    const surviving = await this.reconciledAsyncJobIds(sessionId, [...candidates]);
    this.recordPendingAsyncWork(sessionId, surviving);
    return surviving;
  }

  /** Remembers the detached work a session still owes, or drops the latch when none is left. */
  private recordPendingAsyncWork(
    sessionId: string,
    jobIds: readonly string[],
  ): void {
    if (jobIds.length > 0) this.pendingAsyncWorkSessions.set(sessionId, [...jobIds]);
    else this.pendingAsyncWorkSessions.delete(sessionId);
  }

  /** The launch markers a reconciliation has not retired. */
  private unreconciledAsyncJobIds(
    sessionId: string,
    jobIds: readonly string[],
  ): string[] {
    const dead = this.asyncJobReconciliations.get(sessionId)?.deadJobIds;
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
  private async reconciledAsyncJobIds(
    sessionId: string,
    jobIds: readonly string[],
  ): Promise<string[]> {
    const pending = this.unreconciledAsyncJobIds(sessionId, jobIds);
    if (pending.length === 0) return pending;
    const record = this.asyncJobReconciliations.get(sessionId);
    const asked = record?.checkedJobIds;
    const now = Date.now();
    if (
      record &&
      pending.every((jobId) => asked?.has(jobId)) &&
      now - record.checkedAt < PENDING_ASYNC_RECONCILE_INTERVAL_MS
    )
      return pending;
    const dead = record?.deadJobIds ?? new Set<string>();
    const live = await this.runningAsyncJobIds(sessionId);
    this.asyncJobReconciliations.set(sessionId, {
      checkedAt: now,
      deadJobIds: dead,
      checkedJobIds: new Set([...(asked ?? []), ...pending]),
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
  private async runningAsyncJobIds(
    sessionId: string,
  ): Promise<Set<string> | undefined> {
    let rows: unknown[];
    try {
      rows = await this.querySessionItems(sessionId, "runtime.jobs.list", {}, {
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
  private async brokerSessions(options?: {
    scope?: "repo" | "cwd" | "worktree" | "all";
    initialDiscovery?: boolean;
  }): Promise<SdkSessionRow[] | undefined> {
    try {
      const cli = await this.requireCli();
      if (options?.initialDiscovery && this.startupSessionRows !== undefined) {
        const rows = this.startupSessionRows;
        this.startupSessionRows = undefined;
        return rows;
      }
      // Lifecycle reads (delete, fork recovery, create) always ask the broker.
      // Discovery is the 15s poll: an unchanged index file has nothing new to list.
      if (options?.initialDiscovery && (await this.brokerIndexUnchanged()))
        return this.cachedBrokerRows!.map((row) => ({ ...row }));
      const before = options?.initialDiscovery
        ? await this.brokerIndexRevision()
        : undefined;
      const rows = await cli.listSessions({
        scope: options?.scope ?? "all",
      });
      if (options?.initialDiscovery)
        this.noteBrokerIndex(rows, before, await this.brokerIndexRevision());
      return rows;
    } catch {
      return undefined;
    }
  }

  private invalidateBrokerIndexCache(): void {
    this.cachedBrokerRows = undefined;
    this.cachedBrokerRevision = undefined;
  }

  private async brokerIndexRevision(): Promise<string | undefined> {
    try {
      const info = await stat(brokerSessionIndexPath());
      if (!info.isFile()) return undefined;
      return `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`;
    } catch {
      return undefined;
    }
  }

  private async brokerIndexUnchanged(): Promise<boolean> {
    if (!this.cachedBrokerRevision || !this.cachedBrokerRows) return false;
    return (await this.brokerIndexRevision()) === this.cachedBrokerRevision;
  }

  /**
   * Keeps a discovery list only when the index file did not move during the read.
   *
   * A revision that changes mid-scan belongs to a newer index than the rows just
   * returned, so the next poll has to read again instead of treating them as current.
   */
  private noteBrokerIndex(
    rows: readonly SdkSessionRow[],
    before: string | undefined,
    after: string | undefined,
  ): void {
    if (before && before === after) {
      this.cachedBrokerRevision = after;
      this.cachedBrokerRows = rows.map((row) => ({ ...row }));
      return;
    }
    this.invalidateBrokerIndexCache();
  }

  async createSession(input: CreateSessionInput): Promise<AgentSession> {
    if (input.runtime !== "gjc")
      throw new Error("The GJC controller only creates GJC sessions");
    const cli = await this.requireCli();
    let sessionWorkspace = canonicalWorkspace(input.workspace);
    let worktree:
      | { sourceWorkspace: string; path: string; branch: string; managed: true }
      | undefined;
    if (input.isolation === "worktree") {
      const root = (
        await execFile("git", [
          "-C",
          sessionWorkspace,
          "rev-parse",
          "--show-toplevel",
        ])
      ).stdout.trim();
      if (!root) throw new Error("Workspace is not a git repository");
      const suffix = `${Date.now().toString(36)}-${this.nextLocalId++}`;
      const branch = input.worktreeBranch?.trim() || `gajae/${suffix}`;
      const worktreePath = path.join(
        path.dirname(root),
        `${path.basename(root)}.gajae-worktrees`,
        suffix,
      );
      await execFile("git", [
        "-C",
        root,
        "worktree",
        "add",
        "-b",
        branch,
        worktreePath,
      ]);
      sessionWorkspace = worktreePath;
      worktree = {
        sourceWorkspace: root,
        path: worktreePath,
        branch,
        managed: true,
      };
    }
    const knownSessionIds = new Set([
      ...this.sessions.keys(),
      ...(await this.brokerSessions())?.map((session) => session.sessionId) ??
        [],
    ]);
    let response: { sessionId: string } | undefined;
    const createRequestId = `gajae-session-create-${randomUUID()}`;
    const createStartedAt = Date.now();
    try {
      const created = await cli.rawGlobal(
        "session.create",
        {
          cwd: sessionWorkspace,
          modelPreset: this.modelPreset,
        },
        { repo: sessionWorkspace, idempotencyKey: createRequestId },
      );
      const sessionId =
        typeof created?.sessionId === "string" ? created.sessionId : undefined;
      if (sessionId) response = { sessionId };
    } catch (error) {
      // A create whose receipt could not be verified may still have produced a live
      // session. Verified against gjc/0.15.6: `session.create` answers
      // `terminal_uncertain` while `list` shows the new session live with a pid, so
      // the index is what settles it. Adopting it is not optimism -- it is reading
      // the authoritative account instead of the unverifiable receipt.
      if (isLifecycleUncertain(error)) {
        const retainedId = await this.recoverLifecycleSession(
          sessionWorkspace,
          knownSessionIds,
          createStartedAt,
        );
        if (retainedId) {
          this.sessionCwds.set(retainedId, sessionWorkspace);
          this.transcripts.set(retainedId, []);
          this.messageKeys.set(retainedId, new Map());
          response = { sessionId: retainedId };
        }
      }
      if (!response && worktree && error instanceof SdkCliError && error.outcomeCertainty === "not-applied") {
        try {
          const status = (
            await execFile("git", [
              "-C",
              worktree.path,
              "status",
              "--porcelain",
            ])
          ).stdout.trim();
          if (!status) {
            await execFile("git", [
              "-C",
              worktree.sourceWorkspace,
              "worktree",
              "remove",
              worktree.path,
            ]);
            await execFile("git", [
              "-C",
              worktree.sourceWorkspace,
              "branch",
              "-D",
              worktree.branch,
            ]);
          }
        } catch {
          /* Preserve a dirty or otherwise uncertain worktree for manual recovery. */
        }
      }
      if (!response && isLifecycleUncertain(error)) {
        throw new Error(
          "GJC가 세션을 생성했지만 lifecycle 영수증을 검증하지 못했습니다. 보존된 세션 자동 복구에도 실패했습니다. GJC lifecycle ledger reconciliation이 필요합니다.",
        );
      }
      if (!response) throw error;
    }
    if (!response) throw new Error("GJC did not report a new session id");
    // The startup scan predates this mutation and would hide the new session on
    // the first list call, even though create already announced it to the UI.
    this.startupSessionRows = undefined;
    this.invalidateBrokerIndexCache();
    const createdSessionId = response.sessionId;
    const session: AgentSession = {
      id: createdSessionId,
      title: input.title?.trim() || "New Gajae session",
      subtitle: path.basename(sessionWorkspace) || sessionWorkspace,
      workspace: sessionWorkspace,
      runtime: "gjc",
      status: "idle",
      updatedAt: "now",
      updatedAtMs: Date.now(),
      pinned: false,
      unread: false,
      accent: GJC_ACCENT,
      ownership: "gajae",
      attachment: "recovering",
      ...(worktree ? { worktree } : {}),
    };
    this.sessions.set(session.id, session);
    this.windowHostedSessions.add(session.id);
    this.sessionCwds.set(session.id, sessionWorkspace);
    this.transcripts.set(session.id, []);
    this.messageKeys.set(session.id, new Map());
    this.sessionMetadata?.setAlias(session.id, session.title);
    this.sessionMetadata?.setWorkspace(session.id, sessionWorkspace);
    this.sessionMetadata?.setOwnership(session.id, "gajae");
    if (worktree) this.sessionMetadata?.setWorktree(session.id, worktree);
    try {
      await this.applyPermissionMode(session.id);
    } catch (error) {
      // A session whose safety mode was not confirmed must remain readable but is
      // never advertised as sendable. Preserve its worktree and metadata so the
      // user can retry resume after fixing the broker/runtime failure.
      session.status = "failed";
      session.attachment = "recovering";
      this.emitEvent({ type: "session.created", session: { ...session } });
      throw error;
    }
    session.attachment = "attached";
    this.attachedSessions.add(session.id);
    this.startTailFollower(session.id);
    void this.refreshSdkCommands(session.id);
    await this.refreshModelProfiles(session.id);
    await this.refreshSessionConfigOptions(session.id);
    void this.refreshContextUsage(session.id);
    // The new session's file is the live account for everything it does next.
    const createdFile = await this.locateSharedTranscriptFile(session.id);
    if (createdFile) this.watchSharedTranscript(session.id, createdFile);
    this.emitEvent({ type: "session.created", session: { ...session } });
    return { ...session };
  }

  /** Renames through the live SDK, then mirrors the title into app metadata. */
  async renameSession(sessionId: string, title: string): Promise<void> {
    const value = title.trim();
    if (!value) throw new Error("Session title cannot be empty");
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown GJC session: ${sessionId}`);
    const operations = await this.sdkOperations(sessionId);
    if (operations.has("session.rename"))
      await this.controlSession(sessionId, "session.rename", { name: value });
    this.sessionMetadata?.setAlias(sessionId, value);
    session.title = value;
    markUpdated(session);
    this.emitEvent({ type: "session.updated", session: { ...session } });
  }

  private readonly transcriptAttachments = new Map<string, Promise<void>>();

  private refreshTranscriptAttachment(sessionId: string): void {
    if (
      !this.disposed &&
      this.sessions.get(sessionId)?.attachment === "attachable" &&
      !this.terminalOnlySessions.has(sessionId) &&
      !this.attachedSessions.has(sessionId) &&
      !this.transcriptAttachments.has(sessionId)
    ) {
      const lastAttempt = this.attachAttempts.get(sessionId) ?? 0;
      if (Date.now() - lastAttempt > ATTACH_RETRY_INTERVAL_MS) {
        this.attachAttempts.set(sessionId, Date.now());
        const generation = this.generation;
        const refresh = (async () => {
          try {
            await this.ensureAttached(sessionId, false);
            if (!this.disposed && generation === this.generation && this.sessions.has(sessionId))
              await this.refreshSessionSettings(sessionId);
          } catch {
            // Readable history does not establish runtime control. Required control
            // operations still report their own attachment errors.
          }
        })().finally(() => {
          if (this.transcriptAttachments.get(sessionId) === refresh)
            this.transcriptAttachments.delete(sessionId);
        });
        this.transcriptAttachments.set(sessionId, refresh);
      }
    }
  }

  /**
   * Loads the session's command palette and todo row once, when the user opens it.
   *
   * These live outside the transcript file and have no push channel of their own,
   * but tying them to getTranscript made every 5-second safety-net read spawn CLI
   * queries even when the transcript had not changed.
   */
  async refreshSessionContext(sessionId: string): Promise<void> {
    const commands = this.sessionCommands.get(sessionId);
    if (commands) this.publishSessionCommands(sessionId, commands);
    await Promise.all([
      this.refreshSdkCommands(sessionId),
      this.readTodoRecords(sessionId),
    ]);
  }

  /**
   * Hands the renderer a command palette once per distinct content.
   *
   * Reopening a session used to emit the cached palette on every visit, and the
   * shell replaced its state with a new array of the same commands.
   */
  private publishSessionCommands(
    sessionId: string,
    commands: readonly AgentCommand[],
  ): void {
    const key = commandPublicationKey(commands);
    if (this.publishedCommandKeys.get(sessionId) === key) return;
    this.publishedCommandKeys.set(sessionId, key);
    this.emitEvent({
      type: "session.commands",
      sessionId,
      commands: commands.map((command) => ({ ...command })),
    });
  }

  async getTranscript(sessionId: string): Promise<TranscriptItem[]> {
    const externallyDriven = !this.activePromptSessions.has(sessionId);
    if (this.terminalOnlySessions.has(sessionId) || externallyDriven) {
      try {
        const shared = await this.readSharedTranscript(sessionId);
        if (shared.length > 0) {
          const installed = this.installTranscript(sessionId, shared);
          // Local history is readable before the runtime finishes inspecting its
          // endpoint, profiles and settings. Hydrate those independently.
          this.refreshTranscriptAttachment(sessionId);
          return installed.map(cloneTranscriptItem);
        }
        if (this.terminalOnlySessions.has(sessionId))
          return [this.terminalOnlyNotice(sessionId)];
      } catch {
        if (this.terminalOnlySessions.has(sessionId))
          return [this.terminalOnlyNotice(sessionId)];
      }
    }
    try {
      await this.ensureAttached(sessionId, true);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        /no current Router attachment|provider_lease_conflict/iu.test(message)
      ) {
        this.terminalOnlySessions.add(sessionId);
        const session = this.sessions.get(sessionId);
        if (session) {
          session.attachment = "terminal-only";
          session.ownership = "external";
          this.emitEvent({ type: "session.updated", session: { ...session } });
        }
        return [this.terminalOnlyNotice(sessionId)];
      }
      if (lifecycleUncertainError(error)) {
        const session = this.sessions.get(sessionId);
        if (session) {
          session.attachment = "recovering";
          session.status = "failed";
          this.emitEvent({ type: "session.updated", session: { ...session } });
        }
        return [this.lifecycleUncertainNotice(sessionId)];
      }
      if (!missingSessionError(error)) throw error;
      this.removeLocalSession(sessionId, true);
      return [];
    }
    await this.refreshModelProfiles(sessionId);
    return (this.transcripts.get(sessionId) ?? []).map(cloneTranscriptItem);
  }

  /**
   * Revision of the durable transcript file, used by the renderer's low-frequency
   * safety net. A stat is orders of magnitude cheaper than re-reading and cloning
   * every row, and the inode catches a re-host that reuses the same path.
   */
  async getTranscriptRevision(sessionId: string): Promise<string | undefined> {
    const filePath = await this.locateSharedTranscriptFile(sessionId);
    if (!filePath) return undefined;
    try {
      const info = await stat(filePath);
      if (!info.isFile()) return undefined;
      return `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`;
    } catch {
      return undefined;
    }
  }

  private async readSharedTranscript(
    sessionId: string,
  ): Promise<TranscriptItem[]> {
    const persisted = await this.readPersistedTranscript(sessionId);
    if (persisted) return persisted;
    // No session file yet: ask the session for its retained transcript instead. The
    // file is the durable account and wins whenever it exists.
    const rows = await this.querySessionItems(
      sessionId,
      "transcript.list",
      {},
      { strict: true },
    );
    return sharedTranscriptItems(sessionId, rows);
  }

  /**
   * Parsed envelopes for an append-only transcript, reusing the previous parse
   * and reading only the appended tail. Re-parsing the whole file on every write
   * cost ~24ms per sync on a 14MB transcript, which several subagents writing at
   * once turned into visible lag.
   */
  private async readTranscriptEnvelopes(
    filePath: string,
    info: Stats,
  ): Promise<Record<string, unknown>[]> {
    const parseInto = (
      target: Record<string, unknown>[],
      chunk: string,
      carry: string,
    ): string => {
      const text = carry + chunk;
      const lines = text.split("\n");
      // A write can land mid-line, so the trailing fragment is held back until
      // the newline that completes it arrives.
      const tail = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          target.push(JSON.parse(line) as Record<string, unknown>);
        } catch {
          // A torn or malformed line is skipped, matching the full-file parse.
        }
      }
      return tail;
    };

    const device = Number(info.dev);
    const inode = Number(info.ino);
    const previous = this.sharedTranscriptReads.get(filePath);
    const reusable =
      previous !== undefined &&
      previous.device === device &&
      previous.inode === inode &&
      // Shrinking means the file was rewritten (compaction), so nothing carries over.
      info.size >= previous.size;

    if (reusable && info.size === previous.size) {
      // An unchanged file is still a read, and the eviction order is what decides
      // which transcript survives. Returning early without touching it made the
      // most frequently polled session look like the stalest one.
      this.rememberTranscriptRead(filePath, previous);
      return previous.envelopes.slice();
    }

    if (reusable) {
      const handle = await open(filePath, "r");
      try {
        const length = info.size - previous.size;
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, previous.size);
        const envelopes = previous.envelopes.slice();
        const partial = parseInto(
          envelopes,
          buffer.toString("utf8"),
          previous.partial,
        );
        this.rememberTranscriptRead(filePath, {
          device,
          inode,
          size: info.size,
          envelopes,
          partial,
        });
        return envelopes.slice();
      } finally {
        await handle.close();
      }
    }

    const envelopes: Record<string, unknown>[] = [];
    const partial = parseInto(envelopes, await readFile(filePath, "utf8"), "");
    this.rememberTranscriptRead(filePath, {
      device,
      inode,
      size: info.size,
      envelopes,
      partial,
    });
    return envelopes.slice();
  }

  /** Caches a parsed transcript, evicting the least recently read one past the limit. */
  private rememberTranscriptRead(
    filePath: string,
    entry: {
      device: number;
      inode: number;
      size: number;
      envelopes: Record<string, unknown>[];
      partial: string;
    },
  ): void {
    // Re-inserting moves the key to the end, so the first key is always the one
    // read longest ago.
    this.sharedTranscriptReads.delete(filePath);
    this.sharedTranscriptReads.set(filePath, entry);
    while (
      this.sharedTranscriptReads.size >
      GjcSdkController.SHARED_TRANSCRIPT_CACHE_LIMIT
    ) {
      const oldest = this.sharedTranscriptReads.keys().next();
      if (oldest.done) break;
      this.sharedTranscriptReads.delete(oldest.value);
    }
  }

  private async readPersistedTranscript(
    sessionId: string,
  ): Promise<TranscriptItem[] | undefined> {
    const generation = this.generation;
    const revision = this.currentRunRevision(sessionId);
    const filePath = await this.locateSharedTranscriptFile(sessionId);
    if (!filePath) return undefined;
    this.watchSharedTranscript(sessionId, filePath);
    try {
      const info = await stat(filePath);
      if (!info.isFile() || info.size > 64 * 1024 * 1024) return undefined;
      const envelopes = await this.readTranscriptEnvelopes(filePath, info);
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
        generation === this.generation &&
        this.sessions.has(sessionId)
      ) {
        // This is a monotonic fact from the durable transcript, not a verdict about
        // the active run revision. Record it before any await so an older live phase
        // arriving from live events cannot overtake the file completion receipt.
        const previous = this.compactionRecordWatermark.get(sessionId);
        if (
          previous === undefined ||
          latestCompactionTimestamp > previous
        )
          this.compactionRecordWatermark.set(
            sessionId,
            latestCompactionTimestamp,
          );
      }
      const persistedTurn = persistedTurnState(envelopes);
      // A new compaction record is the durable completion receipt for the requested
      // cycle. It outranks a live `compacting` phase because that phase can remain
      // stuck in the in-memory marker when no separate idle update is delivered.
      // Only clear those live markers when the persisted turn is terminal; a real
      // concurrent prompt remains authoritative while its transcript is running.
      const baseline = this.compactionRecordBaseline.get(sessionId);
      const compactionCompleted =
        this.compactingSessions.has(sessionId) &&
        baseline !== undefined &&
        compactionRecordCount(envelopes) > baseline &&
        (this.compactionStartedAt.get(sessionId) === undefined ||
          (latestCompactionTimestamp !== undefined &&
            latestCompactionTimestamp >
              this.compactionStartedAt.get(sessionId)!)) &&
        !persistedTurn.running;

      // A full read is the only read that sees every launch row and every release row,
      // so it is where a session's detached work is settled: a job paused, cancelled,
      // or taken down with its process writes no release row, and its launch marker
      // would otherwise stay in the file forever. The bounded run-state read may never
      // meet the rows that name those markers, so nothing else asks about them.
      const pendingAsyncJobIds = await this.reconciledAsyncJobIds(
        sessionId,
        persistedTurn.pendingAsyncJobIds,
      );
      // A marker a reconciliation retired is not work again just because this read met
      // the same rows, and a marker it kept is still work however settled the rows here
      // look -- only the runtime can say that job ended.
      const transcriptRunning = persistedTurn.pendingAsyncWorkOnly
        ? pendingAsyncJobIds.length > 0
        : persistedTurn.running;
      const turnRunning =
        transcriptRunning ||
        this.activePromptSessions.has(sessionId) ||
        (this.workingPhaseSessions.has(sessionId) &&
          !this.runtimeIdleSessions.has(sessionId) &&
          !compactionCompleted);
      // A transcript that has not changed since the live signal reported work is the
      // same snapshot that signal already superseded, so it carries no news. Once the
      // file grows and still reports no active turn, it has observed the work end and
      // becomes the newer account. A terminal-owned session never sends
      // gjcRunning:false, so this is sufficient evidence for that kind of session. A
      // cycle that did emit a working phase also needs runtime idle before it settles.
      const seenSize = this.liveRunningDigests.get(sessionId);
      const transcriptAdvanced =
        seenSize !== undefined && info.size !== seenSize;
      const items = sharedTranscriptItems(sessionId, rows, { turnRunning });
      await this.resolveToolImages(items);
      const lifecycleCurrent =
        generation === this.generation &&
        revision === this.currentRunRevision(sessionId);
      if (lifecycleCurrent) {
        if (compactionCompleted) {
          this.compactingSessions.delete(sessionId);
          this.compactionRecordBaseline.delete(sessionId);
          this.compactionStartedAt.delete(sessionId);
          this.liveRunningSessions.delete(sessionId);
          this.liveRunningDigests.delete(sessionId);
          this.liveEvidenceAt.delete(sessionId);
          this.transcriptRunningSessions.delete(sessionId);
          this.discoveredRunStates.delete(sessionId);
          this.workingPhaseSessions.delete(sessionId);
          this.runtimeIdleSessions.delete(sessionId);
          this.patchSessionRuntime(sessionId, { phase: undefined });
        }
        // This read saw every row, so its account of what the session still owes
        // replaces the latch rather than merging with it: a marker these rows no
        // longer name has been released, and a bounded read must not resurrect it.
        this.recordPendingAsyncWork(sessionId, pendingAsyncJobIds);
      }
      const effectiveModel = persistedModelState(envelopes);
      if (
        effectiveModel.model ||
        effectiveModel.thinking ||
        Object.hasOwn(effectiveModel, "serviceTier")
      ) {
        this.patchSessionRuntime(sessionId, effectiveModel);
      }
      // A terminal-owned session gets no live phase report, so the transcript is the
      // only place its finished compaction is recorded.
      // `compactionCompleted` was handled before computing turnRunning so the
      // completion receipt can settle status in this same transcript read.
      if (lifecycleCurrent && !this.activePromptSessions.has(sessionId)) {
        const status = turnRunning ? "running" : "idle";
        const current = this.sessions.get(sessionId)?.status;
        if (status === "idle") {
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
            (!this.compactingSessions.has(sessionId) || compactionCompleted) &&
            (transcriptAdvanced || !this.liveRunningSessions.has(sessionId))
          ) {
            this.liveRunningSessions.delete(sessionId);
            this.liveRunningDigests.delete(sessionId);
            this.liveEvidenceAt.delete(sessionId);
            this.transcriptRunningSessions.delete(sessionId);
            this.discoveredRunStates.delete(sessionId);
            // The transcript has observed the work end, which outranks the last phase
            // GJC reported: leaving the marker set would keep rejecting every later
            // idle report and strand the row at 진행 중.
            this.workingPhaseSessions.delete(sessionId);
            this.runtimeIdleSessions.delete(sessionId);
            this.updateSessionStatus(sessionId, "idle");
          }
        } else if (
          current !== "idle" &&
          !this.locallyAbortedSessions.has(sessionId)
        ) {
          this.updateSessionStatus(sessionId, status);
        }
      }
      // A session owned by a terminal never attaches here, so its own transcript is the
      // only place that states which model it is actually running.
      const model = lastReportedModel(rows);
      if (model && this.sessions.get(sessionId)?.modelDisplay !== model) {
        this.patchSessionRuntime(sessionId, {
          modelDisplay: readableModelLabel(model),
        });
      }
      return items;
    } catch {
      this.sharedSessionFiles.delete(sessionId);
      return undefined;
    }
  }

  private watchSharedTranscript(sessionId: string, filePath: string): void {
    if (this.sharedSessionWatchers.has(sessionId) || this.disposed) return;
    try {
      const fileName = path.basename(filePath);
      const watcher = watch(
        path.dirname(filePath),
        { persistent: false },
        (_event, changedFile) => {
          if (changedFile && changedFile.toString() !== fileName) return;
          const previous = this.sharedSessionRefreshTimers.get(sessionId);
          if (previous) clearTimeout(previous);
          this.sharedSessionRefreshTimers.set(
            sessionId,
            setTimeout(() => {
              this.sharedSessionRefreshTimers.delete(sessionId);
              if (this.disposed) return;
              const previousItems = this.transcripts.get(sessionId);
              void this.readPersistedTranscript(sessionId).then((items) => {
                if (!items || this.disposed) return;
                const installed = this.installTranscript(sessionId, items);
                this.publishTranscriptSync(sessionId, previousItems, installed);
                // External terminal sessions do not publish usage events to this
                // renderer. Re-query after transcript changes so the first response
                // following compaction replaces the pending usage indicator immediately.
                void this.refreshContextUsage(sessionId);
                // A terminal-only row outside discovery has no run-state watcher of
                // its own, and the transcript read above never promotes idle to
                // running. Without this its status stays where it was opened.
                if (this.terminalOnlySessions.has(sessionId))
                  void this.republishRunState(sessionId);
              });
            }, 25),
          );
        },
      );
      watcher.on("error", () => {
        watcher.close();
        this.sharedSessionWatchers.delete(sessionId);
      });
      this.sharedSessionWatchers.set(sessionId, watcher);
    } catch {
      // Initial transcript loading still works when the filesystem cannot be watched.
    }
  }

  /**
   * Publish a transcript rescan as the items that actually changed.
   *
   * A rescan usually adds one row to an unchanged history, so shipping the whole
   * array cost a full clone plus a multi-megabyte IPC hop each time, and handed
   * the renderer fresh objects for every row -- which defeats the memo on each
   * transcript item and re-renders the entire list. Appends go out as individual
   * items; a rewritten history (compaction) still needs the full array.
   */
  private publishTranscriptSync(
    sessionId: string,
    previous: TranscriptItem[] | undefined,
    items: TranscriptItem[],
  ): void {
    const syncWholeHistory = (): void => {
      this.emitEvent({
        type: "transcript.synced",
        sessionId,
        items: items.map(cloneTranscriptItem),
      });
    };

    // No prior history, or a shorter one because compaction rewrote it.
    if (!previous || previous.length > items.length) {
      syncWholeHistory();
      return;
    }

    // A row can also disappear without the history getting shorter: a live row the
    // rebuild recorded under its own id, or one the ended turn never recorded. An
    // appended event cannot take a row away, so a history that dropped one is
    // republished whole -- the renderer's own merge retires the row when the rebuild
    // carries the same block, and this is what covers the rest.
    const present = new Set(items.map((item) => item.id));
    if (previous.some((item) => !present.has(item.id))) {
      syncWholeHistory();
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
    // The bounded window only limits how many changed rows are shipped in one
    // batch. Content still has to be compared across the whole shared prefix:
    // a parallel tool can settle on its original row long after 32 newer rows
    // were appended, and an id-only check left that card running here while the
    // installed history already had its result. Identity changes cannot be
    // expressed as appended items, so those still take the full-history route.
    for (let index = 0; index < windowStart; index += 1) {
      const before = previous[index];
      const after = items[index];
      if (!before || !after) break;
      if (before.id !== after.id) {
        syncWholeHistory();
        return;
      }
      if (!sameTranscriptItem(before, after)) changedIndices.push(index);
    }
    let reachedWindowStart = false;
    for (let index = shared - 1; index >= windowStart; index -= 1) {
      const before = previous[index];
      const after = items[index];
      if (!before || !after) break;
      if (sameTranscriptItem(before, after)) continue;
      if (before.id !== after.id) {
        syncWholeHistory();
        return;
      }
      changedIndices.push(index);
      if (index === windowStart) reachedWindowStart = true;
    }
    // The disagreement reaches the edge of a partial window, so rows before it
    // may have changed too; the whole history is the only safe account.
    if (reachedWindowStart && windowStart > 0) {
      syncWholeHistory();
      return;
    }
    // Additions after the shared prefix are always new rows.
    for (let index = shared; index < items.length; index += 1)
      changedIndices.push(index);
    if (changedIndices.length === 0) return;
    // Replacing many rows is cheaper as one array than as a burst of events.
    if (changedIndices.length > 16) {
      syncWholeHistory();
      return;
    }
    changedIndices.sort((left, right) => left - right);
    for (const index of changedIndices) {
      this.emitEvent({
        type: "transcript.appended",
        item: cloneTranscriptItem(items[index]!),
      });
    }
  }

  /** Inline the GJC blob store bytes so a read image renders in the transcript. */
  private async resolveToolImages(items: TranscriptItem[]): Promise<void> {
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
              const cached = this.imageDataUrls.get(image.blobId);
              if (cached) return { mimeType: image.mimeType, dataUrl: cached };
              try {
                const file = path.join(blobDirectory, image.blobId);
                const info = await stat(file);
                if (!info.isFile() || info.size > 12 * 1024 * 1024)
                  return undefined;
                const dataUrl = `data:${image.mimeType};base64,${(await readFile(file)).toString("base64")}`;
                if (this.imageDataUrls.size > 64) this.imageDataUrls.clear();
                this.imageDataUrls.set(image.blobId, dataUrl);
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

  private terminalOnlyNotice(sessionId: string): NoticeActivity {
    return {
      id: `terminal-only-${sessionId}`,
      kind: "notice",
      sessionId,
      title: "기록 보기 전용 · 실행 연결 없음",
      content:
        "저장된 대화는 열었지만 실행 제어 연결은 복구되지 않았습니다. 기록 조회는 계속 사용할 수 있습니다. 이어서 작업하려면 해당 CLI에서 세션을 다시 열거나 앱의 세션 이어서 진행을 다시 시도하세요. 앱은 기존 CLI를 종료하거나 새 세션으로 대체하지 않습니다.",
      tone: "neutral",
      createdAt: nowLabel(),
    };
  }

  private lifecycleUncertainNotice(sessionId: string): NoticeActivity {
    return {
      id: `lifecycle-uncertain-${sessionId}`,
      kind: "notice",
      sessionId,
      title: "저장된 세션을 검증할 수 없습니다",
      content:
        "네트워크 연결 문제가 아니라 GJC의 로컬 lifecycle 기록이 저장 결과와 일치하지 않는 상태입니다. GJC를 재시작한 뒤 다시 열어 보세요. 계속 발생하면 이 세션은 GJC reconciliation이 필요합니다.",
      tone: "warning",
      createdAt: nowLabel(),
    };
  }

  async setSessionConfig(
    sessionId: string,
    configId: string,
    value: string,
  ): Promise<void> {
    if (configId === "thinking") {
      await this.controlSession(sessionId, "thinking.set", { level: value });
      this.explicitSessionThinking.set(sessionId, value);
      this.patchSessionRuntime(sessionId, { thinking: value });
      const existing = this.sessionConfig.get(sessionId);
      if (existing) {
        const updated = existing.map((option) =>
          option.category === "thought_level" || option.id === "thinking"
            ? { ...option, currentValue: value }
            : option,
        );
        this.sessionConfig.set(sessionId, updated);
        this.emitEvent({ type: "session.config", sessionId, options: updated });
      }
      return;
    }
    if (configId === "model") {
      await this.controlSession(sessionId, "model.profile.set", { id: value });
      this.explicitSessionThinking.delete(sessionId);
      const existing = this.sessionConfig.get(sessionId);
      const selected = existing?.find(
        (option) => option.category === "model" || option.id === "model",
      );
      const display =
        selected?.options?.find((option) => option.value === value)?.name ??
        value;
      this.patchSessionRuntime(sessionId, {
        model: value,
        modelDisplay: display,
      });
      if (existing) {
        const updated = existing.map((option) =>
          option.category === "model" || option.id === "model"
            ? { ...option, currentValue: value }
            : option,
        );
        this.sessionConfig.set(sessionId, updated);
        this.emitEvent({ type: "session.config", sessionId, options: updated });
      }
      await this.refreshSessionSettings(sessionId);
      await this.refreshModelProfiles(sessionId);
      return;
    }
    // Any other selector is a session config value; `config.patch` is the control
    // operation that sets one, and the session's own config is re-read after.
    await this.ensureAttached(sessionId, false);
    await this.controlSession(sessionId, "config.patch", {
      patch: { [configId]: value },
    });
    await this.refreshSessionConfigOptions(sessionId);
  }

  async cycleThinking(sessionId: string): Promise<string | undefined> {
    const result = await this.controlSession(sessionId, "thinking.cycle", {});
    const level =
      result && typeof result.level === "string" ? result.level : undefined;
    if (!level) return undefined;
    this.explicitSessionThinking.set(sessionId, level);
    this.patchSessionRuntime(sessionId, { thinking: level });
    const existing = this.sessionConfig.get(sessionId);
    if (existing) {
      const updated = existing.map((option) =>
        option.category === "thought_level" || option.id === "thinking"
          ? { ...option, currentValue: level }
          : option,
      );
      this.sessionConfig.set(sessionId, updated);
      this.emitEvent({ type: "session.config", sessionId, options: updated });
    }
    return level;
  }

  // A session proven uncontrollable is recorded so the row stops advertising a
  // control surface it does not have, instead of failing again on the next action.
  private markTerminalOnly(sessionId: string): void {
    this.terminalOnlySessions.add(sessionId);
    this.attachedSessions.delete(sessionId);
    this.stopTailFollower(sessionId);
    // The reuse fingerprint only covers broker liveness, which this discovery does
    // not change. Without invalidating it the next scan replays the snapshot taken
    // before the failure and the row goes back to advertising controls.
    this.lastLiveFingerprint = undefined;
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.attachment = "terminal-only";
    session.ownership = "external";
    this.lastDiscovered = this.lastDiscovered.map((row) =>
      row.id === sessionId ? { ...session } : row,
    );
    this.emitEvent({ type: "session.updated", session: { ...session } });
  }

  /**
   * Notes the transcript size at the moment live work was reported. A read failure
   * leaves no baseline, which makes the next transcript snapshot authoritative --
   * the safe direction, since the alternative is a row stuck on running.
   */
  private async rememberLiveRunningTranscriptSize(
    sessionId: string,
  ): Promise<void> {
    try {
      const filePath = await this.locateSharedTranscriptFile(sessionId);
      if (!filePath) return;
      const info = await stat(filePath);
      if (this.liveRunningSessions.has(sessionId))
        this.liveRunningDigests.set(sessionId, info.size);
    } catch {
      // No baseline recorded: the transcript wins next time.
    }
  }

  /** Counts compactions already recorded on disk, or reports an unavailable baseline. */
  private async persistedCompactionCount(
    sessionId: string,
  ): Promise<number | undefined> {
    try {
      const filePath = await this.locateSharedTranscriptFile(sessionId);
      if (!filePath) return undefined;
      const info = await stat(filePath);
      return compactionRecordCount(
        await this.readTranscriptEnvelopes(filePath, info),
      );
    } catch {
      // Zero means the transcript was read and contained no compactions. Treating
      // an I/O failure as zero lets any historical record falsely finish new work.
      return undefined;
    }
  }

  async compactSession(sessionId: string): Promise<void> {
    // Compaction is a session control operation. Terminal-owned sessions route
    // through the broker instead of requiring a second runtime attachment.
    const statusBefore = this.sessions.get(sessionId)?.status;
    const baseline = await this.persistedCompactionCount(sessionId);
    this.compactingSessions.add(sessionId);
    this.compactionStartedAt.delete(sessionId);
    if (baseline === undefined)
      this.compactionRecordBaseline.delete(sessionId);
    else this.compactionRecordBaseline.set(sessionId, baseline);
    this.patchSessionRuntime(sessionId, {
      phase: "compacting",
      status: "running",
    });
    try {
      await this.controlSession(sessionId, "compaction.run", {});
      // GJC intentionally reports null usage after compaction until a later model
      // response provides a trustworthy provider anchor. Never leave the stale
      // pre-compaction percentage visible while that new value is pending.
      this.patchSessionRuntime(sessionId, {
        usagePercent: undefined,
        usagePending: true,
      });
      await this.refreshContextUsage(sessionId);
    } catch (error) {
      // Compaction marked the row running. Leaving it there after a failure keeps
      // the composer queueing behind a turn that never started, so the status it
      // replaced is restored -- and only that one, or a real turn running
      // underneath would be reported idle.
      this.compactingSessions.delete(sessionId);
      this.compactionRecordBaseline.delete(sessionId);
      this.compactionStartedAt.delete(sessionId);
      this.patchSessionRuntime(sessionId, {
        phase: undefined,
        ...(statusBefore && statusBefore !== "running"
          ? { status: statusBefore }
          : {}),
      });
      throw error;
    }
    // The control call returning means GJC accepted the request, not that the
    // history has been rewritten. Clearing the phase here reported compaction
    // finished while it was still running, so the phase is left standing until
    // GJC reports a non-compacting phase through patchSessionInfo.
  }

  private appendLocalUserMessage(
    sessionId: string,
    text: string,
    input: ResolvedMessageInput,
  ): void {
    const echoes = this.echoedPromptTexts.get(sessionId) ?? [];
    echoes.push(normalizeQueuedRequestText(text));
    this.echoedPromptTexts.set(sessionId, echoes);
    const message: ChatMessage = {
      id: `local-prompt-${this.nextLocalId++}`,
      kind: "message",
      sessionId,
      role: "user",
      content: sanitizeLocalAttachmentBlocks(text),
      ...(input.images?.length
        ? {
            images: input.images.map(
              ({ nativePath: _nativePath, ...image }) => image,
            ),
          }
        : {}),
      createdAt: nowLabel(),
      streaming: false,
    };
    this.appendTranscript(message);
  }

  // Returns true when this user update is GJC repeating a prompt already shown.
  private consumePromptEcho(sessionId: string, text: string): boolean {
    const echoes = this.echoedPromptTexts.get(sessionId);
    if (!echoes?.length) return false;
    const normalized = normalizeQueuedRequestText(text);
    const index = echoes.indexOf(normalized);
    if (index < 0) return false;
    echoes.splice(index, 1);
    if (echoes.length === 0) this.echoedPromptTexts.delete(sessionId);
    return true;
  }

  // Waiting work is hidden from the transcript only while it is still waiting.
  // The count is what makes this correct: two identical queued requests must
  // survive one being consumed, and the last release must un-hide the bubble so a
  // consumed steer reads like any other user message.

  // The authoritative queue is the only thing that says what is still waiting.
  // Anything the app once hid but GJC no longer lists has been consumed, so its
  // suppression is dropped and the message becomes a visible user bubble.



  async steerSession(
    sessionId: string,
    input: ResolvedMessageInput,
    options?: { echo?: boolean },
  ): Promise<void> {
    const text = messageTextWithFiles(input)
      .replace(/^\/steer(?:\s+|$)/u, "")
      .trim();
    if (!text) throw new Error("Steering instructions are required");
    // A steer is a user message too. Echoing it before the round trip is what
    // makes it appear immediately; without this the bubble waits for GJC to
    // stream its own user_message_chunk back, which is seconds late on a busy
    // turn and reads as the window having swallowed the message. Callers that
    // already echoed the same text pass echo: false so it is not shown twice.
    if (options?.echo !== false) this.appendLocalUserMessage(sessionId, text, input);
    const pending = this.controlSession(sessionId, "turn.steer", {
      text,
      clientRef: `gajae-steer-${randomUUID()}`,
    }).then(() => undefined);
    const previous = this.pendingSteers.get(sessionId);
    const chained = previous
      ? previous.then(
          () => pending,
          () => pending,
        )
      : pending;
    this.pendingSteers.set(sessionId, chained);
    try {
      await pending;
    } finally {
      if (this.pendingSteers.get(sessionId) === chained)
        this.pendingSteers.delete(sessionId);
    }
  }

  async queueFollowUp(sessionId: string, input: ResolvedMessageInput): Promise<void> {
    const text = messageTextWithFiles(input);
    if (!text) throw new Error("Follow-up text is required");
    try {
      await this.ensureAttached(sessionId, false);
    } catch {
      if (
        !this.terminalOnlySessions.has(sessionId) ||
        this.sessions.get(sessionId)?.ownership !== "external"
      )
        throw new Error("세션 제어 상태를 확인할 수 없어 후속 메시지를 보내지 않았습니다.");
    }
    await this.controlSession(sessionId, "turn.follow_up", { text });
  }

  /**
   * One control operation over `gjc sdk session raw control`.
   *
   * There used to be a private in-process extension path with this CLI as fallback,
   * and the two could disagree about whether an operation was accepted. The CLI is
   * now the only path, so there is one answer per operation and no fallback to
   * reconcile.
   */
  private async controlSession(
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
      | "btw.ask",
    input: Record<string, unknown>,
    options?: { confirm?: boolean; idempotencyKey?: string },
  ): Promise<Record<string, unknown> | undefined> {
    const cli = await this.requireCli();
    // A terminal abort is the only operation that needs a key of its own, and the
    // key must be stable across a retry of the same user action.
    const idempotencyKey =
      options?.idempotencyKey ??
      (operation === "turn.abort" && input.mode === "terminal"
        ? `gajae-abort-${randomUUID()}`
        : undefined);
    try {
      return await cli.rawControl(sessionId, operation, input, {
        repo: this.repoFor(sessionId),
        ...(idempotencyKey ? { idempotencyKey } : {}),
        // An operator terminal abort is destructive and the host requires the flag.
        confirm: options?.confirm === true || input.operator === true,
      });
    } catch (error) {
      if (busyPromptError(error)) throw error;
      // A session with no SDK endpoint is reported once, in terms the user can act
      // on, instead of each caller surfacing the broker's routing language.
      if (isSessionUnreachable(error)) {
        if (operation === "turn.abort" && input.operator === true) {
          try {
            await cli.queryItems(sessionId, "session.metadata", {}, { repo: this.repoFor(sessionId) });
          } catch {
            this.markTerminalOnly(sessionId);
            throw new Error(SHARED_ROUTE_UNAVAILABLE_MESSAGE);
          }
          this.terminalOnlySessions.delete(sessionId);
          throw new OwnedStopUnavailableError();
        }
        this.markTerminalOnly(sessionId);
        throw new Error(SHARED_ROUTE_UNAVAILABLE_MESSAGE);
      }
      throw new Error(brokerFailureMessage(error));
    }
  }

  async listQueuedMessages(sessionId: string): Promise<QueuedMessage[]> {
    try {
      const queued: QueuedMessage[] = [];
      for (const row of await this.querySessionItems(
        sessionId,
        "queue.messages.list",
        {},
        { strict: true },
      )) {
        if (!row || typeof row !== "object" || Array.isArray(row)) continue;
        const value = row as Record<string, unknown>;
        if (typeof value.id !== "string" || typeof value.text !== "string")
          continue;
        const mode = value.mode === "steer" ? "steer" : "followUp";
        queued.push({
          id: value.id,
          text: value.text,
          mode,
          label:
            typeof value.label === "string" && value.label
              ? value.label
              : mode === "steer"
                ? "Steer"
                : "Queued",
        });
      }
      return queued;
    } catch {
      return [];
    }
  }

  /**
   * GJC CLI empty submit: interrupt the current stream so the window can hand over
   * the requests it is holding.
   */
  async flushQueuedNow(sessionId: string): Promise<boolean> {
    if (this.flushingSessions.has(sessionId)) return true;
    this.flushingSessions.add(sessionId);
    try {
      const pendingSteer = this.pendingSteers.get(sessionId);
      if (pendingSteer) await pendingSteer.catch(() => undefined);
      // The window owns its pending queue, so it already knows there is work to
      // release. GJC reports no waiting steer of its own -- turn.steer is consumed
      // by the open turn -- so there is nothing here to confirm against.
      //
      // A host that refuses the operator-owned Stop still serves ordinary control,
      // and the held work is released by the renderer as a steer that the next turn
      // boundary consumes. Failing that refusal here would leave the user's text
      // stuck in the composer over a stop this window was never able to substantiate
      // anyway, so the refusal is not an error for a release. A session the metadata
      // probe could not reach still throws (see controlSession).
      let stopped = false;
      try {
        await this.abortOwnedThroughControl(sessionId);
        stopped = true;
      } catch (error) {
        if (!(error instanceof OwnedStopUnavailableError)) throw error;
      }
      // A release only marks the row running when a turn could not be stopped. A
      // confirmed stop means the turn is over, and a host that never granted this
      // window the operator Stop is answered by the transcript instead. Publishing
      // running unconditionally was how a release against an already finished row
      // left it looking mid-turn: every later message then arrived as a steer
      // behind a turn that had ended, which is the queue the user watched swallow
      // their text.
      const stillRunning =
        !stopped && (await this.discoveredRunState(sessionId)) === "running";
      this.updateSessionStatus(sessionId, stillRunning ? "running" : "idle", {
        announce: false,
      });
      return true;
    } catch (error) {
      if (uncertainAfterSendError(error) || cancelledOperationError(error)) {
        this.updateSessionStatus(sessionId, "running");
        return true;
      }
      throw error;
    } finally {
      this.flushingSessions.delete(sessionId);
    }
  }

  private appendSdkCommandOutput(
    sessionId: string,
    content: string,
  ): void {
    const message: ChatMessage = {
      id: `sdk-command-${this.nextLocalId++}`,
      kind: "message",
      sessionId,
      role: "assistant",
      content,
      createdAt: nowLabel(),
      streaming: false,
    };
    this.appendTranscript(message);
    const session = this.sessions.get(sessionId);
    if (session)
      this.emitEvent({ type: "session.updated", session: { ...session } });
  }

  private sdkCommandJson(value: unknown): string {
    const text = JSON.stringify(value, null, 2) ?? String(value);
    const bounded =
      text.length <= MAX_TOOL_TEXT
        ? text
        : `${text.slice(0, MAX_TOOL_TEXT)}\n… output truncated`;
    return `\`\`\`json\n${bounded}\n\`\`\``;
  }

  private async executeSdkSlashCommand(
    sessionId: string,
    input: ResolvedMessageInput,
    options?: SendMessageOptions,
  ): Promise<boolean> {
    if (input.images?.length || input.files?.length) return false;
    const match = /^\/([a-z][a-z0-9-]*)(?:\s+([\s\S]*))?$/iu.exec(
      input.text.trim(),
    );
    if (!match?.[1]) return false;
    const name = match[1].toLowerCase();
    const args = match[2]?.trim() ?? "";
    const destructive = destructiveSlashAction(input);
    if (destructive && !options?.allowDestructive)
      throw new Error(`${destructiveSlashMessage(destructive)} 데스크톱 확인이 필요한 작업입니다. 이 경로에서는 실행하지 않았습니다.`);
    const spec = SDK_SLASH_COMMAND_SPECS.find(
      (candidate) => candidate.name === name,
    );
    if (!spec) return false;
    const operations = await this.sdkOperations(sessionId);
    // A recognized command whose capability this runtime does not advertise is
    // refused rather than forwarded as prompt text: the same characters would reach
    // the model as a user request for work GJC just said it cannot dispatch.
    if (!spec.operations.some((operation) => operations.has(operation)))
      throw new Error(
        `/${name} is unavailable in this GJC runtime (${spec.operations.join(" and ")} not advertised)`,
      );

    const requireOperation = (operation: string): void => {
      if (!operations.has(operation))
        throw new Error(
          `/${name} is unavailable in this GJC runtime (${operation} is not advertised)`,
        );
    };
    const output = (content: string): true => {
      this.appendSdkCommandOutput(sessionId, content);
      return true;
    };
    const query = async (
      operation: string,
      queryInput: Record<string, unknown> = {},
    ): Promise<unknown[]> => {
      requireOperation(operation);
      return await this.querySessionItems(sessionId, operation, queryInput, {
        strict: true,
      });
    };
    const control = async (
      operation:
        | "mode.goal.operate"
        | "model.profile.set"
        | "thinking.set"
        | "service_tier.set"
        | "session.export_html"
        | "context.clear"
        | "compaction.run"
        | "session.rename"
        | "session.cwd.move"
        | "retry.last"
        | "bash.background"
        | "runtime.reload"
        | "mode.plan.set"
        | "auth.login"
        | "btw.ask",
      controlInput: Record<string, unknown> = {},
      options?: { confirm?: boolean },
    ): Promise<Record<string, unknown> | undefined> => {
      requireOperation(operation);
      return await this.controlSession(
        sessionId,
        operation,
        controlInput,
        options,
      );
    };

    switch (name) {
      case "btw": {
        if (!args) throw new Error("Usage: /btw <question>");
        const result = await control("btw.ask", { question: args });
        const reply =
          typeof result?.reply === "string" ? result.reply.trim() : "";
        if (!reply) throw new Error("GJC returned no /btw answer");
        // The runtime answers from this session's own context and keeps nothing:
        // the reply is an app-owned row like every other SDK command output, so
        // the GJC transcript this window mirrors never gains the side question.
        const question = args
          .split("\n")
          .map((line) => `> ${line}`)
          .join("\n");
        return output(["## Side question", question, "", reply].join("\n"));
      }
      case "context": {
        if (args) throw new Error("Usage: /context");
        const rows = await query("context.get");
        const row = rows[0] as Record<string, unknown> | undefined;
        const usage =
          row?.usage &&
          typeof row.usage === "object" &&
          !Array.isArray(row.usage)
            ? (row.usage as Record<string, unknown>)
            : undefined;
        return output(
          [
            "## Context",
            `- Window: ${typeof usage?.contextWindow === "number" ? usage.contextWindow.toLocaleString() : "unknown"} tokens`,
            `- Used: ${typeof usage?.percent === "number" ? `${usage.percent.toFixed(1)}%` : "unknown"}`,
            `- Source: ${typeof usage?.source === "string" ? usage.source : "unknown"}`,
            `- Streaming: ${row?.isStreaming === true ? "yes" : "no"}`,
            `- Steers queued: ${typeof row?.steeringQueueDepth === "number" ? row.steeringQueueDepth : 0}`,
            `- Follow-ups queued: ${typeof row?.followupQueueDepth === "number" ? row.followupQueueDepth : 0}`,
          ].join("\n"),
        );
      }
      case "usage":
        if (args) throw new Error("Usage: /usage");
        return output(this.sdkCommandJson(await query("usage.get")));
      case "tools":
        if (args) throw new Error("Usage: /tools");
        return output(
          `## Tools\n${(await query("tools.list")).map((tool) => `- ${String(tool)}`).join("\n")}`,
        );
      case "jobs":
        if (args) throw new Error("Usage: /jobs");
        return output(this.sdkCommandJson(await query("runtime.jobs.list")));
      case "session": {
        const subcommand = args || "info";
        if (subcommand === "delete") {
          await this.deleteSession(sessionId);
          return true;
        }
        if (subcommand !== "info")
          throw new Error("Usage: /session [info|delete]");
        const [metadata, stats] = await Promise.all([
          query("session.metadata"),
          query("session.stats"),
        ]);
        return output(this.sdkCommandJson({ metadata: metadata[0], stats: stats[0] }));
      }
      case "transcript":
      case "dump":
        if (args) throw new Error(`Usage: /${name}`);
        return output(this.sdkCommandJson(await query("transcript.list")));
      case "extensions":
        if (args) throw new Error("Usage: /extensions");
        return output(this.sdkCommandJson(await query("extensions.list")));
      case "provider": {
        const login = /^login\s+(.+)$/iu.exec(args);
        if (login?.[1]) {
          const result = await control("auth.login", {
            provider: login[1].trim(),
          });
          return output(this.sdkCommandJson(result ?? { accepted: true }));
        }
        if (args) throw new Error("Usage: /provider [login <provider>]");
        const [active, auth] = await Promise.all([
          operations.has("providers.list/active")
            ? query("providers.list/active")
            : Promise.resolve([]),
          operations.has("auth.providers")
            ? query("auth.providers")
            : Promise.resolve([]),
        ]);
        return output(this.sdkCommandJson({ active, authentication: auth }));
      }
      case "credential":
        if (args) throw new Error("Credential switching is not exposed by this SDK runtime");
        return output(this.sdkCommandJson(await query("auth.providers")));
      case "goal": {
        const [verb = "show", ...rest] = args.split(/\s+/u).filter(Boolean);
        if (verb === "show" || verb === "get")
          return output(this.sdkCommandJson(await query("goal.list/get")));
        const op = verb === "set" ? "create" : verb;
        if (!new Set(["create", "pause", "resume", "complete", "drop"]).has(op))
          throw new Error(
            "Usage: /goal [set|show|pause|resume|complete|drop] [objective]",
          );
        const objective = rest.join(" ");
        if (op === "create" && !objective)
          throw new Error("Usage: /goal set <objective>");
        const result = await control("mode.goal.operate", {
          op,
          ...(objective ? { objective } : {}),
        });
        return output(this.sdkCommandJson(result ?? { accepted: true }));
      }
      case "model": {
        if (!args)
          return output(
            this.sdkCommandJson(await query("models.profiles.list")),
          );
        const result = await control("model.profile.set", { id: args });
        return output(this.sdkCommandJson(result ?? { profile: args }));
      }
      case "effort": {
        if (!args)
          return output(
            `Current effort: ${this.sessions.get(sessionId)?.thinking ?? "inherit"}`,
          );
        const result = await control("thinking.set", { level: args });
        return output(this.sdkCommandJson(result ?? { level: args }));
      }
      case "fast": {
        const verb = (args || "toggle").toLowerCase();
        if (!["toggle", "on", "off", "status"].includes(verb))
          throw new Error("Usage: /fast [toggle|on|off|status]");
        // The window only knows the tier the session reported (its transcript's
        // last `service_tier_change` or a tier this window set itself), and GJC
        // resolves that intent per provider. Every branch below therefore reports
        // the configured tier, never a claim that the provider honored it.
        const current = this.sessions.get(sessionId)?.serviceTier;
        const enabled =
          current !== undefined && SDK_FAST_SERVICE_TIERS.has(current);
        if (verb === "status")
          return output(
            [
              "## Fast mode",
              // A session that never recorded a tier reports none, and none means
              // no fast intent. The line says which of the two it is instead of
              // presenting an unread tier as a state the runtime confirmed.
              `- Intent: ${enabled ? "on" : current ? "off" : "off (no tier reported)"}`,
              `- Configured tier: ${current ?? "none reported"}`,
              "- Configured intent only: GJC decides per provider and model whether a",
              "  request actually carries the fast/priority tier.",
            ].join("\n"),
          );
        const enable = verb === "on" ? true : verb === "off" ? false : !enabled;
        // A toggle has to know the tier it is inverting: the runtime's own tier can
        // come from the user's global serviceTier setting, so guessing "off" would
        // silently downgrade a scoped tier. Ask the session's config once, and
        // refuse rather than flip a state this window cannot read.
        const tierSource =
          verb === "toggle" && current === undefined
            ? ((await this.sessionConfigRow(sessionId))?.serviceTier as
                | string
                | undefined)
            : current;
        if (verb === "toggle" && tierSource === undefined)
          throw new Error(
            "This session does not report its current service tier, so /fast cannot toggle it. Use /fast on or /fast off.",
          );
        const tier =
          enable
            ? tierSource && SDK_SCOPED_FAST_SERVICE_TIERS.has(tierSource)
              ? tierSource
              : "priority"
            : SDK_SERVICE_TIER_OFF;
        const result = await control("service_tier.set", { tier });
        // Mirror what the runtime recorded, including the "none" that stands for a
        // cleared tier, so the next status reads off instead of unknown.
        this.patchSessionRuntime(sessionId, { serviceTier: tier });
        return output(
          `Fast mode ${enable ? "enabled" : "disabled"} (configured tier: ${tier}).\n${this.sdkCommandJson(result ?? { tier })}`,
        );
      }
      case "skills": {
        if (args) throw new Error("Usage: /skills");
        const skills = (await query("skill.list/state")).flatMap((row) => {
          if (!row || typeof row !== "object" || Array.isArray(row)) return [];
          const value = row as Record<string, unknown>;
          if (typeof value.name !== "string" || !value.name) return [];
          const description =
            typeof value.description === "string" ? value.description : "";
          return [`- ${value.name}${description ? ` — ${description}` : ""}`];
        });
        return output(
          [
            "## Skills",
            ...(skills.length > 0
              ? skills
              : ["- This session reports no skills."]),
            "Run one as agent work with `/skill:<name> <request>`.",
          ].join("\n"),
        );
      }
      case "progress":
        if (args) throw new Error("Usage: /progress");
        return output(this.sdkCommandJson(await query("session.progress")));
      case "reload": {
        const requested = args.split(/[\s,]+/u).filter(Boolean);
        const unknown = requested.filter(
          (component) =>
            !(SDK_RELOAD_COMPONENTS as readonly string[]).includes(component),
        );
        if (unknown.length > 0)
          throw new Error(
            `Unknown reload component: ${unknown.join(", ")}. Use one or more of ${SDK_RELOAD_COMPONENTS.join(", ")}.`,
          );
        const components =
          requested.length > 0
            ? [...new Set(requested)]
            : [...SDK_RELOAD_COMPONENTS];
        // gjc/0.18.11 validates this list and then reloads the whole session
        // (`AgentSession.reload`); the per-component split is the runtime's to
        // apply, so the reply reports what was requested and what it answered.
        const result = await control("runtime.reload", { components });
        // A reload re-reads skills, extensions, and config from disk, so the
        // palette this window derived from the old ones is stale the moment it
        // succeeds. Rebuild both sides of the session's reported surface.
        await Promise.all([
          this.refreshSdkCommands(sessionId),
          this.refreshModelProfiles(sessionId).catch(() => undefined),
          this.refreshSessionConfigOptions(sessionId).catch(() => undefined),
        ]);
        return output(
          `Reload requested for ${components.join(", ")}.\n${this.sdkCommandJson(result ?? { reloaded: true })}`,
        );
      }
      case "plan": {
        if (args !== "on" && args !== "off")
          throw new Error("Usage: /plan [on|off]");
        const on = args === "on";
        const result = await control("mode.plan.set", { on });
        if (typeof result?.enabled === "boolean")
          this.patchSessionRuntime(sessionId, {
            mode: result.enabled ? "plan" : "default",
          });
        return output(this.sdkCommandJson(result ?? { enabled: on }));
      }
      case "export": {
        if (args) throw new Error("This SDK exports to its managed HTML path; use /export without a path");
        const result = await control("session.export_html");
        return output(this.sdkCommandJson(result ?? { exported: true }));
      }
      case "clear":
        if (args) throw new Error("Usage: /clear");
        await control("context.clear", {}, { confirm: true });
        return output("Context cleared. The session ID and durable transcript were preserved.");
      case "compact":
        if (args) throw new Error("Use the compact action without inline instructions in this client");
        await this.compactSession(sessionId);
        return true;
      case "retry":
        if (args) throw new Error("Usage: /retry");
        return output(
          this.sdkCommandJson((await control("retry.last")) ?? { accepted: true }),
        );
      case "background":
        if (args) throw new Error("Usage: /background");
        return output(
          this.sdkCommandJson(
            (await control("bash.background")) ?? { accepted: true },
          ),
        );
      case "rename":
        if (!args) throw new Error("Usage: /rename <title>");
        await this.renameSession(sessionId, args);
        return output(`Session renamed to **${args}**.`);
      case "move":
        if (!args) throw new Error("Usage: /move <path>");
        {
          const result = await control("session.cwd.move", { path: args });
          const cwd =
            typeof result?.cwd === "string"
              ? result.cwd
              : path.resolve(this.sessionCwds.get(sessionId) ?? this.workspace, args);
          const session = this.sessions.get(sessionId);
          if (session) {
            this.sessionCwds.set(sessionId, cwd);
            this.sessionMetadata?.setWorkspace(sessionId, cwd);
            session.workspace = cwd;
            session.subtitle = path.basename(cwd) || cwd;
            markUpdated(session);
            this.emitEvent({ type: "session.updated", session: { ...session } });
          }
          return output(this.sdkCommandJson(result ?? { moved: true, cwd }));
        }
      default:
        return false;
    }
  }

  async sendMessage(
    sessionId: string,
    input: ResolvedMessageInput,
    options?: SendMessageOptions,
  ): Promise<MessageDelivery> {
    this.locallyAbortedSessions.delete(sessionId);
    if (await this.executeSdkSlashCommand(sessionId, input, options))
      return "prompt";
    const value = input.text.trim();
    if (/^\/steer(?:\s+|$)/u.test(value)) {
      await this.steerSession(sessionId, input);
      return "steer";
    }
    // `bare` is the user's own text; `promptText` adds the attachment block.
    // steerSession composes the block itself, so the steer fallbacks below hand
    // it `bare` -- passing promptText appended the same block a second time.
    const bare = value.replace(/^\/queue(?:\s+|$)/u, "").trim();
    const promptText = bare + attachedPathsText(input);
    if (!promptText) return "prompt";
    const session = this.sessions.get(sessionId);
    if (
      this.activePromptSessions.has(sessionId) ||
      session?.status === "running"
    ) {
      await this.steerSession(sessionId, { ...input, text: bare });
      return "steer";
    }
    const admission = Symbol(sessionId);
    this.activePromptAdmissions.set(sessionId, admission);
    this.activePromptSessions.add(sessionId);

    // The bubble is echoed before any await so the window shows the request the
    // moment it is submitted. Connecting and attaching are round trips, and doing
    // them first left the composer looking like it had swallowed the message.
    this.activeAssistantMessages.delete(sessionId);
    this.finalizeThought(sessionId);
    this.appendLocalUserMessage(sessionId, promptText, input);
    this.updateSessionStatus(sessionId, "running");

    try {
      const cli = await this.requireCli();
      await this.ensureAttached(sessionId, false);
      // One fresh operation reference per logical prompt. A reused reference is
      // rejected as a conflict while its record is retained, and after eviction it
      // could be admitted again with the first outcome unknown, so a retry must
      // never recycle one.
      const operationRef = freshOperationRef();
      let accepted: Awaited<ReturnType<GjcSdkCli["send"]>> | undefined;
      let alreadySettled = false;
      try {
        accepted = await cli.send(sessionId, promptText, {
          repo: this.repoFor(sessionId),
          opRef: operationRef,
        });
      } catch (error) {
        if (!uncertainAfterSendError(error)) throw error;
        // The frame may already have reached the host. Never retry the logical
        // prompt or reuse its reference; reconcile that exact reference instead.
        const outcome = await this.awaitPromptSettlement(
          sessionId,
          operationRef,
        );
        if (outcome === "unknown") {
          // This send may have been cancelled and replaced while its settlement
          // was being read. Only the original admission may publish the run state.
          if (this.activePromptAdmissions.get(sessionId) === admission)
            this.updateSessionStatus(sessionId, "running");
          return "prompt";
        }
        alreadySettled = true;
      }
      if (accepted?.status === "failed")
        throw new Error("GJC rejected the prompt");
      // `send` returning means the prompt was *accepted*, not that the agent
      // stopped. A follow-up turn, a released steer, or background work keeps running
      // and keeps appending to the transcript, so closing the row here reported 완료
      // over live work. The prompt record and the session's own transcript are the
      // accounts that cover what a single CLI call cannot see, so they decide.
      const settlement = alreadySettled
        ? "terminal"
        : await this.awaitPromptSettlement(sessionId, operationRef);
      if (settlement === "unknown") {
        // Poll exhaustion or unavailable evidence is not a terminal event. The
        // file watcher and tail follower remain responsible for the later state.
        if (this.activePromptAdmissions.get(sessionId) === admission)
          this.updateSessionStatus(sessionId, "running");
        return "prompt";
      }
      // A cancel or a newer prompt may have replaced this run while its
      // settlement was being read. Finalizing now would close the thought and
      // stream of the run that owns the row instead.
      if (this.activePromptAdmissions.get(sessionId) !== admission)
        return "prompt";
      this.finalizeThought(sessionId);
      this.finalizeAssistantMessage(sessionId);
      await this.refreshContextUsage(sessionId);
      // updateSessionStatus announces the running -> idle transition itself.
      //
      // The prompt is released before the read because the run-state cache is keyed on
      // the file, not the caller, and leaving this session marked as actively prompted
      // would let a concurrent republish skip it. `finally` releasing it again is a
      // no-op on a Set.
      const settlementGeneration = this.generation;
      const settlementRevision = this.currentRunRevision(sessionId);
      const ownsRow = this.activePromptAdmissions.get(sessionId) === admission;
      if (ownsRow) {
        this.activePromptAdmissions.delete(sessionId);
        this.activePromptSessions.delete(sessionId);
      }
      const stillRunning = await this.discoveredRunState(sessionId);
      if (
        ownsRow &&
        settlementGeneration === this.generation &&
        settlementRevision === this.currentRunRevision(sessionId)
      )
        this.updateSessionStatus(
          sessionId,
          stillRunning === "running" ? "running" : "idle",
        );
    } catch (caught) {
      let error: unknown = caught;
      // The user cancelled this send, or a newer prompt took the row while this
      // one was in flight. Its late failure belongs to a run that no longer
      // owns the window: settling here finalized the newer run's streaming
      // message, published idle over it, and appended a failure notice for the
      // prompt that was already cancelled.
      if (this.activePromptAdmissions.get(sessionId) !== admission)
        return "prompt";
      if (busyPromptError(error)) {
        this.activePromptSessions.delete(sessionId);
        await this.steerSession(
          sessionId,
          { ...input, text: bare },
          { echo: false },
        );
        return "steer";
      }
      if (isSessionUnreachable(error)) {
        this.markTerminalOnly(sessionId);
        error = new Error(SHARED_ROUTE_UNAVAILABLE_MESSAGE);
      }
      this.finalizeThought(sessionId);
      this.finalizeAssistantMessage(sessionId);
      void this.refreshContextUsage(sessionId);
      if (cancelledOperationError(error)) {
        // A cancel is the user's own action, so it settles quietly.
        this.updateSessionStatus(sessionId, "idle", { announce: false });
        this.appendCancelledNotice(sessionId);
        return "prompt";
      }
      // A failed run is announced as a failure below, so the idle transition must
      // not also announce a completion.
      this.updateSessionStatus(sessionId, "idle", { announce: false });
      const notice: NoticeActivity = {
        id: `gjc-error-${this.nextLocalId++}`,
        kind: "notice",
        sessionId,
        title: "GJC run failed",
        content: error instanceof Error ? error.message : String(error),
        tone: "warning",
        createdAt: nowLabel(),
      };
      this.appendTranscript(notice);
      this.emitActivity(sessionId, "failed");
      throw error;
    } finally {
      if (this.activePromptAdmissions.get(sessionId) === admission) {
        this.activePromptAdmissions.delete(sessionId);
        this.activePromptSessions.delete(sessionId);
      }
    }
    return "prompt";
  }

  /**
   * Waits for an accepted prompt to reach a terminal record.
   *
   * The semantic `send` call returns at acceptance rather than holding open for the
   * whole turn, so the window's spinner and final status need reconciliation. The
   * turn is followed here instead: `status` is the lossless record, and the
   * transcript is watched in parallel by the session-file watcher.
   *
   * A prompt that is still running when the poll budget ends is left running. This
   * never forces the row idle and never reports a cancel, because `unknown` and
   * "still going" are both uncertainty, not proof the work stopped.
   */
  private async awaitPromptSettlement(
    sessionId: string,
    operationRef: string,
  ): Promise<"terminal" | "unknown"> {
    const generation = this.generation;
    for (let attempt = 0; attempt < PROMPT_SETTLE_ATTEMPTS; attempt += 1) {
      // A cancel or a newer turn owns the row now; stop following this one.
      if (
        this.disposed ||
        generation !== this.generation ||
        this.locallyAbortedSessions.has(sessionId)
      )
        return "unknown";
      await new Promise((resolve) =>
        setTimeout(resolve, PROMPT_SETTLE_INTERVAL_MS),
      );
      let record: Awaited<ReturnType<GjcSdkCli["promptStatus"]>> | undefined;
      try {
        const cli = await this.requireCli();
        record = await cli.promptStatus(sessionId, operationRef, {
          repo: this.repoFor(sessionId),
        });
      } catch (error) {
        // A session that cannot answer its own prompt record is not proof the prompt
        // failed; the transcript still accounts for it.
        if (isSessionMissing(error)) return "unknown";
        continue;
      }
      if (!record.completed) continue;
      if (record.status === "failed") {
        const message = record.error?.message ?? "GJC run failed";
        // A cancel is the user's own action and settles quietly upstream.
        if (
          record.error?.code === "aborted" ||
          /abort|cancel/iu.test(message)
        )
          return "terminal";
        throw new Error(message);
      }
      return "terminal";
    }
    return "unknown";
  }

  async cancelRun(sessionId: string): Promise<void> {
    const previous = this.cancellationPromises.get(sessionId);
    if (previous) return previous;
    let resolveCancellation!: () => void;
    let rejectCancellation!: (error: unknown) => void;
    const completion = new Promise<void>((resolve, reject) => {
      resolveCancellation = resolve;
      rejectCancellation = reject;
    });
    // The initiating caller receives the original error below; keep the shared
    // promise from becoming an unhandled rejection when no concurrent caller
    // is waiting on it.
    void completion.catch(() => undefined);
    this.cancellationPromises.set(sessionId, completion);
    this.cancellingSessions.add(sessionId);
    try {
      const stop = await this.fireAbort(sessionId);
      if (stop === "no_active_turn") {
        // Nothing was running, so nothing was cancelled: the run state this window
        // was showing is cleared so the row settles at idle, and the transcript is
        // left alone -- it stays the source of truth for whether work continued on
        // another connection. A notice here would claim a stop that did not happen.
        throw new Error("GJC가 현재 연결에서 활성 turn을 찾지 못했습니다. 세션 작업의 중지 여부는 확인되지 않았습니다.");
      } else {
        this.finalizeThought(sessionId);
        this.finalizeAssistantMessage(sessionId);
        this.finalizeAllMessages(sessionId);
        this.toolSnapshots.delete(sessionId);
        this.cancelOpenTools(sessionId);
        this.cancelPermissionsForSession(sessionId);
        this.appendCancelledNotice(sessionId, stop === "plain");
        this.locallyAbortedSessions.add(sessionId);
        this.cancellationWatermarks.set(sessionId, Date.now());
        this.activePromptAdmissions.delete(sessionId);
        this.activePromptSessions.delete(sessionId);
        // Only confirmed aborts may clear run authority and publish idle.
        this.clearRunState(sessionId);
      }
      this.updateSessionStatus(sessionId, "idle");
      resolveCancellation();
    } catch (error) {
      // No state was cleared before confirmation, so keep whatever the runtime
      // currently reports instead of inventing running work for an idle session.
      rejectCancellation(error);
      throw error;
    } finally {
      this.cancellingSessions.delete(sessionId);
      if (this.cancellationPromises.get(sessionId) === completion)
        this.cancellationPromises.delete(sessionId);
    }
    return completion;
  }

  /**
   * Drops this window's run-authority state for a session whose run is over.
   */
  private clearRunState(sessionId: string): void {
    this.liveRunningSessions.delete(sessionId);
    this.liveRunningDigests.delete(sessionId);
    this.liveEvidenceAt.delete(sessionId);
    this.transcriptRunningSessions.delete(sessionId);
    this.workingPhaseSessions.delete(sessionId);
    this.runtimeIdleSessions.delete(sessionId);
    this.pendingAsyncWorkSessions.delete(sessionId);
    this.discoveredRunStates.delete(sessionId);
    this.compactingSessions.delete(sessionId);
    this.compactionRecordBaseline.delete(sessionId);
    this.compactionStartedAt.delete(sessionId);
  }

  /**
   * Stops the run, through the operator route when the host serves it and through the
   * ordinary abort when the host answers but refuses the operator-owned Stop.
   *
   * The result names what was confirmed: `owned` stopped this window's turn and the
   * work the runtime counts as owned, `plain` stopped the turn through the ordinary
   * route only, and `no_active_turn` means there was no turn to stop at all.
   */
  private async fireAbort(
    sessionId: string,
  ): Promise<"owned" | "plain" | "no_active_turn"> {
    try {
      await this.abortOwnedThroughControl(sessionId);
      return "owned";
    } catch (error) {
      if (!(error instanceof OwnedStopUnavailableError)) throw error;
    }
    const disposition = await this.abortPlainThroughControl(sessionId);
    return disposition === "stopped" ? "plain" : "no_active_turn";
  }

  /**
   * Ordinary `turn.abort` -- the payload and route a CLI cancel uses.
   *
   * Verified against gjc/0.18.11: `session-cli.ts` diverts `turn.abort` to the broker
   * `session.control` route only when the payload carries an `operator` key
   * (`operatorAbortBrokerRequest`), so this shape travels the ordinary Router control
   * path a directly launched TUI host does serve. Its dispositions (`session-runtime`
   * `abort`) are `{aborted:true}` -- the run is gone -- for this connection's own
   * turn, `{aborted:false, turn:"no_active_turn"}` when this connection owned no
   * active run, and `{aborted:false, reason:"queue_terminal_unconfirmed"}` when it
   * could not confirm. `turn:"stopped"` is the terminal-abort confirmation, accepted
   * here too so a runtime that answers the ordinary route with the terminal
   * disposition still reads as confirmed.
   *
   * Only a confirmation counts as stopped. The ordinary route stops this connection's
   * turn and nothing the runtime holds as work owned by another connection, so its
   * confirmation never substantiates that owned background work stopped.
   *
   * A route failure is reported as the owned-stop refusal instead of marking the
   * session read-only: a refused Stop is not evidence that the session lost ordinary
   * control (the metadata probe just proved it answers), and the refusal keeps the
   * retry guidance the user can act on.
   */
  private async abortPlainThroughControl(
    sessionId: string,
  ): Promise<"stopped" | "no_active_turn"> {
    const cli = await this.requireCli();
    const answer = await cli
      .rawControl(sessionId, "turn.abort", {}, { repo: this.repoFor(sessionId) })
      .catch((error: unknown): never => {
        throw new OwnedStopUnavailableError(error);
      });
    if (answer?.turn === "stopped" || answer?.aborted === true) return "stopped";
    // No active turn on this connection: nothing was stopped, and that is not a
    // failure to report.
    if (answer?.turn === "no_active_turn") return "no_active_turn";
    throw new Error(
      `GJC가 작업 중지를 확정하지 못했습니다. 응답: ${JSON.stringify(answer ?? null)}`,
    );
  }

  private appendCancelledNotice(
    sessionId: string,
    ownedWorkUnconfirmed = false,
  ): void {
    // A plain abort stops this connection's turn; reaching the work the runtime
    // counts as owned needs the operator route, so that cancel states the limit in
    // one sentence instead of claiming background work stopped.
    const content = ownedWorkUnconfirmed
      ? "진행 중인 작업이 취소되어 종료됐습니다. 다만 이 호스트의 백그라운드 작업은 중지 여부가 확인되지 않았습니다."
      : "진행 중인 작업이 취소되어 종료됐습니다.";
    const items = this.transcripts.get(sessionId) ?? [];
    // The persisted transcript reports an aborted turn as `shared-cancelled-`,
    // so checking only for this window's own prefix announced the same
    // cancellation a second time once the rebuild had already landed. The caveat is
    // part of the notice, so a cancel that states it is not swallowed by an earlier
    // cancel that does not.
    if (
      items.some(
        (item) =>
          item.kind === "notice" &&
          item.title === "작업 취소됨" &&
          item.content === content,
      )
    )
      return;
    this.appendTranscript({
      id: `gjc-cancelled-${this.nextLocalId++}`,
      kind: "notice",
      sessionId,
      title: "작업 취소됨",
      content,
      tone: "neutral",
      createdAt: nowLabel(),
    });
  }

  /**
   * Stops the current turn and this window's own background work.
   *
   * Terminal abort is session-scoped: it cancels the current turn and exactly the
   * owned background work without signalling or closing the GJC session process.
   * A signal is never sent -- SIGINT would take down a session the user may be
   * sharing with a terminal.
   *
   * The payload carries only `mode`/`scope`/`operator`: the host validates terminal
   * abort input strictly and rejects any other key (including `confirm` and
   * `idempotencyKey`, which travel as CLI flags) with `usage`. Verified against
   * gjc/0.18.11: adding a `clientRef` or `turnId` field to the terminal payload is
   * rejected before dispatch.
   *
   * Only `turn: "stopped"` is a confirmation. The historical gjc/0.18.11 bug
   * (fixed in 0.18.12) answered the typed disposition `{turn:"no_active_turn", terminal:"terminal_no_effect"}` when the
   * broker route cannot see the host's active prompt -- reproducible while a turn is
   * verifiably running (`status` in_flight and `turn.steer` accepted on the same
   * session) -- and the turn keeps running. Reporting that as a cancellation would
   * tell the user work stopped while it is still going, so the failure is surfaced
   * instead and the local run state is left untouched.
   */
  private async abortOwnedThroughControl(
    sessionId: string,
  ): Promise<Record<string, unknown>> {
    // The local running event precedes the host's broker registration. A Stop
    // pressed in that gap answers `no_active_turn` even though the prompt is
    // being accepted, so re-ask briefly before reporting the stop unconfirmed.
    let result: Record<string, unknown> | undefined;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const idempotencyKey = `gajae-abort-${randomUUID()}`;
      result = await this.controlSession(
        sessionId,
        "turn.abort",
        {
          mode: "terminal",
          scope: "owned",
          operator: true,
        },
        { idempotencyKey, confirm: true },
      );
      if (result?.turn === "stopped") return result;
      if (result?.turn !== "no_active_turn" || attempt === 4) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(
      `GJC가 작업 중지를 확정하지 못했습니다. 응답: ${JSON.stringify(result ?? null)}`,
    );
  }

  toolDecisionInfo(
    toolId: string,
    decision: ToolDecision,
  ): { name: string; requiresConfirmation: boolean } {
    const option = this.permissionOption(toolId, decision);
    return {
      name: option.name,
      requiresConfirmation: option.kind.startsWith("allow"),
    };
  }

  private permissionOption(toolId: string, decision: ToolDecision) {
    const pending = this.pendingPermissions.get(toolId);
    if (!pending)
      throw new Error(`No pending permission for tool call ${toolId}`);
    const option = pending.request.options.find(
      (candidate) => candidate.optionId === decision.optionId,
    );
    if (!option)
      throw new Error(`Unknown permission option ${decision.optionId}`);
    return option;
  }

  async resolveToolCall(toolId: string, decision: ToolDecision): Promise<void> {
    const pending = this.pendingPermissions.get(toolId)!;
    const option = this.permissionOption(toolId, decision);
    this.pendingPermissions.delete(toolId);
    pending.resolve({
      outcome: { outcome: "selected", optionId: option.optionId },
    });
    this.patchTool(toolId, {
      status: option.kind.startsWith("allow") ? "approved" : "denied",
    });
  }

  async markSessionRead(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.unread = false;
      this.sessionMetadata?.setUnread(sessionId, false);
      this.emitEvent({ type: "session.updated", session: { ...session } });
    }
  }

  async readArtifact(
    sessionId: string,
    artifactId: string,
  ): Promise<ArtifactContent> {
    if (!/^[A-Za-z0-9._-]+$/.test(artifactId))
      throw new Error("Invalid artifact id");
    const file = path.join(
      this.artifactDirectory,
      this.artifactNamespace(sessionId),
      `${artifactId}.json`,
    );
    try {
      const raw = JSON.parse(await readFile(file, "utf8")) as { text?: string };
      const text = raw.text ?? "";
      return {
        artifactId,
        text,
        complete: true,
        totalBytes: Buffer.byteLength(text),
      };
    } catch {
      const cli = await this.requireCli();
      await this.ensureAttached(sessionId, false);
      const chunks: Buffer[] = [];
      let offset = 0;
      let complete = false;
      while (!complete) {
        const envelope = await cli.rawQuery(
          sessionId,
          "artifact.read",
          { artifactId, offset, length: 256 * 1024 },
          { repo: this.repoFor(sessionId) },
        );
        const result =
          envelope.result &&
          typeof envelope.result === "object" &&
          !Array.isArray(envelope.result)
            ? (envelope.result as Record<string, unknown>)
            : envelope;
        if (typeof result.bytes !== "string")
          throw new Error(`Artifact ${artifactId} returned invalid data`);
        const chunk = Buffer.from(result.bytes, "base64");
        if (chunk.length === 0 && result.complete !== true)
          throw new Error(`Artifact ${artifactId} made no read progress`);
        chunks.push(chunk);
        offset += chunk.length;
        if (offset > 64 * 1024 * 1024)
          throw new Error(
            `Artifact ${artifactId} exceeds the 64 MB desktop read limit`,
          );
        complete = result.complete === true;
      }
      return {
        artifactId,
        text: Buffer.concat(chunks).toString("utf8"),
        complete,
        totalBytes: offset,
      };
    }
  }

  async previewFile(
    sessionId: string,
    requestedPath: string,
  ): Promise<GeneratedFilePreview> {
    const workspace = await realpath(
      this.sessionCwds.get(sessionId) ?? this.workspace,
    );
    const resolved = await realpath(
      path.isAbsolute(requestedPath)
        ? requestedPath
        : path.join(workspace, requestedPath),
    );
    if (
      resolved !== workspace &&
      !resolved.startsWith(`${workspace}${path.sep}`)
    )
      throw new Error("Preview file must be inside the session workspace");
    const info = await stat(resolved);
    if (!info.isFile()) throw new Error("Preview target is not a file");
    const extension = path.extname(resolved).toLowerCase();
    const imageTypes: Record<string, string> = {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".webp": "image/webp",
      ".gif": "image/gif",
      ".svg": "image/svg+xml",
    };
    const textTypes: Record<string, string> = {
      ".txt": "text/plain",
      ".json": "application/json",
      ".yaml": "application/yaml",
      ".yml": "application/yaml",
      ".toml": "application/toml",
      ".csv": "text/csv",
      ".ts": "text/typescript",
      ".tsx": "text/typescript",
      ".js": "text/javascript",
      ".jsx": "text/javascript",
      ".css": "text/css",
      ".py": "text/x-python",
      ".rs": "text/x-rust",
      ".go": "text/x-go",
    };
    const base = {
      path: resolved,
      name: path.basename(resolved),
      size: info.size,
    };
    if (imageTypes[extension]) {
      if (info.size > 20 * 1024 * 1024)
        throw new Error("Image preview exceeds 20 MiB");
      const bytes = await readFile(resolved);
      return {
        ...base,
        kind: "image",
        mimeType: imageTypes[extension]!,
        dataUrl: `data:${imageTypes[extension]};base64,${bytes.toString("base64")}`,
      };
    }
    if (extension === ".pdf") {
      if (info.size > 30 * 1024 * 1024)
        throw new Error("PDF preview exceeds 30 MiB");
      const bytes = await readFile(resolved);
      return {
        ...base,
        kind: "pdf",
        mimeType: "application/pdf",
        dataUrl: `data:application/pdf;base64,${bytes.toString("base64")}`,
      };
    }
    if (
      extension === ".md" ||
      extension === ".markdown" ||
      extension === ".html" ||
      extension === ".htm" ||
      textTypes[extension]
    ) {
      if (info.size > 2 * 1024 * 1024)
        throw new Error("Text preview exceeds 2 MiB");
      const content = await readFile(resolved, "utf8");
      const kind =
        extension === ".md" || extension === ".markdown"
          ? "markdown"
          : extension === ".html" || extension === ".htm"
            ? "html"
            : "text";
      return {
        ...base,
        kind,
        mimeType:
          kind === "html"
            ? "text/html"
            : kind === "markdown"
              ? "text/markdown"
              : textTypes[extension]!,
        content,
      };
    }
    return {
      ...base,
      kind: "unsupported",
      mimeType: "application/octet-stream",
    };
  }

  private async querySessionItems(
    sessionId: string,
    query: string,
    input: Record<string, unknown> = {},
    options?: { strict?: boolean },
  ): Promise<unknown[]> {
    try {
      const cli = await this.requireCli();
      return await cli.queryItems(sessionId, query, input, {
        repo: this.repoFor(sessionId),
      });
    } catch (error) {
      if (!options?.strict) return [];
      throw error;
    }
  }

  /**
   * Rebuilds one session's command palette.
   *
   * Three sources feed it:
   *  - this window's adapter specs, filtered by the operations the runtime
   *    advertises (`runtime.capabilities`);
   *  - dynamic commands synthesized from runtime state (`discoverDynamicCommands`),
   *    which is what fills a skill palette on create/attach before GJC has published
   *    anything of its own;
   *  - the runtime's advertised commands (`available_commands_update`), which win on
   *    a name collision.
   *
   * The palette is rebuilt from those sources whole, so a command the runtime stops
   * listing leaves with it. An authoritative update is also authority over the
   * synthesized set: once one arrives, even an empty one, the runtime's own list is
   * used alone and the synthesized entries are dropped instead of being merged back
   * in. A failing source contributes nothing rather than clearing the palette.
   */
  private async refreshSdkCommands(
    sessionId: string,
    advertised?: AgentCommand[],
  ): Promise<void> {
    if (advertised) this.sessionAdvertisedCommands.set(sessionId, advertised);
    // A capability query that answers nothing is not the same as one that answered
    // "no": the cached set is reused when there is one, and the adapter specs stay
    // out of the palette rather than reporting a guess either way. A query that
    // fails is neither: the palette already on screen stays, and the read is
    // retried with backoff instead of being abandoned until the next open.
    let operations: Set<string>;
    try {
      operations = await this.sdkOperations(sessionId, { strict: true });
    } catch {
      this.scheduleCommandRefreshRetry(sessionId);
      return;
    }
    const authoritative = this.sessionAdvertisedCommands.get(sessionId);
    let discovered: AgentCommand[] | undefined;
    if (authoritative === undefined) {
      try {
        discovered = await this.discoverDynamicCommands(sessionId, operations);
      } catch {
        this.scheduleCommandRefreshRetry(sessionId);
        return;
      }
    }
    if (discovered) this.sessionDiscoveredCommands.set(sessionId, discovered);
    else this.sessionDiscoveredCommands.delete(sessionId);
    if (
      operations.size === 0 &&
      authoritative === undefined &&
      discovered === undefined
    ) {
      // Nothing to rebuild from: never publish an empty palette over a good cache.
      // An empty answer is still an answer, so a previous failure stops retrying.
      this.clearCommandRefreshRetry(sessionId);
      return;
    }
    const commands = [
      ...new Map(
        [
          ...sdkSlashCommandsForOperations([...operations]),
          ...(discovered ?? []),
          ...(authoritative ?? []),
        ].map((command) => [command.name, command]),
      ).values(),
    ];
    this.sessionCommands.set(sessionId, commands);
    this.clearCommandRefreshRetry(sessionId);
    this.publishSessionCommands(sessionId, commands);
  }

  private scheduleCommandRefreshRetry(sessionId: string): void {
    if (
      this.disposed ||
      !this.sessions.has(sessionId) ||
      this.commandRefreshTimers.has(sessionId)
    )
      return;
    const attempt = this.commandRefreshAttempts.get(sessionId) ?? 0;
    const delay = Math.min(
      COMMAND_REFRESH_RETRY_MAX_MS,
      COMMAND_REFRESH_RETRY_BASE_MS * 2 ** attempt,
    );
    this.commandRefreshAttempts.set(sessionId, attempt + 1);
    const timer = setTimeout(() => {
      this.commandRefreshTimers.delete(sessionId);
      if (this.disposed || !this.sessions.has(sessionId)) return;
      void this.refreshSdkCommands(sessionId);
    }, delay);
    this.commandRefreshTimers.set(sessionId, timer);
  }

  private clearCommandRefreshRetry(sessionId: string): void {
    const timer = this.commandRefreshTimers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.commandRefreshTimers.delete(sessionId);
    this.commandRefreshAttempts.delete(sessionId);
  }

  /**
   * Dynamic commands synthesized from runtime state, used only until the runtime
   * publishes its own list.
   *
   * `skill.list/state` is the only dynamic command source gjc/0.18.11 exposes through
   * the SDK query surface: there is no query for the slash-command snapshot the
   * runtime builds for its own UI (`getSessionSlashCommands`, which filters
   * `skillsSettings.enableSkillCommands` and `skill.hide`), and this window does not
   * pretend to reproduce that registry. Rows that carry a visibility flag are honored
   * and a config that explicitly disables skills removes the whole set, but a hidden
   * skill in a row that carries no flag cannot be told apart from a visible one, so
   * these entries are advertised as selectable agent work only: `/skill:<name>` is
   * still delivered to the runtime as a prompt, and the runtime decides whether the
   * skill runs. They are also dropped as soon as an `available_commands_update`
   * arrives, since the runtime's own list is the authority on its own commands.
   */
  private async discoverDynamicCommands(
    sessionId: string,
    operations: ReadonlySet<string>,
  ): Promise<AgentCommand[] | undefined> {
    if (!operations.has("skill.list/state")) return undefined;
    const [skills, config] = await Promise.all([
      this.querySessionItems(sessionId, "skill.list/state", {}, { strict: true }),
      operations.has("config.list/get")
        ? this.querySessionItems(
            sessionId,
            "config.list/get",
            {},
            { strict: true },
          )
        : Promise.resolve([]),
    ]);
    if (skillsDisabledByConfig(config)) return [];
    const commands = new Map<string, AgentCommand>();
    for (const row of skills) {
      if (!row || typeof row !== "object" || Array.isArray(row)) continue;
      const skill = row as Record<string, unknown>;
      const name = typeof skill.name === "string" ? skill.name.trim() : "";
      if (!name) continue;
      if (
        skill.hide === true ||
        skill.hidden === true ||
        skill.enabled === false ||
        skill.visible === false
      )
        continue;
      const commandName = `skill:${name}`;
      if (commands.has(commandName)) continue;
      const description =
        typeof skill.description === "string" ? skill.description : "";
      commands.set(commandName, {
        name: commandName,
        description: description || `Run the ${name} skill`,
        hint: "[instructions]",
      });
    }
    return [...commands.values()];
  }

  private async sdkOperations(
    sessionId: string,
    options?: { strict?: boolean },
  ): Promise<Set<string>> {
    const cached = this.sessionSdkOperations.get(sessionId);
    if (cached) return cached;
    const rows = await this.querySessionItems(
      sessionId,
      "runtime.capabilities",
      {},
      options?.strict ? { strict: true } : undefined,
    );
    const operations = new Set(
      rows.flatMap((row) => {
        if (!row || typeof row !== "object" || Array.isArray(row)) return [];
        const value = row as Record<string, unknown>;
        return Array.isArray(value.operations)
          ? value.operations.filter(
              (operation): operation is string => typeof operation === "string",
            )
          : [];
      }),
    );
    if (operations.size > 0) this.sessionSdkOperations.set(sessionId, operations);
    return operations;
  }

  async getGoal(sessionId: string): Promise<GoalSnapshot> {
    // The todo read is shared with the transcript snapshot row, so the counters here
    // and the row a user can expand are the same observation of the same store.
    // A live tail already re-reads the store when a todo tool finishes, so this
    // poll must not call `todo.list` on the goal cadence. Without that channel the
    // fallback below is a long backoff, not another 4s/10s query.
    const [goalRows, todoRows] = await Promise.all([
      this.querySessionItems(sessionId, "goal.list/get"),
      this.todoRowsForGoal(sessionId),
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
    };
  }

  async operateGoal(
    sessionId: string,
    operation: GoalOperation,
  ): Promise<GoalSnapshot> {
    await this.controlSession(sessionId, "mode.goal.operate", {
      op: operation,
    });
    return this.getGoal(sessionId);
  }

  /**
   * The subagents a session launched, read from the task tool's own arguments.
   *
   * This used to also query `runtime.jobs.list` and merge anything whose kind matched
   * /subagent|task/. Verified against gjc/0.18.11, that query answers a single wrapper
   * row shaped `{running, recent, delivery}` whose entries are background *tool* runs
   * with `type` set to the tool name ("bash"). No entry is ever a subagent and no
   * top-level row has a `kind`, so the filter matched nothing: the merge was dead code
   * whose only live effect was making this method require a live runtime, so a
   * session whose subagents were already in the transcript failed to list them
   * whenever the runtime was unreachable.
   */
  async listSubagents(sessionId: string): Promise<SubagentSnapshot[]> {
    const declaredById = new Map<string, SubagentSnapshot>();
    for (const agent of (this.transcripts.get(sessionId) ?? []).flatMap(
      (item) => (item.kind === "tool" ? (item.subagents ?? []) : []),
    ))
      declaredById.set(agent.id, agent);
    return [...declaredById.values()];
  }

  async getDiff(sessionId: string): Promise<DiffSnapshot> {
    const workspace = this.sessionCwds.get(sessionId) ?? this.workspace;
    try {
      await this.ensureAttached(sessionId, false);
      const files: DiffSnapshot["files"] = [];
      for (const row of await this.querySessionItems(
        sessionId,
        "diff.list_files",
      ))
        if (row && typeof row === "object") {
          const value = row as Record<string, unknown>;
          if (typeof value.path === "string")
            files.push({
              id: typeof value.id === "string" ? value.id : value.path,
              path: value.path,
              patch: typeof value.body === "string" ? value.body : "",
            });
        }
      return {
        sessionId,
        workspace,
        files,
        refreshedAt: new Date().toISOString(),
      };
    } catch (error) {
      return {
        sessionId,
        workspace,
        files: [],
        refreshedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async refreshRuntimeState(sessionId: string): Promise<EffectiveRuntimeState> {
    await this.ensureAttached(sessionId, false);
    const query = async (name: string): Promise<unknown[]> =>
      await this.querySessionItems(sessionId, name);
    const [metadata, skills, config, capabilities, tools] = await Promise.all([
      query("session.metadata"),
      query("skill.list/state"),
      query("config.list/get"),
      query("runtime.capabilities"),
      query("tools.list"),
    ]);
    const names = (values: unknown[]): string[] =>
      [
        ...new Set(
          values.flatMap((value) => {
            if (typeof value === "string") return [value];
            if (!value || typeof value !== "object" || Array.isArray(value))
              return [];
            const item = value as Record<string, unknown>;
            const name = item.name ?? item.id ?? item.key;
            return typeof name === "string" && name ? [name] : [];
          }),
        ),
      ].sort();
    const configRows = config.flatMap((value) =>
      value && typeof value === "object" && !Array.isArray(value)
        ? [value as Record<string, unknown>]
        : [],
    );
    const namedConfig = (pattern: RegExp): string[] =>
      [
        ...new Set(
          configRows.flatMap((item) => {
            const key = String(item.key ?? item.name ?? item.id ?? "");
            if (!pattern.test(key)) return [];
            const value = item.value ?? item.currentValue;
            if (Array.isArray(value))
              return value.filter(
                (entry): entry is string => typeof entry === "string",
              );
            return typeof value === "string" && value ? [value] : [];
          }),
        ),
      ].sort();
    const session = this.sessions.get(sessionId);
    const runtimeState: EffectiveRuntimeState = {
      modelProfile: session?.model ?? this.modelPreset,
      model: session?.modelDisplay,
      thinking: session?.thinking,
      mode: session?.mode,
      permissionHandling: this.permissionHandling,
      mcpServers: namedConfig(/mcp/iu),
      skills: names(skills),
      rules: namedConfig(/rule/iu),
      tools: [...new Set([...names(tools), ...names(capabilities)])].sort(),
      gjcVersion: this.connectionState.version,
      refreshedAt: new Date().toISOString(),
    };
    if (metadata.length > 0 && !runtimeState.model) {
      const first = metadata[0];
      if (first && typeof first === "object" && !Array.isArray(first)) {
        const model = (first as Record<string, unknown>).model;
        if (typeof model === "string") runtimeState.model = model;
      }
    }
    if (session) {
      session.runtimeState = runtimeState;
      this.emitEvent({ type: "session.updated", session: { ...session } });
    }
    this.emitEvent({ type: "runtime.updated", sessionId, runtimeState });
    return runtimeState;
  }

  async reconnect(): Promise<BackendConnection> {
    if (this.disposed) throw new Error("GJC controller is disposed");
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    // Reconnect is a re-resolve, not a restart: there is no process to signal, so
    // nothing owned by another window can be disturbed by it.
    this.cli = undefined;
    this.startup = undefined;
    this.routeProbes.clear();
    this.permissionModeApplied.clear();
    for (const sessionId of this.toolObservers.keys())
      this.stopTailFollower(sessionId);
    for (const sessionId of this.tailControllers.keys())
      this.stopTailFollower(sessionId);
    this.attachedSessions.clear();
    this.sessionSdkOperations.clear();
    this.transcriptAttachments.clear();
    this.attachAttempts.clear();
    this.generation += 1;
    await this.ensureStarted();
    await this.recoverOwnedSessions();
    return { ...this.connectionState };
  }

  /**
   * Stops this window listing a session without touching anything GJC owns.
   *
   * gjc/0.18.12's public `session.delete` cannot remove saved history: it answers
   * `operation_failed` with `outcomeCertainty: unknown` and leaves the broker row
   * at `deleted: false` and the transcript on disk (reproduced on a throwaway
   * session with the exact input this app sends). A delete that cannot be proven is
   * refused, so this is the only removal this build can actually complete. The
   * session id is added to the hidden set discovery filters on, which means it
   * stays out of the rail instead of reappearing on the next scan.
   */
  hideSession(sessionId: string): void {
    this.removeLocalSession(sessionId, true);
  }

  deleteSession(sessionId: string): Promise<void> {
    const previous = this.deletionPromises.get(sessionId);
    if (previous) return previous;
    const operation = this.performDeleteSession(sessionId);
    this.deletionPromises.set(sessionId, operation);
    void operation
      .finally(() => {
        if (this.deletionPromises.get(sessionId) === operation)
          this.deletionPromises.delete(sessionId);
      })
      .catch(() => undefined);
    return operation;
  }

  private async performDeleteSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    this.deletingSessions.add(sessionId);
    try {
      // A session this window re-hosted is ours to close; a terminal's host is
      // not. GJC refuses `session.delete` while a host is live, so close only the
      // host this app attached, then delete the saved transcript.
      if (
        this.windowHostedSessions.has(sessionId) &&
        (await this.sessionBrokerRow(sessionId))?.live === true
      ) {
        await this.brokerLifecycle("session.close", {
          sessionId,
          cwd: this.sessionCwds.get(sessionId) ?? this.workspace,
        });
        this.attachedSessions.delete(sessionId);
        this.stopTailFollower(sessionId);
      }
      const outcome = await this.brokerLifecycleDelete(sessionId);
      if (outcome === "recovering") {
        if (session) {
          session.attachment = "recovering";
          this.attachedSessions.delete(sessionId);
          this.stopTailFollower(sessionId);
          this.emitEvent({ type: "session.updated", session: { ...session } });
        }
        // Who created the session does not decide this: on gjc/0.18.12 a saved
        // session that contains tool execution answers `session.delete` with an
        // unknown outcome while the broker row stays `deleted: false` (upstream
        // #6828), so an app-created session is refused exactly like a CLI's. The
        // old wording sent every caller to a CLI picker and read as "a CLI holds
        // this", which is not the reason here -- the receipt was never conclusive.
        throw new Error("세션 삭제를 확정하지 못했습니다. 로컬 기록과 워크트리는 보존했고, 이 세션은 복구 필요 · 읽기 전용이 되었습니다. GJC가 삭제 결과를 확정하지 못한 경우로, 도구를 실행한 이력이 있는 세션은 gjc/0.18.12에서 삭제가 미확정으로 끝나는 알려진 제한이 있습니다. 삭제를 다시 확인하려면 다시 시도하고, 계속 쓰려면 세션을 이어서 진행하세요. 앱은 삭제를 위해 CLI를 종료하거나 자동으로 재시도하지 않습니다.");
      }
      await this.removeSessionArtifacts(sessionId);
      this.removeLocalSession(sessionId, false);
    } catch (error) {
      if (lifecycleInputRefused(error) || lifecycleLegacyHistoryAmbiguous(error)) {
        // Neither admission refusal settles earlier effects. Preserve every
        // artifact and require reconciliation before another attempt.
        if (session) {
          session.attachment = "recovering";
          this.attachedSessions.delete(sessionId);
          this.stopTailFollower(sessionId);
          this.emitEvent({ type: "session.updated", session: { ...session } });
        }
        if (lifecycleLegacyHistoryAmbiguous(error)) {
          throw new Error("이전 GJC 수명주기 기록의 영향 범위를 확인할 수 없어 삭제 요청이 실행되지 않았습니다 (lifecycle_legacy_history_ambiguous). 이전 작업의 결과는 여전히 미확정입니다. 원본 작업·요청 키·대상과 ledger를 보존하고 확인해야 합니다. ledger 수정, 강제 삭제, 새 키로 재시도하지 마세요.");
        }
        throw new Error("GJC가 세션 삭제 요청의 입력을 거부했습니다 (lifecycle_input_refused). 요청 정보를 수정하고 기존 세션 상태를 확인해야 합니다. 자동으로 재시도하지 않습니다.");
      }
      if (missingSessionError(error) || missingLifecycleSessionError(error)) {
        await this.removeSessionArtifacts(sessionId);
        this.removeLocalSession(sessionId, false);
        return;
      }
      if (liveSessionDeleteError(error)) {
        throw new Error(
          "현재 SDK는 사용 중인 세션의 기록 삭제를 지원하지 않습니다. 해당 CLI의 세션 선택 화면에서 삭제하세요. 앱은 기록 삭제를 위해 CLI를 종료하지 않습니다.",
        );
      }
      if (lifecycleUncertainError(error) || uncertainLifecycleOutcomeError(error)) {
        if (session) {
          session.attachment = "recovering";
          this.attachedSessions.delete(sessionId);
          this.stopTailFollower(sessionId);
          this.emitEvent({ type: "session.updated", session: { ...session } });
        }
        // Same evidence rule as the branch above: the receipt did not establish an
        // outcome and the broker row was never proven gone, so nothing local is
        // discarded and the session stops accepting sends until it is reattached.
        throw new Error("세션 삭제를 확정하지 못했습니다. 로컬 기록과 워크트리는 보존했고, 이 세션은 복구 필요 · 읽기 전용이 되었습니다. 같은 이유로 반복 시도해도 결과가 같을 수 있습니다. 계속 쓰려면 세션을 이어서 진행하세요.");
      }
      throw error;
    } finally {
      this.deletingSessions.delete(sessionId);
    }
  }

  private async brokerLifecycleDelete(
    sessionId: string,
  ): Promise<"deleted" | "recovering"> {
    // The shared transcript scan walks this host's session directory and shares no
    // state with the broker, so it runs alongside the lifecycle round trips instead
    // of behind them; the delete still receives the path this lookup resolves on its
    // own.
    const locatedSessionPath = this.locateSharedTranscriptFile(sessionId);
    const row = await this.sessionBrokerRow(sessionId);
    // An unreadable index is not an absent session: with no row there is no evidence
    // that a live endpoint is gone, so the session stays for reconciliation.
    if (row === undefined) return "recovering";
    // Let the SDK authorize this exact saved-session deletion. A live or
    // generation-zero row is neither permission to stop its process nor proof
    // that a future owner-authorized history deletion must be refused locally.
    const cwd = row?.repo ?? this.sessionCwds.get(sessionId) ?? this.workspace;
    const sessionPath = await locatedSessionPath;
    try {
      await this.brokerLifecycle("session.delete", {
        sessionId,
        cwd,
        ...(row?.stateRoot ? { stateRoot: row.stateRoot } : {}),
        ...(sessionPath ? { sessionPath } : {}),
      });
      return "deleted";
    } catch (error) {
      if (missingLifecycleSessionError(error) || missingSessionError(error))
        return "deleted";
      // A live-session refusal is a definite refusal, not an unknown outcome;
      // the caller must not mark the row recovering when nothing was attempted.
      if (liveSessionDeleteError(error)) throw error;
      if (
        lifecycleUncertainError(error) ||
        uncertainLifecycleOutcomeError(error)
      ) {
        // The receipt is not proof of either success or failure. Only an absent or
        // tombstoned broker row proves deletion; every other outcome preserves the
        // transcript, artifacts, metadata, and worktree for reconciliation.
        const afterDelete = await this.sessionBrokerRow(sessionId);
        if (afterDelete === null || afterDelete?.deleted === true) return "deleted";
        if (lifecycleInputRefused(error) || lifecycleLegacyHistoryAmbiguous(error)) throw error;
        return "recovering";
      }
      throw error;
    }
  }

  /** `null` means proven absent; `undefined` means the broker index was unavailable. */
  private async sessionBrokerRow(
    sessionId: string,
  ): Promise<SdkSessionRow | null | undefined> {
    const listed = await this.brokerSessions();
    if (!listed) return undefined;
    return listed.find((session) => session.sessionId === sessionId) ?? null;
  }

  private async removeSessionArtifacts(sessionId: string): Promise<void> {
    const ids = this.artifactSessionIds.get(sessionId) ?? new Set<string>();
    const writes = [...ids]
      .map((id) => this.artifactWrites.get(this.artifactWriteKey(sessionId, id)))
      .filter((write): write is Promise<void> => Boolean(write));
    if (writes.length > 0) await Promise.all(writes);
    await rm(
      path.join(this.artifactDirectory, this.artifactNamespace(sessionId)),
      { recursive: true, force: true },
    );
    this.artifactSessionIds.delete(sessionId);
  }

  private artifactNamespace(sessionId: string): string {
    return Buffer.from(sessionId, "utf8").toString("base64url");
  }

  private artifactWriteKey(sessionId: string, artifactId: string): string {
    return `${this.artifactNamespace(sessionId)}\0${artifactId}`;
  }

  private async locateSharedTranscriptFile(
    sessionId: string,
  ): Promise<string | undefined> {
    let filePath = this.sharedSessionFiles.get(sessionId);
    if (filePath) {
      try {
        await access(filePath);
        return filePath;
      } catch {
        this.sharedSessionFiles.delete(sessionId);
      }
    }
    const configuredAgentDirectory = path.resolve(
      process.env.GJC_CODING_AGENT_DIR ?? path.join(homedir(), ".gjc/agent"),
    );
    // GJC canonicalizes the workspace and the transcript path before matching a
    // resume target. `/tmp` and `/private/tmp` name one directory but compare as
    // two, so an agent directory reached through a symlinked temp root produced
    // `lifecycle_input_refused` for a transcript that was right there.
    const agentDirectory = await realpath(configuredAgentDirectory).catch(
      () => configuredAgentDirectory,
    );
    const sessionsDirectory = path.join(agentDirectory, "sessions");
    const suffix = `_${sessionId}.jsonl`;
    try {
      for (const bucket of await readdir(sessionsDirectory, {
        withFileTypes: true,
      })) {
        if (!bucket.isDirectory()) continue;
        const directory = path.join(sessionsDirectory, bucket.name);
        const candidates = (await readdir(directory, { withFileTypes: true }))
          .filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
          .map((entry) => path.join(directory, entry.name));
        if (candidates.length === 0) continue;
        // A re-host writes a new timestamped session file and leaves the older ones
        // in place, so the current generation is the newest match rather than
        // whichever the directory listing happens to return first. Handing GJC a
        // stale file made `session.delete` refuse with an unknown outcome.
        const stamped = await Promise.all(
          candidates.map(async (candidate) => ({
            candidate,
            mtimeMs: (await stat(candidate)).mtimeMs,
          })),
        );
        stamped.sort((left, right) => right.mtimeMs - left.mtimeMs);
        const candidate = stamped[0].candidate;
        filePath = await realpath(candidate).catch(() => candidate);
        this.sharedSessionFiles.set(sessionId, filePath);
        return filePath;
      }
    } catch {
      return undefined;
    }
    return undefined;
  }

  private async brokerLifecycle(
    operation: "session.delete" | "session.close",
    input: Record<string, unknown>,
  ): Promise<void> {
    const sessionId =
      typeof input.sessionId === "string" ? input.sessionId : undefined;
    const repo =
      (sessionId ? this.sessionCwds.get(sessionId) : undefined) ??
      this.workspace;
    const cli = await this.requireCli();
    await cli.rawGlobal(operation, input, {
      repo,
      idempotencyKey: `gajae-${operation.replace(".", "-")}-${randomUUID()}`,
    });
  }

  private removeLocalSession(sessionId: string, hide: boolean): void {
    this.stopTailFollower(sessionId);
    this.windowHostedSessions.delete(sessionId);
    this.sessions.delete(sessionId);
    this.sessionCwds.delete(sessionId);
    this.attachedSessions.delete(sessionId);
    this.transcriptAttachments.delete(sessionId);
    this.transcripts.delete(sessionId);
    this.messageKeys.delete(sessionId);
    this.activeAssistantMessages.delete(sessionId);
    this.activeThoughts.delete(sessionId);
    this.activePromptSessions.delete(sessionId);
    this.activePromptAdmissions.delete(sessionId);
    this.cancellationWatermarks.delete(sessionId);
    this.liveRunningSessions.delete(sessionId);
    this.liveRunningDigests.delete(sessionId);
    this.liveEvidenceAt.delete(sessionId);
    this.transcriptRunningSessions.delete(sessionId);
    this.workingPhaseSessions.delete(sessionId);
    this.runtimeIdleSessions.delete(sessionId);
    this.pendingAsyncWorkSessions.delete(sessionId);
    this.asyncJobReconciliations.delete(sessionId);
    this.runRevisions.delete(sessionId);
    this.discoveredRunStates.delete(sessionId);
    this.compactingSessions.delete(sessionId);
    this.compactionRecordBaseline.delete(sessionId);
    this.compactionRecordWatermark.delete(sessionId);
    this.compactionStartedAt.delete(sessionId);
    this.suppressedUserMessageKeys.delete(sessionId);
    this.echoedPromptTexts.delete(sessionId);
    this.locallyAbortedSessions.delete(sessionId);
    this.sessionCommands.delete(sessionId);
    this.publishedCommandKeys.delete(sessionId);
    this.clearCommandRefreshRetry(sessionId);
    this.clearTodoPoll(sessionId);
    this.sessionAdvertisedCommands.delete(sessionId);
    this.sessionDiscoveredCommands.delete(sessionId);
    this.sessionPlans.delete(sessionId);
    this.sessionTodoSnapshots.delete(sessionId);
    this.todoReads.delete(sessionId);
    this.sessionSdkOperations.delete(sessionId);
    this.sessionConfig.delete(sessionId);
    this.terminalOnlySessions.delete(sessionId);
    this.routeProbes.delete(sessionId);
    this.modelProfiles.delete(sessionId);
    this.explicitSessionThinking.delete(sessionId);
    this.sharedSessionWatchers.get(sessionId)?.close();
    this.sharedSessionWatchers.delete(sessionId);
    this.runStateWatchers.get(sessionId)?.close();
    this.runStateWatchers.delete(sessionId);
    const runStateTimer = this.runStateTimers.get(sessionId);
    if (runStateTimer) clearTimeout(runStateTimer);
    this.runStateTimers.delete(sessionId);
    const refreshTimer = this.sharedSessionRefreshTimers.get(sessionId);
    if (refreshTimer) clearTimeout(refreshTimer);
    this.sharedSessionRefreshTimers.delete(sessionId);
    this.cancelPermissionsForSession(sessionId);
    if (hide) this.sessionMetadata?.hideSession?.(sessionId);
    else this.sessionMetadata?.deleteAlias?.(sessionId);
    // Removing a row changes what the next scan should produce even though the
    // broker's live set is untouched, so the reuse fingerprint is invalidated.
    this.lastLiveFingerprint = undefined;
    this.invalidateBrokerIndexCache();
    this.lastDiscovered = this.lastDiscovered.filter(
      (session) => session.id !== sessionId,
    );
    this.emitEvent({ type: "session.deleted", sessionId });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const pending of this.pendingPermissions.values()) {
      pending.resolve({ outcome: { outcome: "cancelled" } });
    }
    this.pendingPermissions.clear();
    this.routeProbes.clear();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    // No agent process is owned here, so disposal never kills a running session.
    for (const controller of this.tailControllers.values()) controller.abort();
    this.tailControllers.clear();
    for (const observer of this.toolObservers.values()) observer.abort();
    this.toolObservers.clear();
    this.toolSnapshots.clear();
    this.cli = undefined;
    this.startup = undefined;
    this.startupSessionRows = undefined;
    this.invalidateBrokerIndexCache();
    for (const timer of this.commandRefreshTimers.values()) clearTimeout(timer);
    this.commandRefreshTimers.clear();
    this.commandRefreshAttempts.clear();
    for (const timer of this.todoPollTimers.values()) clearTimeout(timer);
    this.todoPollTimers.clear();
    this.todoPollAttempts.clear();
    this.publishedCommandKeys.clear();
    this.transcriptAttachments.clear();
    this.permissionModeApplied.clear();
    this.windowHostedSessions.clear();
    this.tailReads.clear();
    this.tailCheckpoints.clear();
    this.sessions.clear();
    this.sessionCwds.clear();
    this.attachedSessions.clear();
    // Only a successful attach removes a session's throttle stamp, so sessions that
    // never attach -- terminal-only rows, dead endpoints -- held one for the life of
    // the process while every other map here was already being cleared.
    this.attachAttempts.clear();
    // Each entry holds a transcript's parsed envelopes, measured at 6.3MB apiece.
    this.sharedTranscriptReads.clear();
    this.sharedSessionFiles.clear();
    this.sessionParents.clear();
    this.transcripts.clear();
    this.messageKeys.clear();
    this.activeAssistantMessages.clear();
    this.activeThoughts.clear();
    this.activePromptSessions.clear();
    this.activePromptAdmissions.clear();
    this.cancellationWatermarks.clear();
    this.liveRunningSessions.clear();
    this.liveRunningDigests.clear();
    this.liveEvidenceAt.clear();
    this.transcriptRunningSessions.clear();
    this.workingPhaseSessions.clear();
    this.runtimeIdleSessions.clear();
    this.pendingAsyncWorkSessions.clear();
    this.asyncJobReconciliations.clear();
    this.runRevisions.clear();
    this.discoveredRunStates.clear();
    this.compactingSessions.clear();
    this.compactionRecordBaseline.clear();
    this.compactionRecordWatermark.clear();
    this.compactionStartedAt.clear();
    this.suppressedUserMessageKeys.clear();
    this.echoedPromptTexts.clear();
    this.sessionCommands.clear();
    this.sessionAdvertisedCommands.clear();
    this.sessionDiscoveredCommands.clear();
    this.sessionPlans.clear();
    this.sessionTodoSnapshots.clear();
    this.todoReads.clear();
    this.sessionSdkOperations.clear();
    this.sessionConfig.clear();
    this.terminalOnlySessions.clear();
    this.modelProfiles.clear();
    this.explicitSessionThinking.clear();
    this.artifactWrites.clear();
    this.artifactSessionIds.clear();
    this.deletingSessions.clear();
    this.deletionPromises.clear();
    // In-flight bookkeeping. Each entry is normally removed in a `finally`, so what
    // is left here is whatever a rejected or abandoned call did not reach. Teardown
    // claims to release everything, so it has to include these too.
    this.cancellingSessions.clear();
    this.cancellationPromises.clear();
    this.flushingSessions.clear();
    this.pendingSteers.clear();
    this.locallyAbortedSessions.clear();
    this.imageDataUrls.clear();
    this.contextUsageQueries.clear();
    for (const watcher of this.sharedSessionWatchers.values()) watcher.close();
    for (const watcher of this.runStateWatchers.values()) watcher.close();
    this.runStateWatchers.clear();
    for (const timer of this.runStateTimers.values()) clearTimeout(timer);
    this.runStateTimers.clear();
    for (const timer of this.sharedSessionRefreshTimers.values())
      clearTimeout(timer);
    this.sharedSessionWatchers.clear();
    this.sharedSessionRefreshTimers.clear();
  }

  private async ensureStarted(): Promise<void> {
    if (this.cli) return;
    if (this.startup) return this.startup;
    if (this.disposed) throw new Error("GJC controller is disposed");

    this.startup = this.start().finally(() => {
      this.startup = undefined;
    });
    return this.startup;
  }

  /**
   * Prepares the CLI client.
   *
   * There is nothing to connect to: the broker is started on demand by the CLI
   * itself, and every operation is its own process. "Ready" therefore means the
   * executable resolves and the broker answers a session list -- proof the app can
   * actually reach the runtime, without holding anything open. A runtime crash or
   * upgrade can no longer take the window's connection down with it, because there
   * is no connection to lose.
   */
  private async start(): Promise<void> {
    const generation = ++this.generation;
    this.startupSessionRows = undefined;
    this.invalidateBrokerIndexCache();
    this.setConnection({
      state: "connecting",
      backend: "gjc",
      label: "GJC",
      detail: "Reaching the GJC broker",
      workspace: this.workspace,
      modelPreset: this.modelPreset,
    });
    const executable = await this.resolveExecutable();
    let profileThinking: string | undefined;
    try {
      const modelsFile = path.join(
        path.resolve(
          process.env.GJC_CODING_AGENT_DIR ??
            path.join(homedir(), ".gjc/agent"),
        ),
        "models.yml",
      );
      profileThinking = configuredProfileDefaultThinking(
        await readFile(modelsFile, "utf8"),
        this.modelPreset,
      );
    } catch {
      /* built-in profiles resolve their own defaults */
    }
    this.modelPresetThinking = profileThinking;
    const cli = new GjcSdkCli({
      executable,
      repo: this.workspace,
      env: runtimeEnvironment(),
      timeoutMs: STARTUP_TIMEOUT_MS,
    });
    // The broker index doubles as the reachability check: it fails closed with a
    // typed operational error when the broker cannot be started at all.
    const beforeIndex = await this.brokerIndexRevision();
    const rows = await cli.listSessions({ scope: "all" });
    const afterIndex = await this.brokerIndexRevision();
    if (generation !== this.generation || this.disposed) return;
    this.noteBrokerIndex(rows, beforeIndex, afterIndex);
    this.startupSessionRows = rows;
    this.cli = cli;
    this.permissionModeApplied.clear();
    this.setConnection({
      state: "connected",
      backend: "gjc",
      label: "GJC",
      detail: `SDK session CLI · ${this.modelPreset}`,
      workspace: this.workspace,
      modelPreset: this.modelPreset,
      generation,
    });
    this.reconnectAttempt = 0;
    queueMicrotask(() => {
      void this.recoverOwnedSessions();
    });
    // Version is informational. Waiting for it held the first paint behind a
    // second process after the broker had already answered.
    void this.publishRuntimeVersion(cli, generation);
  }

  private async publishRuntimeVersion(
    cli: GjcSdkCli,
    generation: number,
  ): Promise<void> {
    const version = await cli.version().catch(() => undefined);
    if (!version || generation !== this.generation || this.disposed) return;
    if (this.connectionState.state !== "connected") return;
    this.setConnection({ ...this.connectionState, version });
  }

  /**
   * The CLI client, starting it if this is the first use.
   *
   * Replaces the old `requireConnection`: there is no liveness to check because no
   * process is held between calls.
   */
  private async requireCli(): Promise<GjcSdkCli> {
    await this.ensureStarted();
    if (!this.cli) throw new Error("GJC SDK session CLI is unavailable");
    return this.cli;
  }

  /** The workspace a session's CLI calls must resolve against. */
  private repoFor(sessionId: string): string {
    return this.sessionCwds.get(sessionId) ?? this.workspace;
  }

  /**
   * Applies the configured permission handling to a session.
   *
   * The old permission environment variable applied only to the removed child
   * protocol process. A broker-hosted session host instead keeps a per-session SDK
   * permission mode, set through the `permission_mode.set` control operation and
   * defaulting to `allow`.
   *
   * Fail-closed note: the host has no reverse channel to ask an external
   * controller for a decision (`permission.request` is a host-to-client operation
   * the session CLI cannot carry). A session left in `prompt` mode therefore
   * *rejects* tool calls with "no permission provider is connected" rather than
   * prompting anyone. So `prompt` and `deny` are both mapped to the host's `deny`,
   * which refuses the tool call with a decision the transcript records, instead of
   * silently granting what the user did not approve. `always-allow` maps to
   * `allow`. If GJC ever gains a way to answer a permission request from an
   * external controller, `prompt` should move to it rather than to `deny`.
   */
  private async applyPermissionMode(sessionId: string): Promise<void> {
    if (this.permissionModeApplied.has(sessionId)) return;
    const mode =
      this.permissionHandling === "always-allow" ||
      this.permissionHandling === "auto"
        ? "always-allow"
        : "deny";
    const cli = await this.requireCli();
    await cli.rawControl(
      sessionId,
      "permission_mode.set",
      { mode },
      { repo: this.repoFor(sessionId) },
    );
    this.permissionModeApplied.add(sessionId);
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer) return;
    const delay = Math.min(
      30_000,
      500 * 2 ** Math.min(this.reconnectAttempt, 6),
    );
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.ensureStarted()
        .then(() => this.recoverOwnedSessions())
        .catch(() => this.scheduleReconnect());
    }, delay);
  }

  private async recoverOwnedSessions(): Promise<void> {
    if (!this.cli) return;
    for (const session of this.sessions.values()) {
      if (
        session.ownership !== "gajae" ||
        this.attachedSessions.has(session.id)
      )
        continue;
      const cwd = this.sessionCwds.get(session.id);
      if (!cwd) continue;
      try {
        await this.ensureAttached(session.id, false);
        session.attachment = "attached";
        // Re-attaching says this window can talk to the session again, not that its
        // turn ended. Another process may have kept working through the disconnect,
        // so the transcript decides; `idle` is only the answer when it has none.
        session.status = (await this.discoveredRunState(session.id)) ?? "idle";
        session.unread = true;
        this.sessionMetadata?.setUnread(session.id, true);
        this.emitEvent({ type: "session.updated", session: { ...session } });
        this.emitEvent({
          type: "session.activity",
          sessionId: session.id,
          title: session.title,
          unread: true,
          category: "recovered",
        });
      } catch {
        session.attachment = "recovering";
        session.status = "failed";
        this.emitEvent({ type: "session.updated", session: { ...session } });
      }
    }
  }

  private async resolveExecutable(): Promise<string> {
    // Resolve the same GJC the user's shell resolves. A fixed preference list
    // silently disagreed with PATH: `~/.bun/bin` was checked before
    // `~/.local/bin`, so the app ran an older install than the terminal did
    // (0.15.2 against 0.15.3) and an upgrade to the PATH-visible one changed
    // nothing here. An explicit setting or GJC_BIN still wins.
    const candidates = [
      this.configuredExecutable,
      process.env.GJC_BIN,
      ...gjcPathCandidates(),
    ].filter((candidate): candidate is string => Boolean(candidate));
    for (const candidate of candidates) {
      try {
        await access(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Try the next installation path.
      }
    }
    return "gjc";
  }

  /**
   * Past sessions on disk, newest first.
   *
   * Discovery only lists sessions the broker still reports as live, so everything
   * else is unreachable from the window even though `gjc --resume <id>` opens it
   * fine. The session files are the authority on what exists.
   */
  async listHistorySessions(): Promise<HistorySession[]> {
    const agentDirectory = path.resolve(
      process.env.GJC_CODING_AGENT_DIR ?? path.join(homedir(), ".gjc/agent"),
    );
    const sessionsDirectory = path.join(agentDirectory, "sessions");
    // Liveness is decoration here; the files still list fine without it.
    const liveIds = new Set(
      ((await this.brokerSessions()) ?? [])
        .filter((session) => session.live)
        .map((session) => session.sessionId),
    );
    const files: Array<{ path: string; id: string; modified: number }> = [];
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
            files.push({ path: filePath, id, modified: info.mtimeMs });
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
          const headLines = await transcriptHeadLines(file.path);
          const summary = historySessionSummary(headLines);
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
            parentId: parentSessionOf(headLines[0], file.id),
          };
        } catch {
          /* the file went away or is not a readable transcript */
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(8, files.length) }, read),
    );
    return sessions.filter(
      (session): session is HistorySession => session !== undefined,
    );
  }

  /**
   * Open saved history and try to restore control independently. An unreachable
   * runtime must not make a readable transcript fail to open.
   */
  async openHistorySession(sessionId: string): Promise<AgentSession> {
    if (this.sessions.has(sessionId)) return this.openHistoryWithControl(sessionId);
    const filePath = await this.locateSharedTranscriptFile(sessionId);
    if (!filePath)
      throw new Error(`세션 기록을 찾지 못했습니다: ${sessionId}`);
    let cwd: string | undefined;
    try {
      const text = await readFile(filePath, "utf8");
      cwd = historySessionSummary(text.split("\n"))?.cwd;
    } catch {
      /* the workspace falls back below */
    }
    const workspace = cwd ?? this.workspace;
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
      ownership: this.sessionMetadata?.getOwnership(sessionId) ?? "external",
      attachment: "recovering",
    };
    this.sessions.set(sessionId, session);
    this.sessionCwds.set(sessionId, workspace);
    this.sessionMetadata?.setWorkspace(sessionId, workspace);
    this.emitEvent({ type: "session.created", session: { ...session } });
    return this.openHistoryWithControl(sessionId);
  }

  private async openHistoryWithControl(sessionId: string): Promise<AgentSession> {
    const generation = this.generation;
    try {
      return await this.resumeSession(sessionId);
    } catch (error) {
      if (!isSessionUnreachable(error)) throw error;
      // Only a real persisted read authorizes history-only opening. Never
      // fabricate an empty conversation or re-host a live CLI after this refusal.
      const items = await this.readPersistedTranscript(sessionId);
      if (items === undefined) throw error;
      if (this.disposed || generation !== this.generation || !this.sessions.has(sessionId))
        throw new Error("GJC session history opening was cancelled");
      this.markTerminalOnly(sessionId);
      const installed = this.installTranscript(sessionId, items);
      // The row is not discovered, so nothing else describes its run state. The
      // transcript is the only account of a CLI that is still working, and the
      // freshly opened row must not claim it finished.
      const status = await this.discoveredRunState(sessionId);
      const opened = this.sessions.get(sessionId);
      if (
        opened &&
        status &&
        opened.status !== status &&
        opened.status !== "failed" &&
        opened.status !== "starting"
      ) {
        this.advanceRunRevision(sessionId);
        opened.status = status;
        this.emitEvent({ type: "session.updated", session: { ...opened } });
      }
      this.emitEvent({
        type: "transcript.synced",
        sessionId,
        items: installed.map(cloneTranscriptItem),
      });
      return { ...this.sessions.get(sessionId)! };
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
  async resumeSession(sessionId: string): Promise<AgentSession> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown GJC session: ${sessionId}`);
    // The refusal that produced terminal-only is not permanent, so the flag is
    // cleared before retrying or ensureAttached would be skipped entirely.
    this.terminalOnlySessions.delete(sessionId);
    this.stopTailFollower(sessionId);
    this.attachedSessions.delete(sessionId);
    this.attachAttempts.delete(sessionId);
    try {
      await this.ensureAttached(sessionId, true);
      await this.refreshSessionSettings(sessionId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/no current Router attachment|provider_lease_conflict/iu.test(message)) {
        this.terminalOnlySessions.add(sessionId);
        session.attachment = "terminal-only";
        session.ownership = "external";
        this.emitEvent({ type: "session.updated", session: { ...session } });
        throw new Error(
          "다른 터미널이 이 세션을 잡고 있어 이어서 진행할 수 없습니다. 해당 GJC를 종료한 뒤 다시 시도하세요.",
        );
      }
      // A lifecycle receipt is evidence that the attach was recorded, not whether
      // it happened. The transcript is read from the session file either way, so
      // an unverifiable receipt leaves the session readable instead of failing
      // the resume outright -- it only means live control is not guaranteed.
      if (!lifecycleUncertainError(error)) throw error;
      this.attachedSessions.delete(sessionId);
      session.attachment = "recovering";
      this.emitEvent({ type: "session.updated", session: { ...session } });
    }
    const resumed = this.sessions.get(sessionId);
    if (!resumed) throw new Error(`Unknown GJC session: ${sessionId}`);
    // The transcript is republished so the window shows the history the resumed
    // session actually has, not the read-only snapshot it was left with.
    const items = await this.getTranscript(sessionId);
    this.emitEvent({
      type: "transcript.synced",
      sessionId,
      items: items.map(cloneTranscriptItem),
    });
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
  private async ensureAttached(
    sessionId: string,
    replay: boolean,
  ): Promise<void> {
    if (this.attachedSessions.has(sessionId)) {
      // Attachment and the tail reader are separate lives. A reader that died on
      // a transient broker error left the session attached, so every later use
      // took this early return and the follower was never restarted.
      this.startTailFollower(sessionId);
      return;
    }
    const cli = await this.requireCli();
    const generation = this.generation;
    const wasListed = this.sessions.has(sessionId);
    const requireCurrentAttachment = (): void => {
      if (this.disposed || generation !== this.generation || (wasListed && !this.sessions.has(sessionId)))
        throw new Error("GJC session attachment was cancelled");
    };
    requireCurrentAttachment();
    const cwd = this.repoFor(sessionId);
    if (replay) {
      this.installTranscript(sessionId, []);
      this.messageKeys.set(sessionId, new Map());
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
      const sessionPath = await this.locateSharedTranscriptFile(sessionId);
      requireCurrentAttachment();
      await cli.rawGlobal(
        "session.resume",
        {
          sessionId,
          cwd,
          ...(sessionPath ? { sessionPath } : {}),
          modelPreset: this.modelPreset,
        },
        { repo: cwd },
      );
      rehosted = true;
      this.windowHostedSessions.add(sessionId);
      // The re-host writes a new timestamped session file. Drop the path this window
      // cached, or the next lifecycle call (delete especially) hands GJC the previous
      // generation's file and the operation comes back with an unknown outcome.
      this.sharedSessionFiles.delete(sessionId);
    }
    // Only a session this window hosts may have its permission handling applied.
    // A session already live in another host belongs to that host, and rewriting its
    // policy changes how *that* agent runs tools: the desktop smoke attached to a
    // live session to read its model profiles, set the app's fail-closed `deny`, and
    // left the session rejecting every tool call afterwards. Reading a session is not
    // authority over it.
    const owned = rehosted || this.sessions.get(sessionId)?.ownership === "gajae";
    requireCurrentAttachment();
    if (owned) await this.applyPermissionMode(sessionId);
    await this.refreshSessionConfigOptions(sessionId);
    await this.refreshModelProfiles(sessionId);
    requireCurrentAttachment();
    if (replay) {
      const restored = await this.readSharedTranscript(sessionId).catch(() => []);
      if (restored.length > 0) this.installTranscript(sessionId, restored);
      this.finalizeAllMessages(sessionId);
    }
    this.attachedSessions.add(sessionId);
    this.terminalOnlySessions.delete(sessionId);
    this.startTailFollower(sessionId);
    // Command discovery must not wait for GJC to publish a bootstrap update: a
    // session opened in an already-running process never re-sends one, and the tail
    // frame that carried it may be long past. Ask the runtime directly.
    void this.refreshSdkCommands(sessionId);
    // The session file is the live account now that no connection streams updates.
    const watched = await this.locateSharedTranscriptFile(sessionId);
    if (watched) this.watchSharedTranscript(sessionId, watched);
    const session = this.sessions.get(sessionId);
    if (session) {
      if (rehosted) {
        session.ownership = "gajae";
        this.sessionMetadata?.setOwnership(sessionId, "gajae");
      }
      session.attachment = "attached";
      // A successful attach clears the failure this window recorded, but it does not
      // observe the turn. Opening a session someone else is driving must not report
      // that work as finished, so the transcript answers and `idle` is the fallback.
      if (session.status === "failed")
        session.status = (await this.discoveredRunState(sessionId)) ?? "idle";
      this.emitEvent({ type: "session.updated", session: { ...session } });
    }
    void this.refreshContextUsage(sessionId);
  }

  /**
   * Starts the bounded `sdk session tail --all-events` catch-up loop.
   *
   * In gjc/0.18.11 tail is a batch command, not NDJSON: it returns one JSON envelope
   * when an observed turn becomes idle or the wait window elapses, and an elapsed
   * window reports `terminal:false` with the frames it had collected. The session-file
   * watcher stays the durable transcript account; this loop is supplemental
   * lifecycle evidence. Each invocation is short-lived, resumes from the last
   * checkpoint claim, and is abortable so detach, close, delete, and app shutdown
   * cannot leak a `gjc` reader process.
   */
  private startTailFollower(sessionId: string): void {
    if (
      this.disposed ||
      this.tailReads.has(sessionId) ||
      !this.attachedSessions.has(sessionId)
    )
      return;
    const abortController = new AbortController();
    this.tailControllers.set(sessionId, abortController);
    const follow = this.followSessionTail(sessionId, abortController).finally(
      () => {
        if (this.tailReads.get(sessionId) === follow)
          this.tailReads.delete(sessionId);
        if (this.tailControllers.get(sessionId) === abortController)
          this.tailControllers.delete(sessionId);
      },
    );
    this.tailReads.set(sessionId, follow);
    void follow.catch(() => undefined);
    this.clearTodoPoll(sessionId);
    this.startToolObserver(sessionId);
  }

  private stopTailFollower(sessionId: string): void {
    this.toolObservers.get(sessionId)?.abort();
    this.toolObservers.delete(sessionId);
    this.toolSnapshots.delete(sessionId);
    this.tailControllers.get(sessionId)?.abort();
    this.tailControllers.delete(sessionId);
    // Ownership of the slot ends synchronously. The old promise's `finally`
    // checks identity before cleanup, so it cannot remove a replacement follower.
    this.tailReads.delete(sessionId);
    this.tailCheckpoints.delete(sessionId);
  }

  private startToolObserver(sessionId: string): void {
    if (this.toolObservers.has(sessionId) || this.disposed) return;
    const controller = new AbortController();
    this.toolObservers.set(sessionId, controller);
    const detached = new Promise<void>((resolve) => {
      controller.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    void (async () => {
      while (!this.disposed && !controller.signal.aborted && this.attachedSessions.has(sessionId)) {
        try {
          const cli = await this.requireCli();
          if (controller.signal.aborted) return;
          await cli.observeTools(sessionId, (kind, payload) => {
            if (!controller.signal.aborted && !this.disposed)
              this.projectToolStream(sessionId, kind, payload);
          }, controller.signal, this.repoFor(sessionId));
        } catch {
          // The observer has no lifecycle authority. Durable tail/file reads still
          // work during relay failure, and a fresh connection accepts snapshots.
        }
        if (!controller.signal.aborted) await tailReadPause(detached);
      }
    })().finally(() => {
      if (this.toolObservers.get(sessionId) === controller) this.toolObservers.delete(sessionId);
    });
  }

  private projectToolStream(sessionId: string, kind: string, payload: Record<string, unknown>): void {
    const event = payload.event;
    if (!event || typeof event !== "object" || Array.isArray(event)) return;
    const value = event as Record<string, unknown>;
    if (value.type !== kind || typeof value.toolCallId !== "string" || typeof value.toolName !== "string") return;
    if (!["tool_execution_start", "tool_execution_update", "tool_execution_end"].includes(kind)) return;
    const existing = this.transcripts.get(sessionId)?.find((item) => item.kind === "tool" && item.id === value.toolCallId);
    if (existing?.kind === "tool" && !LIVE_TOOL_STATUSES.has(existing.status)) return;
    const ended = kind === "tool_execution_end";
    const result = ended ? value.result : value.partialResult;
    const record = result && typeof result === "object" && !Array.isArray(result)
      ? result as Record<string, unknown> : undefined;
    const text = record ? toolResultText(record) ?? "" : undefined;
    this.upsertTool(sessionId, {
      sessionUpdate: kind === "tool_execution_start" ? "tool_call" : "tool_call_update",
      toolCallId: value.toolCallId,
      title: value.toolName,
      rawInput: value.args,
      status: ended ? value.isError === true ? "failed" : "completed" : "in_progress",
      ...(record ? {
        rawOutput: !ended && value.toolName === "bash"
          ? `[실시간 출력 스냅샷 · 앞부분이 생략될 수 있음]\n${text}` : text,
        content: Array.isArray(record.content) ? record.content : undefined,
      } : {}),
    });
    const tool = this.transcripts.get(sessionId)?.find((item): item is ToolActivity => item.kind === "tool" && item.id === value.toolCallId);
    if (!tool) return;
    let snapshots = this.toolSnapshots.get(sessionId);
    if (!snapshots) this.toolSnapshots.set(sessionId, snapshots = new Map());
    snapshots.set(tool.id, { ...tool });
    if (snapshots.size > 256) snapshots.delete(snapshots.keys().next().value!);
  }

  private async followSessionTail(
    sessionId: string,
    controller: AbortController,
  ): Promise<void> {
    const detached = new Promise<void>((resolve) => {
      if (controller.signal.aborted) resolve();
      else
        controller.signal.addEventListener("abort", () => resolve(), {
          once: true,
        });
    });
    let transientFailures = 0;
    while (
      !this.disposed &&
      !controller.signal.aborted &&
      this.attachedSessions.has(sessionId)
    ) {
      try {
        const cli = await this.requireCli();
        const tail = await cli.tail(sessionId, {
          repo: this.repoFor(sessionId),
          ...(this.tailCheckpoints.get(sessionId)
            ? { cursor: this.tailCheckpoints.get(sessionId) }
            : {}),
          untilIdle: true,
          timeoutMs: TAIL_WINDOW_MS,
          signal: controller.signal,
        });
        transientFailures = 0;
        if (tail.gap) {
          this.tailCheckpoints.delete(sessionId);
          await this.refreshTranscriptFromFile(sessionId);
          continue;
        }
        if (tail.checkpointToken)
          this.tailCheckpoints.set(sessionId, tail.checkpointToken);
        this.projectTailItems(sessionId, tail.items);
        if (tail.source === "offline") return;
        // A reader that answered with no frames at all did no work. The CLI owns the
        // wait window and normally blocks for it, but an endpoint that accepts the
        // read and has nothing to send answers at once, and re-issuing that straight
        // away would spawn one reader process per iteration -- a tighter loop than
        // the longer window ever allowed. One window of quiet before the next read
        // bounds the poll rate; frames that arrive during it wait for the next pass,
        // which the shorter window already made the norm.
        if (tail.items.length === 0) await tailReadPause(detached);
      } catch (error) {
        if (controller.signal.aborted || this.disposed) return;
        if (error instanceof SdkCliError) {
          if (error.code === "aborted") return;
          // A timeout means only that no terminal turn event arrived inside this
          // bounded window. It is not a failed run and never clears the spinner.
          if (error.code === "tail_timeout") continue;
          if (error.code === "retention_gap") {
            this.tailCheckpoints.delete(sessionId);
            await this.refreshTranscriptFromFile(sessionId);
            continue;
          }
          if (
            error.code === "session_deleted" ||
            error.code === "session_unavailable"
          )
            return;
        }
        // The session is still attached, so a transport failure is not a reason to
        // stop following it forever. Retry with a capped backoff, preserving the
        // checkpoint, instead of leaving the early-returning attach path with no
        // follower and no way to notice.
        transientFailures += 1;
        await tailRetryPause(detached, transientFailures);
        continue;
      }
    }
  }

  private projectTailItems(
    sessionId: string,
    items: Array<{ kind: string; payload: unknown }>,
  ): void {
    let transcriptEvidence = false;
    for (const item of items) {
      const payload =
        item.payload &&
        typeof item.payload === "object" &&
        !Array.isArray(item.payload)
          ? (item.payload as Record<string, unknown>)
          : undefined;
      const directUpdate = payload?.sessionUpdate;
      const nested =
        payload?.update &&
        typeof payload.update === "object" &&
        !Array.isArray(payload.update)
          ? (payload.update as Record<string, unknown>)
          : undefined;
      if (typeof directUpdate === "string")
        this.handleSessionUpdate({
          sessionId,
          update: payload as unknown as SessionUpdate,
        });
      else if (typeof nested?.sessionUpdate === "string")
        this.handleSessionUpdate({
          sessionId,
          update: nested as unknown as SessionUpdate,
        });
      if (item.kind === "transcript") transcriptEvidence = true;
      if (item.kind === "turn_start" || item.kind === "agent_start")
        this.updateSessionStatus(sessionId, "running");
      if (item.kind === "agent_failed")
        this.updateSessionStatus(sessionId, "failed", { announce: false });
      if (item.kind === "turn_end" || item.kind === "agent_end")
        void this.reconcileTailTerminalState(sessionId);
      if (item.kind === "session_closed" || item.kind === "session_terminated")
        this.stopTailFollower(sessionId);
    }
    if (transcriptEvidence) void this.refreshTranscriptFromFile(sessionId);
  }

  private async refreshTranscriptFromFile(sessionId: string): Promise<void> {
    const previous = this.transcripts.get(sessionId);
    const items = await this.readPersistedTranscript(sessionId).catch(
      () => undefined,
    );
    if (!items || this.disposed) return;
    const installed = this.installTranscript(sessionId, items);
    this.publishTranscriptSync(sessionId, previous, installed);
  }

  private async reconcileTailTerminalState(sessionId: string): Promise<void> {
    const generation = this.generation;
    const revision = this.currentRunRevision(sessionId);
    const state = await this.discoveredRunState(sessionId);
    if (state !== undefined && state !== "running" && generation === this.generation && revision === this.currentRunRevision(sessionId))
      this.updateSessionStatus(sessionId, "idle");
  }

  /**
   * Projects one session update into the transcript.
   *
   * These come from `gjc sdk session tail` frames and from rows read
   * out of the session file, both of which carry the same shapes. Keeping this
   * switch as the single projection point is what lets the renderer stay unchanged.
   */
  private handleSessionUpdate(notification: SessionNotification): void {
    const { sessionId, update } = notification;
    switch (update.sessionUpdate) {
      case "user_message_chunk":
        this.projectMessageChunk(sessionId, "user", update);
        break;
      case "agent_message_chunk":
        this.finalizeThought(sessionId);
        this.projectMessageChunk(sessionId, "assistant", update);
        break;
      case "agent_thought_chunk":
        this.projectThoughtChunk(sessionId, update);
        break;
      case "tool_call":
        this.finalizeThought(sessionId);
        this.upsertTool(sessionId, update);
        break;
      case "tool_call_update":
        this.upsertTool(sessionId, update);
        break;
      case "session_info_update":
        this.patchSessionInfo(sessionId, update);
        break;
      case "plan":
        this.upsertPlan(sessionId, update.entries);
        break;
      case "available_commands_update": {
        // GJC's own command list for this session. An empty update is authoritative
        // too -- it says the session has no dynamic commands, so the synthesized
        // skill entries must not be merged back over it.
        void this.refreshSdkCommands(
          sessionId,
          agentCommands(update.availableCommands),
        );
        break;
      }
      case "config_option_update":
        this.captureSessionState(sessionId, update.configOptions);
        if (this.attachedSessions.has(sessionId))
          void this.refreshModelProfiles(sessionId);
        break;
      case "current_mode_update":
        this.patchSessionRuntime(sessionId, { mode: update.currentModeId });
        break;
      case "usage_update":
        if (update.size > 0)
          this.patchSessionRuntime(sessionId, {
            usagePercent: Math.min(
              100,
              Math.max(0, (update.used / update.size) * 100),
            ),
            usagePending: false,
          });
        break;
      default:
        break;
    }
  }

  private projectThoughtChunk(
    sessionId: string,
    update: Extract<SessionUpdate, { sessionUpdate: "agent_thought_chunk" }>,
  ): void {
    const text = textFromContent(update.content);
    if (!text) return;
    const existingId = this.activeThoughts.get(sessionId);
    if (existingId) {
      const thought = (this.transcripts.get(sessionId) ?? []).find(
        (item): item is ThoughtActivity =>
          item.kind === "thought" && item.id === existingId,
      );
      if (!thought) return;
      thought.content += text;
      this.emitEvent({
        type: "thought.delta",
        sessionId,
        thoughtId: thought.id,
        delta: text,
        streaming: true,
      });
      return;
    }
    const thought: ThoughtActivity = {
      id: update.messageId
        ? `gjc-thought-${update.messageId}`
        : `gjc-thought-${this.nextLocalId++}`,
      kind: "thought",
      sessionId,
      content: text,
      createdAt: nowLabel(),
      streaming: true,
    };
    this.activeThoughts.set(sessionId, thought.id);
    this.appendTranscript(thought);
  }

  private finalizeThought(sessionId: string): void {
    const thoughtId = this.activeThoughts.get(sessionId);
    if (!thoughtId) return;
    const thought = (this.transcripts.get(sessionId) ?? []).find(
      (item): item is ThoughtActivity =>
        item.kind === "thought" && item.id === thoughtId,
    );
    if (thought) {
      thought.streaming = false;
      this.emitEvent({
        type: "thought.delta",
        sessionId,
        thoughtId,
        delta: "",
        streaming: false,
      });
    }
    this.activeThoughts.delete(sessionId);
  }

  private upsertPlan(
    sessionId: string,
    entries: Extract<SessionUpdate, { sessionUpdate: "plan" }>["entries"],
  ): void {
    const items = this.transcripts.get(sessionId) ?? [];
    const existing = items.find(
      (item): item is PlanActivity => item.kind === "plan",
    );
    const plan: PlanActivity = {
      id: existing?.id ?? `gjc-plan-${this.nextLocalId++}`,
      kind: "plan",
      sessionId,
      entries: entries.map((entry) => ({
        content: entry.content,
        status:
          entry.status === "in_progress" || entry.status === "completed"
            ? entry.status
            : "pending",
      })),
      createdAt: existing?.createdAt ?? nowLabel(),
    };
    if (existing) Object.assign(existing, plan);
    else this.appendTranscript(plan);
    // The row the session actually carries is the retained one, so a later durable
    // rebuild composes the same plan state instead of an earlier copy of it. An
    // update with no entries is still an update: it clears them.
    this.sessionPlans.set(sessionId, existing ?? plan);
    this.emitEvent({
      type: "plan.updated",
      plan: { ...plan, entries: plan.entries.map((entry) => ({ ...entry })) },
    });
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
  private installTranscript(
    sessionId: string,
    items: TranscriptItem[],
  ): TranscriptItem[] {
    const snapshots = this.toolSnapshots.get(sessionId);
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
    const previous = this.transcripts.get(sessionId) ?? [];
    const ids = new Set(items.map((item) => item.id));
    // App-owned views the durable read never carries: the plan the runtime reported
    // and the todo snapshot this window queried.
    const appOwned = [
      this.sessionPlans.get(sessionId),
      this.sessionTodoSnapshots.get(sessionId)?.row,
    ];
    const retained: Array<{
      row: TranscriptItem;
      afterId: string | undefined;
    }> = [];
    for (let index = 0; index < previous.length; index += 1) {
      const row = previous[index]!;
      const isAppOwned =
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
      if (!isLiveOnlyRow(row)) continue;
      const twin = durableTwinOf(items, row);
      if (twin) {
        // The block this row streamed is now recorded under the read's own id, so
        // the deltas still addressed to the id the wire invented are handed to the
        // row that holds it. Without that they would find no row to append to and
        // the rest of the block would be dropped.
        if (this.activeAssistantMessages.get(sessionId) === row.id)
          this.activeAssistantMessages.set(sessionId, twin.id);
        if (this.activeThoughts.get(sessionId) === row.id)
          this.activeThoughts.set(sessionId, twin.id);
        continue;
      }
      const anchor = precedingSharedRow(previous, index, ids);
      if (durableTurnEnded(items, anchor)) continue;
      retained.push({ row, afterId: anchor?.id });
    }
    const composed = composeTranscriptRows(items, retained);
    if (this.terminalOnlySessions.has(sessionId) && !composed.some((item) => item.id === `terminal-only-${sessionId}`))
      composed.push(this.terminalOnlyNotice(sessionId));
    this.transcripts.set(sessionId, composed);
    return composed;
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
  private async todoRowsForGoal(sessionId: string): Promise<unknown[]> {
    const snapshot = this.sessionTodoSnapshots.get(sessionId);
    if (this.attachedSessions.has(sessionId)) {
      this.clearTodoPoll(sessionId);
      if (snapshot) return snapshot.rows ?? [];
      return (await this.readTodoRecords(sessionId)) ?? [];
    }
    // A failed read still leaves a snapshot, and that must not turn the goal
    // poll back into a `todo.list` on every pass. The backoff timer retries it.
    if (snapshot) {
      this.armTodoPoll(sessionId);
      return snapshot.rows ?? [];
    }
    const rows = (await this.readTodoRecords(sessionId)) ?? [];
    this.armTodoPoll(sessionId);
    return rows;
  }

  private armTodoPoll(sessionId: string): void {
    if (
      this.disposed ||
      this.attachedSessions.has(sessionId) ||
      !this.sessions.has(sessionId) ||
      this.todoPollTimers.has(sessionId)
    )
      return;
    const attempt = this.todoPollAttempts.get(sessionId) ?? 0;
    const delay = Math.min(
      TODO_EVENT_POLL_MAX_MS,
      TODO_EVENT_POLL_BASE_MS * 2 ** attempt,
    );
    const timer = setTimeout(() => {
      this.todoPollTimers.delete(sessionId);
      if (
        this.disposed ||
        !this.sessions.has(sessionId) ||
        this.attachedSessions.has(sessionId)
      )
        return;
      this.todoPollAttempts.set(sessionId, attempt + 1);
      void this.readTodoRecords(sessionId).finally(() => {
        if (
          !this.disposed &&
          this.sessions.has(sessionId) &&
          !this.attachedSessions.has(sessionId)
        )
          this.armTodoPoll(sessionId);
      });
    }, delay);
    this.todoPollTimers.set(sessionId, timer);
  }

  private clearTodoPoll(sessionId: string): void {
    const timer = this.todoPollTimers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.todoPollTimers.delete(sessionId);
    this.todoPollAttempts.delete(sessionId);
  }

  private async readTodoRecords(
    sessionId: string,
  ): Promise<unknown[] | undefined> {
    const pending = this.todoReads.get(sessionId);
    if (pending) return pending;
    const read = this.queryTodoRecords(sessionId);
    this.todoReads.set(sessionId, read);
    try {
      return await read;
    } finally {
      if (this.todoReads.get(sessionId) === read) this.todoReads.delete(sessionId);
    }
  }

  private async queryTodoRecords(
    sessionId: string,
  ): Promise<unknown[] | undefined> {
    const observedAt = nowLabel();
    let rows: unknown[] | undefined;
    let failure: string | undefined;
    try {
      rows = await this.querySessionItems(
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
    if (this.disposed || !this.sessions.has(sessionId)) return undefined;
    if (rows === undefined)
      this.publishTodoSnapshot(sessionId, { error: failure, observedAt });
    else this.publishTodoSnapshot(sessionId, { rows, observedAt });
    return rows;
  }

  /**
   * Record what the todo store held, or that it could not be read.
   *
   * A failed read keeps the last successful snapshot on screen and says it is
   * stale; with no earlier success it says the store is unavailable. Neither case
   * may render as an empty list.
   */
  private publishTodoSnapshot(
    sessionId: string,
    observed:
      | { rows: unknown[]; observedAt: string }
      | { error: string | undefined; observedAt: string },
  ): void {
    const previous = this.sessionTodoSnapshots.get(sessionId);
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
    this.sessionTodoSnapshots.set(sessionId, {
      row,
      ...(rows === undefined ? {} : { rows }),
      ...(json === undefined ? {} : { json }),
      ...(observedAt === undefined ? {} : { observedAt }),
    });
    this.publishAppRow(sessionId, row);
  }

  /**
   * Put an app-owned row into a session's transcript.
   *
   * A row that has not changed is not republished: the goal panel and a transcript
   * bootstrap both read the same store, and each read would otherwise emit an IPC
   * row with identical content. A session with no installed transcript keeps the row
   * in its snapshot state, and the next install composes it in.
   */
  private publishAppRow(sessionId: string, row: SystemNoticeActivity): void {
    const items = this.transcripts.get(sessionId);
    if (items) {
      const index = items.findIndex((item) => item.id === row.id);
      const existing = index >= 0 ? items[index] : undefined;
      if (existing && sameTranscriptItem(existing, row)) return;
      if (index >= 0) items[index] = row;
      else items.push(row);
    }
    this.emitEvent({
      type: "transcript.appended",
      item: cloneTranscriptItem(row),
    });
  }

  private captureSessionState(
    sessionId: string,
    options: SessionConfigOption[],
    mode?: string | null,
  ): void {
    const normalized = agentConfigOptions(options);
    const discoveredProfiles = this.modelProfiles.get(sessionId);
    const modelOption = normalized.find(
      (option) => option.category === "model" || option.id === "model",
    );
    const selectedPreset =
      typeof modelOption?.currentValue === "string"
        ? modelOption.currentValue.replace(/^gajae-code\//u, "")
        : undefined;
    const thinkingOption = normalized.find(
      (option) =>
        option.category === "thought_level" || option.id === "thinking",
    );
    if (
      thinkingOption &&
      selectedPreset === this.modelPreset &&
      this.modelPresetThinking
    ) {
      thinkingOption.currentValue =
        this.explicitSessionThinking.get(sessionId) ?? this.modelPresetThinking;
    }
    if (modelOption && discoveredProfiles?.length)
      modelOption.options = discoveredProfiles;
    this.sessionConfig.set(sessionId, normalized);
    this.emitEvent({ type: "session.config", sessionId, options: normalized });
    const model = normalized.find(
      (option) => option.category === "model" || option.id === "model",
    );
    const thinking = normalized.find(
      (option) =>
        option.category === "thought_level" || option.id === "thinking",
    );
    const modelValue =
      typeof model?.currentValue === "string" ? model.currentValue : undefined;
    const currentSession = this.sessions.get(sessionId);
    const modelChanged =
      modelValue !== undefined && currentSession?.model !== modelValue;
    this.patchSessionRuntime(sessionId, {
      ...(mode ? { mode } : {}),
      ...(modelValue !== undefined ? { model: modelValue } : {}),
      ...(modelChanged ? { modelDisplay: undefined } : {}),
      ...(typeof thinking?.currentValue === "string"
        ? { thinking: thinking.currentValue }
        : {}),
    });
  }

  /**
   * Builds this session's config options from the session-scoped SDK config.
   *
   * The model/thinking selectors behind `/model` and Shift+Tab read these values.
   * The
   * session's own `config.list/get` is the authoritative source, and it answers the
   * session's real preset rather than a process-wide launch flag.
   */
  private async refreshSessionConfigOptions(sessionId: string): Promise<void> {
    const row = await this.sessionConfigRow(sessionId);
    if (!row) return;
    const preset =
      typeof row.modelPreset === "string" && row.modelPreset
        ? row.modelPreset
        : undefined;
    const thinking =
      typeof row.thinking === "string" && row.thinking ? row.thinking : undefined;
    const mode = typeof row.mode === "string" && row.mode ? row.mode : undefined;
    const options: SessionConfigOption[] = [
      {
        type: "select",
        id: "model",
        name: "Model",
        category: "model",
        currentValue: preset ?? this.modelPreset,
        options: (this.modelProfiles.get(sessionId) ?? []).map((profile) => ({
          type: "item",
          id: profile.value,
          name: profile.name,
          ...(profile.group ? { group: profile.group } : {}),
          ...(profile.description ? { description: profile.description } : {}),
        })),
      },
      {
        type: "select",
        id: "thinking",
        name: "Thinking",
        category: "thought_level",
        currentValue:
          this.explicitSessionThinking.get(sessionId) ??
          thinking ??
          this.modelPresetThinking,
        options: [...EFFORT_LEVELS].map((level) => ({
          type: "item",
          id: level,
          name: level,
        })),
      },
      ...(mode
        ? [
            {
              type: "select" as const,
              id: "mode",
              name: "Mode",
              category: "mode",
              currentValue: mode,
              options: [{ type: "item", id: mode, name: mode }],
            },
          ]
        : []),
    ];
    this.captureSessionState(sessionId, options, mode);
  }

  /** One row of the session's own config, or undefined when it cannot answer. */
  private async sessionConfigRow(
    sessionId: string,
  ): Promise<Record<string, unknown> | undefined> {
    try {
      const cli = await this.requireCli();
      const items = await cli.queryItems(
        sessionId,
        "config.list/get",
        {},
        { repo: this.repoFor(sessionId) },
      );
      return items.find(
        (item): item is Record<string, unknown> =>
          Boolean(item) && typeof item === "object" && !Array.isArray(item),
      );
    } catch {
      return undefined;
    }
  }

  /**
   * Reconciles the session's reported model/thinking/mode after a change.
   *
   * The session-scoped SDK config is the only thing that answers what the session
   * itself runs, so a restored session reports its own model instead of the
   * app-wide default.
   */
  private async refreshSessionSettings(sessionId: string): Promise<void> {
    try {
      const row = await this.sessionConfigRow(sessionId);
      if (!row) return;
      const preset =
        typeof row.modelPreset === "string" && row.modelPreset
          ? row.modelPreset
          : undefined;
      const thinking =
        typeof row.thinking === "string" && row.thinking
          ? row.thinking
          : undefined;
      const mode =
        typeof row.mode === "string" && row.mode ? row.mode : undefined;
      // A host that reports the session's service tier here is read too: /fast
      // inverts this value, and guessing the direction is how a scoped fast tier
      // gets silently downgraded.
      const serviceTier =
        typeof row.serviceTier === "string" && row.serviceTier
          ? row.serviceTier
          : undefined;
      if (!preset && !thinking && !mode && !serviceTier) return;
      const current = this.sessions.get(sessionId);
      this.patchSessionRuntime(sessionId, {
        ...(preset ? { model: preset } : {}),
        ...(thinking ? { thinking } : {}),
        ...(mode ? { mode } : {}),
        ...(serviceTier ? { serviceTier } : {}),
      });
      const options = this.sessionConfig.get(sessionId);
      if (options && (preset || thinking || mode)) {
        const updated = options.map((option) => {
          if ((option.category === "model" || option.id === "model") && preset)
            return { ...option, currentValue: preset };
          if (
            (option.category === "thought_level" || option.id === "thinking") &&
            thinking
          )
            return { ...option, currentValue: thinking };
          if ((option.category === "mode" || option.id === "mode") && mode)
            return { ...option, currentValue: mode };
          return option;
        });
        this.sessionConfig.set(sessionId, updated);
        this.emitEvent({ type: "session.config", sessionId, options: updated });
      }
      if (preset && (current?.model !== preset || !current.modelDisplay)) {
        const capabilities = await this.modelCapabilities(sessionId, preset);
        this.patchSessionRuntime(sessionId, {
          modelDisplay:
            capabilities.modelDisplay ??
            this.modelProfiles
              .get(sessionId)
              ?.find((profile) => profile.value === preset)?.name ??
            preset,
        });
      }
    } catch {
      // A session that cannot answer a config query keeps the values it already had.
    }
  }

  private async refreshModelProfiles(sessionId: string): Promise<void> {
    try {
      const cli = await this.requireCli();
      const items = await cli.queryItems(
        sessionId,
        "models.profiles.list",
        {},
        { repo: this.repoFor(sessionId) },
      );
      const profiles = items
        .flatMap((item): AgentConfigOptionValue[] => {
          if (!item || typeof item !== "object") return [];
          const profile = item as {
            id?: unknown;
            displayName?: unknown;
            source?: unknown;
            available?: unknown;
          };
          if (typeof profile.id !== "string" || profile.available === false)
            return [];
          const configured = profile.source === "configured";
          return [
            {
              value: profile.id,
              name:
                typeof profile.displayName === "string" && profile.displayName
                  ? profile.displayName
                  : profile.id,
              group: configured ? "Custom profiles" : "Built-in profiles",
              description: configured
                ? "From ~/.gjc/agent/models.yml"
                : "Bundled with GJC",
            },
          ];
        })
        .sort((left, right) => {
          if (left.group !== right.group)
            return left.group === "Custom profiles" ? -1 : 1;
          return left.name.localeCompare(right.name);
        });
      if (profiles.length > 0) this.modelProfiles.set(sessionId, profiles);
      const existing = this.sessionConfig.get(sessionId) ?? [];
      if (existing.length > 0) {
        const selectedModel = existing.find(
          (option) => option.category === "model" || option.id === "model",
        )?.currentValue;
        const modelCapabilities =
          typeof selectedModel === "string"
            ? await this.modelCapabilities(sessionId, selectedModel)
            : undefined;
        const thinkingOptions = modelCapabilities?.thinkingOptions;
        // A preset whose catalog row carries no default-model label must still resolve to a
        // name: the profile list, then the raw preset id. Leaving it undefined is what pinned
        // the composer at "모델 확인 중…" after every preset change.
        const modelDisplay =
          modelCapabilities?.modelDisplay ??
          (typeof selectedModel === "string"
            ? (profiles.find((profile) => profile.value === selectedModel)
                ?.name ?? selectedModel)
            : undefined);
        if (modelDisplay) this.patchSessionRuntime(sessionId, { modelDisplay });
        const updated = existing.map((option) => {
          if (
            (option.category === "model" || option.id === "model") &&
            profiles.length > 0
          )
            return { ...option, options: profiles };
          if (
            (option.category === "thought_level" || option.id === "thinking") &&
            thinkingOptions
          ) {
            return { ...option, options: thinkingOptions };
          }
          return option;
        });
        this.sessionConfig.set(sessionId, updated);
        this.emitEvent({ type: "session.config", sessionId, options: updated });
      }
    } catch {
      // The active session keeps its cached model options when discovery is unavailable.
    }
  }

  private async modelCapabilities(
    sessionId: string,
    selectedModel: string,
  ): Promise<{
    thinkingOptions?: AgentConfigOptionValue[];
    modelDisplay?: string;
  }> {
    try {
      const cli = await this.requireCli();
      const items = await cli.queryItems(
        sessionId,
        "models.list/current",
        {},
        { repo: this.repoFor(sessionId) },
      );
      return {
        thinkingOptions: thinkingOptionsForModelCatalog(items, selectedModel),
        modelDisplay: profileDefaultModelLabel(items, selectedModel),
      };
    } catch {
      return {};
    }
  }

  /**
   * Context usage for a session, at most one query in flight per session.
   *
   * Every transcript write asks for this. Several subagents writing at once can
   * otherwise spawn a burst of redundant usage lookups, so a request that arrives
   * while one is running joins it instead of adding another.
   */
  private refreshContextUsage(sessionId: string): Promise<void> {
    const inFlight = this.contextUsageQueries.get(sessionId);
    if (inFlight) return inFlight;
    const query = this.queryContextUsage(sessionId).finally(() => {
      this.contextUsageQueries.delete(sessionId);
    });
    this.contextUsageQueries.set(sessionId, query);
    return query;
  }

  private async queryContextUsage(sessionId: string): Promise<void> {
    try {
      const items = await this.querySessionItems(sessionId, "context.get");
      const first = items[0];
      const usage =
        first && typeof first === "object" && !Array.isArray(first)
          ? (first as { usage?: unknown }).usage
          : undefined;
      if (!usage || typeof usage !== "object" || Array.isArray(usage)) return;
      const snapshot = usage as {
        percent?: unknown;
        tokens?: unknown;
        contextWindow?: unknown;
      };
      const percent =
        typeof snapshot.percent === "number"
          ? snapshot.percent
          : typeof snapshot.tokens === "number" &&
              typeof snapshot.contextWindow === "number" &&
              snapshot.contextWindow > 0
            ? (snapshot.tokens / snapshot.contextWindow) * 100
            : undefined;
      if (percent !== undefined) {
        this.patchSessionRuntime(sessionId, {
          usagePercent: Math.min(100, Math.max(0, percent)),
          usagePending: false,
        });
      } else if (snapshot.percent === null || snapshot.tokens === null) {
        this.patchSessionRuntime(sessionId, {
          usagePercent: undefined,
          usagePending: true,
        });
      }
    } catch {
      // Usage is advisory and must not block session attachment or prompting.
    }
  }

  private patchSessionRuntime(
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
  ): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    // A turn re-asserts the same runtime state repeatedly (status already running,
    // unchanged usage percent). Every emit is an IPC broadcast that re-renders the
    // renderer's whole session subtree, so a patch that changes nothing is dropped.
    const changed = Object.entries(patch).some(
      ([key, value]) => session[key as keyof AgentSession] !== value,
    );
    if (!changed) return;
    if (
      Object.hasOwn(patch, "status") &&
      patch.status !== undefined &&
      session.status !== patch.status
    )
      this.advanceRunRevision(sessionId);
    Object.assign(session, patch);
    this.emitEvent({ type: "session.updated", session: { ...session } });
  }

  private projectMessageChunk(
    sessionId: string,
    role: ChatMessage["role"],
    update: Extract<
      SessionUpdate,
      { sessionUpdate: "user_message_chunk" | "agent_message_chunk" }
    >,
  ): void {
    const text = textFromContent(update.content);
    const image =
      update.content.type === "image"
        ? imageFromContent(update.content, `gjc-image-${this.nextLocalId++}`)
        : undefined;
    const userMessageKey =
      role === "user" && update.messageId
        ? `user:${update.messageId}`
        : undefined;
    if (
      userMessageKey &&
      this.suppressedUserMessageKeys.get(sessionId)?.has(userMessageKey)
    )
      return;
    if (role === "user" && text && this.consumePromptEcho(sessionId, text)) {
      if (userMessageKey) {
        const suppressed =
          this.suppressedUserMessageKeys.get(sessionId) ?? new Set<string>();
        suppressed.add(userMessageKey);
        this.suppressedUserMessageKeys.set(sessionId, suppressed);
      }
      return;
    }
    if (!text && !image) return;
    const activeAssistantId =
      role === "assistant"
        ? this.activeAssistantMessages.get(sessionId)
        : undefined;
    const fallbackKey =
      role === "assistant"
        ? `assistant-${this.nextLocalId++}`
        : `user-${this.nextLocalId++}`;
    const externalKey = `${role}:${update.messageId ?? fallbackKey}`;
    const keys = this.messageKeys.get(sessionId) ?? new Map<string, string>();
    const existingId = activeAssistantId ?? keys.get(externalKey);

    if (existingId) {
      const items = this.transcripts.get(sessionId) ?? [];
      const message = items.find((item) => item.id === existingId);
      if (message?.kind !== "message") return;
      message.content += text;
      if (image) message.images = [...(message.images ?? []), image];
      message.streaming = role === "assistant";
      if (image)
        this.emitEvent({
          type: "message.updated",
          message: cloneTranscriptItem(message) as ChatMessage,
        });
      if (text) {
        this.emitEvent({
          type: "message.delta",
          sessionId,
          messageId: message.id,
          delta: text,
          streaming: message.streaming,
        });
      }
      return;
    }

    const id = update.messageId
      ? `gjc-message-${update.messageId}`
      : `gjc-message-${this.nextLocalId++}`;
    keys.set(externalKey, id);
    this.messageKeys.set(sessionId, keys);
    if (role === "assistant") this.activeAssistantMessages.set(sessionId, id);
    const message: ChatMessage = {
      id,
      kind: "message",
      sessionId,
      role,
      content: text,
      ...(image ? { images: [image] } : {}),
      createdAt: nowLabel(),
      streaming: role === "assistant",
    };
    this.appendTranscript(message);
  }

  private upsertTool(
    sessionId: string,
    update: Extract<
      SessionUpdate,
      { sessionUpdate: "tool_call" | "tool_call_update" }
    >,
  ): void {
    const items = this.transcripts.get(sessionId) ?? [];
    const existing = items.find(
      (item): item is ToolActivity =>
        item.kind === "tool" && item.id === update.toolCallId,
    );
    if (
      this.locallyAbortedSessions.has(sessionId) &&
      update.sessionUpdate === "tool_call" &&
      !existing
    )
      return;
    if (update.sessionUpdate === "tool_call" && !existing)
      this.finalizeAssistantMessage(sessionId);
    const name = inferToolName(update, existing);
    const input =
      update.rawInput &&
      typeof update.rawInput === "object" &&
      !Array.isArray(update.rawInput)
        ? (update.rawInput as Record<string, unknown>)
        : undefined;
    const diff =
      toolDiffText(update.rawOutput, update.content) ?? existing?.diff;
    const images = [
      ...toolImageRefs(update.content),
      ...toolImageRefs(update.rawOutput),
    ];
    const projectedStatus = update.status
      ? toolStatus(update.status)
      : (existing?.status ?? "running");
    const rawOutput = update.rawOutput ?? update.content;
    const outputText =
      rawOutput === undefined
        ? undefined
        : typeof rawOutput === "string"
          ? rawOutput
          : JSON.stringify(rawOutput);
    const subagents =
      name === "task"
        ? input
          ? taskSubagents(input, projectedStatus, outputText)
          : existing?.subagents?.map((agent) => ({
              ...agent,
              status:
                receiptSubagentStatus(outputText, agent.id) ??
                taskStatus(projectedStatus),
            }))
        : undefined;
    const patch: ToolActivity = {
      id: update.toolCallId,
      kind: "tool",
      sessionId,
      name,
      description: update.title ?? existing?.description ?? name,
      command: boundedJson(update.rawInput) ?? existing?.command,
      status: projectedStatus,
      createdAt: existing?.createdAt ?? nowLabel(),
      output:
        boundedJson(update.rawOutput ?? update.content) ?? existing?.output,
      artifactRefs: [
        ...new Set([
          ...(existing?.artifactRefs ?? []),
          ...artifactReferences(update.rawInput),
          ...artifactReferences(update.rawOutput ?? update.content),
        ]),
      ],
      ...(diff ? { diff } : {}),
      ...(typeof input?.path === "string" && input.path
        ? { targetPath: input.path }
        : existing?.targetPath
          ? { targetPath: existing.targetPath }
          : {}),
      ...(images.length > 0
        ? { images }
        : existing?.images
          ? { images: existing.images }
          : {}),
      ...(subagents && subagents.length > 0 ? { subagents } : {}),
    };
    if (update.rawInput !== undefined) {
      const id = `${sessionId}-${update.toolCallId}-input`.replace(
        /[^A-Za-z0-9._-]/g,
        "_",
      );
      patch.inputArtifactId = id;
      void this.persistArtifact(sessionId, id, update.rawInput).catch((error) =>
        console.error(`Failed to persist tool input artifact ${id}`, error),
      );
    }
    if (update.rawOutput !== undefined || update.content !== undefined) {
      const id = `${sessionId}-${update.toolCallId}-output`.replace(
        /[^A-Za-z0-9._-]/g,
        "_",
      );
      patch.outputArtifactId = id;
      void this.persistArtifact(
        sessionId,
        id,
        update.rawOutput ?? update.content,
      ).catch((error) =>
        console.error(`Failed to persist tool output artifact ${id}`, error),
      );
    }
    if (existing) {
      Object.assign(existing, patch);
      this.emitEvent({ type: "tool.updated", tool: { ...existing } });
    } else {
      this.appendTranscript(patch);
    }
    // A todo tool that finished is the only live signal that the store may have
    // changed, and it is not a todo record: it is a request. The store itself is
    // read back so what is shown is what the runtime recorded, not the input op.
    if (name === "todo_write" && patch.status === "completed")
      void this.readTodoRecords(sessionId);
    if (patch.images?.some((image) => image.blobId && !image.dataUrl)) {
      const settled = existing ?? patch;
      void this.resolveToolImages([settled])
        .then(() => {
          this.emitEvent({ type: "tool.updated", tool: { ...settled } });
        })
        .catch(() => undefined);
    }
  }

  private async persistArtifact(
    sessionId: string,
    artifactId: string,
    value: unknown,
  ): Promise<void> {
    if (this.deletingSessions.has(sessionId)) return;
    let sessionArtifacts = this.artifactSessionIds.get(sessionId);
    if (!sessionArtifacts) {
      sessionArtifacts = new Set<string>();
      this.artifactSessionIds.set(sessionId, sessionArtifacts);
    }
    sessionArtifacts.add(artifactId);
    const text = redactSensitiveText(
      typeof value === "string" ? value : JSON.stringify(value, null, 2),
    );
    const namespace = this.artifactNamespace(sessionId);
    const file = path.join(
      this.artifactDirectory,
      namespace,
      `${artifactId}.json`,
    );
    const writeKey = this.artifactWriteKey(sessionId, artifactId);
    const previous = this.artifactWrites.get(writeKey) ?? Promise.resolve();
    const operation = previous
      .catch(() => undefined)
      .then(async () => {
        if (this.deletingSessions.has(sessionId)) return;
        await mkdir(path.dirname(file), { recursive: true });
        const temporary = `${file}.${process.pid}.${this.nextLocalId++}.tmp`;
        await writeFile(temporary, JSON.stringify({ text }), { mode: 0o600 });
        await rename(temporary, file);
      });
    this.artifactWrites.set(writeKey, operation);
    try {
      await operation;
    } finally {
      if (this.artifactWrites.get(writeKey) === operation)
        this.artifactWrites.delete(writeKey);
    }
  }

  /**
   * Records a tool call that is waiting on an approval decision.
   *
   * A broker-hosted session host cannot ask an external controller for a decision,
   * so nothing calls this over a live channel any more; the session's permission
   * mode is set instead (see `applyPermissionMode`). It stays because a transcript
   * row can still report a tool as awaiting approval, and the window has to show
   * that state and be able to clear it on cancel.
   */
  private requestPermission(
    request: PendingPermission["request"],
  ): Promise<{ outcome: { outcome: string; optionId?: string } }> {
    const { toolCall } = request;
    this.upsertTool(request.sessionId, {
      sessionUpdate: "tool_call_update",
      ...toolCall,
      status: "pending",
    });
    this.patchTool(toolCall.toolCallId, { status: "approval-required" });
    this.patchTool(toolCall.toolCallId, {
      permissionOptions: request.options.map((option) => ({
        optionId: option.optionId,
        kind: option.kind,
        name: option.name,
      })),
    });
    return new Promise((resolve) => {
      this.pendingPermissions.set(toolCall.toolCallId, { request, resolve });
    });
  }

  private patchTool(toolId: string, patch: Partial<ToolActivity>): void {
    for (const items of this.transcripts.values()) {
      const tool = items.find(
        (item): item is ToolActivity =>
          item.kind === "tool" && item.id === toolId,
      );
      if (!tool) continue;
      const waiting =
        tool.status !== "approval-required" &&
        patch.status === "approval-required";
      Object.assign(tool, patch);
      this.emitEvent({ type: "tool.updated", tool: { ...tool } });
      if (waiting) this.emitActivity(tool.sessionId, "permission");
      return;
    }
  }

  private patchSessionInfo(
    sessionId: string,
    update: Extract<SessionUpdate, { sessionUpdate: "session_info_update" }>,
  ): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (update.title?.trim() && !this.sessionMetadata?.getAlias(sessionId)) {
      session.title = readableSessionTitle(sessionId, update.title);
    }
    if (update.updatedAt) markUpdated(session, update.updatedAt);
    const phase =
      typeof update._meta?.gjcPhase === "string"
        ? update._meta.gjcPhase
        : undefined;
    const running = update._meta?.gjcRunning;
    const compactionState =
      update._meta?.gjcCompactionState === "start" ||
      update._meta?.gjcCompactionState === "end"
        ? update._meta.gjcCompactionState
        : undefined;
    const phaseTimestamp =
      typeof update.updatedAt === "string" ? Date.parse(update.updatedAt) : NaN;
    const staleOrderedPhase =
      (phase === "compacting" || phase === "working") &&
      Number.isFinite(phaseTimestamp) &&
      (this.compactionRecordWatermark.get(sessionId) ?? -Infinity) >=
        phaseTimestamp;
    if (phase === "compacting" && !staleOrderedPhase) {
      session.phase = "compacting";
      this.compactingSessions.add(sessionId);
      if (Number.isFinite(phaseTimestamp))
        this.compactionStartedAt.set(sessionId, phaseTimestamp);
      if (!this.locallyAbortedSessions.has(sessionId))
        session.status = "running";
    } else if (phase && !staleOrderedPhase) {
      // GJC reporting any other phase is the authority that compaction ended, so
      // this is where a locally started compaction is released. Returning from the
      // control call only meant the request was accepted.
      if (
        (phase === "working" && update.updatedAt !== undefined) ||
        phase === "responding" ||
        phase === "idle"
      ) {
        this.compactingSessions.delete(sessionId);
        this.compactionRecordBaseline.delete(sessionId);
        this.compactionStartedAt.delete(sessionId);
      }
      session.phase =
        phase === "responding" || phase === "idle" ? undefined : phase;
    }
    // A report carrying `updatedAt` is describing an actual change of state; GJC's
    // explicit compaction start/end events are ordered lifecycle evidence too, even
    // though current releases omit updatedAt on those two notifications.
    const lifecycleChanged =
      update.updatedAt !== undefined || compactionState !== undefined;
    const runtimeConfirmedWorkingCycle =
      lifecycleChanged &&
      !staleOrderedPhase &&
      (running === true || (phase !== undefined && phase !== "idle"));
    if (runtimeConfirmedWorkingCycle) {
      // A new ordered runtime cycle supersedes the app's cancellation fence; the
      // fence only suppresses stale evidence from the cancelled run.
      const cancelledAt = this.cancellationWatermarks.get(sessionId);
      if (cancelledAt !== undefined && Number.isFinite(phaseTimestamp) && phaseTimestamp > cancelledAt) {
        this.locallyAbortedSessions.delete(sessionId);
        this.cancellationWatermarks.delete(sessionId);
      }
      // A non-idle phase with a timestamp is a state change the runtime just
      // reported, which is live evidence of work like any other.
      this.recordLiveEvidence(sessionId);
      this.advanceRunRevision(sessionId);
      this.workingPhaseSessions.add(sessionId);
      this.runtimeIdleSessions.delete(sessionId);
    }
    const runtimeFinishedWorkingCycle =
      lifecycleChanged &&
      (phase === "idle" || (phase === undefined && running === false)) &&
      this.workingPhaseSessions.has(sessionId);
    if (runtimeFinishedWorkingCycle) {
      this.runtimeIdleSessions.add(sessionId);
      // The transcript may already contain the final assistant row. If it does not,
      // its watcher will call this again when that row arrives.
      void this.readPersistedTranscript(sessionId);
    }
    if (
      running === true &&
      !staleOrderedPhase &&
      !this.locallyAbortedSessions.has(sessionId)
    ) {
      if (session.status !== "running" && !runtimeConfirmedWorkingCycle)
        this.advanceRunRevision(sessionId);
      // The report is the runtime asserting this session is working right now -- the
      // bootstrap pair an attach delivers is the same report -- so the aging clock
      // runs from here rather than from when the latch was first armed.
      this.recordLiveEvidence(sessionId);
      session.status = "running";
      if (!this.liveRunningSessions.has(sessionId)) {
        this.liveRunningSessions.add(sessionId);
        // Record how much transcript existed when the work was reported, so a later
        // read can tell an unchanged stale snapshot from one that watched it end.
        void this.rememberLiveRunningTranscriptSize(sessionId);
      }
    }
    if (phase === "compacting" && !staleOrderedPhase) {
      // Capture the revision only after this event has advanced it. Starting this
      // read earlier made it stale itself synchronously, so a completion record
      // already on disk could never clear the newly armed working marker.
      void this.readPersistedTranscript(sessionId).catch(() => undefined);
    }
    // A prompt this window sent owns the status until its own round trip settles,
    // because GJC reports gjcRunning:false for the state *before* the prompt was
    // accepted. Telling the two apart needs one bit of history: a stale report
    // arrives without GJC ever having confirmed the turn started, while a genuine
    // completion always follows a gjcRunning:true for that same turn. Ignoring
    // every report instead left the row running forever whenever the prompt never
    // got its reply.
    //
    // The same reasoning covers a turn nobody here started. Attaching to a session
    // makes GJC publish a bootstrap `gjcRunning:false` describing *this connection's*
    // prompt state, which says nothing about work another process is driving. Reading
    // it as a completion is what flipped a working session to 완료 the moment it was
    // clicked. Only a report that follows a confirmed start closes a turn.
    const neverConfirmedRunning = !this.liveRunningSessions.has(sessionId);
    const staleForActivePrompt =
      this.activePromptSessions.has(sessionId) && neverConfirmedRunning;
    // Which report to discard depends on where the row's running state came from. A
    // status this window set for its own command is answered by that command's own
    // live report. A status read out of the transcript belongs to work in another
    // process, and the bootstrap report carries no information about it.
    const bootstrapForForeignTurn =
      !this.activePromptSessions.has(sessionId) &&
      neverConfirmedRunning &&
      this.transcriptRunningSessions.has(sessionId);
    // Attaching delivers two reports 0.1s apart, captured from the running app:
    //   {updatedAt, _meta:{gjcPhase:"working", gjcRunning:true}}
    //   {           _meta:{gjcPhase:"idle",    gjcRunning:false}}
    // The second is the bootstrap restatement of this connection's prompt slot, and it
    // has no `updatedAt` because nothing changed. The guard below already ignored it, but
    // only while nothing had confirmed the session running -- and the report 0.1s earlier
    // had just done exactly that, so the idle won and the row read 완료 while a tool was
    // still working.
    //
    // A real runtime transition states when it happened, so requiring `updatedAt`
    // rejects the restatement. It still does not finish the row by itself: the
    // transcript must also contain the cycle's terminal assistant response.
    const bootstrapIdleAfterWorking =
      update.updatedAt === undefined &&
      this.workingPhaseSessions.has(sessionId);
    if (
      running === false &&
      session.status !== "failed" &&
      !staleForActivePrompt &&
      !bootstrapForForeignTurn &&
      !bootstrapIdleAfterWorking &&
      !this.workingPhaseSessions.has(sessionId) &&
      !this.pendingAsyncWorkSessions.has(sessionId) &&
      !this.compactingSessions.has(sessionId)
    ) {
      // A turn this window did not start -- a steer, or work driven from the
      // terminal -- ends here rather than in sendMessage, so this is where its
      // completion is announced. A cancel is excluded: the user performed it and
      // is already watching, so announcing it is noise.
      const wasRunning = session.status === "running";
      if (session.status !== "idle") this.advanceRunRevision(sessionId);
      session.status = "idle";
      this.clearRunningLatches(sessionId);
      if (session.phase === "compacting") session.phase = undefined;
      if (
        wasRunning &&
        !this.cancellingSessions.has(sessionId) &&
        !this.locallyAbortedSessions.has(sessionId)
      )
        this.emitActivity(sessionId, "completed");
    }
    if (typeof update._meta?.gjcThinkingLevel === "string")
      session.thinking = update._meta.gjcThinkingLevel;
    this.emitEvent({ type: "session.updated", session: { ...session } });
  }

  async forkSession(input: {
    sourceSessionId: string;
    title?: string;
  }): Promise<AgentSession> {
    const source = this.sessions.get(input.sourceSessionId);
    if (!source)
      throw new Error(`Unknown GJC session: ${input.sourceSessionId}`);
    const cwd = this.sessionCwds.get(source.id);
    if (!cwd || path.resolve(cwd) !== path.resolve(source.workspace))
      throw new Error("Fork requires the canonical source workspace");
    await this.ensureAttached(source.id, false);
    // The fork itself is what creates the session; the lifecycle receipt is only
    // the evidence that it was recorded. A receipt that cannot be verified was
    // reported as a failed fork even though the broker had already created the
    // session -- which is why discovery listed it moments later. The broker index
    // is the authority on whether that happened, so it is consulted instead of
    // surfacing an error for a fork that succeeded.
    const knownSessionIds = new Set([
      ...this.sessions.keys(),
      ...((await this.brokerSessions()) ?? []).map((listed) => listed.sessionId),
    ]);
    const cli = await this.requireCli();
    let forkedId: string | undefined;
    const forkRequestId = `gajae-session-fork-${randomUUID()}`;
    const forkStartedAt = Date.now();
    try {
      const forked = await cli.rawGlobal(
        "session.fork",
        {
          cwd,
          sourceSessionId: source.id,
          modelPreset: this.modelPreset,
        },
        { repo: cwd, idempotencyKey: forkRequestId },
      );
      if (typeof forked?.sessionId === "string") forkedId = forked.sessionId;
    } catch (error) {
      if (!isLifecycleUncertain(error)) throw error;
    }
    // The fork changes the broker index. A discovery cache taken before it
    // would omit the new session until the index file's revision moved.
    this.invalidateBrokerIndexCache();
    if (!forkedId)
      forkedId = await this.recoverForkedSession(
        cwd,
        knownSessionIds,
        forkStartedAt,
      );
    if (!forkedId)
      throw new Error(
        "GJC가 세션을 포크했지만 lifecycle 영수증을 검증하지 못했습니다. 보존된 포크 자동 복구에도 실패했습니다. GJC lifecycle ledger reconciliation이 필요합니다.",
      );
    const inheritedWorktree =
      source.worktree?.managed === true &&
      path.resolve(source.worktree.path) === path.resolve(cwd)
        ? source.worktree
        : undefined;
    const session: AgentSession = {
      id: forkedId,
      title: input.title?.trim() || `${source.title} (fork)`,
      subtitle: path.basename(cwd) || cwd,
      workspace: cwd,
      runtime: "gjc",
      status: "idle",
      updatedAt: "now",
      updatedAtMs: Date.now(),
      // The fork this window asked for already knows the source; the envelope read
      // only has to cover sessions this window did not create.
      parentId: input.sourceSessionId,
      pinned: false,
      unread: false,
      accent: GJC_ACCENT,
      ownership: "gajae",
      attachment: "recovering",
      ...(inheritedWorktree ? { worktree: inheritedWorktree } : {}),
    };
    this.sessions.set(session.id, session);
    this.windowHostedSessions.add(session.id);
    this.sessionCwds.set(session.id, cwd);
    this.sessionMetadata?.setAlias(session.id, session.title);
    this.sessionMetadata?.setWorkspace(session.id, cwd);
    this.sessionMetadata?.setOwnership(session.id, "gajae");
    if (inheritedWorktree)
      this.sessionMetadata?.setWorktree(session.id, inheritedWorktree);
    try {
      await this.applyPermissionMode(session.id);
    } catch (error) {
      session.status = "failed";
      this.emitEvent({ type: "session.created", session: { ...session } });
      throw error;
    }
    session.attachment = "attached";
    this.attachedSessions.add(session.id);
    this.startTailFollower(session.id);
    await this.refreshSessionConfigOptions(session.id);
    const forkedFile = await this.locateSharedTranscriptFile(session.id);
    if (forkedFile) this.watchSharedTranscript(session.id, forkedFile);
    this.emitEvent({ type: "session.created", session: { ...session } });
    return { ...session };
  }

  /**
   * The id of the session a fork created, recovered from the broker index when the
   * fork's own lifecycle receipt could not be verified. Undefined when no new
   * session for this workspace appears, which means the fork really did not happen.
   */
  private async recoverForkedSession(
    cwd: string,
    knownSessionIds: ReadonlySet<string>,
    startedAt: number,
  ): Promise<string | undefined> {
    const workspace = canonicalWorkspace(cwd);
    const retained = await this.recoverLifecycleSession(
      workspace,
      knownSessionIds,
      startedAt,
      LIFECYCLE_RECOVERY_ATTEMPTS,
      this.forkRecoveryIntervalMs,
    );
    if (retained) {
      this.sessionCwds.set(retained, workspace);
      this.transcripts.set(retained, []);
      this.messageKeys.set(retained, new Map());
    }
    return retained;
  }

  /**
   * Finds the session a create or fork retained after an unverifiable receipt.
   *
   * GJC's public list/inspect projection strips `lifecycleRequestId` -- the ledger
   * marker is internal -- so matching the caller's idempotency key never succeeds.
   * What the index does establish is that a session is new to this workspace and
   * that its endpoint appeared after the request began. Two such sessions mean a
   * concurrent creator, which is ambiguous; the caller must not guess between them.
   */
  private async recoverLifecycleSession(
    workspaceDirectory: string,
    knownSessionIds: ReadonlySet<string>,
    startedAt: number,
    attempts = LIFECYCLE_RECOVERY_ATTEMPTS,
    intervalMs = LIFECYCLE_RECOVERY_INTERVAL_MS,
  ): Promise<string | undefined> {
    const workspace = canonicalWorkspace(workspaceDirectory);
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const candidates = ((await this.brokerSessions()) ?? []).filter(
        (listed) =>
          !knownSessionIds.has(listed.sessionId) &&
          listed.live &&
          !listed.deleted &&
          (listed.endpointGeneration ?? 0) > 0 &&
          listed.repo !== undefined &&
          canonicalWorkspace(listed.repo) === workspace &&
          Math.max(listed.endpointMtimeMs ?? 0, listed.activityAt ?? 0) >=
            startedAt - LIFECYCLE_RECOVERY_CLOCK_SLACK_MS,
      );
      if (candidates.length > 1) return undefined;
      if (candidates.length === 1) return candidates[0]!.sessionId;
      if (attempt < attempts - 1)
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    return undefined;
  }

  async getGitStatus(sessionId: string): Promise<GitStatusSnapshot> {
    const workspace = this.sessionCwds.get(sessionId) ?? this.workspace;
    // A session can live in a directory that is not a repository at all. `git status`
    // exits non-zero there, and that rejection reached the IPC handler as an
    // unhandled error every time the panel polled. No repository is a state, not a
    // failure, so it is reported as one.
    let result: { stdout: string };
    try {
      result = await execFile(
        "git",
        ["-C", workspace, "status", "--porcelain=v1", "-z", "--branch"],
        { maxBuffer: 2 * 1024 * 1024 },
      );
    } catch {
      return { workspace, branch: "", ahead: 0, behind: 0, files: [] };
    }
    let branch = "";
    let upstream: string | undefined;
    let ahead = 0;
    let behind = 0;
    const files: GitStatusSnapshot["files"] = [];
    const entries = result.stdout.split("\0").filter(Boolean);
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index]!;
      if (entry.startsWith("## ")) {
        const header = entry.slice(3);
        const match =
          /^(.*?)\.\.\.([^ ]+)(?: \[ahead (\d+)(?:, behind (\d+))?\]| \[behind (\d+)\])?$/u.exec(
            header,
          );
        if (match) {
          branch = match[1] ?? "";
          upstream = match[2];
          ahead = Number(match[3] ?? 0);
          behind = Number(match[4] ?? match[5] ?? 0);
        } else branch = gitBranchFromHeader(header);
        continue;
      }
      if (entry.length < 4) continue;
      const indexStatus = entry[0] ?? ".";
      const workingTree = entry[1] ?? ".";
      const filePath = entry.slice(3);
      if (safeGitPath(filePath))
        files.push({ path: filePath, index: indexStatus, workingTree });
      if (indexStatus === "R" || indexStatus === "C") index += 1;
    }
    return {
      workspace,
      branch,
      ...(upstream ? { upstream } : {}),
      ahead,
      behind,
      files,
    };
  }

  private async mutateGit(
    sessionId: string,
    args: string[],
  ): Promise<GitStatusSnapshot> {
    const session = this.sessions.get(sessionId);
    const worktree = session?.worktree;
    if (
      !session ||
      !worktree?.managed ||
      path.resolve(session.workspace) !== path.resolve(worktree.path)
    )
      throw new Error("Git mutation requires a managed Gajae worktree");
    const root = (
      await execFile("git", [
        "-C",
        worktree.path,
        "rev-parse",
        "--show-toplevel",
      ])
    ).stdout.trim();
    if (path.resolve(root) !== path.resolve(worktree.path))
      throw new Error("Managed worktree path verification failed");
    await execFile("git", ["-C", worktree.path, ...args]);
    return this.getGitStatus(sessionId);
  }
  async stageFiles(
    sessionId: string,
    paths: string[],
  ): Promise<GitStatusSnapshot> {
    const status = await this.getGitStatus(sessionId);
    const allowed = new Set(status.files.map((file) => file.path));
    if (
      paths.some((filePath) => !allowed.has(filePath) || !safeGitPath(filePath))
    )
      throw new Error(
        "Path is not an eligible repository-relative changed file",
      );
    return this.mutateGit(sessionId, ["add", "--", ...paths]);
  }
  async unstageFiles(
    sessionId: string,
    paths: string[],
  ): Promise<GitStatusSnapshot> {
    const status = await this.getGitStatus(sessionId);
    const allowed = new Set(status.files.map((file) => file.path));
    if (
      paths.some((filePath) => !allowed.has(filePath) || !safeGitPath(filePath))
    )
      throw new Error(
        "Path is not an eligible repository-relative changed file",
      );
    return this.mutateGit(sessionId, ["restore", "--staged", "--", ...paths]);
  }
  async commitChanges(
    sessionId: string,
    message: string,
  ): Promise<GitStatusSnapshot> {
    const text = message.trim();
    if (!text || text.length > 512)
      throw new Error("Commit message is required and bounded");
    return this.mutateGit(sessionId, ["commit", "-m", text]);
  }
  async pushChanges(sessionId: string): Promise<GitStatusSnapshot> {
    return this.mutateGit(sessionId, ["push"]);
  }

  private appendTranscript(item: TranscriptItem): void {
    const items = this.transcripts.get(item.sessionId) ?? [];
    items.push(item);
    this.transcripts.set(item.sessionId, items);
    this.emitEvent({
      type: "transcript.appended",
      item: cloneTranscriptItem(item),
    });
  }

  private emitActivity(
    sessionId: string,
    category: Extract<AgentEvent, { type: "session.activity" }>["category"],
  ): void {
    // A session this window prompted may not be in the discovered set yet. The
    // outcome still has to be announced, so an unknown session falls back to a
    // readable title rather than swallowing the notification.
    const session = this.sessions.get(sessionId);
    if (session) {
      session.unread = true;
      this.sessionMetadata?.setUnread(sessionId, true);
    }
    this.emitEvent({
      type: "session.activity",
      sessionId,
      title: session?.title ?? readableSessionTitle(sessionId, undefined),
      unread: true,
      category,
    });
  }

  private finalizeAssistantMessage(sessionId: string): void {
    const messageId = this.activeAssistantMessages.get(sessionId);
    if (!messageId) return;
    const items = this.transcripts.get(sessionId) ?? [];
    const message = items.find((item) => item.id === messageId);
    if (message?.kind === "message") {
      message.streaming = false;
      this.emitEvent({
        type: "message.delta",
        sessionId,
        messageId,
        delta: "",
        streaming: false,
      });
    }
    this.activeAssistantMessages.delete(sessionId);
  }

  private finalizeAllMessages(sessionId: string): void {
    const items = this.transcripts.get(sessionId) ?? [];
    for (const item of items) {
      if (item.kind !== "message" || !item.streaming) continue;
      item.streaming = false;
      this.emitEvent({
        type: "message.delta",
        sessionId,
        messageId: item.id,
        delta: "",
        streaming: false,
      });
    }
    this.activeAssistantMessages.delete(sessionId);
  }

  private currentRunRevision(sessionId: string): number {
    return (
      this.runRevisions.get(sessionId) ??
      this.sessions.get(sessionId)?.runRevision ??
      0
    );
  }

  private advanceRunRevision(sessionId: string): number {
    const revision = this.currentRunRevision(sessionId) + 1;
    this.runRevisions.set(sessionId, revision);
    const session = this.sessions.get(sessionId);
    if (session) session.runRevision = revision;
    return revision;
  }

  private updateSessionStatus(
    sessionId: string,
    status: AgentSession["status"],
    options?: { announce?: boolean },
  ): void {
    const session = this.sessions.get(sessionId);
    if (status === "running" && this.locallyAbortedSessions.has(sessionId))
      return;
    // Any running status published here -- this window's own prompt, steer, or
    // release round trip, or a tail frame announcing a turn -- is the freshest
    // account of work this process holds. Recording it gives the transcript the
    // grace window to catch up before it is allowed to overrule the row.
    if (status === "running") this.recordLiveEvidence(sessionId);
    // Any running -> idle transition is a finished turn, and the finish is what
    // the user is waiting for, so the announcement lives here rather than at each
    // callsite. A session owned by a terminal reaches idle through the persisted
    // transcript watcher, which is why announcing only from sendMessage left
    // those runs finishing silently.
    //
    // A session this window prompted before discovery listed it has no record
    // here yet; its turn still ran, so the announcement does not depend on one.
    //
    // A cancel is excluded: the user performed it and is already looking at the
    // window, so telling them about it is noise.
    const finishedTurn =
      options?.announce !== false &&
      status === "idle" &&
      (session?.status ?? "running") === "running" &&
      !this.cancellingSessions.has(sessionId) &&
      !this.locallyAbortedSessions.has(sessionId);
    if (session) {
      if (session.status !== status) this.advanceRunRevision(sessionId);
      session.status = status;
      markUpdated(session);
      this.emitEvent({ type: "session.updated", session: { ...session } });
    }
    if (finishedTurn) this.emitActivity(sessionId, "completed");
  }

  /**
   * Cancel every tool card a stopped turn could still be showing as open work.
   *
   * A queued call is included: it was waiting rather than running, and a cancelled
   * turn never starts it -- leaving it `pending` kept a live card (and its spinner)
   * in a transcript whose turn is over.
   */
  private cancelOpenTools(sessionId: string): void {
    const items = this.transcripts.get(sessionId) ?? [];
    for (const item of items) {
      if (item.kind !== "tool") continue;
      if (!LIVE_TOOL_STATUSES.has(item.status)) continue;
      item.status = "cancelled";
      if (item.subagents) {
        item.subagents = item.subagents.map((agent) =>
          agent.status === "running" || agent.status === "waiting"
            ? { ...agent, status: "failed" }
            : agent,
        );
      }
      this.emitEvent({ type: "tool.updated", tool: { ...item } });
    }
  }

  private cancelPermissionsForSession(sessionId: string): void {
    for (const [toolId, pending] of this.pendingPermissions) {
      if (pending.request.sessionId !== sessionId) continue;
      pending.resolve({ outcome: { outcome: "cancelled" } });
      this.pendingPermissions.delete(toolId);
    }
  }

  private cancelAllPermissions(): void {
    for (const pending of this.pendingPermissions.values()) {
      pending.resolve({ outcome: { outcome: "cancelled" } });
    }
    this.pendingPermissions.clear();
  }

  private setConnection(connection: BackendConnection): void {
    this.connectionState = connection;
    this.emitEvent({
      type: "connection.updated",
      connection: { ...connection },
    });
  }
}
