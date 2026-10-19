import type { DiffSnapshot } from "../../shared/agent-contract";
import type {
  GithubFailure,
  GithubFailureState,
  GithubIssueDetail,
  GithubIssueSummary,
  GithubPullDetail,
  GithubPullSummary,
  GithubQuery,
  GithubRepositoryStatus,
  GithubReview,
  GithubReviewState,
  RepoCiSummary,
  RepoDesktopBridge,
  RepositorySnapshot,
  RepoWorktree,
} from "../../shared/repo-ipc";
import type { AgentBackend } from "../backend/agent-backend";
import type { AgentSession } from "../backend/types";
import { ArrowLeft, ExternalLink, FolderOpen, GitCompare } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { humanErrorMessage, sessionTitleText } from "./format";
import { DiffPanel } from "./inspector";
import { sessionsInPath } from "./project-model";
import { t } from "../i18n";


/**
 * The project-scoped repository screen.
 *
 * One project, three questions: what is on disk (branch, worktrees, changed file
 * counts), what is on GitHub (issues, pull requests, CI), and which session is
 * working in which worktree. Nothing on this screen writes: staging, committing and
 * pushing stay on the session-scoped `DiffPanel`, which owns the managed-worktree
 * rules and asks before it touches a branch.
 *
 * The state-bearing shell is `RepoView`; the panels below it render straight from
 * their props, so every state a user can hit -- rejected IPC, the six GitHub
 * failures, loading, empty, populated -- can be rendered without an Electron bridge.
 */

export type RepoViewTab = "overview" | "issues" | "pulls" | "branches";

/** Local state first, then the two remote lists, then everything that exists locally. */
const REPO_TABS: readonly RepoViewTab[] = [
  "overview",
  "issues",
  "pulls",
  "branches",
];

export function repoTabLabel(tab: RepoViewTab): string {
  switch (tab) {
    case "overview":
      return t("개요");
    case "issues":
      return t("이슈");
    case "pulls":
      return t("PR");
    case "branches":
      return t("브랜치·워크트리");
  }
}

/**
 * One bridge read, as the body renders it.
 *
 * `failed` carries text rather than an error: a rejected promise is an IPC failure,
 * which is a different thing from the `GithubQuery` failure state a query answered
 * with, and `humanErrorMessage` is what keeps a credential that reached the message
 * off the screen.
 */
export type RepoLoad<T> =
  | { status: "loading" }
  | { status: "ready"; value: T }
  | { status: "failed"; error: string };

/**
 * Why GitHub could not answer, in words the user can act on.
 *
 * The six causes are six different fixes -- add a remote, move to GitHub, install
 * `gh`, log in, get back online, retry -- so they never share a sentence.
 */
export function githubFailureText(failure: GithubFailureState): string {
  switch (failure) {
    case "no-remote":
      return t("원격 저장소가 없습니다. 이 프로젝트는 로컬에만 있습니다.");
    case "not-github":
      return t("GitHub 저장소가 아닙니다. 이슈와 풀 리퀘스트는 GitHub에서만 조회합니다.");
    case "no-cli":
      return t("GitHub CLI(gh)를 찾을 수 없습니다. 설치하면 이슈와 풀 리퀘스트를 볼 수 있습니다.");
    case "unauthenticated":
      return t("GitHub에 로그인되어 있지 않습니다. 터미널에서 gh auth login을 실행하세요.");
    case "unreachable":
      return t("GitHub에 연결하지 못했습니다. 네트워크 상태를 확인하세요.");
    case "error":
      return t("GitHub에서 응답을 받지 못했습니다. 잠시 후 다시 시도하세요.");
  }
}

export function ciLabel(ci: RepoCiSummary): string {
  switch (ci.state) {
    case "passing":
      return t("CI 통과");
    case "failing":
      return ci.total > 0 ? t`CI 실패 ${ci.failing}/${ci.total}` : t("CI 실패");
    case "pending":
      return ci.total > 0 ? t`CI 진행 중 ${ci.pending}/${ci.total}` : t("CI 진행 중");
    case "none":
      return t("CI 없음");
  }
}

/**
 * A GitHub query that could not answer.
 *
 * The sentence names the cause, because each cause has a different fix, and the
 * redacted reason the query reported follows in parentheses when there is one: a
 * repository this account cannot see and a refused API call read the same way in
 * the sentence alone, and only one of them is worth retrying.
 */
