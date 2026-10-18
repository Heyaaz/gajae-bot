import { execFile } from "node:child_process";
import path from "node:path";
import { REPO_LIST_LIMIT } from "../shared/repo-ipc.js";
import type {
  GithubIssueDetail,
  GithubIssueSummary,
  GithubLabel,
  GithubPullDetail,
  GithubPullSummary,
  GithubQuery,
  GithubRepositoryStatus,
  GithubReview,
  GithubReviewState,
  ProjectPathResolution,
  RepoBranch,
  RepoCiSummary,
  RepoWorktree,
  RepositoryRemote,
  RepositorySnapshot,
} from "../shared/repo-ipc.js";

/**
 * Read-only Git and GitHub reads for the repository screen.
 *
 * Every command here answers a question; nothing stages, commits, pushes, resets
 * or deletes. `gh` is asked only to read, and its own keyring owns the
 * credential, so no value this module produces can carry one. A GitHub failure is
 * a state (`GithubQuery`) rather than a thrown error because the screen has to
 * say *which* failure it was: "no remote", "not GitHub", "no gh", "not logged
 * in" and "offline" need different fixes from the person reading.
 */

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export type CommandRunner = (file: string, args: readonly string[]) => Promise<CommandResult>;

export interface RepoServiceOptions {
  /** Git binary; defaults to the one on PATH. */
  gitExecutable?: string;
  /** GitHub CLI binary; defaults to the one on PATH. */
  ghExecutable?: string;
  /** The command runner; the shipped one spawns real processes. */
  run?: CommandRunner;
  /** Clock used for cache expiry and `refreshedAt`. */
  now?: () => number;
  /** How long one path's project root answer is reused. */
  resolveCacheMs?: number;
}

const GIT_TIMEOUT = 10_000;
const GH_TIMEOUT = 25_000;
const MAX_BUFFER = 4 * 1024 * 1024;
const DEFAULT_RESOLVE_CACHE_MS = 5000;
/**
 * Git processes one RepoService may run at once.
 *
 * The rail asks about as many paths as it has workspaces, and a refresh can run
 * while the previous one is still going. Without a gate that became one process
 * per worktree per refresh; a repository with many linked worktrees could starve
 * the app of file descriptors and processes. Eight keeps the fan-out useful while
 * bounding it.
 */
const MAX_GIT_PROCESSES = 8;
/** A retry is only for a failure the machine can recover from by itself. */
const TRANSIENT_GIT_FAILURE = /\b(?:EAGAIN|EMFILE|ENFILE|ENOMEM|EBUSY|ETIMEDOUT)\b/u;
const DETAIL_LIMIT = 200;
const GITHUB_HOST = "github.com";

/** Token shapes that must never survive into a message the screen shows. */
const CREDENTIAL =
  /(gh[pousr]_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,}|[A-Za-z0-9_-]{30,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,})/gu;

/**
 * Git's own refusals for a path that is not inside a working tree.
 *
 * They are the only Git failures that mean "this path is not a repository"; every
 * other failure is a repository the read could not reach, which is a different
 * thing to report.
 */
const NOT_A_REPOSITORY = /not a git repository|not a working tree|must be run in a work tree/iu;

/**
 * Whether a Git failure is about resources rather than the path.
 *
 * A spawn that ran out of file descriptors or memory says nothing about whether
 * the path is a repository, so caching it as "outside Git" would hide the project
 * for the whole cache window and repeat the same starvation.
 */
function isTransientGitFailure(error: unknown): boolean {
  const code = (error as { code?: unknown } | undefined)?.code;
  return (
    (typeof code === "string" && TRANSIENT_GIT_FAILURE.test(code)) ||
    TRANSIENT_GIT_FAILURE.test(errorText(error))
  );
}

/**
 * The shipped runner.
 *
 * `execFile` reports a failed spawn through the error and a refused command
 * through stderr, and both have to arrive as one rejection a human can read. The
 * message is built here rather than taken from Node's exec message format, and
 * a spawn that never happened keeps its `code` so ENOENT is still recognizable.
 * A `gh` call crosses the network and gets the longer budget; a local Git read
 * never needs it.
 */
