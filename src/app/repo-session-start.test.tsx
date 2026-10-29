/**
 * @vitest-environment happy-dom
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  GithubFailedLog,
  GithubIssueDetail,
  GithubPullDetail,
  GithubQuery,
  RepoDesktopBridge,
  RepositorySnapshot,
} from "../../shared/repo-ipc";
import type { NewSessionPrefill } from "../../shared/settings-ipc";
import type { AgentBackend } from "../backend/agent-backend";
import type { AgentSession } from "../backend/types";
import {
  branchPlacement,
  ciSessionPrefill,
  issueBranchName,
  issueSessionPrefill,
} from "./repo-session-start";
import { RepoView } from "./repo-view";

vi.mock("./inspector", () => ({ DiffPanel: () => null }));

const ROOT = "/projects/gajae-bot";
const LINKED = "/projects/gajae-bot.gajae-worktrees/abc";

function snapshot(worktrees: RepositorySnapshot["worktrees"] = []): RepositorySnapshot {
  return {
    root: ROOT,
    name: "gajae-bot",
    repository: true,
    branch: "main",
    remote: {
      name: "origin",
      url: "https://github.com/Heyaaz/gajae-bot.git",
      slug: "github.com/Heyaaz/gajae-bot",
      webUrl: "https://github.com/Heyaaz/gajae-bot",
    },
    branches: [],
    worktrees: [
      { path: ROOT, branch: "main", head: "1", main: true, locked: false, prunable: false },
      ...worktrees,
    ],
    refreshedAt: "now",
  };
}

const ISSUE: GithubIssueDetail = {
  number: 166,
  title: "[로드맵 T1] Repo 화면에서 작업 시작: 이슈·CI 실패 → worktree 세션",
  state: "open",
  url: "https://github.com/Heyaaz/gajae-bot/issues/166",
  author: "Heyaaz",
  labels: [{ name: "enhancement", color: "a2eeef" }],
  comments: 0,
  updatedAt: "now",
  body: "## 완료 기준\n- [ ] 이슈에서 시작하면 컴포저에 이슈 내용이 채워짐",
  createdAt: "now",
  assignees: [],
};

const PULL: GithubPullDetail = {
  number: 9,
  title: "Add a rail",
  state: "open",
  draft: false,
  url: "https://github.com/Heyaaz/gajae-bot/pull/9",
  author: "Heyaaz",
  headRefName: "feat/rail",
  baseRefName: "main",
  review: "none",
  ci: { state: "failing", total: 2, failing: 1, pending: 0, failedRuns: [41] },
  updatedAt: "now",
  body: "",
  createdAt: "now",
  mergeable: "mergeable",
  additions: 1,
  deletions: 0,
  changedFiles: 1,
  crossRepository: false,
  reviews: [],
};

const LOG: GithubFailedLog = {
  runs: [{ id: 41, url: "https://github.com/Heyaaz/gajae-bot/actions/runs/41" }],
  log: "build\ttest\tFAIL expected 1 got 2\n",
  truncated: true,
};

describe("planning a session from GitHub work", () => {
  it("names the issue branch from the number and the title's ASCII words", () => {
    expect(issueBranchName(ISSUE)).toBe("issue-166-t1-repo-ci-worktree");
    expect(issueBranchName({ number: 3, title: "한글 제목" })).toBe("issue-3");
  });

  it("uses a worktree that already has the branch and otherwise asks for a managed one", () => {
    expect(
      branchPlacement(snapshot([{ path: LINKED, branch: "feat/rail", head: "2", main: false, locked: false, prunable: false }]), "feat/rail", { worktreeBranchExisting: true }),
    ).toEqual({ workspace: LINKED, isolation: "workspace" });
    expect(branchPlacement(snapshot(), "feat/rail", { worktreeBranchExisting: true })).toEqual({
      workspace: ROOT,
      isolation: "worktree",
      worktreeBranch: "feat/rail",
      worktreeBranchExisting: true,
    });
    expect(branchPlacement(snapshot(), "issue-3", {})).toEqual({
      workspace: ROOT,
      isolation: "worktree",
      worktreeBranch: "issue-3",
    });
  });

  it("puts the issue's title, body, labels and URL in the first request", () => {
    const prefill = issueSessionPrefill(snapshot(), ISSUE);
    expect(prefill.prompt).toContain(ISSUE.title);
    expect(prefill.prompt).toContain(ISSUE.body);
    expect(prefill.prompt).toContain("enhancement");
    expect(prefill.prompt).toContain(ISSUE.url);
    expect(prefill.workLink).toEqual({ kind: "issue", number: 166, url: ISSUE.url });
  });

  it("attaches the failed log to a CI fix and says when its beginning was cut", () => {
    const prefill = ciSessionPrefill(snapshot(), { kind: "branch", branch: "main" }, LOG);
    expect(prefill.prompt).toContain("FAIL expected 1 got 2");
    expect(prefill.prompt).toContain("32KB");
    expect(prefill.prompt).toContain(LOG.runs[0]!.url);
    // The main working tree has the default branch: the fix runs there, not in a copy.
    expect(prefill).toMatchObject({ workspace: ROOT, isolation: "workspace" });
    expect(prefill.workLink).toEqual({ kind: "ci", branch: "main", url: LOG.runs[0]!.url });
  });

  it("runs a fork's CI fix on the pull's own head, never on this repository's branch of the same name", () => {
    // A `contributor:main` pull named the base repository's main, so the session
    // was placed in the user's own main checkout with code that is not the pull's.
    const fork = { ...PULL, headRefName: "main", crossRepository: true };
    const prefill = ciSessionPrefill(snapshot(), { kind: "pull", pull: fork }, LOG);
    expect(prefill).toMatchObject({
      workspace: ROOT,
      isolation: "worktree",
      worktreeBranch: "pr-9",
      worktreePull: { remote: "origin", number: 9 },
    });
    expect(prefill).not.toHaveProperty("worktreeBranchExisting");
    expect(prefill.prompt).toContain("pr-9");
  });

  it("marks a CI fix that would run in the main checkout, which may hold the user's own changes", () => {
    expect(ciSessionPrefill(snapshot(), { kind: "branch", branch: "main" }, LOG)).toMatchObject({
      workspace: ROOT,
      isolation: "workspace",
      mainCheckout: true,
    });
    const linked = snapshot([{ path: LINKED, branch: "feat/rail", head: "2", main: false, locked: false, prunable: false }]);
    expect(ciSessionPrefill(linked, { kind: "pull", pull: PULL }, LOG)).not.toHaveProperty("mainCheckout");
  });

  it("tells the agent which run's log is missing and why", () => {
    const skipped = {
      id: 42,
      url: "https://github.com/Heyaaz/gajae-bot/actions/runs/42",
      skipped: "run 42 is still in progress; logs will be available when it is complete",
    };
    const prefill = ciSessionPrefill(
      snapshot(),
      { kind: "branch", branch: "main" },
      { ...LOG, runs: [...LOG.runs, skipped] },
    );
    expect(prefill.prompt).toContain(`${skipped.url} (${skipped.skipped})`);
    expect(prefill.prompt).toContain("FAIL expected 1 got 2");
  });
});

describe("starting a session from the repository screen", () => {
  let root: Root | undefined;
  let host: HTMLDivElement | undefined;

  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
  });

  function bridge(overrides: Partial<RepoDesktopBridge> = {}): RepoDesktopBridge {
    const ok = <T,>(value: T): Promise<GithubQuery<T>> => Promise.resolve({ state: "ok", value });
    return {
      resolveProjects: async () => [],
      readRepository: async () => snapshot(),
      readGithub: () =>
        ok({
          fullName: "Heyaaz/gajae-bot",
          url: "https://github.com/Heyaaz/gajae-bot",
          defaultBranch: "main",
          openIssues: 1,
          openPulls: 1,
          ci: { state: "passing", total: 1, failing: 0, pending: 0, failedRuns: [] },
          private: false,
        }),
      listIssues: () => ok([ISSUE]),
      getIssue: () => ok(ISSUE),
      listPulls: () => ok([PULL]),
      getPull: () => ok(PULL),
      readFailedLog: () => ok(LOG),
      openExternal: async () => undefined,
      revealFolder: async () => undefined,
      ...overrides,
    };
  }

  async function mount(repo: RepoDesktopBridge, sessions: AgentSession[] = []) {
    const onStartSession = vi.fn<(prefill: NewSessionPrefill) => void>();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () =>
      root!.render(
        createElement(RepoView, {
          project: { root: ROOT, name: "gajae-bot" },
          sessions,
          backend: {} as AgentBackend,
          bridge: repo,
          onOpenSession: () => undefined,
          onStartSession,
          onClose: () => undefined,
          onError: () => undefined,
        }),
      ),
    );
    return onStartSession;
  }

  const button = (label: string) =>
    [...host!.querySelectorAll("button")].find((element) => element.textContent?.includes(label));

  async function click(label: string): Promise<void> {
    await vi.waitFor(() => expect(button(label)).toBeDefined());
    await act(async () => button(label)!.click());
  }

  it("opens the dialog for an issue in the worktree that already has its branch", async () => {
    const branch = issueBranchName(ISSUE);
    const onStartSession = await mount(
      bridge({
        readRepository: async () =>
          snapshot([{ path: LINKED, branch, head: "2", main: false, locked: false, prunable: false }]),
      }),
    );
    await click("이슈");
    await click(ISSUE.title);
    await click("이 이슈로 세션 시작");
    await vi.waitFor(() => expect(onStartSession).toHaveBeenCalledOnce());
    expect(onStartSession.mock.calls[0]![0]).toMatchObject({
      workspace: LINKED,
      isolation: "workspace",
      workLink: { kind: "issue", number: 166 },
    });
    expect(onStartSession.mock.calls[0]![0].prompt).toContain(ISSUE.body);
  });

  it("keeps the CI button disabled with the gh sentence when the log cannot be read", async () => {
    const readFailedLog = vi.fn(async () => ({
      state: "unauthenticated" as const,
      detail: "GitHub 인증이 필요합니다.",
    }));
    const onStartSession = await mount(bridge({ readFailedLog }));
    await click("PR");
    await click(PULL.title);
    await click("CI 실패 고치기");
    await vi.waitFor(() => expect(button("CI 실패 고치기")!.disabled).toBe(true));
    expect(host!.querySelector(".repo-start__reason")?.textContent).toContain(
      "GitHub에 로그인되어 있지 않습니다",
    );
    expect(readFailedLog).toHaveBeenCalledWith(ROOT, [41]);
    expect(onStartSession).not.toHaveBeenCalled();
  });

  it("lets a CI fix be tried again after a log read that can succeed later", async () => {
    const readFailedLog = vi
      .fn<RepoDesktopBridge["readFailedLog"]>()
      .mockResolvedValueOnce({
        state: "error",
        detail: "run 41 is still in progress; logs will be available when it is complete",
      })
      .mockResolvedValue({ state: "ok", value: LOG });
    const onStartSession = await mount(bridge({ readFailedLog }));
    await click("PR");
    await click(PULL.title);
    await click("CI 실패 고치기");
    await vi.waitFor(() =>
      expect(host!.querySelector(".repo-start__reason")?.textContent).toContain("still in progress"),
    );
    expect(button("CI 실패 고치기")!.disabled).toBe(false);
    await click("CI 실패 고치기");
    await vi.waitFor(() => expect(onStartSession).toHaveBeenCalledOnce());
  });

  it("hands a CI fix the failed log and the pull's branch, which must already exist", async () => {
    const onStartSession = await mount(bridge());
    await click("PR");
    await click(PULL.title);
    await click("CI 실패 고치기");
    await vi.waitFor(() => expect(onStartSession).toHaveBeenCalledOnce());
    expect(onStartSession.mock.calls[0]![0]).toMatchObject({
      workspace: ROOT,
      isolation: "worktree",
      worktreeBranch: "feat/rail",
      worktreeBranchExisting: true,
      workLink: { kind: "pull", number: 9, url: PULL.url },
    });
    expect(onStartSession.mock.calls[0]![0].prompt).toContain("FAIL expected 1 got 2");
  });

  it("disables a CI fix up front when no failing check is an Actions run", async () => {
    await mount(bridge({ getPull: async () => ({ state: "ok", value: { ...PULL, ci: { ...PULL.ci, failedRuns: [] } } }) }));
    await click("PR");
    await click(PULL.title);
    await vi.waitFor(() => expect(button("CI 실패 고치기")!.disabled).toBe(true));
    expect(host!.querySelector(".repo-start__reason")?.textContent).toContain("GitHub Actions");
  });

  it("lists the sessions started from GitHub work on the overview and in the issue", async () => {
    const linked = {
      id: "s-166",
      title: "#166 Repo 화면",
      subtitle: "",
      workspace: LINKED,
      runtime: "gjc",
      status: "idle",
      updatedAt: "now",
      pinned: false,
      unread: false,
      accent: "#fff",
      ownership: "gajae",
      attachment: "attached",
      workLink: { kind: "issue", number: 166, url: ISSUE.url },
    } as AgentSession;
    await mount(bridge(), [linked]);
    await vi.waitFor(() => expect(host!.querySelector(".repo-link")?.textContent).toContain("이슈 #166"));
    expect(host!.querySelector(".repo-link")?.textContent).toContain("#166 Repo 화면");
    await click("이슈");
    await click(ISSUE.title);
    await vi.waitFor(() => expect(host!.textContent).toContain("시작한 세션"));
  });
});