function GithubFailureNotice({ failure }: { failure: GithubFailure }): ReactNode {
  const detail = "detail" in failure ? failure.detail : "";
  return (
    <p className="repo-error">
      {githubFailureText(failure.state)}
      {detail && ` (${detail})`}
    </p>
  );
}

export function reviewLabel(review: GithubReviewState): string {
  switch (review) {
    case "approved":
      return t("승인됨");
    case "changes-requested":
      return t("변경 요청");
    case "review-required":
      return t("리뷰 필요");
    case "none":
      return t("리뷰 없음");
  }
}

/** One review's own state, which is not the pull's rolled-up `review`. */
const REVIEW_ENTRY_LABELS: Record<GithubReview["state"], string> = {
  approved: "승인",
  "changes-requested": "변경 요청",
  commented: "코멘트",
  dismissed: "해제됨",
  pending: "대기",
};

export function issueStateLabel(state: GithubIssueSummary["state"]): string {
  return state === "open" ? t("열림") : t("닫힘");
}

export function pullStateLabel(state: GithubPullSummary["state"]): string {
  switch (state) {
    case "open":
      return t("열림");
    case "closed":
      return t("닫힘");
    case "merged":
      return t("병합됨");
  }
}

const MERGEABLE_LABELS: Record<GithubPullDetail["mergeable"], string> = {
  mergeable: "병합 가능",
  conflicting: "충돌",
  unknown: "확인 중",
};

/** `1.0` is a count written as if it were measured; `1` is the same count. */
function trimTrailingZero(value: string): string {
  return value.endsWith(".0") ? value.slice(0, -2) : value;
}

/**
 * Counts in Korean units.
 *
 * A repository can report five figures of issues and the same five figures of pull
 * requests, and a five-digit badge is wider than the card holding it. The exact
 * number is what the tooltip is for; the badge stays one glyph run wide.
 */
export function formatRepoCount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  const count = Math.trunc(value);
  if (count < 1_000) return String(count);
  if (count < 10_000) return t`${trimTrailingZero((count / 1_000).toFixed(1))}천`;
  return t`${trimTrailingZero((count / 10_000).toFixed(1))}만`;
}

/**
 * Starts one bridge read and reports its outcome.
 *
 * `isActive` is the effect's cleanup flag: a read that lands after the user moved to
 * another tab or another project must not write over the state of the new one.
 */
function startRead<T>(
  apply: (state: RepoLoad<T>) => void,
  start: () => Promise<T>,
  isActive: () => boolean,
): void {
  apply({ status: "loading" });
  void start().then(
    (value) => {
      if (isActive()) apply({ status: "ready", value });
    },
    (failure: unknown) => {
      if (isActive())
        apply({ status: "failed", error: humanErrorMessage(failure) });
    },
  );
}

function RepoBadge({ tone, children }: { tone: string; children: ReactNode }) {
  return <span className={`repo-badge repo-badge--${tone}`}>{children}</span>;
}

export interface RepoOverviewPanelProps {
  repository: RepositorySnapshot;
  github: GithubQuery<GithubRepositoryStatus>;
  sessions: AgentSession[];
  onOpenSession: (sessionId: string) => void;
  onOpenDiff: (session: AgentSession) => void;
}