export function defaultCommandRunner(ghExecutable: string): CommandRunner {
  return (file, args) =>
    new Promise<CommandResult>((resolve, reject) => {
      const timeout = file === ghExecutable ? GH_TIMEOUT : GIT_TIMEOUT;
      execFile(file, args, { timeout, maxBuffer: MAX_BUFFER, windowsHide: true }, (error, stdout, stderr) => {
        if (error) {
          reject(commandFailure(file, error, stderr));
          return;
        }
        resolve({ stdout, stderr });
      });
    });
}

function commandFailure(
  file: string,
  error: { message: string; code?: string | number | null },
  stderr: string,
): Error {
  const failure = new Error(stderr.trim() || error.message || `${file} 실행이 실패했습니다.`);
  if (typeof error.code === "string") (failure as { code?: string }).code = error.code;
  return failure;
}

/**
 * `git worktree list --porcelain` is a sequence of blank-line separated blocks,
 * and the first block is the main working tree. Every block opens with its
 * `worktree` line, so the blocks are followed as attributes of the latest one
 * and anything else on the output (a detached marker, a `bare` marker, a stray
 * line) is simply ignored.
 */
export function parseWorktreeList(stdout: string): RepoWorktree[] {
  const worktrees: RepoWorktree[] = [];
  let current: RepoWorktree | undefined;
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const separator = line.indexOf(" ");
    const key = separator < 0 ? line : line.slice(0, separator);
    const value = separator < 0 ? "" : line.slice(separator + 1).trim();
    if (key === "worktree") {
      if (!value) continue;
      current = {
        path: value,
        head: "",
        main: worktrees.length === 0,
        locked: false,
        prunable: false,
      };
      worktrees.push(current);
      continue;
    }
    if (!current) continue;
    if (key === "HEAD") current.head = value;
    else if (key === "branch") {
      const name = value.replace(/^refs\/heads\//u, "");
      if (name) current.branch = name;
    } else if (key === "locked") current.locked = true;
    else if (key === "prunable") current.prunable = true;
  }
  return worktrees;
}

/**
 * How many entries `git status --porcelain=v1 -z` reported.
 *
 * Each entry is `<XY> <path>` followed by a NUL, and a rename or a copy appends
 * the original path as one more field, so counting fields would report a single
 * renamed file as two changes. The rename letter is read from the index column,
 * which is where Git puts it, and the field that follows it is skipped.
 */
export function countStatusEntries(stdout: string): number {
  const fields = stdout.split("\0");
  let entries = 0;
  for (let index = 0; index < fields.length; index += 1) {
    const entry = fields[index];
    if (entry.length === 0) continue;
    entries += 1;
    const staged = entry[0];
    const followedByOriginalPath =
      staged === "R" || staged === "C"
        ? index + 1 < fields.length && fields[index + 1].length > 0
        : false;
    if (followedByOriginalPath) index += 1;
  }
  return entries;
}

/** The parts of a GitHub remote the repository screen needs. */
export interface GithubRemote {
  host: string;
  owner: string;
  name: string;
  slug: string;
  webUrl: string;
}

const REMOTE_SCHEMES = new Set(["https:", "http:", "ssh:", "git:"]);
const SCP_REMOTE = /^(?:[^/@:]+@)?([^/@:]+):(?!\/)(.+)$/u;

/** Remove URL userinfo before a remote URL crosses the repository screen boundary. */
function publicRemoteUrl(url: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(url)) {
    try {
      const parsed = new URL(url);
      parsed.username = "";
      parsed.password = "";
      return parsed.toString().replace(/\/$/u, url.endsWith("/") ? "/" : "");
    } catch {
      // Preserve malformed remotes; normal parsing still decides whether they
      // can be identified, and the output sanitizer below handles known forms.
    }
  }
  return url.replace(/^([^/@:]+)@([^/@:]+):(?!\/)/u, "$2:");
}

/**
 * A remote URL reduced to its GitHub parts.
 *
 * Only github.com itself counts. GitHub Enterprise serves the same URL shapes on
 * another host, and the screen has to report "비GitHub remote" there instead of
 * linking to a repository nobody asked about. A nested group (`owner/sub/name`)
 * is not a GitHub repository either, and neither is `www.github.com`, which is
 * why the host is compared whole rather than by suffix.
 */
