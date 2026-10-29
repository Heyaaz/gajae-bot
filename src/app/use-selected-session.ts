import { useCallback, useEffect, useRef, useState } from "react";
import type {
  DiffSnapshot,
  GitStatusSnapshot,
  GoalSnapshot,
} from "../../shared/agent-contract";
import type { AgentBackend } from "../backend/agent-backend";
import type { AgentSession } from "../backend/types";
import { goalPollDelay } from "./goal-poll";

type SessionIdRef = { current: string | null };

export function useGoal(
  backend: AgentBackend,
  selectedIdRef: SessionIdRef,
  selectedSessionId: string | undefined,
  selectedSessionStatus: AgentSession["status"] | undefined,
) {
  const [goal, setGoal] = useState<GoalSnapshot>({
    enabled: false,
    completed: 0,
    total: 0,
  });
  const goalRescheduleRef = useRef<(snapshot: GoalSnapshot) => void>(
    () => undefined,
  );
  const [goalBusySessionId, setGoalBusySessionId] = useState<string | null>(null);


  useEffect(() => {
    if (!selectedSessionId) return;
    let active = true;
    let refreshing = false;
    let timer: number | undefined;
    const clearTimer = (): void => {
      if (timer === undefined) return;
      window.clearTimeout(timer);
      timer = undefined;
    };
    const schedule = (snapshot: GoalSnapshot): void => {
      if (!active) return;
      clearTimer();
      timer = window.setTimeout(refresh, goalPollDelay(snapshot, selectedSessionStatus));
    };
    const refresh = (): void => {
      if (!active || refreshing) return;
      refreshing = true;
      void backend
        .getGoal(selectedSessionId)
        .then((snapshot) => {
          if (!active || selectedIdRef.current !== selectedSessionId) return;
          setGoal(snapshot);
          schedule(snapshot);
        })
        .catch(() => {
          if (!active || selectedIdRef.current !== selectedSessionId) return;
          const snapshot = { enabled: false, completed: 0, total: 0 };
          setGoal(snapshot);
          schedule(snapshot);
        })
        .finally(() => { refreshing = false; });
    };
    goalRescheduleRef.current = (snapshot) => {
      if (active) schedule(snapshot);
    };
    // Goal and todo state advance at tool-call pace, not at streaming pace. No
    // active goal backs off to 30s; a goal operation reschedules immediately from
    // the snapshot it already received instead of issuing another query.
    queueMicrotask(refresh);
    const refreshOnVisible = (): void => {
      if (document.hidden) return;
      clearTimer();
      refresh();
    };
    document.addEventListener("visibilitychange", refreshOnVisible);
    return () => {
      active = false;
      clearTimer();
      goalRescheduleRef.current = () => undefined;
      document.removeEventListener("visibilitychange", refreshOnVisible);
    };
  }, [backend, selectedSessionId, selectedSessionStatus]);

  return { goal, setGoal, goalRescheduleRef, goalBusySessionId, setGoalBusySessionId };
}

export function useGitStatus(
  backend: AgentBackend,
  selectedSessionId: string | undefined,
  selectedSessionStatus: AgentSession["status"] | undefined,
) {
  const [selectedGit, setSelectedGit] = useState<GitStatusSnapshot | null>(
    null,
  );


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

  return selectedGit;
}

export function useDiff(
  backend: AgentBackend,
  diffOpen: boolean,
  selectedId: string | null,
  selectedIdRef: SessionIdRef,
  sessionWorkspace: string | undefined,
) {
  const [diff, setDiff] = useState<DiffSnapshot | null>(null);
  const diffOpenRef = useRef(diffOpen);
  diffOpenRef.current = diffOpen;
  // Every diff belongs to the session it was requested for; bumping this drops
  // an answer that arrives after the user moved on.
  const diffRequestRef = useRef(0);
  const [diffLoading, setDiffLoading] = useState(false);

  const refreshDiff = useCallback(async (): Promise<void> => {
    const sessionId = selectedId;
    if (!sessionId) return;
    const request = ++diffRequestRef.current;
    const workspace = sessionWorkspace ?? "";
    setDiffLoading(true);
    try {
      const snapshot = await backend.getDiff(sessionId);
      if (diffRequestRef.current !== request || selectedIdRef.current !== sessionId)
        return;
      setDiff(snapshot);
    } catch (e) {
      if (diffRequestRef.current !== request || selectedIdRef.current !== sessionId)
        return;
      setDiff({
        sessionId,
        workspace,
        files: [],
        refreshedAt: new Date().toISOString(),
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      if (diffRequestRef.current === request) setDiffLoading(false);
    }
  }, [backend, selectedId, sessionWorkspace]);

  // A session switch invalidates the diff already on screen and anything still in
  // flight, so those patches can never be read -- or acted on -- under the new
  // session.
  useEffect(() => {
    diffRequestRef.current += 1;
    setDiff(null);
    setDiffLoading(false);
    if (selectedId && diffOpenRef.current) void refreshDiff();
  }, [selectedId, diffOpen, refreshDiff]);

  return { diff, diffLoading, refreshDiff };
}
