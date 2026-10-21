import gajaeIconUrl from "../assets/gajae-icon-ui.png";
import type {
  DiffSnapshot,
  GitStatusSnapshot,
  GjcUpdateStatus,
  GoalOperation,
  GoalSnapshot,
  HistorySession,
  MessageDelivery,
  SubagentSnapshot,
  TranscriptPage,
  TranscriptPageRequest,
  TranscriptRequestSummary,
} from "../../shared/agent-contract";
import type {
  AgentCommand,
  AgentConfigOption,
  AgentControlPreferences,
  AgentEvent,
  AgentSession,
  BackendConnection,
  MessageInput,
  QuestionSubmission,
  ToolViewMode,
  TranscriptItem,
} from "../backend/types";
import { useAgentBackend } from "../backend/use-agent-backend";
import {
  MessageDeliveryTracker,
  isTrackableMessageInput,
} from "../message-delivery";
import type { MessageDeliverySessionState } from "../message-delivery";
import {
  cacheTranscript,
  initialSessionId,
  discoveryRevisionIsFresh,
  lastUserRequestContent,
  mergeDiscoveredSessions,
  mergeTranscriptItem,
  pendingQuestions,
  pendingToolApprovals,
  updateTranscriptItem,
} from "../transcript-utils";
import {
  mergeRequestSummaries,
  mergeTranscriptPage,
  mergeTranscriptTail,
  refreshTranscriptWindow,
} from "../transcript-pages";
import { getLanguage, t, useLanguage } from "../i18n";
import { FolderGit2, GitBranch, Layers, Menu, PanelRight, Plus, X } from "lucide-react";
import { TerminalView } from "./terminal-view";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Composer,
  releaseQueuedSession,
  subscribeComposerReleaseRetry,
} from "./composer";
import {
  DeleteSessionDialog,
  GlobalSearchDialog,
  NewSessionDialog,
  ResumeSessionDialog,
} from "./dialogs";
import {
  BUNDLED_GJC_COMMANDS,
  EMPTY_TRANSCRIPT,
  directoryName,
  humanErrorMessage,
  sessionTitleText,
  statusLabel,
} from "./format";
import { DiffPanel, GoalProgressRow, Inspector } from "./inspector";
import { RemoteGate, RemoteStrip, remoteGateNeeded } from "./remote";
import {
  DeferredProjectList,
  DeferredRepoView,
  DeferredSettingsDialog,
} from "./deferred-views";
import { Sidebar } from "./sidebar";
import { sessionListModel } from "./sidebar-model";
import { Dropdown } from "./primitives";
import {
  ALL_PROJECTS_ID,
  buildProjectGroups,
  projectPathOf,
  resolveProjectSelection,
  sessionsOfProject,
} from "./project-model";
import type { RepoDesktopBridge } from "../../shared/repo-ipc";
import type { ProjectPathResolution } from "../../shared/repo-ipc";
import { QuestionBanner } from "./question-card";
import {
  ApprovalBanner,
  ConversationFindBar,
  RecentRequestStrip,
  Transcript,
} from "./transcript";
import {
  DEFAULT_MODEL_PRESET,
  DEFAULT_NOTIFICATION_PREFERENCES,
  DEFAULT_TOOL_VIEW_MODE,
} from "../../shared/agent-contract";
import type { RemoteClientStatus } from "../../shared/remote-protocol";

interface ShellSendOptions {
  quiet?: boolean;
  retryId?: string;
}

type ShellSendMessage = (
  sessionId: string,
  input: MessageInput,
  options?: ShellSendOptions,
) => Promise<MessageDelivery>;

type TranscriptPageScope =
  | { kind: "latest" }
  | { kind: "around"; id: string };

type TranscriptPageMergeMode = "replace" | "prepend" | "tail" | "around";

interface SessionTranscriptPageState {
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
  firstId?: string;
  lastId?: string;
  scope: TranscriptPageScope;
  loadingPage: boolean;
  pageError: string;
  loadingEarlier: boolean;
  earlierError: string;
}

const EMPTY_TRANSCRIPT_PAGE_STATE: SessionTranscriptPageState = {
  hasMoreBefore: false,
  hasMoreAfter: false,
  scope: { kind: "latest" },
  loadingPage: false,
  pageError: "",
  loadingEarlier: false,
  earlierError: "",
};

function reconcilePageRequestIndex(
  existing: TranscriptRequestSummary[],
  incoming: TranscriptRequestSummary[],
  eventVersions: ReadonlyMap<string, number> | undefined,
  readVersion: number,
): TranscriptRequestSummary[] {
  const existingById = new Map(existing.map((request) => [request.id, request]));
  const incomingIds = new Set(incoming.map((request) => request.id));
  const requests = incoming.map((request) =>
    (eventVersions?.get(request.id) ?? 0) > readVersion
      ? existingById.get(request.id) ?? request
      : request,
  );
  for (const request of existing) {
    if (
      !incomingIds.has(request.id) &&
      (eventVersions?.get(request.id) ?? 0) > readVersion
    )
      requests.push(request);
  }
  return requests;
}

function lastDurableUserRequest(
  items: readonly TranscriptItem[],
): Extract<TranscriptItem, { kind: "message" }> | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!;
    if (
      item.kind === "message" &&
      item.role === "user" &&
      !item.id.startsWith("local-prompt-")
    )
      return item;
  }
  return undefined;
}

/**
 * Whether a key press is the shell's abort gesture.
 *
 * This is the whole of the shortcut's claim to Escape. It used to be read in the
 * capture phase, ahead of every handler nearer the key, so pressing Escape while
 * typing a session name cancelled the run behind the editor the user was closing.
 * The key now travels the bubble phase and each of these guards hands it back.
 */
export function escapeCancelsRun(input: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  defaultPrevented: boolean;
  textEntry: boolean;
  surfaceOpen: boolean;
}): boolean {
  if (input.key !== "Escape" && input.key !== "Esc") return false;
  if (input.metaKey || input.ctrlKey || input.altKey || input.shiftKey)
    return false;
  // A nearer handler already took the key -- the rename field consumes Escape.
  if (input.defaultPrevented) return false;
  // Typing owns Escape. The composer cancels the run from its own handler, so
  // claiming the key here as well would cancel the same run twice; an editor or a
  // dialog field only closes itself.
  if (input.textEntry) return false;
  // While a dismissible surface is up, Escape closes it and nothing else.
  if (input.surfaceOpen) return false;
  return true;
}

/**
 * Whether the key landed in a field the user is typing into.
 *
 * Duck-typed instead of `instanceof HTMLElement` so the rule stays readable and
 * testable outside a DOM.
 */
export function isTextEntryTarget(target: unknown): boolean {
  const element = target as
    | { tagName?: unknown; isContentEditable?: unknown }
    | null;
  if (!element || typeof element !== "object") return false;
  if (element.isContentEditable === true) return true;
  return (
    element.tagName === "INPUT" ||
    element.tagName === "TEXTAREA" ||
    element.tagName === "SELECT"
  );
}

/**
 * Whether a transcript still shows work in progress: something streaming, or a
 * tool mid-execution.
 *
 * Two states deliberately do NOT count, because both outlive their turn and
 * treating either as running left the composer queueing every later message
 * while the header read idle -- the message only went out after some unrelated
 * interaction: a tool card awaiting approval, and a plan entry left at
 * in_progress once the turn ended.
 */
function transcriptHasLiveWork(transcript: readonly TranscriptItem[]): boolean {
  return transcript.some((item) => {
    if (item.kind === "message" || item.kind === "thought")
      return item.streaming === true;
    if (item.kind === "tool") return item.status === "running";
    return false;
  });
}

function deliverySessionState(
  session: AgentSession | undefined,
  connection: BackendConnection["state"],
): MessageDeliverySessionState | undefined {
  if (!session) return undefined;
  return {
    status: session.status,
    phase: session.phase,
    attachment: session.attachment,
    connection,
  };
}

function isNotExecutedDelivery(
  value: MessageDelivery,
): value is Extract<MessageDelivery, { kind: "not_executed" }> {
  return typeof value !== "string" && value.kind === "not_executed";
}

/**
 * Whether the composer has to treat the selected session as mid-turn.
 *
 * The session row is the runtime's own account of the run, so a terminal status
 * settles this outright. The transcript is the weaker account: a row synced while
 * a turn was open carries `streaming` on its message or thought and `running` on
 * an unresolved tool card, and nothing re-syncs that row once the turn ends, so
 * those flags outlive the work they describe. Letting them outrank an idle row
 * kept the composer on 이어서 보내기 and held every later message as a steer
 * behind a turn that was already done -- the row read 완료 while the next prompt
 * queued forever. Nothing in the transcript can date its own evidence, so the
 * stale flag and a freshly started turn look identical there; the row, which the
 * runtime advances as work begins and ends, is the only account that
 * distinguishes them.
 *
 * `starting` is the other side of that: the row exists but has not reported a
 * turn yet, so the transcript is the only account of work already underway. A
 * session with no row at all has nothing to go on.
 *
 * Compaction and a waiting approval outlive the turn that started them and have
 * no live transcript row of their own, so they are read from the row directly.
 */
export function composerTurnLive(
  // A row can arrive without a status yet (a freshly listed session), and the
  // caller then has only the transcript to go on, so the field is optional here
  // even though a fully read AgentSession always carries one.
  session: { status?: AgentSession["status"]; phase?: AgentSession["phase"] } | null,
  transcript: readonly TranscriptItem[],
): boolean {
  if (!session) return false;
  if (session.phase === "compacting") return true;
  if (session.status === "running" || session.status === "waiting") return true;
  // A terminal status is the runtime stating the turn is over. Any live-looking
  // row under it belongs to that finished turn, not to the next one.
  if (session.status === "idle" || session.status === "failed") return false;
  return transcriptHasLiveWork(transcript);
}

export function unreadBadgeCount(
  sessions: ReadonlyArray<Pick<AgentSession, "unread">>,
): number {
  return sessions.filter((session) => session.unread).length;
}

