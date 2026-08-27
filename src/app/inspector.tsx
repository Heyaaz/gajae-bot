import gajaeIconUrl from "../assets/gajae-icon.png";
import type {
  DiffSnapshot,
  GitStatusSnapshot,
  GoalOperation,
  GoalSnapshot,
  SubagentSnapshot,
} from "../../shared/agent-contract";
import type { AgentBackend } from "../backend/agent-backend";
import type { AgentSession, ToolActivity, TranscriptItem } from "../backend/types";
import { Target, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { statusLabel, subagentLabel } from "./format";

export interface InspectorProps {
  session: AgentSession;
  transcript: TranscriptItem[];
  liveSubagents: SubagentSnapshot[];
  onClose: () => void;
}

export function Inspector({
  session,
  transcript,
  liveSubagents,
  onClose,
}: InspectorProps) {
  const transcriptSubagents = transcript.filter(
    (item): item is ToolActivity =>
      item.kind === "tool" && /^(task|subagent)$/iu.test(item.name),
  );
  const subagents: SubagentSnapshot[] =
    liveSubagents.length > 0
      ? liveSubagents
      : transcriptSubagents.map((tool): SubagentSnapshot => ({
          id: tool.id,
          label: subagentLabel(tool),
          status:
            tool.status === "running"
              ? "running"
              : tool.status === "failed" || tool.status === "denied"
                ? "failed"
                : tool.status === "approval-required"
                  ? "waiting"
                  : "completed",
          detail: tool.output,
        }));
  return (
    <aside className="inspector">
      <header>
        <strong>Gajae 세션 정보</strong>
        <button className="icon-button" type="button" onClick={onClose}>
          <X size={17} />
        </button>
      </header>
      <section className="inspector-identity">
        <span className="inspector-avatar">
          <img src={gajaeIconUrl} alt="" />
        </span>
        <h2>{session.title}</h2>
        <p>{session.subtitle}</p>
        <span
          className={`status-chip status-chip--${session.phase === "compacting" ? "compacting" : session.status}`}
        >
          {statusLabel(session.status, session.phase)}
        </span>
      </section>
      <section className="inspector-section inspector-subagents">
        <h3>서브 에이전트</h3>
        {subagents.length > 0 ? (
          subagents.map((tool) => (
            <article
              className={`subagent-card subagent-card--${tool.status}`}
              key={tool.id}
            >
              <header>
                <span
                  className={`subagent-state subagent-state--${tool.status}`}
                />
                <strong>{tool.label}</strong>
                <em>
                  {tool.status === "running"
                    ? "작업 중"
                    : tool.status === "waiting"
                      ? "대기"
                      : tool.status === "failed"
                        ? "실패"
                        : "완료"}
                </em>
              </header>
              <small>{[tool.role, tool.id].filter(Boolean).join(" · ")}</small>
              {(tool.objective || tool.detail) && (
                <p>{tool.objective || tool.detail}</p>
              )}
            </article>
          ))
        ) : (
          <p>실행된 서브 에이전트가 없습니다.</p>
        )}
      </section>
    </aside>
  );
}

export function GoalProgressRow({
  goal,
  busy,
  onOperate,
}: {
  goal: GoalSnapshot;
  busy: boolean;
  onOperate: (operation: GoalOperation) => void;
}) {
  if (!goal.enabled || !goal.objective) return null;
  return (
    <div
      className={`goal-progress-row goal-progress-row--${goal.mode ?? "active"}`}
    >
      <span className="goal-progress-icon">
        <Target size={13} />
      </span>
      <span className="goal-progress-copy">
        <strong>{goal.objective}</strong>
        {goal.total > 0 && (
          <small>
            {goal.completed}/{goal.total}
          </small>
        )}
      </span>
      <span className="goal-progress-actions">
        {goal.mode === "paused" ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => onOperate("resume")}
          >
            재개
          </button>
        ) : (
          goal.mode !== "complete" && (
            <button
              type="button"
              disabled={busy}
              onClick={() => onOperate("pause")}
            >
              일시정지
            </button>
          )
        )}
        {goal.mode !== "complete" && (
          <button
            type="button"
            disabled={busy}
            onClick={() => onOperate("complete")}
          >
            완료
          </button>
        )}
        <button type="button" disabled={busy} onClick={() => onOperate("drop")}>
          해제
        </button>
      </span>
    </div>
  );
}

