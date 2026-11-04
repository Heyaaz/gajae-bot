import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { realpathSync, type FSWatcher, type Stats } from "node:fs";
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
  QuestionActivity,
  QuestionSubmission,
  ToolActivity,
  ToolDecision,
  TranscriptItem,
  TranscriptChange,
  ArtifactContent,
  DiffSnapshot,
  EffectiveRuntimeState,
  GeneratedFilePreview,
  WorkspaceFileIndex,
  GitStatusSnapshot,
  GoalOperation,
  GoalSnapshot,
  HistorySession,
  QueuedMessage,
  SessionProgress,
  SubagentSnapshot,
  TranscriptPage,
  TranscriptPageRequest,
} from "../shared/agent-contract.js";
import type { GjcSettingChange } from "../shared/gjc-settings.js";
import {
  DEFAULT_MODEL_PRESET,
} from "../shared/agent-contract.js";
import type { SessionMetadataStore } from "./session-metadata-store.js";
import { ImageDataUrlCache } from "./image-data-cache.js";
import { resolveGjcExecutable, runtimeEnvironment } from "./runtime-path.js";
import {
  GjcSdkCli,
  brokerExec,
  isSessionMissing,
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
  AvailableCommand,
  CLOCK_LABEL,
  ContentBlock,
  GjcControllerOptions,
  HISTORY_SUMMARY_HEAD_BYTES,
  LIVE_MESSAGE_PREFIXES,
  LIVE_THOUGHT_PREFIX,
  LIVE_TOOL_STATUSES,
  OWNED_STOP_UNAVAILABLE_MESSAGE,
  PendingPermission,
  PersistedTurnState,
  PlanEntry,
  RUN_STATE_TAIL_BYTES,
  ResolvedMessageInput,
  STARTUP_TIMEOUT_MS,
  SdkSlashCommandSpec,
  SendMessageOptions,
  SessionConfigOption,
  SessionNotification,
  SessionUpdate,
  TAIL_RETRY_BASE_MS,
  TAIL_RETRY_MAX_MS,
  TERMINAL_STOP_REASONS,
  TodoSnapshotState,
  ToolCallFields,
  ToolCallStatus,
  canonicalWorkspace,
  cloneTranscriptItem,
  comparableRowText,
  configOptionValues,
  configuredProfileDefaultThinking,
  customMessageTitle,
  hasLivePrefix,
  historySessionSummary,
  imageFromContent,
  markUpdated,
  normalizeQueuedRequestText,
  nowLabel,
  persistedTranscriptRunning,
  readableSessionTitle,
  sanitizeLocalAttachmentBlocks,
  sharedContentText,
  textFromContent,
  timestampMs,
  todoSnapshotTask,
} from "./gjc-sdk-foundation.js";

import { previewGeneratedFile } from "./gjc-sdk-file-preview.js";
import {
  resolveWorkspaceFile,
  WorkspaceFileLister,
} from "./workspace-files.js";
import {
  finalizeThought,
  handleSessionUpdate,
  patchSessionInfo,
  patchTool,
  projectTailItems,
  projectThoughtChunk,
  projectToolStream,
  reconcileTailTerminalState,
  requestPermission,
  startTailFollower,
  startToolObserver,
  stopTailFollower,
  type StreamHost,
  upsertTool,
} from "./gjc-sdk-stream.js";
import {
  appendCancelledNotice,
  awaitPromptSettlement,
  cancelRun,
  compactSession,
  consumePromptEcho,
  type ControlHost,
  controlRetry,
  controlSession,
  fireAbort,
  flushQueuedNow,
  listQueuedMessages,
  queueFollowUp,
  querySessionItems,
  type PromptSettlementKind,
  type SdkControlOperation,
  sendMessage,
  steerSession,
} from "./gjc-sdk-control.js";
import {
  appendTranscript,
  finalizeAllMessages,
  finalizeAssistantMessage,
  getTranscript,
  getTranscriptChanges,
  getTranscriptPage,
  getTranscriptRevision,
  installTranscript,
  invalidateDesktopTranscript,
  markTranscriptRowDirty,
  noteTranscriptEpoch,
  persistedCompactionCount,
  publishTranscriptSync,
  readPersistedTranscript,
  readSharedTranscript,
  refreshTranscriptFromFile,
  reindexToolRows,
  rememberLiveRunningTranscriptSize,
  resolveToolImages,
  type TranscriptStoreHost,
  watchSharedTranscript,
  watchTranscripts,
} from "./gjc-sdk-transcript-store.js";
import {
  type AttachHost,
  ensureAttached,
  listHistorySessions,
  markTerminalOnly,
  openHistorySession,
  recoverOwnedSessions,
  refreshTranscriptAttachment,
  resumeSession,
  scheduleDetach,
} from "./gjc-sdk-attach.js";
import {
  createSession,
  deleteSession,
  type DeleteSessionOptions,
  forkSession,
  hideSession,
  type LifecycleHost,
  recoverForkedSession,
  removeLocalSession,
  renameSession,
  sessionHostElsewhere,
} from "./gjc-sdk-lifecycle.js";
import {
  brokerIndexRevision,
  brokerSessions,
  discoverSessions,
  type DiscoveryHost,
  invalidateBrokerIndexCache,
  liveRouteReachable,
  noteBrokerIndex,
  sessionParentId,
} from "./gjc-sdk-discovery.js";
import {
  advanceRunRevision,
  clearRunningLatches,
  currentRunRevision,
  discoveredRunState,
  emitActivity,
  liveEvidenceQuiet,
  reconciledAsyncJobIds,
  recordLiveEvidence,
  recordPendingAsyncWork,
  republishRunState,
  type RunStateHost,
  settleQuietRunningRow,
  syncRunStateWatchers,
  transcriptStartedNewWork,
  updateSessionStatus,
} from "./gjc-sdk-run-state.js";
import {
  type FilesHost,
  getDiff,
  locateSharedTranscriptFile,
  persistArtifact,
  previewFile,
  readArtifact,
  readTranscriptEnvelopes,
  removeSessionArtifacts,
} from "./gjc-sdk-files.js";
import {
  captureSessionState,
  applyLiveSettings,
  cycleThinking,
  patchSessionRuntime,
  refreshRuntimeState,
  refreshContextUsage,
  refreshModelCapabilities,
  refreshSessionConfigOptions,
  refreshSessionSettings,
  type SessionConfigHost,
  sessionConfigRow,
  setSessionConfig,
} from "./gjc-sdk-session-config.js";
import {
  clearProgress,
  clearTodoPoll,
  getGoal,
  type GoalTodoHost,
  listSubagents,
  operateGoal,
  readTodoRecords,
  requestProgressRefresh,
} from "./gjc-sdk-goal-todo.js";
export {
  TODO_EVENT_POLL_BASE_MS,
  TODO_EVENT_POLL_MAX_MS,
  PROGRESS_REFRESH_MIN_MS,
  PROGRESS_STALE_MS,
  PROGRESS_WATCH_MS,
} from "./gjc-sdk-goal-todo.js";
import {
  clearCommandRefreshRetry,
  type CommandPaletteHost,
  publishSessionCommands,
  refreshSdkCommands,
  refreshSessionContext,
  sdkOperations,
} from "./gjc-sdk-command-palette.js";
export {
  COMMAND_REFRESH_RETRY_BASE_MS,
  COMMAND_REFRESH_RETRY_MAX_MS,
  SESSION_CONTEXT_REFRESH_TTL_MS,
} from "./gjc-sdk-command-palette.js";
import {
  answerQuestion,
  hasAnswerableQuestion,
  listPendingQuestions,
  projectWorkflowGate,
  questionById,
  type QuestionHost,
  questionKey,
  refreshWorkflowQuestions,
  settleOpenQuestions,
  submitQuestionAnswer,
} from "./gjc-sdk-questions.js";
import { askSideQuestion, executeSdkSlashCommand, type SlashCommandHost } from "./gjc-sdk-slash-commands.js";
import { deleteSessionThroughCli } from "./gjc-cli-session-delete.js";
import {
  type ConnectionHost,
  getConnection,
  reconfigure,
  reconnect,
  requireCli,
} from "./gjc-sdk-connection.js";
import {
  disposeController,
  type TeardownHost,
} from "./gjc-sdk-teardown.js";
import {
  applyPermissionMode,
  cancelPermissionsForSession,
  PermissionChannels,
  type PermissionApprovalHost,
  resolveToolCall,
  toolDecisionInfo,
} from "./gjc-sdk-permissions.js";
import { gjcHostProcess, stopGjcHostProcess, type GjcHostProcess } from "./gjc-host-process.js";
import {
  commitChanges,
  getGitStatus,
  pushChanges,
  stageFiles,
  unstageFiles,
  type GitScope,
} from "./gjc-sdk-git.js";
import {
  projectTranscriptItemForDelivery,
} from "./transcript-body-preview.js";