export function RepoOverviewPanel({
  repository,
  github,
  sessions,
  onOpenSession,
  onOpenDiff,
}: RepoOverviewPanelProps) {
  return (
    <>
      <section className="repo-card">
        <header className="repo-card__header">
          <h3>{t("로컬 저장소")}</h3>
          <code>{repository.branch || "detached"}</code>
        </header>
        {repository.repository && (
          <p className="repo-card__meta">
            <span>{t("브랜치")} {formatRepoCount(repository.branches.length)}</span>
            <span>{t("워크트리")} {formatRepoCount(repository.worktrees.length)}</span>
            {repository.remote && (
              <span>{repository.remote.slug ?? repository.remote.name}</span>
            )}
          </p>
        )}
        {repository.error && <p className="repo-error">{repository.error}</p>}
        {/* Both sentences say nothing was read here, so they never appear
            together: Git refusing the path is the only reason this project has
            no repository, and a failed read reports itself instead. */}
        {!repository.repository && !repository.error && (
          <p className="repo-empty">{t("Git 저장소가 아닙니다.")}</p>
        )}
        <WorktreeRows
          worktrees={repository.worktrees}
          sessions={sessions}
          onOpenSession={onOpenSession}
          onOpenDiff={onOpenDiff}
        />
      </section>
      <section className="repo-card">
        <header className="repo-card__header">
          <h3>GitHub</h3>
          {github.state === "ok" && <span>{github.value.fullName}</span>}
        </header>
        {github.state === "ok" ? (
          <>
            <p className="repo-card__meta">
              <span>{t("열린 이슈")} {formatRepoCount(github.value.openIssues)}</span>
              <span>{t("열린 PR")} {formatRepoCount(github.value.openPulls)}</span>
              <RepoBadge tone={github.value.ci.state}>
                {ciLabel(github.value.ci)}
              </RepoBadge>
            </p>
            <p className="repo-card__meta">
              <span>
                {t("기본 브랜치")} <code>{github.value.defaultBranch}</code>
              </span>
              {github.value.private && <span>{t("비공개 저장소")}</span>}
            </p>
          </>
        ) : (
          <GithubFailureNotice failure={github} />
        )}
      </section>
    </>
  );
}

export interface RepoBranchesPanelProps {
  repository: RepositorySnapshot;
  sessions: AgentSession[];
  onOpenSession: (sessionId: string) => void;
  onOpenDiff: (session: AgentSession) => void;
}

