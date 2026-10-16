import { describe, expect, it } from "vitest";
import { REPO_LIST_LIMIT } from "../shared/repo-ipc.js";
import {
  RepoService,
  classifyGithubFailure,
  defaultCommandRunner,
  parseGithubRemote,
  parseWorktreeList,
  redactDetail,
  summarizeCheckRuns,
  summarizeRollup,
} from "./repo-service.js";
import type { CommandResult, CommandRunner } from "./repo-service.js";

type Route = CommandResult | Error;

const ok = (stdout: string): CommandResult => ({ stdout, stderr: "" });
const failed = (stderr: string): Error => new Error(stderr);
const missing = (file: string): Error =>
  Object.assign(new Error(`spawn ${file} ENOENT`), { code: "ENOENT" });

// GitHub-token shapes only: built at run time so no token literal sits in the
// source, and unreachable as credentials either way.
const FAKE_TOKEN = `ghp_${"A".repeat(36)}`;
const FAKE_PAT = `github_pat_${"B".repeat(20)}`;

/** A runner keyed by the exact command line; anything else is a test bug. */
function fakeRunner(routes: Record<string, Route | undefined>) {
  const calls: string[] = [];
  const run: CommandRunner = async (file, args) => {
    const key = [file, ...args].join(" ");
    calls.push(key);
    const route = routes[key];
    if (!route) throw new Error(`unexpected command: ${key}`);
    if (route instanceof Error) throw route;
    return route;
  };
  return { run, calls };
}

const MAIN = "/projects/app";
const LINKED = "/projects/app-feature";
const NOTES = "/notes";
const MAIN_HEAD = "1111111111111111111111111111111111111111";
const LINKED_HEAD = "2222222222222222222222222222222222222222";

/** `git worktree list --porcelain` for a repository with one linked worktree. */
const WORKTREES = [
  `worktree ${MAIN}`,
  `HEAD ${MAIN_HEAD}`,
  "branch refs/heads/main",
  "",
  `worktree ${LINKED}`,
  `HEAD ${LINKED_HEAD}`,
  "branch refs/heads/feature/login",
  "",
].join("\n");

const WORKTREE_LIST = `git -C ${MAIN} worktree list --porcelain`;
const LINKED_LIST = `git -C ${LINKED} worktree list --porcelain`;
const NOTES_LIST = `git -C ${NOTES} worktree list --porcelain`;
const MAIN_STATUS = `git -C ${MAIN} status --porcelain=v1 -z`;
const LINKED_STATUS = `git -C ${LINKED} status --porcelain=v1 -z`;
const BRANCH_FORMAT = `git -C ${MAIN} branch --format=%(refname:short)%09%(upstream:short)`;
const MAIN_REMOTE = `git -C ${MAIN} remote`;
const MAIN_ORIGIN_URL = `git -C ${MAIN} remote get-url origin`;
const NOTES_REMOTE = `git -C ${NOTES} remote`;

const GITHUB_URL = "https://github.com/owner/app.git";
const GITHUB_WEB_URL = "https://github.com/owner/app";

const REPO_API = "gh api repos/owner/app";
const ISSUE_SEARCH = "gh api search/issues?q=repo:owner/app+is:issue+is:open&per_page=1";
const PULL_SEARCH = "gh api search/issues?q=repo:owner/app+is:pr+is:open&per_page=1";
const CHECK_RUNS = "gh api repos/owner/app/commits/main/check-runs?per_page=100";
const CHECK_RUNS_HEAD = "gh api repos/owner/app/commits/HEAD/check-runs?per_page=100";
const ISSUE_LIST = `gh issue list --repo owner/app --state open --limit ${REPO_LIST_LIMIT} --json number,title,state,url,labels,comments,updatedAt,author`;
const ISSUE_VIEW =
  "gh issue view 12 --repo owner/app --json number,title,state,url,labels,comments,updatedAt,author,body,createdAt,assignees";
const PULL_LIST = `gh pr list --repo owner/app --state open --limit ${REPO_LIST_LIMIT} --json number,title,state,isDraft,url,author,headRefName,baseRefName,reviewDecision,updatedAt,statusCheckRollup`;
const PULL_VIEW =
  "gh pr view 9 --repo owner/app --json number,title,state,isDraft,url,author,headRefName,baseRefName,reviewDecision,updatedAt,createdAt,body,mergeable,additions,deletions,changedFiles,statusCheckRollup,reviews";