export function DiffPanel({
  session,
  backend,
  diff,
  loading,
  onRefresh,
  onClose,
}: {
  session: AgentSession;
  backend: AgentBackend;
  diff: DiffSnapshot | null;
  loading: boolean;
  onRefresh: () => void;
  onClose: () => void;
}) {
  const [git, setGit] = useState<GitStatusSnapshot | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [commitMessage, setCommitMessage] = useState("");
  const [gitBusy, setGitBusy] = useState(false);
  const [gitError, setGitError] = useState("");
  const refreshGit = useCallback(() => {
    setGitError("");
    void backend
      .getGitStatus(session.id)
      .then(setGit)
      .catch((error) =>
        setGitError(error instanceof Error ? error.message : String(error)),
      );
  }, [backend, session.id]);
  useEffect(() => {
    queueMicrotask(refreshGit);
  }, [refreshGit]);

  async function mutate(
    operation: () => Promise<GitStatusSnapshot>,
  ): Promise<void> {
    setGitBusy(true);
    setGitError("");
    try {
      setGit(await operation());
      setSelected([]);
      onRefresh();
    } catch (error) {
      setGitError(error instanceof Error ? error.message : String(error));
    } finally {
      setGitBusy(false);
    }
  }

  const staged =
    git?.files
      .filter(
        (file) =>
          file.index !== " " && file.index !== "." && file.index !== "?",
      )
      .map((file) => file.path) ?? [];
  const unstaged =
    git?.files
      .filter((file) => file.workingTree !== " " && file.workingTree !== ".")
      .map((file) => file.path) ?? [];
  return (
    <aside className="diff-panel">
      <header>
        <strong>변경된 파일</strong>
        <button className="icon-button" type="button" onClick={onClose}>
          <X size={16} />
        </button>
      </header>
      <div className="diff-toolbar">
        <button
          className="button-secondary"
          type="button"
          onClick={() => {
            onRefresh();
            refreshGit();
          }}
          disabled={loading || gitBusy}
        >
          {loading ? "불러오는 중…" : "새로 고침"}
        </button>
        {git && (
          <span>
            <strong>{git.branch || "detached"}</strong>
            {git.upstream && (
              <small>
                {git.upstream} · ↑{git.ahead} ↓{git.behind}
              </small>
            )}
          </span>
        )}
      </div>
      {gitError && <p className="diff-error">{gitError}</p>}
      {session.worktree?.managed ? (
        <section className="git-actions">
          <div className="git-file-list">
            {git?.files.map((file) => (
              <label key={file.path}>
                <input
                  type="checkbox"
                  checked={selected.includes(file.path)}
                  onChange={(event) =>
                    setSelected((current) =>
                      event.target.checked
                        ? [...new Set([...current, file.path])]
                        : current.filter((path) => path !== file.path),
                    )
                  }
                />
                <code>
                  {file.index}
                  {file.workingTree}
                </code>
                <span>{file.path}</span>
              </label>
            ))}
          </div>
          <div>
            <button
              className="button-secondary"
              type="button"
              disabled={
                gitBusy ||
                selected.filter((path) => unstaged.includes(path)).length === 0
              }
              onClick={() =>
                void mutate(() =>
                  backend.stageFiles(
                    session.id,
                    selected.filter((path) => unstaged.includes(path)),
                  ),
                )
              }
            >
              Stage
            </button>
            <button
              className="button-secondary"
              type="button"
              disabled={
                gitBusy ||
                selected.filter((path) => staged.includes(path)).length === 0
              }
              onClick={() =>
                void mutate(() =>
                  backend.unstageFiles(
                    session.id,
                    selected.filter((path) => staged.includes(path)),
                  ),
                )
              }
            >
              Unstage
            </button>
          </div>
          <div className="commit-row">
            <input
              placeholder="커밋 메시지"
              value={commitMessage}
              onChange={(event) => setCommitMessage(event.target.value)}
            />
            <button
              className="button-primary"
              type="button"
              disabled={gitBusy || staged.length === 0 || !commitMessage.trim()}
              onClick={() => {
                if (
                  !window.confirm(
                    `스테이징된 ${staged.length}개 파일을 커밋할까요?`,
                  )
                )
                  return;
                void mutate(() =>
                  backend.commitChanges(session.id, commitMessage),
                ).then(() => setCommitMessage(""));
              }}
            >
              Commit
            </button>
            <button
              className="button-primary"
              type="button"
              disabled={gitBusy || !git?.upstream || git.ahead === 0}
              onClick={() => {
                if (
                  !window.confirm(
                    `${git?.upstream ?? "upstream"}으로 ${git?.ahead ?? 0}개 커밋을 push할까요?`,
                  )
                )
                  return;
                void mutate(() => backend.pushChanges(session.id));
              }}
            >
              Push
            </button>
          </div>
        </section>
      ) : (
        <p className="diff-empty">
          Git 변경 작업은 Gajae managed worktree 세션에서만 사용할 수 있습니다.
        </p>
      )}
      {diff?.error && <p className="diff-error">{diff.error}</p>}
      {!loading && !diff?.error && (diff?.files.length ?? 0) === 0 && (
        <p className="diff-empty">변경된 파일이 없습니다.</p>
      )}
      {diff?.files.map((file) => (
        <details key={file.id} open>
          <summary>{file.path}</summary>
          <pre>{file.patch || "(패치 없음)"}</pre>
        </details>
      ))}
    </aside>
  );
}
