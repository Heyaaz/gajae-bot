import { useEffect, useMemo, useState } from "react";
import type { AgentSession } from "../backend/types";
import type { ParallelGroup } from "../../shared/parallel-run";
import type {
  ProjectPathResolution,
  RepoDesktopBridge,
} from "../../shared/repo-ipc";
import {
  ALL_PROJECTS_ID,
  buildProjectGroups,
  projectPathOf,
  resolveProjectSelection,
  sessionsOfProject,
} from "./project-model";
import { sessionListModel } from "./sidebar-model";
import type { SessionGrouping, SessionProjectRef } from "./sidebar-model";

export function useProjectModel(
  sessions: AgentSession[],
  parallelGroups: ParallelGroup[],
  repoBridge: RepoDesktopBridge | null,
  selectedProjectId: string,
  grouping: SessionGrouping,
  collapsedProjects: ReadonlySet<string>,
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
  // One chosen project has nothing to section by project, so the rail reads by state.
  const projectOf = useMemo(() => {
    if (grouping !== "project" || activeProjectId !== ALL_PROJECTS_ID) return undefined;
    const refs = new Map<string, SessionProjectRef>();
    for (const project of projectGroups)
      for (const session of project.sessions)
        refs.set(session.id, { id: project.id, name: project.name });
    return (session: AgentSession) => refs.get(session.id);
  }, [grouping, activeProjectId, projectGroups]);
  // The digits the main process sends for ⌘1-⌘9 index this list, so it has to be the
  // rail's own order: the same rows the rail lists, sectioned the same way.
  const shortcutSessions = useMemo(
    () =>
      sessionListModel(
        filteredSessions.filter((session) => session.status !== "unknown"),
        { parallelGroups, projectOf, collapsedProjects },
      ).shortcuts,
    [filteredSessions, parallelGroups, projectOf, collapsedProjects],
  );

  return {
    projectGroups,
    activeProjectId,
    activeProject,
    filteredSessions,
    shortcutSessions,
    projectOf,
  };
}
