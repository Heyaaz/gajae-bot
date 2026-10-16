import { describe, expect, it } from "vitest";
import type { ProjectPathResolution } from "../../shared/repo-ipc";
import type { AgentSession } from "../backend/types";
import {
  ALL_PROJECTS_ID,
  buildProjectGroups,
  projectIdsOf,
  projectNameOf,
  projectPathOf,
  projectRootOf,
  repositoryRootsOf,
  resolveProjectSelection,
  sessionsInPath,
  sessionsOfProject,
} from "./project-model";
import type { ProjectGroup } from "./project-model";

function session(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: "session",
    title: "Session",
    subtitle: "",
    workspace: "/tmp/project",
    runtime: "gjc",
    status: "idle",
    updatedAt: "now",
    pinned: false,
    unread: false,
    accent: "#ffffff",
    ownership: "gajae",
    attachment: "attached",
    ...overrides,
  } as AgentSession;
}

/** A session whose workspace is a managed checkout of `source`. */
function managedWorktree(id: string, source: string): AgentSession {
  const worktreePath = `${source}/.worktrees/${id}`;
  return session({
    id,
    workspace: worktreePath,
    worktree: {
      sourceWorkspace: source,
      path: worktreePath,
      branch: id,
      managed: true,
    },
  });
}

function resolution(
  path: string,
  root: string,
  repository: boolean,
): ProjectPathResolution {
  return { path, root, repository };
}

function resolutionMap(
  ...entries: ProjectPathResolution[]
): ReadonlyMap<string, ProjectPathResolution> {
  return new Map(entries.map((entry) => [entry.path, entry]));
}

/** The model as one comparable value: ids, labels, Git flags and session ids. */
function summarize(groups: readonly ProjectGroup[]) {
  return groups.map((group) => ({
    id: group.id,
    name: group.name,
    repository: group.repository,
    sessions: group.sessions.map((row) => row.id),
  }));
}

describe("projectPathOf", () => {
  it("reads a managed worktree as a checkout of its source workspace", () => {
    expect(projectPathOf(managedWorktree("issue-3", "/tmp/repo"))).toBe(
      "/tmp/repo",
    );
  });

  it("reads a plain session as its own workspace", () => {
    expect(projectPathOf(session({ workspace: "/tmp/notes" }))).toBe(
      "/tmp/notes",
    );
  });
});

describe("projectRootOf", () => {
  it("takes the canonical root and the Git flag from the resolution", () => {
    const resolutions = resolutionMap(
      resolution("/tmp/repo/.worktrees/issue-3", "/tmp/repo", true),
    );
    expect(
      projectRootOf(
        session({ workspace: "/tmp/repo/.worktrees/issue-3" }),
        resolutions,
      ),
    ).toEqual({ root: "/tmp/repo", repository: true });
  });

  it("keeps its own root when the service has not answered for the path", () => {
    expect(
      projectRootOf(session({ workspace: "/tmp/pending" }), resolutionMap()),
    ).toEqual({ root: "/tmp/pending", repository: false });
  });
});

describe("projectNameOf", () => {
  it("labels a root by its last path segment", () => {
    expect(projectNameOf("/tmp/gajae-bot")).toBe("gajae-bot");
    expect(projectNameOf("/tmp/gajae-bot/")).toBe("gajae-bot");
    expect(projectNameOf("gajae-bot")).toBe("gajae-bot");
  });

  it("never labels a root blank", () => {
    // "/" has no segment to take, and the selector cannot render an empty row.
    expect(projectNameOf("/")).toBe("/");
    for (const root of ["/", "", "/tmp/gajae-bot/", "gajae-bot"])
      expect(projectNameOf(root)).not.toBe("");
  });
});

describe("buildProjectGroups", () => {
  it("keeps a managed worktree in the project it was forked from", () => {
    const groups = buildProjectGroups(
      [
        session({ id: "plain", workspace: "/tmp/repo" }),
        managedWorktree("issue-3", "/tmp/repo"),
      ],
      [resolution("/tmp/repo", "/tmp/repo", true)],
    );
    expect(summarize(groups)).toEqual([
      {
        id: "/tmp/repo",
        name: "repo",
        repository: true,
        sessions: ["plain", "issue-3"],
      },
    ]);
  });

  it("joins a linked worktree the service resolved to the main working tree", () => {
    const groups = buildProjectGroups(
      [
        session({ id: "main", workspace: "/tmp/repo" }),
        session({ id: "linked", workspace: "/tmp/repo-issue-3" }),
      ],
      [
        resolution("/tmp/repo", "/tmp/repo", true),
        resolution("/tmp/repo-issue-3", "/tmp/repo", true),
      ],
    );
    expect(summarize(groups)).toEqual([
      {
        id: "/tmp/repo",
        name: "repo",
        repository: true,
        sessions: ["main", "linked"],
      },
    ]);
  });

  it("keeps a workspace outside Git as its own project", () => {
    const groups = buildProjectGroups(
      [
        session({ id: "note-1", workspace: "/tmp/notes" }),
        session({ id: "note-2", workspace: "/tmp/notes" }),
      ],
      [resolution("/tmp/notes", "/tmp/notes", false)],
    );
    expect(summarize(groups)).toEqual([
      {
        id: "/tmp/notes",
        name: "notes",
        repository: false,
        sessions: ["note-1", "note-2"],
      },
    ]);
    expect(repositoryRootsOf(groups)).toEqual([]);
  });

  it("keeps a workspace with no resolution entry", () => {
    const groups = buildProjectGroups(
      [session({ id: "pending", workspace: "/tmp/pending" })],
      [],
    );
    expect(summarize(groups)).toEqual([
      {
        id: "/tmp/pending",
        name: "pending",
        repository: false,
        sessions: ["pending"],
      },
    ]);
  });

  it("keeps every session in exactly one project", () => {
    const sessions = [
      session({ id: "plain", workspace: "/tmp/repo" }),
      managedWorktree("issue-3", "/tmp/repo"),
      session({ id: "notes", workspace: "/tmp/notes" }),
      session({ id: "pending", workspace: "/tmp/pending" }),
    ];
    const groups = buildProjectGroups(sessions, [
      resolution("/tmp/repo", "/tmp/repo", true),
      resolution("/tmp/notes", "/tmp/notes", false),
    ]);
    const ids = groups.flatMap((group) => group.sessions.map((row) => row.id));
    expect(groups).toHaveLength(3);
    expect([...ids].sort()).toEqual(["issue-3", "notes", "pending", "plain"]);
  });

  it("orders projects that share a label by id", () => {
    const beta = session({ id: "beta", workspace: "/tmp/beta/project" });
    const alpha = session({ id: "alpha", workspace: "/tmp/alpha/project" });
    // Both are labelled "project", so the root decides; the order the sessions were
    // handed in must not leak into which project the selector leads with.
    expect(projectIdsOf(buildProjectGroups([beta, alpha], []))).toEqual([
      "/tmp/alpha/project",
      "/tmp/beta/project",
    ]);
    expect(projectIdsOf(buildProjectGroups([alpha, beta], []))).toEqual([
      "/tmp/alpha/project",
      "/tmp/beta/project",
    ]);
  });
});