function repositoryRoutes(extra: Record<string, Route | undefined> = {}): Record<string, Route | undefined> {
  return {
    [WORKTREE_LIST]: ok(WORKTREES),
    [MAIN_STATUS]: ok(" M src/app.ts\0?? notes.txt\0"),
    // A worktree that cannot be read is not a clean worktree.
    [LINKED_STATUS]: failed("fatal: cannot read the working tree"),
    [BRANCH_FORMAT]: ok("main\torigin/main\nfeature/login\torigin/feature/login\n"),
    [MAIN_REMOTE]: ok("origin\n"),
    [MAIN_ORIGIN_URL]: ok(`${GITHUB_URL}\n`),
    ...extra,
  };
}

function githubRoutes(extra: Record<string, Route | undefined> = {}): Record<string, Route | undefined> {
  return {
    [MAIN_REMOTE]: ok("origin\n"),
    [MAIN_ORIGIN_URL]: ok(`${GITHUB_URL}\n`),
    ...extra,
  };
}

describe("resolveProjects", () => {
  it("answers each path with its repository's main worktree", async () => {
    const { run, calls } = fakeRunner({
      [WORKTREE_LIST]: ok(WORKTREES),
      [LINKED_LIST]: ok(WORKTREES),
      [NOTES_LIST]: failed("fatal: not a git repository (or any of the parent directories): .git"),
    });
    const service = new RepoService({ run });
    await expect(service.resolveProjects([MAIN, LINKED, NOTES, "", "relative/dir"])).resolves.toEqual([
      // A linked worktree resolves to the same project as its main worktree.
      { path: MAIN, root: MAIN, repository: true },
      { path: LINKED, root: MAIN, repository: true },
      // A path outside Git keeps its own root, because its sessions live there.
      { path: NOTES, root: NOTES, repository: false },
      { path: "", root: "", repository: false },
      { path: "relative/dir", root: "relative/dir", repository: false },
    ]);
    // Empty and relative paths are answered without a spawn.
    expect([...calls].sort()).toEqual([WORKTREE_LIST, LINKED_LIST, NOTES_LIST].sort());
  });

  it("resolves a repeated path once and repeats its answer", async () => {
    const { run, calls } = fakeRunner({ [WORKTREE_LIST]: ok(WORKTREES) });
    const resolved = await new RepoService({ run }).resolveProjects([MAIN, MAIN, MAIN]);
    expect(resolved).toHaveLength(3);
    expect(resolved.map((entry) => entry.root)).toEqual([MAIN, MAIN, MAIN]);
    expect(calls).toEqual([WORKTREE_LIST]);
  });

  it("caches answers, failures included, for resolveCacheMs", async () => {
    let clock = 1_000;
    const { run, calls } = fakeRunner({
      [WORKTREE_LIST]: ok(WORKTREES),
      [NOTES_LIST]: failed("fatal: not a git repository"),
    });
    const service = new RepoService({ run, now: () => clock, resolveCacheMs: 5_000 });
    await service.resolveProjects([MAIN, NOTES]);
    clock = 3_000;
    await service.resolveProjects([MAIN, NOTES]);
    expect(calls).toHaveLength(2);
    clock = 6_001;
    await service.resolveProjects([MAIN, NOTES]);
    // One second past the window, both the answer and the failure are asked again.
    expect(calls).toHaveLength(4);
  });

  it("keeps the asked path verbatim while resolving the trimmed one", async () => {
    const { run, calls } = fakeRunner({ [WORKTREE_LIST]: ok(WORKTREES) });
    await expect(new RepoService({ run }).resolveProjects([`  ${MAIN}\t`])).resolves.toEqual([
      { path: `  ${MAIN}\t`, root: MAIN, repository: true },
    ]);
    expect(calls).toEqual([WORKTREE_LIST]);
  });
});