export function parseGithubRemote(url: string): GithubRemote | undefined {
  const trimmed = url.trim();
  if (!trimmed) return undefined;
  let host: string;
  let pathPart: string;
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed)) {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return undefined;
    }
    if (!REMOTE_SCHEMES.has(parsed.protocol)) return undefined;
    host = parsed.hostname;
    pathPart = parsed.pathname;
  } else {
    const scp = SCP_REMOTE.exec(trimmed);
    if (!scp) return undefined;
    host = scp[1];
    pathPart = scp[2];
  }
  if (host.toLowerCase() !== GITHUB_HOST) return undefined;
  const segments = pathPart.split("/").filter((segment) => segment.length > 0);
  if (segments.length !== 2) return undefined;
  const owner = segments[0];
  const name = segments[1].replace(/\.git$/u, "");
  if (!owner || !name) return undefined;
  return {
    host: GITHUB_HOST,
    owner,
    name,
    slug: `${GITHUB_HOST}/${owner}/${name}`,
    webUrl: `https://${GITHUB_HOST}/${owner}/${name}`,
  };
}

const FAILING_CONCLUSIONS = new Set(["FAILURE", "TIMED_OUT", "STARTUP_FAILURE", "ACTION_REQUIRED", "STALE"]);
const FAILING_STATES = new Set(["FAILURE", "ERROR"]);
const PENDING_STATES = new Set(["PENDING", "EXPECTED"]);

/**
 * One check entry, whichever shape it arrived in.
 *
 * A check run carries `status` + `conclusion`; a status context carries `state`.
 * A status that is set but not COMPLETED is still running, and a status this
 * build has never seen lands there too — fail closed, because a check nobody
 * understands is not a passing check.
 */
function entryOutcome(entry: unknown): "failing" | "pending" | "passing" {
  const source = asRecord(entry);
  const status = upper(source.status);
  const conclusion = upper(source.conclusion);
  const state = upper(source.state);
  if (FAILING_CONCLUSIONS.has(conclusion) || FAILING_STATES.has(state)) return "failing";
  if ((status !== "" && status !== "COMPLETED") || PENDING_STATES.has(state)) return "pending";
  return "passing";
}

function summarize(entries: readonly unknown[]): RepoCiSummary {
  let failing = 0;
  let pending = 0;
  for (const entry of entries) {
    const outcome = entryOutcome(entry);
    if (outcome === "failing") failing += 1;
    else if (outcome === "pending") pending += 1;
  }
  const total = entries.length;
  const state = total === 0 ? "none" : failing > 0 ? "failing" : pending > 0 ? "pending" : "passing";
  return { state, total, failing, pending };
}

/** The default branch's `check_runs` array. */
export function summarizeCheckRuns(entries: readonly unknown[]): RepoCiSummary {
  return summarize(entries);
}

/** A pull's `statusCheckRollup`, which mixes check runs and status contexts. */
export function summarizeRollup(entries: readonly unknown[]): RepoCiSummary {
  return summarize(entries);
}

export interface GithubFailureClassification {
  state: "no-cli" | "unauthenticated" | "unreachable" | "error";
  detail: string;
}

/**
 * The wording a shell uses when the binary itself is missing, as a backstop to
 * the spawn error's code. `not found` on its own is not that wording: `gh` prints
 * GitHub's 404 as `gh: Not Found (HTTP 404)`, which is a repository the signed-in
 * account cannot see, so classifying it as a missing CLI would name the wrong fix.
 */
const NO_CLI = /ENOENT|command not found|not recognized as an internal or external command/iu;
const UNAUTHENTICATED = /gh auth login|not logged|authentication|Bad credentials|HTTP 401|401 Unauthorized/iu;
const UNREACHABLE =
  /could not resolve host|no such host|dial tcp|network is unreachable|connection refused|i\/o timeout|timed out|timeout|proxy|TLS handshake|HTTP 50[0-9]|HTTP 429|rate limit/iu;

/**
 * Which failure state an error is.
 *
 * The states exist because the screen has to tell them apart: a missing CLI, a
 * CLI that is not logged in, a network that cannot reach GitHub, and an API that
 * refused the query. The detail carries a redacted reason and never a token.
 */