type BadgingNavigator = Navigator & {
  setAppBadge?: (contents?: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
};

/**
 * Mirrors unread sessions onto the installed PWA icon.
 *
 * The desktop window keeps its own sidebar count; the badge is what a phone can
 * see without opening the app. Rejection is non-fatal: a browser without the
 * Badging API simply has no icon badge.
 */
export function syncAppBadge(
  count: number,
  nav: BadgingNavigator | undefined =
    typeof navigator === "undefined" ? undefined : navigator,
): void {
  if (!nav) return;
  if (count > 0) void nav.setAppBadge?.(count).catch(() => undefined);
  else void nav.clearAppBadge?.().catch(() => undefined);
}

export default function App() {
  const language = useLanguage();
  const backend = useAgentBackend();
  const [connection, setConnection] = useState<BackendConnection>({
    state: "connecting",
    backend: "mock",
    label: "Gajae runtime",
    detail: "Connecting",
    workspace: "",
  });
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const connectionRef = useRef(connection);
  connectionRef.current = connection;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [transcripts, setTranscripts] = useState<
    Record<string, TranscriptItem[]>
  >({});
  const transcriptsRef = useRef(transcripts);
  transcriptsRef.current = transcripts;
  const [transcriptPageStates, setTranscriptPageStates] = useState<
    Record<string, SessionTranscriptPageState>
  >({});
  const transcriptPageStatesRef = useRef(transcriptPageStates);
  transcriptPageStatesRef.current = transcriptPageStates;
  const [requestSummariesBySession, setRequestSummariesBySession] = useState<
    Record<string, TranscriptRequestSummary[]>
  >({});
  const requestSummariesRef = useRef(requestSummariesBySession);
  requestSummariesRef.current = requestSummariesBySession;
  const messageDeliveryTrackerRef = useRef<MessageDeliveryTracker | null>(null);
  if (!messageDeliveryTrackerRef.current)
    messageDeliveryTrackerRef.current = new MessageDeliveryTracker();
  const deliveryPageReadsRef = useRef(new Set<string>());
  const deliveryPageRetryAfterRef = useRef(new Map<string, number>());
  const deliveryRetryTimersRef = useRef(new Map<string, number>());
  const [messageDeliveryRevision, setMessageDeliveryRevision] = useState(0);
  const [commands, setCommands] = useState<Record<string, AgentCommand[]>>({});
  const [configOptions, setConfigOptions] = useState<
    Record<string, AgentConfigOption[]>
  >({});
  const [searchQuery, setSearchQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [revealTarget, setRevealTarget] = useState<{
    sessionId: string;
    itemId: string;
  } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<GjcUpdateStatus | null>(
    null,
  );
  const [updateBusy, setUpdateBusy] = useState<
    "checking" | "installing" | null
  >(null);
  const [updateError, setUpdateError] = useState("");
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [inspectorToolId, setInspectorToolId] = useState<string>();
  const [resumingId, setResumingId] = useState<string | null>(null);
  const [focusedApprovalId, setFocusedApprovalId] = useState<string | undefined>(
    undefined,
  );
  const [findOpen, setFindOpen] = useState(false);
  const [diffOpen, setDiffOpen] = useState(false);
  const [diff, setDiff] = useState<DiffSnapshot | null>(null);
  const [selectedGit, setSelectedGit] = useState<GitStatusSnapshot | null>(
    null,
  );
  const [goal, setGoal] = useState<GoalSnapshot>({
    enabled: false,
    completed: 0,
    total: 0,
  });

  useEffect(() => {
    const tracker = messageDeliveryTrackerRef.current!;
    const now = Date.now();
    for (const sessionId of tracker.sessionIds()) {
      const session = sessions.find((candidate) => candidate.id === sessionId);
      const deliveryState = deliverySessionState(
        session,
        connection.state,
      );
      tracker.observeSession(
        sessionId,
        deliveryState,
        now,
      );
      if (
        tracker.needsLatestRead(sessionId) &&
        !deliveryPageReadsRef.current.has(sessionId) &&
        Date.now() >= (deliveryPageRetryAfterRef.current.get(sessionId) ?? 0)
      ) {
        deliveryPageReadsRef.current.add(sessionId);
        const requestedAt = Date.now();
        const beforeCount = tracker.snapshot(sessionId).length;
        void (async () => {
          let latest = await backend.getTranscriptPage(sessionId);
          const latestHasMoreAfter = latest.hasMoreAfter;
          let items = latest.items;
          let hasMoreBefore = latest.hasMoreBefore;
          let covered = tracker.coversPendingAttempts(
            sessionId,
            items,
            hasMoreBefore,
          );
          while (!latestHasMoreAfter && !covered && hasMoreBefore && latest.firstId) {
            const older = await backend.getTranscriptPage(sessionId, {
              beforeId: latest.firstId,
            });
            items = mergeTranscriptPage(items, older, "prepend");
            latest = {
              ...latest,
              firstId: older.firstId,
              lastId: latest.lastId,
              hasMoreBefore: older.hasMoreBefore,
              items,
            };
            hasMoreBefore = older.hasMoreBefore;
            covered = tracker.coversPendingAttempts(
              sessionId,
              items,
              hasMoreBefore,
            );
          }
          const complete = !latestHasMoreAfter && covered;
          tracker.observeTranscript(
            sessionId,
            items,
            { kind: "latest", complete, requestedAt },
            Date.now(),
          );
          const afterCount = tracker.snapshot(sessionId).length;
          const needsAnotherRead = tracker.needsLatestRead(sessionId);
          if ((complete || afterCount !== beforeCount) && !needsAnotherRead) {
            deliveryPageRetryAfterRef.current.delete(sessionId);
            const timer = deliveryRetryTimersRef.current.get(sessionId);
            if (timer !== undefined) window.clearTimeout(timer);
            deliveryRetryTimersRef.current.delete(sessionId);
            setMessageDeliveryRevision((revision) => revision + 1);
          } else {
            const retryAt = Date.now() + 5_000;
            deliveryPageRetryAfterRef.current.set(sessionId, retryAt);
            if (!deliveryRetryTimersRef.current.has(sessionId)) {
              const timer = window.setTimeout(() => {
                deliveryRetryTimersRef.current.delete(sessionId);
                deliveryPageRetryAfterRef.current.delete(sessionId);
                setMessageDeliveryRevision((revision) => revision + 1);
              }, 5_000);
              deliveryRetryTimersRef.current.set(sessionId, timer);
            }
            if (complete || afterCount !== beforeCount)
              setMessageDeliveryRevision((revision) => revision + 1);
          }
        })()
          .catch(() => undefined)
          .finally(() => deliveryPageReadsRef.current.delete(sessionId));
      }
    }
  }, [backend, sessions, connection.state, messageDeliveryRevision]);

  useEffect(
    () => () => {
      for (const timer of deliveryRetryTimersRef.current.values())
        window.clearTimeout(timer);
      deliveryRetryTimersRef.current.clear();
    },
    [],
  );

  useEffect(() => {
    const due = messageDeliveryTrackerRef.current!.nextDeadline();
    if (due === undefined) return;
    const timer = window.setTimeout(() => {
      messageDeliveryTrackerRef.current!.advance(Date.now());
      setMessageDeliveryRevision((revision) => revision + 1);
    }, Math.max(0, due - Date.now()));
    return () => window.clearTimeout(timer);
  }, [messageDeliveryRevision]);
  const [goalBusySessionId, setGoalBusySessionId] = useState<string | null>(null);
  const [liveSubagents, setLiveSubagents] = useState<SubagentSnapshot[]>([]);
  const [diffLoading, setDiffLoading] = useState(false);
  const [deleteCandidate, setDeleteCandidate] = useState<AgentSession | null>(
    null,
  );
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  // Bumped for every request this window sends into the open session. The transcript
  // reads it as "the reader asked for this" and takes the view to the newest content,
  // which is the one append that may move a view someone had scrolled away from.
  const [sentRequestToken, setSentRequestToken] = useState(0);
  const [resumeOpen, setResumeOpen] = useState(false);
  const [historySessions, setHistorySessions] = useState<HistorySession[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [appError, setAppError] = useState("");
  // On a phone the session list is a drawer, not a column: 76px of permanent rail
  // is a fifth of the screen. Wide windows never see this control.
  const [navOpen, setNavOpen] = useState(false);
  // Which project the rail is filtered by: the sentinel for the whole rail, or a
  // canonical project root. It is kept across session picks so the context the user
  // chose survives the trip into a conversation.
  const [selectedProjectId, setSelectedProjectId] = useState<string>(
    ALL_PROJECTS_ID,
  );
  // The center area shows one of three things. A session pick always returns to the
  // conversation; the repository screen and the project list are entered on purpose.
  const [centerView, setCenterView] = useState<
    "conversation" | "repository" | "projects"
  >("conversation");
  const [surface, setSurface] = useState<"chat" | "terminal">("chat");
  const [terminalMounted, setTerminalMounted] = useState(false);
  const surfaceRef = useRef(surface);
  useEffect(() => {
    surfaceRef.current = surface;
  }, [surface]);
  // Git project roots, as the main process resolved them. Empty until that answer
  // arrives, and empty forever in a renderer with no desktop bridge; the grouping
  // falls back to workspace paths in that case rather than dropping sessions.
  const [projectResolutions, setProjectResolutions] = useState<
    ProjectPathResolution[]
  >([]);
  // The whole object the store answered with is kept, not only the label the sidebar
  // renders: the reasoning-card preference is a field of it, and a card toggles that
  // one field through the bridge without touching the rest.
  const [preferences, setPreferences] = useState<AgentControlPreferences>({
    workspace: "",
    workspaceLabel: t("개인 Workspace"),
    modelPreset: DEFAULT_MODEL_PRESET,
    permissionHandling: "prompt",
    gjcExecutable: "",
    thoughtsExpanded: false,
    toolViewMode: DEFAULT_TOOL_VIEW_MODE,
    notificationPreferences: DEFAULT_NOTIFICATION_PREFERENCES,
    language: getLanguage(),
    runningSubmission: "queue",
  });
  const preferencesRef = useRef(preferences);
  // The card toggle is a stable callback so the memo'd transcript rows keep their
  // identity, which means it reads the current value through this ref rather than
  // closing over the render that created it.
  useEffect(() => {
    preferencesRef.current = preferences;
  }, [preferences]);
  const workspaceLabel = preferences.workspaceLabel;
  const pendingSessions = useRef(new Map<string, Promise<AgentSession>>());
  const selectedIdRef = useRef<string | null>(null);
  const navigationGenerationRef = useRef(0);
  const transcriptPageGenerationsRef = useRef(new Map<string, number>());
  const initialPageReadsRef = useRef(new Map<string, Promise<TranscriptPage | undefined>>());
  const transcriptPageInFlightRef = useRef(new Set<string>());
  const transcriptEventVersionsRef = useRef(new Map<string, number>());
  const transcriptItemVersionsRef = useRef(new Map<string, Map<string, number>>());
  const transcriptRequestEventVersionsRef = useRef(new Map<string, Map<string, number>>());
  const pendingTranscriptScopesRef = useRef(new Map<string, TranscriptPageScope>());
  const revealRequestGenerationRef = useRef(0);

  useEffect(() => {
    const cachedIds = new Set(Object.keys(transcripts));
    const prune = <T,>(source: Record<string, T>): Record<string, T> =>
      Object.fromEntries(
        Object.entries(source).filter(([sessionId]) => cachedIds.has(sessionId)),
      );
    const pages = prune(transcriptPageStatesRef.current);
    if (Object.keys(pages).length !== Object.keys(transcriptPageStatesRef.current).length) {
      transcriptPageStatesRef.current = pages;
      setTranscriptPageStates(pages);
    }
    const summaries = prune(requestSummariesRef.current);
    if (Object.keys(summaries).length !== Object.keys(requestSummariesRef.current).length) {
      requestSummariesRef.current = summaries;
      setRequestSummariesBySession(summaries);
    }
  }, [transcripts]);

  function updateTranscriptPageState(
    sessionId: string,
    update: (current: SessionTranscriptPageState) => SessionTranscriptPageState,
  ): void {
    const current = transcriptPageStatesRef.current;
    const next = {
      ...current,
      [sessionId]: update(
        current[sessionId] ?? EMPTY_TRANSCRIPT_PAGE_STATE,
      ),
    };
    transcriptPageStatesRef.current = next;
    setTranscriptPageStates(next);
  }

  function noteTranscriptEvent(sessionId: string, itemIds: string[] = []): void {
    const version = (transcriptEventVersionsRef.current.get(sessionId) ?? 0) + 1;
    transcriptEventVersionsRef.current.set(sessionId, version);
    if (itemIds.length === 0) return;
    let itemVersions = transcriptItemVersionsRef.current.get(sessionId);
    if (!itemVersions) {
      itemVersions = new Map();
      transcriptItemVersionsRef.current.set(sessionId, itemVersions);
    }
    for (const id of itemIds) itemVersions.set(id, version);
    let requestVersions = transcriptRequestEventVersionsRef.current.get(sessionId);
    if (!requestVersions) {
      requestVersions = new Map();
      transcriptRequestEventVersionsRef.current.set(sessionId, requestVersions);
    }
    for (const id of itemIds) requestVersions.set(id, version);
  }

  function tracksTranscriptSession(sessionId: string): boolean {
    return Boolean(transcriptsRef.current[sessionId]) ||
      transcriptPageInFlightRef.current.has(sessionId);
  }

  function updateRequestSummaries(
    sessionId: string,
    items: readonly TranscriptItem[],
  ): void {
    const current = requestSummariesRef.current;
    const next = {
      ...current,
      [sessionId]: mergeRequestSummaries(current[sessionId] ?? [], items),
    };
    requestSummariesRef.current = next;
    setRequestSummariesBySession(next);
  }

  function mergePageRequestSummaries(
    sessionId: string,
    requests: TranscriptRequestSummary[],
    readVersion: number,
  ): void {
    const current = requestSummariesRef.current;
    const next = {
      ...current,
      [sessionId]: reconcilePageRequestIndex(
        current[sessionId] ?? [],
        requests,
        transcriptRequestEventVersionsRef.current.get(sessionId),
        readVersion,
      ),
    };
    requestSummariesRef.current = next;
    setRequestSummariesBySession(next);
  }

  async function readTranscriptPage(
    sessionId: string,
    request: TranscriptPageRequest | undefined,
    mode: TranscriptPageMergeMode,
    scope: TranscriptPageScope,
  ): Promise<TranscriptPage | undefined> {
    const generation = (transcriptPageGenerationsRef.current.get(sessionId) ?? 0) + 1;
    transcriptPageGenerationsRef.current.set(sessionId, generation);
    const protectsHistoricalView =
      scope.kind === "around" && mode !== "prepend";
    if (protectsHistoricalView)
      pendingTranscriptScopesRef.current.set(sessionId, scope);
    transcriptPageInFlightRef.current.add(sessionId);
    const readVersion = transcriptEventVersionsRef.current.get(sessionId) ?? 0;
    let page: TranscriptPage;
    try {
      page = mode === "around"
        ? await refreshTranscriptWindow(
            transcriptsRef.current[sessionId] ?? [],
            (pageRequest) => backend.getTranscriptPage(sessionId, pageRequest),
          )
        : await backend.getTranscriptPage(sessionId, request);
    } catch (error) {
      if (transcriptPageGenerationsRef.current.get(sessionId) === generation) {
        transcriptPageInFlightRef.current.delete(sessionId);
        pendingTranscriptScopesRef.current.delete(sessionId);
        if (mode === "around")
          updateTranscriptPageState(sessionId, (current) => ({
            ...current,
            loadingPage: false,
            pageError: humanErrorMessage(error),
          }));
      }
      throw error;
    }
    if (transcriptPageGenerationsRef.current.get(sessionId) !== generation)
      return undefined;

    setTranscripts((current) => {
      if (transcriptPageGenerationsRef.current.get(sessionId) !== generation)
        return current;
      const currentItems = current[sessionId] ?? [];
      const currentById = new Map(currentItems.map((item) => [item.id, item]));
      const itemVersions = transcriptItemVersionsRef.current.get(sessionId);
      const freshPage: TranscriptPage = {
        ...page,
        items: page.items.map((item) =>
          (itemVersions?.get(item.id) ?? 0) > readVersion
            ? currentById.get(item.id) ?? item
            : item,
        ),
      };
      let items: TranscriptItem[];
      if (mode === "prepend") {
        items = mergeTranscriptPage(currentItems, freshPage, "prepend");
      } else if (mode === "tail") {
        items = mergeTranscriptTail(currentItems, freshPage.items);
      } else if (mode === "around") {
        items = mergeTranscriptPage(currentItems, freshPage, "replace");
      } else {
        items = mergeTranscriptPage(currentItems, freshPage, "replace");
      }
      if (
        scope.kind === "latest" &&
        mode !== "prepend" &&
        mode !== "around"
      ) {
        const installedIds = new Set(items.map((item) => item.id));
        const arrivedDuringRead = currentItems.filter(
          (item) =>
            !installedIds.has(item.id) &&
            (itemVersions?.get(item.id) ?? 0) > readVersion,
        );
        if (arrivedDuringRead.length > 0) items = [...items, ...arrivedDuringRead];
      }
      const next = cacheTranscript(current, sessionId, items);
      transcriptsRef.current = next;
      return next;
    });
    if (transcriptPageGenerationsRef.current.get(sessionId) !== generation)
      return undefined;

    const previous = transcriptPageStatesRef.current[sessionId] ?? EMPTY_TRANSCRIPT_PAGE_STATE;
    const pageState: SessionTranscriptPageState = {
      ...previous,
      scope,
      loadingPage: false,
      pageError: "",
      loadingEarlier: false,
      earlierError: "",
    };
    if (mode === "prepend") {
      pageState.hasMoreBefore = page.hasMoreBefore;
      pageState.hasMoreAfter = previous.hasMoreAfter;
      pageState.firstId = page.firstId ?? previous.firstId;
      pageState.lastId = previous.lastId ?? page.lastId;
    } else if (mode === "tail") {
      pageState.hasMoreBefore = previous.hasMoreBefore || page.hasMoreBefore;
      pageState.hasMoreAfter = page.hasMoreAfter;
      pageState.firstId = previous.firstId ?? page.firstId;
      pageState.lastId = page.lastId ?? previous.lastId;
    } else if (mode === "around") {
      pageState.hasMoreBefore = page.hasMoreBefore;
      pageState.hasMoreAfter = page.hasMoreAfter;
      pageState.firstId = page.firstId;
      pageState.lastId = page.lastId;
    } else {
      pageState.hasMoreBefore = page.hasMoreBefore;
      pageState.hasMoreAfter = page.hasMoreAfter;
      pageState.firstId = page.firstId;
      pageState.lastId = page.lastId;
    }
    updateTranscriptPageState(sessionId, () => pageState);
    mergePageRequestSummaries(sessionId, page.requests, readVersion);
    transcriptPageInFlightRef.current.delete(sessionId);
    pendingTranscriptScopesRef.current.delete(sessionId);
    const finishedVersion = transcriptEventVersionsRef.current.get(sessionId) ?? 0;
    if (finishedVersion !== readVersion) {
      window.setTimeout(() => {
        if (
          transcriptEventVersionsRef.current.get(sessionId) === finishedVersion &&
          transcriptsRef.current[sessionId]
        )
          void refreshTranscriptPage(sessionId).catch(() => undefined);
      }, 200);
    }
    return page;
  }

  async function refreshTranscriptPage(sessionId: string): Promise<void> {
    if (!transcriptsRef.current[sessionId]) return;
    const pageState = transcriptPageStatesRef.current[sessionId];
    if (
      pageState?.scope.kind === "around" ||
      pageState?.hasMoreAfter
    ) {
      const anchorId = pageState?.scope.kind === "around"
        ? pageState.scope.id
        : pageState?.firstId ?? transcriptsRef.current[sessionId]?.[0]?.id;
      if (!anchorId) return;
      await readTranscriptPage(
        sessionId,
        { aroundId: anchorId },
        "around",
        { kind: "around", id: anchorId },
      );
      return;
    }
    await readTranscriptPage(sessionId, undefined, "tail", { kind: "latest" });
  }

  function mergeLiveTranscriptItems(
    sessionId: string,
    current: TranscriptItem[],
    incoming: readonly TranscriptItem[],
  ): TranscriptItem[] {
    const pageState = transcriptPageStatesRef.current[sessionId];
    const pendingScope = pendingTranscriptScopesRef.current.get(sessionId);
    const historical =
      pageState?.scope.kind === "around" ||
      pageState?.hasMoreAfter ||
      pendingScope?.kind === "around";
    let next = current;
    for (const item of incoming) {
      if (historical && !next.some((existing) => existing.id === item.id)) continue;
      next = mergeTranscriptItem(next, item);
    }
    return next;
  }

  useEffect(() => {
    if (!appError) return;
    const timer = window.setTimeout(() => setAppError(""), 4_500);
    return () => window.clearTimeout(timer);
  }, [appError]);
  const updateCheckedRef = useRef(false);
  const settingsBridge = window.agentControlDesktop?.settings;
  // A browser is the remote client of a host: the shell keeps its status so an
  // unpaired device sees the pairing screen and a view-only device cannot type
  // into a composer the host would refuse anyway.
  const remoteBridge = backend.remoteAccess;
  const [remoteStatus, setRemoteStatus] = useState<RemoteClientStatus | null>(
    remoteBridge ? null : { state: "connected" },
  );

  useEffect(() => {
    const bridge = backend.remoteAccess;
    if (!bridge) return;
    let active = true;
    void bridge.getStatus().then((status) => {
      if (active) setRemoteStatus(status);
    });
    const unsubscribe = bridge.subscribe((status) => setRemoteStatus(status));
    return () => {
      active = false;
      unsubscribe();
    };
  }, [backend]);

  const checkForUpdate = useCallback(async (): Promise<void> => {
    if (!settingsBridge) return;
    setUpdateBusy("checking");
    setUpdateError("");
    try {
      setUpdateStatus(await settingsBridge.checkGjcUpdate());
    } catch (error) {
      setUpdateError(error instanceof Error ? error.message : String(error));
    } finally {
      setUpdateBusy(null);
    }
  }, [settingsBridge]);

  const installUpdate = useCallback(async (): Promise<void> => {
    if (!settingsBridge || !updateStatus?.updateAvailable) return;
    if (
      !window.confirm(
        t`GJC ${updateStatus.latestVersion}(으)로 업데이트할까요? 업데이트 후 GJC runtime이 다시 연결됩니다.`,
      )
    )
      return;
    setUpdateBusy("installing");
    setUpdateError("");
    try {
      setUpdateStatus(await settingsBridge.installGjcUpdate());
    } catch (error) {
      setUpdateError(error instanceof Error ? error.message : String(error));
      setSettingsOpen(true);
    } finally {
      setUpdateBusy(null);
    }
  }, [settingsBridge, updateStatus]);

  useEffect(() => {
    if (updateCheckedRef.current) return;
    // `gjc update --check` is its own process. Starting it while the broker
    // index is still the reachability probe competes with the first session
    // list, so it waits until that connection attempt has settled.
    if (connection.state === "connecting") return;
    updateCheckedRef.current = true;
    queueMicrotask(() => void checkForUpdate());
  }, [checkForUpdate, connection.state]);

  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  const [reconnecting, setReconnecting] = useState(false);
  const reconnect = useCallback(async (): Promise<void> => {
    setReconnecting(true);
    try {
      setConnection(await backend.reconnect());
    } catch (error) {
      setAppError(humanErrorMessage(error));
    } finally {
      setReconnecting(false);
    }
  }, [backend]);
  // A runtime that is not attached has no sessions, no transcripts, and no controls
  // that can do anything. Rendering the ordinary shell over that state showed an empty
  // but otherwise normal-looking window, so the failure is given the workspace instead.
  const runtimeUnavailable =
    connection.state === "disconnected" || connection.state === "error";

  useEffect(() => {
    function openGlobalSearch(event: globalThis.KeyboardEvent): void {
      if (
        !event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.shiftKey ||
        surfaceRef.current === "terminal" ||
        event.key.toLowerCase() !== "k"
      )
        return;
      event.preventDefault();
      setSearchOpen(true);
    }
    window.addEventListener("keydown", openGlobalSearch);
    return () => window.removeEventListener("keydown", openGlobalSearch);
  }, []);

  useEffect(() => {
    const settingsBridge = window.agentControlDesktop?.settings;
    if (!settingsBridge) return;
    let active = true;
    void settingsBridge.getPreferences().then((loaded) => {
      if (active) setPreferences(loaded);
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    void backend.getConnection().then((currentConnection) => {
      if (active) setConnection(currentConnection);
    });
    // Run ends can happen while another screen is open and no composer exists.
    // This tracker lives for the shell's lifetime, so a queue restored from a
    // snapshot is still released when its session reports idle. A running report
    // must have been seen first: an idle row right after a send, before the turn
    // starts, is not evidence that queued work can be handed over.
    const runStates = new Map<string, AgentSession["status"]>();
    // Discovery is a slow read. A live update that advances the revision while
    // the list request is in flight makes the older response stale: merging it
    // already refuses to overwrite the row, but observing it would still turn a
    // running -> idle transition into a queue release. Track the newest revision
    // seen so the side effect follows the same rule as the rendered row.
    const observedRevisions = new Map<string, number>();
    const releaseSessionQueue = (sessionId: string): void => {
      const selectedAtRelease = selectedIdRef.current;
      void releaseQueuedSession(sessionId, async (request) => {
        // Send directly: this request belongs to the session whose run ended, which
        // may not be the one on screen. The composer's sent-request token would
        // scroll an unrelated transcript.
        await sendMessageRef.current(sessionId, {
          text: request.text,
          images: request.images,
          files: request.files,
        }, { quiet: true });
      }, () => selectedIdRef.current === selectedAtRelease)
        .catch((error: unknown) => setAppError(humanErrorMessage(error)));
    };
    const observeSessionRun = (session: AgentSession): void => {
      if (
        !discoveryRevisionIsFresh(
          observedRevisions.get(session.id),
          session.runRevision,
        )
      )
        return;
      observedRevisions.set(session.id, session.runRevision ?? 0);
      const previous = runStates.get(session.id);
      runStates.set(session.id, session.status);
      if (previous !== "running" || session.status !== "idle") return;
      releaseSessionQueue(session.id);
    };
    // A flush that was awaiting the runtime can outlive its composer. The idle
    // event then arrived while that instance held the release lock, so retry once
    // the retiring instance hands the lock back -- but only while the session is
    // still idle; otherwise its later idle transition will do it.
    const unsubscribeReleaseRetry = subscribeComposerReleaseRetry((sessionId) => {
      if (runStates.get(sessionId) === "idle") releaseSessionQueue(sessionId);
    });

    // A GJC session started from the CLI after this window opened only shows up if
    // discovery runs again, so the list refreshes instead of loading once.
    let listing = false;
    const loadSessions = (initial: boolean): void => {
      if (listing || !active) return;
      listing = true;
      void backend
        .listSessions()
        .then((loadedSessions) => {
          if (!active) return;
          for (const session of loadedSessions) observeSessionRun(session);
          setSessions((current) =>
            mergeDiscoveredSessions(
              current,
              loadedSessions,
              selectedIdRef.current,
            ),
          );
          if (initial)
            setSelectedId((selected) =>
              initialSessionId(loadedSessions, selected),
            );
        })
        .catch(() => undefined)
        .finally(() => { listing = false; });
    };
    // Poll only sessions already in the three-session transcript cache. A bounded page
    // repairs missed watcher events without ever turning a historical view into a tail.
    const refreshingTranscripts = new Set<string>();
    const queuedTranscriptRefreshes = new Set<string>();
    const refreshTranscript = (id: string): void => {
      if (!active || !transcriptsRef.current[id]) return;
      if (refreshingTranscripts.has(id)) {
        queuedTranscriptRefreshes.add(id);
        return;
      }
      refreshingTranscripts.add(id);
      const startedAtVersion = transcriptEventVersionsRef.current.get(id) ?? 0;
      void refreshTranscriptPage(id)
        .catch(() => undefined)
        .finally(() => {
          refreshingTranscripts.delete(id);
          const changedDuringRead =
            (transcriptEventVersionsRef.current.get(id) ?? 0) !== startedAtVersion;
          if (
            active &&
            (queuedTranscriptRefreshes.delete(id) || changedDuringRead)
          )
            window.setTimeout(() => refreshTranscript(id), 200);
        });
    };
    const refreshSelectedTranscript = (): void => {
      const id = selectedIdRef.current;
      if (id) refreshTranscript(id);
    };
    const refreshVisibleState = (): void => {
      loadSessions(false);
      refreshSelectedTranscript();
    };
    loadSessions(true);
    // A full scan costs seconds on a large broker index, so polling faster than
    // that just queues overlapping scans. The controller skips `session list`
    // while `sessions/index.jsonl` is unchanged; this beat still runs so a
    // transcript-only run-state change can move the fingerprint. Focus refresh
    // covers the case where the user switches to this window right after
    // starting a CLI session.
    //
    // The scan is skipped while the window is hidden. Run state now arrives on its
    // own from the transcript watchers, so the only thing polling still discovers is
    // a session started elsewhere -- which nobody can see until this window is
    // visible again, and the focus listener below already refreshes for that.
    const discoveryTimer = window.setInterval(() => {
      if (document.hidden) return;
      refreshVisibleState();
    }, 15_000);
    // The event stream is still the primary path; this second beat only repairs a
    // frozen selected conversation, so it can be shorter than session discovery.
    const transcriptTimer = window.setInterval(() => {
      if (!document.hidden) refreshSelectedTranscript();
    }, 5_000);
    const refreshOnFocus = (): void => refreshVisibleState();
    window.addEventListener("focus", refreshOnFocus);
    // `focus` does not fire when the window is merely un-occluded on macOS, so
    // visibility is tracked separately to catch up after a hidden stretch.
    const refreshOnVisible = (): void => {
      if (!document.hidden) refreshVisibleState();
    };
    document.addEventListener("visibilitychange", refreshOnVisible);

    const unsubscribe = backend.subscribe((event: AgentEvent) => {
      if (event.type === "connection.updated") {
        setConnection(event.connection);
      } else if (event.type === "session.created") {
        observeSessionRun(event.session);
        setSessions((current) => [
          event.session,
          ...current.filter((session) => session.id !== event.session.id),
        ]);
      } else if (event.type === "session.updated") {
        observeSessionRun(event.session);
        setSessions((current) =>
          current.map((session) =>
            session.id === event.session.id &&
            discoveryRevisionIsFresh(
              session.runRevision,
              event.session.runRevision,
            )
              ? event.session
              : session,
          ),
        );
      } else if (event.type === "session.deleted") {
        forgetSession(event.sessionId);
      } else if (event.type === "transcript.appended") {
        const tracked = tracksTranscriptSession(event.item.sessionId);
        if (tracked) noteTranscriptEvent(event.item.sessionId, [event.item.id]);
        messageDeliveryTrackerRef.current!.observeUserEvent(
          event.item.sessionId,
          event.item,
          Date.now(),
        );
        setMessageDeliveryRevision((revision) => revision + 1);
        if (tracked && !event.item.id.startsWith("local-prompt-"))
          updateRequestSummaries(event.item.sessionId, [event.item]);
        setTranscripts((current) => {
          const items = current[event.item.sessionId];
          if (!items) return current;
          const next = cacheTranscript(
            current,
            event.item.sessionId,
            mergeLiveTranscriptItems(event.item.sessionId, items, [event.item]),
          );
          transcriptsRef.current = next;
          return next;
        });
      } else if (event.type === "transcript.synced") {
        const tracked = tracksTranscriptSession(event.sessionId);
        if (tracked)
          noteTranscriptEvent(event.sessionId, event.items.map((item) => item.id));
        messageDeliveryTrackerRef.current!.observeTranscript(
          event.sessionId,
          event.items,
          { kind: "other", complete: false },
          Date.now(),
        );
        setMessageDeliveryRevision((revision) => revision + 1);
        if (tracked)
          updateRequestSummaries(
            event.sessionId,
            event.items.filter(
              (item) =>
                item.kind !== "message" ||
                item.role !== "user" ||
                !item.id.startsWith("local-prompt-"),
            ),
          );
        setTranscripts((current) => {
          const existing = current[event.sessionId];
          if (!existing) return current;
          const pageState = transcriptPageStatesRef.current[event.sessionId];
          const historical = pageState?.scope.kind === "around" || pageState?.hasMoreAfter;
          const items = historical
            ? mergeLiveTranscriptItems(
                event.sessionId,
                existing,
                event.items.filter((item) => existing.some((row) => row.id === item.id)),
              )
            : mergeTranscriptTail(existing, event.items);
          const next = cacheTranscript(current, event.sessionId, items);
          transcriptsRef.current = next;
          return next;
        });
      } else if (event.type === "transcript.invalidated") {
        if (tracksTranscriptSession(event.sessionId))
          noteTranscriptEvent(event.sessionId);
        refreshTranscript(event.sessionId);
      } else if (event.type === "message.delta") {
        if (tracksTranscriptSession(event.sessionId))
          noteTranscriptEvent(event.sessionId, [event.messageId]);
        setTranscripts((current) => {
          const next = updateTranscriptItem(
            current,
            event.sessionId,
            event.messageId,
            (item) =>
              item.kind === "message"
                ? {
                    ...item,
                    content: item.content + event.delta,
                    streaming: event.streaming,
                  }
                : item,
          );
          transcriptsRef.current = next;
          return next;
        });
      } else if (event.type === "message.updated") {
        const tracked = tracksTranscriptSession(event.message.sessionId);
        if (tracked)
          noteTranscriptEvent(event.message.sessionId, [event.message.id]);
        messageDeliveryTrackerRef.current!.observeUserEvent(
          event.message.sessionId,
          event.message,
          Date.now(),
        );
        setMessageDeliveryRevision((revision) => revision + 1);
        if (tracked && !event.message.id.startsWith("local-prompt-"))
          updateRequestSummaries(event.message.sessionId, [event.message]);
        setTranscripts((current) => {
          const next = updateTranscriptItem(
            current,
            event.message.sessionId,
            event.message.id,
            () => event.message,
          );
          transcriptsRef.current = next;
          return next;
        });
      } else if (event.type === "thought.delta") {
        if (tracksTranscriptSession(event.sessionId))
          noteTranscriptEvent(event.sessionId, [event.thoughtId]);
        setTranscripts((current) => {
          const next = updateTranscriptItem(
            current,
            event.sessionId,
            event.thoughtId,
            (item) =>
              item.kind === "thought"
                ? {
                    ...item,
                    content: item.content + event.delta,
                    streaming: event.streaming,
                  }
                : item,
          );
          transcriptsRef.current = next;
          return next;
        });
      } else if (event.type === "plan.updated") {
        if (tracksTranscriptSession(event.plan.sessionId))
          noteTranscriptEvent(event.plan.sessionId, [event.plan.id]);
        setTranscripts((current) => {
          const next = updateTranscriptItem(
            current,
            event.plan.sessionId,
            event.plan.id,
            () => event.plan,
          );
          transcriptsRef.current = next;
          return next;
        });
      } else if (event.type === "session.commands") {
        setCommands((current) => ({
          ...current,
          [event.sessionId]: event.commands,
        }));
      } else if (event.type === "session.config") {
        setConfigOptions((current) => ({
          ...current,
          [event.sessionId]: event.options,
        }));
      } else if (event.type === "tool.updated") {
        if (tracksTranscriptSession(event.tool.sessionId))
          noteTranscriptEvent(event.tool.sessionId, [event.tool.id]);
        setTranscripts((current) => {
          const next = updateTranscriptItem(
            current,
            event.tool.sessionId,
            event.tool.id,
            () => event.tool,
          );
          transcriptsRef.current = next;
          return next;
        });
      } else if (event.type === "question.updated") {
        const tracked = tracksTranscriptSession(event.question.sessionId);
        if (tracked)
          noteTranscriptEvent(event.question.sessionId, [event.question.id]);
        setTranscripts((current) => {
          const items = current[event.question.sessionId];
          if (!items) return current;
          const next = cacheTranscript(
            current,
            event.question.sessionId,
            mergeLiveTranscriptItems(
              event.question.sessionId,
              items,
              [event.question],
            ),
          );
          transcriptsRef.current = next;
          return next;
        });
      } else if (event.type === "session.activity") {
        setSessions((current) =>
          current.map((s) =>
            s.id === event.sessionId
              ? {
                  ...s,
                  unread:
                    event.sessionId !== selectedIdRef.current && event.unread,
                }
              : s,
          ),
        );
      }
    });

    return () => {
      active = false;
      window.clearInterval(discoveryTimer);
      window.clearInterval(transcriptTimer);
      window.removeEventListener("focus", refreshOnFocus);
      document.removeEventListener("visibilitychange", refreshOnVisible);
      unsubscribeReleaseRetry();
      unsubscribe();
    };
  }, [backend]);

  const selectedSession =
    sessions.find((session) => session.id === selectedId) ?? null;
  const selectedSessionId = selectedSession?.id;
  const selectedSessionStatus = selectedSession?.status;
  const selectedSessionRef = useRef(selectedSession);
  selectedSessionRef.current = selectedSession;
  selectedIdRef.current = selectedId;
  const cachedSelectedTranscript = selectedId ? transcripts[selectedId] : undefined;

  useEffect(() => {
    const ids = Object.keys(transcripts);
    if (selectedId && !ids.includes(selectedId)) ids.push(selectedId);
    backend.watchTranscripts?.(ids);
  }, [backend, transcripts, selectedId]);

  useEffect(() => {
    if (!selectedId || cachedSelectedTranscript) return;
    let active = true;
    updateTranscriptPageState(selectedId, (current) => ({
      ...current,
      loadingPage: true,
      pageError: "",
      scope: { kind: "latest" },
    }));
    let read = initialPageReadsRef.current.get(selectedId);
    if (!read) {
      read = readTranscriptPage(selectedId, undefined, "replace", { kind: "latest" });
      initialPageReadsRef.current.set(selectedId, read);
      const pending = read;
      const release = (): void => {
        if (initialPageReadsRef.current.get(selectedId) === pending)
          initialPageReadsRef.current.delete(selectedId);
      };
      void read.then(release, release);
    }
    void read
      .then((page) => {
        if (active && page)
          void backend.refreshSessionContext?.(selectedId).catch(() => undefined);
      })
      .catch((error) => {
        if (!active) return;
        updateTranscriptPageState(selectedId, (current) => ({
          ...current,
          loadingPage: false,
          pageError: humanErrorMessage(error),
        }));
      });
    return () => {
      active = false;
    };
  }, [backend, selectedId, cachedSelectedTranscript]);

  useEffect(() => {
    if (!selectedSessionId) return;
    let active = true;
    let refreshing = false;
    const refresh = (): void => {
      if (!active || refreshing) return;
      refreshing = true;
      void backend
        .getGoal(selectedSessionId)
        .then((snapshot) => {
          if (active && selectedIdRef.current === selectedSessionId)
            setGoal(snapshot);
        })
        .catch(() => {
          if (active && selectedIdRef.current === selectedSessionId)
            setGoal({ enabled: false, completed: 0, total: 0 });
        })
        .finally(() => { refreshing = false; });
    };
    queueMicrotask(refresh);
    // Goal and todo state advance at tool-call pace, not at streaming pace. Two
    // round trips every 1.5s against the host's GJC connection cost more than the
    // freshness is worth while a turn is running. A hidden window has nobody to
    // show the result to, and it refreshes on the way back in.
    const timer = window.setInterval(
      () => {
        if (!document.hidden) refresh();
      },
      selectedSessionStatus === "running" ? 4_000 : 10_000,
    );
    const refreshOnVisible = (): void => {
      if (!document.hidden) refresh();
    };
    document.addEventListener("visibilitychange", refreshOnVisible);
    return () => {
      active = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshOnVisible);
    };
  }, [backend, selectedSessionId, selectedSessionStatus]);

  useEffect(() => {
    if (!selectedSessionId || !inspectorOpen) {
      queueMicrotask(() => setLiveSubagents([]));
      return;
    }
    let active = true;
    const refresh = (): void => {
      void backend
        .listSubagents(selectedSessionId)
        .then((jobs) => {
          if (active) setLiveSubagents(jobs);
        })
        .catch(() => undefined);
    };
    queueMicrotask(refresh);
    // Subagent rows only change when a delegated job starts or finishes, and the
    // inspector is the only surface that shows them -- so a hidden window polls for
    // rows nobody is looking at.
    const timer = window.setInterval(() => {
      if (!document.hidden) refresh();
    }, 4_000);
    const refreshOnVisible = (): void => {
      if (!document.hidden) refresh();
    };
    document.addEventListener("visibilitychange", refreshOnVisible);
    return () => {
      active = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshOnVisible);
    };
  }, [backend, inspectorOpen, selectedSessionId]);

  useEffect(() => {
    if (!selectedId) return;
    void backend.markSessionRead(selectedId);
  }, [backend, selectedId]);

  // The main process cannot infer which session a focused window is showing from
  // focus alone. Naming it lets notifications skip the turn being watched instead
  // of pinging the user about their own screen.
  useEffect(() => {
    const bridge = window.agentControlDesktop?.settings;
    if (!bridge) return;
    void bridge.setViewedSession(selectedId).catch(() => undefined);
  }, [selectedId]);

  useEffect(
    () => () => {
      void window.agentControlDesktop?.settings
        .setViewedSession(null)
        .catch(() => undefined);
    },
    [],
  );

  const unreadCount = unreadBadgeCount(sessions);
  useEffect(() => {
    syncAppBadge(unreadCount);
  }, [unreadCount]);

  useEffect(() => {
    if (!selectedSessionId) {
      queueMicrotask(() => setSelectedGit(null));
      return;
    }
    let active = true;
    const refresh = (): void => {
      void backend
        .getGitStatus(selectedSessionId)
        .then((status) => {
          if (active) setSelectedGit(status);
        })
        .catch(() => {
          if (active) setSelectedGit(null);
        });
    };
    queueMicrotask(refresh);
    window.addEventListener("focus", refresh);
    return () => {
      active = false;
      window.removeEventListener("focus", refresh);
    };
  }, [backend, selectedSessionId, selectedSessionStatus]);

  async function refreshDiff(): Promise<void> {
    if (!selectedId) return;
    setDiffLoading(true);
    try {
      setDiff(await backend.getDiff(selectedId));
    } catch (e) {
      setDiff({
        sessionId: selectedId,
        workspace: selectedSession?.workspace ?? "",
        files: [],
        refreshedAt: new Date().toISOString(),
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setDiffLoading(false);
    }
  }

  async function operateGoal(operation: GoalOperation): Promise<void> {
    const sessionId = selectedId;
    if (!sessionId || goalBusySessionId === sessionId) return;
    setGoalBusySessionId(sessionId);
    try {
      const snapshot = await backend.operateGoal(sessionId, operation);
      if (selectedIdRef.current === sessionId) setGoal(snapshot);
    } catch (error) {
      if (selectedIdRef.current === sessionId)
        setAppError(humanErrorMessage(error));
    } finally {
      setGoalBusySessionId((current) =>
        current === sessionId ? null : current,
      );
    }
  }

  // The preload object is frozen, so this is one reference for the process's life.
  const repoBridge: RepoDesktopBridge | null =
    window.agentControlDesktop?.repo ?? null;
  // Only the paths actually in use are resolved, and only when the set changes: a
  // session's status changes far more often than its workspace does.
  const workspaceKey = useMemo(
    () => [...new Set(sessions.map(projectPathOf))].sort().join("\n"),
    [sessions],
  );
  useEffect(() => {
    // No bridge (a browser or a remote client) and no workspaces both leave the
    // grouping to the workspace paths themselves; there is nothing to resolve.
    if (!repoBridge || !workspaceKey) return;
    let active = true;
    void repoBridge
      .resolveProjects(workspaceKey.split("\n"))
      .then((resolved) => {
        if (active) setProjectResolutions(resolved);
      })
      // A failed lookup leaves the previous answer in place. Grouping by workspace
      // path is still correct, only coarser, and clearing it would redraw the whole
      // rail as ungrouped for a transient IPC failure.
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [repoBridge, workspaceKey]);

  const projectGroups = useMemo(
    () => buildProjectGroups(sessions, projectResolutions),
    [sessions, projectResolutions],
  );
  // A project whose last session was deleted must not leave the rail filtered by a
  // row that no longer exists.
  const activeProjectId = useMemo(
    () => resolveProjectSelection(selectedProjectId, projectGroups),
    [selectedProjectId, projectGroups],
  );
  const activeProject = useMemo(
    () => projectGroups.find((group) => group.id === activeProjectId) ?? null,
    [projectGroups, activeProjectId],
  );
  const filteredSessions = useMemo(
    () => sessionsOfProject(sessions, projectGroups, activeProjectId),
    [sessions, projectGroups, activeProjectId],
  );
  // The digits the main process sends for ⌘1-⌘9 index this list, so it has to be the
  // rail's own order: pinned first, then the state groups, newest first inside each.
  const shortcutSessions = useMemo(
    () => sessionListModel(filteredSessions).shortcuts,
    [filteredSessions],
  );

  // Nothing is hidden any more: a request the composer is still holding was never
  // sent, so it cannot appear here, and anything that did reach GJC is an ordinary
  // user message.
  const selectedTranscript = selectedId
    ? (transcripts[selectedId] ?? EMPTY_TRANSCRIPT)
    : EMPTY_TRANSCRIPT;
  const selectedDeliveryAttempts = selectedId
    ? messageDeliveryTrackerRef.current!.snapshot(selectedId)
    : [];
  // Queue state changes when the turn starts or ends, not on every streamed
  // chunk. Keying this on transcript length re-listed the queue over the shared
  // GJC connection for each chunk, which is what made sending feel slow.
  // A permission the agent already withdrew is gone by the time a slow click
  // arrives, and the backend rejects for it. Dropping that rejection left the
  // dialog looking answered while nothing had been sent, so it surfaces like
  // every other action failure.
  const resolveToolCall = useCallback(
    (toolId: string, optionId: string) => {
      backend.resolveToolCall(toolId, { optionId }).catch((error: unknown) => {
        setAppError(humanErrorMessage(error));
      });
    },
    [backend],
  );
  const answerQuestion = useCallback(
    (gateId: string, submission: QuestionSubmission, idempotencyKey: string) => {
      if (!selectedId) return;
      backend
        .answerQuestion(selectedId, gateId, submission, idempotencyKey)
        .catch((error: unknown) => {
          setAppError(humanErrorMessage(error));
        });
    },
    [backend, selectedId],
  );
  const pendingApprovals = useMemo(
    () => pendingToolApprovals(selectedTranscript),
    [selectedTranscript],
  );
  const pendingQuestionCards = useMemo(
    () => pendingQuestions(selectedTranscript),
    [selectedTranscript],
  );
  const readArtifact = useCallback(
    (artifactId: string) => {
      if (!selectedId)
        return Promise.reject(new Error(t("선택된 세션이 없습니다.")));
      return backend.readArtifact(
        selectedId,
        artifactId.replace(/^artifact:\/\//u, ""),
      );
    },
    [backend, selectedId],
  );
  const completeReveal = useCallback((itemId: string) => {
    setRevealTarget((current) => (current?.itemId === itemId ? null : current));
  }, []);
  const selectedTranscriptPageState = selectedId
    ? transcriptPageStates[selectedId] ?? EMPTY_TRANSCRIPT_PAGE_STATE
    : EMPTY_TRANSCRIPT_PAGE_STATE;
  async function loadEarlierTranscript(): Promise<void> {
    const sessionId = selectedIdRef.current;
    if (!sessionId) return;
    const pageState = transcriptPageStatesRef.current[sessionId] ?? EMPTY_TRANSCRIPT_PAGE_STATE;
    const beforeId = pageState.firstId ?? transcriptsRef.current[sessionId]?.[0]?.id;
    if (!pageState.hasMoreBefore || !beforeId) return;
    updateTranscriptPageState(sessionId, (current) => ({
      ...current,
      loadingEarlier: true,
      earlierError: "",
    }));
    try {
      const page = await readTranscriptPage(
        sessionId,
        { beforeId },
        "prepend",
        pageState.scope,
      );
      if (!page)
        updateTranscriptPageState(sessionId, (current) => ({
          ...current,
          loadingEarlier: false,
        }));
    } catch (error) {
      updateTranscriptPageState(sessionId, (current) => ({
        ...current,
        loadingEarlier: false,
        earlierError: humanErrorMessage(error),
      }));
    }
  }
  async function returnTranscriptToLatest(): Promise<void> {
    const sessionId = selectedIdRef.current;
    if (!sessionId) return;
    const generation = ++revealRequestGenerationRef.current;
    setRevealTarget(null);
    updateTranscriptPageState(sessionId, (current) => ({
      ...current,
      loadingPage: true,
      pageError: "",
    }));
    try {
      const page = await readTranscriptPage(
        sessionId,
        undefined,
        "replace",
        { kind: "latest" },
      );
      if (
        page &&
        selectedIdRef.current === sessionId &&
        revealRequestGenerationRef.current === generation
      )
        setSentRequestToken((token) => token + 1);
    } catch (error) {
      if (revealRequestGenerationRef.current === generation)
        updateTranscriptPageState(sessionId, (current) => ({
          ...current,
          loadingPage: false,
          pageError: humanErrorMessage(error),
        }));
    }
  }
  function revealTranscriptItem(itemId: string): void {
    const sessionId = selectedIdRef.current;
    if (!sessionId) return;
    const generation = ++revealRequestGenerationRef.current;
    if (transcriptsRef.current[sessionId]?.some((item) => item.id === itemId)) {
      setRevealTarget({ sessionId, itemId });
      return;
    }
    void readTranscriptPage(
      sessionId,
      { aroundId: itemId },
      "replace",
      { kind: "around", id: itemId },
    ).then((page) => {
      if (
        !page ||
        selectedIdRef.current !== sessionId ||
        revealRequestGenerationRef.current !== generation
      )
        return;
      if (!page.items.some((item) => item.id === itemId)) {
        setAppError(t("요청 위치를 대화에서 찾지 못했습니다."));
        return;
      }
      setRevealTarget({ sessionId, itemId });
    }).catch((error) => {
      if (selectedIdRef.current === sessionId &&
          revealRequestGenerationRef.current === generation)
        setAppError(humanErrorMessage(error));
    });
  }
  async function retrySelectedTranscriptPage(): Promise<void> {
    const sessionId = selectedIdRef.current;
    if (!sessionId) return;
    updateTranscriptPageState(sessionId, (current) => ({
      ...current,
      loadingPage: true,
      pageError: "",
      scope: { kind: "latest" },
    }));
    try {
      await readTranscriptPage(sessionId, undefined, "replace", { kind: "latest" });
      void backend.refreshSessionContext?.(sessionId).catch(() => undefined);
    } catch (error) {
      updateTranscriptPageState(sessionId, (current) => ({
        ...current,
        loadingPage: false,
        pageError: humanErrorMessage(error),
      }));
    }
  }
  const selectedCommands = useMemo(() => {
    const live = selectedId ? (commands[selectedId] ?? []) : [];
    return [
      ...new Map(
        [...BUNDLED_GJC_COMMANDS, ...live].map((command) => [
          command.name,
          {
            ...command,
            description: t(command.description),
            ...(command.hint ? { hint: t(command.hint) } : {}),
          },
        ]),
      ).values(),
    ];
  }, [commands, selectedId, language]);
  const selectedConfigOptions = useMemo(
    () => (selectedId && configOptions[selectedId]) || [],
    [configOptions, selectedId],
  );
  // An undefined command list means the live palette has not arrived yet. A
  // terminal-only or recovering row has no SDK endpoint to answer, so it is not
  // left claiming a load that can never finish.
  const commandsPending =
    selectedId !== null &&
    commands[selectedId] === undefined &&
    selectedSession?.attachment !== "terminal-only" &&
    selectedSession?.attachment !== "recovering";
  const onCommandPaletteOpen = useCallback(() => {
    if (!selectedId) return;
    void backend.refreshSessionContext?.(selectedId).catch(() => undefined);
  }, [backend, selectedId]);
  const composerModelPreset =
    selectedSession?.model ?? connection.modelPreset ?? DEFAULT_MODEL_PRESET;
  const composerConfigOptions = useMemo(() => {
    if (
      selectedConfigOptions.some(
        (option) => option.category === "model" || option.id === "model",
      )
    )
      return selectedConfigOptions;
    return [
      {
        id: "model",
        name: t("프리셋"),
        category: "model",
        type: "select" as const,
        currentValue: composerModelPreset,
        options: [
          {
            value: composerModelPreset,
            name: selectedSession?.modelDisplay ?? t("모델 확인 중…"),
          },
        ],
      },
      ...selectedConfigOptions,
    ];
  }, [
    composerModelPreset,
    language,
    selectedConfigOptions,
    selectedSession?.modelDisplay,
  ]);
  const recentWorkspaces = useMemo(
    () => [
      ...new Set(sessions.map((session) => session.workspace).filter(Boolean)),
    ],
    [sessions],
  );

  const selectSession = useCallback((sessionId: string): void => {
    navigationGenerationRef.current += 1;
    setSelectedId(sessionId);
    setNavOpen(false);
    // A find query scoped to the previous conversation's content has nothing to
    // do with the one just opened.
    setFindOpen(false);
    // Picking a session always returns to its conversation, and the project filter
    // is left exactly as the user set it: the point of the project selector is
    // that the context outlives any one session.
    setCenterView("conversation");
    setTranscripts((current) =>
      current[sessionId]
        ? cacheTranscript(current, sessionId, current[sessionId])
        : current,
    );
  }, []);

  const createSession = useCallback(
    (input: {
      title: string;
      workspace: string;
      isolation?: "workspace" | "worktree";
      worktreeBranch?: string;
    }): void => {
      const draftId = `draft-${crypto.randomUUID()}`;
      const draft: AgentSession = {
        id: draftId,
        title: input.title,
        subtitle: directoryName(input.workspace),
        workspace: input.workspace,
        runtime: "gjc",
        status: "starting",
        updatedAt: "now",
        updatedAtMs: Date.now(),
        pinned: false,
        unread: false,
        accent: "#ff8a34",
        ownership: "gajae",
        attachment: "attached",
      };
      setSessions((current) => [draft, ...current]);
      setSelectedId(draftId);
      setTranscripts((current) => cacheTranscript(current, draftId, []));
      setNewSessionOpen(false);
      setAppError("");

      const creation = backend.createSession({
        runtime: "gjc",
        title: input.title,
        workspace: input.workspace,
        isolation: input.isolation ?? "workspace",
        worktreeBranch: input.worktreeBranch,
      });
      pendingSessions.current.set(draftId, creation);
      void creation
        .then((session) => {
          setSessions((current) => [
            session,
            ...current.filter(
              (item) => item.id !== draftId && item.id !== session.id,
            ),
          ]);
          setSelectedId((current) =>
            current === draftId ? session.id : current,
          );
          setTranscripts((current) => {
            const next = { ...current };
            const items = current[session.id] ?? current[draftId] ?? [];
            delete next[draftId];
            return cacheTranscript(next, session.id, items);
          });
        })
        .catch((error) => {
          setSessions((current) =>
            current.map((session) =>
              session.id === draftId
                ? { ...session, status: "failed" }
                : session,
            ),
          );
          setAppError(humanErrorMessage(error));
        });
    },
    [backend],
  );

  const resolveSessionId = useCallback(async (sessionId: string): Promise<string> => {
    return (await pendingSessions.current.get(sessionId))?.id ?? sessionId;
  }, []);

  const cancelRun = useCallback(
    async (sessionId: string): Promise<void> => {
      try {
        await backend.cancelRun(await resolveSessionId(sessionId));
      } catch (error) {
        setAppError(humanErrorMessage(error));
        throw error;
      }
    },
    [backend, resolveSessionId],
  );

  // Dismissible surfaces own Escape while they are up: the key's job there is to
  // close the surface, and cancelling a run behind the dialog the user is reading is
  // never what they asked for. The dialogs only bind Escape on their own fields, so
  // with focus anywhere else in the dialog the key used to reach the abort shortcut.
  const dismissibleSurfaceOpen =
    searchOpen ||
    newSessionOpen ||
    resumeOpen ||
    settingsOpen ||
    findOpen ||
    deleteCandidate !== null;

  useEffect(() => {
    const unsubscribe = window.agentControlDesktop?.onSessionShortcut(
      (shortcut) => {
        if (shortcut.type === "abort") {
          if (surfaceRef.current === "terminal") return;
          const session = selectedSessionRef.current;
          if (session) void cancelRun(session.id).catch(() => undefined);
          return;
        }
        if (shortcut.type === "new") {
          const workspace = selectedSession?.workspace || connection.workspace;
          if (workspace) createSession({ title: "새 Gajae 세션", workspace });
          else setNewSessionOpen(true);
          return;
        }
        const session = shortcutSessions[shortcut.index];
        if (session) selectSession(session.id);
      },
    );
    const unsubscribeAbort = window.agentControlDesktop?.onAbortRun(() => {
      if (surfaceRef.current === "terminal") return;
      const session = selectedSessionRef.current;
      if (session) void cancelRun(session.id).catch(() => undefined);
    });
    function abortWithEscape(event: globalThis.KeyboardEvent): void {
      if (surfaceRef.current === "terminal") return;
      if (
        !escapeCancelsRun({
          key: event.key,
          metaKey: event.metaKey,
          ctrlKey: event.ctrlKey,
          altKey: event.altKey,
          shiftKey: event.shiftKey,
          defaultPrevented: event.defaultPrevented,
          textEntry: isTextEntryTarget(event.target),
          surfaceOpen: dismissibleSurfaceOpen,
        })
      )
        return;
      event.preventDefault();
      const session = selectedSessionRef.current;
      if (session) void cancelRun(session.id).catch(() => undefined);
    }
    // Bubble phase, not capture: a dialog field, the rename editor and the composer
    // are all nearer the key and each one decides for itself whether Escape means
    // "close me" or "stop the run".
    window.addEventListener("keydown", abortWithEscape);
    return () => {
      unsubscribe?.();
      unsubscribeAbort?.();
      window.removeEventListener("keydown", abortWithEscape);
    };
  }, [
    connection.workspace,
    createSession,
    dismissibleSurfaceOpen,
    selectSession,
    selectedSession?.workspace,
    shortcutSessions,
    cancelRun,
  ]);

  // ⌘↵/⌘⌫ approve or reject the currently focused pending approval. MetaKey-gated
  // so it never fights the composer's own Enter handling, and ignored while a
  // dismissible surface is open for the same reason abortWithEscape is.
  useEffect(() => {
    function onApprovalShortcut(event: globalThis.KeyboardEvent): void {
      if (surfaceRef.current === "terminal") return;
      if (!event.metaKey || dismissibleSurfaceOpen) return;
      if (event.key !== "Enter" && event.key !== "Backspace") return;
      const pending = pendingApprovals;
      if (pending.length === 0) return;
      const focused =
        pending.find((tool) => tool.id === focusedApprovalId) ?? pending[0]!;
      const option = focused.permissionOptions?.find((candidate) =>
        event.key === "Enter"
          ? candidate.kind.startsWith("allow")
          : candidate.kind.startsWith("reject"),
      );
      if (!option) return;
      event.preventDefault();
      resolveToolCall(focused.id, option.optionId);
    }
    window.addEventListener("keydown", onApprovalShortcut);
    return () => window.removeEventListener("keydown", onApprovalShortcut);
  }, [dismissibleSurfaceOpen, pendingApprovals, focusedApprovalId, resolveToolCall]);

  // ⌘F: find within the open conversation. Distinct from ⌘K (sidebar's cross-session
  // global search, opened by focusing its own input) -- this one does not compete
  // with a browser/OS find because the window never ships its own, and it is
  // deliberately allowed through from inside a text field the same way a native
  // find shortcut is.
  useEffect(() => {
    function onFindShortcut(event: globalThis.KeyboardEvent): void {
      if (surfaceRef.current === "terminal") return;
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "f") return;
      if (!selectedSessionRef.current) return;
      event.preventDefault();
      setFindOpen(true);
    }
    window.addEventListener("keydown", onFindShortcut);
    return () => window.removeEventListener("keydown", onFindShortcut);
  }, []);

  async function sendMessage(
    sessionId: string,
    input: MessageInput,
    options: ShellSendOptions = {},
  ): Promise<MessageDelivery> {
    const resolvedSessionId = await resolveSessionId(sessionId);
    const tracker = messageDeliveryTrackerRef.current!;
    const session =
      sessionsRef.current.find((candidate) => candidate.id === resolvedSessionId) ??
      (await pendingSessions.current.get(sessionId));
    let baseline =
      transcriptsRef.current[resolvedSessionId] ??
      transcriptsRef.current[sessionId];
    let baselineKnown = baseline !== undefined;
    const pageState = transcriptPageStatesRef.current[resolvedSessionId];
    const isSelectedSend =
      options.quiet !== true && selectedIdRef.current === resolvedSessionId;
    if (isSelectedSend) {
      revealRequestGenerationRef.current += 1;
      setRevealTarget(null);
      if (pendingTranscriptScopesRef.current.get(resolvedSessionId)?.kind === "around") {
        transcriptPageGenerationsRef.current.set(resolvedSessionId,
          (transcriptPageGenerationsRef.current.get(resolvedSessionId) ?? 0) + 1);
        pendingTranscriptScopesRef.current.delete(resolvedSessionId);
        transcriptPageInFlightRef.current.delete(resolvedSessionId);
        updateTranscriptPageState(resolvedSessionId, (current) => ({
          ...current, loadingPage: false, pageError: "", loadingEarlier: false,
        }));
      }
    }
    const mustInstallLatest =
      isSelectedSend &&
      (pageState?.scope.kind === "around" || pageState?.hasMoreAfter === true);
    const needsLatestBaseline =
      !baselineKnown ||
      pageState?.scope.kind === "around" ||
      pageState?.hasMoreAfter === true;
    if (needsLatestBaseline) {
      try {
        if (isSelectedSend)
          updateTranscriptPageState(resolvedSessionId, (current) => ({
            ...current,
            loadingPage: true,
            pageError: "",
          }));
        const latest = isSelectedSend
          ? await readTranscriptPage(
              resolvedSessionId,
              undefined,
              "replace",
              { kind: "latest" },
            )
          : await backend.getTranscriptPage(resolvedSessionId);
        if (!latest) throw new Error(t("최신 대화를 불러오지 못했습니다."));
        baseline = latest.items;
        const lastDurableRequest = lastDurableUserRequest(latest.items);
        const latestIndexedRequest = latest.requests.at(-1);
        baselineKnown = lastDurableRequest
          ? latestIndexedRequest?.id === lastDurableRequest.id
          : latest.requests.length === 0 && !latest.hasMoreBefore;
      } catch (error) {
        if (isSelectedSend)
          updateTranscriptPageState(resolvedSessionId, (current) => ({
            ...current,
            loadingPage: false,
            pageError: humanErrorMessage(error),
          }));
        if (mustInstallLatest) {
          if (options.retryId) {
            const retryGeneration = tracker.submissionGeneration(options.retryId);
            if (retryGeneration !== undefined) {
              tracker.rejectSubmission(
                options.retryId,
                Date.now(),
                retryGeneration,
                true,
              );
              setMessageDeliveryRevision((revision) => revision + 1);
            }
          }
          throw error;
        }
        baseline = baseline ?? [];
        baselineKnown = false;
      }
    } else if (baseline) {
      const durable = lastDurableUserRequest(baseline);
      const summaries = requestSummariesRef.current[resolvedSessionId] ?? [];
      baselineKnown = durable
        ? summaries.length === 0 || summaries.at(-1)?.id === durable.id
        : summaries.length === 0 && !pageState?.hasMoreBefore;
    }
    const now = Date.now();
    const sessionState = deliverySessionState(
      session,
      connectionRef.current.state,
    );
    let deliveryAttemptId = options.retryId;
    if (options.retryId) {
      tracker.submitRetry(
        options.retryId,
        resolvedSessionId,
        baseline ?? [],
        now,
        sessionState,
        baselineKnown,
      );
    } else if (
      isTrackableMessageInput(
        input,
        [...BUNDLED_GJC_COMMANDS, ...(commands[resolvedSessionId] ?? [])],
      )
    ) {
      deliveryAttemptId = tracker.submit(
        resolvedSessionId,
        input,
        baseline ?? [],
        now,
        sessionState,
        baselineKnown,
      );
    }
    const generation = deliveryAttemptId
      ? tracker.submissionGeneration(deliveryAttemptId)
      : undefined;
    setMessageDeliveryRevision((revision) => revision + 1);
    let rendererEchoId: string | undefined;
    const text = input.text.trim();
    const prompt = text.replace(/^\/(?:steer|queue)(?:\s+|$)/u, "").trim();
    if (prompt && (!text.startsWith("/") || /^\/(?:steer|queue)(?:\s+|$)/u.test(text))) {
      const echo: TranscriptItem = {
        id: `local-prompt-renderer-${crypto.randomUUID()}`,
        sessionId: resolvedSessionId, kind: "message", role: "user", content: prompt,
        // Same clock format as the controller's rows, so the label does not
        // change (오후 01:22 -> 13:22) when the confirmed row replaces this one.
        createdAt: new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date()),
        streaming: false,
        ...(input.images.length ? { images: input.images } : {}),
      };
      rendererEchoId = echo.id;
      setTranscripts((current) => {
        const next = cacheTranscript(current, resolvedSessionId,
          mergeTranscriptItem(current[resolvedSessionId] ?? [], echo),
        );
        transcriptsRef.current = next;
        return next;
      });
    }
    // Answering the reader is part of sending: the transcript takes the view to the
    // newest content, so the request they just made and the reply to it appear where
    // they are looking instead of below a scroll position they had left behind.
    if (
      options.quiet !== true &&
      selectedIdRef.current === resolvedSessionId
    ) {
      setSentRequestToken((token) => token + 1);
    }
    try {
      const result = await backend.sendMessage(resolvedSessionId, input);
      if (deliveryAttemptId && generation !== undefined) {
        if (isNotExecutedDelivery(result))
          tracker.markNotExecuted(
            deliveryAttemptId,
            result.detail,
            generation,
            Date.now(),
          );
        else if (options.retryId)
          tracker.finishRetry(deliveryAttemptId, Date.now(), generation);
        else tracker.acceptSubmission(deliveryAttemptId, Date.now(), generation);
        setMessageDeliveryRevision((revision) => revision + 1);
      }
      return result;
    } catch (error) {
      if (rendererEchoId) {
        const echoId = rendererEchoId;
        setTranscripts((current) => {
          const items = current[resolvedSessionId];
          if (!items?.some((item) => item.id === echoId)) return current;
          return {
            ...current,
            [resolvedSessionId]: items.filter((item) => item.id !== echoId),
          };
        });
      }
      if (deliveryAttemptId && generation !== undefined) {
        tracker.rejectSubmission(
          deliveryAttemptId,
          Date.now(),
          generation,
          options.retryId !== undefined,
        );
        setMessageDeliveryRevision((revision) => revision + 1);
      }
      setAppError(humanErrorMessage(error));
      throw error;
    }
  }

  // A run-failure notice's 다시 시도 button: resends the session's own last request
  // rather than making the user retype it. Text only -- the transcript does not
  // keep the original attachments to resend alongside it.
  // The transcript changes on every streaming chunk. Reading it through a ref keeps
  // this callback — and the memoized row that receives it — the same across those
  // chunks. The text is read when the button is pressed, not when the row rendered.
  const sendMessageRef = useRef<ShellSendMessage>(sendMessage);
  sendMessageRef.current = sendMessage;
  const retryMessageDelivery = useCallback((attemptId: string): void => {
    const pending = messageDeliveryTrackerRef.current!.beginRetry(attemptId);
    if (!pending) return;
    setMessageDeliveryRevision((revision) => revision + 1);
    void sendMessageRef.current(pending.sessionId, pending.input, {
      retryId: attemptId,
    }).catch(() => undefined);
  }, []);
  const retryLastRequest = useCallback((sessionId: string): void => {
    const text = lastUserRequestContent(transcriptsRef.current[sessionId] ?? []);
    if (!text) return;
    void sendMessageRef.current(sessionId, { text, images: [], files: [] });
  }, []);

  async function setSessionConfig(
    sessionId: string,
    configId: string,
    value: string,
  ): Promise<void> {
    const previousValue = configOptions[sessionId]?.find(
      (option) => option.id === configId,
    )?.currentValue;
    setConfigOptions((current) => ({
      ...current,
      [sessionId]: (current[sessionId] ?? []).map((option) =>
        option.id === configId ? { ...option, currentValue: value } : option,
      ),
    }));
    try {
      await backend.setSessionConfig(
        await resolveSessionId(sessionId),
        configId,
        value,
      );
    } catch (error) {
      if (previousValue !== undefined) {
        setConfigOptions((current) => ({
          ...current,
          [sessionId]: (current[sessionId] ?? []).map((option) =>
            option.id === configId && option.currentValue === value
              ? { ...option, currentValue: previousValue }
              : option,
          ),
        }));
      }
      setAppError(error instanceof Error ? error.message : String(error));
    }
  }

  async function cycleThinking(sessionId: string): Promise<void> {
    try {
      const level = await backend.cycleThinking(
        await resolveSessionId(sessionId),
      );
      if (!level) {
        setAppError(t("현재 모델은 추론 effort 전환을 지원하지 않습니다."));
      }
    } catch (error) {
      setAppError(humanErrorMessage(error));
    }
  }

  async function compactSession(sessionId: string): Promise<void> {
    try {
      await backend.compactSession(await resolveSessionId(sessionId));
    } catch (error) {
      setAppError(humanErrorMessage(error));
    }
  }

  async function flushQueuedNow(sessionId: string): Promise<void> {
    try {
      const resolved = await resolveSessionId(sessionId);
      await backend.flushQueuedNow(resolved);
    } catch (error) {
      setAppError(humanErrorMessage(error));
      throw error;
    }
  }

  async function renameWorkspace(label: string): Promise<void> {
    try {
      const saved =
        await window.agentControlDesktop?.settings.setWorkspaceLabel(label);
      if (saved)
        setPreferences((current) => ({ ...current, workspaceLabel: saved }));
    } catch (error) {
      setAppError(error instanceof Error ? error.message : String(error));
    }
  }

  async function renameSession(
    sessionId: string,
    title: string,
  ): Promise<void> {
    // The sidebar commits a rename from Enter or blur, so no caller holds this
    // promise: a refused rename reached the renderer's unhandled-rejection queue as
    // its only record. Reporting here also makes the promise it hands back resolve.
    try {
      await backend.renameSession(await resolveSessionId(sessionId), title);
    } catch (error) {
      setAppError(humanErrorMessage(error));
    }
  }

  function openResumePicker(): void {
    setResumeOpen(true);
    setHistoryLoading(true);
    setHistoryError("");
    void backend
      .listHistorySessions()
      .then(setHistorySessions)
      .catch((error) =>
        setHistoryError(
          error instanceof Error ? error.message : String(error),
        ),
      )
      .finally(() => setHistoryLoading(false));
  }

  async function openHistorySession(sessionId: string): Promise<void> {
    const navigationGeneration = ++navigationGenerationRef.current;
    setResumingId(sessionId);
    setHistoryError("");
    setAppError("");
    // The picker's job ends once a session is chosen. Keeping it open over the
    // session it just opened hid the result, and the row exists either way --
    // openHistorySession creates it before attaching -- so a refused attach is
    // reported against the visible session rather than inside the dialog.
    setResumeOpen(false);
    setSelectedId(sessionId);
    try {
      const opened = await backend.openHistorySession(sessionId);
      setSessions((current) => [
        opened,
        ...current.filter((item) => item.id !== opened.id),
      ]);
      if (navigationGenerationRef.current === navigationGeneration)
        setSelectedId(opened.id);
    } catch (error) {
      setAppError(error instanceof Error ? error.message : String(error));
    } finally {
      setResumingId(null);
    }
  }

  async function resumeSession(sessionId: string): Promise<void> {
    setResumingId(sessionId);
    setAppError("");
    try {
      const resumed = await backend.resumeSession(
        await resolveSessionId(sessionId),
      );
      setSessions((current) =>
        current.map((item) => (item.id === resumed.id ? resumed : item)),
      );
    } catch (error) {
      setAppError(error instanceof Error ? error.message : String(error));
    } finally {
      setResumingId(null);
    }
  }

  async function forkSession(session: AgentSession): Promise<void> {
    const navigationGeneration = navigationGenerationRef.current;
    try {
      const fork = await backend.forkSession({
        sourceSessionId: await resolveSessionId(session.id),
        title: t`${sessionTitleText(session.title)} (포크)`,
      });
      setSessions((current) => [
        fork,
        ...current.filter((item) => item.id !== fork.id),
      ]);
      if (navigationGenerationRef.current === navigationGeneration)
        setSelectedId(fork.id);
      setTranscripts((current) => cacheTranscript(current, fork.id, []));
      setSearchQuery("");
    } catch (error) {
      setAppError(error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Everything the shell holds for a session that is gone: its row, its cached
   * transcript, and a selection still pointing at it.
   *
   * The backend's `session.deleted` event and the optimistic delete the user
   * confirms both go through here, so the row leaves the sidebar the same way
   * whichever one arrives first -- and the event that follows an optimistic delete
   * finds nothing left to move.
   */
  const forgetSession = useCallback((sessionId: string): void => {
    setSessions((current) => {
      const remaining = current.filter((session) => session.id !== sessionId);
      setSelectedId((selected) =>
        selected === sessionId ? (remaining[0]?.id ?? null) : selected,
      );
      return remaining;
    });
    setTranscripts((current) => {
      const next = { ...current };
      delete next[sessionId];
      return next;
    });
  }, []);

  /**
   * Hides a session from the rail without deleting anything GJC owns.
   *
   * gjc/0.18.12 cannot complete a saved-history delete through the public SDK
   * (session.delete answers operation_failed with an unknown outcome and leaves
   * the row and transcript in place), so this is the only removal that finishes.
   * It is offered as its own action; the delete path above stays as it was.
   */
  const hideSession = useCallback((sessionId: string): void => {
    const removed = sessions.find((candidate) => candidate.id === sessionId);
    forgetSession(sessionId);
    void backend.hideSession(sessionId).catch((error: unknown) => {
      // Hiding is local bookkeeping, so a failure leaves the rail unchanged and
      // reports why instead of pretending the row went away.
      if (removed)
        setSessions((current) =>
          current.some((session) => session.id === removed.id)
            ? current
            : [removed, ...current],
        );
      setAppError(error instanceof Error ? error.message : String(error));
    });
  }, [backend, forgetSession, sessions]);

  const onHideSession = useCallback(
    (session: AgentSession) => {
      hideSession(session.id);
    },
    [hideSession],
  );

  async function deleteSession(sessionId: string): Promise<void> {
    // The user is the first to know: the backend's delete walks close, broker
    // lookup and delete one CLI call at a time, and the row used to sit in the
    // sidebar for all of it. Drop the row now, keep the copies needed to take it
    // back, and let the `session.deleted` event that follows be a no-op.
    const removed = sessions.find((session) => session.id === sessionId) ?? null;
    const selectionBefore = selectedId;
    // What dropping the selected row will move the selection to; the delete only
    // restores the old selection if it is still on this spot when the backend says
    // no, so a selection the user made meanwhile stands.
    const selectionAfter =
      selectionBefore === sessionId
        ? (sessions.find((session) => session.id !== sessionId)?.id ?? null)
        : selectionBefore;
    forgetSession(sessionId);
    setDeleteCandidate(null);
    try {
      await backend.deleteSession(await resolveSessionId(sessionId));
    } catch (error) {
      // The row never really left. Put it back -- unless it reappeared on its own
      // while the backend worked -- and undo the selection move this delete made.
      if (removed) {
        setSessions((current) =>
          current.some((session) => session.id === removed.id)
            ? current
            : [removed, ...current],
        );
      }
      setSelectedId((current) =>
        current === selectionAfter ? selectionBefore : current,
      );
      setAppError(error instanceof Error ? error.message : String(error));
    }
  }

  // The sidebar is memoized so a streamed transcript chunk stops re-rendering it,
  // measured at 1.1-1.7ms per pass. That only holds if its callbacks keep the same
  // identity, and the handlers above are plain declarations rebuilt on every render.
  // Routing through a ref means the stable wrappers below always call the current
  // ones instead of closing over a stale render's state.
  const handlers = {
    forkSession,
    resumeSession,
    renameSession,
    renameWorkspace,
    installUpdate,
    openResumePicker,
  };
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  const openSearch = useCallback(() => setSearchOpen(true), []);
  const openNewSession = useCallback(() => setNewSessionOpen(true), []);
  const openSettings = useCallback(() => {
    // Remote clients do not edit host preferences; the panel that does lives in
    // the desktop app, where the runtime and workspace it changes also live.
    if (backend.remoteAccess) {
      setAppError(t("설정은 Gajae 데스크톱 앱에서 열 수 있습니다."));
      return;
    }
    setSettingsOpen(true);
  }, [backend]);
  // A card's 펼치기/접기 is optimistic: the click has to land on every visible card at
  // once, and the store is what says whether the write happened. A refused write puts
  // the previous value back, so the window never shows a preference it did not save.
  const toggleThoughtsExpanded = useCallback((): void => {
    const current = preferencesRef.current.thoughtsExpanded;
    const next = !current;
    if (!settingsBridge) {
      // A browser is the remote client of a host, and the preference belongs to the host.
      setAppError(t("설정은 Gajae 데스크톱 앱에서 열 수 있습니다."));
      return;
    }
    setPreferences((latest) => ({ ...latest, thoughtsExpanded: next }));
    void settingsBridge.setThoughtsExpanded(next).then(
      (saved) =>
        setPreferences((latest) => ({
          ...latest,
          thoughtsExpanded: saved,
        })),
      (error: unknown) => {
        setPreferences((latest) => ({
          ...latest,
          thoughtsExpanded: current,
        }));
        setAppError(humanErrorMessage(error));
      },
    );
  }, [settingsBridge]);
  // The header density selector is optimistic for the same reason as the thought
  // toggle: the click has to land immediately, while the store is the authority on
  // whether it persisted. A browser has no host settings bridge, so the density
  // stays local to that client instead of pretending to save on the host.
  const changeToolViewMode = useCallback(
    (next: ToolViewMode): void => {
      const current = preferencesRef.current.toolViewMode;
      if (next === current) return;
      setPreferences((latest) => ({ ...latest, toolViewMode: next }));
      if (!settingsBridge) return;
      void settingsBridge.setToolViewMode(next).then(
        (saved) =>
          setPreferences((latest) => ({ ...latest, toolViewMode: saved })),
        (error: unknown) => {
          setPreferences((latest) => ({
            ...latest,
            toolViewMode: current,
          }));
          setAppError(humanErrorMessage(error));
        },
      );
    },
    [settingsBridge],
  );
  const startFork = useCallback((session: AgentSession) => {
    void handlersRef.current.forkSession(session);
  }, []);
  const startResume = useCallback((session: AgentSession) => {
    void handlersRef.current.resumeSession(session.id);
  }, []);
  const startRename = useCallback((sessionId: string, title: string) => {
    void handlersRef.current.renameSession(sessionId, title);
  }, []);
  const startWorkspaceRename = useCallback((label: string) => {
    void handlersRef.current.renameWorkspace(label);
  }, []);
  const startUpdate = useCallback(() => {
    void handlersRef.current.installUpdate();
  }, []);
  const closeInspector = useCallback(() => setInspectorOpen(false), []);
  // The inspector is memoized for the same reason as the sidebar: it is a child of the
  // shell, so every streamed chunk re-runs it, and it scans the whole transcript to
  // find the few rows it shows. Its callbacks have to keep their identity or the memo
  // never holds.
  const resumeSelectedSession = useCallback(() => {
    const id = selectedIdRef.current;
    if (id) void handlersRef.current.resumeSession(id);
  }, []);
  const openResumePickerStable = useCallback(() => {
    handlersRef.current.openResumePicker();
  }, []);
  // Stable callbacks: the sidebar is memoized, and a new identity here would redraw
  // the whole rail on every streamed chunk.
  const changeProject = useCallback((projectId: string) => {
    setSelectedProjectId(projectId);
    // 전체 프로젝트 is not one repository, so the repository screen has nothing to
    // show: leaving it open would have to pick a project the user never chose.
    if (projectId === ALL_PROJECTS_ID)
      setCenterView((view) => (view === "repository" ? "conversation" : view));
  }, []);
  const openRepository = useCallback(() => setCenterView("repository"), []);
  const openProjects = useCallback(() => setCenterView("projects"), []);
  const openConversation = useCallback(() => setCenterView("conversation"), []);
  const openRepositoryFor = useCallback((projectId: string) => {
    setSelectedProjectId(projectId);
    setCenterView("repository");
  }, []);
  const projectRoot = activeProject?.root;
  const openProjectFolder = useCallback(() => {
    if (!repoBridge || !projectRoot) return;
    void repoBridge.revealFolder(projectRoot).catch((error: unknown) => {
      setAppError(humanErrorMessage(error));
    });
  }, [repoBridge, projectRoot]);
  const openProjectGithub = useCallback(() => {
    if (!repoBridge || !projectRoot) return;
    void repoBridge
      .readRepository(projectRoot)
      .then((snapshot) => {
        const url = snapshot.remote?.webUrl;
        if (!url) {
          setAppError(t("GitHub remote가 없어서 열 수 있는 페이지가 없습니다."));
          return;
        }
        return repoBridge.openExternal(url);
      })
      .catch((error: unknown) => {
        setAppError(humanErrorMessage(error));
      });
  }, [repoBridge, projectRoot]);
  const updateBusyFlag = Boolean(updateBusy);

  // Streaming re-renders the shell on every joined delta. These callbacks stay
  // the same object so the memoized composer does not run again while a reply grows.
  const composerActionsRef = useRef({
    sendMessage,
    cancelRun,
    flushQueuedNow,
    compactSession,
    createSession,
    setSessionConfig,
    cycleThinking,
    session: selectedSession,
  });
  composerActionsRef.current = {
    sendMessage,
    cancelRun,
    flushQueuedNow,
    compactSession,
    createSession,
    setSessionConfig,
    cycleThinking,
    session: selectedSession,
  };
  const onComposerSend = useCallback((input: MessageInput) => {
    const current = composerActionsRef.current;
    const session = current.session;
    if (!session) return Promise.resolve(undefined);
    return current.sendMessage(session.id, input);
  }, []);
  const onComposerCancel = useCallback(() => {
    const session = composerActionsRef.current.session;
    if (!session) return Promise.resolve();
    return composerActionsRef.current.cancelRun(session.id);
  }, []);
  const onComposerFlushQueued = useCallback(() => {
    const session = composerActionsRef.current.session;
    if (!session) return Promise.resolve();
    return composerActionsRef.current.flushQueuedNow(session.id);
  }, []);
  const onComposerCompact = useCallback(() => {
    const session = composerActionsRef.current.session;
    if (!session) return;
    void composerActionsRef.current.compactSession(session.id);
  }, []);
  const onComposerNewSession = useCallback(() => {
    const session = composerActionsRef.current.session;
    if (!session) return;
    composerActionsRef.current.createSession({
      title: "새 Gajae 세션",
      workspace: session.workspace,
    });
  }, []);
  const onComposerWorkspaceChange = useCallback((workspace: string) => {
    composerActionsRef.current.createSession({
      title: "새 Gajae 세션",
      workspace,
    });
  }, []);
  const onComposerConfigChange = useCallback((configId: string, value: string) => {
    const session = composerActionsRef.current.session;
    if (!session) return;
    void composerActionsRef.current.setSessionConfig(session.id, configId, value);
  }, []);
  const onComposerCycleThinking = useCallback(() => {
    const session = composerActionsRef.current.session;
    if (!session) return;
    void composerActionsRef.current.cycleThinking(session.id);
  }, []);
  const onRevealInspector = useCallback((toolId: string) => {
    setInspectorToolId(toolId);
    setInspectorOpen(true);
  }, []);
  const autoDenyHint = useMemo(() => {
    if (
      preferences.permissionHandling === "always-allow" ||
      preferences.permissionHandling === "auto"
    )
      return undefined;
    return {
      message: t("현재 권한 모드 때문에 자동 거부됨"),
      onOpenSettings: openSettings,
    };
  }, [language, openSettings, preferences.permissionHandling]);

  const remoteViewOnly = remoteStatus?.permission === "view";

  if (remoteBridge && remoteGateNeeded(remoteStatus)) {
    return (
      <div className="app-shell app-shell--remote">
        <RemoteGate bridge={remoteBridge} status={remoteStatus} />
      </div>
    );
  }

  return (
    <div className={`app-shell ${navOpen ? "is-nav-open" : ""}`}>
      <button
        className="nav-toggle"
        type="button"
        aria-label={t("세션 목록")}
        aria-expanded={navOpen}
        onClick={() => setNavOpen((open) => !open)}
      >
        <Menu size={18} />
      </button>
      {navOpen && (
        <div
          className="nav-backdrop"
          role="presentation"
          onClick={() => setNavOpen(false)}
        />
      )}
      {remoteBridge && remoteStatus && (
        <RemoteStrip
          status={remoteStatus}
          onReconnect={() => void reconnect()}
        />
      )}
      <Sidebar
        sessions={filteredSessions}
        connection={connection}
        selectedId={selectedId}
        projects={projectGroups}
        projectId={activeProjectId}
        onProjectChange={changeProject}
        onOpenRepository={openRepository}
        onOpenProjects={openProjects}
        onOpenProjectGithub={openProjectGithub}
        onOpenProjectFolder={openProjectFolder}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        onSearchOpen={openSearch}
        onSelect={selectSession}
        onCreate={openNewSession}
        onFork={startFork}
        onResume={startResume}
        onResumePicker={openResumePickerStable}
        onRename={startRename}
        onDelete={setDeleteCandidate}
        onHide={onHideSession}
        onSettings={openSettings}
        workspaceLabel={workspaceLabel}
        onWorkspaceLabelChange={startWorkspaceRename}
        updateStatus={updateStatus}
        updateBusy={updateBusyFlag}
        onUpdate={startUpdate}
      />

      {runtimeUnavailable ? (
        <main className="workspace workspace--empty workspace--offline">
          <span className="workspace-empty__mark">
            <img src={gajaeIconUrl} alt="" />
          </span>
          <h1>{t("GJC runtime에 연결되지 않았습니다")}</h1>
          <p className="workspace-offline__detail">{connection.detail}</p>
          <p className="workspace-offline__hint">
            {t("연결되지 않은 동안에는 세션 목록과 대화 내용을 표시할 수 없습니다.")} </p>
          <div className="workspace-offline__actions">
            <button
              className="button-primary"
              type="button"
              disabled={reconnecting}
              onClick={() => void reconnect()}
            >
              {reconnecting ? <span className="mini-spinner" /> : null}
              {reconnecting ? t("재연결 중") : t("재연결")}
            </button>
            <button
              className="button-secondary"
              type="button"
              onClick={openSettings}
            >
              {t("설정 열기")} </button>
          </div>
        </main>
      ) : centerView === "projects" ? (
        <DeferredProjectList
          projects={projectGroups}
          activeId={activeProjectId}
          onSelect={changeProject}
          onOpenRepository={openRepositoryFor}
          onClose={openConversation}
        />
      ) : centerView === "repository" && activeProject ? (
        <DeferredRepoView
          project={{ root: activeProject.root, name: activeProject.name }}
          sessions={activeProject.sessions}
          backend={backend}
          bridge={repoBridge}
          onOpenSession={selectSession}
          onClose={openConversation}
          onError={setAppError}
        />
      ) : selectedSession ? (
        <main className="workspace" data-surface={surface}>
          <header className="chat-header">
            <div className="chat-identity">
              <span className="header-avatar">
                <img src={gajaeIconUrl} alt="" />
              </span>
              <span>
                <strong>{selectedSession.title}</strong>
                <small>
                  <span
                    className={`presence-inline presence-inline--${selectedSession.phase === "compacting" ? "compacting" : selectedSession.status}`}
                  />
                  {statusLabel(selectedSession.status, selectedSession.phase)}
                  {selectedSession.attachment === "terminal-only" && (
                    <span className="chat-sync">{t("제어 연결 없음 · 기록 동기화 중")}</span>
                  )}
                  {selectedSession.attachment === "recovering" && (
                    <span
                      className="chat-sync"
                      title={t("삭제·재연결 결과를 확인하지 못해 기록을 보존했습니다. 이 세션은 다시 이어서 진행해야 보낼 수 있습니다.")}
                    >
                      {t("복구 필요 · 읽기 전용")} </span>
                  )}
                  {(selectedGit?.branch ||
                    selectedSession.worktree?.branch) && (
                    <span
                      className="chat-branch"
                      title={t`${selectedGit?.workspace ?? selectedSession.workspace}의 현재 Git 브랜치`}
                    >
                      <GitBranch size={11} />
                      {selectedGit?.branch || selectedSession.worktree?.branch}
                    </span>
                  )}
                </small>
              </span>
            </div>
            <div className="chat-header__actions">
              <div className="surface-mode-toggle" role="group" aria-label={t("채팅과 터미널")}>
                <button
                  type="button"
                  className={surface === "chat" ? "is-active" : ""}
                  aria-pressed={surface === "chat"}
                  onClick={() => setSurface("chat")}
                >
                  {t("채팅")}
                </button>
                <button
                  type="button"
                  className={surface === "terminal" ? "is-active" : ""}
                  aria-pressed={surface === "terminal"}
                  data-terminal-toggle
                  onClick={() => {
                    setTerminalMounted(true);
                    setSurface("terminal");
                  }}
                >
                  {t("터미널")}
                </button>
              </div>
              <div className="tool-view-mode-toggle">
                <Dropdown ariaLabel={t("대화 표시 방식")} icon={<Layers size={15} aria-hidden="true" />} value={preferences.toolViewMode} onChange={changeToolViewMode}
                  options={[
                    { value: "basic", label: t("요약"), description: t("도구 요약") },
                    { value: "reasoning", label: t("기본"), description: t("도구 카드") },
                    { value: "detailed", label: t("상세"), description: t("추론까지 펼침") },
                  ]} />
              </div>
              <button
                className={`icon-button ${diffOpen ? "is-active" : ""}`}
                type="button"
                title={t("변경 파일 보기")}
                onClick={() => {
                  setDiffOpen((open) => !open);
                  if (!diffOpen) void refreshDiff();
                }}
              >
                <FolderGit2 size={18} />
              </button>
              <button
                className={`icon-button ${inspectorOpen ? "is-active" : ""}`}
                type="button"
                data-session-info
                title={t("세션 정보")}
                onClick={() => setInspectorOpen((open) => !open)}
              >
                <PanelRight size={18} />
              </button>
            </div>
          </header>

          <div className="workspace-body">
            <section
              className={`conversation conversation--${selectedSession.phase === "compacting" ? "compacting" : selectedSession.status}`}
              hidden={surface === "terminal"}
            >
              {findOpen && (
                <ConversationFindBar
                  items={selectedTranscript}
                  onClose={() => setFindOpen(false)}
                  onReveal={(itemId) =>
                    setRevealTarget({ sessionId: selectedSession.id, itemId })
                  }
                />
              )}
              <RecentRequestStrip
                items={selectedTranscript}
                requestSummaries={requestSummariesBySession[selectedSession.id]}
                onReveal={revealTranscriptItem}
              />
              <Transcript
                sessionId={selectedSession.id}
                items={selectedTranscript}
                hasMoreBefore={selectedTranscriptPageState.hasMoreBefore}
                loadingEarlier={selectedTranscriptPageState.loadingEarlier}
                loadEarlierError={selectedTranscriptPageState.earlierError}
                loadingPage={selectedTranscriptPageState.loadingPage}
                pageLoadError={selectedTranscriptPageState.pageError}
                onLoadEarlier={loadEarlierTranscript}
                onReturnToLatest={returnTranscriptToLatest}
                onRetryPage={retrySelectedTranscriptPage}
                deliveryAttempts={selectedDeliveryAttempts}
                onRetryDelivery={retryMessageDelivery}
                sentRequestToken={sentRequestToken}
                turnSession={{
                  status: selectedSession.status,
                  phase: selectedSession.phase,
                }}
                compacting={selectedSession.phase === "compacting"}
                thoughtsExpanded={preferences.thoughtsExpanded}
                onToggleThoughtsExpanded={toggleThoughtsExpanded}
                toolViewMode={preferences.toolViewMode}
                revealItemId={
                  revealTarget?.sessionId === selectedSession.id
                    ? revealTarget.itemId
                    : undefined
                }
                onRevealComplete={completeReveal}
                onResolveTool={resolveToolCall}
                onAnswerQuestion={answerQuestion}
                onReadArtifact={readArtifact}
                onRetryLastRequest={retryLastRequest}
                onRevealInspector={onRevealInspector}
                autoDenyHint={autoDenyHint}
                emptyStateMeta={{
                  workspace: selectedSession.workspace,
                  modelDisplay: selectedSession.modelDisplay,
                  recentWorkspaces,
                  onWorkspaceChange: (workspace) =>
                    createSession({ title: "새 Gajae 세션", workspace }),
                }}
              />
              <div className="composer-wrap">
                <QuestionBanner
                  pending={pendingQuestionCards}
                  onAnswer={answerQuestion}
                />
                <ApprovalBanner
                  pending={pendingApprovals}
                  focusedId={focusedApprovalId}
                  onReveal={(toolId) => {
                    setFocusedApprovalId(toolId);
                    setRevealTarget({ sessionId: selectedSession.id, itemId: toolId });
                  }}
                  onFocusChange={setFocusedApprovalId}
                />
                <GoalProgressRow
                  goal={goal}
                  busy={goalBusySessionId === selectedSession.id}
                  onOperate={(operation) => void operateGoal(operation)}
                />
                <Composer
                  sessionId={selectedSession.id}
                  running={composerTurnLive(
                    selectedSession,
                    selectedTranscript,
                  )}
                  sessionTitle={selectedSession.title}
                  workspace={selectedSession.workspace}
                  workspaces={recentWorkspaces}
                  commands={selectedCommands}
                  commandsPending={commandsPending}
                  configOptions={composerConfigOptions}
                  modelDisplay={selectedSession.modelDisplay}
                  thinking={selectedSession.thinking}
                  usagePercent={selectedSession.usagePercent}
                  serviceTier={selectedSession.serviceTier}
                  runningSubmission={preferences.runningSubmission}
                  onSend={onComposerSend}
                  onCancel={onComposerCancel}
                  onFlushQueued={onComposerFlushQueued}
                  onCompact={onComposerCompact}
                  onNewSession={onComposerNewSession}
                  onWorkspaceChange={onComposerWorkspaceChange}
                  onConfigChange={onComposerConfigChange}
                  onCycleThinking={onComposerCycleThinking}
                  onCommandPaletteOpen={onCommandPaletteOpen}
                  readOnly={remoteViewOnly}
                />
              </div>
            </section>
            {terminalMounted && (
              <TerminalView
                key={selectedSession.workspace || selectedSession.id}
                cwd={selectedSession.workspace}
                active={surface === "terminal"}
                hidden={surface !== "terminal"}
              />
            )}
            {surface === "chat" && inspectorOpen && (
              <Inspector
                session={selectedSession}
                transcript={selectedTranscript}
                liveSubagents={liveSubagents}
                resuming={resumingId === selectedSession.id}
                onResume={resumeSelectedSession}
                revealToolId={inspectorToolId}
                onClose={closeInspector}
              />
            )}
            {surface === "chat" && diffOpen && (
              <DiffPanel
                session={selectedSession}
                backend={backend}
                diff={diff}
                loading={diffLoading}
                onRefresh={() => void refreshDiff()}
                onClose={() => setDiffOpen(false)}
              />
            )}
          </div>
        </main>
      ) : (
        <main className="workspace workspace--empty">
          <span className="workspace-empty__mark">
            <img src={gajaeIconUrl} alt="" />
          </span>
          <h1>{t("선택된 Gajae 세션이 없습니다")}</h1>
          <button
            className="button-primary"
            type="button"
            onClick={() => setNewSessionOpen(true)}
          >
            <Plus size={16} /> {t("새 세션")} </button>
        </main>
      )}

      {appError && (
        <div className="app-error">
          <span>{appError}</span>
          <button type="button" onClick={() => setAppError("")}>
            <X size={14} />
          </button>
        </div>
      )}
      {searchOpen && (
        <GlobalSearchDialog
          query={searchQuery}
          onQueryChange={setSearchQuery}
          onClose={() => setSearchOpen(false)}
          onPick={(result) => {
            setRevealTarget({
              sessionId: result.sessionId,
              itemId: result.itemId,
            });
            selectSession(result.sessionId);
            setSearchOpen(false);
            setSearchQuery("");
          }}
        />
      )}
      {newSessionOpen && (
        <NewSessionDialog
          defaultWorkspace={connection.workspace}
          onCancel={() => setNewSessionOpen(false)}
          onCreate={createSession}
        />
      )}
      {resumeOpen && (
        <ResumeSessionDialog
          sessions={historySessions}
          loading={historyLoading}
          error={historyError}
          busyId={resumingId}
          onClose={() => setResumeOpen(false)}
          onOpen={(sessionId) => void openHistorySession(sessionId)}
        />
      )}
      {settingsOpen && (
        <DeferredSettingsDialog
          connection={connection}
          thoughtsExpanded={preferences.thoughtsExpanded}
          onClose={() => setSettingsOpen(false)}
          onSaved={(saved) => {
            setPreferences(saved);
            setConnection((current) => ({
              ...current,
              workspace: saved.workspace,
            }));
          }}
          updateStatus={updateStatus}
          updateBusy={updateBusy}
          updateError={updateError}
          onCheckUpdate={() => void checkForUpdate()}
          onInstallUpdate={() => void installUpdate()}
        />
      )}
      {deleteCandidate && (
        <DeleteSessionDialog
          session={deleteCandidate}
          onCancel={() => setDeleteCandidate(null)}
          onConfirm={() => void deleteSession(deleteCandidate.id)}
        />
      )}
    </div>
  );
}
