import { useEffect, useMemo, useState } from "react";
import type { AgentSession } from "../backend/types";
import type { ParallelGroup } from "../../shared/parallel-run";
import type {
  ProjectPathResolution,
  RepoDesktopBridge,
} from "../../shared/repo-ipc";
import {
  buildProjectGroups,
  projectPathOf,
  resolveProjectSelection,
  sessionsOfProject,
} from "./project-model";
import { sessionListModel } from "./sidebar-model";

export function useProjectModel(
  sessions: AgentSession[],
  parallelGroups: ParallelGroup[],
  repoBridge: RepoDesktopBridge | null,
  selectedProjectId: string,
) {
  // Git project roots, as the main process resolved them. Empty until that answer
  // arrives, and empty forever in a renderer with no desktop bridge; the grouping
  // falls back to workspace paths in that case rather than dropping sessions.
  const [projectResolutions, setProjectResolutions] = useState<
    ProjectPathResolution[]
  >([]);

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
    () => sessionListModel(filteredSessions, { parallelGroups }).shortcuts,
    [filteredSessions, parallelGroups],
  );

  return {
    projectGroups,
    activeProjectId,
    activeProject,
    filteredSessions,
    shortcutSessions,
  };
}