export function classifyGithubFailure(error: unknown): GithubFailureClassification {
  const message = errorText(error);
  const code = (error as { code?: unknown } | null | undefined)?.code;
  if (code === "ENOENT" || NO_CLI.test(message)) {
    return { state: "no-cli", detail: "GitHub CLI(gh)를 찾을 수 없습니다." };
  }
  const reason = redactDetail(message);
  if (UNAUTHENTICATED.test(message)) {
    return { state: "unauthenticated", detail: redactDetail(`GitHub 인증이 필요합니다. ${reason}`) };
  }
  if (UNREACHABLE.test(message)) {
    return { state: "unreachable", detail: reason || "GitHub에 연결할 수 없습니다." };
  }
  return { state: "error", detail: reason || "GitHub 정보를 읽지 못했습니다." };
}

/** Everything an error can say. The environment is never read here. */
function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (!error || typeof error !== "object") return "";
  const source = error as { message?: unknown; stderr?: unknown };
  const parts = [source.message, source.stderr].filter(
    (part): part is string => typeof part === "string" && part.length > 0,
  );
  return parts.filter((part, index) => parts.indexOf(part) === index).join(" ");
}

/**
 * A one-line, bounded, credential-free version of a diagnostic.
 *
 * Errors arrive from Git, from `gh` and from the network, and any of them can
 * quote a token or a wall of stderr; this is what the screen is allowed to show.
 * The ellipsis is part of the budget: the whole detail is at most 200 characters.
 */
export function redactDetail(text: string): string {
  const collapsed = text.replace(CREDENTIAL, "[redacted]").replace(/\s+/gu, " ").trim();
  return collapsed.length > DETAIL_LIMIT
    ? `${collapsed.slice(0, DETAIL_LIMIT - 1)}…`
    : collapsed;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  return typeof value === "string" ? value : "";
}

