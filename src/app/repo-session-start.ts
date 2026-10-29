import type { SessionWorkLink } from "../../shared/agent-contract";
import {
  REPO_FAILED_LOG_LIMIT,
  type GithubFailedLog,
  type GithubIssueDetail,
  type GithubPullDetail,
  type RepositorySnapshot,
} from "../../shared/repo-ipc";
import type { NewSessionPrefill } from "../../shared/settings-ipc";
import type { AgentSession } from "../backend/types";
import { t } from "../i18n";

const SLUG_LIMIT = 40;
const TITLE_LIMIT = 80;

/** `issue-<n>-<slug>`; a title with no ASCII words leaves `issue-<n>`. */
export function issueBranchName(issue: Pick<GithubIssueDetail, "number" | "title">): string {
  const slug = issue.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .slice(0, SLUG_LIMIT)
    .replace(/^-+|-+$/gu, "");
  return slug ? `issue-${issue.number}-${slug}` : `issue-${issue.number}`;
}

/**
 * Where a session for `branch` runs. A worktree that already has the branch
 * checked out is used as it is; otherwise a managed worktree is made for it, and
 * the controller reuses a local branch of that name instead of creating another.
 * `existing` forbids starting the branch from HEAD when it is nowhere yet.
 */
export function branchPlacement(
  repository: RepositorySnapshot,
  branch: string,
  existing: boolean,
): Pick<NewSessionPrefill, "workspace" | "isolation" | "worktreeBranch" | "worktreeBranchExisting"> {
  const checkedOut = repository.worktrees.find(
    (worktree) => worktree.branch === branch && !worktree.prunable,
  );
  if (checkedOut) return { workspace: checkedOut.path, isolation: "workspace" };
  return {
    workspace: repository.root,
    isolation: "worktree",
    worktreeBranch: branch,
    ...(existing ? { worktreeBranchExisting: true } : {}),
  };
}

function sessionTitle(title: string): string {
  return title.length > TITLE_LIMIT ? `${title.slice(0, TITLE_LIMIT - 1)}…` : title;
}

export function issueSessionPrefill(
  repository: RepositorySnapshot,
  issue: GithubIssueDetail,
): NewSessionPrefill {
  const labels = issue.labels.map((label) => label.name).join(", ");
  const prompt = [
    t("GitHub 이슈 #{number}을(를) 해결해 주세요.", { number: issue.number }),
    "",
    t("제목: {title}", { title: issue.title }),
    `URL: ${issue.url}`,
    ...(labels ? [t("라벨: {labels}", { labels })] : []),
    "",
    issue.body.trim() || t("본문이 없습니다."),
  ].join("\n");
  return {
    ...branchPlacement(repository, issueBranchName(issue), false),
    title: sessionTitle(`#${issue.number} ${issue.title}`),
    prompt,
    workLink: { kind: "issue", number: issue.number, url: issue.url },
  };
}

/** A failing CI: a pull request's head, or the default branch with no pull. */
export type CiTarget =
  | { kind: "pull"; pull: Pick<GithubPullDetail, "number" | "title" | "url" | "headRefName"> }
  | { kind: "branch"; branch: string };

export function ciSessionPrefill(
  repository: RepositorySnapshot,
  target: CiTarget,
  failed: GithubFailedLog,
): NewSessionPrefill {
  const branch = target.kind === "pull" ? target.pull.headRefName : target.branch;
  const fence = "````";
  const prompt = [
    target.kind === "pull"
      ? t("PR #{number} {title}의 CI 실패를 고쳐 주세요.", {
          number: target.pull.number,
          title: target.pull.title,
        })
      : t("{branch} 브랜치의 CI 실패를 고쳐 주세요.", { branch }),
    "",
    t("브랜치: {branch}", { branch }),
    ...(target.kind === "pull" ? [`PR: ${target.pull.url}`] : []),
    ...failed.runs.map((run) => t("실패한 실행: {url}", { url: run.url })),
    "",
    failed.truncated
      ? t("실패한 단계의 로그입니다. {limit}KB 상한을 넘은 앞부분은 생략했습니다.", {
          limit: REPO_FAILED_LOG_LIMIT / 1024,
        })
      : t("실패한 단계의 로그입니다."),
    fence,
    failed.log.trimEnd() || t("로그가 비어 있습니다."),
    fence,
  ].join("\n");
  const workLink: SessionWorkLink =
    target.kind === "pull"
      ? { kind: "pull", number: target.pull.number, url: target.pull.url }
      : { kind: "ci", branch, url: failed.runs[0]?.url ?? repository.remote?.webUrl ?? "" };
  return {
    ...branchPlacement(repository, branch, true),
    title: sessionTitle(t("CI 수정: {branch}", { branch })),
    prompt,
    workLink,
  };
}

export function workLinkLabel(link: SessionWorkLink): string {
  switch (link.kind) {
    case "issue":
      return t("이슈 #{number}", { number: link.number });
    case "pull":
      return t("PR #{number}", { number: link.number });
    case "ci":
      return t("CI {branch}", { branch: link.branch });
  }
}

/** Sessions started from the same issue or pull, so a second start can be skipped. */
export function sessionsLinkedTo(
  sessions: readonly AgentSession[],
  kind: "issue" | "pull",
  number: number,
): AgentSession[] {
  return sessions.filter(
    (session) => session.workLink?.kind === kind && session.workLink.number === number,
  );
}