describe("projectIdsOf", () => {
  it("lists ids in the order the groups are shown", () => {
    const groups = buildProjectGroups(
      [
        session({ id: "one", workspace: "/tmp/repo" }),
        session({ id: "two", workspace: "/tmp/notes" }),
      ],
      [],
    );
    expect(projectIdsOf(groups)).toEqual(["/tmp/notes", "/tmp/repo"]);
  });
});

describe("resolveProjectSelection", () => {
  const groups = buildProjectGroups(
    [
      session({ id: "one", workspace: "/tmp/repo" }),
      session({ id: "two", workspace: "/tmp/notes" }),
    ],
    [],
  );

  it("keeps a selection that names a project", () => {
    expect(resolveProjectSelection("/tmp/repo", groups)).toBe("/tmp/repo");
    expect(resolveProjectSelection(ALL_PROJECTS_ID, groups)).toBe(
      ALL_PROJECTS_ID,
    );
  });

  it("falls back to every project when the selection names nothing", () => {
    // The remembered project lost its last session, so its group is gone while the
    // selection is not.
    expect(resolveProjectSelection("/tmp/deleted", groups)).toBe(
      ALL_PROJECTS_ID,
    );
    expect(resolveProjectSelection("/tmp/repo", [])).toBe(ALL_PROJECTS_ID);
    expect(resolveProjectSelection(ALL_PROJECTS_ID, [])).toBe(ALL_PROJECTS_ID);
  });
});

describe("sessionsOfProject", () => {
  const handedIn = [
    session({ id: "one", workspace: "/tmp/repo" }),
    session({ id: "two", workspace: "/tmp/notes" }),
    session({ id: "three", workspace: "/tmp/repo" }),
  ];
  const groups = buildProjectGroups(handedIn, []);

  it("returns every session for the everywhere selection, without reordering", () => {
    // The rail is ranked by pin, state group and recency before it arrives; reading
    // it back group by group re-sorted it by project name instead, which moved a
    // pinned row below another project's session.
    expect(
      sessionsOfProject(handedIn, groups, ALL_PROJECTS_ID).map((row) => row.id),
    ).toEqual(["one", "two", "three"]);
  });

  it("returns one project's sessions in the order they were handed in", () => {
    expect(
      sessionsOfProject(handedIn, groups, "/tmp/repo").map((row) => row.id),
    ).toEqual(["one", "three"]);
    expect(
      sessionsOfProject(handedIn, groups, "/tmp/notes").map((row) => row.id),
    ).toEqual(["two"]);
  });

  it("reads an id that names no project as every project", () => {
    expect(
      sessionsOfProject(handedIn, groups, "/tmp/deleted").map((row) => row.id),
    ).toEqual(["one", "two", "three"]);
  });
});

describe("sessionsInPath", () => {
  const worktree = "/tmp/repo/.worktrees/issue-3";
  const sessions = [
    session({ id: "main", workspace: "/tmp/repo" }),
    session({ id: "first", workspace: worktree }),
    session({ id: "second", workspace: worktree }),
  ];

  it("matches one worktree path exactly, in the order handed in", () => {
    expect(sessionsInPath(sessions, worktree).map((row) => row.id)).toEqual([
      "first",
      "second",
    ]);
    expect(sessionsInPath(sessions, "/tmp/repo").map((row) => row.id)).toEqual([
      "main",
    ]);
  });

  it("ignores paths that only look like the worktree", () => {
    // A trailing separator is a different string, and a prefix match would let the
    // worktree claim the sessions of a sibling checkout.
    expect(sessionsInPath(sessions, `${worktree}/`)).toEqual([]);
    expect(sessionsInPath(sessions, `${worktree}0`)).toEqual([]);
  });
});

describe("repositoryRootsOf", () => {
  it("lists the Git-backed roots only", () => {
    const groups = buildProjectGroups(
      [
        session({ id: "repo", workspace: "/tmp/repo" }),
        session({ id: "notes", workspace: "/tmp/notes" }),
      ],
      [
        resolution("/tmp/repo", "/tmp/repo", true),
        resolution("/tmp/notes", "/tmp/notes", false),
      ],
    );
    expect(repositoryRootsOf(groups)).toEqual(["/tmp/repo"]);
  });
});
