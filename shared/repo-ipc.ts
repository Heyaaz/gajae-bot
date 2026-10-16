/**
 * The project-scoped repository surface.
 *
 * Everything here is read-only against the local repository and against GitHub.
 * Mutating Git work stays on the session-scoped bridge (`stageFiles`,
 * `commitChanges`, `pushChanges`), which owns the managed-worktree checks; this
 * channel set never stages, commits, pushes, deletes, or resets anything.
 *
 * No payload carries a credential. GitHub access runs through the `gh` CLI's own
 * keyring, so the queries below report *whether* access worked and never the
 * token that made it work.
 */

export const REPO_IPC = {
  /** Canonical Git project roots for the workspaces the rail is showing. */
  resolveProjects: "agent-control:repo:resolve-projects",
  /** Local branches, worktrees and remote for one project root. */
  readRepository: "agent-control:repo:read-repository",
  /** GitHub repository status: issue/PR counts and the default branch CI. */
  readGithub: "agent-control:repo:read-github",
  listIssues: "agent-control:repo:list-issues",
  getIssue: "agent-control:repo:get-issue",
  listPulls: "agent-control:repo:list-pulls",
  getPull: "agent-control:repo:get-pull",
  /** Opens a validated https URL in the OS browser. */
  openExternal: "agent-control:repo:open-external",
  /** Reveals a project or worktree directory in the OS file manager. */
  revealFolder: "agent-control:repo:reveal-folder",
} as const;

/**
 * One workspace as a project member.
 *
 * `root` is the project's main working tree, so every linked worktree of the same
 * repository resolves to the same project instead of appearing as a second one.
 * A path outside Git keeps its own root: a workspace that is not a repository
 * still has to hold its sessions somewhere.
 */
export interface ProjectPathResolution {
  /** The path as asked, unchanged. */
  path: string;
  /** The main working tree of the repository, or the path itself outside Git. */
  root: string;
  repository: boolean;
}

export interface RepoBranch {
  name: string;
  /** Set when a worktree has this branch checked out; that worktree's path. */
  worktreePath?: string;
}

export interface RepoWorktree {
  path: string;
  /** Checked-out branch, absent on a detached HEAD or a bare entry. */
  branch?: string;
  head: string;
  /** The repository's main working tree, which is the project root itself. */
  main: boolean;
  locked: boolean;
  prunable: boolean;
  /**
   * Entries `git status --porcelain` reports here, tracked and untracked alike.
   * Absent when the working tree could not be read, which is not the same as a
   * clean tree and is shown as such.
   */
  changed?: number;
}

/** A configured remote, with the browsable URL when it is GitHub. */
export interface RepositoryRemote {
  name: string;
  url: string;
  /** `<host>/<owner>/<name>`, present only for a GitHub remote. */
  slug?: string;
  /** `https://github.com/owner/name`, present only for a GitHub remote. */
  webUrl?: string;
}

export interface RepositorySnapshot {
  root: string;
  /** Directory name, which is the project label. */
  name: string;
  repository: boolean;
  /** The main working tree's branch; empty on a detached HEAD or outside Git. */
  branch: string;
  remote?: RepositoryRemote;
  branches: RepoBranch[];
  worktrees: RepoWorktree[];
  /**
   * Set when a local Git read failed. The screen reports it instead of drawing an
   * empty repository as if the project simply had no branches.
   */
  error?: string;
  refreshedAt: string;
}

/** Why a GitHub query could not answer. */
export type GithubFailureState =
  | "no-remote"
  | "not-github"
  | "no-cli"
  | "unauthenticated"
  | "unreachable"
  | "error";

/**
 * The result of one GitHub query.
 *
 * A failure is a state rather than a thrown error: the repository screen has to
 * say which of "no remote", "not GitHub", "no `gh`", "not logged in", "offline"
 * and "the API refused" applies, and an empty list is none of them.
 */
export type GithubQuery<T> =
  | { state: "ok"; value: T }
  | { state: Exclude<GithubFailureState, "no-remote" | "not-github">; detail: string }
  | { state: "no-remote" }
  | { state: "not-github"; remote: string };

export type CiState = "passing" | "failing" | "pending" | "none";

export interface RepoCiSummary {
  state: CiState;
  total: number;
  failing: number;
  pending: number;
}

export interface GithubRepositoryStatus {
  /** `owner/name`. */
  fullName: string;
  url: string;
  defaultBranch: string;
  openIssues: number;
  openPulls: number;
  /** The default branch's latest commit checks, which is what "CI" means here. */
  ci: RepoCiSummary;
  /** True when the repository cannot be read without credentials. */
  private: boolean;
}

export interface GithubLabel {
  name: string;
  color: string;
}

export interface GithubIssueSummary {
  number: number;
  title: string;
  state: "open" | "closed";
  url: string;
  author: string;
  labels: GithubLabel[];
  comments: number;
  updatedAt: string;
}

export interface GithubIssueDetail extends GithubIssueSummary {
  body: string;
  createdAt: string;
  assignees: string[];
}

export type GithubReviewState =
  | "approved"
  | "changes-requested"
  | "review-required"
  | "none";

export interface GithubReview {
  author: string;
  state: "approved" | "changes-requested" | "commented" | "dismissed" | "pending";
  submittedAt?: string;
}

export interface GithubPullSummary {
  number: number;
  title: string;
  state: "open" | "closed" | "merged";
  draft: boolean;
  url: string;
  author: string;
  headRefName: string;
  baseRefName: string;
  review: GithubReviewState;
  ci: RepoCiSummary;
  updatedAt: string;
}

export interface GithubPullDetail extends GithubPullSummary {
  body: string;
  createdAt: string;
  mergeable: "mergeable" | "conflicting" | "unknown";
  additions: number;
  deletions: number;
  changedFiles: number;
  reviews: GithubReview[];
}

/** How many rows a list query asks for. Detail queries ignore it. */
export const REPO_LIST_LIMIT = 30;

export interface RepoDesktopBridge {
  resolveProjects(paths: string[]): Promise<ProjectPathResolution[]>;
  readRepository(root: string): Promise<RepositorySnapshot>;
  readGithub(root: string): Promise<GithubQuery<GithubRepositoryStatus>>;
  listIssues(root: string): Promise<GithubQuery<GithubIssueSummary[]>>;
  getIssue(
    root: string,
    number: number,
  ): Promise<GithubQuery<GithubIssueDetail>>;
  listPulls(root: string): Promise<GithubQuery<GithubPullSummary[]>>;
  getPull(
    root: string,
    number: number,
  ): Promise<GithubQuery<GithubPullDetail>>;
  openExternal(url: string): Promise<void>;
  revealFolder(path: string): Promise<void>;
}
