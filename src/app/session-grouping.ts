import { useCallback, useState } from "react";
import type { SessionGrouping } from "./sidebar-model";

const GROUPING_STORAGE_KEY = "gajae.sidebar.grouping";

// A view preference of this window, so it lives in browser storage; storage that is
// unavailable (a private profile, a sandboxed preview) falls back to projects.
function storedGrouping(): SessionGrouping {
  try {
    return window.localStorage.getItem(GROUPING_STORAGE_KEY) === "status"
      ? "status"
      : "project";
  } catch {
    return "project";
  }
}

function storeGrouping(value: SessionGrouping): void {
  try {
    window.localStorage.setItem(GROUPING_STORAGE_KEY, value);
  } catch {
    // The choice still holds for this window.
  }
}

/**
 * How the rail sections its rows and which project sections are folded.
 *
 * The shell owns this rather than the rail: the ⌘-digit order is computed from the
 * same model, and a folded project's rows take no digit.
 */
export function useSessionGrouping() {
  const [grouping, setGroupingState] = useState<SessionGrouping>(storedGrouping);
  const [collapsedProjects, setCollapsedProjects] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const setGrouping = useCallback((value: SessionGrouping) => {
    setGroupingState(value);
    storeGrouping(value);
  }, []);
  const toggleProject = useCallback((projectId: string) => {
    setCollapsedProjects((current) => {
      const next = new Set(current);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  }, []);
  return { grouping, setGrouping, collapsedProjects, toggleProject };
}
