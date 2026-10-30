import { createElement } from "react";
import type { FunctionComponent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type {
  GithubFailureState,
  GithubIssueDetail,
  GithubIssueSummary,
  GithubPullDetail,
  GithubPullSummary,
  GithubQuery,
  GithubRepositoryStatus,
  RepoCiSummary,
  RepoDesktopBridge,
  RepositorySnapshot,
  RepoWorktree,
} from "../../shared/repo-ipc";
import type { AgentBackend } from "../backend/agent-backend";
import type { AgentSession } from "../backend/types";
import {
  RepoBranchesPanel,
  RepoIssuesPanel,
  RepoOverviewPanel,
  RepoPullsPanel,
  RepoView,
  changesForProject,
  ciLabel,
  detailForSelection,
  formatRepoCount,
  githubFailureText,
  issueStateLabel,
  pullStateLabel,
  repoTabLabel,
  reviewLabel,
} from "./repo-view";
import type {
  RepoBranchesPanelProps,
  RepoIssuesPanelProps,
  RepoLoad,
  RepoOverviewPanelProps,
  RepoPullsPanelProps,
  RepoViewProps,
  RepoViewTab,
} from "./repo-view";

/**
 * The repository screen renders from props, which is what lets these tests cover the
 * states that matter -- no desktop bridge, each of the six GitHub failures, an empty
 * list, a populated one, a worktree whose status could not be read -- without an
 * Electron bridge, a DOM, or a request.
 *
 * `renderToStaticMarkup` runs no effects, so the one test that needs a bridge explains
 * the render contract it can observe instead of pretending to watch a call.
 */

const noop = (): void => undefined;

function render<P extends object>(
  component: FunctionComponent<P>,
  props: P,
): string {
  return renderToStaticMarkup(
    createElement(component, props as P & { key?: null }),
  );
}

function session(
  index: number,
  overrides: Partial<AgentSession> = {},
): AgentSession {
  return {
    id: `session-${index}`,
    title: `Session ${index}`,
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

function worktree(overrides: Partial<RepoWorktree> = {}): RepoWorktree {
  return {
    path: "/tmp/project",
    head: "0f1e2d3",
    main: true,
    locked: false,
    prunable: false,
    ...overrides,
  };
}

function snapshot(
  overrides: Partial<RepositorySnapshot> = {},
): RepositorySnapshot {
  return {
    root: "/tmp/project",
    name: "project",
    repository: true,
    branch: "main",
    remote: {
      name: "origin",
      url: "git@github.com:Heyaaz/gajae-bot.git",
      slug: "Heyaaz/gajae-bot",
      webUrl: "https://github.com/Heyaaz/gajae-bot",
    },
    branches: [],
    worktrees: [worktree()],
    refreshedAt: "now",
    ...overrides,
  };
}

function ci(overrides: Partial<RepoCiSummary> = {}): RepoCiSummary {
  return { state: "passing", total: 2, failing: 0, pending: 0, failedRuns: [], ...overrides };
}

function githubStatus(): GithubRepositoryStatus {
  return {
    fullName: "Heyaaz/gajae-bot",
    url: "https://github.com/Heyaaz/gajae-bot",
    defaultBranch: "main",
    openIssues: 1_234,
    openPulls: 2,
    ci: ci(),
    private: false,
  };
}

function issue(overrides: Partial<GithubIssueSummary> = {}): GithubIssueSummary {
  return {
    number: 12,
    title: "저장소 화면",
    state: "open",
    url: "https://github.com/Heyaaz/gajae-bot/issues/12",
    author: "octocat",
    labels: [{ name: "enhancement", color: "a2eeef" }],
    comments: 2,
    updatedAt: "2h",
    ...overrides,
  };
}

function issueDetail(
  overrides: Partial<GithubIssueDetail> = {},
): GithubIssueDetail {
  return {
    ...issue(),
    body: "본문입니다.",
    createdAt: "2026-10-15T01:00:00.000Z",
    assignees: ["octocat"],
    ...overrides,
  };
}

function pull(overrides: Partial<GithubPullSummary> = {}): GithubPullSummary {
  return {
    number: 34,
    title: "프로젝트 화면 분리",
    state: "open",
    draft: false,
    url: "https://github.com/Heyaaz/gajae-bot/pull/34",
    author: "octocat",
    headRefName: "feat/issue-3-project-repo-view",
    baseRefName: "main",
    review: "changes-requested",
    ci: ci({ state: "failing", failing: 1 }),
    updatedAt: "5m",
    ...overrides,
  };
}

function pullDetail(overrides: Partial<GithubPullDetail> = {}): GithubPullDetail {
  return {
    ...pull(),
    crossRepository: false,
    body: "PR 본문입니다.",
    createdAt: "2026-10-15T01:00:00.000Z",
    mergeable: "mergeable",
    additions: 4,
    deletions: 2,
    changedFiles: 1,
    reviews: [],
    ...overrides,
  };
}

function loaded<T>(value: T): RepoLoad<T> {
  return { status: "ready", value };
}

function overviewProps(
  overrides: Partial<RepoOverviewPanelProps> = {},
): RepoOverviewPanelProps {
  return {
    repository: snapshot(),
    github: { state: "ok", value: githubStatus() },
    sessions: [],
    onOpenSession: noop,
    onOpenDiff: noop,
    ...overrides,
  };
}

function branchesProps(
  overrides: Partial<RepoBranchesPanelProps> = {},
): RepoBranchesPanelProps {
  return {
    repository: snapshot(),
    sessions: [],
    onOpenSession: noop,
    onOpenDiff: noop,
    ...overrides,
  };
}

function issuesProps(
  overrides: Partial<RepoIssuesPanelProps> = {},
): RepoIssuesPanelProps {
  return {
    query: { state: "ok", value: [issue()] },
    detail: null,
    onSelect: noop,
    onBack: noop,
    onOpenUrl: noop,
    ...overrides,
  };
}

function pullsProps(
  overrides: Partial<RepoPullsPanelProps> = {},
): RepoPullsPanelProps {
  return {
    query: { state: "ok", value: [pull()] },
    detail: null,
    onSelect: noop,
    onBack: noop,
    onOpenUrl: noop,
    ...overrides,
  };
}

function repoViewProps(bridge: RepoDesktopBridge | null): RepoViewProps {
  return {
    project: { root: "/tmp/project", name: "project" },
    sessions: [session(0)],
    // With no bridge nothing below the header can run, so the backend is never
    // reached and an empty stand-in is the honest one for this render.
    backend: {} as unknown as AgentBackend,
    bridge,
    onOpenSession: noop,
    onClose: noop,
    onError: noop,
  };
}

/** The text of the first failure paragraph, or an empty string. */
function errorText(markup: string): string {
  return markup.match(/<p class="repo-error">([^<]*)<\/p>/u)?.[1] ?? "";
}

describe("RepoView without a desktop bridge", () => {
  it("draws the desktop-only notice and nothing that could ask for a read", () => {
    const markup = render(RepoView, repoViewProps(null));
    expect(markup).toContain("저장소 화면은 데스크톱 앱에서만 사용할 수 있습니다");
    expect(markup).toContain("project");
    expect(markup).toContain("/tmp/project");
    // The tabs are the only control that starts a load, and the folder button is the
    // other bridge call the header makes. Neither is drawn, so the request guard in
    // the effects is the second half of a contract this render already keeps.
    expect(markup).not.toContain("repo-tab");
    expect(markup).not.toContain("로컬 폴더 열기");
    expect(markup).not.toContain("불러오는 중");
    expect(markup).not.toContain("repo-error");
  });
});

describe("repository change selection ownership", () => {
  it("does not expose a previous project's selected session after switching roots", () => {
    const priorSelection = {
      projectRoot: "/repo-a",
      requestId: 1,
      session: session(0, { workspace: "/repo-a" }),
      diff: null,
      loading: true,
      error: "",
    };

    expect(changesForProject(priorSelection, "/repo-b")).toBeNull();
    expect(changesForProject(priorSelection, "/repo-a")).toBe(priorSelection);
  });
});

describe("RepoOverviewPanel GitHub states", () => {
  const FAILURES: readonly GithubFailureState[] = [
    "no-remote",
    "not-github",
    "no-cli",
    "unauthenticated",
    "unreachable",
    "error",
  ];

  function githubQuery(
    failure: GithubFailureState,
  ): GithubQuery<GithubRepositoryStatus> {
    switch (failure) {
      case "no-remote":
        return { state: "no-remote" };
      case "not-github":
        return { state: "not-github", remote: "origin" };
      default:
        return { state: failure, detail: "gh: failed" };
    }
  }

  it("says which of the six failures it is, in its own words", () => {
    const rendered = FAILURES.map((failure) =>
      errorText(
        render(RepoOverviewPanel, overviewProps({ github: githubQuery(failure) })),
      ),
    );
    // Six causes, six fixes: one shared sentence would leave the user unable to tell
    // "install gh" from "log in". The redacted reason a query reported follows in
    // the same paragraph, so the sentence is the start of it rather than all of it.
    expect(new Set(rendered).size).toBe(FAILURES.length);
    rendered.forEach((text, index) => {
      expect(text.startsWith(githubFailureText(FAILURES[index]))).toBe(true);
      expect(text).toMatch(/[가-힣]/u);
    });
    expect(rendered[5]).toBe(`${githubFailureText("error")} (gh: failed)`);
  });

  it("carries the reported reason, and invents none when there is none", () => {
    const withDetail = errorText(
      render(
        RepoIssuesPanel,
        issuesProps({ query: { state: "error", detail: "gh: Not Found (HTTP 404)" } }),
      ),
    );
    // A 404 for a repository this account cannot see reads the same as a refusal
    // that is worth retrying until the reason is on screen.
    expect(withDetail).toContain("gh: Not Found (HTTP 404)");
    const without = errorText(
      render(RepoPullsPanel, pullsProps({ query: { state: "no-remote" } })),
    );
    expect(without).toBe(githubFailureText("no-remote"));
  });

  it("reports a failed local read instead of drawing it as a project without Git", () => {
    const markup = render(
      RepoOverviewPanel,
      overviewProps({
        repository: snapshot({
          repository: false,
          branch: "",
          remote: undefined,
          worktrees: [],
          error: "저장소를 읽지 못했습니다: dubious ownership",
        }),
      }),
    );
    expect(markup).toContain("dubious ownership");
    expect(markup).not.toContain("Git 저장소가 아닙니다");
    // Nothing was read, so there are no counts to state either.
    expect(markup).not.toContain("워크트리 0");
  });

  it("keeps the not-a-repository sentence for a project outside Git", () => {
    const markup = render(
      RepoOverviewPanel,
      overviewProps({
        repository: snapshot({
          repository: false,
          branch: "",
          remote: undefined,
          worktrees: [],
        }),
      }),
    );
    expect(markup).toContain("Git 저장소가 아닙니다");
    expect(markup).not.toContain("repo-error");
  });

  it("reports a failure instead of inventing counts", () => {
    const markup = render(
      RepoOverviewPanel,
      overviewProps({ github: { state: "no-remote" } }),
    );
    expect(markup).toContain("repo-error");
    expect(markup).not.toContain("열린 이슈");
    expect(markup).not.toContain("열린 PR");
  });

  it("counts issues, pull requests and the default branch CI when it answered", () => {
    const markup = render(RepoOverviewPanel, overviewProps());
    expect(markup).toContain("열린 이슈 1.2천");
    expect(markup).toContain("열린 PR 2");
    expect(markup).toContain(ciLabel(ci()));
    expect(markup).toContain("Heyaaz/gajae-bot");
  });
});

describe("RepoIssuesPanel lists", () => {
  it("shows the empty sentence for an empty list, not a failure", () => {
    const markup = render(
      RepoIssuesPanel,
      issuesProps({ query: { state: "ok", value: [] } }),
    );
    expect(markup).toContain("열린 이슈가 없습니다");
    expect(markup).not.toContain("repo-error");
    expect(markup).not.toContain("repo-row__number");
  });

  it("renders the number, title, labels and author of each issue", () => {
    const markup = render(RepoIssuesPanel, issuesProps());
    expect(markup).toContain("#12");
    expect(markup).toContain("저장소 화면");
    expect(markup).toContain("enhancement");
    expect(markup).toContain("octocat");
    expect(markup).toContain("2h");
    expect(markup).toContain(issueStateLabel("open"));
  });

  it("shows GitHub's ISO time as an age, with the exact time on hover", () => {
    const updatedAt = new Date(Date.now() - 3 * 3_600_000 - 60_000).toISOString();
    const markup = render(
      RepoIssuesPanel,
      issuesProps({ query: { state: "ok", value: [issue({ updatedAt })] } }),
    );
    expect(markup).toContain(">3h<");
    expect(markup).not.toContain(updatedAt);
    expect(markup).toMatch(/<small title="[^"]*\d[^"]*">3h<\/small>/);
  });
});

describe("RepoPullsPanel rows", () => {
  it("carries the review badge and the CI badge", () => {
    const markup = render(RepoPullsPanel, pullsProps());
    expect(markup).toContain("repo-badge--review-changes-requested");
    expect(markup).toContain(reviewLabel("changes-requested"));
    expect(markup).toContain("repo-badge--failing");
    expect(markup).toContain(ciLabel(pull().ci));
  });

  it("dresses every CI state with its own badge class", () => {
    for (const state of ["passing", "failing", "pending", "none"] as const) {
      const markup = render(
        RepoPullsPanel,
        pullsProps({ query: { state: "ok", value: [pull({ ci: ci({ state }) })] } }),
      );
      expect(markup).toContain(`repo-badge--${state}`);
    }
  });

  it("maps every union member to a distinct label", () => {
    const ciStates = ["passing", "failing", "pending", "none"] as const;
    const ciLabels = ciStates.map((state) => ciLabel(ci({ state })));
    expect(new Set(ciLabels).size).toBe(ciStates.length);
    for (const label of ciLabels) expect(label.length).toBeGreaterThan(0);

    const reviews = [
      "approved",
      "changes-requested",
      "review-required",
      "none",
    ] as const;
    const reviewLabels = reviews.map(reviewLabel);
    expect(new Set(reviewLabels).size).toBe(reviews.length);
    for (const label of reviewLabels) expect(label.length).toBeGreaterThan(0);
  });
});

describe("Worktree rows", () => {
  it("counts the changed entries, and says so when the tree could not be read", () => {
    const markup = render(
      RepoOverviewPanel,
      overviewProps({
        repository: snapshot({
          worktrees: [
            worktree({ changed: 3 }),
            worktree({
              path: "/tmp/project-wt",
              main: false,
              branch: undefined,
              changed: undefined,
            }),
          ],
        }),
      }),
    );
    expect(markup).toContain("변경 3");
    // Undefined means `git status` could not be read here, which is not a clean tree.
    expect(markup).toContain("읽을 수 없음");
    expect(markup).toContain("detached");
  });

  it("lists the sessions of a path as chips and offers the diff of the first", () => {
    const markup = render(
      RepoOverviewPanel,
      overviewProps({
        sessions: [
          session(0, { workspace: "/tmp/project" }),
          session(1, { workspace: "/tmp/elsewhere" }),
        ],
        repository: snapshot({
          worktrees: [
            worktree({ path: "/tmp/project", changed: 0 }),
            worktree({ path: "/tmp/project-wt", main: false, changed: 0 }),
          ],
        }),
      }),
    );
    expect(markup).toContain("repo-chip");
    expect(markup).toContain("Session 0");
    // A session of another workspace belongs to that worktree's row, not this one.
    expect(markup).not.toContain("Session 1");
    // One worktree has a session, so exactly one row can open changed files.
    expect(markup.split("변경 파일").length - 1).toBe(1);
  });
});

describe("RepoBranchesPanel", () => {
  it("shows the branch list and marks the branch a worktree holds", () => {
    const markup = render(
      RepoBranchesPanel,
      branchesProps({
        repository: snapshot({
          branches: [
            { name: "main", worktreePath: "/tmp/project" },
            { name: "feat/issue-3" },
          ],
        }),
      }),
    );
    expect(markup).toContain("repo-branch__path");
    expect(markup).toContain("/tmp/project");
    expect(markup).toContain("체크아웃됨");
    expect(markup).toContain("feat/issue-3");
    expect(markup.split("체크아웃됨").length - 1).toBe(1);
  });

  it("names a failed read instead of showing its empty lists as the truth", () => {
    const markup = render(
      RepoBranchesPanel,
      branchesProps({
        repository: snapshot({
          branches: [],
          error: "저장소 정보를 일부만 읽었습니다: 브랜치 목록: bad object HEAD",
        }),
      }),
    );
    expect(markup).toContain("bad object HEAD");
    // An empty list beside a failed read states a fact the read did not establish.
    expect(markup).not.toContain("브랜치가 없습니다");
  });

  it("draws one notice when the snapshot read nothing at all", () => {
    const outsideGit = render(
      RepoBranchesPanel,
      branchesProps({
        repository: snapshot({
          repository: false,
          branch: "",
          remote: undefined,
          worktrees: [],
        }),
      }),
    );
    expect(outsideGit).toContain("Git 저장소가 아닙니다");
    expect(outsideGit).not.toContain("워크트리가 없습니다");
    expect(outsideGit).not.toContain("브랜치가 없습니다");

    const failedRead = render(
      RepoBranchesPanel,
      branchesProps({
        repository: snapshot({
          repository: false,
          branch: "",
          remote: undefined,
          worktrees: [],
          error: "저장소를 읽지 못했습니다: permission denied",
        }),
      }),
    );
    expect(failedRead).toContain("permission denied");
    expect(failedRead).not.toContain("Git 저장소가 아닙니다");
  });
});

describe("Issue detail", () => {
  it("shows the body with a way back to the list", () => {
    const markup = render(
      RepoIssuesPanel,
      issuesProps({
        detail: loaded<GithubQuery<GithubIssueDetail>>({
          state: "ok",
          value: issueDetail(),
        }),
      }),
    );
    expect(markup).toContain("목록으로");
    expect(markup).toContain("repo-detail__body");
    expect(markup).toContain("본문입니다.");
    expect(markup).toContain("#12");
    // The list stays loaded behind the detail, but it is not what the user sees.
    expect(markup).not.toContain("repo-row__number");
  });
});

describe("repository detail selection", () => {
  it("returns to the issue list when the selection is cleared", () => {
    const detail = loaded<GithubQuery<GithubIssueDetail>>({
      state: "ok",
      value: issueDetail(),
    });

    expect(detailForSelection(12, detail)).toBe(detail);
    expect(detailForSelection(null, detail)).toBeNull();
    const markup = render(
      RepoIssuesPanel,
      issuesProps({ detail: detailForSelection(null, detail) }),
    );
    expect(markup).toContain("repo-row__number");
    expect(markup).not.toContain("repo-detail__body");
  });

  it("returns to the pull request list when the selection is cleared", () => {
    const detail = loaded<GithubQuery<GithubPullDetail>>({
      state: "ok",
      value: pullDetail(),
    });

    expect(detailForSelection(34, detail)).toBe(detail);
    expect(detailForSelection(null, detail)).toBeNull();
    const markup = render(
      RepoPullsPanel,
      pullsProps({ detail: detailForSelection(null, detail) }),
    );
    expect(markup).toContain("repo-row__number");
    expect(markup).not.toContain("repo-detail__body");
  });
});

describe("Pure labels", () => {
  it("names every tab exactly once", () => {
    const tabs: readonly RepoViewTab[] = [
      "overview",
      "issues",
      "pulls",
      "branches",
    ];
    expect(tabs.map(repoTabLabel)).toEqual([
      "개요",
      "이슈",
      "PR",
      "브랜치·워크트리",
    ]);
    expect(new Set(tabs.map(repoTabLabel)).size).toBe(tabs.length);
  });

  it("labels both issue states and all three pull states", () => {
    expect(issueStateLabel("open")).toBe("열림");
    expect(issueStateLabel("closed")).toBe("닫힘");
    expect(pullStateLabel("open")).toBe("열림");
    expect(pullStateLabel("closed")).toBe("닫힘");
    expect(pullStateLabel("merged")).toBe("병합됨");
  });

  it("shortens a count that would not fit and refuses to invent one", () => {
    expect(formatRepoCount(0)).toBe("0");
    expect(formatRepoCount(7)).toBe("7");
    expect(formatRepoCount(999)).toBe("999");
    expect(formatRepoCount(1_000)).toBe("1천");
    expect(formatRepoCount(1_234)).toBe("1.2천");
    expect(formatRepoCount(12_345)).toBe("1.2만");
    expect(formatRepoCount(120_000)).toBe("12만");
    // A count that is missing or impossible is not rendered as a number.
    expect(formatRepoCount(Number.NaN)).toBe("0");
    expect(formatRepoCount(Number.POSITIVE_INFINITY)).toBe("0");
    expect(formatRepoCount(-4)).toBe("0");
  });
});
