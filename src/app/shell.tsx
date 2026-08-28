import gajaeIconUrl from "../assets/gajae-icon.png";
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
  AgentEvent,
  AgentSession,
  BackendConnection,
  MessageInput,
  TranscriptItem,
} from "../backend/types";
import { useAgentBackend } from "../backend/use-agent-backend";
import {
  cacheTranscript,
  initialSessionId,
  mergeDiscoveredSessions,
  mergeTranscriptItem,
  orderedSessionsForShortcuts,
  updateTranscriptItem,
} from "../transcript-utils";
import { FolderGit2, GitBranch, PanelRight, Plus, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Composer } from "./composer";
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
  profileFromDetail,
  statusLabel,
} from "./format";
import { DiffPanel, GoalProgressRow, Inspector } from "./inspector";
import { SettingsDialog } from "./settings";
import { Sidebar } from "./sidebar";
import { RecentRequestStrip, Transcript } from "./transcript";

export default function App() {
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
  const [resumingId, setResumingId] = useState<string | null>(null);
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
  const [goalBusy, setGoalBusy] = useState(false);
  const [liveSubagents, setLiveSubagents] = useState<SubagentSnapshot[]>([]);
  const [diffLoading, setDiffLoading] = useState(false);
  const [deleteCandidate, setDeleteCandidate] = useState<AgentSession | null>(
    null,
  );
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const [resumeOpen, setResumeOpen] = useState(false);
  const [historySessions, setHistorySessions] = useState<HistorySession[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [appError, setAppError] = useState("");
  const [workspaceLabel, setWorkspaceLabel] = useState("개인 Workspace");
  const pendingSessions = useRef(new Map<string, Promise<AgentSession>>());
  const selectedIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!appError) return;
    const timer = window.setTimeout(() => setAppError(""), 4_500);
    return () => window.clearTimeout(timer);
  }, [appError]);
  const updateCheckedRef = useRef(false);
  const settingsBridge = window.agentControlDesktop?.settings;

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
        `GJC ${updateStatus.latestVersion}(으)로 업데이트할까요? 업데이트 후 GJC runtime이 다시 연결됩니다.`,
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
    void settingsBridge.getPreferences().then((preferences) => {
      if (active) setWorkspaceLabel(preferences.workspaceLabel);
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
    // A GJC session started from the CLI after this window opened only shows up if
    // discovery runs again, so the list refreshes instead of loading once.
    const loadSessions = (initial: boolean): void => {
      void backend
        .listSessions()
        .then((loadedSessions) => {
          if (!active) return;
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
        .catch(() => undefined);
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
      loadSessions(false);
    }, 15_000);
    const refreshOnFocus = (): void => loadSessions(false);
    window.addEventListener("focus", refreshOnFocus);
    // `focus` does not fire when the window is merely un-occluded on macOS, so
    // visibility is tracked separately to catch up after a hidden stretch.
    const refreshOnVisible = (): void => {
      if (!document.hidden) loadSessions(false);
    };
    document.addEventListener("visibilitychange", refreshOnVisible);

    const unsubscribe = backend.subscribe((event: AgentEvent) => {
      if (event.type === "connection.updated") {
        setConnection(event.connection);
      } else if (event.type === "session.created") {
        setSessions((current) => [
          event.session,
          ...current.filter((session) => session.id !== event.session.id),
        ]);
      } else if (event.type === "session.updated") {
        setSessions((current) =>
          current.map((session) =>
            session.id === event.session.id ? event.session : session,
          ),
        );
      } else if (event.type === "session.deleted") {
        setSessions((current) => {
          const remaining = current.filter(
            (session) => session.id !== event.sessionId,
          );
          setSelectedId((selected) =>
            selected === event.sessionId
              ? (remaining[0]?.id ?? null)
              : selected,
          );
          return remaining;
        });
        setTranscripts((current) => {
          const next = { ...current };
          delete next[event.sessionId];
          return next;
        });
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
      window.removeEventListener("focus", refreshOnFocus);
      document.removeEventListener("visibilitychange", refreshOnVisible);
      unsubscribe();
    };
  }, [backend]);

  const selectedSession =
    sessions.find((session) => session.id === selectedId) ?? null;
  const selectedSessionId = selectedSession?.id;
  const selectedSessionStatus = selectedSession?.status;
  const selectedSessionRef = useRef(selectedSession);
  selectedSessionRef.current = selectedSession;

  useEffect(() => {
    if (!selectedId) return;
    if (transcripts[selectedId]) return;
    let active = true;
    void backend
      .getTranscript(selectedId)
      .then((items) => {
        if (active)
          setTranscripts((current) =>
            cacheTranscript(current, selectedId, items),
          );
      })
      .catch((error) => {
        if (!active) return;
        setTranscripts((current) => cacheTranscript(current, selectedId, []));
        setAppError(humanErrorMessage(error));
      });
    return () => {
      active = false;
    };
  }, [backend, selectedId, transcripts]);

  useEffect(() => {
    if (!selectedSessionId) return;
    let active = true;
    const refresh = (): void => {
      void backend
        .getGoal(selectedSessionId)
        .then((snapshot) => {
          if (active) setGoal(snapshot);
        })
        .catch(() => {
          if (active) setGoal({ enabled: false, completed: 0, total: 0 });
        });
    };
    queueMicrotask(refresh);
    // Goal and todo state advance at tool-call pace, not at streaming pace. Two
    // round trips every 1.5s on the shared ACP channel cost more than the
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
    if (!selectedId || goalBusy) return;
    setGoalBusy(true);
    try {
      setGoal(await backend.operateGoal(selectedId, operation));
    } catch (error) {
      setAppError(humanErrorMessage(error));
    } finally {
      setGoalBusy(false);
    }
  }

  const filteredSessions = sessions;
  const shortcutSessions = useMemo(
    () => orderedSessionsForShortcuts(filteredSessions),
    [filteredSessions],
  );

  // Nothing is hidden any more: a request the composer is still holding was never
  // sent, so it cannot appear here, and anything that did reach GJC is an ordinary
  // user message.
  const selectedTranscript = selectedId
    ? (transcripts[selectedId] ?? EMPTY_TRANSCRIPT)
    : EMPTY_TRANSCRIPT;
  // Live work means the transcript is still producing output right now:
  // something is streaming or a tool is mid-execution.
  //
  // Two states deliberately do NOT count, because both outlive their turn and
  // treating either as running left the composer queueing every later message
  // while the header read idle -- the message only went out after some unrelated
  // interaction: a tool card awaiting approval, and a plan entry left at
  // in_progress once the turn ended.
  const transcriptHasLiveWork = selectedTranscript.some((item) => {
    if (item.kind === "message" || item.kind === "thought")
      return item.streaming === true;
    if (item.kind === "tool") return item.status === "running";
    return false;
  });
  // Queue state changes when the turn starts or ends, not on every streamed
  // chunk. Keying this on transcript length re-listed the queue over the shared
  // ACP channel for each chunk, which is what made sending feel slow.
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
  const readArtifact = useCallback(
    (artifactId: string) => {
      if (!selectedId)
        return Promise.reject(new Error("선택된 세션이 없습니다."));
      return backend.readArtifact(
        selectedId,
        artifactId.replace(/^artifact:\/\//u, ""),
      );
    },
    [backend, selectedId],
  );
  const previewFile = useCallback(
    (filePath: string) => {
      if (!selectedId)
        return Promise.reject(new Error("선택된 세션이 없습니다."));
      return backend.previewFile(selectedId, filePath);
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
          command,
        ]),
      ).values(),
    ];
  }, [commands, selectedId]);
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
          name: "프리셋",
          category: "model",
          type: "select" as const,
          currentValue:
            selectedSession?.model ?? profileFromDetail(connection.detail),
          options: [
            {
              value:
                selectedSession?.model ?? profileFromDetail(connection.detail),
              name: selectedSession?.modelDisplay ?? "모델 확인 중…",
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
    setSelectedId(sessionId);
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

  useEffect(() => {
    const unsubscribe = window.agentControlDesktop?.onSessionShortcut(
      (shortcut) => {
        if (shortcut.type === "abort") {
          const session = selectedSessionRef.current;
          if (session) void cancelRun(session.id);
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
      if (session) void cancelRun(session.id);
    });
    function abortWithEscape(event: globalThis.KeyboardEvent): void {
      if (
        (event.key !== "Escape" && event.key !== "Esc") ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey
      )
        return;
      if (searchOpen || settingsOpen || newSessionOpen || deleteCandidate)
        return;
      event.preventDefault();
      const session = selectedSessionRef.current;
      if (session) void cancelRun(session.id);
    }
    window.addEventListener("keydown", abortWithEscape, true);
    return () => {
      unsubscribe?.();
      unsubscribeAbort?.();
      window.removeEventListener("keydown", abortWithEscape, true);
    };
  }, [
    connection.workspace,
    createSession,
    deleteCandidate,
    newSessionOpen,
    searchOpen,
    selectSession,
    selectedSession?.workspace,
    settingsOpen,
    shortcutSessions,
  ]);

  async function resolveSessionId(sessionId: string): Promise<string> {
    return (await pendingSessions.current.get(sessionId))?.id ?? sessionId;
  }

  async function sendMessage(
    sessionId: string,
    input: MessageInput,
  ): Promise<MessageDelivery | undefined> {
    try {
      return await backend.sendMessage(
        await resolveSessionId(sessionId),
        input,
      );
    } catch (error) {
      setAppError(humanErrorMessage(error));
      return undefined;
    }
  }

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
        setAppError("현재 모델은 추론 effort 전환을 지원하지 않습니다.");
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

  async function cancelRun(sessionId: string): Promise<void> {
    try {
      await backend.cancelRun(await resolveSessionId(sessionId));
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
    }
  }

  async function renameWorkspace(label: string): Promise<void> {
    try {
      const saved =
        await window.agentControlDesktop?.settings.setWorkspaceLabel(label);
      if (saved) setWorkspaceLabel(saved);
    } catch (error) {
      setAppError(error instanceof Error ? error.message : String(error));
    }
  }

  async function renameSession(
    sessionId: string,
    title: string,
  ): Promise<void> {
    await backend.renameSession(await resolveSessionId(sessionId), title);
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
    setResumingId(sessionId);
    setHistoryError("");
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
    try {
      const fork = await backend.forkSession({
        sourceSessionId: await resolveSessionId(session.id),
        title: `${session.title} (포크)`,
      });
      setSessions((current) => [
        fork,
        ...current.filter((item) => item.id !== fork.id),
      ]);
      setSelectedId(fork.id);
      setTranscripts((current) => cacheTranscript(current, fork.id, []));
      setSearchQuery("");
    } catch (error) {
      setAppError(error instanceof Error ? error.message : String(error));
    }
  }

  async function deleteSession(sessionId: string): Promise<void> {
    try {
      await backend.deleteSession(await resolveSessionId(sessionId));
      setDeleteCandidate(null);
    } catch (error) {
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
  const openSettings = useCallback(() => setSettingsOpen(true), []);
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
  const openResumePickerStable = useCallback(() => {
    handlersRef.current.openResumePicker();
  }, []);
  const updateBusyFlag = Boolean(updateBusy);

  return (
    <div className="app-shell">
      <Sidebar
        sessions={filteredSessions}
        connection={connection}
        selectedId={selectedId}
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
        onSettings={openSettings}
        workspaceLabel={workspaceLabel}
        onWorkspaceLabelChange={startWorkspaceRename}
        updateStatus={updateStatus}
        updateBusy={updateBusyFlag}
        onUpdate={startUpdate}
      />

      {selectedSession ? (
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
                    <span className="chat-sync">터미널 읽기 전용 동기화</span>
                  )}
                  {(selectedGit?.branch ||
                    selectedSession.worktree?.branch) && (
                    <span
                      className="chat-branch"
                      title={`${selectedGit?.workspace ?? selectedSession.workspace}의 현재 Git 브랜치`}
                    >
                      <GitBranch size={11} />
                      {selectedGit?.branch || selectedSession.worktree?.branch}
                    </span>
                  )}
                </small>
              </span>
            </div>
            <div className="chat-header__actions">
              <button
                className={`icon-button ${diffOpen ? "is-active" : ""}`}
                type="button"
                title="변경 파일"
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
                title="세션 정보"
                onClick={() => setInspectorOpen((open) => !open)}
              >
                <PanelRight size={18} />
              </button>
              {(connection.state === "disconnected" ||
                connection.state === "error") && (
                <button
                  className="button-secondary"
                  type="button"
                  onClick={() => void backend.reconnect().then(setConnection)}
                >
                  재연결
                </button>
              )}
            </div>
          </header>

          <div className="workspace-body">
            <section
              className={`conversation conversation--${selectedSession.phase === "compacting" ? "compacting" : selectedSession.status}`}
            >
              <RecentRequestStrip
                items={selectedTranscript}
                onReveal={(itemId) =>
                  setRevealTarget({ sessionId: selectedSession.id, itemId })
                }
              />
              <Transcript
                items={selectedTranscript}
                compacting={selectedSession.phase === "compacting"}
                revealItemId={
                  revealTarget?.sessionId === selectedSession.id
                    ? revealTarget.itemId
                    : undefined
                }
                onRevealComplete={completeReveal}
                onResolveTool={resolveToolCall}
                onReadArtifact={readArtifact}
                onPreviewFile={previewFile}
              />
              <div className="composer-wrap">
                <GoalProgressRow
                  goal={goal}
                  busy={goalBusy}
                  onOperate={(operation) => void operateGoal(operation)}
                />
                <Composer
                  sessionId={selectedSession.id}
                  running={
                    selectedSession.phase === "compacting" ||
                    selectedSession.status === "running" ||
                    selectedSession.status === "waiting" ||
                    transcriptHasLiveWork
                  }
                  sessionTitle={selectedSession.title}
                  workspace={selectedSession.workspace}
                  workspaces={recentWorkspaces}
                  commands={selectedCommands}
                  configOptions={composerConfigOptions}
                  modelDisplay={selectedSession.modelDisplay}
                  thinking={selectedSession.thinking}
                  usagePercent={selectedSession.usagePercent}
                  onSend={(input) => sendMessage(selectedSession.id, input)}
                  onCancel={() => void cancelRun(selectedSession.id)}
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
                />
              </div>
            </section>
            {inspectorOpen && (
              <Inspector
                session={selectedSession}
                transcript={selectedTranscript}
                liveSubagents={liveSubagents}
                resuming={resumingId === selectedSession.id}
                onResume={() => void resumeSession(selectedSession.id)}
                onClose={() => setInspectorOpen(false)}
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
          <h1>선택된 Gajae 세션이 없습니다</h1>
          <button
            className="button-primary"
            type="button"
            onClick={() => setNewSessionOpen(true)}
          >
            <Plus size={16} /> 새 세션
          </button>
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
        <SettingsDialog
          connection={connection}
          onClose={() => setSettingsOpen(false)}
          onSaved={(preferences) => {
            setWorkspaceLabel(preferences.workspaceLabel);
            setConnection((current) => ({
              ...current,
              workspace: preferences.workspace,
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