describe("parseWorktreeList", () => {
  it("maps porcelain blocks, with the first one as main", () => {
    const worktrees = parseWorktreeList(
      [
        "worktree /repo",
        "HEAD aaaa",
        "branch refs/heads/main",
        "",
        "worktree /repo-topic",
        "HEAD bbbb",
        "branch refs/heads/topic",
        "",
        "worktree /repo-detached",
        "HEAD cccc",
        "detached",
        "",
        "worktree /repo-locked",
        "HEAD dddd",
        "branch refs/heads/locked",
        "locked gitdir file points to non-existent location",
        "",
        "worktree /repo-prunable",
        "HEAD eeee",
        "detached",
        "prunable gitdir file points to non-existent location",
        "",
      ].join("\n"),
    );
    expect(worktrees).toEqual([
      { path: "/repo", head: "aaaa", branch: "main", main: true, locked: false, prunable: false },
      { path: "/repo-topic", head: "bbbb", branch: "topic", main: false, locked: false, prunable: false },
      { path: "/repo-detached", head: "cccc", main: false, locked: false, prunable: false },
      { path: "/repo-locked", head: "dddd", branch: "locked", main: false, locked: true, prunable: false },
      { path: "/repo-prunable", head: "eeee", main: false, locked: false, prunable: true },
    ]);
    // A detached HEAD names no branch at all, rather than an empty name.
    expect(worktrees[2]).not.toHaveProperty("branch");
    expect(worktrees[4]).not.toHaveProperty("branch");
  });

  it("keeps a bare entry as a main worktree only when it is first", () => {
    const [bare] = parseWorktreeList("worktree /srv/bare.git\nbare\n");
    expect(bare).toEqual({ path: "/srv/bare.git", head: "", main: true, locked: false, prunable: false });
    expect(bare).not.toHaveProperty("branch");
    const [, second] = parseWorktreeList("worktree /a\nbare\n\nworktree /b\nbare\n");
    expect(second.main).toBe(false);
  });

  it("ignores blank and garbage lines", () => {
    expect(parseWorktreeList("\nnot a shape\n\ngarbage\n")).toEqual([]);
    const [worktree] = parseWorktreeList("garbage\n\nworktree /repo\nHEAD aaaa\ndetached\n\n");
    expect(worktree).toEqual({ path: "/repo", head: "aaaa", main: true, locked: false, prunable: false });
  });
});

describe("parseGithubRemote", () => {
  const github = {
    host: "github.com",
    owner: "owner",
    name: "name",
    slug: "github.com/owner/name",
    webUrl: "https://github.com/owner/name",
  };

  it("accepts every URL shape git prints for a GitHub remote", () => {
    expect(parseGithubRemote("https://github.com/owner/name")).toEqual(github);
    expect(parseGithubRemote("https://github.com/owner/name/")).toEqual(github);
    expect(parseGithubRemote("https://github.com/owner/name.git")).toEqual(github);
    expect(parseGithubRemote("http://github.com/owner/name.git")).toEqual(github);
    expect(parseGithubRemote("git@github.com:owner/name.git")).toEqual(github);
    expect(parseGithubRemote("ssh://git@github.com:2222/owner/name.git")).toEqual(github);
    expect(parseGithubRemote("git://github.com/owner/name")).toEqual(github);
  });

  it("reads the host without regard to case", () => {
    // The same repository, written with the host capitalised the way a person might
    // paste it: the comparison is on the lowercased host, and the link it produces
    // is the canonical lowercase one.
    expect(parseGithubRemote("https://GitHub.com/owner/name")?.webUrl).toBe(
      "https://github.com/owner/name",
    );
    expect(parseGithubRemote("git@GitHub.COM:owner/name.git")?.name).toBe(
      "name",
    );
  });

  it("refuses anything that is not github.com itself", () => {
    expect(parseGithubRemote("https://gitlab.com/owner/name")).toBeUndefined();
    expect(parseGithubRemote("https://github.com.example.com/owner/name")).toBeUndefined();
    // A subdomain is not the host whose URL we would link to.
    expect(parseGithubRemote("https://www.github.com/owner/name")).toBeUndefined();
    expect(parseGithubRemote("git@ghe.example.com:owner/name.git")).toBeUndefined();
    expect(parseGithubRemote("file:///srv/owner/name")).toBeUndefined();
    expect(parseGithubRemote("")).toBeUndefined();
    expect(parseGithubRemote("not a url")).toBeUndefined();
  });

  it("refuses a nested group, which is not a GitHub repository", () => {
    expect(parseGithubRemote("https://github.com/owner/sub/name")).toBeUndefined();
    expect(parseGithubRemote("git@github.com:owner/sub/name.git")).toBeUndefined();
    expect(parseGithubRemote("https://github.com/owner")).toBeUndefined();
  });
});

