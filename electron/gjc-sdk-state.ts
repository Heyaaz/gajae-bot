import type { FSWatcher } from "node:fs";
import type { AgentSession, AgentCommand, AgentConfigOption, AgentConfigOptionValue, MessageDelivery, PlanActivity, QuestionActivity, ToolActivity, TranscriptItem, SessionProgress } from "../shared/agent-contract.js";
import { ImageDataUrlCache } from "./image-data-cache.js";
import type { GjcSdkCli, SdkSessionRow } from "./gjc-sdk-cli.js";
import type { PendingPermission, TodoSnapshotState, historySessionSummary } from "./gjc-sdk-foundation.js";
import { WorkspaceFileLister } from "./workspace-files.js";

/**
 * The in-memory registries the controller and its feature modules share.
 *
 * Every map is keyed by session id. Feature modules reach them through the
 * controller's host object, so a field is declared here once and read wherever
 * its feature lives.
 */
export abstract class GjcSdkState {
  protected modelPresetThinking?: string;
  protected readonly sessions = new Map<string, AgentSession>();
  protected readonly sessionCwds = new Map<string, string>();
  protected readonly workspaceFiles = new WorkspaceFileLister();
  protected readonly attachedSessions = new Set<string>();
  /**
   * Sessions the renderer is showing or keeping in its transcript cache.
   *
   * `undefined` means no window has reported a cache yet; an old renderer or a
   * remote-only host must not have every attached session released because nobody
   * told this process what is visible.
   */
  protected watchedTranscripts: Set<string> | undefined;
  protected readonly detachTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  protected readonly transcripts = new Map<string, TranscriptItem[]>();
  /** Tool id → row index, rebuilt whenever the transcript array is replaced. */
  protected readonly toolRowIndices = new Map<string, Map<string, number>>();
  /** Rows mutated live that a later durable rescan must compare even when old. */
  protected readonly dirtyTranscriptRows = new Map<string, Set<string>>();
  protected readonly desktopTranscriptBaselines = new Map<string, TranscriptItem[]>();
  protected readonly messageKeys = new Map<string, Map<string, string>>();
  protected readonly activeAssistantMessages = new Map<string, string>();
  protected readonly activeThoughts = new Map<string, string>();
  protected readonly activePromptSessions = new Set<string>();
  protected readonly activePromptAdmissions = new Map<string, symbol>();
  protected readonly cancellationWatermarks = new Map<string, number>();
  protected readonly cancellingSessions = new Set<string>();
  protected readonly cancellationPromises = new Map<string, Promise<void>>();
  protected readonly flushingSessions = new Set<string>();
  protected readonly pendingSteers = new Map<string, Promise<MessageDelivery>>();
  protected readonly suppressedUserMessageKeys = new Map<string, Set<string>>();
  // A prompt renders its own user bubble immediately so an ordinary chat message
  // appears without waiting for the agent round trip. GJC echoes the same prompt
  // back as a user update, so the first echo of each text is dropped.
  protected readonly echoedPromptTexts = new Map<string, string[]>();
  protected readonly locallyAbortedSessions = new Set<string>();
  /** Compaction is finished only when GJC says so, never when the request returns. */
  protected readonly compactingSessions = new Set<string>();
  // How many compaction records the transcript held when compaction started. A
  // terminal-owned session never receives session_info_update, so the live signal
  // cannot release the phase for it; a new record appearing is the evidence that
  // GJC finished. Without this the indicator stayed up for the rest of the session.
  protected readonly compactionRecordBaseline = new Map<string, number>();
  // Latest durable compaction record timestamp observed for each session. Live
  // phase updates at or before this watermark are delayed stale delivery.
  protected readonly compactionRecordWatermark = new Map<string, number>();
  // Timestamped compacting phases start a distinct cycle. A durable record older
  // than this boundary belongs to the preceding cycle and cannot finish this one.
  protected readonly compactionStartedAt = new Map<string, number>();
  // Sessions live SDK evidence currently reports as working. The persisted
  // transcript lags behind that signal, so it is not allowed to report one of
  // these idle until GJC itself says the turn ended.
  protected readonly liveRunningSessions = new Set<string>();
  // Transcript size at the moment the live signal reported work, keyed by session.
  // Anything at that size is the snapshot the signal already superseded; a larger
  // file is a newer account.
  protected readonly liveRunningDigests = new Map<string, number>();
  // When the newest live work signal for a session was accepted, keyed by session.
  // Every latch below is armed by a report and released by a report, so a session
  // whose reports stop has nothing left to age it out -- one held a finished row in
  // the working group for 16 hours. This is that clock: in-memory, one number per
  // session that ever reported work, consulted only when a transcript verdict
  // already disagrees with the row.
  protected readonly liveEvidenceAt = new Map<string, number>();
  /**
   * Sessions whose running state was read out of their transcript.
   *
   * Attaching to a session makes GJC publish a bootstrap `gjcRunning:false` about
   * this connection's own prompt state. For a session another process is driving that
   * report is uninformative, and taking it as a completion flipped the row to 완료 the
   * moment it was clicked. Remembering where the running state came from is what
   * tells that report apart from a real one.
   */
  protected readonly transcriptRunningSessions = new Set<string>();
  /**
   * Sessions whose current work cycle GJC confirmed with a non-idle phase.
   *
   * The marker survives runtime idle until the transcript confirms the final assistant
   * row. The phase is the only signal that separates a turn waiting on a tool result
   * from one that ended, because `gjcRunning:false` also describes this connection's
   * idle prompt slot while a steer drives the actual work.
   */
  protected readonly workingPhaseSessions = new Set<string>();
  /**
   * Sessions whose runtime has reported a real idle transition after a working phase.
   *
   * Neither side closes a cycle alone. Runtime idle can arrive while the model is
   * still responding after a tool, and the transcript can contain a `stop` row before
   * more tool calls are appended. A session that emitted a working phase settles only
   * after this marker and a terminal transcript agree.
   */
  protected readonly runtimeIdleSessions = new Set<string>();
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
  protected readonly pendingAsyncWorkSessions = new Map<string, string[]>();
  /**
   * Sessions whose running -> idle completion was withheld because the background
   * job list could not be read. One later idle verdict announces that finish once.
   */
  protected readonly completionDeferredSessions = new Set<string>();
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
  protected readonly asyncJobReconciliations = new Map<
    string,
    {
      checkedAt: number;
      deadJobIds: Set<string>;
      checkedJobIds: Set<string>;
      querySucceeded: boolean;
    }
  >();
  /** Monotonic per-session lifecycle generation for async status reads and IPC merges. */
  protected readonly runRevisions = new Map<string, number>();
  /**
   * Bumps when this process changes a transcript the file has not recorded yet:
   * a streamed row, a plan, a todo snapshot. The file stat cannot see those, so
   * the safety-net revision includes this counter.
   */
  protected readonly transcriptEpoch = new Map<string, number>();
  /**
   * Transcript-derived run state per session, keyed by the file size it was read at.
   *
   * `runningJobIds` records the launch markers the verdict at that size rests on,
   * so a size-unchanged read can still notice that the job behind them ended.
   */
  /** The transcript size an idle row settled at, per run revision. */
  protected readonly idleTranscriptBaselines = new Map<
    string,
    { revision: number; size: number }
  >();
  protected readonly discoveredRunStates = new Map<
    string,
    { size: number; status: AgentSession["status"]; runningJobIds?: string[] }
  >();
  /** Delay between broker polls while recovering a fork's session id. */
  protected forkRecoveryIntervalMs = 250;
  protected readonly sessionCommands = new Map<string, AgentCommand[]>();
  /** Last command palette actually handed to the renderer, so an identical reopen is silent. */
  protected readonly publishedCommandKeys = new Map<string, string>();
  protected readonly commandRefreshTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  protected readonly commandRefreshAttempts = new Map<string, number>();
  /** In-flight command palette rebuild per session, shared by concurrent callers. */
  protected readonly commandRefreshes = new Map<string, Promise<void>>();
  protected readonly sessionContextRefreshes = new Map<string, Promise<void>>();
  protected readonly sessionContextRefreshedAt = new Map<string, number>();
  /** Long todo reads used only while a session has no live todo event channel. */
  protected readonly todoPollTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  protected readonly todoPollAttempts = new Map<string, number>();
  /**
   * Commands the runtime itself advertised (`available_commands_update`).
   *
   * This is the authoritative set and is replaced wholesale on every event, so a
   * command the runtime withdraws disappears from the palette. It is kept apart
   * from the merged cache because that cache is also fed by this window's adapter
   * specs and by runtime state discovery, and neither of those may speak for GJC.
   */
  protected readonly sessionAdvertisedCommands = new Map<string, AgentCommand[]>();
  /**
   * Dynamic commands discovered from runtime state on attach/create rather than
   * from an `available_commands_update`. Replaced wholesale by each discovery pass.
   */
  protected readonly sessionDiscoveredCommands = new Map<string, AgentCommand[]>();
  protected readonly sessionSdkOperations = new Map<string, Set<string>>();
  protected readonly sessionConfig = new Map<string, AgentConfigOption[]>();
  /**
   * The last plan the runtime reported for a session.
   *
   * `sessionUpdate=plan` is the only plan source, and the durable session file does
   * not record plans. A rescan therefore replaced the transcript array with file
   * rows and the plan of a session that was still running it disappeared, so the
   * row is retained here and composed back into every install of that transcript.
   */
  protected readonly sessionPlans = new Map<string, PlanActivity>();
  /** Ask questions projected from `workflow.gates.list` and `workflow_gate`. */
  protected readonly sessionQuestions = new Map<string, Map<string, QuestionActivity>>();
  /** Gates this window already accepted, so a stale pending row cannot reopen them. */
  protected readonly acceptedQuestions = new Set<string>();
  /**
   * A gate event that has not yet been confirmed by the list.
   *
   * The list is the source of truth, but the event can arrive one read ahead of
   * it. The first empty read keeps the card; the next one settles it.
   */
  protected readonly observedQuestions = new Set<string>();
  protected readonly questionRefreshes = new Map<string, Promise<void>>();
  protected readonly questionAnswers = new Map<string, Promise<void>>();
  /** The runtime's todo store as this window last observed it, per session. */
  protected readonly sessionTodoSnapshots = new Map<string, TodoSnapshotState>();
  /** Last `session.progress` read; a failed read keeps the previous snapshot. */
  protected readonly sessionProgress = new Map<
    string,
    { progress: SessionProgress | undefined; readAt: number }
  >();
  protected readonly progressReads = new Map<string, Promise<void>>();
  /** When a goal row last asked for each session's progress. */
  protected readonly progressWatchedAt = new Map<string, number>();
  protected readonly progressTimers = new Map<
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
  protected readonly todoReads = new Map<string, Promise<unknown[] | undefined>>();
  protected readonly terminalOnlySessions = new Set<string>();
  protected readonly modelProfiles = new Map<string, AgentConfigOptionValue[]>();
  protected readonly explicitSessionThinking = new Map<string, string>();
  protected readonly pendingPermissions = new Map<string, PendingPermission>();
  protected readonly artifactWrites = new Map<string, Promise<void>>();
  protected readonly artifactSessionIds = new Map<string, Set<string>>();
  protected readonly deletingSessions = new Set<string>();
  protected readonly deletionPromises = new Map<string, Promise<void>>();
  protected readonly sharedSessionFiles = new Map<string, string>();
  // A transcript is append-only, so a rescan only has to parse the bytes added
  // since the last one. Device/inode identify the file so a compaction that
  // rewrites or truncates it is detected and falls back to a full parse.
  //
  // Every entry retains the file's parsed envelopes, so the map is held to the
  // transcripts actually being re-read. Measured at 6.3MB per entry, an unbounded
  // map reached 372MB across 60 transcripts and would pass 2GB across the 400 on
  // this machine. Insertion order makes it an LRU: the oldest key is evicted first.
  protected readonly sharedTranscriptReads = new Map<
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
  protected readonly sharedSessionWatchers = new Map<string, FSWatcher>();
  protected readonly sharedSessionRefreshTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  protected readonly imageDataUrls = new ImageDataUrlCache();
  protected readonly attachAttempts = new Map<string, number>();
  protected readonly contextUsageQueries = new Map<string, Promise<void>>();
  /** Last usage observation (query or live event) used to pace watcher repairs. */
  protected readonly contextUsageObservedAt = new Map<string, number>();
  /**
   * The `gjc sdk session` client.
   *
   * There is no resident agent process and no connection object: each call is its
   * own short-lived CLI invocation. `readiness` only memoises resolving the
   * executable and reading the broker index once per start, so the window can
   * report a real state instead of pretending to be connected.
   */
  protected cli?: GjcSdkCli;
  protected startup?: Promise<void>;
  protected disposed = false;
  protected nextLocalId = 1;
  protected generation = 0;
  protected recovery?: Promise<void>;
  /** Sessions whose permission mode has been applied for this runtime generation. */
  protected readonly permissionModeApplied = new Set<string>();
  /** Live tail catch-up reads in flight, keyed by session. */
  protected readonly tailReads = new Map<string, Promise<void>>();
  /** Abort handles for the short-lived tail CLI child currently reading a session. */
  protected readonly tailControllers = new Map<string, AbortController>();
  /** Latest tail checkpoint claim per session, so a re-read resumes rather than rewinds. */
  /**
   * Where each session's tail resumes. gjc/0.18.12 refuses a live `--cursor`
   * without the transcript row it stopped at (`usage`), so the two travel together.
   */
  protected readonly tailCheckpoints = new Map<
    string,
    { cursor: string; afterTranscriptId: string }
  >();
  /** Last sequence observed from a tail, used to distinguish catch-up from new work. */
  protected readonly tailEventPositions = new Map<
    string,
    { generation: number; seq: number }
  >();
  /** Sessions this window resumed, and therefore may close before deleting. */
  protected readonly windowHostedSessions = new Set<string>();
  /** Public observer connections that replace tool output with the newest snapshot. */
  protected readonly toolObservers = new Map<string, AbortController>();
  /** The latest streamed tool rows, kept over a stale durable read. */
  protected readonly toolSnapshots = new Map<string, Map<string, ToolActivity>>();

