import { useEffect, useState } from "react";
import type { SubagentSnapshot } from "../../shared/agent-contract";
import type { AgentBackend } from "../backend/agent-backend";

export function useLiveSubagents(
  backend: AgentBackend,
  selectedSessionId: string | undefined,
  inspectorOpen: boolean,
): SubagentSnapshot[] {
  const [liveSubagents, setLiveSubagents] = useState<SubagentSnapshot[]>([]);

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

  return liveSubagents;
}