describe("readRepository", () => {
  it("reads the branch, branches, worktrees and remote in one snapshot", async () => {
    const clock = Date.UTC(2026, 0, 2, 3, 4, 5);
    const { run } = fakeRunner(repositoryRoutes());
    const snapshot = await new RepoService({ run, now: () => clock }).readRepository(MAIN);
    expect(snapshot).toEqual({
      root: MAIN,
      name: "app",
      repository: true,
      branch: "main",
      remote: { name: "origin", url: GITHUB_URL, slug: "github.com/owner/app", webUrl: GITHUB_WEB_URL },
      branches: [
        { name: "feature/login", worktreePath: LINKED },
        { name: "main", worktreePath: MAIN },
      ],
      worktrees: [
        { path: MAIN, head: MAIN_HEAD, branch: "main", main: true, locked: false, prunable: false, changed: 2 },
        { path: LINKED, head: LINKED_HEAD, branch: "feature/login", main: false, locked: false, prunable: false },
      ],
      refreshedAt: new Date(clock).toISOString(),
    });
    // An unreadable working tree stays absent rather than reading as clean.
    expect(snapshot.worktrees[1]).not.toHaveProperty("changed");
  });

  it("reports a path outside Git as a state, not a failure", async () => {
    const { run, calls } = fakeRunner({ [NOTES_LIST]: failed("fatal: not a git repository") });
    const snapshot = await new RepoService({ run }).readRepository(NOTES);
    expect(snapshot).toEqual({
      root: NOTES,
      name: "notes",
      repository: false,
      branch: "",
      branches: [],
      worktrees: [],
      refreshedAt: expect.any(String),
    });
    expect(snapshot).not.toHaveProperty("error");
    // Nothing else is asked of a path that is not a repository.
    expect(calls).toEqual([NOTES_LIST]);
  });

  it("keeps what it read and names the read that failed", async () => {
    const { run } = fakeRunner(
      repositoryRoutes({
        [BRANCH_FORMAT]: failed("fatal: bad object HEAD"),
        [MAIN_REMOTE]: failed("fatal: no remotes configured"),
      }),
    );
    const snapshot = await new RepoService({ run }).readRepository(MAIN);
    expect(snapshot.repository).toBe(true);
    expect(snapshot.worktrees).toHaveLength(2);
    expect(snapshot.branch).toBe("main");
    expect(snapshot.branches).toEqual([]);
    expect(snapshot.remote).toBeUndefined();
    expect(snapshot.error).toContain("일부만");
    expect(snapshot.error).toContain("bad object HEAD");
    expect(snapshot.error).toContain("no remotes configured");
  });

  it("leaves the snapshot error-free when everything reads", async () => {
    const { run } = fakeRunner(repositoryRoutes({ [LINKED_STATUS]: ok("") }));
    const snapshot = await new RepoService({ run }).readRepository(MAIN);
    expect(snapshot).not.toHaveProperty("error");
    expect(snapshot.worktrees[1].changed).toBe(0);
  });
});

describe("GitHub failure states", () => {
  it("answers no-remote without asking gh", async () => {
    const { run, calls } = fakeRunner({ [MAIN_REMOTE]: ok("\n") });
    await expect(new RepoService({ run }).readGithub(MAIN)).resolves.toEqual({ state: "no-remote" });
    expect(calls.some((call) => call.startsWith("gh "))).toBe(false);
  });

  it("reports a remote that is not GitHub with its raw URL, preferring origin", async () => {
    const { run, calls } = fakeRunner({
      [MAIN_REMOTE]: ok("upstream\norigin\n"),
      [MAIN_ORIGIN_URL]: ok("https://gitlab.com/owner/app.git\n"),
      // Picking `upstream` here would miss this route and fail the test.
      [`git -C ${MAIN} remote get-url upstream`]: ok("https://gitlab.com/other/app.git\n"),
    });
    await expect(new RepoService({ run }).listIssues(MAIN)).resolves.toEqual({
      state: "not-github",
      remote: "https://gitlab.com/owner/app.git",
    });
    expect(calls).toContain(MAIN_ORIGIN_URL);
  });

  it("falls back to the first remote when origin is absent", async () => {
    const { run, calls } = fakeRunner({
      [MAIN_REMOTE]: ok("upstream\nfork\n"),
      [`git -C ${MAIN} remote get-url upstream`]: ok(`${GITHUB_URL}\n`),
    });
    await expect(new RepoService({ run }).githubUrlFor(MAIN)).resolves.toBe(GITHUB_WEB_URL);
    expect(calls).toContain(`git -C ${MAIN} remote get-url upstream`);
  });

  it("reports a missing CLI as no-cli", async () => {
    const { run } = fakeRunner(githubRoutes({ [REPO_API]: missing("gh") }));
    await expect(new RepoService({ run }).readGithub(MAIN)).resolves.toEqual({
      state: "no-cli",
      detail: "GitHub CLI(gh)를 찾을 수 없습니다.",
    });
  });

  it("reports a CLI that is not signed in as unauthenticated", async () => {
    const { run } = fakeRunner(
      githubRoutes({ [PULL_LIST]: failed("gh: To use GitHub CLI, run: gh auth login") }),
    );
    await expect(new RepoService({ run }).listPulls(MAIN)).resolves.toEqual({
      state: "unauthenticated",
      detail: expect.stringContaining("GitHub 인증이 필요합니다."),
    });
  });

  it("reports a network that cannot reach GitHub as unreachable", async () => {
    const { run } = fakeRunner(
      githubRoutes({
        [REPO_API]: failed(
          'error: Get "https://api.github.com/repos/owner/app": dial tcp: lookup api.github.com: no such host',
        ),
      }),
    );
    await expect(new RepoService({ run }).readGithub(MAIN)).resolves.toEqual({
      state: "unreachable",
      detail: expect.stringContaining("no such host"),
    });
  });

  it("reports an unexpected refusal as an error", async () => {
    const { run } = fakeRunner(githubRoutes({ [ISSUE_VIEW]: failed("gh: something exploded") }));
    await expect(new RepoService({ run }).getIssue(MAIN, 12)).resolves.toEqual({
      state: "error",
      detail: "gh: something exploded",
    });
  });

  it("classifies a failure from any of the parallel reads", async () => {
    const { run } = fakeRunner(
      githubRoutes({
        [REPO_API]: ok(JSON.stringify({ default_branch: "main", private: false })),
        [ISSUE_SEARCH]: failed("HTTP 401: Bad credentials"),
        [PULL_SEARCH]: ok(JSON.stringify({ total_count: 0 })),
        [CHECK_RUNS]: ok(JSON.stringify({ check_runs: [] })),
      }),
    );
    await expect(new RepoService({ run }).readGithub(MAIN)).resolves.toEqual({
      state: "unauthenticated",
      detail: expect.stringContaining("GitHub 인증이 필요합니다."),
    });
  });

  it("reports a remote read Git refused as an error, not as no-remote", async () => {
    const { run } = fakeRunner({ [MAIN_REMOTE]: failed("fatal: not a git repository") });
    await expect(new RepoService({ run }).readGithub(MAIN)).resolves.toEqual({
      state: "error",
      detail: "fatal: not a git repository",
    });
  });
});

