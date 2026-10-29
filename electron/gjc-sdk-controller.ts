import {
  open,
  readFile,
  stat,
} from "node:fs/promises";
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
  controlSession,
  fireAbort,
  flushQueuedNow,
  listQueuedMessages,
  queueFollowUp,
  sendMessage,
  steerSession,
} from "./gjc-sdk-control.js";
import {
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
  openHistorySession,
  recoverOwnedSessions,
  refreshTranscriptAttachment,
  resumeSession,
  scheduleDetach,
} from "./gjc-sdk-attach.js";
import {
  createSession,
  deleteSession,
  forkSession,
  hideSession,
  type LifecycleHost,
  recoverForkedSession,
  removeLocalSession,
  renameSession,
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
  clearRunningLatches,
  discoveredRunState,
  liveEvidenceQuiet,
  reconciledAsyncJobIds,
  recordLiveEvidence,
  recordPendingAsyncWork,
  republishRunState,
  type RunStateHost,
  settleQuietRunningRow,
  syncRunStateWatchers,
  transcriptStartedNewWork,
} from "./gjc-sdk-run-state.js";
import {
  type FilesHost,
  locateSharedTranscriptFile,
  persistArtifact,
  previewFile,
  readArtifact,
  readTranscriptEnvelopes,
  removeSessionArtifacts,
} from "./gjc-sdk-files.js";
import {
  captureSessionState,
  cycleThinking,
  patchSessionRuntime,
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
  operateGoal,
  PROGRESS_REFRESH_MIN_MS,
  PROGRESS_STALE_MS,
  PROGRESS_WATCH_MS,
  readTodoRecords,
  requestProgressRefresh,
  TODO_EVENT_POLL_BASE_MS,
  TODO_EVENT_POLL_MAX_MS,
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
  COMMAND_REFRESH_RETRY_BASE_MS,
  COMMAND_REFRESH_RETRY_MAX_MS,
  type CommandPaletteHost,
  publishSessionCommands,
  refreshSdkCommands,
  sdkOperations,
} from "./gjc-sdk-command-palette.js";
export {
  COMMAND_REFRESH_RETRY_BASE_MS,
  COMMAND_REFRESH_RETRY_MAX_MS,
} from "./gjc-sdk-command-palette.js";
import {
  hasAnswerableQuestion,
  projectWorkflowGate,
  questionById,
  type QuestionHost,
  questionKey,
  refreshWorkflowQuestions,
  settleOpenQuestions,
  submitQuestionAnswer,
} from "./gjc-sdk-questions.js";
import { executeSdkSlashCommand } from "./gjc-sdk-slash-commands.js";
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

/**
 * How long a loaded command/todo context is reused before it is read again.
 *
 * Opening the palette is a user gesture, not a poll; a refresh costs two or more
 * CLI round trips, so a reopen seconds later must not repeat them.
 */
