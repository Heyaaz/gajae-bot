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
} from "../../shared/agent-contract";
import type {
  AgentCommand,
  AgentConfigOption,
  AgentControlPreferences,
  AgentEvent,
  AgentSession,
  BackendConnection,
  MessageInput,
  ToolViewMode,
  TranscriptItem,
} from "../backend/types";
import { useAgentBackend } from "../backend/use-agent-backend";
import {
  cacheTranscript,
  initialSessionId,
  discoveryRevisionIsFresh,
  lastUserRequestContent,
  mergeDiscoveredSessions,
  mergeTranscriptItem,
  pendingToolApprovals,
  updateTranscriptItem,
} from "../transcript-utils";
import { getLanguage, t, useLanguage } from "../i18n";
import { FolderGit2, GitBranch, Layers, Menu, PanelRight, Plus, X } from "lucide-react";
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
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [transcripts, setTranscripts] = useState<
    Record<string, TranscriptItem[]>
  >({});
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
    updateCheckedRef.current = true;
    queueMicrotask(() => void checkForUpdate());
  }, [checkForUpdate]);

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
      void releaseQueuedSession(sessionId, async (request) => {
        // Send directly: this request belongs to the session whose run ended, which
        // may not be the one on screen. The composer's sent-request token would
        // scroll an unrelated transcript.
        await backend.sendMessage(await resolveSessionId(sessionId), {
          text: request.text,
          images: request.images,
          files: request.files,
        });
      }).catch((error: unknown) => setAppError(humanErrorMessage(error)));
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
    // A live tail can miss a file write when a watcher or endpoint drops. The
    // session list poll alone would then leave the selected conversation frozen at
    // an old row and an idle header. Re-read the selected transcript on the same
    // low-frequency beat so the durable session file is a safety net, not only the
    // event stream. getTranscript returns the controller's merged view, including
    // app-owned plan/todo rows, so replacing the cache does not discard them.
    let refreshingTranscript = false;
    const refreshSelectedTranscript = (): void => {
      const id = selectedIdRef.current;
      if (!id || refreshingTranscript) return;
      refreshingTranscript = true;
      void (async () => {
        const revision = await backend
          .getTranscriptRevision?.(id)
          .catch(() => undefined);
        if (revision && transcriptRevisions.current.get(id) === revision) return;
        const items = await backend.getTranscript(id);
        if (!active) return;
        if (revision) transcriptRevisions.current.set(id, revision);
        setTranscripts((current) => cacheTranscript(current, id, items));
      })()
        .catch(() => undefined)
        .finally(() => { refreshingTranscript = false; });
    };
    const refreshVisibleState = (): void => {
      loadSessions(false);
      refreshSelectedTranscript();
    };
    loadSessions(true);
    // A full scan costs seconds on a large broker index, so polling faster than
    // that just queues overlapping scans. Focus refresh covers the case where the
    // user switches to this window right after starting a CLI session.
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
            session.id === event.session.id ? event.session : session,
          ),
        );
      } else if (event.type === "session.deleted") {
        forgetSession(event.sessionId);
      } else if (event.type === "transcript.appended") {
        setTranscripts((current) => {
          const items = current[event.item.sessionId];
          if (!items) return current;
          return cacheTranscript(
            current,
            event.item.sessionId,
            mergeTranscriptItem(items, event.item),
          );
        });
      } else if (event.type === "transcript.synced") {
        setTranscripts((current) =>
          cacheTranscript(current, event.sessionId, event.items),
        );
      } else if (event.type === "message.delta") {
        setTranscripts((current) =>
          updateTranscriptItem(
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
          ),
        );
      } else if (event.type === "message.updated") {
        setTranscripts((current) =>
          updateTranscriptItem(
            current,
            event.message.sessionId,
            event.message.id,
            () => event.message,
          ),
        );
      } else if (event.type === "thought.delta") {
        setTranscripts((current) =>
          updateTranscriptItem(
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
          ),
        );
      } else if (event.type === "plan.updated") {
        setTranscripts((current) =>
          updateTranscriptItem(
            current,
            event.plan.sessionId,
            event.plan.id,
            () => event.plan,
          ),
        );
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
        setTranscripts((current) =>
          updateTranscriptItem(
            current,
            event.tool.sessionId,
            event.tool.id,
            () => event.tool,
          ),
        );
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
  const transcriptReads = useMemo(
    () => ({ backend, pending: new Map<string, Promise<TranscriptItem[]>>() }),
    [backend],
  );
  const transcriptRevisions = useRef(new Map<string, string>());

  useEffect(() => {
    if (!selectedId || cachedSelectedTranscript) return;
    let active = true;
    let read = transcriptReads.pending.get(selectedId);
    if (!read) {
      read = transcriptReads.backend.getTranscript(selectedId).finally(() => {
        if (transcriptReads.pending.get(selectedId) === read)
          transcriptReads.pending.delete(selectedId);
      });
      transcriptReads.pending.set(selectedId, read);
    }
    void read
      .then(async (items) => {
        const revision = await transcriptReads.backend
          .getTranscriptRevision?.(selectedId)
          .catch(() => undefined);
        if (active) {
          if (revision)
            transcriptRevisions.current.set(selectedId, revision);
          setTranscripts((current) =>
            current[selectedId] ? current : cacheTranscript(current, selectedId, items),
          );
          void transcriptReads.backend
            .refreshSessionContext?.(selectedId)
            .catch(() => undefined);
        }
      })
      .catch((error) => {
        if (!active) return;
        setAppError(humanErrorMessage(error));
      });
    return () => {
      active = false;
    };
  }, [backend, selectedId, cachedSelectedTranscript, transcriptReads]);

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
  const pendingApprovals = useMemo(
    () => pendingToolApprovals(selectedTranscript),
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
  const selectedConfigOptions = selectedId
    ? (configOptions[selectedId] ?? [])
    : [];
  const composerConfigOptions = selectedConfigOptions.some(
    (option) => option.category === "model" || option.id === "model",
  )
    ? selectedConfigOptions
    : [
        {
          id: "model",
          name: t("프리셋"),
          category: "model",
          type: "select" as const,
          currentValue:
            selectedSession?.model ??
            connection.modelPreset ??
            DEFAULT_MODEL_PRESET,
          options: [
            {
              value:
                selectedSession?.model ??
                connection.modelPreset ??
                DEFAULT_MODEL_PRESET,
              name: selectedSession?.modelDisplay ?? t("모델 확인 중…"),
            },
          ],
        },
        ...selectedConfigOptions,
      ];
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
      const session = selectedSessionRef.current;
      if (session) void cancelRun(session.id).catch(() => undefined);
    });
    function abortWithEscape(event: globalThis.KeyboardEvent): void {
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
  ): Promise<MessageDelivery> {
    // Answering the reader is part of sending: the transcript takes the view to the
    // newest content, so the request they just made and the reply to it appear where
    // they are looking instead of below a scroll position they had left behind.
    setSentRequestToken((token) => token + 1);
    try {
      return await backend.sendMessage(
        await resolveSessionId(sessionId),
        input,
      );
    } catch (error) {
      setAppError(humanErrorMessage(error));
      throw error;
    }
  }

  // A run-failure notice's 다시 시도 button: resends the session's own last request
  // rather than making the user retype it. Text only -- the transcript does not
  // keep the original attachments to resend alongside it.
  const retryLastRequest = useCallback(
    (sessionId: string): void => {
      const text = lastUserRequestContent(transcripts[sessionId] ?? []);
      if (!text) return;
      void sendMessage(sessionId, { text, images: [], files: [] });
    },
    [transcripts],
  );

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
  function forgetSession(sessionId: string): void {
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
  }

  /**
   * Hides a session from the rail without deleting anything GJC owns.
   *
   * gjc/0.18.12 cannot complete a saved-history delete through the public SDK
   * (session.delete answers operation_failed with an unknown outcome and leaves
   * the row and transcript in place), so this is the only removal that finishes.
   * It is offered as its own action; the delete path above stays as it was.
   */
  function hideSession(sessionId: string): void {
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
  }

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
        onHide={(session) => hideSession(session.id)}
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
        <main className="workspace">
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
                onReveal={(itemId) =>
                  setRevealTarget({ sessionId: selectedSession.id, itemId })
                }
              />
              <Transcript
                sessionId={selectedSession.id}
                items={selectedTranscript}
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
                onReadArtifact={readArtifact}
                onRetryLastRequest={retryLastRequest}
                onRevealInspector={(toolId) => {
                  setInspectorToolId(toolId);
                  setInspectorOpen(true);
                }}
                autoDenyHint={
                  preferences.permissionHandling !== "always-allow" &&
                  preferences.permissionHandling !== "auto"
                    ? {
                        message: t("현재 권한 모드 때문에 자동 거부됨"),
                        onOpenSettings: openSettings,
                      }
                    : undefined
                }
                emptyStateMeta={{
                  workspace: selectedSession.workspace,
                  modelDisplay: selectedSession.modelDisplay,
                  recentWorkspaces,
                  onWorkspaceChange: (workspace) =>
                    createSession({ title: "새 Gajae 세션", workspace }),
                }}
              />
              <div className="composer-wrap">
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
                  configOptions={composerConfigOptions}
                  modelDisplay={selectedSession.modelDisplay}
                  thinking={selectedSession.thinking}
                  usagePercent={selectedSession.usagePercent}
                  serviceTier={selectedSession.serviceTier}
                  runningSubmission={preferences.runningSubmission}
                  onSend={(input) => sendMessage(selectedSession.id, input)}
                  onCancel={() => cancelRun(selectedSession.id)}
                  onFlushQueued={() => flushQueuedNow(selectedSession.id)}
                  onCompact={() => void compactSession(selectedSession.id)}
                  onNewSession={() =>
                    createSession({
                      title: "새 Gajae 세션",
                      workspace: selectedSession.workspace,
                    })
                  }
                  onWorkspaceChange={(workspace) =>
                    createSession({ title: "새 Gajae 세션", workspace })
                  }
                  onConfigChange={(configId, value) =>
                    void setSessionConfig(selectedSession.id, configId, value)
                  }
                  onCycleThinking={() => void cycleThinking(selectedSession.id)}
                  readOnly={remoteViewOnly}
                />
              </div>
            </section>
            {inspectorOpen && (
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
            {diffOpen && (
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
