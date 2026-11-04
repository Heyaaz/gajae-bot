import gajaeIconUrl from "../assets/gajae-icon-ui.png";
import type {
  GoalOperation,
  HistorySession,
} from "../../shared/agent-contract";
import type {
  AgentCommand,
  AgentConfigOption,
  AgentControlPreferences,
  AgentSession,
  BackendConnection,
  MessageInput,
  QuestionSubmission,
} from "../backend/types";
import { useAgentBackend } from "../backend/use-agent-backend";
import {
  cacheTranscript,
  pendingQuestions,
  pendingToolApprovals,
} from "../transcript-utils";
import { getLanguage, t, useLanguage } from "../i18n";
import { Menu, Plus, X } from "lucide-react";
import { TerminalView } from "./terminal-view";
import { TerminalSessionPane } from "./terminal-session-pane";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Composer,
  submitComposerInput,
} from "./composer";
import {
  GlobalSearchDialog,
  NewSessionDialog,
  ResumeSessionDialog,
} from "./dialogs";
import {
  EMPTY_TRANSCRIPT,
  humanErrorMessage,
  sessionTitleText,
} from "./format";
import { DiffPanel, GoalProgressRow, Inspector } from "./inspector";
import { SideQuestionPanel } from "./side-question-panel";
import { sideQuestionText, type SideExchange } from "./side-questions";
import { useSideChat } from "./use-side-chat";
import { useLiveSubagents } from "./use-live-subagents";
import { useParallelGroups } from "./use-parallel-groups";
import { WorkflowStatusCards } from "./workflow-status";
import { RemoteGate, RemoteStrip, remoteGateNeeded } from "./remote";
import {
  DeferredInboxView,
  DeferredParallelView,
  DeferredProjectList,
  DeferredRepoView,
  DeferredSettingsDialog,
} from "./deferred-views";
import { createTranscriptNavigation } from "./transcript-navigation";
import { createSessionActions } from "./session-actions";
import { useGjcUpdate, useRemoteStatus } from "./use-host-status";
import { ChatHeader } from "./chat-header";
import { OnboardingView } from "./onboarding-view";
import type { OnboardingStep } from "../../shared/onboarding";
import { useComposerCallbacks } from "./use-composer-callbacks";
import { usePreferenceToggles } from "./use-preference-toggles";
import { useComposerModel } from "./use-composer-model";
import { useCreateSession } from "./use-create-session";
import { useSessionRemoval } from "./use-session-removal";
import { useProjectModel } from "./use-project-model";
import { useSessionGrouping } from "./session-grouping";
import { useDiff, useGitStatus, useGoal } from "./use-selected-session";
import { useTranscriptStore } from "./use-transcript-store";
import { useMessageDelivery } from "./use-message-delivery";
import { useSendMessage } from "./use-send-message";
import { useInbox } from "./use-inbox";
import { useShellShortcuts } from "./use-shell-shortcuts";
import { useSessionSync } from "./use-session-sync";
import { Sidebar } from "./sidebar";
import type { ParallelDesktopBridge } from "../../shared/parallel-ipc";
import {
  ALL_PROJECTS_ID,
} from "./project-model";
import type { RepoDesktopBridge } from "../../shared/repo-ipc";
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
import {
  DEFAULT_DESKTOP_INTEGRATION,
} from "../../shared/desktop-integration";
import type { NewSessionPrefill } from "../../shared/settings-ipc";
import {
  EMPTY_TRANSCRIPT_PAGE_STATE,
  composerTurnLive,
  invalidLinkMessage,
  syncAppBadge,
  unreadBadgeCount,
} from "./shell-model";
import type {
  CenterView,
  ShellSendMessage,
} from "./shell-model";

export {
  composerTurnLive,
  escapeCancelsRun,
  isTextEntryTarget,
  syncAppBadge,
  unreadBadgeCount,
} from "./shell-model";