describe("readGithub", () => {
  it("reads counts, the default branch and its checks", async () => {
    const { run, calls } = fakeRunner(
      githubRoutes({
        [REPO_API]: ok(JSON.stringify({ full_name: "owner/app", default_branch: "main", private: true })),
        [ISSUE_SEARCH]: ok(JSON.stringify({ total_count: 7 })),
        [PULL_SEARCH]: ok(JSON.stringify({ total_count: 3 })),
        [CHECK_RUNS]: ok(
          JSON.stringify({
            total_count: 2,
            check_runs: [
              { status: "COMPLETED", conclusion: "SUCCESS" },
              { status: "IN_PROGRESS", conclusion: null },
            ],
          }),
        ),
      }),
    );
    await expect(new RepoService({ run }).readGithub(MAIN)).resolves.toEqual({
      state: "ok",
      value: {
        fullName: "owner/app",
        url: GITHUB_WEB_URL,
        defaultBranch: "main",
        openIssues: 7,
        openPulls: 3,
        ci: { state: "pending", total: 2, failing: 0, pending: 1 },
        private: true,
      },
    });
    expect(calls).toContain(CHECK_RUNS);
  });

  it("survives an API payload that omits everything", async () => {
    const { run } = fakeRunner(
      githubRoutes({
        [REPO_API]: ok("{}"),
        [ISSUE_SEARCH]: ok("{}"),
        [PULL_SEARCH]: ok("{}"),
        // Without a default branch the checks are asked of HEAD.
        [CHECK_RUNS_HEAD]: ok(JSON.stringify({ check_runs: [] })),
      }),
    );
    await expect(new RepoService({ run }).readGithub(MAIN)).resolves.toEqual({
      state: "ok",
      value: {
        fullName: "owner/app",
        url: GITHUB_WEB_URL,
        defaultBranch: "",
        openIssues: 0,
        openPulls: 0,
        ci: { state: "none", total: 0, failing: 0, pending: 0 },
        private: false,
      },
    });
  });
});