export const SESSION_CONTEXT_REFRESH_TTL_MS = 15_000;


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
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private reconnectAttempt = 0;
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

  private readonly questionHost: QuestionHost = ((controller: GjcSdkController): QuestionHost => ({
    get sessionQuestions() {
      return controller.sessionQuestions;
    },
    get questionRefreshes() {
      return controller.questionRefreshes;
    },
    get disposed() {
      return controller.disposed;
    },
    querySessionItems: (sessionId, query, input, options) => controller.querySessionItems(sessionId, query, input, options),
    get observedQuestions() {
      return controller.observedQuestions;
    },
    get acceptedQuestions() {
      return controller.acceptedQuestions;
    },
    get transcripts() {
      return controller.transcripts;
    },
    get locallyAbortedSessions() {
      return controller.locallyAbortedSessions;
    },
    noteTranscriptEpoch: (sessionId) => controller.noteTranscriptEpoch(sessionId),
    get emitEvent() {
      return controller.emitEvent;
    },
    markTranscriptRowDirty: (sessionId, rowId) => controller.markTranscriptRowDirty(sessionId, rowId),
    emitActivity: (sessionId, category) => controller.emitActivity(sessionId, category),
    get sessions() {
      return controller.sessions;
    },
    get cancellingSessions() {
      return controller.cancellingSessions;
    },
    updateSessionStatus: (sessionId, status, options) => controller.updateSessionStatus(sessionId, status, options),
    controlSession: (sessionId, operation, input, options) => controller.controlSession(sessionId, operation, input, options),
  }))(this);

  private readonly commandPaletteHost: CommandPaletteHost = ((controller: GjcSdkController): CommandPaletteHost => ({
    get commandRefreshes() {
      return controller.commandRefreshes;
    },
    get sessionAdvertisedCommands() {
      return controller.sessionAdvertisedCommands;
    },
    get sessionDiscoveredCommands() {
      return controller.sessionDiscoveredCommands;
    },
    get sessionCommands() {
      return controller.sessionCommands;
    },
    get disposed() {
      return controller.disposed;
    },
    get sessions() {
      return controller.sessions;
    },
    get commandRefreshTimers() {
      return controller.commandRefreshTimers;
    },
    get commandRefreshAttempts() {
      return controller.commandRefreshAttempts;
    },
    querySessionItems: (sessionId, query, input, options) => controller.querySessionItems(sessionId, query, input, options),
    get sessionSdkOperations() {
      return controller.sessionSdkOperations;
    },
    get publishedCommandKeys() {
      return controller.publishedCommandKeys;
    },
    get emitEvent() {
      return controller.emitEvent;
    },
  }))(this);

  private readonly goalTodoHost: GoalTodoHost = ((controller: GjcSdkController): GoalTodoHost => ({
    querySessionItems: (sessionId, query, input, options) => controller.querySessionItems(sessionId, query, input, options),
    get sessionSdkOperations() {
      return controller.sessionSdkOperations;
    },
    get progressWatchedAt() {
      return controller.progressWatchedAt;
    },
    get sessionProgress() {
      return controller.sessionProgress;
    },
    get disposed() {
      return controller.disposed;
    },
    get progressTimers() {
      return controller.progressTimers;
    },
    get progressReads() {
      return controller.progressReads;
    },
    get sessions() {
      return controller.sessions;
    },
    controlSession: (sessionId, operation, input, options) => controller.controlSession(sessionId, operation, input, options),
    get sessionTodoSnapshots() {
      return controller.sessionTodoSnapshots;
    },
    get attachedSessions() {
      return controller.attachedSessions;
    },
    get todoPollTimers() {
      return controller.todoPollTimers;
    },
    get todoPollAttempts() {
      return controller.todoPollAttempts;
    },
    get todoReads() {
      return controller.todoReads;
    },
    markTranscriptRowDirty: (sessionId, rowId) => controller.markTranscriptRowDirty(sessionId, rowId),
    get transcripts() {
      return controller.transcripts;
    },
    noteTranscriptEpoch: (sessionId) => controller.noteTranscriptEpoch(sessionId),
    get emitEvent() {
      return controller.emitEvent;
    },
  }))(this);

  private readonly sessionConfigHost: SessionConfigHost = ((controller: GjcSdkController): SessionConfigHost => ({
    get modelProfiles() {
      return controller.modelProfiles;
    },
    get modelPreset() {
      return controller.modelPreset;
    },
    get modelPresetThinking() {
      return controller.modelPresetThinking;
    },
    get explicitSessionThinking() {
      return controller.explicitSessionThinking;
    },
    get sessionConfig() {
      return controller.sessionConfig;
    },
    get emitEvent() {
      return controller.emitEvent;
    },
    get sessions() {
      return controller.sessions;
    },
    requireCli: () => controller.requireCli(),
    repoFor: (sessionId) => controller.repoFor(sessionId),
    get disposed() {
      return controller.disposed;
    },
    get contextUsageObservedAt() {
      return controller.contextUsageObservedAt;
    },
    get contextUsageQueries() {
      return controller.contextUsageQueries;
    },
    querySessionItems: (sessionId, query, input, options) => controller.querySessionItems(sessionId, query, input, options),
    advanceRunRevision: (sessionId) => controller.advanceRunRevision(sessionId),
    controlSession: (sessionId, operation, input, options) => controller.controlSession(sessionId, operation, input, options),
    ensureAttached: (sessionId, replay) => controller.ensureAttached(sessionId, replay),
  }))(this);

  private readonly filesHost: FilesHost = ((controller: GjcSdkController): FilesHost => ({
    get transcripts() {
      return controller.transcripts;
    },
    getTranscript: (sessionId) => controller.getTranscript(sessionId),
    get artifactDirectory() {
      return controller.artifactDirectory;
    },
    requireCli: () => controller.requireCli(),
    ensureAttached: (sessionId, replay) => controller.ensureAttached(sessionId, replay),
    repoFor: (sessionId) => controller.repoFor(sessionId),
    get deletingSessions() {
      return controller.deletingSessions;
    },
    get artifactSessionIds() {
      return controller.artifactSessionIds;
    },
    get artifactWrites() {
      return controller.artifactWrites;
    },
    get nextLocalId() {
      return controller.nextLocalId;
    },
    set nextLocalId(value) {
      controller.nextLocalId = value;
    },
    get sessionCwds() {
      return controller.sessionCwds;
    },
    get workspace() {
      return controller.workspace;
    },
    get sharedSessionFiles() {
      return controller.sharedSessionFiles;
    },
    get sharedTranscriptReads() {
      return controller.sharedTranscriptReads;
    },
  }))(this);

  private readonly runStateHost: RunStateHost = ((controller: GjcSdkController): RunStateHost => ({
    locateSharedTranscriptFile: (sessionId) => controller.locateSharedTranscriptFile(sessionId),
    get discoveredRunStates() {
      return controller.discoveredRunStates;
    },
    get pendingAsyncWorkSessions() {
      return controller.pendingAsyncWorkSessions;
    },
    get asyncJobReconciliations() {
      return controller.asyncJobReconciliations;
    },
    get sessions() {
      return controller.sessions;
    },
    get liveRunningSessions() {
      return controller.liveRunningSessions;
    },
    get transcriptRunningSessions() {
      return controller.transcriptRunningSessions;
    },
    get locallyAbortedSessions() {
      return controller.locallyAbortedSessions;
    },
    currentRunRevision: (sessionId) => controller.currentRunRevision(sessionId),
    get idleTranscriptBaselines() {
      return controller.idleTranscriptBaselines;
    },
    get workingPhaseSessions() {
      return controller.workingPhaseSessions;
    },
    get runtimeIdleSessions() {
      return controller.runtimeIdleSessions;
    },
    get liveEvidenceAt() {
      return controller.liveEvidenceAt;
    },
    get liveRunningDigests() {
      return controller.liveRunningDigests;
    },
    get compactingSessions() {
      return controller.compactingSessions;
    },
    get compactionRecordBaseline() {
      return controller.compactionRecordBaseline;
    },
    get compactionStartedAt() {
      return controller.compactionStartedAt;
    },
    get activePromptSessions() {
      return controller.activePromptSessions;
    },
    advanceRunRevision: (sessionId) => controller.advanceRunRevision(sessionId),
    get emitEvent() {
      return controller.emitEvent;
    },
    querySessionItems: (sessionId, query, input, options) => controller.querySessionItems(sessionId, query, input, options),
    get disposed() {
      return controller.disposed;
    },
    get runStateWatchers() {
      return controller.runStateWatchers;
    },
    get runStateTimers() {
      return controller.runStateTimers;
    },
    get sharedSessionWatchers() {
      return controller.sharedSessionWatchers;
    },
    get generation() {
      return controller.generation;
    },
    get lastDiscovered() {
      return controller.lastDiscovered;
    },
    set lastDiscovered(value) {
      controller.lastDiscovered = value;
    },
  }))(this);

  private readonly discoveryHost: DiscoveryHost = ((controller: GjcSdkController): DiscoveryHost => ({
    brokerSessions: (options) => controller.brokerSessions(options),
    get lastDiscovered() {
      return controller.lastDiscovered;
    },
    set lastDiscovered(value) {
      controller.lastDiscovered = value;
    },
    get sessionMetadata() {
      return controller.sessionMetadata;
    },
    liveRouteReachable: (row) => controller.liveRouteReachable(row),
    get terminalOnlySessions() {
      return controller.terminalOnlySessions;
    },
    get sessions() {
      return controller.sessions;
    },
    get lastLiveFingerprint() {
      return controller.lastLiveFingerprint;
    },
    set lastLiveFingerprint(value) {
      controller.lastLiveFingerprint = value;
    },
    get workspace() {
      return controller.workspace;
    },
    get activePromptSessions() {
      return controller.activePromptSessions;
    },
    get liveRunningSessions() {
      return controller.liveRunningSessions;
    },
    get pendingAsyncWorkSessions() {
      return controller.pendingAsyncWorkSessions;
    },
    syncRunStateWatchers: (sessionIds) => controller.syncRunStateWatchers(sessionIds),
    discoveredRunState: (sessionId) => controller.discoveredRunState(sessionId),
    get workingPhaseSessions() {
      return controller.workingPhaseSessions;
    },
    liveEvidenceQuiet: (sessionId) => controller.liveEvidenceQuiet(sessionId),
    locateSharedTranscriptFile: (sessionId) => controller.locateSharedTranscriptFile(sessionId),
    get attachedSessions() {
      return controller.attachedSessions;
    },
    currentRunRevision: (sessionId) => controller.currentRunRevision(sessionId),
    settleQuietRunningRow: (sessionId, transcriptStatus, currentSession) => controller.settleQuietRunningRow(sessionId, transcriptStatus, currentSession),
    get runtimeIdleSessions() {
      return controller.runtimeIdleSessions;
    },
    get locallyAbortedSessions() {
      return controller.locallyAbortedSessions;
    },
    sessionParentId: (sessionId) => controller.sessionParentId(sessionId),
    advanceRunRevision: (sessionId) => controller.advanceRunRevision(sessionId),
    get sessionCwds() {
      return controller.sessionCwds;
    },
    get routeProbes() {
      return controller.routeProbes;
    },
    requireCli: () => controller.requireCli(),
    get disposed() {
      return controller.disposed;
    },
    get startupSessionRows() {
      return controller.startupSessionRows;
    },
    set startupSessionRows(value) {
      controller.startupSessionRows = value;
    },
    get cachedBrokerRows() {
      return controller.cachedBrokerRows;
    },
    set cachedBrokerRows(value) {
      controller.cachedBrokerRows = value;
    },
    get cachedBrokerRevision() {
      return controller.cachedBrokerRevision;
    },
    set cachedBrokerRevision(value) {
      controller.cachedBrokerRevision = value;
    },
    get sessionParents() {
      return controller.sessionParents;
    },
  }))(this);

  private readonly lifecycleHost: LifecycleHost = ((controller: GjcSdkController): LifecycleHost => ({
    requireCli: () => controller.requireCli(),
    get nextLocalId() {
      return controller.nextLocalId;
    },
    set nextLocalId(value) {
      controller.nextLocalId = value;
    },
    get sessions() {
      return controller.sessions;
    },
    brokerSessions: (options) => controller.brokerSessions(options),
    get modelPreset() {
      return controller.modelPreset;
    },
    get sessionCwds() {
      return controller.sessionCwds;
    },
    get transcripts() {
      return controller.transcripts;
    },
    get toolRowIndices() {
      return controller.toolRowIndices;
    },
    get messageKeys() {
      return controller.messageKeys;
    },
    get startupSessionRows() {
      return controller.startupSessionRows;
    },
    set startupSessionRows(value) {
      controller.startupSessionRows = value;
    },
    invalidateBrokerIndexCache: () => controller.invalidateBrokerIndexCache(),
    get windowHostedSessions() {
      return controller.windowHostedSessions;
    },
    get sessionMetadata() {
      return controller.sessionMetadata;
    },
    applyPermissionMode: (sessionId) => controller.applyPermissionMode(sessionId),
    get emitEvent() {
      return controller.emitEvent;
    },
    get attachedSessions() {
      return controller.attachedSessions;
    },
    startTailFollower: (sessionId) => controller.startTailFollower(sessionId),
    refreshSdkCommands: (sessionId, advertised) => controller.refreshSdkCommands(sessionId, advertised),
    refreshSessionConfigOptions: (sessionId) => controller.refreshSessionConfigOptions(sessionId),
    refreshContextUsage: (sessionId, options) => controller.refreshContextUsage(sessionId, options),
    locateSharedTranscriptFile: (sessionId) => controller.locateSharedTranscriptFile(sessionId),
    watchSharedTranscript: (sessionId, filePath) => controller.watchSharedTranscript(sessionId, filePath),
    ensureAttached: (sessionId, replay) => controller.ensureAttached(sessionId, replay),
    get forkRecoveryIntervalMs() {
      return controller.forkRecoveryIntervalMs;
    },
    get deletionPromises() {
      return controller.deletionPromises;
    },
    get deletingSessions() {
      return controller.deletingSessions;
    },
    get workspace() {
      return controller.workspace;
    },
    stopTailFollower: (sessionId) => controller.stopTailFollower(sessionId),
    removeSessionArtifacts: (sessionId) => controller.removeSessionArtifacts(sessionId),
    removeLocalSession: (sessionId, hide) => controller.removeLocalSession(sessionId, hide),
    get transcriptAttachments() {
      return controller.transcriptAttachments;
    },
    get dirtyTranscriptRows() {
      return controller.dirtyTranscriptRows;
    },
    get desktopTranscriptBaselines() {
      return controller.desktopTranscriptBaselines;
    },
    get activeAssistantMessages() {
      return controller.activeAssistantMessages;
    },
    get activeThoughts() {
      return controller.activeThoughts;
    },
    get activePromptSessions() {
      return controller.activePromptSessions;
    },
    get activePromptAdmissions() {
      return controller.activePromptAdmissions;
    },
    get cancellationWatermarks() {
      return controller.cancellationWatermarks;
    },
    get liveRunningSessions() {
      return controller.liveRunningSessions;
    },
    get liveRunningDigests() {
      return controller.liveRunningDigests;
    },
    get liveEvidenceAt() {
      return controller.liveEvidenceAt;
    },
    get transcriptRunningSessions() {
      return controller.transcriptRunningSessions;
    },
    get workingPhaseSessions() {
      return controller.workingPhaseSessions;
    },
    get runtimeIdleSessions() {
      return controller.runtimeIdleSessions;
    },
    get pendingAsyncWorkSessions() {
      return controller.pendingAsyncWorkSessions;
    },
    get completionDeferredSessions() {
      return controller.completionDeferredSessions;
    },
    get asyncJobReconciliations() {
      return controller.asyncJobReconciliations;
    },
    get runRevisions() {
      return controller.runRevisions;
    },
    get discoveredRunStates() {
      return controller.discoveredRunStates;
    },
    get idleTranscriptBaselines() {
      return controller.idleTranscriptBaselines;
    },
    get compactingSessions() {
      return controller.compactingSessions;
    },
    get compactionRecordBaseline() {
      return controller.compactionRecordBaseline;
    },
    get compactionRecordWatermark() {
      return controller.compactionRecordWatermark;
    },
    get compactionStartedAt() {
      return controller.compactionStartedAt;
    },
    get suppressedUserMessageKeys() {
      return controller.suppressedUserMessageKeys;
    },
    get echoedPromptTexts() {
      return controller.echoedPromptTexts;
    },
    get locallyAbortedSessions() {
      return controller.locallyAbortedSessions;
    },
    get sessionCommands() {
      return controller.sessionCommands;
    },
    get publishedCommandKeys() {
      return controller.publishedCommandKeys;
    },
    get commandRefreshes() {
      return controller.commandRefreshes;
    },
    get sessionContextRefreshes() {
      return controller.sessionContextRefreshes;
    },
    get sessionContextRefreshedAt() {
      return controller.sessionContextRefreshedAt;
    },
    clearCommandRefreshRetry: (sessionId) => controller.clearCommandRefreshRetry(sessionId),
    clearTodoPoll: (sessionId) => controller.clearTodoPoll(sessionId),
    clearProgress: (sessionId) => controller.clearProgress(sessionId),
    get sessionAdvertisedCommands() {
      return controller.sessionAdvertisedCommands;
    },
    get sessionDiscoveredCommands() {
      return controller.sessionDiscoveredCommands;
    },
    get sessionPlans() {
      return controller.sessionPlans;
    },
    get sessionQuestions() {
      return controller.sessionQuestions;
    },
    get sessionTodoSnapshots() {
      return controller.sessionTodoSnapshots;
    },
    get todoReads() {
      return controller.todoReads;
    },
    get sessionSdkOperations() {
      return controller.sessionSdkOperations;
    },
    get sessionConfig() {
      return controller.sessionConfig;
    },
    get terminalOnlySessions() {
      return controller.terminalOnlySessions;
    },
    get routeProbes() {
      return controller.routeProbes;
    },
    get modelProfiles() {
      return controller.modelProfiles;
    },
    get explicitSessionThinking() {
      return controller.explicitSessionThinking;
    },
    get sharedSessionWatchers() {
      return controller.sharedSessionWatchers;
    },
    get runStateWatchers() {
      return controller.runStateWatchers;
    },
    get runStateTimers() {
      return controller.runStateTimers;
    },
    get sharedSessionRefreshTimers() {
      return controller.sharedSessionRefreshTimers;
    },
    cancelPermissionsForSession: (sessionId) => controller.cancelPermissionsForSession(sessionId),
    get lastLiveFingerprint() {
      return controller.lastLiveFingerprint;
    },
    set lastLiveFingerprint(value) {
      controller.lastLiveFingerprint = value;
    },
    get lastDiscovered() {
      return controller.lastDiscovered;
    },
    set lastDiscovered(value) {
      controller.lastDiscovered = value;
    },
    sdkOperations: (sessionId, options) => controller.sdkOperations(sessionId, options),
    controlSession: (sessionId, operation, input, options) => controller.controlSession(sessionId, operation, input, options),
  }))(this);

  private readonly attachHost: AttachHost = ((controller: GjcSdkController): AttachHost => ({
    brokerSessions: (options) => controller.brokerSessions(options),
    get historySummaryCache() {
      return controller.historySummaryCache;
    },
    get sessions() {
      return controller.sessions;
    },
    locateSharedTranscriptFile: (sessionId) => controller.locateSharedTranscriptFile(sessionId),
    get workspace() {
      return controller.workspace;
    },
    get sessionMetadata() {
      return controller.sessionMetadata;
    },
    get sessionCwds() {
      return controller.sessionCwds;
    },
    get emitEvent() {
      return controller.emitEvent;
    },
    get generation() {
      return controller.generation;
    },
    resumeSession: (sessionId) => controller.resumeSession(sessionId),
    readPersistedTranscript: (sessionId) => controller.readPersistedTranscript(sessionId),
    get disposed() {
      return controller.disposed;
    },
    markTerminalOnly: (sessionId) => controller.markTerminalOnly(sessionId),
    installTranscript: (sessionId, items) => controller.installTranscript(sessionId, items),
    discoveredRunState: (sessionId) => controller.discoveredRunState(sessionId),
    advanceRunRevision: (sessionId) => controller.advanceRunRevision(sessionId),
    invalidateDesktopTranscript: (sessionId) => controller.invalidateDesktopTranscript(sessionId),
    get terminalOnlySessions() {
      return controller.terminalOnlySessions;
    },
    stopTailFollower: (sessionId) => controller.stopTailFollower(sessionId),
    get attachedSessions() {
      return controller.attachedSessions;
    },
    get attachAttempts() {
      return controller.attachAttempts;
    },
    ensureAttached: (sessionId, replay) => controller.ensureAttached(sessionId, replay),
    refreshSessionSettings: (sessionId) => controller.refreshSessionSettings(sessionId),
    startTailFollower: (sessionId) => controller.startTailFollower(sessionId),
    requireCli: () => controller.requireCli(),
    repoFor: (sessionId) => controller.repoFor(sessionId),
    get messageKeys() {
      return controller.messageKeys;
    },
    get modelPreset() {
      return controller.modelPreset;
    },
    get windowHostedSessions() {
      return controller.windowHostedSessions;
    },
    get sharedSessionFiles() {
      return controller.sharedSessionFiles;
    },
    applyPermissionMode: (sessionId) => controller.applyPermissionMode(sessionId),
    refreshSdkCommands: (sessionId, advertised) => controller.refreshSdkCommands(sessionId, advertised),
    refreshSessionConfigOptions: (sessionId) => controller.refreshSessionConfigOptions(sessionId),
    readSharedTranscript: (sessionId) => controller.readSharedTranscript(sessionId),
    finalizeAllMessages: (sessionId) => controller.finalizeAllMessages(sessionId),
    get watchedTranscripts() {
      return controller.watchedTranscripts;
    },
    watchSharedTranscript: (sessionId, filePath) => controller.watchSharedTranscript(sessionId, filePath),
    refreshContextUsage: (sessionId, options) => controller.refreshContextUsage(sessionId, options),
    get detachTimers() {
      return controller.detachTimers;
    },
    get activePromptSessions() {
      return controller.activePromptSessions;
    },
    get workingPhaseSessions() {
      return controller.workingPhaseSessions;
    },
    get sharedSessionWatchers() {
      return controller.sharedSessionWatchers;
    },
    get sharedSessionRefreshTimers() {
      return controller.sharedSessionRefreshTimers;
    },
    get transcripts() {
      return controller.transcripts;
    },
    get toolRowIndices() {
      return controller.toolRowIndices;
    },
    get dirtyTranscriptRows() {
      return controller.dirtyTranscriptRows;
    },
    get desktopTranscriptBaselines() {
      return controller.desktopTranscriptBaselines;
    },
    get activeAssistantMessages() {
      return controller.activeAssistantMessages;
    },
    get activeThoughts() {
      return controller.activeThoughts;
    },
    get sessionSdkOperations() {
      return controller.sessionSdkOperations;
    },
    get contextUsageObservedAt() {
      return controller.contextUsageObservedAt;
    },
    get transcriptAttachments() {
      return controller.transcriptAttachments;
    },
    get cli() {
      return controller.cli;
    },
    get recovery() {
      return controller.recovery;
    },
    set recovery(value) {
      controller.recovery = value;
    },
  }))(this);

  private readonly transcriptStoreHost: TranscriptStoreHost = ((controller: GjcSdkController): TranscriptStoreHost => ({
    get activePromptSessions() {
      return controller.activePromptSessions;
    },
    readPersistedTranscript: (sessionId) => controller.readPersistedTranscript(sessionId),
    installTranscript: (sessionId, items) => controller.installTranscript(sessionId, items),
    get terminalOnlySessions() {
      return controller.terminalOnlySessions;
    },
    readSharedTranscript: (sessionId) => controller.readSharedTranscript(sessionId),
    refreshTranscriptAttachment: (sessionId) => controller.refreshTranscriptAttachment(sessionId),
    terminalOnlyNotice: (sessionId) => controller.terminalOnlyNotice(sessionId),
    ensureAttached: (sessionId, replay) => controller.ensureAttached(sessionId, replay),
    get sessions() {
      return controller.sessions;
    },
    get emitEvent() {
      return controller.emitEvent;
    },
    lifecycleUncertainNotice: (sessionId) => controller.lifecycleUncertainNotice(sessionId),
    removeLocalSession: (sessionId, hide) => controller.removeLocalSession(sessionId, hide),
    get transcripts() {
      return controller.transcripts;
    },
    getTranscript: (sessionId) => controller.getTranscript(sessionId),
    get desktopTranscriptBaselines() {
      return controller.desktopTranscriptBaselines;
    },
    get toolRowIndices() {
      return controller.toolRowIndices;
    },
    get dirtyTranscriptRows() {
      return controller.dirtyTranscriptRows;
    },
    currentRunRevision: (sessionId) => controller.currentRunRevision(sessionId),
    get transcriptEpoch() {
      return controller.transcriptEpoch;
    },
    locateSharedTranscriptFile: (sessionId) => controller.locateSharedTranscriptFile(sessionId),
    querySessionItems: (sessionId, query, input, options) => controller.querySessionItems(sessionId, query, input, options),
    get generation() {
      return controller.generation;
    },
    watchSharedTranscript: (sessionId, filePath) => controller.watchSharedTranscript(sessionId, filePath),
    readTranscriptEnvelopes: (filePath, info) => controller.readTranscriptEnvelopes(filePath, info),
    get compactionRecordWatermark() {
      return controller.compactionRecordWatermark;
    },
    reconciledAsyncJobIds: (sessionId, jobIds) => controller.reconciledAsyncJobIds(sessionId, jobIds),
    get asyncJobReconciliations() {
      return controller.asyncJobReconciliations;
    },
    get workingPhaseSessions() {
      return controller.workingPhaseSessions;
    },
    get compactionRecordBaseline() {
      return controller.compactionRecordBaseline;
    },
    get compactingSessions() {
      return controller.compactingSessions;
    },
    get compactionStartedAt() {
      return controller.compactionStartedAt;
    },
    get runtimeIdleSessions() {
      return controller.runtimeIdleSessions;
    },
    get liveRunningDigests() {
      return controller.liveRunningDigests;
    },
    get liveRunningSessions() {
      return controller.liveRunningSessions;
    },
    get liveEvidenceAt() {
      return controller.liveEvidenceAt;
    },
    get transcriptRunningSessions() {
      return controller.transcriptRunningSessions;
    },
    get discoveredRunStates() {
      return controller.discoveredRunStates;
    },
    patchSessionRuntime: (sessionId, patch) => controller.patchSessionRuntime(sessionId, patch),
    recordPendingAsyncWork: (sessionId, jobIds) => controller.recordPendingAsyncWork(sessionId, jobIds),
    transcriptStartedNewWork: (sessionId, size, transcriptRunning) => controller.transcriptStartedNewWork(sessionId, size, transcriptRunning),
    updateSessionStatus: (sessionId, status, options) => controller.updateSessionStatus(sessionId, status, options),
    get locallyAbortedSessions() {
      return controller.locallyAbortedSessions;
    },
    get sharedSessionFiles() {
      return controller.sharedSessionFiles;
    },
    get sharedSessionWatchers() {
      return controller.sharedSessionWatchers;
    },
    get disposed() {
      return controller.disposed;
    },
    get sharedSessionRefreshTimers() {
      return controller.sharedSessionRefreshTimers;
    },
    publishTranscriptSync: (sessionId, previous, items) => controller.publishTranscriptSync(sessionId, previous, items),
    refreshContextUsage: (sessionId, options) => controller.refreshContextUsage(sessionId, options),
    republishRunState: (sessionId) => controller.republishRunState(sessionId),
    get toolSnapshots() {
      return controller.toolSnapshots;
    },
    get imageDataUrls() {
      return controller.imageDataUrls;
    },
    get sessionPlans() {
      return controller.sessionPlans;
    },
    get sessionTodoSnapshots() {
      return controller.sessionTodoSnapshots;
    },
    get activeAssistantMessages() {
      return controller.activeAssistantMessages;
    },
    get activeThoughts() {
      return controller.activeThoughts;
    },
    get sessionQuestions() {
      return controller.sessionQuestions;
    },
    get watchedTranscripts() {
      return controller.watchedTranscripts;
    },
    set watchedTranscripts(value) {
      controller.watchedTranscripts = value;
    },
    get detachTimers() {
      return controller.detachTimers;
    },
    get attachedSessions() {
      return controller.attachedSessions;
    },
    scheduleDetach: (sessionId) => controller.scheduleDetach(sessionId),
  }))(this);

  private readonly controlHost: ControlHost = ((controller: GjcSdkController): ControlHost => ({
    get sessions() {
      return controller.sessions;
    },
    persistedCompactionCount: (sessionId) => controller.persistedCompactionCount(sessionId),
    get compactingSessions() {
      return controller.compactingSessions;
    },
    get compactionStartedAt() {
      return controller.compactionStartedAt;
    },
    get compactionRecordBaseline() {
      return controller.compactionRecordBaseline;
    },
    patchSessionRuntime: (sessionId, patch) => controller.patchSessionRuntime(sessionId, patch),
    controlSession: (sessionId, operation, input, options) => controller.controlSession(sessionId, operation, input, options),
    refreshContextUsage: (sessionId, options) => controller.refreshContextUsage(sessionId, options),
    get echoedPromptTexts() {
      return controller.echoedPromptTexts;
    },
    get locallyAbortedSessions() {
      return controller.locallyAbortedSessions;
    },
    appendLocalUserMessage: (sessionId, text, input) => controller.appendLocalUserMessage(sessionId, text, input),
    get pendingSteers() {
      return controller.pendingSteers;
    },
    ensureAttached: (sessionId, replay) => controller.ensureAttached(sessionId, replay),
    get terminalOnlySessions() {
      return controller.terminalOnlySessions;
    },
    requireCli: () => controller.requireCli(),
    repoFor: (sessionId) => controller.repoFor(sessionId),
    markTerminalOnly: (sessionId) => controller.markTerminalOnly(sessionId),
    querySessionItems: (sessionId, query, input, options) => controller.querySessionItems(sessionId, query, input, options),
    get flushingSessions() {
      return controller.flushingSessions;
    },
    discoveredRunState: (sessionId) => controller.discoveredRunState(sessionId),
    updateSessionStatus: (sessionId, status, options) => controller.updateSessionStatus(sessionId, status, options),
    executeSdkSlashCommand: (sessionId, input, options) => controller.executeSdkSlashCommand(sessionId, input, options),
    get activePromptSessions() {
      return controller.activePromptSessions;
    },
    get generation() {
      return controller.generation;
    },
    get activePromptAdmissions() {
      return controller.activePromptAdmissions;
    },
    currentRunRevision: (sessionId) => controller.currentRunRevision(sessionId),
    get activeAssistantMessages() {
      return controller.activeAssistantMessages;
    },
    finalizeThought: (sessionId) => controller.finalizeThought(sessionId),
    awaitPromptSettlement: (sessionId, operationRef, isCurrent) => controller.awaitPromptSettlement(sessionId, operationRef, isCurrent),
    finalizeAssistantMessage: (sessionId) => controller.finalizeAssistantMessage(sessionId),
    get nextLocalId() {
      return controller.nextLocalId;
    },
    set nextLocalId(value) {
      controller.nextLocalId = value;
    },
    appendTranscript: (item) => controller.appendTranscript(item),
    emitActivity: (sessionId, category) => controller.emitActivity(sessionId, category),
    get disposed() {
      return controller.disposed;
    },
    republishRunState: (sessionId) => controller.republishRunState(sessionId),
    get cancellationWatermarks() {
      return controller.cancellationWatermarks;
    },
    get cancellationPromises() {
      return controller.cancellationPromises;
    },
    get cancellingSessions() {
      return controller.cancellingSessions;
    },
    fireAbort: (sessionId) => controller.fireAbort(sessionId),
    finalizeAllMessages: (sessionId) => controller.finalizeAllMessages(sessionId),
    get toolSnapshots() {
      return controller.toolSnapshots;
    },
    cancelOpenTools: (sessionId) => controller.cancelOpenTools(sessionId),
    settleOpenQuestions: (sessionId, status) => controller.settleOpenQuestions(sessionId, status),
    cancelPermissionsForSession: (sessionId) => controller.cancelPermissionsForSession(sessionId),
    get liveRunningSessions() {
      return controller.liveRunningSessions;
    },
    get liveRunningDigests() {
      return controller.liveRunningDigests;
    },
    get liveEvidenceAt() {
      return controller.liveEvidenceAt;
    },
    get transcriptRunningSessions() {
      return controller.transcriptRunningSessions;
    },
    get workingPhaseSessions() {
      return controller.workingPhaseSessions;
    },
    get runtimeIdleSessions() {
      return controller.runtimeIdleSessions;
    },
    get pendingAsyncWorkSessions() {
      return controller.pendingAsyncWorkSessions;
    },
    get discoveredRunStates() {
      return controller.discoveredRunStates;
    },
    get transcripts() {
      return controller.transcripts;
    },
  }))(this);

  private readonly streamHost: StreamHost = ((controller: GjcSdkController): StreamHost => ({
    get disposed() {
      return controller.disposed;
    },
    get tailReads() {
      return controller.tailReads;
    },
    get attachedSessions() {
      return controller.attachedSessions;
    },
    get tailControllers() {
      return controller.tailControllers;
    },
    clearTodoPoll: (sessionId) => controller.clearTodoPoll(sessionId),
    get toolObservers() {
      return controller.toolObservers;
    },
    get toolSnapshots() {
      return controller.toolSnapshots;
    },
    get tailCheckpoints() {
      return controller.tailCheckpoints;
    },
    get tailEventPositions() {
      return controller.tailEventPositions;
    },
    refreshWorkflowQuestions: (sessionId) => controller.refreshWorkflowQuestions(sessionId),
    requireCli: () => controller.requireCli(),
    projectToolStream: (sessionId, kind, payload) => controller.projectToolStream(sessionId, kind, payload),
    repoFor: (sessionId) => controller.repoFor(sessionId),
    projectMessageChunk: (sessionId, role, update) => controller.projectMessageChunk(sessionId, role, update),
    finalizeAssistantMessage: (sessionId) => controller.finalizeAssistantMessage(sessionId),
    refreshTranscriptFromFile: (sessionId) => controller.refreshTranscriptFromFile(sessionId),
    get transcripts() {
      return controller.transcripts;
    },
    noteTranscriptEpoch: (sessionId) => controller.noteTranscriptEpoch(sessionId),
    get emitEvent() {
      return controller.emitEvent;
    },
    appendTranscript: (item) => controller.appendTranscript(item),
    projectWorkflowGate: (sessionId, payload) => controller.projectWorkflowGate(sessionId, payload),
    requestProgressRefresh: (sessionId) => controller.requestProgressRefresh(sessionId),
    upsertTool: (sessionId, update) => controller.upsertTool(sessionId, update),
    settleOpenQuestions: (sessionId, status) => controller.settleOpenQuestions(sessionId, status),
    handleSessionUpdate: (notification) => controller.handleSessionUpdate(notification),
    updateSessionStatus: (sessionId, status, options) => controller.updateSessionStatus(sessionId, status, options),
    get generation() {
      return controller.generation;
    },
    currentRunRevision: (sessionId) => controller.currentRunRevision(sessionId),
    discoveredRunState: (sessionId) => controller.discoveredRunState(sessionId),
    refreshSdkCommands: (sessionId, advertised) => controller.refreshSdkCommands(sessionId, advertised),
    captureSessionState: (sessionId, options, mode) => controller.captureSessionState(sessionId, options, mode),
    get sessionConfig() {
      return controller.sessionConfig;
    },
    get modelProfiles() {
      return controller.modelProfiles;
    },
    refreshSessionConfigOptions: (sessionId) => controller.refreshSessionConfigOptions(sessionId),
    refreshModelCapabilities: (sessionId) => controller.refreshModelCapabilities(sessionId),
    patchSessionRuntime: (sessionId, patch) => controller.patchSessionRuntime(sessionId, patch),
    get contextUsageObservedAt() {
      return controller.contextUsageObservedAt;
    },
    get activeThoughts() {
      return controller.activeThoughts;
    },
    get nextLocalId() {
      return controller.nextLocalId;
    },
    set nextLocalId(value) {
      controller.nextLocalId = value;
    },
    get sessionPlans() {
      return controller.sessionPlans;
    },
    markTranscriptRowDirty: (sessionId, rowId) => controller.markTranscriptRowDirty(sessionId, rowId),
    get toolRowIndices() {
      return controller.toolRowIndices;
    },
    get locallyAbortedSessions() {
      return controller.locallyAbortedSessions;
    },
    persistArtifact: (sessionId, artifactId, value) => controller.persistArtifact(sessionId, artifactId, value),
    readTodoRecords: (sessionId) => controller.readTodoRecords(sessionId),
    resolveToolImages: (items) => controller.resolveToolImages(items),
    emitActivity: (sessionId, category) => controller.emitActivity(sessionId, category),
    get pendingPermissions() {
      return controller.pendingPermissions;
    },
    get sessions() {
      return controller.sessions;
    },
    get sessionMetadata() {
      return controller.sessionMetadata;
    },
    get compactionRecordWatermark() {
      return controller.compactionRecordWatermark;
    },
    get compactingSessions() {
      return controller.compactingSessions;
    },
    get compactionStartedAt() {
      return controller.compactionStartedAt;
    },
    get compactionRecordBaseline() {
      return controller.compactionRecordBaseline;
    },
    get cancellationWatermarks() {
      return controller.cancellationWatermarks;
    },
    recordLiveEvidence: (sessionId) => controller.recordLiveEvidence(sessionId),
    advanceRunRevision: (sessionId) => controller.advanceRunRevision(sessionId),
    get workingPhaseSessions() {
      return controller.workingPhaseSessions;
    },
    get runtimeIdleSessions() {
      return controller.runtimeIdleSessions;
    },
    readPersistedTranscript: (sessionId) => controller.readPersistedTranscript(sessionId),
    get liveRunningSessions() {
      return controller.liveRunningSessions;
    },
    rememberLiveRunningTranscriptSize: (sessionId) => controller.rememberLiveRunningTranscriptSize(sessionId),
    get activePromptSessions() {
      return controller.activePromptSessions;
    },
    get transcriptRunningSessions() {
      return controller.transcriptRunningSessions;
    },
    get pendingAsyncWorkSessions() {
      return controller.pendingAsyncWorkSessions;
    },
    clearRunningLatches: (sessionId) => controller.clearRunningLatches(sessionId),
    get cancellingSessions() {
      return controller.cancellingSessions;
    },
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
    this.completionDeferredSessions.clear();
    this.asyncJobReconciliations.clear();
    this.discoveredRunStates.clear();
    this.idleTranscriptBaselines.clear();
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

  private discoverSessions(): Promise<AgentSession[]> {
    return discoverSessions(this.discoveryHost);
  }

  private readonly routeProbes = new Map<string, { at: number; reachable: boolean }>();

  private liveRouteReachable(row: SdkSessionRow): Promise<boolean> {
    return liveRouteReachable(this.discoveryHost, row);
  }

  private readonly runStateWatchers = new Map<string, FSWatcher>();
  private readonly runStateTimers = new Map<string, NodeJS.Timeout>();

  private syncRunStateWatchers(sessionIds: readonly string[]): Promise<void> {
    return syncRunStateWatchers(this.runStateHost, sessionIds);
  }

  private republishRunState(sessionId: string): Promise<void> {
    return republishRunState(this.runStateHost, sessionId);
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
    return sessionParentId(this.discoveryHost, sessionId);
  }

  private discoveredRunState(
    sessionId: string,
  ): Promise<AgentSession["status"] | undefined> {
    return discoveredRunState(this.runStateHost, sessionId);
  }

  private transcriptStartedNewWork(
    sessionId: string,
    size: number,
    transcriptRunning: boolean,
  ): boolean {
    return transcriptStartedNewWork(this.runStateHost, sessionId, size, transcriptRunning);
  }

  private recordLiveEvidence(sessionId: string): void {
    return recordLiveEvidence(this.runStateHost, sessionId);
  }

  private liveEvidenceQuiet(sessionId: string): boolean {
    return liveEvidenceQuiet(this.runStateHost, sessionId);
  }

  private clearRunningLatches(sessionId: string): void {
    return clearRunningLatches(this.runStateHost, sessionId);
  }

  private settleQuietRunningRow(
    sessionId: string,
    transcriptStatus: AgentSession["status"] | undefined,
    currentSession: AgentSession | undefined,
  ): boolean {
    return settleQuietRunningRow(this.runStateHost, sessionId, transcriptStatus, currentSession);
  }

  private recordPendingAsyncWork(
    sessionId: string,
    jobIds: readonly string[],
  ): void {
    return recordPendingAsyncWork(this.runStateHost, sessionId, jobIds);
  }

  private reconciledAsyncJobIds(
    sessionId: string,
    jobIds: readonly string[],
  ): Promise<string[]> {
    return reconciledAsyncJobIds(this.runStateHost, sessionId, jobIds);
  }

  private brokerSessions(options?: {
    scope?: "repo" | "cwd" | "worktree" | "all";
    initialDiscovery?: boolean;
  }): Promise<SdkSessionRow[] | undefined> {
    return brokerSessions(this.discoveryHost, options);
  }

  private invalidateBrokerIndexCache(): void {
    return invalidateBrokerIndexCache(this.discoveryHost);
  }

  private brokerIndexRevision(): Promise<string | undefined> {
    return brokerIndexRevision();
  }

  private noteBrokerIndex(
    rows: readonly SdkSessionRow[],
    before: string | undefined,
    after: string | undefined,
  ): void {
    return noteBrokerIndex(this.discoveryHost, rows, before, after);
  }

  createSession(input: CreateSessionInput): Promise<AgentSession> {
    return createSession(this.lifecycleHost, input);
  }

  renameSession(sessionId: string, title: string): Promise<void> {
    return renameSession(this.lifecycleHost, sessionId, title);
  }

  private readonly transcriptAttachments = new Map<string, Promise<void>>();

  private refreshTranscriptAttachment(sessionId: string): void {
    return refreshTranscriptAttachment(this.attachHost, sessionId);
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
    // The palette asks for this whenever it opens. A session opened a moment ago
    // has already paid for these CLI reads, and repeating them made every reopen
    // spawn another pair of processes before the same palette could render.
    const inFlight = this.sessionContextRefreshes.get(sessionId);
    if (inFlight) return inFlight;
    const refreshedAt = this.sessionContextRefreshedAt.get(sessionId);
    if (
      refreshedAt !== undefined &&
      Date.now() - refreshedAt < SESSION_CONTEXT_REFRESH_TTL_MS
    )
      return;
    const refresh = (async () => {
      await Promise.all([
        this.refreshSdkCommands(sessionId),
        this.readTodoRecords(sessionId),
      ]);
      this.sessionContextRefreshedAt.set(sessionId, Date.now());
    })().finally(() => {
      if (this.sessionContextRefreshes.get(sessionId) === refresh)
        this.sessionContextRefreshes.delete(sessionId);
    });
    this.sessionContextRefreshes.set(sessionId, refresh);
    return refresh;
  }

  private publishSessionCommands(
    sessionId: string,
    commands: readonly AgentCommand[],
  ): void {
    return publishSessionCommands(this.commandPaletteHost, sessionId, commands);
  }

  watchTranscripts(sessionIds: readonly string[]): void {
    return watchTranscripts(this.transcriptStoreHost, sessionIds);
  }

  private scheduleDetach(sessionId: string): void {
    return scheduleDetach(this.attachHost, sessionId);
  }

  getTranscript(sessionId: string): Promise<TranscriptItem[]> {
    return getTranscript(this.transcriptStoreHost, sessionId);
  }

  getTranscriptPage(
    sessionId: string,
    request?: TranscriptPageRequest,
  ): Promise<TranscriptPage> {
    return getTranscriptPage(this.transcriptStoreHost, sessionId, request);
  }

  getTranscriptChanges(sessionId: string): Promise<TranscriptChange> {
    return getTranscriptChanges(this.transcriptStoreHost, sessionId);
  }

  private reindexToolRows(
    sessionId: string,
    items: readonly TranscriptItem[],
  ): void {
    return reindexToolRows(this.transcriptStoreHost, sessionId, items);
  }

  private markTranscriptRowDirty(sessionId: string, rowId: string): void {
    return markTranscriptRowDirty(this.transcriptStoreHost, sessionId, rowId);
  }

  private invalidateDesktopTranscript(sessionId: string): void {
    return invalidateDesktopTranscript(this.transcriptStoreHost, sessionId);
  }

  getTranscriptRevision(sessionId: string): Promise<string | undefined> {
    return getTranscriptRevision(this.transcriptStoreHost, sessionId);
  }

  private noteTranscriptEpoch(sessionId: string): void {
    return noteTranscriptEpoch(this.transcriptStoreHost, sessionId);
  }

  private readSharedTranscript(
    sessionId: string,
  ): Promise<TranscriptItem[]> {
    return readSharedTranscript(this.transcriptStoreHost, sessionId);
  }

  private readTranscriptEnvelopes(
    filePath: string,
    info: Stats,
  ): Promise<Record<string, unknown>[]> {
    return readTranscriptEnvelopes(this.filesHost, filePath, info);
  }

  private readPersistedTranscript(
    sessionId: string,
  ): Promise<TranscriptItem[] | undefined> {
    return readPersistedTranscript(this.transcriptStoreHost, sessionId);
  }

  private watchSharedTranscript(sessionId: string, filePath: string): void {
    return watchSharedTranscript(this.transcriptStoreHost, sessionId, filePath);
  }

  private publishTranscriptSync(
    sessionId: string,
    previous: TranscriptItem[] | undefined,
    items: TranscriptItem[],
  ): void {
    return publishTranscriptSync(this.transcriptStoreHost, sessionId, previous, items);
  }

  private resolveToolImages(items: TranscriptItem[]): Promise<void> {
    return resolveToolImages(this.transcriptStoreHost, items);
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

  setSessionConfig(
    sessionId: string,
    configId: string,
    value: string,
  ): Promise<void> {
    return setSessionConfig(this.sessionConfigHost, sessionId, configId, value);
  }

  cycleThinking(sessionId: string): Promise<string | undefined> {
    return cycleThinking(this.sessionConfigHost, sessionId);
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

  private rememberLiveRunningTranscriptSize(
    sessionId: string,
  ): Promise<void> {
    return rememberLiveRunningTranscriptSize(this.transcriptStoreHost, sessionId);
  }

  private persistedCompactionCount(
    sessionId: string,
  ): Promise<number | undefined> {
    return persistedCompactionCount(this.transcriptStoreHost, sessionId);
  }

  compactSession(sessionId: string): Promise<void> {
    return compactSession(this.controlHost, sessionId);
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

  private consumePromptEcho(sessionId: string, text: string): boolean {
    return consumePromptEcho(this.controlHost, sessionId, text);
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
    return steerSession(this.controlHost, sessionId, input, options);
  }

  queueFollowUp(
    sessionId: string,
    input: ResolvedMessageInput,
  ): Promise<MessageDelivery> {
    return queueFollowUp(this.controlHost, sessionId, input);
  }

  private controlSession(
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
  ): Promise<Record<string, unknown> | undefined> {
    return controlSession(this.controlHost, sessionId, operation, input, options);
  }

  listQueuedMessages(sessionId: string): Promise<QueuedMessage[]> {
    return listQueuedMessages(this.controlHost, sessionId);
  }

  flushQueuedNow(sessionId: string): Promise<boolean> {
    return flushQueuedNow(this.controlHost, sessionId);
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

  private executeSdkSlashCommand(
    sessionId: string,
    input: ResolvedMessageInput,
    options?: SendMessageOptions,
  ): Promise<boolean> {
    return executeSdkSlashCommand(
      {
        workspace: this.workspace,
        sessions: this.sessions,
        sessionCwds: this.sessionCwds,
        sessionMetadata: this.sessionMetadata,
        emitEvent: (event) => this.emitEvent(event),
        sdkOperations: (id) => this.sdkOperations(id),
        appendSdkCommandOutput: (id, content) => this.appendSdkCommandOutput(id, content),
        querySessionItems: (id, query, queryInput, queryOptions) =>
          this.querySessionItems(id, query, queryInput, queryOptions),
        controlSession: (id, operation, controlInput, controlOptions) =>
          this.controlSession(id, operation, controlInput, controlOptions),
        deleteSession: (id) => this.deleteSession(id),
        sessionConfigRow: (id) => this.sessionConfigRow(id),
        patchSessionRuntime: (id, patch) => this.patchSessionRuntime(id, patch),
        refreshSdkCommands: (id) => this.refreshSdkCommands(id),
        refreshSessionConfigOptions: (id) => this.refreshSessionConfigOptions(id),
        compactSession: (id) => this.compactSession(id),
        renameSession: (id, title) => this.renameSession(id, title),
      },
      sessionId,
      input,
      options,
    );
  }

  sendMessage(
    sessionId: string,
    input: ResolvedMessageInput,
    options?: SendMessageOptions,
  ): Promise<MessageDelivery> {
    return sendMessage(this.controlHost, sessionId, input, options);
  }

  private awaitPromptSettlement(
    sessionId: string,
    operationRef: string,
    isCurrent?: () => boolean,
  ): Promise<
    | "terminal"
    | "unknown"
    | { kind: "not_executed"; detail: string }
  > {
    return awaitPromptSettlement(this.controlHost, sessionId, operationRef, isCurrent);
  }

  cancelRun(sessionId: string): Promise<void> {
    return cancelRun(this.controlHost, sessionId);
  }

  private fireAbort(
    sessionId: string,
  ): Promise<"owned" | "plain" | "no_active_turn"> {
    return fireAbort(this.controlHost, sessionId);
  }

  private appendCancelledNotice(
    sessionId: string,
    ownedWorkUnconfirmed = false,
  ): void {
    return appendCancelledNotice(this.controlHost, sessionId, ownedWorkUnconfirmed);
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

  /**
   * Pending and rejected ask cards for one session.
   *
   * `workflow.gates.list` is the source of truth. The stdio `workflow_gate`
   * event only wakes this read.
   */
  async listPendingQuestions(sessionId: string): Promise<QuestionActivity[]> {
    await this.refreshWorkflowQuestions(sessionId);
    return [...(this.sessionQuestions.get(sessionId)?.values() ?? [])].filter(
      (question) =>
        question.answerable &&
        (question.status === "pending" || question.status === "rejected"),
    );
  }

  /**
   * Answers one ask gate through `workflow.gate_answer`.
   *
   * The first submission for a gate wins. A second caller waits for that
   * attempt and then sees the settled card, so a desktop click and a remote
   * click cannot both commit. A `rejected` resolution stays on the card.
   */
  answerQuestion(
    sessionId: string,
    gateId: string,
    submission: QuestionSubmission,
    idempotencyKey: string,
  ): Promise<void> {
    const key = this.questionKey(sessionId, gateId);
    const inflight = this.questionAnswers.get(key);
    if (inflight) return inflight;
    const run = this.submitQuestionAnswer(
      sessionId,
      gateId,
      submission,
      idempotencyKey,
    );
    this.questionAnswers.set(key, run);
    return run.finally(() => {
      if (this.questionAnswers.get(key) === run) this.questionAnswers.delete(key);
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

  readArtifact(
    sessionId: string,
    artifactId: string,
  ): Promise<ArtifactContent> {
    return readArtifact(this.filesHost, sessionId, artifactId);
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
    return previewFile(this.filesHost, sessionId, requestedPath);
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

  private refreshSdkCommands(
    sessionId: string,
    advertised?: AgentCommand[],
  ): Promise<void> {
    return refreshSdkCommands(this.commandPaletteHost, sessionId, advertised);
  }

  private clearCommandRefreshRetry(sessionId: string): void {
    return clearCommandRefreshRetry(this.commandPaletteHost, sessionId);
  }

  private sdkOperations(
    sessionId: string,
    options?: { strict?: boolean },
  ): Promise<Set<string>> {
    return sdkOperations(this.commandPaletteHost, sessionId, options);
  }

  getGoal(sessionId: string): Promise<GoalSnapshot> {
    return getGoal(this.goalTodoHost, sessionId);
  }

  private requestProgressRefresh(sessionId: string): void {
    return requestProgressRefresh(this.goalTodoHost, sessionId);
  }

  private clearProgress(sessionId: string): void {
    return clearProgress(this.goalTodoHost, sessionId);
  }

  operateGoal(
    sessionId: string,
    operation: GoalOperation,
  ): Promise<GoalSnapshot> {
    return operateGoal(this.goalTodoHost, sessionId, operation);
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
    this.desktopTranscriptBaselines.clear();
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

  hideSession(sessionId: string): void {
    return hideSession(this.lifecycleHost, sessionId);
  }

  deleteSession(sessionId: string): Promise<void> {
    return deleteSession(this.lifecycleHost, sessionId);
  }

  private removeSessionArtifacts(sessionId: string): Promise<void> {
    return removeSessionArtifacts(this.filesHost, sessionId);
  }

  private locateSharedTranscriptFile(
    sessionId: string,
  ): Promise<string | undefined> {
    return locateSharedTranscriptFile(this.filesHost, sessionId);
  }

  private removeLocalSession(sessionId: string, hide: boolean): void {
    return removeLocalSession(this.lifecycleHost, sessionId, hide);
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
    for (const timer of this.progressTimers.values()) clearTimeout(timer);
    this.progressTimers.clear();
    this.sessionProgress.clear();
    this.progressReads.clear();
    this.progressWatchedAt.clear();
    this.publishedCommandKeys.clear();
    this.transcriptAttachments.clear();
    this.permissionModeApplied.clear();
    this.windowHostedSessions.clear();
    this.tailReads.clear();
    this.tailCheckpoints.clear();
    this.tailEventPositions.clear();
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
    this.historySummaryCache.clear();
    for (const timer of this.detachTimers.values()) clearTimeout(timer);
    this.detachTimers.clear();
    this.watchedTranscripts = undefined;
    this.transcripts.clear();
    this.toolRowIndices.clear();
    this.dirtyTranscriptRows.clear();
    this.desktopTranscriptBaselines.clear();
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
    this.completionDeferredSessions.clear();
    this.asyncJobReconciliations.clear();
    this.runRevisions.clear();
    this.transcriptEpoch.clear();
    this.discoveredRunStates.clear();
    this.idleTranscriptBaselines.clear();
    this.compactingSessions.clear();
    this.compactionRecordBaseline.clear();
    this.compactionRecordWatermark.clear();
    this.compactionStartedAt.clear();
    this.suppressedUserMessageKeys.clear();
    this.echoedPromptTexts.clear();
    this.sessionCommands.clear();
    this.commandRefreshes.clear();
    this.sessionContextRefreshes.clear();
    this.sessionContextRefreshedAt.clear();
    this.sessionAdvertisedCommands.clear();
    this.sessionDiscoveredCommands.clear();
    this.sessionPlans.clear();
    this.sessionQuestions.clear();
    this.acceptedQuestions.clear();
    this.observedQuestions.clear();
    this.questionRefreshes.clear();
    this.questionAnswers.clear();
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
    this.contextUsageObservedAt.clear();
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

  private recoverOwnedSessions(): Promise<void> {
    return recoverOwnedSessions(this.attachHost);
  }

  private async resolveExecutable(): Promise<string> {
    return (await resolveGjcExecutable(this.configuredExecutable)) ?? "gjc";
  }

  listHistorySessions(): Promise<HistorySession[]> {
    return listHistorySessions(this.attachHost);
  }

  openHistorySession(sessionId: string): Promise<AgentSession> {
    return openHistorySession(this.attachHost, sessionId);
  }

  resumeSession(sessionId: string): Promise<AgentSession> {
    return resumeSession(this.attachHost, sessionId);
  }

  private ensureAttached(
    sessionId: string,
    replay: boolean,
  ): Promise<void> {
    return ensureAttached(this.attachHost, sessionId, replay);
  }

  private startTailFollower(sessionId: string): void {
    return startTailFollower(this.streamHost, sessionId);
  }

  private stopTailFollower(sessionId: string): void {
    return stopTailFollower(this.streamHost, sessionId);
  }

  private startToolObserver(sessionId: string): void {
    return startToolObserver(this.streamHost, sessionId);
  }

  private questionKey(sessionId: string, gateId: string): string {
    return questionKey(sessionId, gateId);
  }

  private questionById(
    sessionId: string,
    gateId: string,
  ): QuestionActivity | undefined {
    return questionById(this.questionHost, sessionId, gateId);
  }

  private hasAnswerableQuestion(sessionId: string): boolean {
    return hasAnswerableQuestion(this.questionHost, sessionId);
  }

  private refreshWorkflowQuestions(sessionId: string): Promise<void> {
    return refreshWorkflowQuestions(this.questionHost, sessionId);
  }

  private settleOpenQuestions(
    sessionId: string,
    status: "cancelled" | "timeout",
  ): void {
    return settleOpenQuestions(this.questionHost, sessionId, status);
  }

  private projectWorkflowGate(
    sessionId: string,
    payload: Record<string, unknown>,
  ): void {
    return projectWorkflowGate(this.questionHost, sessionId, payload);
  }

  private submitQuestionAnswer(
    sessionId: string,
    gateId: string,
    submission: QuestionSubmission,
    idempotencyKey: string,
  ): Promise<void> {
    return submitQuestionAnswer(this.questionHost, sessionId, gateId, submission, idempotencyKey);
  }

  private projectToolStream(sessionId: string, kind: string, payload: Record<string, unknown>): void {
    return projectToolStream(this.streamHost, sessionId, kind, payload);
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
    return projectTailItems(this.streamHost, sessionId, items);
  }

  private refreshTranscriptFromFile(sessionId: string): Promise<void> {
    return refreshTranscriptFromFile(this.transcriptStoreHost, sessionId);
  }

  private reconcileTailTerminalState(sessionId: string): Promise<void> {
    return reconcileTailTerminalState(this.streamHost, sessionId);
  }

  private handleSessionUpdate(notification: SessionNotification): void {
    return handleSessionUpdate(this.streamHost, notification);
  }

  private projectThoughtChunk(
    sessionId: string,
    update: Extract<SessionUpdate, { sessionUpdate: "agent_thought_chunk" }>,
  ): void {
    return projectThoughtChunk(this.streamHost, sessionId, update);
  }

  private finalizeThought(sessionId: string): void {
    return finalizeThought(this.streamHost, sessionId);
  }

  private installTranscript(
    sessionId: string,
    items: TranscriptItem[],
  ): TranscriptItem[] {
    return installTranscript(this.transcriptStoreHost, sessionId, items);
  }

  private clearTodoPoll(sessionId: string): void {
    return clearTodoPoll(this.goalTodoHost, sessionId);
  }

  private readTodoRecords(
    sessionId: string,
  ): Promise<unknown[] | undefined> {
    return readTodoRecords(this.goalTodoHost, sessionId);
  }

  private captureSessionState(
    sessionId: string,
    options: SessionConfigOption[],
    mode?: string | null,
  ): void {
    return captureSessionState(this.sessionConfigHost, sessionId, options, mode);
  }

  private refreshSessionConfigOptions(sessionId: string): Promise<void> {
    return refreshSessionConfigOptions(this.sessionConfigHost, sessionId);
  }

  private sessionConfigRow(
    sessionId: string,
  ): Promise<Record<string, unknown> | undefined> {
    return sessionConfigRow(this.sessionConfigHost, sessionId);
  }

  private refreshSessionSettings(sessionId: string): Promise<void> {
    return refreshSessionSettings(this.sessionConfigHost, sessionId);
  }

  private refreshModelCapabilities(sessionId: string): Promise<void> {
    return refreshModelCapabilities(this.sessionConfigHost, sessionId);
  }

  private refreshContextUsage(
    sessionId: string,
    options?: { force?: boolean },
  ): Promise<void> {
    return refreshContextUsage(this.sessionConfigHost, sessionId, options);
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
    return patchSessionRuntime(this.sessionConfigHost, sessionId, patch);
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
      this.noteTranscriptEpoch(sessionId);
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
    return upsertTool(this.streamHost, sessionId, update);
  }

  private persistArtifact(
    sessionId: string,
    artifactId: string,
    value: unknown,
  ): Promise<void> {
    return persistArtifact(this.filesHost, sessionId, artifactId, value);
  }

  private patchTool(toolId: string, patch: Partial<ToolActivity>): void {
    return patchTool(this.streamHost, toolId, patch);
  }

  private patchSessionInfo(
    sessionId: string,
    update: Extract<SessionUpdate, { sessionUpdate: "session_info_update" }>,
  ): void {
    return patchSessionInfo(this.streamHost, sessionId, update);
  }

  forkSession(input: {
    sourceSessionId: string;
    title?: string;
  }): Promise<AgentSession> {
    return forkSession(this.lifecycleHost, input);
  }

  private recoverForkedSession(
    cwd: string,
    knownSessionIds: ReadonlySet<string>,
    startedAt: number,
  ): Promise<string | undefined> {
    return recoverForkedSession(this.lifecycleHost, cwd, knownSessionIds, startedAt);
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

  private appendTranscript(item: TranscriptItem): void {
    const items = this.transcripts.get(item.sessionId) ?? [];
    items.push(item);
    this.transcripts.set(item.sessionId, items);
    if (item.kind === "tool") {
      let indices = this.toolRowIndices.get(item.sessionId);
      if (!indices) {
        indices = new Map();
        this.toolRowIndices.set(item.sessionId, indices);
      }
      indices.set(item.id, items.length - 1);
    }
    this.noteTranscriptEpoch(item.sessionId);
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
      this.noteTranscriptEpoch(sessionId);
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
    let changed = false;
    for (const item of items) {
      if (item.kind !== "message" || !item.streaming) continue;
      item.streaming = false;
      changed = true;
      this.emitEvent({
        type: "message.delta",
        sessionId,
        messageId: item.id,
        delta: "",
        streaming: false,
      });
    }
    if (changed) this.noteTranscriptEpoch(sessionId);
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
    // An ask gate is still waiting on a person. Idle and running reports keep
    // arriving from the tail while that is true; the sidebar stays on waiting
    // until the card settles. A failure and a cancel still win.
    if (
      this.hasAnswerableQuestion(sessionId) &&
      !this.cancellingSessions.has(sessionId) &&
      !this.locallyAbortedSessions.has(sessionId) &&
      status !== "failed" &&
      (status === "running" || status === "idle")
    )
      status = "waiting";
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
    const previous = session?.status ?? "running";
    const owesCompletion =
      previous === "running" ||
      (previous === "unknown" &&
        this.completionDeferredSessions.has(sessionId));
    if (status === "unknown" && previous === "running")
      this.completionDeferredSessions.add(sessionId);
    else if (status !== "unknown")
      this.completionDeferredSessions.delete(sessionId);
    // Unknown is not a finish. A later idle verdict is the one completion notice
    // for the running turn whose job list could not be read.
    const finishedTurn =
      options?.announce !== false &&
      status === "idle" &&
      owesCompletion &&
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