function upper(value: unknown): string {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

function amount(source: Record<string, unknown>, key: string): number {
  const value = source[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function issueState(value: string): "open" | "closed" {
  return value.toLowerCase() === "open" ? "open" : "closed";
}

function pullState(value: string): "open" | "closed" | "merged" {
  const state = value.toLowerCase();
  if (state === "open") return "open";
  if (state === "merged") return "merged";
  return "closed";
}

function reviewDecision(value: string): GithubReviewState {
  switch (value.trim().toUpperCase()) {
    case "APPROVED":
      return "approved";
    case "CHANGES_REQUESTED":
      return "changes-requested";
    case "REVIEW_REQUIRED":
      return "review-required";
    default:
      return "none";
  }
}

function reviewOutcome(value: string): GithubReview["state"] {
  switch (value.trim().toUpperCase()) {
    case "APPROVED":
      return "approved";
    case "CHANGES_REQUESTED":
      return "changes-requested";
    case "COMMENTED":
      return "commented";
    case "DISMISSED":
      return "dismissed";
    default:
      return "pending";
  }
}

function mergeableState(value: string): GithubPullDetail["mergeable"] {
  switch (value.trim().toUpperCase()) {
    case "MERGEABLE":
      return "mergeable";
    case "CONFLICTING":
      return "conflicting";
    default:
      return "unknown";
  }
}

function labelsOf(value: unknown): GithubLabel[] {
  return asList(value).map((entry) => {
    const label = asRecord(entry);
    return { name: text(label, "name"), color: text(label, "color") };
  });
}

function loginsOf(value: unknown): string[] {
  return asList(value)
    .map((entry) => text(asRecord(entry), "login"))
    .filter((login) => login.length > 0);
}

function parseIssue(value: unknown): GithubIssueSummary {
  const source = asRecord(value);
  return {
    number: amount(source, "number"),
    title: text(source, "title"),
    state: issueState(text(source, "state")),
    url: text(source, "url"),
    author: text(asRecord(source.author), "login"),
    labels: labelsOf(source.labels),
    comments: amount(source, "comments"),
    updatedAt: text(source, "updatedAt"),
  };
}

function parseIssueDetail(value: unknown): GithubIssueDetail {
  const source = asRecord(value);
  return {
    ...parseIssue(source),
    body: text(source, "body"),
    createdAt: text(source, "createdAt"),
    assignees: loginsOf(source.assignees),
  };
}

function parsePull(value: unknown): GithubPullSummary {
  const source = asRecord(value);
  return {
    number: amount(source, "number"),
    title: text(source, "title"),
    state: pullState(text(source, "state")),
    draft: source.isDraft === true,
    url: text(source, "url"),
    author: text(asRecord(source.author), "login"),
    headRefName: text(source, "headRefName"),
    baseRefName: text(source, "baseRefName"),
    review: reviewDecision(text(source, "reviewDecision")),
    ci: summarizeRollup(asList(source.statusCheckRollup)),
    updatedAt: text(source, "updatedAt"),
  };
}

function parsePullDetail(value: unknown): GithubPullDetail {
  const source = asRecord(value);
  return {
    ...parsePull(source),
    body: text(source, "body"),
    createdAt: text(source, "createdAt"),
    mergeable: mergeableState(text(source, "mergeable")),
    additions: amount(source, "additions"),
    deletions: amount(source, "deletions"),
    changedFiles: amount(source, "changedFiles"),
    reviews: asList(source.reviews).map((entry) => {
      const review = asRecord(entry);
      const submittedAt = text(review, "submittedAt");
      return {
        author: text(asRecord(review.author), "login"),
        state: reviewOutcome(text(review, "state")),
        // Absent `submittedAt` stays absent: a pending review has not been sent.
        ...(submittedAt ? { submittedAt } : {}),
      };
    }),
  };
}

const ISSUE_FIELDS = "number,title,state,url,labels,comments,updatedAt,author";
const ISSUE_DETAIL_FIELDS = `${ISSUE_FIELDS},body,createdAt,assignees`;
const PULL_FIELDS =
  "number,title,state,isDraft,url,author,headRefName,baseRefName,reviewDecision,updatedAt,statusCheckRollup";
const PULL_DETAIL_FIELDS =
  "number,title,state,isDraft,url,author,headRefName,baseRefName,reviewDecision,updatedAt,createdAt,body,mergeable,additions,deletions,changedFiles,statusCheckRollup,reviews";

interface CachedResolution {
  at: number;
  resolution: ProjectPathResolution;
}

export class RepoService {
  private readonly gitExecutable: string;
  private readonly ghExecutable: string;
  private readonly run: CommandRunner;
  private readonly now: () => number;
  private readonly resolveCacheMs: number;
  private readonly resolutions = new Map<string, CachedResolution>();
  private readonly pendingResolutions = new Map<string, Promise<ProjectPathResolution>>();
  private readonly pendingReads = new Map<string, Promise<RepositorySnapshot>>();
  private gitActive = 0;
  private readonly gitQueue: Array<() => void> = [];

  constructor(options: RepoServiceOptions = {}) {
    this.gitExecutable = options.gitExecutable ?? "git";
    this.ghExecutable = options.ghExecutable ?? "gh";
    this.run = options.run ?? defaultCommandRunner(this.ghExecutable);
    this.now = options.now ?? Date.now;
    this.resolveCacheMs = options.resolveCacheMs ?? DEFAULT_RESOLVE_CACHE_MS;
  }

  /**
   * The project root behind each asked path, one answer per input.
   *
   * Failures are answers too: a workspace outside Git keeps its own path as its
   * root, because the sessions of such a workspace still have to live somewhere
   * in the rail. Nothing here throws, so no session can be lost to a directory
   * that moved or a Git that is not installed.
   */
  async resolveProjects(paths: readonly string[]): Promise<ProjectPathResolution[]> {
    const asked = [...new Set(paths.map((entry) => entry.trim()))];
    const resolved = new Map<string, ProjectPathResolution>();
    await Promise.all(
      asked.map(async (trimmed) => {
        resolved.set(trimmed, await this.resolveProject(trimmed));
      }),
    );
    // A repeated path repeats its entry: the renderer indexes this list against
    // the workspaces it asked about.
    return paths.map((inputPath) => {
      const trimmed = inputPath.trim();
      const entry = resolved.get(trimmed);
      return entry ? { ...entry, path: inputPath } : { path: inputPath, root: inputPath, repository: false };
    });
  }

  private async resolveProject(trimmed: string): Promise<ProjectPathResolution> {
    const cached = this.resolutions.get(trimmed);
    if (cached && this.now() - cached.at < this.resolveCacheMs) return cached.resolution;
    // A rail refresh and the refresh that follows it can ask about the same
    // workspace before the first answer lands. Both share one lookup instead of
    // spawning the same Git twice.
    const pending = this.pendingResolutions.get(trimmed);
    if (pending) return pending;
    const lookup = this.lookupProject(trimmed).then(({ resolution, cacheable }) => {
      if (cacheable) this.resolutions.set(trimmed, { at: this.now(), resolution });
      return resolution;
    });
    this.pendingResolutions.set(trimmed, lookup);
    try {
      return await lookup;
    } finally {
      this.pendingResolutions.delete(trimmed);
    }
  }

  private async lookupProject(
    trimmed: string,
  ): Promise<{ resolution: ProjectPathResolution; cacheable: boolean }> {
    const outside = { path: trimmed, root: trimmed, repository: false };
    if (!trimmed || !path.isAbsolute(trimmed)) return { resolution: outside, cacheable: true };
    for (let attempt = 0; ; attempt += 1) {
      try {
        const listed = await this.git(["worktree", "list", "--porcelain"], trimmed);
        const [main] = parseWorktreeList(listed.stdout);
        return {
          resolution: main ? { path: trimmed, root: main.path, repository: true } : outside,
          cacheable: true,
        };
      } catch (error) {
        // Resource exhaustion is not an answer about the path. Give the machine
        // one chance to recover under the process gate, and never persist the
        // failure: a temporary EMFILE must not read as "outside Git" for the
        // cache window.
        if (attempt === 0 && isTransientGitFailure(error)) {
          await new Promise((resolve) => setTimeout(resolve, 25));
          continue;
        }
        // Other failures are cached: a workspace outside Git is asked about on
        // every rail refresh, and hearing "not a repository" again is not worth
        // a process spawn.
        return { resolution: outside, cacheable: !isTransientGitFailure(error) };
      }
    }
  }

  /**
   * The local repository behind a project root.
   *
   * Outside Git is a state rather than a failure: the project exists and its
   * sessions are where they were, it simply has nothing to draw. A read that
   * fails *inside* a repository is reported through `error` so the screen does
   * not show a half-read repository as if it were the whole truth.
   */
  async readRepository(root: string): Promise<RepositorySnapshot> {
    // Opening and refreshing the repository panel can overlap. A shared read
    // keeps one worktree fan-out per root in flight at a time.
    const pending = this.pendingReads.get(root);
    if (pending) return pending;
    const read = this.readRepositoryNow(root);
    this.pendingReads.set(root, read);
    try {
      return await read;
    } finally {
      this.pendingReads.delete(root);
    }
  }

  private async readRepositoryNow(root: string): Promise<RepositorySnapshot> {
    const name = path.basename(root);
    const refreshedAt = new Date(this.now()).toISOString();
    let worktrees: RepoWorktree[];
    let failure: string | undefined;
    try {
      const listed = await this.git(["worktree", "list", "--porcelain"], root);
      worktrees = parseWorktreeList(listed.stdout);
    } catch (error) {
      worktrees = [];
      // Git refusing the path is the same as the path being outside Git only
      // when Git says so. A missing binary, a `safe.directory` refusal or a
      // permission error would otherwise be drawn as a project that has no
      // repository, which asks the user to fix the wrong thing.
      if (!NOT_A_REPOSITORY.test(errorText(error)))
        failure = redactDetail(errorText(error)) || "저장소를 읽지 못했습니다.";
    }
    if (worktrees.length === 0) {
      const empty: RepositorySnapshot = {
        root,
        name,
        repository: false,
        branch: "",
        branches: [],
        worktrees: [],
        refreshedAt,
      };
      if (failure) empty.error = failure;
      return empty;
    }
    const failures: string[] = [];
    // The change counts, the branch list and the remote answer independent
    // questions, so they are asked at once instead of in a chain of round trips.
    const [changed, branches, remote] = await Promise.all([
      Promise.all(worktrees.map((worktree) => this.changedEntries(worktree.path))),
      this.guarded<RepoBranch[]>("브랜치 목록", failures, () => this.listBranches(root, worktrees), []),
      this.guarded<RepositoryRemote | undefined>("원격", failures, () => this.readRemote(root), undefined),
    ]);
    changed.forEach((count, index) => {
      // Absent means "could not read", which is not the same as clean.
      if (count !== undefined) worktrees[index].changed = count;
    });
    const snapshot: RepositorySnapshot = {
      root,
      name,
      repository: true,
      branch: worktrees[0].branch ?? "",
      branches,
      worktrees,
      refreshedAt,
    };
    if (remote) snapshot.remote = remote;
    if (failures.length > 0) {
      snapshot.error = redactDetail(`저장소 정보를 일부만 읽었습니다: ${failures.join("; ")}`);
    }
    return snapshot;
  }

  /** `git status --porcelain` entries for one working tree, or undefined. */
  private async changedEntries(worktreePath: string): Promise<number | undefined> {
    try {
      const status = await this.git(["status", "--porcelain=v1", "-z"], worktreePath);
      return countStatusEntries(status.stdout);
    } catch {
      return undefined;
    }
  }

  /**
   * Local branches, each with the worktree that has it checked out.
   *
   * The upstream column comes along because Git prints these two fields in one
   * cheap call; the screen only shows names and checkouts. A detached HEAD is a
   * synthetic `(HEAD detached at …)` row, not a branch.
   */
  private async listBranches(root: string, worktrees: readonly RepoWorktree[]): Promise<RepoBranch[]> {
    const listed = await this.git(["branch", "--format=%(refname:short)%09%(upstream:short)"], root);
    const branches = new Map<string, RepoBranch>();
    for (const raw of listed.stdout.split("\n")) {
      const name = raw.split("\t")[0].trim();
      if (!name || name.startsWith("(HEAD detached")) continue;
      if (!branches.has(name)) branches.set(name, { name });
    }
    for (const worktree of worktrees) {
      if (!worktree.branch) continue;
      const branch = branches.get(worktree.branch);
      if (branch) branch.worktreePath = worktree.path;
    }
    return [...branches.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  /**
   * The remote the screen reports and links.
   *
   * `origin` is the convention for the repository a person means, so it wins
   * even when another remote is listed first. A remote with no URL is omitted.
   */
  private async readRemote(root: string): Promise<RepositoryRemote | undefined> {
    const listed = await this.git(["remote"], root);
    const names = listed.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((name) => name.length > 0);
    if (names.length === 0) return undefined;
    const name = names.includes("origin") ? "origin" : names[0];
    const fetched = await this.git(["remote", "get-url", name], root);
    const url = fetched.stdout.trim();
    if (!url) return undefined;
    const github = parseGithubRemote(url);
    const publicUrl = publicRemoteUrl(url);
    return github
      ? { name, url: publicUrl, slug: github.slug, webUrl: github.webUrl }
      : { name, url: publicUrl };
  }

  /**
   * Every GitHub read starts from the same two questions: which remote, and is
   * it GitHub. Only then is `gh` asked, and only to read.
   */
  private async githubQuery<T>(
    root: string,
    query: (owner: string, name: string) => Promise<T>,
  ): Promise<GithubQuery<T>> {
    let remote: RepositoryRemote | undefined;
    try {
      remote = await this.readRemote(root);
    } catch (error) {
      // The remote itself could not be read, which says nothing about `gh`.
      return { state: "error", detail: redactDetail(errorText(error)) || "원격 저장소를 읽지 못했습니다." };
    }
    if (!remote) return { state: "no-remote" };
    const github = parseGithubRemote(remote.url);
    if (!github) return { state: "not-github", remote: remote.url };
    try {
      return { state: "ok", value: await query(github.owner, github.name) };
    } catch (error) {
      return classifyGithubFailure(error);
    }
  }

  private async ghJson(args: readonly string[]): Promise<unknown> {
    const result = await this.run(this.ghExecutable, args);
    try {
      return JSON.parse(result.stdout) as unknown;
    } catch {
      const sample = result.stdout.trim().slice(0, DETAIL_LIMIT);
      throw new Error(sample ? `gh 응답을 읽지 못했습니다: ${sample}` : "gh가 빈 응답을 반환했습니다.");
    }
  }

  async readGithub(root: string): Promise<GithubQuery<GithubRepositoryStatus>> {
    return this.githubQuery(root, async (owner, name) => {
      const fullName = `${owner}/${name}`;
      const repository = asRecord(await this.ghJson(["api", `repos/${fullName}`]));
      const defaultBranch = text(repository, "default_branch");
      const [issues, pulls, checks] = await Promise.all([
        this.ghJson(["api", `search/issues?q=repo:${fullName}+is:issue+is:open&per_page=1`]),
        this.ghJson(["api", `search/issues?q=repo:${fullName}+is:pr+is:open&per_page=1`]),
        // A repository whose default branch is missing would build an empty
        // path; HEAD is the commit that branch points at.
        this.ghJson(["api", `repos/${fullName}/commits/${defaultBranch || "HEAD"}/check-runs?per_page=100`]),
      ]);
      return {
        fullName,
        url: `https://${GITHUB_HOST}/${fullName}`,
        defaultBranch,
        openIssues: amount(asRecord(issues), "total_count"),
        openPulls: amount(asRecord(pulls), "total_count"),
        ci: summarizeCheckRuns(asList(asRecord(checks).check_runs)),
        private: repository.private === true,
      };
    });
  }

  async listIssues(root: string): Promise<GithubQuery<GithubIssueSummary[]>> {
    return this.githubQuery(root, async (owner, name) =>
      asList(
        await this.ghJson([
          "issue",
          "list",
          "--repo",
          `${owner}/${name}`,
          "--state",
          "open",
          "--limit",
          String(REPO_LIST_LIMIT),
          "--json",
          ISSUE_FIELDS,
        ]),
      ).map(parseIssue),
    );
  }

  async getIssue(root: string, number: number): Promise<GithubQuery<GithubIssueDetail>> {
    return this.githubQuery(root, async (owner, name) =>
      parseIssueDetail(
        await this.ghJson([
          "issue",
          "view",
          String(number),
          "--repo",
          `${owner}/${name}`,
          "--json",
          ISSUE_DETAIL_FIELDS,
        ]),
      ),
    );
  }

  async listPulls(root: string): Promise<GithubQuery<GithubPullSummary[]>> {
    return this.githubQuery(root, async (owner, name) =>
      asList(
        await this.ghJson([
          "pr",
          "list",
          "--repo",
          `${owner}/${name}`,
          "--state",
          "open",
          "--limit",
          String(REPO_LIST_LIMIT),
          "--json",
          PULL_FIELDS,
        ]),
      ).map(parsePull),
    );
  }

  async getPull(root: string, number: number): Promise<GithubQuery<GithubPullDetail>> {
    return this.githubQuery(root, async (owner, name) =>
      parsePullDetail(
        await this.ghJson([
          "pr",
          "view",
          String(number),
          "--repo",
          `${owner}/${name}`,
          "--json",
          PULL_DETAIL_FIELDS,
        ]),
      ),
    );
  }

  private async git(args: readonly string[], cwd: string): Promise<CommandResult> {
    if (this.gitActive >= MAX_GIT_PROCESSES) {
      await new Promise<void>((resolve) => this.gitQueue.push(resolve));
    }
    this.gitActive += 1;
    try {
      return await this.run(this.gitExecutable, ["-C", cwd, ...args]);
    } finally {
      this.gitActive -= 1;
      this.gitQueue.shift()?.();
    }
  }

  /**
   * A read that can fail without sinking the snapshot.
   *
   * What did work is still returned; the failure is named so the screen reports
   * it instead of drawing an empty list as if the repository simply had none.
   */
  private async guarded<T>(
    part: string,
    failures: string[],
    read: () => Promise<T>,
    fallback: T,
  ): Promise<T> {
    try {
      return await read();
    } catch (error) {
      failures.push(`${part}: ${redactDetail(errorText(error)) || "읽지 못했습니다."}`);
      return fallback;
    }
  }
}