const NO_SIDE_EXCHANGES: readonly SideExchange[] = [];

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
  const sendMessageRef = useRef<ShellSendMessage | null>(null);
  const connectionRef = useRef(connection);
  connectionRef.current = connection;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { messageDeliveryTrackerRef, setMessageDeliveryRevision } =
    useMessageDelivery(backend, sessions, connection);
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
  const [settingsTab, setSettingsTab] = useState<"gjc" | "environment">("gjc");
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [inspectorToolId, setInspectorToolId] = useState<string>();
  const [resumingId, setResumingId] = useState<string | null>(null);
  const [focusedApprovalId, setFocusedApprovalId] = useState<string | undefined>(
    undefined,
  );
  const [findOpen, setFindOpen] = useState(false);
  const [diffOpen, setDiffOpen] = useState(false);

  // Each open is its own request: a second prefill while the dialog is up
  // remounts it with the new values instead of being dropped.
  const [newSessionRequest, setNewSessionRequest] = useState<{
    prefill?: NewSessionPrefill;
    serial: number;
  } | null>(null);
  // Bumped for every request this window sends into the open session. The transcript
  // reads it as "the reader asked for this" and takes the view to the newest content,
  // which is the one append that may move a view someone had scrolled away from.
  const [sentRequestToken, setSentRequestToken] = useState(0);
  const [resumeOpen, setResumeOpen] = useState(false);
  const [historySessions, setHistorySessions] = useState<HistorySession[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [appError, setAppError] = useState("");
  // A session link that arrived before the first session list waits for it, so a
  // link that started the app is not reported missing before the list arrives.
  const sessionLinkRef = useRef<{ listed: boolean; waiting?: string }>({
    listed: false,
  });
  // On a phone the session list is a drawer, not a column: 76px of permanent rail
  // is a fifth of the screen. Wide windows never see this control.
  const [navOpen, setNavOpen] = useState(false);
  // Which project the rail is filtered by: the sentinel for the whole rail, or a
  // canonical project root. It is kept across session picks so the context the user
  // chose survives the trip into a conversation.
  const [selectedProjectId, setSelectedProjectId] = useState<string>(
    ALL_PROJECTS_ID,
  );
  // The center area shows one of five things. A session pick always returns to the
  // conversation; the repository screen, the project list, the inbox and a parallel
  // run's comparison are entered on purpose.
  const [centerView, setCenterView] = useState<CenterView>("conversation");
  // Best-of-N groups as the main process holds them, and the one the comparison
  // view shows when the center area is on it.
  const [parallelGroupId, setParallelGroupId] = useState<string | null>(null);
  const [surface, setSurface] = useState<"chat" | "terminal">("chat");
  const [terminalMounted, setTerminalMounted] = useState(false);
  const surfaceRef = useRef(surface);
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
    desktopIntegration: DEFAULT_DESKTOP_INTEGRATION,
    language: getLanguage(),
    runningSubmission: "queue",
    newSessionKind: "app",
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
  // Rows the user removed while the backend still works on it; a list refresh
  // in that window must not bring them back.
  const removingSessionIdsRef = useRef(new Set<string>());
  const navigationGenerationRef = useRef(0);
  const revealRequestGenerationRef = useRef(0);

  const {
    transcripts,
    setTranscripts,
    transcriptsRef,
    transcriptPageStates,
    transcriptPageStatesRef,
    requestSummariesBySession,
    requestSummariesRef,
    initialPageReadsRef,
    transcriptPageGenerationsRef,
    transcriptPageInFlightRef,
    transcriptEventVersionsRef,
    transcriptRevisionsRef,
    transcriptItemVersionsRef,
    pendingTranscriptScopesRef,
    updateTranscriptPageState,
    noteTranscriptEvent,
    tracksTranscriptSession,
    updateRequestSummaries,
    readTranscriptPage,
    refreshTranscriptPage,
    mergeLiveTranscriptItems,
  } = useTranscriptStore(backend);


  useEffect(() => {
    if (!appError) return;
    const timer = window.setTimeout(() => setAppError(""), 4_500);
    return () => window.clearTimeout(timer);
  }, [appError]);
  const settingsBridge = window.agentControlDesktop?.settings;
  const remoteBridge = backend.remoteAccess;
  const remoteStatus = useRemoteStatus(backend);

  const onboardingBridge = window.agentControlDesktop?.onboarding;
  const [onboardingStep, setOnboardingStep] = useState<OnboardingStep | null>(null);
  // A Mac that has never run GJC opens on first-run setup. Past that, until every
  // required tool has been seen working once, the window opens on the environment
  // check so a fresh install shows what is missing before a session fails on it. A
  // host without either channel (an older main, a smoke) just skips it.
  useEffect(() => {
    let active = true;
    void (async () => {
      const step = await onboardingBridge?.pendingStep().catch(() => null);
      if (!active) return;
      if (step) {
        setOnboardingStep(step);
        return;
      }
      const due = await settingsBridge?.environmentCheckDue().catch(() => false);
      if (!active || !due) return;
      setSettingsTab("environment");
      setSettingsOpen(true);
    })();
    return () => {
      active = false;
    };
  }, [onboardingBridge, settingsBridge]);

  const { updateStatus, updateBusy, updateError, checkForUpdate, installUpdate } =
    useGjcUpdate(settingsBridge, connection.state, setSettingsOpen);

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
    transcriptRevisionsRef.current.delete(sessionId);
  }, []);

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

  const openLinkedSession = useCallback(
    (sessionId: string, known: readonly AgentSession[]): void => {
      if (known.some((session) => session.id === sessionId))
        selectSession(sessionId);
      else setAppError(invalidLinkMessage({ kind: "session" }));
    },
    [selectSession],
  );

  const [turnCompletion, setTurnCompletion] = useState<{ sessionId: string }>();
  const onTurnCompleted = useCallback((sessionId: string) => {
    // Only the session on screen can show a suggestion, so a background session
    // finishing never costs a model call.
    if (sessionId === selectedIdRef.current) setTurnCompletion({ sessionId });
  }, []);
  const suggestNextInput = useMemo(
    () => (backend.suggestNextInput ? (sessionId: string) => backend.suggestNextInput!(sessionId) : undefined),
    [backend],
  );

  useSessionSync({
    onTurnCompleted,
    backend,
    sessionsRef,
    selectedIdRef,
    sendMessageRef,
    messageDeliveryTrackerRef,
    removingSessionIdsRef,
    sessionLinkRef,
    setConnection,
    setSessions,
    setSelectedId,
    setTranscripts,
    setCommands,
    setConfigOptions,
    setMessageDeliveryRevision,
    setAppError,
    forgetSession,
    openLinkedSession,
    transcriptsRef,
    transcriptPageStatesRef,
    transcriptRevisionsRef,
    transcriptEventVersionsRef,
    tracksTranscriptSession,
    noteTranscriptEvent,
    updateRequestSummaries,
    mergeLiveTranscriptItems,
    refreshTranscriptPage,
  });

  const selectedSession =
    sessions.find((session) => session.id === selectedId) ?? null;
  // A terminal session has no conversation, so nothing below that reads one
  // from GJC runs for it; `chatId` is the selection those reads follow.
  const terminalSession = selectedSession?.runtime === "terminal" ? selectedSession : null;
  const chatId = terminalSession ? null : selectedId;
  const selectedSessionId = terminalSession ? undefined : selectedSession?.id;
  const selectedSessionStatus = selectedSession?.status;
  const selectedSessionRef = useRef(selectedSession);
  selectedSessionRef.current = selectedSession;
  selectedIdRef.current = selectedId;
  // Shortcuts that would steal keys from a terminal check this.
  const shownSurface = terminalSession ? "terminal" : surface;
  useEffect(() => {
    surfaceRef.current = shownSurface;
  }, [shownSurface]);
  const cachedSelectedTranscript = chatId ? transcripts[chatId] : undefined;

  useEffect(() => {
    const ids = Object.keys(transcripts);
    if (chatId && !ids.includes(chatId)) ids.push(chatId);
    backend.watchTranscripts?.(ids);
  }, [backend, transcripts, chatId]);

  useEffect(() => {
    const selectedId = chatId;
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
  }, [backend, chatId, cachedSelectedTranscript]);

  const { goal, setGoal, goalRescheduleRef, goalBusySessionId, setGoalBusySessionId } = useGoal(
    backend,
    selectedIdRef,
    selectedSessionId,
    selectedSessionStatus,
  );

  const liveSubagents = useLiveSubagents(backend, selectedSessionId, inspectorOpen);

  const { toggleInbox, inboxCount } = useInbox(
    backend,
    chatId,
    centerView,
    selectedSession,
    sessions,
    setNavOpen,
    setCenterView,
  );

  // The main process cannot infer which session a focused window is showing from
  // focus alone. Naming it lets notifications skip the turn being watched instead
  // of pinging the user about their own screen.
  useEffect(() => {
    const bridge = window.agentControlDesktop?.settings;
    if (!bridge) return;
    void bridge.setViewedSession(chatId).catch(() => undefined);
  }, [chatId]);

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

  const selectedGit = useGitStatus(backend, selectedSessionId, selectedSessionStatus);

  const { diff, diffLoading, refreshDiff } = useDiff(
    backend,
    diffOpen,
    chatId,
    selectedIdRef,
    selectedSession?.workspace,
  );



  async function operateGoal(operation: GoalOperation): Promise<void> {
    const sessionId = selectedId;
    if (!sessionId || goalBusySessionId === sessionId) return;
    setGoalBusySessionId(sessionId);
    try {
      const snapshot = await backend.operateGoal(sessionId, operation);
      if (selectedIdRef.current === sessionId) {
        setGoal(snapshot);
        goalRescheduleRef.current(snapshot);
      }
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
  const parallelBridge: ParallelDesktopBridge | null =
    window.agentControlDesktop?.parallel ?? null;
  const parallelGroups = useParallelGroups(parallelBridge);
  const sessionGrouping = useSessionGrouping();
  const {
    projectGroups,
    activeProjectId,
    activeProject,
    filteredSessions,
    shortcutSessions,
    projectOf,
  } = useProjectModel(
    sessions,
    parallelGroups,
    repoBridge,
    selectedProjectId,
    sessionGrouping.grouping,
    sessionGrouping.collapsedProjects,
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
    (toolId: string, optionId: string, comment?: string) => {
      backend.resolveToolCall(toolId, { optionId, ...(comment ? { comment } : {}) }).catch((error: unknown) => {
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
  const {
    loadEarlierTranscript,
    returnTranscriptToLatest,
    revealTranscriptItem,
    retrySelectedTranscriptPage,
  } = createTranscriptNavigation({
    backend,
    selectedIdRef,
    transcriptsRef,
    transcriptPageStatesRef,
    revealRequestGenerationRef,
    setRevealTarget,
    setSentRequestToken,
    setAppError,
    updateTranscriptPageState,
    readTranscriptPage,
  });
  const {
    selectedCommands,
    commandsPending,
    onCommandPaletteOpen,
    composerConfigOptions,
  } = useComposerModel(
    backend,
    commands,
    configOptions,
    chatId,
    terminalSession ? null : selectedSession,
    connection,
    language,
  );
  const recentWorkspaces = useMemo(
    () => [
      ...new Set(sessions.map((session) => session.workspace).filter(Boolean)),
    ],
    [sessions],
  );

  const newSessionRequestRef = useRef(newSessionRequest);
  newSessionRequestRef.current = newSessionRequest;

  const openNewSessionDialog = useCallback(
    (prefill?: NewSessionPrefill): void => {
      // A second request remounts the dialog, which never runs its own cancel;
      // the first request's screenshots are given back here instead.
      const abandoned = (newSessionRequestRef.current?.prefill?.images ?? []).flatMap(
        (image) => (image.token ? [image.token] : []),
      );
      if (abandoned.length > 0)
        void window.agentControlDesktop?.settings
          ?.discardAttachments(abandoned)
          .catch(() => undefined);
      setNewSessionRequest((current) => ({
        prefill,
        serial: (current?.serial ?? 0) + 1,
      }));
    },
    [],
  );

  const openParallelGroup = useCallback((groupId: string): void => {
    setParallelGroupId(groupId);
    setNavOpen(false);
    setCenterView("parallel");
  }, []);

  const createSession = useCreateSession(
    backend,
    pendingSessions,
    setAppError,
    setNewSessionRequest,
    setSessions,
    setSelectedId,
    setTranscripts,
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

  useShellShortcuts({
    surfaceRef,
    selectedSessionRef,
    sessionLinkRef,
    sessionsRef,
    connection,
    selectedSession,
    centerView,
    searchOpen,
    newSessionRequest,
    resumeOpen,
    settingsOpen,
    findOpen,
    shortcutSessions,
    pendingApprovals,
    focusedApprovalId,
    createSession,
    cancelRun,
    openLinkedSession,
    openNewSessionDialog,
    openParallelGroup,
    selectSession,
    resolveToolCall,
    toggleInbox,
    setAppError,
    setSearchOpen,
    setFindOpen,
  });

  const { sendMessage, retryMessageDelivery, retryLastRequest } = useSendMessage({
    backend,
    sessionsRef,
    connectionRef,
    commands,
    pendingSessions,
    selectedIdRef,
    revealRequestGenerationRef,
    messageDeliveryTrackerRef,
    sendMessageRef,
    resolveSessionId,
    setRevealTarget,
    setSentRequestToken,
    setMessageDeliveryRevision,
    setTranscripts,
    setAppError,
    transcriptsRef,
    transcriptPageStatesRef,
    requestSummariesRef,
    pendingTranscriptScopesRef,
    transcriptPageGenerationsRef,
    transcriptPageInFlightRef,
    transcriptItemVersionsRef,
    updateTranscriptPageState,
    readTranscriptPage,
  });

  const controlSelectedRetry = useCallback(
    (action: "now" | "abort"): void => {
      if (!chatId) return;
      void backend.controlRetry?.(chatId, action).catch((error: unknown) =>
        setAppError(humanErrorMessage(error)),
      );
    },
    [backend, chatId],
  );

  const {
    setSessionConfig,
    cycleThinking,
    compactSession,
    flushQueuedNow,
    renameWorkspace,
    renameSession,
    openResumePicker,
    resumeSession,
  } = createSessionActions({
    backend,
    configOptions,
    resolveSessionId,
    setAppError,
    setConfigOptions,
    setPreferences,
    setSessions,
    setResumeOpen,
    setHistoryLoading,
    setHistoryError,
    setHistorySessions,
    setResumingId,
  });

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

  const { onHideSession, onDeleteSession } = useSessionRemoval(
    backend,
    removingSessionIdsRef,
    sessions,
    selectedId,
    forgetSession,
    resolveSessionId,
    setSessions,
    setSelectedId,
    setAppError,
  );

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
  const openNewSession = useCallback(
    () => openNewSessionDialog(),
    [openNewSessionDialog],
  );
  const openSettings = useCallback(() => {
    // Remote clients do not edit host preferences; the panel that does lives in
    // the desktop app, where the runtime and workspace it changes also live.
    if (backend.remoteAccess) {
      setAppError(t("설정은 Gajae 데스크톱 앱에서 열 수 있습니다."));
      return;
    }
    setSettingsOpen(true);
  }, [backend]);
  const { toggleThoughtsExpanded, changeToolViewMode } = usePreferenceToggles(
    settingsBridge,
    preferencesRef,
    setPreferences,
    setAppError,
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
  const openGroup = parallelGroups.find((group) => group.id === parallelGroupId);
  const openInboxSession = selectSession;
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

  const {
    askSideBackend,
    sideOpen,
    setSideOpen,
    sideThreads,
    askSide,
    retrySide,
    clearSide,
    sideUnsupported,
    askSideFromComposer,
  } = useSideChat(backend, selectedCommands, commandsPending, surfaceRef, selectedSessionRef);

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
    askSide: askSideFromComposer,
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
    askSide: askSideFromComposer,
    session: selectedSession,
  };
  const onComposerSend = useCallback((input: MessageInput) => {
    const current = composerActionsRef.current;
    const session = current.session;
    if (!session) return Promise.resolve(undefined);
    // `/btw` answers in the side panel instead of the conversation.
    const question = current.askSide ? sideQuestionText(input) : undefined;
    if (question !== undefined) {
      current.askSide?.(session.id, question);
      return Promise.resolve(undefined);
    }
    return current.sendMessage(session.id, input);
  }, []);
  // A diff review is submitted as if typed into that session's composer, so a
  // live turn holds it as a row instead of sending it.
  const submitReview = useCallback((sessionId: string, text: string) => {
    submitComposerInput(sessionId, { text, images: [], files: [] }, {
      running: composerTurnLive(
        sessionsRef.current.find((session) => session.id === sessionId) ?? null,
        transcriptsRef.current[sessionId] ?? EMPTY_TRANSCRIPT,
      ),
      runningSubmission: preferencesRef.current.runningSubmission,
      send: (input) => sendMessageRef.current!(sessionId, input),
    });
  }, []);
  const {
    onComposerCancel,
    onComposerFlushQueued,
    onComposerCompact,
    onComposerNewSession,
    onComposerWorkspaceChange,
    onComposerConfigChange,
    onComposerCycleThinking,
  } = useComposerCallbacks(composerActionsRef);
  const onRevealInspector = useCallback((toolId: string) => {
    setInspectorToolId(toolId);
    setInspectorOpen(true);
  }, []);
  const approvalChannel = selectedSession?.approvalChannel === true;
  const autoDenyHint = useMemo(() => {
    if (
      approvalChannel ||
      preferences.permissionHandling === "always-allow" ||
      preferences.permissionHandling === "auto"
    )
      return undefined;
    return {
      message: t("현재 권한 모드 때문에 자동 거부됨"),
      onOpenSettings: openSettings,
    };
  }, [approvalChannel, language, openSettings, preferences.permissionHandling]);

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
        grouping={sessionGrouping.grouping}
        onGroupingChange={sessionGrouping.setGrouping}
        projectOf={projectOf}
        collapsedProjects={sessionGrouping.collapsedProjects}
        onToggleProject={sessionGrouping.toggleProject}
        onOpenRepository={openRepository}
        onOpenProjects={openProjects}
        inboxCount={inboxCount}
        inboxOpen={centerView === "inbox"}
        onToggleInbox={toggleInbox}
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
        onDelete={onDeleteSession}
        onHide={onHideSession}
        onSettings={openSettings}
        workspaceLabel={workspaceLabel}
        onWorkspaceLabelChange={startWorkspaceRename}
        updateStatus={updateStatus}
        updateBusy={updateBusyFlag}
        onUpdate={startUpdate}
        parallelGroups={parallelGroups}
        openParallelGroupId={centerView === "parallel" ? parallelGroupId : null}
        onOpenParallelGroup={openParallelGroup}
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
      ) : centerView === "inbox" ? (
        <DeferredInboxView
          sessions={sessions}
          projects={projectGroups}
          transcripts={transcripts}
          automations={window.agentControlDesktop?.automations}
          onOpenSession={openInboxSession}
          onClose={openConversation}
        />
      ) : centerView === "parallel" && openGroup && parallelBridge ? (
        <DeferredParallelView
          group={openGroup}
          sessions={sessions}
          backend={backend}
          bridge={parallelBridge}
          onOpenSession={selectSession}
          onClose={openConversation}
          onError={setAppError}
          onSubmitReview={remoteViewOnly ? undefined : submitReview}
        />
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
          onStartSession={openNewSessionDialog}
          onClose={openConversation}
          onError={setAppError}
          onSubmitReview={remoteViewOnly ? undefined : submitReview}
        />
      ) : terminalSession ? (
        <TerminalSessionPane session={terminalSession} />
      ) : selectedSession ? (
        <main className="workspace" data-surface={surface}>
          <ChatHeader
            selectedSession={selectedSession}
            selectedGit={selectedGit}
            surface={surface}
            setSurface={setSurface}
            setTerminalMounted={setTerminalMounted}
            toolViewMode={preferences.toolViewMode}
            changeToolViewMode={changeToolViewMode}
            diffOpen={diffOpen}
            setDiffOpen={setDiffOpen}
            inspectorOpen={inspectorOpen}
            setInspectorOpen={setInspectorOpen}
            {...(askSideBackend ? { sideOpen, setSideOpen } : {})}
          />

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
                  retrying:
                    selectedSession.status === "running" && selectedSession.retry !== undefined,
                }}
                retry={selectedSession.retry}
                onControlRetry={backend.controlRetry ? controlSelectedRetry : undefined}
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
                <WorkflowStatusCards progress={goal.progress} />
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
                  onSuggestNextInput={suggestNextInput}
                  turnCompletion={turnCompletion}
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
            {surface === "chat" && sideOpen && askSideBackend && (
              <SideQuestionPanel
                key={selectedSession.id}
                exchanges={sideThreads[selectedSession.id] ?? NO_SIDE_EXCHANGES}
                unsupported={sideUnsupported}
                onAsk={(question) => askSide(selectedSession.id, question)}
                onRetry={(id) => retrySide(selectedSession.id, id)}
                onClear={() => clearSide(selectedSession.id)}
                onClose={() => setSideOpen(false)}
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
                onSubmitReview={remoteViewOnly ? undefined : submitReview}
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
            onClick={openNewSession}
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
      {/* One modal at a time. A link that arrives during the first run's
          environment check waits until it closes: the session it starts needs
          what the check is reporting on. */}
      {newSessionRequest && !settingsOpen && (
        <NewSessionDialog
          key={newSessionRequest.serial}
          defaultWorkspace={connection.workspace}
          prefill={newSessionRequest.prefill}
          kind={
            backend.terminalSessions === true && preferences.newSessionKind === "cli"
              ? "terminal"
              : "gjc"
          }
          onCancel={() => setNewSessionRequest(null)}
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
          onToggleThoughtsExpanded={toggleThoughtsExpanded}
          onClose={() => {
            setSettingsOpen(false);
            setSettingsTab("gjc");
            // Choices the dialog saves on change, such as the new-session kind,
            // never pass through onSaved.
            void window.agentControlDesktop?.settings
              .getPreferences()
              .then(setPreferences)
              .catch(() => undefined);
          }}
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
          initialTab={settingsTab}
        />
      )}
      {onboardingStep && onboardingBridge && (
        <OnboardingView
          bridge={onboardingBridge}
          step={onboardingStep}
          onClose={() => setOnboardingStep(null)}
          onStartConversation={() => openNewSessionDialog()}
        />
      )}
    </div>
  );
}