export * from "./gjc-sdk-foundation.js";

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
  private readonly workspaceFiles = new WorkspaceFileLister();
  private readonly attachedSessions = new Set<string>();
  /**
   * Sessions the renderer is showing or keeping in its transcript cache.
   *
   * `undefined` means no window has reported a cache yet; an old renderer or a
   * remote-only host must not have every attached session released because nobody
   * told this process what is visible.
   */
  private watchedTranscripts: Set<string> | undefined;
  private readonly detachTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly transcripts = new Map<string, TranscriptItem[]>();
  /** Tool id → row index, rebuilt whenever the transcript array is replaced. */
  private readonly toolRowIndices = new Map<string, Map<string, number>>();
  /** Rows mutated live that a later durable rescan must compare even when old. */
  private readonly dirtyTranscriptRows = new Map<string, Set<string>>();
  private readonly desktopTranscriptBaselines = new Map<string, TranscriptItem[]>();
  private readonly messageKeys = new Map<string, Map<string, string>>();
  private readonly activeAssistantMessages = new Map<string, string>();
  private readonly activeThoughts = new Map<string, string>();
  private readonly activePromptSessions = new Set<string>();
  private readonly activePromptAdmissions = new Map<string, symbol>();
  private readonly cancellationWatermarks = new Map<string, number>();
  private readonly cancellingSessions = new Set<string>();
  private readonly cancellationPromises = new Map<string, Promise<void>>();
  private readonly flushingSessions = new Set<string>();
  private readonly pendingSteers = new Map<string, Promise<MessageDelivery>>();
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
   * Sessions whose running -> idle completion was withheld because the background
   * job list could not be read. One later idle verdict announces that finish once.
   */
  private readonly completionDeferredSessions = new Set<string>();
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
    {
      checkedAt: number;
      deadJobIds: Set<string>;
      checkedJobIds: Set<string>;
      querySucceeded: boolean;
    }
  >();
  /** Monotonic per-session lifecycle generation for async status reads and IPC merges. */
  private readonly runRevisions = new Map<string, number>();
  /**
   * Bumps when this process changes a transcript the file has not recorded yet:
   * a streamed row, a plan, a todo snapshot. The file stat cannot see those, so
   * the safety-net revision includes this counter.
   */
  private readonly transcriptEpoch = new Map<string, number>();
  /**
   * Transcript-derived run state per session, keyed by the file size it was read at.
   *
   * `runningJobIds` records the launch markers the verdict at that size rests on,
   * so a size-unchanged read can still notice that the job behind them ended.
   */
  /** The transcript size an idle row settled at, per run revision. */
  private readonly idleTranscriptBaselines = new Map<
    string,
    { revision: number; size: number }
  >();
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
  /** In-flight command palette rebuild per session, shared by concurrent callers. */
  private readonly commandRefreshes = new Map<string, Promise<void>>();
  private readonly sessionContextRefreshes = new Map<string, Promise<void>>();
  private readonly sessionContextRefreshedAt = new Map<string, number>();
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
  /** Ask questions projected from `workflow.gates.list` and `workflow_gate`. */
  private readonly sessionQuestions = new Map<string, Map<string, QuestionActivity>>();
  /** Gates this window already accepted, so a stale pending row cannot reopen them. */
  private readonly acceptedQuestions = new Set<string>();
  /**
   * A gate event that has not yet been confirmed by the list.
   *
   * The list is the source of truth, but the event can arrive one read ahead of
   * it. The first empty read keeps the card; the next one settles it.
   */
  private readonly observedQuestions = new Set<string>();
  private readonly questionRefreshes = new Map<string, Promise<void>>();
  private readonly questionAnswers = new Map<string, Promise<void>>();
  /** The runtime's todo store as this window last observed it, per session. */
  private readonly sessionTodoSnapshots = new Map<string, TodoSnapshotState>();
  /** Last `session.progress` read; a failed read keeps the previous snapshot. */
  private readonly sessionProgress = new Map<
    string,
    { progress: SessionProgress | undefined; readAt: number }
  >();
  private readonly progressReads = new Map<string, Promise<void>>();
  /** When a goal row last asked for each session's progress. */
  private readonly progressWatchedAt = new Map<string, number>();
  private readonly progressTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
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
  private readonly permissionChannels = new PermissionChannels({
    relayTransport: (sessionId) => {
      if (!this.cli) throw new Error("GJC is not connected");
      return { executable: this.cli.executable, env: this.cli.env, cwd: this.repoFor(sessionId) };
    },
    sessionActive: (sessionId) => {
      const status = this.sessions.get(sessionId)?.status;
      return status === "starting" || status === "running" || status === "waiting";
    },
    requestPermission: (request) => requestPermission(this.host, request),
    dropPermission: (toolId) => {
      const pending = this.pendingPermissions.get(toolId);
      if (!pending) return;
      this.pendingPermissions.delete(toolId);
      pending.resolve({ outcome: { outcome: "cancelled" } });
      patchTool(this.host, toolId, { status: "pending", permissionOptions: undefined });
    },
  });
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
  private readonly sharedTranscriptReads = new Map<
    string,
    {
      device: number;
      inode: number;
      size: number;
      /** Stat identity, including ctime, that the parsed envelopes belong to. */
      revision: string;
      envelopes: Record<string, unknown>[];
      partial: string;
      /** Bytes this read took from disk. Zero when the cached parse was reused. */
      bytesRead: number;
    }
  >();
  private readonly sharedSessionWatchers = new Map<string, FSWatcher>();
  private readonly sharedSessionRefreshTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly imageDataUrls = new ImageDataUrlCache();
  private readonly attachAttempts = new Map<string, number>();
  private readonly contextUsageQueries = new Map<string, Promise<void>>();
  /** Last usage observation (query or live event) used to pace watcher repairs. */
  private readonly contextUsageObservedAt = new Map<string, number>();

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
  private recovery?: Promise<void>;
  /** Sessions whose permission mode has been applied for this runtime generation. */
  private readonly permissionModeApplied = new Set<string>();
  /** Live tail catch-up reads in flight, keyed by session. */
  private readonly tailReads = new Map<string, Promise<void>>();
  /** Abort handles for the short-lived tail CLI child currently reading a session. */
  private readonly tailControllers = new Map<string, AbortController>();
  /** Latest tail checkpoint claim per session, so a re-read resumes rather than rewinds. */
  /**
   * Where each session's tail resumes. gjc/0.18.12 refuses a live `--cursor`
   * without the transcript row it stopped at (`usage`), so the two travel together.
   */
  private readonly tailCheckpoints = new Map<
    string,
    { cursor: string; afterTranscriptId: string }
  >();
  /** Last sequence observed from a tail, used to distinguish catch-up from new work. */
  private readonly tailEventPositions = new Map<
    string,
    { generation: number; seq: number }
  >();
  /** Sessions this window resumed, and therefore may close before deleting. */
  private readonly windowHostedSessions = new Set<string>();
  /** Public observer connections that replace tool output with the newest snapshot. */
  private readonly toolObservers = new Map<string, AbortController>();
  /** The latest streamed tool rows, kept over a stale durable read. */
  private readonly toolSnapshots = new Map<string, Map<string, ToolActivity>>();

  private readonly host: QuestionHost & CommandPaletteHost & GoalTodoHost & SessionConfigHost & FilesHost & RunStateHost & DiscoveryHost & LifecycleHost & AttachHost & TranscriptStoreHost & ControlHost & StreamHost & PermissionApprovalHost & TeardownHost & ConnectionHost & SlashCommandHost = ((controller: GjcSdkController) => ({
    get sessionQuestions() { return controller.sessionQuestions; },
    get questionRefreshes() { return controller.questionRefreshes; },
    get disposed() { return controller.disposed; },
    deleteSession: (sessionId) => controller.deleteSession(sessionId),
    renameSession: (sessionId, title) => controller.renameSession(sessionId, title),
    compactSession: (sessionId) => controller.compactSession(sessionId),
    sessionConfigRow: (sessionId) => sessionConfigRow(controller.host, sessionId),
    hasAnswerableQuestion: (sessionId) => hasAnswerableQuestion(controller.host, sessionId),
    get configuredExecutable() { return controller.configuredExecutable; },
    set configuredExecutable(value) { controller.configuredExecutable = value; },
    get connectionState() { return controller.connectionState; },
    set connectionState(value) { controller.connectionState = value; },
    resolveExecutable: () => controller.resolveExecutable(),
    recoverOwnedSessions: () => controller.recoverOwnedSessions(),
    noteBrokerIndex: (rows, before, after) => noteBrokerIndex(controller.host, rows, before, after),
    get permissionHandling() { return controller.permissionHandling; },
    set permissionHandling(value) { controller.permissionHandling = value; },
    get permissionModeApplied() { return controller.permissionModeApplied; },
    get permissionChannels() { return controller.permissionChannels; },
    patchTool: (toolId, patch) => patchTool(controller.host, toolId, patch),
    querySessionItems: (...args: Parameters<ControlHost["querySessionItems"]>) => querySessionItems(controller.host, ...args),
    get observedQuestions() { return controller.observedQuestions; },
    get acceptedQuestions() { return controller.acceptedQuestions; },
    get transcripts() { return controller.transcripts; },
    get locallyAbortedSessions() { return controller.locallyAbortedSessions; },
    noteTranscriptEpoch: (sessionId) => noteTranscriptEpoch(controller.host, sessionId),
    get emitEvent() { return controller.emitEvent; },
    markTranscriptRowDirty: (sessionId, rowId) => controller.markTranscriptRowDirty(sessionId, rowId),
    emitActivity: (sessionId, category) => controller.emitActivity(sessionId, category),
    get sessions() { return controller.sessions; },
    get cancellingSessions() { return controller.cancellingSessions; },
    updateSessionStatus: (sessionId, status, options) => controller.updateSessionStatus(sessionId, status, options),
    controlSession: (...args: Parameters<ControlHost["controlSession"]>) => controller.controlSession(...args),
    get commandRefreshes() { return controller.commandRefreshes; },
    get sessionAdvertisedCommands() { return controller.sessionAdvertisedCommands; },
    get sessionDiscoveredCommands() { return controller.sessionDiscoveredCommands; },
    get sessionCommands() { return controller.sessionCommands; },
    get commandRefreshTimers() { return controller.commandRefreshTimers; },
    get commandRefreshAttempts() { return controller.commandRefreshAttempts; },
    get sessionSdkOperations() { return controller.sessionSdkOperations; },
    get publishedCommandKeys() { return controller.publishedCommandKeys; },
    get progressWatchedAt() { return controller.progressWatchedAt; },
    get sessionProgress() { return controller.sessionProgress; },
    get progressTimers() { return controller.progressTimers; },
    get progressReads() { return controller.progressReads; },
    get sessionTodoSnapshots() { return controller.sessionTodoSnapshots; },
    get attachedSessions() { return controller.attachedSessions; },
    get todoPollTimers() { return controller.todoPollTimers; },
    get todoPollAttempts() { return controller.todoPollAttempts; },
    get todoReads() { return controller.todoReads; },
    get modelProfiles() { return controller.modelProfiles; },
    get modelPreset() { return controller.modelPreset; },
    set modelPreset(value) { controller.modelPreset = value; },
    get modelPresetThinking() { return controller.modelPresetThinking; },
    set modelPresetThinking(value) { controller.modelPresetThinking = value; },
    get explicitSessionThinking() { return controller.explicitSessionThinking; },
    get sessionConfig() { return controller.sessionConfig; },
    requireCli: () => requireCli(controller.host),
    repoFor: (sessionId) => controller.repoFor(sessionId),
    get contextUsageObservedAt() { return controller.contextUsageObservedAt; },
    get contextUsageQueries() { return controller.contextUsageQueries; },
    advanceRunRevision: (sessionId) => controller.advanceRunRevision(sessionId),
    ensureAttached: (sessionId, replay) => controller.ensureAttached(sessionId, replay),
    getTranscript: (sessionId) => controller.getTranscript(sessionId),
    get artifactDirectory() { return controller.artifactDirectory; },
    get deletingSessions() { return controller.deletingSessions; },
    get artifactSessionIds() { return controller.artifactSessionIds; },
    get artifactWrites() { return controller.artifactWrites; },
    get nextLocalId() { return controller.nextLocalId; },
    set nextLocalId(value) { controller.nextLocalId = value; },
    get sessionCwds() { return controller.sessionCwds; },
    get workspace() { return controller.workspace; },
    set workspace(value) { controller.workspace = value; },
    get sharedSessionFiles() { return controller.sharedSessionFiles; },
    get sharedTranscriptReads() { return controller.sharedTranscriptReads; },
    locateSharedTranscriptFile: (sessionId) => controller.locateSharedTranscriptFile(sessionId),
    get discoveredRunStates() { return controller.discoveredRunStates; },
    get pendingAsyncWorkSessions() { return controller.pendingAsyncWorkSessions; },
    get asyncJobReconciliations() { return controller.asyncJobReconciliations; },
    get liveRunningSessions() { return controller.liveRunningSessions; },
    get transcriptRunningSessions() { return controller.transcriptRunningSessions; },
    currentRunRevision: (sessionId) => controller.currentRunRevision(sessionId),
    get idleTranscriptBaselines() { return controller.idleTranscriptBaselines; },
    get workingPhaseSessions() { return controller.workingPhaseSessions; },
    get runtimeIdleSessions() { return controller.runtimeIdleSessions; },
    get liveEvidenceAt() { return controller.liveEvidenceAt; },
    get liveRunningDigests() { return controller.liveRunningDigests; },
    get compactingSessions() { return controller.compactingSessions; },
    get compactionRecordBaseline() { return controller.compactionRecordBaseline; },
    get compactionStartedAt() { return controller.compactionStartedAt; },
    get activePromptSessions() { return controller.activePromptSessions; },
    get runStateWatchers() { return controller.runStateWatchers; },
    get runStateTimers() { return controller.runStateTimers; },
    get sharedSessionWatchers() { return controller.sharedSessionWatchers; },
    get generation() { return controller.generation; },
    set generation(value) { controller.generation = value; },
    get lastDiscovered() { return controller.lastDiscovered; },
    set lastDiscovered(value) { controller.lastDiscovered = value; },
    brokerSessions: (options) => controller.brokerSessions(options),
    get sessionMetadata() { return controller.sessionMetadata; },
    liveRouteReachable: (row) => controller.liveRouteReachable(row),
    get terminalOnlySessions() { return controller.terminalOnlySessions; },
    get lastLiveFingerprint() { return controller.lastLiveFingerprint; },
    set lastLiveFingerprint(value) { controller.lastLiveFingerprint = value; },
    syncRunStateWatchers: (sessionIds) => syncRunStateWatchers(controller.host, sessionIds),
    discoveredRunState: (sessionId) => controller.discoveredRunState(sessionId),
    liveEvidenceQuiet: (sessionId) => liveEvidenceQuiet(controller.host, sessionId),
    settleQuietRunningRow: (sessionId, transcriptStatus, currentSession) => settleQuietRunningRow(controller.host, sessionId, transcriptStatus, currentSession),
    sessionParentId: (sessionId) => controller.sessionParentId(sessionId),
    get routeProbes() { return controller.routeProbes; },
    get startupSessionRows() { return controller.startupSessionRows; },
    set startupSessionRows(value) { controller.startupSessionRows = value; },
    get cachedBrokerRows() { return controller.cachedBrokerRows; },
    set cachedBrokerRows(value) { controller.cachedBrokerRows = value; },
    get cachedBrokerRevision() { return controller.cachedBrokerRevision; },
    set cachedBrokerRevision(value) { controller.cachedBrokerRevision = value; },
    get sessionParents() { return controller.sessionParents; },
    get toolRowIndices() { return controller.toolRowIndices; },
    get messageKeys() { return controller.messageKeys; },
    invalidateBrokerIndexCache: () => invalidateBrokerIndexCache(controller.host),
    get windowHostedSessions() { return controller.windowHostedSessions; },
    applyPermissionMode: (sessionId) => applyPermissionMode(controller.host, sessionId),
    startTailFollower: (sessionId) => controller.startTailFollower(sessionId),
    refreshSdkCommands: (...args: Parameters<LifecycleHost["refreshSdkCommands"]>) => controller.refreshSdkCommands(...args),
    refreshSessionConfigOptions: (sessionId) => controller.refreshSessionConfigOptions(sessionId),
    refreshContextUsage: (sessionId, options) => controller.refreshContextUsage(sessionId, options),
    watchSharedTranscript: (sessionId, filePath) => controller.watchSharedTranscript(sessionId, filePath),
    get forkRecoveryIntervalMs() { return controller.forkRecoveryIntervalMs; },
    get deletionPromises() { return controller.deletionPromises; },
    stopTailFollower: (sessionId) => controller.stopTailFollower(sessionId),
    removeSessionArtifacts: (sessionId) => controller.removeSessionArtifacts(sessionId),
    deleteThroughGjcCli: (cwd, sessionPath) => controller.deleteThroughGjcCli(cwd, sessionPath),
    gjcHostProcess: (pid) => controller.gjcHostProcess(pid),
    stopGjcHostProcess: (pid) => controller.stopGjcHostProcess(pid),
    removeLocalSession: (sessionId, hide) => controller.removeLocalSession(sessionId, hide),
    get transcriptAttachments() { return controller.transcriptAttachments; },
    get dirtyTranscriptRows() { return controller.dirtyTranscriptRows; },
    get desktopTranscriptBaselines() { return controller.desktopTranscriptBaselines; },
    get activeAssistantMessages() { return controller.activeAssistantMessages; },
    get activeThoughts() { return controller.activeThoughts; },
    get activePromptAdmissions() { return controller.activePromptAdmissions; },
    get cancellationWatermarks() { return controller.cancellationWatermarks; },
    get completionDeferredSessions() { return controller.completionDeferredSessions; },
    get runRevisions() { return controller.runRevisions; },
    get compactionRecordWatermark() { return controller.compactionRecordWatermark; },
    get suppressedUserMessageKeys() { return controller.suppressedUserMessageKeys; },
    get echoedPromptTexts() { return controller.echoedPromptTexts; },
    get sessionContextRefreshes() { return controller.sessionContextRefreshes; },
    get sessionContextRefreshedAt() { return controller.sessionContextRefreshedAt; },
    clearCommandRefreshRetry: (sessionId) => clearCommandRefreshRetry(controller.host, sessionId),
    clearTodoPoll: (sessionId) => clearTodoPoll(controller.host, sessionId),
    clearProgress: (sessionId) => clearProgress(controller.host, sessionId),
    get sessionPlans() { return controller.sessionPlans; },
    get sharedSessionRefreshTimers() { return controller.sharedSessionRefreshTimers; },
    cancelPermissionsForSession: (sessionId) => cancelPermissionsForSession(controller.host, sessionId),
    sdkOperations: (sessionId, options?: { strict?: boolean }) => controller.sdkOperations(sessionId, options),
    get historySummaryCache() { return controller.historySummaryCache; },
    resumeSession: (sessionId) => controller.resumeSession(sessionId),
    readPersistedTranscript: (sessionId) => controller.readPersistedTranscript(sessionId),
    markTerminalOnly: (sessionId) => markTerminalOnly(controller.host, sessionId),
    installTranscript: (sessionId, items) => controller.installTranscript(sessionId, items),
    invalidateDesktopTranscript: (sessionId) => invalidateDesktopTranscript(controller.host, sessionId),
    get attachAttempts() { return controller.attachAttempts; },
    refreshSessionSettings: (sessionId) => controller.refreshSessionSettings(sessionId),
    readSharedTranscript: (sessionId) => controller.readSharedTranscript(sessionId),
    finalizeAllMessages: (sessionId) => finalizeAllMessages(controller.host, sessionId),
    get watchedTranscripts() { return controller.watchedTranscripts; },
    get detachTimers() { return controller.detachTimers; },
    get cli() { return controller.cli; },
    set cli(value) { controller.cli = value; },
    get startup() { return controller.startup; },
    set startup(value) { controller.startup = value; },
    get questionAnswers() { return controller.questionAnswers; },
    get recovery() { return controller.recovery; },
    set recovery(value) { controller.recovery = value; },
    refreshTranscriptAttachment: (sessionId) => controller.refreshTranscriptAttachment(sessionId),
    get transcriptEpoch() { return controller.transcriptEpoch; },
    readTranscriptEnvelopes: (filePath, info) => controller.readTranscriptEnvelopes(filePath, info),
    reconciledAsyncJobIds: (sessionId, jobIds) => reconciledAsyncJobIds(controller.host, sessionId, jobIds),
    patchSessionRuntime: (sessionId, patch) => patchSessionRuntime(controller.host, sessionId, patch),
    recordPendingAsyncWork: (sessionId, jobIds) => recordPendingAsyncWork(controller.host, sessionId, jobIds),
    transcriptStartedNewWork: (sessionId, size, transcriptRunning) => transcriptStartedNewWork(controller.host, sessionId, size, transcriptRunning),
    publishTranscriptSync: (sessionId, previous, items) => controller.publishTranscriptSync(sessionId, previous, items),
    republishRunState: (sessionId) => controller.republishRunState(sessionId),
    get toolSnapshots() { return controller.toolSnapshots; },
    get imageDataUrls() { return controller.imageDataUrls; },
    set watchedTranscripts(value) { controller.watchedTranscripts = value; },
    scheduleDetach: (sessionId) => scheduleDetach(controller.host, sessionId),
    persistedCompactionCount: (sessionId) => persistedCompactionCount(controller.host, sessionId),
    appendLocalUserMessage: (sessionId, text, input) => controller.appendLocalUserMessage(sessionId, text, input),
    get pendingSteers() { return controller.pendingSteers; },
    get flushingSessions() { return controller.flushingSessions; },
    executeSdkSlashCommand: (sessionId, input, options) => controller.executeSdkSlashCommand(sessionId, input, options),
    finalizeThought: (sessionId) => finalizeThought(controller.host, sessionId),
    awaitPromptSettlement: (sessionId, operationRef, isCurrent, kind) => controller.awaitPromptSettlement(sessionId, operationRef, isCurrent, kind),
    finalizeAssistantMessage: (sessionId) => finalizeAssistantMessage(controller.host, sessionId),
    appendTranscript: (item) => controller.appendTranscript(item),
    get cancellationPromises() { return controller.cancellationPromises; },
    fireAbort: (sessionId) => controller.fireAbort(sessionId),
    settleOpenQuestions: (sessionId, status) => settleOpenQuestions(controller.host, sessionId, status),
    get tailReads() { return controller.tailReads; },
    get tailControllers() { return controller.tailControllers; },
    get toolObservers() { return controller.toolObservers; },
    get tailCheckpoints() { return controller.tailCheckpoints; },
    get tailEventPositions() { return controller.tailEventPositions; },
    refreshWorkflowQuestions: (sessionId) => refreshWorkflowQuestions(controller.host, sessionId),
    projectToolStream: (sessionId, kind, payload) => controller.projectToolStream(sessionId, kind, payload),
    projectMessageChunk: (sessionId, role, update) => controller.projectMessageChunk(sessionId, role, update),
    refreshTranscriptFromFile: (sessionId) => controller.refreshTranscriptFromFile(sessionId),
    projectWorkflowGate: (sessionId, payload) => projectWorkflowGate(controller.host, sessionId, payload),
    requestProgressRefresh: (sessionId) => requestProgressRefresh(controller.host, sessionId),
    upsertTool: (sessionId, update) => controller.upsertTool(sessionId, update),
    handleSessionUpdate: (notification) => controller.handleSessionUpdate(notification),
    captureSessionState: (sessionId, options, mode) => captureSessionState(controller.host, sessionId, options, mode),
    refreshModelCapabilities: (sessionId) => refreshModelCapabilities(controller.host, sessionId),
    persistArtifact: (sessionId, artifactId, value) => controller.persistArtifact(sessionId, artifactId, value),
    readTodoRecords: (sessionId) => controller.readTodoRecords(sessionId),
    resolveToolImages: (items) => resolveToolImages(controller.host, items),
    get pendingPermissions() { return controller.pendingPermissions; },
    recordLiveEvidence: (sessionId) => recordLiveEvidence(controller.host, sessionId),
    rememberLiveRunningTranscriptSize: (sessionId) => rememberLiveRunningTranscriptSize(controller.host, sessionId),
    clearRunningLatches: (sessionId) => clearRunningLatches(controller.host, sessionId),
  }))(this);

  constructor(options: GjcControllerOptions) {
    this.workspace = canonicalWorkspace(options.workspace);
    this.configuredExecutable = options.executable;
    this.modelPreset = options.modelPreset ?? DEFAULT_MODEL_PRESET;
    this.permissionHandling = options.permissionHandling ?? "prompt";
    this.sessionMetadata = options.sessionMetadata;
    this.emitEvent = (event) => {
      switch (event.type) {
        case "transcript.appended":
          options.emit({
            ...event,
            item: projectTranscriptItemForDelivery(event.item),
          });
          break;
        case "tool.updated":
          options.emit({
            ...event,
            tool: projectTranscriptItemForDelivery(event.tool) as ToolActivity,
          });
          break;
        case "transcript.synced":
          options.emit({
            ...event,
            items: event.items.map(projectTranscriptItemForDelivery),
          });
          break;
        case "session.updated":
          options.emit(event);
          this.permissionChannels.sync(event.session.id);
          break;
        default:
          options.emit(event);
      }
    };
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

  getConnection(): Promise<BackendConnection> {
    return getConnection(this.host);
  }

  reconfigure(preferences: AgentControlPreferences): Promise<boolean> {
    return reconfigure(this.host, preferences);
  }

  /** The title the session list shows, cut to one readable line. */
  sessionTitle(sessionId: string): string | undefined {
    const title = this.sessions.get(sessionId)?.title.replace(/\s+/gu, " ").trim();
    if (!title) return undefined;
    return title.length > 72 ? `${title.slice(0, 71).trimEnd()}\u2026` : title;
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

  private discoverSessions(): Promise<AgentSession[]> {
    return discoverSessions(this.host);
  }

  private readonly routeProbes = new Map<string, { at: number; reachable: boolean }>();

  private liveRouteReachable(row: SdkSessionRow): Promise<boolean> {
    return liveRouteReachable(this.host, row);
  }

  private readonly runStateWatchers = new Map<string, FSWatcher>();
  private readonly runStateTimers = new Map<string, NodeJS.Timeout>();

  private republishRunState(sessionId: string): Promise<void> {
    return republishRunState(this.host, sessionId);
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
  /** History picker summaries, reused while the session file's stat is unchanged. */
  private readonly historySummaryCache = new Map<
    string,
    {
      mtimeMs: number;
      size: number;
      summary: NonNullable<ReturnType<typeof historySessionSummary>>;
      parentId?: string;
    }
  >();

  private sessionParentId(
    sessionId: string,
  ): Promise<string | undefined> {
    return sessionParentId(this.host, sessionId);
  }

  private discoveredRunState(
    sessionId: string,
  ): Promise<AgentSession["status"] | undefined> {
    return discoveredRunState(this.host, sessionId);
  }

  private brokerSessions(options?: {
    scope?: "repo" | "cwd" | "worktree" | "all";
    initialDiscovery?: boolean;
    reuseUnchangedIndex?: boolean;
  }): Promise<SdkSessionRow[] | undefined> {
    return brokerSessions(this.host, options);
  }

  private brokerIndexRevision(): Promise<string | undefined> {
    return brokerIndexRevision();
  }

  createSession(input: CreateSessionInput): Promise<AgentSession> {
    return createSession(this.host, input);
  }

  renameSession(sessionId: string, title: string): Promise<void> {
    return renameSession(this.host, sessionId, title);
  }

  private readonly transcriptAttachments = new Map<string, Promise<void>>();

  private refreshTranscriptAttachment(sessionId: string): void {
    return refreshTranscriptAttachment(this.host, sessionId);
  }

  refreshSessionContext(sessionId: string): Promise<void> {
    return refreshSessionContext(this.host, sessionId);
  }

  watchTranscripts(sessionIds: readonly string[]): void {
    return watchTranscripts(this.host, sessionIds);
  }

  getTranscript(sessionId: string): Promise<TranscriptItem[]> {
    return getTranscript(this.host, sessionId);
  }

  getTranscriptPage(
    sessionId: string,
    request?: TranscriptPageRequest,
  ): Promise<TranscriptPage> {
    return getTranscriptPage(this.host, sessionId, request);
  }

  getTranscriptChanges(sessionId: string): Promise<TranscriptChange> {
    return getTranscriptChanges(this.host, sessionId);
  }

  private reindexToolRows(
    sessionId: string,
    items: readonly TranscriptItem[],
  ): void {
    return reindexToolRows(this.host, sessionId, items);
  }

  private markTranscriptRowDirty(sessionId: string, rowId: string): void {
    return markTranscriptRowDirty(this.host, sessionId, rowId);
  }

  getTranscriptRevision(sessionId: string): Promise<string | undefined> {
    return getTranscriptRevision(this.host, sessionId);
  }

  private readSharedTranscript(
    sessionId: string,
  ): Promise<TranscriptItem[]> {
    return readSharedTranscript(this.host, sessionId);
  }

  private readTranscriptEnvelopes(
    filePath: string,
    info: Stats,
  ): Promise<Record<string, unknown>[]> {
    return readTranscriptEnvelopes(this.host, filePath, info);
  }

  private readPersistedTranscript(
    sessionId: string,
  ): Promise<TranscriptItem[] | undefined> {
    return readPersistedTranscript(this.host, sessionId);
  }

  private watchSharedTranscript(sessionId: string, filePath: string): void {
    return watchSharedTranscript(this.host, sessionId, filePath);
  }

  private publishTranscriptSync(
    sessionId: string,
    previous: TranscriptItem[] | undefined,
    items: TranscriptItem[],
  ): void {
    return publishTranscriptSync(this.host, sessionId, previous, items);
  }

  setSessionConfig(
    sessionId: string,
    configId: string,
    value: string,
  ): Promise<void> {
    return setSessionConfig(this.host, sessionId, configId, value);
  }

  cycleThinking(sessionId: string): Promise<string | undefined> {
    return cycleThinking(this.host, sessionId);
  }

  applyLiveSettings(changes: readonly GjcSettingChange[]): Promise<void> {
    return applyLiveSettings(this.host, changes);
  }

  controlRetry(sessionId: string, action: "now" | "abort"): Promise<void> {
    return controlRetry(this.host, sessionId, action);
  }

  askSideQuestion(sessionId: string, question: string): Promise<string> {
    return askSideQuestion(this.host, sessionId, question);
  }

  compactSession(sessionId: string): Promise<void> {
    return compactSession(this.host, sessionId);
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

  // Waiting work is hidden from the transcript only while it is still waiting.
  // The count is what makes this correct: two identical queued requests must
  // survive one being consumed, and the last release must un-hide the bubble so a
  // consumed steer reads like any other user message.

  // The authoritative queue is the only thing that says what is still waiting.
  // Anything the app once hid but GJC no longer lists has been consumed, so its
  // suppression is dropped and the message becomes a visible user bubble.



  steerSession(
    sessionId: string,
    input: ResolvedMessageInput,
    options?: { echo?: boolean },
  ): Promise<MessageDelivery> {
    return steerSession(this.host, sessionId, input, options);
  }

  queueFollowUp(
    sessionId: string,
    input: ResolvedMessageInput,
  ): Promise<MessageDelivery> {
    return queueFollowUp(this.host, sessionId, input);
  }

  private controlSession(
    sessionId: string,
    operation: SdkControlOperation,
    input: Record<string, unknown>,
    options?: { confirm?: boolean; idempotencyKey?: string; timeoutMs?: number },
  ): Promise<Record<string, unknown> | undefined> {
    return controlSession(this.host, sessionId, operation, input, options);
  }

  listQueuedMessages(sessionId: string): Promise<QueuedMessage[]> {
    return listQueuedMessages(this.host, sessionId);
  }

  flushQueuedNow(sessionId: string): Promise<boolean> {
    return flushQueuedNow(this.host, sessionId);
  }

  private executeSdkSlashCommand(
    sessionId: string,
    input: ResolvedMessageInput,
    options?: SendMessageOptions,
  ): Promise<boolean> {
    return executeSdkSlashCommand(this.host, sessionId, input, options);
  }

  sendMessage(
    sessionId: string,
    input: ResolvedMessageInput,
    options?: SendMessageOptions,
  ): Promise<MessageDelivery> {
    return sendMessage(this.host, sessionId, input, options);
  }

  private awaitPromptSettlement(
    sessionId: string,
    operationRef: string,
    isCurrent?: () => boolean,
    kind?: PromptSettlementKind,
  ): Promise<
    | "terminal"
    | "unknown"
    | { kind: "not_executed"; detail: string }
  > {
    return awaitPromptSettlement(this.host, sessionId, operationRef, isCurrent, kind);
  }

  cancelRun(sessionId: string): Promise<void> {
    return cancelRun(this.host, sessionId);
  }

  private fireAbort(
    sessionId: string,
  ): Promise<"owned" | "plain" | "no_active_turn"> {
    return fireAbort(this.host, sessionId);
  }

  private appendCancelledNotice(
    sessionId: string,
    ownedWorkUnconfirmed = false,
  ): void {
    return appendCancelledNotice(this.host, sessionId, ownedWorkUnconfirmed);
  }

  toolDecisionInfo(
    toolId: string,
    decision: ToolDecision,
  ): { name: string; requiresConfirmation: boolean } {
    return toolDecisionInfo(this.host, toolId, decision);
  }

  resolveToolCall(toolId: string, decision: ToolDecision): Promise<void> {
    return resolveToolCall(this.host, toolId, decision);
  }

  listPendingQuestions(sessionId: string): Promise<QuestionActivity[]> {
    return listPendingQuestions(this.host, sessionId);
  }

  answerQuestion(
    sessionId: string,
    gateId: string,
    submission: QuestionSubmission,
    idempotencyKey: string,
  ): Promise<void> {
    return answerQuestion(this.host, sessionId, gateId, submission, idempotencyKey);
  }

  async markSessionRead(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.unread = false;
      this.sessionMetadata?.setUnread(sessionId, false);
      this.emitEvent({ type: "session.updated", session: { ...session } });
    }
  }

  readArtifact(
    sessionId: string,
    artifactId: string,
  ): Promise<ArtifactContent> {
    return readArtifact(this.host, sessionId, artifactId);
  }

  listWorkspaceFiles(sessionId: string): Promise<WorkspaceFileIndex> {
    return this.workspaceFiles.list(this.repoFor(sessionId));
  }

  /** The real path of a file an `@` mention names in the session workspace. */
  resolveWorkspaceFile(sessionId: string, relativePath: string): Promise<string> {
    return resolveWorkspaceFile(this.repoFor(sessionId), relativePath);
  }

  previewFile(
    sessionId: string,
    requestedPath: string,
  ): Promise<GeneratedFilePreview> {
    return previewFile(this.host, sessionId, requestedPath);
  }

  private refreshSdkCommands(
    sessionId: string,
    advertised?: AgentCommand[],
  ): Promise<void> {
    return refreshSdkCommands(this.host, sessionId, advertised);
  }

  private sdkOperations(
    sessionId: string,
    options?: { strict?: boolean },
  ): Promise<Set<string>> {
    return sdkOperations(this.host, sessionId, options);
  }

  getGoal(sessionId: string): Promise<GoalSnapshot> {
    return getGoal(this.host, sessionId);
  }

  operateGoal(
    sessionId: string,
    operation: GoalOperation,
  ): Promise<GoalSnapshot> {
    return operateGoal(this.host, sessionId, operation);
  }

  listSubagents(sessionId: string): Promise<SubagentSnapshot[]> {
    return listSubagents(this.host, sessionId);
  }

  getDiff(sessionId: string): Promise<DiffSnapshot> {
    return getDiff(this.host, sessionId);
  }

  refreshRuntimeState(sessionId: string): Promise<EffectiveRuntimeState> {
    return refreshRuntimeState(this.host, sessionId);
  }

  reconnect(): Promise<BackendConnection> {
    return reconnect(this.host);
  }

  hideSession(sessionId: string): void {
    return hideSession(this.host, sessionId);
  }

  deleteSession(sessionId: string, options?: DeleteSessionOptions): Promise<void> {
    return deleteSession(this.host, sessionId, options);
  }

  /** Another GJC holding the session open, which deleting it would have to stop. */
  sessionHostElsewhere(
    sessionId: string,
    options?: { reuseUnchangedIndex?: boolean },
  ): Promise<GjcHostProcess | undefined> {
    return sessionHostElsewhere(this.host, sessionId, options);
  }

  private removeSessionArtifacts(sessionId: string): Promise<void> {
    return removeSessionArtifacts(this.host, sessionId);
  }

  private gjcHostProcess(pid: number): Promise<GjcHostProcess | undefined> {
    return gjcHostProcess(pid);
  }

  private stopGjcHostProcess(pid: number): Promise<boolean> {
    return stopGjcHostProcess(pid);
  }

  private async deleteThroughGjcCli(cwd: string, sessionPath: string): Promise<void> {
    const cli = await requireCli(this.host);
    await deleteSessionThroughCli({ executable: cli.executable, env: cli.env, cwd, sessionPath });
  }

  private locateSharedTranscriptFile(
    sessionId: string,
  ): Promise<string | undefined> {
    return locateSharedTranscriptFile(this.host, sessionId);
  }

  private removeLocalSession(sessionId: string, hide: boolean): void {
    return removeLocalSession(this.host, sessionId, hide);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    disposeController(this.host);
  }

  /** The workspace a session's CLI calls must resolve against. */
  private repoFor(sessionId: string): string {
    return this.sessionCwds.get(sessionId) ?? this.workspace;
  }

  private recoverOwnedSessions(): Promise<void> {
    return recoverOwnedSessions(this.host);
  }

  private async resolveExecutable(): Promise<string> {
    return (await resolveGjcExecutable(this.configuredExecutable)) ?? "gjc";
  }

  listHistorySessions(): Promise<HistorySession[]> {
    return listHistorySessions(this.host);
  }

  openHistorySession(sessionId: string): Promise<AgentSession> {
    return openHistorySession(this.host, sessionId);
  }

  resumeSession(sessionId: string): Promise<AgentSession> {
    return resumeSession(this.host, sessionId);
  }

  private ensureAttached(
    sessionId: string,
    replay: boolean,
  ): Promise<void> {
    return ensureAttached(this.host, sessionId, replay);
  }

  private startTailFollower(sessionId: string): void {
    return startTailFollower(this.host, sessionId);
  }

  private stopTailFollower(sessionId: string): void {
    return stopTailFollower(this.host, sessionId);
  }

  private startToolObserver(sessionId: string): void {
    return startToolObserver(this.host, sessionId);
  }

  private questionKey(sessionId: string, gateId: string): string {
    return questionKey(sessionId, gateId);
  }

  private questionById(
    sessionId: string,
    gateId: string,
  ): QuestionActivity | undefined {
    return questionById(this.host, sessionId, gateId);
  }

  private projectToolStream(sessionId: string, kind: string, payload: Record<string, unknown>): void {
    return projectToolStream(this.host, sessionId, kind, payload);
  }

  private projectTailItems(
    sessionId: string,
    items: Array<{
      kind: string;
      payload: unknown;
      generation?: number;
      seq?: number;
    }>,
  ): void {
    return projectTailItems(this.host, sessionId, items);
  }

  private refreshTranscriptFromFile(sessionId: string): Promise<void> {
    return refreshTranscriptFromFile(this.host, sessionId);
  }

  private reconcileTailTerminalState(sessionId: string): Promise<void> {
    return reconcileTailTerminalState(this.host, sessionId);
  }

  private handleSessionUpdate(notification: SessionNotification): void {
    return handleSessionUpdate(this.host, notification);
  }

  private projectThoughtChunk(
    sessionId: string,
    update: Extract<SessionUpdate, { sessionUpdate: "agent_thought_chunk" }>,
  ): void {
    return projectThoughtChunk(this.host, sessionId, update);
  }

  private installTranscript(
    sessionId: string,
    items: TranscriptItem[],
  ): TranscriptItem[] {
    return installTranscript(this.host, sessionId, items);
  }

  private readTodoRecords(
    sessionId: string,
  ): Promise<unknown[] | undefined> {
    return readTodoRecords(this.host, sessionId);
  }

  private refreshSessionConfigOptions(sessionId: string): Promise<void> {
    return refreshSessionConfigOptions(this.host, sessionId);
  }

  private refreshSessionSettings(sessionId: string): Promise<void> {
    return refreshSessionSettings(this.host, sessionId);
  }

  private refreshContextUsage(
    sessionId: string,
    options?: { force?: boolean },
  ): Promise<void> {
    return refreshContextUsage(this.host, sessionId, options);
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
    if (role === "user" && text && consumePromptEcho(this.host, sessionId, text)) {
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
      noteTranscriptEpoch(this.host, sessionId);
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
    return upsertTool(this.host, sessionId, update);
  }

  private persistArtifact(
    sessionId: string,
    artifactId: string,
    value: unknown,
  ): Promise<void> {
    return persistArtifact(this.host, sessionId, artifactId, value);
  }

  private patchSessionInfo(
    sessionId: string,
    update: Extract<SessionUpdate, { sessionUpdate: "session_info_update" }>,
  ): void {
    return patchSessionInfo(this.host, sessionId, update);
  }

  forkSession(input: {
    sourceSessionId: string;
    title?: string;
  }): Promise<AgentSession> {
    return forkSession(this.host, input);
  }

  private recoverForkedSession(
    cwd: string,
    knownSessionIds: ReadonlySet<string>,
    startedAt: number,
  ): Promise<string | undefined> {
    return recoverForkedSession(this.host, cwd, knownSessionIds, startedAt);
  }

  private gitScope(): GitScope {
    return {
      workspace: this.workspace,
      sessions: this.sessions,
      sessionCwds: this.sessionCwds,
    };
  }
  async getGitStatus(sessionId: string): Promise<GitStatusSnapshot> {
    return getGitStatus(this.gitScope(), sessionId);
  }
  async stageFiles(sessionId: string, paths: string[]): Promise<GitStatusSnapshot> {
    return stageFiles(this.gitScope(), sessionId, paths);
  }
  async unstageFiles(sessionId: string, paths: string[]): Promise<GitStatusSnapshot> {
    return unstageFiles(this.gitScope(), sessionId, paths);
  }
  async commitChanges(sessionId: string, message: string): Promise<GitStatusSnapshot> {
    return commitChanges(this.gitScope(), sessionId, message);
  }
  async pushChanges(sessionId: string): Promise<GitStatusSnapshot> {
    return pushChanges(this.gitScope(), sessionId);
  }

  private emitActivity(
    sessionId: string,
    category: Extract<AgentEvent, { type: "session.activity" }>["category"],
  ): void {
    return emitActivity(this.host, sessionId, category);
  }

  private appendTranscript(item: TranscriptItem): void {
    return appendTranscript(this.host, item);
  }

  private currentRunRevision(sessionId: string): number {
    return currentRunRevision(this.host, sessionId);
  }

  private advanceRunRevision(sessionId: string): number {
    return advanceRunRevision(this.host, sessionId);
  }

  private updateSessionStatus(
    sessionId: string,
    status: AgentSession["status"],
    options?: { announce?: boolean },
  ): void {
    return updateSessionStatus(this.host, sessionId, status, options);
  }
}