  protected discoveryInFlight: Promise<AgentSession[]> | undefined;
  // The startup reachability check is also the first complete global index.
  // Only discovery consumes it; lifecycle operations always ask for fresh evidence.
  protected startupSessionRows: SdkSessionRow[] | undefined;
  /** Last full broker list whose index file revision was stable across the read. */
  protected cachedBrokerRows: SdkSessionRow[] | undefined;
  protected cachedBrokerRevision: string | undefined;
  // The session map is a durable cache keyed by every id ever seen, including
  // rows discovery later filtered out. Yielding must replay the last discovered
  // list instead, or skipping a scan resurrects dead sessions in the sidebar.
  protected lastDiscovered: AgentSession[] = [];
  protected lastLiveFingerprint: string | undefined;

  protected readonly routeProbes = new Map<string, { at: number; reachable: boolean }>();

  protected readonly runStateWatchers = new Map<string, FSWatcher>();
  protected readonly runStateTimers = new Map<string, NodeJS.Timeout>();

  /**
   * Parent session ids, keyed by session id, with `null` for a transcript that was
   * read and named no source.
   *
   * A fork writes the link into the new session's envelope when it creates the
   * file and never revises it, so one read per session is enough -- and the negative
   * answer has to be cached too, or every discovery pass would re-read the head of
   * every root session in the list.
   */
  protected readonly sessionParents = new Map<string, string | null>();
  /** History picker summaries, reused while the session file's stat is unchanged. */
  protected readonly historySummaryCache = new Map<
    string,
    {
      mtimeMs: number;
      size: number;
      summary: NonNullable<ReturnType<typeof historySessionSummary>>;
      parentId?: string;
    }
  >();

  protected readonly transcriptAttachments = new Map<string, Promise<void>>();
}