export function RepoBranchesPanel({
  repository,
  sessions,
  onOpenSession,
  onOpenDiff,
}: RepoBranchesPanelProps) {
  // A snapshot that read nothing has nothing to draw, and two empty cards would
  // claim the repository has no branches and no worktrees when the read is what
  // did not happen.
  if (!repository.repository)
    return repository.error ? (
      <p className="repo-error">{repository.error}</p>
    ) : (
      <p className="repo-empty">{t("Git 저장소가 아닙니다.")}</p>
    );
  return (
    <>
      {repository.error && <p className="repo-error">{repository.error}</p>}
      <section className="repo-card">
        <header className="repo-card__header">
          <h3>{t("워크트리")}</h3>
          <span>{formatRepoCount(repository.worktrees.length)}</span>
        </header>
        <WorktreeRows
          worktrees={repository.worktrees}
          sessions={sessions}
          onOpenSession={onOpenSession}
          onOpenDiff={onOpenDiff}
        />
      </section>
      <section className="repo-card">
        <header className="repo-card__header">
          <h3>{t("브랜치")}</h3>
          <span>{formatRepoCount(repository.branches.length)}</span>
        </header>
        {repository.branches.length > 0 && (
          <ul className="repo-branches">
            {repository.branches.map((branch) => (
              <li className="repo-branch" key={branch.name}>
                <code>{branch.name}</code>
                {branch.worktreePath && (
                  <>
                    <span className="repo-branch__path">{branch.worktreePath}</span>
                    <RepoBadge tone="checked-out">{t("체크아웃됨")}</RepoBadge>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
        {/* An empty list beside a failed read would state a fact the read did
            not establish. */}
        {repository.branches.length === 0 && !repository.error && (
          <p className="repo-empty">{t("브랜치가 없습니다.")}</p>
        )}
      </section>
    </>
  );
}

/**
 * The worktree rows both local tabs show.
 *
 * A worktree is where the work is, so the row carries the sessions that live in it
 * and the way into their changed files; a worktree nothing is running in is still a
 * row, it simply has no chip and no diff to open.
 */
function WorktreeRows({
  worktrees,
  sessions,
  onOpenSession,
  onOpenDiff,
}: {
  worktrees: RepoWorktree[];
  sessions: readonly AgentSession[];
  onOpenSession: (sessionId: string) => void;
  onOpenDiff: (session: AgentSession) => void;
}) {
  if (worktrees.length === 0)
    return <p className="repo-empty">{t("워크트리가 없습니다.")}</p>;
  return (
    <ul className="repo-worktrees">
      {worktrees.map((worktree) => {
        const connected = sessionsInPath(sessions, worktree.path);
        const diffSession = connected[0];
        return (
          <li className="repo-worktree" key={worktree.path}>
            <div className="repo-worktree__head">
              <code>{worktree.path}</code>
              {worktree.main && <RepoBadge tone="main">main</RepoBadge>}
            </div>
            <div className="repo-worktree__meta">
              <span>{worktree.branch ?? "detached"}</span>
              <span>
                {worktree.changed === undefined
                  ? t("읽을 수 없음")
                  : t`변경 ${formatRepoCount(worktree.changed)}`}
              </span>
              {worktree.locked && <span>{t("잠김")}</span>}
              {worktree.prunable && <span>{t("정리 필요")}</span>}
            </div>
            {connected.length > 0 && (
              <div className="repo-chips">
                {connected.map((session) => (
                  <button
                    className="repo-chip"
                    type="button"
                    key={session.id}
                    onClick={() => onOpenSession(session.id)}
                  >
                    {sessionTitleText(session.title)}
                  </button>
                ))}
              </div>
            )}
            {diffSession && (
              <button
                className="button-secondary"
                type="button"
                onClick={() => onOpenDiff(diffSession)}
              >
                <GitCompare size={13} />
                {t("변경 파일")} </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export interface RepoIssuesPanelProps {
  query: GithubQuery<GithubIssueSummary[]>;
  /** Null until a row is picked; the list behind it is kept meanwhile. */
  detail: RepoLoad<GithubQuery<GithubIssueDetail>> | null;
  onSelect: (number: number) => void;
  onBack: () => void;
  onOpenUrl: (url: string) => void;
}

export function RepoIssuesPanel({
  query,
  detail,
  onSelect,
  onBack,
  onOpenUrl,
}: RepoIssuesPanelProps) {
  if (detail)
    return (
      <IssueDetailView load={detail} onBack={onBack} onOpenUrl={onOpenUrl} />
    );
  if (query.state !== "ok")
    return <GithubFailureNotice failure={query} />;
  if (query.value.length === 0)
    return <p className="repo-empty">{t("열린 이슈가 없습니다.")}</p>;
  return (
    <ul className="repo-list">
      {query.value.map((issue) => (
        <li className="repo-row" key={issue.number}>
          <button
            className="repo-row__button"
            type="button"
            onClick={() => onSelect(issue.number)}
          >
            <span className="repo-row__number">#{issue.number}</span>
            <strong className="repo-row__title">{issue.title}</strong>
            <span className="repo-row__meta">
              <RepoBadge tone={issue.state}>
                {issueStateLabel(issue.state)}
              </RepoBadge>
              {issue.labels.map((label) => (
                <RepoBadge tone="label" key={label.name}>
                  {label.name}
                </RepoBadge>
              ))}
              <span>{issue.author}</span>
              <small>{issue.updatedAt}</small>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export interface RepoPullsPanelProps {
  query: GithubQuery<GithubPullSummary[]>;
  detail: RepoLoad<GithubQuery<GithubPullDetail>> | null;
  onSelect: (number: number) => void;
  onBack: () => void;
  onOpenUrl: (url: string) => void;
}

export function RepoPullsPanel({
  query,
  detail,
  onSelect,
  onBack,
  onOpenUrl,
}: RepoPullsPanelProps) {
  if (detail)
    return <PullDetailView load={detail} onBack={onBack} onOpenUrl={onOpenUrl} />;
  if (query.state !== "ok")
    return <GithubFailureNotice failure={query} />;
  if (query.value.length === 0)
    return <p className="repo-empty">{t("열린 풀 리퀘스트가 없습니다.")}</p>;
  return (
    <ul className="repo-list">
      {query.value.map((pull) => (
        <li className="repo-row" key={pull.number}>
          <button
            className="repo-row__button"
            type="button"
            onClick={() => onSelect(pull.number)}
          >
            <span className="repo-row__number">#{pull.number}</span>
            <strong className="repo-row__title">{pull.title}</strong>
            <span className="repo-row__meta">
              <RepoBadge tone={pull.state}>{pullStateLabel(pull.state)}</RepoBadge>
              <RepoBadge tone={`review-${pull.review}`}>
                {reviewLabel(pull.review)}
              </RepoBadge>
              <RepoBadge tone={pull.ci.state}>{ciLabel(pull.ci)}</RepoBadge>
              <span>{pull.author}</span>
              <small>{pull.updatedAt}</small>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** The back control lives with the detail it leaves, not with the list. */
function DetailHeader({ onBack }: { onBack: () => void }) {
  return (
    <header className="repo-detail__header">
      <button className="button-secondary" type="button" onClick={onBack}>
        <ArrowLeft size={13} />
        {t("목록으로")} </button>
    </header>
  );
}

function IssueDetailView({
  load,
  onBack,
  onOpenUrl,
}: {
  load: RepoLoad<GithubQuery<GithubIssueDetail>>;
  onBack: () => void;
  onOpenUrl: (url: string) => void;
}) {
  return (
    <article className="repo-detail">
      <DetailHeader onBack={onBack} />
      {load.status === "loading" && (
        <p className="repo-view__status">{t("불러오는 중…")}</p>
      )}
      {load.status === "failed" && <p className="repo-error">{load.error}</p>}
      {load.status === "ready" &&
        (load.value.state === "ok" ? (
          <IssueDetailBody issue={load.value.value} onOpenUrl={onOpenUrl} />
        ) : (
          <GithubFailureNotice failure={load.value} />
        ))}
    </article>
  );
}

function IssueDetailBody({
  issue,
  onOpenUrl,
}: {
  issue: GithubIssueDetail;
  onOpenUrl: (url: string) => void;
}) {
  return (
    <>
      <h3 className="repo-detail__title">
        #{issue.number} {issue.title}
      </h3>
      <p className="repo-detail__meta">
        <RepoBadge tone={issue.state}>{issueStateLabel(issue.state)}</RepoBadge>
        {issue.labels.map((label) => (
          <RepoBadge tone="label" key={label.name}>
            {label.name}
          </RepoBadge>
        ))}
        <span>{issue.author}</span>
        <span>{issue.updatedAt}</span>
        {issue.comments > 0 && (
          <span>{t("댓글")} {formatRepoCount(issue.comments)}</span>
        )}
        <button
          className="button-secondary"
          type="button"
          onClick={() => onOpenUrl(issue.url)}
        >
          <ExternalLink size={13} />
          {t("GitHub에서 열기")} </button>
      </p>
      {issue.assignees.length > 0 && (
        <p className="repo-detail__meta">
          {t("담당자")} {issue.assignees.join(", ")}
        </p>
      )}
      <pre className="repo-detail__body">{issue.body || t("본문이 없습니다.")}</pre>
    </>
  );
}

function PullDetailView({
  load,
  onBack,
  onOpenUrl,
}: {
  load: RepoLoad<GithubQuery<GithubPullDetail>>;
  onBack: () => void;
  onOpenUrl: (url: string) => void;
}) {
  return (
    <article className="repo-detail">
      <DetailHeader onBack={onBack} />
      {load.status === "loading" && (
        <p className="repo-view__status">{t("불러오는 중…")}</p>
      )}
      {load.status === "failed" && <p className="repo-error">{load.error}</p>}
      {load.status === "ready" &&
        (load.value.state === "ok" ? (
          <PullDetailBody pull={load.value.value} onOpenUrl={onOpenUrl} />
        ) : (
          <p className="repo-error">{githubFailureText(load.value.state)}</p>
        ))}
    </article>
  );
}

function PullDetailBody({
  pull,
  onOpenUrl,
}: {
  pull: GithubPullDetail;
  onOpenUrl: (url: string) => void;
}) {
  return (
    <>
      <h3 className="repo-detail__title">
        #{pull.number} {pull.title}
      </h3>
      <p className="repo-detail__meta">
        <RepoBadge tone={pull.state}>{pullStateLabel(pull.state)}</RepoBadge>
        {pull.draft && <RepoBadge tone="draft">{t("초안")}</RepoBadge>}
        <RepoBadge tone={`review-${pull.review}`}>
          {reviewLabel(pull.review)}
        </RepoBadge>
        <RepoBadge tone={pull.ci.state}>{ciLabel(pull.ci)}</RepoBadge>
        <span>{pull.author}</span>
        <span>{pull.updatedAt}</span>
        <button
          className="button-secondary"
          type="button"
          onClick={() => onOpenUrl(pull.url)}
        >
          <ExternalLink size={13} />
          {t("GitHub에서 열기")} </button>
      </p>
      <p className="repo-detail__branches">
        <code>{pull.headRefName}</code> → <code>{pull.baseRefName}</code>
      </p>
      <p className="repo-detail__stats">
        <span className="repo-detail__additions">
          +{formatRepoCount(pull.additions)}
        </span>
        <span className="repo-detail__deletions">
          -{formatRepoCount(pull.deletions)}
        </span>
        <span>{t("파일")} {formatRepoCount(pull.changedFiles)}{t("개 파일")}</span>
        <span>{t(MERGEABLE_LABELS[pull.mergeable])}</span>
      </p>
      {pull.reviews.length === 0 ? (
        <p className="repo-empty">{t("아직 리뷰가 없습니다.")}</p>
      ) : (
        <ul className="repo-reviews">
          {pull.reviews.map((review, index) => (
            <li key={`${review.author}-${review.submittedAt ?? index}`}>
              <strong>{review.author}</strong>
              <span>{t(REVIEW_ENTRY_LABELS[review.state])}</span>
              {review.submittedAt && <small>{review.submittedAt}</small>}
            </li>
          ))}
        </ul>
      )}
      <pre className="repo-detail__body">{pull.body || t("본문이 없습니다.")}</pre>
    </>
  );
}

export interface RepoViewProps {
  /** The selected project. */
  project: { root: string; name: string };
  /** Every session of this project, in rail order. */
  sessions: AgentSession[];
  /** Required to reuse the existing change-file panel. */
  backend: AgentBackend;
  /** Null in a renderer with no desktop bridge (browser/remote client). */
  bridge: RepoDesktopBridge | null;
  onOpenSession: (sessionId: string) => void;
  onClose: () => void;
  onError: (message: string) => void;
}

/** Which session's changed files are open, and what has arrived for it. */
export interface ChangesView {
  projectRoot: string;
  requestId: number;
  session: AgentSession;
  diff: DiffSnapshot | null;
  loading: boolean;
  error: string;
}

/** A cached selection is actionable only in the project that opened it. */
export function changesForProject(
  changes: ChangesView | null,
  projectRoot: string,
): ChangesView | null {
  return changes?.projectRoot === projectRoot ? changes : null;
}

/** A fetched detail is visible only while its list selection is active. */
export function detailForSelection<T>(
  selection: number | null,
  detail: T | null,
): T | null {
  return selection === null ? null : detail;
}

export function RepoView({
  project,
  sessions,
  backend,
  bridge,
  onOpenSession,
  onClose,
  onError,
}: RepoViewProps) {
  const [tab, setTab] = useState<RepoViewTab>("overview");
  const [repository, setRepository] = useState<RepoLoad<RepositorySnapshot>>({
    status: "loading",
  });
  const [github, setGithub] = useState<
    RepoLoad<GithubQuery<GithubRepositoryStatus>>
  >({ status: "loading" });
  const [issues, setIssues] = useState<
    RepoLoad<GithubQuery<GithubIssueSummary[]>>
  >({ status: "loading" });
  const [pulls, setPulls] = useState<
    RepoLoad<GithubQuery<GithubPullSummary[]>>
  >({ status: "loading" });
  const [issueNumber, setIssueNumber] = useState<number | null>(null);
  const [issueDetail, setIssueDetail] = useState<
    RepoLoad<GithubQuery<GithubIssueDetail>> | null
  >(null);
  const [pullNumber, setPullNumber] = useState<number | null>(null);
  const [pullDetail, setPullDetail] = useState<
    RepoLoad<GithubQuery<GithubPullDetail>> | null
  >(null);
  const [changes, setChanges] = useState<ChangesView | null>(null);
  const changesRequestId = useRef(0);

  // The rail can switch projects under this screen. Nothing read for the previous
  // root may stand in for the new one while it loads, so every read starts over --
  // including the tabs the user is not looking at.
  useEffect(() => {
    setRepository({ status: "loading" });
    setGithub({ status: "loading" });
    setIssues({ status: "loading" });
    setPulls({ status: "loading" });
    setIssueNumber(null);
    setIssueDetail(null);
    setPullNumber(null);
    setPullDetail(null);
    setChanges(null);
  }, [project.root]);

  // One read per tab, keyed by the project the tab is reading. A tab the user comes
  // back to re-reads: the local repository moves while the screen is open, and the
  // GitHub lists have no push channel to refresh them from.
  useEffect(() => {
    if (!bridge) return;
    const root = project.root;
    let active = true;
    const isActive = (): boolean => active;
    if (tab === "overview") {
      startRead<RepositorySnapshot>(
        setRepository,
        () => bridge.readRepository(root),
        isActive,
      );
      startRead<GithubQuery<GithubRepositoryStatus>>(
        setGithub,
        () => bridge.readGithub(root),
        isActive,
      );
    } else if (tab === "issues") {
      startRead<GithubQuery<GithubIssueSummary[]>>(
        setIssues,
        () => bridge.listIssues(root),
        isActive,
      );
    } else if (tab === "pulls") {
      startRead<GithubQuery<GithubPullSummary[]>>(
        setPulls,
        () => bridge.listPulls(root),
        isActive,
      );
    } else {
      startRead<RepositorySnapshot>(
        setRepository,
        () => bridge.readRepository(root),
        isActive,
      );
    }
    return () => {
      active = false;
    };
  }, [bridge, project.root, tab]);

  useEffect(() => {
    if (!bridge || issueNumber === null) return;
    let active = true;
    startRead<GithubQuery<GithubIssueDetail>>(
      setIssueDetail,
      () => bridge.getIssue(project.root, issueNumber),
      () => active,
    );
    return () => {
      active = false;
    };
  }, [bridge, issueNumber, project.root]);

  useEffect(() => {
    if (!bridge || pullNumber === null) return;
    let active = true;
    startRead<GithubQuery<GithubPullDetail>>(
      setPullDetail,
      () => bridge.getPull(project.root, pullNumber),
      () => active,
    );
    return () => {
      active = false;
    };
  }, [bridge, pullNumber, project.root]);

  function openUrl(url: string): void {
    if (!bridge) return;
    void bridge
      .openExternal(url)
      .catch((failure: unknown) => onError(humanErrorMessage(failure)));
  }

  function revealFolder(path: string): void {
    if (!bridge) return;
    void bridge
      .revealFolder(path)
      .catch((failure: unknown) => onError(humanErrorMessage(failure)));
  }

  function openChanges(session: AgentSession): void {
    const projectRoot = project.root;
    const requestId = ++changesRequestId.current;
    setChanges({
      projectRoot,
      requestId,
      session,
      diff: null,
      loading: true,
      error: "",
    });
    void backend.getDiff(session.id).then(
      (diff) => {
        setChanges((current) =>
          current &&
          current.projectRoot === projectRoot &&
          current.requestId === requestId &&
          current.session.id === session.id
            ? { ...current, diff, loading: false }
            : current,
        );
      },
      (failure: unknown) => {
        setChanges((current) =>
          current &&
          current.projectRoot === projectRoot &&
          current.requestId === requestId &&
          current.session.id === session.id
            ? { ...current, loading: false, error: humanErrorMessage(failure) }
            : current,
        );
      },
    );
  }

  function selectTab(next: RepoViewTab): void {
    setTab(next);
    // A detail and a diff belong to the tab they were opened from; carrying either
    // into another tab would show something the user did not ask for here.
    setIssueNumber(null);
    setPullNumber(null);
    setChanges(null);
  }

  function tabBody(): ReactNode {
    // Project props can change before the reset effect runs. Never let the old
    // project's selection or diff be actionable during that render.
    const currentChanges = changesForProject(changes, project.root);
    if (currentChanges)
      return (
        <>
          {currentChanges.error && (
            <p className="repo-error">{currentChanges.error}</p>
          )}
          <DiffPanel
            key={`${currentChanges.projectRoot}:${currentChanges.session.id}`}
            session={currentChanges.session}
            backend={backend}
            diff={currentChanges.diff}
            loading={currentChanges.loading}
            onRefresh={() => openChanges(currentChanges.session)}
            onClose={() => setChanges(null)}
          />
        </>
      );
    switch (tab) {
      case "overview": {
        if (repository.status === "failed")
          return <p className="repo-error">{repository.error}</p>;
        if (repository.status === "loading")
          return <p className="repo-view__status">{t("불러오는 중…")}</p>;
        // A failed GitHub read is one card's problem, not the whole screen's: the
        // local repository has already answered, and hiding it behind the same
        // paragraph would take away the branch and worktree state the user can
        // still act on.
        if (github.status === "failed")
          return (
            <>
              <p className="repo-error">{github.error}</p>
              <RepoOverviewPanel
                repository={repository.value}
                github={{ state: "error", detail: github.error }}
                sessions={sessions}
                onOpenSession={onOpenSession}
                onOpenDiff={openChanges}
              />
            </>
          );
        if (github.status === "loading")
          return <p className="repo-view__status">{t("불러오는 중…")}</p>;
        return (
          <RepoOverviewPanel
            repository={repository.value}
            github={github.value}
            sessions={sessions}
            onOpenSession={onOpenSession}
            onOpenDiff={openChanges}
          />
        );
      }
      case "issues":
        if (issues.status === "failed")
          return <p className="repo-error">{issues.error}</p>;
        if (issues.status === "loading")
          return <p className="repo-view__status">{t("불러오는 중…")}</p>;
        return (
          <RepoIssuesPanel
            query={issues.value}
            detail={detailForSelection(issueNumber, issueDetail)}
            onSelect={(number) => setIssueNumber(number)}
            onBack={() => {
              setIssueNumber(null);
              setIssueDetail(null);
            }}
            onOpenUrl={openUrl}
          />
        );
      case "pulls":
        if (pulls.status === "failed")
          return <p className="repo-error">{pulls.error}</p>;
        if (pulls.status === "loading")
          return <p className="repo-view__status">{t("불러오는 중…")}</p>;
        return (
          <RepoPullsPanel
            query={pulls.value}
            detail={detailForSelection(pullNumber, pullDetail)}
            onSelect={(number) => setPullNumber(number)}
            onBack={() => {
              setPullNumber(null);
              setPullDetail(null);
            }}
            onOpenUrl={openUrl}
          />
        );
      case "branches":
        if (repository.status === "failed")
          return <p className="repo-error">{repository.error}</p>;
        if (repository.status === "loading")
          return <p className="repo-view__status">{t("불러오는 중…")}</p>;
        return (
          <RepoBranchesPanel
            repository={repository.value}
            sessions={sessions}
            onOpenSession={onOpenSession}
            onOpenDiff={openChanges}
          />
        );
    }
  }

  // The header needs the local snapshot for the GitHub URL, so it is drawn from
  // whatever local read has landed -- the overview or the branches tab.
  const webUrl =
    repository.status === "ready" ? (repository.value.remote?.webUrl ?? "") : "";

  return (
    <main className="repo-view">
      <header className="repo-view__header">
        <strong className="repo-view__title">{project.name}</strong>
        <code className="repo-view__root">{project.root}</code>
        <button
          className="button-secondary"
          type="button"
          disabled={!webUrl}
          title={webUrl || t("GitHub remote가 없습니다")}
          onClick={() => openUrl(webUrl)}
        >
          <ExternalLink size={13} />
          {t("GitHub에서 열기")} </button>
        {bridge && (
          <button
            className="button-secondary"
            type="button"
            onClick={() => revealFolder(project.root)}
          >
            <FolderOpen size={13} />
            {t("로컬 폴더 열기")} </button>
        )}
        <button className="button-secondary" type="button" onClick={onClose}>
          <ArrowLeft size={14} />
          {t("대화로 돌아가기")} </button>
      </header>
      {/* The tabs are the only thing that starts a read, so a renderer without the
          desktop bridge gets the notice and no way to ask for one. */}
      {bridge && (
        <nav className="repo-view__tabs">
          {REPO_TABS.map((id) => (
            <button
              className={id === tab ? "repo-tab is-active" : "repo-tab"}
              type="button"
              key={id}
              aria-selected={id === tab}
              onClick={() => selectTab(id)}
            >
              {repoTabLabel(id)}
            </button>
          ))}
        </nav>
      )}
      <div className="repo-view__body">
        {bridge ? (
          tabBody()
        ) : (
          <p className="repo-view__notice">
            {t("저장소 화면은 데스크톱 앱에서만 사용할 수 있습니다. 브라우저나 원격 기기에서는 세션 목록으로 돌아가세요.")} </p>
        )}
      </div>
    </main>
  );
}