describe("GitHub list and detail mapping", () => {
  it("maps issue rows", async () => {
    const { run } = fakeRunner(
      githubRoutes({
        [ISSUE_LIST]: ok(
            JSON.stringify([
              {
                number: 12,
                title: "Rail forgets a project",
                state: "OPEN",
                url: `${GITHUB_WEB_URL}/issues/12`,
                author: { login: "octocat" },
                labels: [{ name: "bug", color: "d73a4a" }, { name: "no-color" }],
                comments: 4,
                updatedAt: "2026-01-02T03:04:05Z",
              },
              {
                number: 13,
                title: "Gone",
                state: "SOMETHING_NEW",
                url: `${GITHUB_WEB_URL}/issues/13`,
                author: null,
                labels: [],
                comments: 0,
                updatedAt: "2026-01-03T00:00:00Z",
              },
            ]),
          ),
      }),
    );
    await expect(new RepoService({ run }).listIssues(MAIN)).resolves.toEqual({
      state: "ok",
      value: [
        {
          number: 12,
          title: "Rail forgets a project",
          state: "open",
          url: `${GITHUB_WEB_URL}/issues/12`,
          author: "octocat",
          labels: [
            { name: "bug", color: "d73a4a" },
            { name: "no-color", color: "" },
          ],
          comments: 4,
          updatedAt: "2026-01-02T03:04:05Z",
        },
        {
          number: 13,
          title: "Gone",
          state: "closed",
          url: `${GITHUB_WEB_URL}/issues/13`,
          author: "",
          labels: [],
          comments: 0,
          updatedAt: "2026-01-03T00:00:00Z",
        },
      ],
    });
  });

  it("maps an issue detail, including assignees", async () => {
    const { run } = fakeRunner(
      githubRoutes({
        [ISSUE_VIEW]: ok(
            JSON.stringify({
              number: 12,
              title: "Rail forgets a project",
              state: "OPEN",
              url: `${GITHUB_WEB_URL}/issues/12`,
              author: { login: "octocat" },
              labels: [{ name: "bug", color: "d73a4a" }],
              comments: 4,
              updatedAt: "2026-01-02T03:04:05Z",
              body: "steps to reproduce",
              createdAt: "2025-12-31T00:00:00Z",
              assignees: [{ login: "maintainer" }, null],
            }),
          ),
      }),
    );
    await expect(new RepoService({ run }).getIssue(MAIN, 12)).resolves.toEqual({
      state: "ok",
      value: {
        number: 12,
        title: "Rail forgets a project",
        state: "open",
        url: `${GITHUB_WEB_URL}/issues/12`,
        author: "octocat",
        labels: [{ name: "bug", color: "d73a4a" }],
        comments: 4,
        updatedAt: "2026-01-02T03:04:05Z",
        body: "steps to reproduce",
        createdAt: "2025-12-31T00:00:00Z",
        assignees: ["maintainer"],
      },
    });
  });

  it("maps pull rows, including the rollup and the review decision", async () => {
    const { run } = fakeRunner(
      githubRoutes({
        [PULL_LIST]: ok(
            JSON.stringify([
              {
                number: 9,
                title: "Add a rail",
                state: "OPEN",
                isDraft: true,
                url: `${GITHUB_WEB_URL}/pull/9`,
                author: { login: "octocat" },
                headRefName: "feat/rail",
                baseRefName: "main",
                reviewDecision: "CHANGES_REQUESTED",
                updatedAt: "2026-02-01T00:00:00Z",
                statusCheckRollup: [
                  { __typename: "CheckRun", status: "COMPLETED", conclusion: "FAILURE" },
                  { __typename: "StatusContext", state: "SUCCESS" },
                ],
              },
              {
                number: 10,
                title: "No decision yet",
                state: "CLOSED",
                isDraft: false,
                url: `${GITHUB_WEB_URL}/pull/10`,
                author: { login: "octocat" },
                headRefName: "chore/cleanup",
                baseRefName: "main",
                reviewDecision: null,
                updatedAt: "2026-02-02T00:00:00Z",
                statusCheckRollup: [],
              },
              {
                number: 11,
                title: "Approved, still waiting",
                state: "MERGED",
                isDraft: false,
                url: `${GITHUB_WEB_URL}/pull/11`,
                author: { login: "octocat" },
                headRefName: "feat/next",
                baseRefName: "main",
                reviewDecision: "APPROVED",
                updatedAt: "2026-02-03T00:00:00Z",
                statusCheckRollup: [{ __typename: "StatusContext", state: "EXPECTED" }],
              },
            ]),
          ),
      }),
    );
    await expect(new RepoService({ run }).listPulls(MAIN)).resolves.toEqual({
      state: "ok",
      value: [
        {
          number: 9,
          title: "Add a rail",
          state: "open",
          draft: true,
          url: `${GITHUB_WEB_URL}/pull/9`,
          author: "octocat",
          headRefName: "feat/rail",
          baseRefName: "main",
          review: "changes-requested",
          ci: { state: "failing", total: 2, failing: 1, pending: 0 },
          updatedAt: "2026-02-01T00:00:00Z",
        },
        {
          number: 10,
          title: "No decision yet",
          state: "closed",
          draft: false,
          url: `${GITHUB_WEB_URL}/pull/10`,
          author: "octocat",
          headRefName: "chore/cleanup",
          baseRefName: "main",
          review: "none",
          ci: { state: "none", total: 0, failing: 0, pending: 0 },
          updatedAt: "2026-02-02T00:00:00Z",
        },
        {
          number: 11,
          title: "Approved, still waiting",
          state: "merged",
          draft: false,
          url: `${GITHUB_WEB_URL}/pull/11`,
          author: "octocat",
          headRefName: "feat/next",
          baseRefName: "main",
          review: "approved",
          ci: { state: "pending", total: 1, failing: 0, pending: 1 },
          updatedAt: "2026-02-03T00:00:00Z",
        },
      ],
    });
  });

  it("maps a pull detail, narrowing mergeable and mapping reviews", async () => {
    const { run } = fakeRunner(
      githubRoutes({
        [PULL_VIEW]: ok(
            JSON.stringify({
              number: 9,
              title: "Add a rail",
              state: "OPEN",
              isDraft: false,
              url: `${GITHUB_WEB_URL}/pull/9`,
              author: { login: "octocat" },
              headRefName: "feat/rail",
              baseRefName: "main",
              reviewDecision: "APPROVED",
              updatedAt: "2026-02-01T00:00:00Z",
              createdAt: "2026-01-30T00:00:00Z",
              body: "why this rail",
              mergeable: "CONFLICTING",
              additions: 120,
              deletions: 8,
              changedFiles: 5,
              statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }],
              reviews: [
                { author: { login: "reviewer" }, state: "APPROVED", submittedAt: "2026-02-02T00:00:00Z" },
                { author: { login: "commenter" }, state: "COMMENTED" },
                { author: { login: "stranger" }, state: "SOMETHING_NEW" },
              ],
            }),
          ),
      }),
    );
    const result = await new RepoService({ run }).getPull(MAIN, 9);
    expect(result).toEqual({
      state: "ok",
      value: {
        number: 9,
        title: "Add a rail",
        state: "open",
        draft: false,
        url: `${GITHUB_WEB_URL}/pull/9`,
        author: "octocat",
        headRefName: "feat/rail",
        baseRefName: "main",
        review: "approved",
        ci: { state: "passing", total: 1, failing: 0, pending: 0 },
        updatedAt: "2026-02-01T00:00:00Z",
        body: "why this rail",
        createdAt: "2026-01-30T00:00:00Z",
        mergeable: "conflicting",
        additions: 120,
        deletions: 8,
        changedFiles: 5,
        reviews: [
          { author: "reviewer", state: "approved", submittedAt: "2026-02-02T00:00:00Z" },
          { author: "commenter", state: "commented" },
          { author: "stranger", state: "pending" },
        ],
      },
    });
    if (result.state !== "ok") throw new Error("expected a detail");
    // A review that was never submitted carries no timestamp at all.
    expect(result.value.reviews[1]).not.toHaveProperty("submittedAt");
    expect(result.value.reviews[2]).not.toHaveProperty("submittedAt");
  });

  it("accepts the lowercase mergeable GitHub also sends", async () => {
    const { run } = fakeRunner(
      githubRoutes({
        [PULL_VIEW]: ok(JSON.stringify({ number: 9, title: "Add a rail", state: "OPEN", mergeable: "mergeable" })),
      }),
    );
    await expect(new RepoService({ run }).getPull(MAIN, 9)).resolves.toMatchObject({
      state: "ok",
      value: { mergeable: "mergeable", reviews: [] },
    });
  });
});

