import type { ProjectPathResolution } from "../../shared/repo-ipc";
import { projectPathOf } from "../../shared/agent-contract";
import type { AgentSession } from "../backend/types";

/**
 * The selector's "every project" entry.
 *
 * A project id is a directory root, so no project can ever be called "all"; this is
 * a sentinel the rail can select without a group behind it.
 */
export const ALL_PROJECTS_ID = "all";

export interface ProjectGroup {
  /** Canonical project root, which is also the group key. */
  id: string;
  /** Directory name shown in the selector. */
  name: string;
  root: string;
  /** False when the root is not inside a Git repository. */
  repository: boolean;
  /** Sessions in this project, in the order they were handed in. */
  sessions: AgentSession[];
}

export { projectPathOf } from "../../shared/agent-contract";

/**
 * The project a session belongs to, as the desktop service resolved it.
 *
 * A path the map has no entry for -- a remote renderer with no bridge to ask, or a
 * workspace the service has not answered for yet -- keeps its own root: the rail has
 * to hold that project's sessions while the answer is missing rather than drop them.
 */
export function projectRootOf(
  session: AgentSession,
  resolutions: ReadonlyMap<string, ProjectPathResolution>,
): { root: string; repository: boolean } {
  const path = projectPathOf(session);
  const resolution = resolutions.get(path);
  return resolution
    ? { root: resolution.root, repository: resolution.repository }
    : { root: path, repository: false };
}

/**
 * The label a selector shows for a project root.
 *
 * Segments rather than everything after the last separator: a root written with a
 * trailing slash ("/tmp/project/") still has to be labelled "project". A root with
 * no segment left ("/") is its own name, and an empty path falls back to a word,
 * because the selector cannot render a blank row.
 */
export function projectNameOf(root: string): string {
  const segments = root.split("/").filter(Boolean);
  return segments.at(-1) ?? (root || "Workspace");
}

/**
 * Groups sessions into the projects they belong to.
 *
 * Sessions keep the order they were handed in, because the rail has already ranked
 * them; only the groups are reordered, and only by label, so the selector reads
 * alphabetically. Labels collide (two checkouts can both be called "project"), so
 * the root breaks the tie and the order stays the same between two builds.
 */
export function buildProjectGroups(
  sessions: readonly AgentSession[],
  resolutions: readonly ProjectPathResolution[],
): ProjectGroup[] {
  const byPath = new Map(
    resolutions.map((resolution) => [resolution.path, resolution]),
  );
  const groups = new Map<string, ProjectGroup>();
  for (const session of sessions) {
    const { root, repository } = projectRootOf(session, byPath);
    const existing = groups.get(root);
    if (existing) {
      existing.sessions.push(session);
      continue;
    }
    groups.set(root, {
      id: root,
      name: projectNameOf(root),
      root,
      repository,
      sessions: [session],
    });
  }
  return [...groups.values()].sort(
    (left, right) =>
      left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
  );
}

/**
 * The selection the rail can actually show.
 *
 * A remembered id outlives its project when the project's last session is deleted,
 * and a restored selection can name a project this renderer has not seen yet. Both,
 * and an empty rail, fall back to every project: a rail showing nothing is worse
 * than one showing more sessions than were asked for.
 */
export function resolveProjectSelection(
  selectedId: string,
  groups: readonly ProjectGroup[],
): string {
  return groups.some((group) => group.id === selectedId)
    ? selectedId
    : ALL_PROJECTS_ID;
}

/**
 * The sessions one selection shows.
 *
 * The rail's own order is preserved rather than rebuilt from the group order: the
 * list is ranked by pin, state group and recency before it gets here, and reading
 * it back group by group would re-sort the whole rail by project name. A session is
 * matched by id, because one session appears in exactly one group either way.
 *
 * An id that names no project reads as every project, the same way the selection
 * resolves: the rail has to keep its rows when the project they belonged to is gone.
 */
export function sessionsOfProject(
  sessions: readonly AgentSession[],
  groups: readonly ProjectGroup[],
  selectedId: string,
): AgentSession[] {
  if (selectedId === ALL_PROJECTS_ID) return [...sessions];
  const group = groups.find((candidate) => candidate.id === selectedId);
  if (!group) return [...sessions];
  const member = new Set(group.sessions.map((session) => session.id));
  return sessions.filter((session) => member.has(session.id));
}

/**
 * The sessions running in one worktree path.
 *
 * Exact comparison on purpose: the path names one checkout, and a prefix match would
 * let "/tmp/repo" claim the sessions of "/tmp/repo-old" -- and, because a managed
 * worktree lives inside its source repository, would show a worktree's sessions in
 * the main worktree's row as well.
 */
export function sessionsInPath(
  sessions: readonly AgentSession[],
  path: string,
): AgentSession[] {
  return sessions.filter((session) => session.workspace === path);
}
