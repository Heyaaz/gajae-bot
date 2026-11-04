import { useEffect, useEffectEvent } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { AgentBackend } from "../backend/agent-backend";
import type {
  AgentCommand,
  AgentConfigOption,
  AgentEvent,
  AgentSession,
  BackendConnection,
  TranscriptItem,
} from "../backend/types";
import type { MessageDeliveryTracker } from "../message-delivery";
import {
  discoveryRevisionIsFresh,
  initialSessionId,
  mergeDiscoveredSessions,
} from "../transcript-utils";
import { createBackendEventHandler } from "./backend-events";
import type { BackendEventContext } from "./backend-events";
import { releaseQueuedSession, subscribeComposerReleaseRetry } from "./composer";
import { humanErrorMessage } from "./format";
import type { ShellSendMessage } from "./shell-model";
import type { useTranscriptStore } from "./use-transcript-store";

type TranscriptStore = ReturnType<typeof useTranscriptStore>;

export interface SessionSyncContext {
  backend: AgentBackend;
  sessionsRef: MutableRefObject<AgentSession[]>;
  selectedIdRef: MutableRefObject<string | null>;
  sendMessageRef: MutableRefObject<ShellSendMessage | null>;
  messageDeliveryTrackerRef: MutableRefObject<MessageDeliveryTracker | null>;
  removingSessionIdsRef: MutableRefObject<Set<string>>;
  sessionLinkRef: MutableRefObject<{ listed: boolean; waiting?: string }>;
  setConnection: Dispatch<SetStateAction<BackendConnection>>;
  setSessions: Dispatch<SetStateAction<AgentSession[]>>;
  setSelectedId: Dispatch<SetStateAction<string | null>>;
  setTranscripts: Dispatch<SetStateAction<Record<string, TranscriptItem[]>>>;
  setCommands: Dispatch<SetStateAction<Record<string, AgentCommand[]>>>;
  setConfigOptions: Dispatch<SetStateAction<Record<string, AgentConfigOption[]>>>;
  setMessageDeliveryRevision: Dispatch<SetStateAction<number>>;
  setAppError: (message: string) => void;
  forgetSession: (sessionId: string) => void;
  openLinkedSession: (sessionId: string, known: readonly AgentSession[]) => void;
  transcriptsRef: TranscriptStore["transcriptsRef"];
  transcriptPageStatesRef: TranscriptStore["transcriptPageStatesRef"];
  transcriptRevisionsRef: TranscriptStore["transcriptRevisionsRef"];
  transcriptEventVersionsRef: TranscriptStore["transcriptEventVersionsRef"];
  tracksTranscriptSession: TranscriptStore["tracksTranscriptSession"];
  noteTranscriptEvent: TranscriptStore["noteTranscriptEvent"];
  updateRequestSummaries: TranscriptStore["updateRequestSummaries"];
  mergeLiveTranscriptItems: TranscriptStore["mergeLiveTranscriptItems"];
  refreshTranscriptPage: TranscriptStore["refreshTranscriptPage"];
  onTurnCompleted?: (sessionId: string) => void;
}

export function useSessionSync(context: SessionSyncContext): void {
  const {
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
    onTurnCompleted,
  } = context;
  // The subscription and the polling below live as long as `backend`. These run the
  // latest render's functions each time they fire, not the ones from the render
  // that subscribed.
  const onBackendEvent = useEffectEvent(
    (
      event: AgentEvent,
      local: Pick<BackendEventContext, "observeSessionRun" | "refreshTranscript">,
    ): void =>
      createBackendEventHandler({
        setConnection,
        setSessions,
        setTranscripts,
        setCommands,
        setConfigOptions,
        setMessageDeliveryRevision,
        messageDeliveryTrackerRef,
        transcriptsRef,
        transcriptPageStatesRef,
        transcriptRevisionsRef,
        selectedIdRef,
        forgetSession,
        tracksTranscriptSession,
        noteTranscriptEvent,
        updateRequestSummaries,
        mergeLiveTranscriptItems,
        onTurnCompleted,
        ...local,
      })(event),
  );
  const openListedSession = useEffectEvent(
    (sessionId: string, known: readonly AgentSession[]): void =>
      openLinkedSession(sessionId, known),
  );
  const readTranscriptTail = useEffectEvent(
    (id: string): Promise<void> => refreshTranscriptPage(id),
  );

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
        await sendMessageRef.current!(sessionId, {
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
      let listed: readonly AgentSession[] = [];
      void backend
        .listSessions()
        .then((loadedSessions) => {
          if (!active) return;
          listed = loadedSessions.filter(
            (session) => !removingSessionIdsRef.current.has(session.id),
          );
          for (const session of listed) observeSessionRun(session);
          setSessions((current) =>
            mergeDiscoveredSessions(current, listed, selectedIdRef.current),
          );
          if (initial)
            setSelectedId((selected) =>
              initialSessionId(listed, selected),
            );
        })
        .catch(() => undefined)
        .finally(() => {
          listing = false;
          if (!initial || !active) return;
          const link = sessionLinkRef.current;
          link.listed = true;
          if (link.waiting === undefined) return;
          const sessionId = link.waiting;
          link.waiting = undefined;
          openListedSession(sessionId, [...sessionsRef.current, ...listed]);
        });
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
      void readTranscriptTail(id)
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

    const unsubscribe = backend.subscribe((event) =>
      onBackendEvent(event, { observeSessionRun, refreshTranscript }),
    );

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
}