describe("githubUrlFor", () => {
  it("answers the browsable URL for a GitHub remote", async () => {
    const { run } = fakeRunner(githubRoutes());
    await expect(new RepoService({ run }).githubUrlFor(MAIN)).resolves.toBe(GITHUB_WEB_URL);
  });

  it("answers nothing when there is no GitHub remote", async () => {
    const noRemote = fakeRunner({ [MAIN_REMOTE]: ok("") });
    await expect(new RepoService({ run: noRemote.run }).githubUrlFor(MAIN)).resolves.toBeUndefined();

    const notGithub = fakeRunner({
      [MAIN_REMOTE]: ok("origin\n"),
      [MAIN_ORIGIN_URL]: ok("git@gitlab.com:owner/app.git\n"),
    });
    await expect(new RepoService({ run: notGithub.run }).githubUrlFor(MAIN)).resolves.toBeUndefined();

    const outsideGit = fakeRunner({ [NOTES_REMOTE]: failed("fatal: not a git repository") });
    await expect(new RepoService({ run: outsideGit.run }).githubUrlFor(NOTES)).resolves.toBeUndefined();
  });
});

describe("check summaries", () => {
  it("counts failing, pending and passing check runs", () => {
    expect(summarizeCheckRuns([])).toEqual({ state: "none", total: 0, failing: 0, pending: 0 });
    expect(
      summarizeCheckRuns([
        { status: "COMPLETED", conclusion: "SUCCESS" },
        { status: "COMPLETED", conclusion: "NEUTRAL" },
        { status: "COMPLETED", conclusion: "TIMED_OUT" },
        { status: "IN_PROGRESS", conclusion: null },
        { status: "QUEUED", conclusion: null },
        // A status this build has never seen is still running, not passing.
        { status: "WAITING_FOR_SOMETHING_NEW", conclusion: null },
      ]),
    ).toEqual({ state: "failing", total: 6, failing: 1, pending: 3 });
  });

  it("sums a status check rollup of check runs and status contexts", () => {
    expect(
      summarizeRollup([
        { __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" },
        { __typename: "StatusContext", state: "PENDING" },
        { __typename: "StatusContext", state: "ERROR" },
      ]),
    ).toEqual({ state: "failing", total: 3, failing: 1, pending: 1 });
    expect(summarizeRollup([{ __typename: "StatusContext", state: "SUCCESS" }])).toEqual({
      state: "passing",
      total: 1,
      failing: 0,
      pending: 0,
    });
  });
});

describe("classifyGithubFailure", () => {
  it("names the missing CLI through both the code and the text", () => {
    expect(classifyGithubFailure(missing("gh"))).toEqual({
      state: "no-cli",
      detail: "GitHub CLI(gh)를 찾을 수 없습니다.",
    });
    expect(classifyGithubFailure(new Error("zsh: command not found: gh"))).toEqual({
      state: "no-cli",
      detail: "GitHub CLI(gh)를 찾을 수 없습니다.",
    });
  });

  it("tells a signed-out CLI from an unreachable network", () => {
    expect(classifyGithubFailure(new Error("gh: To use GitHub CLI, run: gh auth login")).state).toBe("unauthenticated");
    expect(classifyGithubFailure(new Error("dial tcp: lookup api.github.com: no such host")).state).toBe("unreachable");
    expect(classifyGithubFailure(new Error('Get "https://api.github.com": HTTP 502')).state).toBe("unreachable");
    expect(classifyGithubFailure(new Error("API rate limit exceeded for 203.0.113.7")).state).toBe("unreachable");
    expect(classifyGithubFailure(new Error("gh: something exploded")).state).toBe("error");
    expect(classifyGithubFailure(undefined).state).toBe("error");
  });

  it("keeps a credential out of the detail", () => {
    const classified = classifyGithubFailure(
      new Error(`401 Unauthorized: token ${FAKE_TOKEN} was rejected`),
    );
    expect(classified.state).toBe("unauthenticated");
    expect(classified.detail).toContain("[redacted]");
    expect(classified.detail).not.toContain("ghp_");
  });
});

describe("redactDetail", () => {
  it("replaces token-shaped strings", () => {
    expect(redactDetail(`token ${FAKE_TOKEN} leaked`)).toBe("token [redacted] leaked");
    expect(redactDetail(FAKE_PAT)).toBe("[redacted]");
    expect(
      redactDetail(
        "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
      ),
    ).toBe("Bearer [redacted]");
  });

  it("keeps the whole detail at 200 characters or less", () => {
    const detail = redactDetail(`fatal:\n\n  not   a repository ${"x".repeat(400)}  `);
    expect(detail.startsWith("fatal: not a repository")).toBe(true);
    expect(detail.endsWith("…")).toBe(true);
    expect(detail.length).toBeLessThanOrEqual(200);
    expect(redactDetail("short").length).toBe(5);
  });
});

describe("the shipped runner", () => {
  it("keeps ENOENT so a missing gh is not read as an API failure", async () => {
    // A binary name that cannot exist: the spawn fails without asking the
    // machine anything, and the rejection is what classification sees.
    const runner = defaultCommandRunner("gajae-missing-gh-binary");
    const error = await runner("gajae-missing-gh-binary", ["api", "repos/owner/app"]).then(
      () => new Error("the missing binary was spawned"),
      (reason: unknown) => reason,
    );
    expect(error).toMatchObject({ code: "ENOENT" });
    expect(classifyGithubFailure(error)).toEqual({
      state: "no-cli",
      detail: "GitHub CLI(gh)를 찾을 수 없습니다.",
    });
  });
});
