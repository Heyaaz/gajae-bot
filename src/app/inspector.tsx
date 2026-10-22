import gajaeIconUrl from "../assets/gajae-icon-ui.png";
import type {
  DiffSnapshot,
  GitStatusSnapshot,
  GoalOperation,
  GoalSnapshot,
  SubagentSnapshot,
} from "../../shared/agent-contract";
import type { AgentBackend } from "../backend/agent-backend";
import type { AgentSession, ToolActivity, TranscriptItem } from "../backend/types";
import { Copy, RotateCcw, Target, X } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { sessionTitleText, statusLabel, subagentLabel } from "./format";
import { t, useLanguage } from "../i18n";


export function shouldClearCommitMessage(
  succeeded: boolean,
  submittedRevision: number,
  currentRevision: number,
): boolean {
  return succeeded && submittedRevision === currentRevision;
}

export interface InspectorProps {
  session: AgentSession;
  transcript: TranscriptItem[];
  liveSubagents: SubagentSnapshot[];
  resuming?: boolean;
  onResume?: () => void;
  onClose: () => void;
  revealToolId?: string;
}

const InspectorWorkCard = memo(function InspectorWorkCard({
  work,
  highlighted,
}: { work: SubagentSnapshot; highlighted: boolean }) {
  useLanguage();
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (!highlighted || !ref.current) return;
    ref.current.open = true;
    ref.current.scrollIntoView({ block: "nearest" });
    ref.current.focus();
  }, [highlighted]);
  return (
    <details ref={ref} tabIndex={-1}
      className={`subagent-card subagent-card--${work.status}${highlighted ? " is-search-reveal" : ""}`}>
      <summary>
        <span className={`subagent-state subagent-state--${work.status}`} />
        <strong>{work.label}</strong>
        <em>{work.status === "running" ? t("작업 중") : work.status === "waiting" ? t("대기") : work.status === "failed" ? t("실패") : t("완료")}</em>
      </summary>
      <small>{[work.role, work.id].filter(Boolean).join(" · ")}</small>
      {work.objective && <p>{work.objective}</p>}
      {work.detail ? <pre className="inspector-work-output">{work.detail}</pre> :
        <p>{t("아직 보고된 상세 내용이 없습니다.")}</p>}
    </details>
  );
});

/**
 * Session detail panel.
 *
 * Memoized, and its subagent list derived through useMemo, because the panel is a child
 * of the shell: every streamed chunk changes shell state and re-runs this whole subtree.
 * The panel shows a handful of rows but scans the entire transcript to find them, and
 * that scan was repeating on chunks that could not affect it.
 */
function InspectorView({
  session,
  transcript,
  liveSubagents,
  resuming = false,
  onResume,
  onClose,
  revealToolId,
}: InspectorProps) {
  useLanguage();
  const shellWork = useMemo(() => transcript.filter(
    (item): item is ToolActivity => item.kind === "tool" && /^(bash|shell|exec|execute)$/iu.test(item.name),
  ), [transcript]);
  const subagents: SubagentSnapshot[] = useMemo(
    () =>
      liveSubagents.length > 0
        ? liveSubagents
        : transcript
            .filter(
              (item): item is ToolActivity =>
                item.kind === "tool" && /^(task|subagent)$/iu.test(item.name),
            )
            .map((tool): SubagentSnapshot => ({
              id: tool.id,
              label: subagentLabel(tool),
              status:
                tool.status === "running"
                  ? "running"
                  : tool.status === "failed" || tool.status === "denied" || tool.status === "cancelled"
                    ? "failed"
                    : tool.status === "approval-required" || tool.status === "pending"
                      ? "waiting"
                      : "completed",
              detail: tool.output,
            })),
    [liveSubagents, transcript],
  );
  return (
    <aside className="inspector">
      <header>
        <strong>{t("Gajae 세션 정보")}</strong>
        <button className="icon-button" type="button" onClick={onClose}>
          <X size={17} />
        </button>
      </header>
      <section className="inspector-identity">
        <span className="inspector-avatar">
          <img src={gajaeIconUrl} alt="" />
        </span>
        <h2>{sessionTitleText(session.title)}</h2>
        <button
          className="inspector-session-id"
          type="button"
          title={t("세션 ID 복사")}
          onClick={() => void navigator.clipboard?.writeText(session.id)}
        >
          <code>{session.id}</code>
          <Copy size={11} />
        </button>
        <p>{session.subtitle}</p>
        <span
          className={`status-chip status-chip--${session.phase === "compacting" ? "compacting" : session.status}`}
        >
          {statusLabel(session.status, session.phase)}
        </span>
        {onResume && session.attachment !== "attached" && (
          <button
            className="inspector-resume"
            type="button"
            disabled={resuming}
            onClick={() => onResume()}
          >
            <RotateCcw size={12} />
            {resuming ? t("이어서 진행 중…") : t("세션 이어서 진행")}
          </button>
        )}
      </section>
      <section className="inspector-section inspector-subagents">
        <h3>{t("서브 에이전트")}</h3>
        {subagents.length > 0 ? (
          subagents.map((tool) => (
            <InspectorWorkCard key={tool.id} work={tool} highlighted={tool.id === revealToolId} />
          ))
        ) : (
          <p>{t("실행된 서브 에이전트가 없습니다.")}</p>
        )}
      </section>
      <section className="inspector-section">
        <h3>{t("셸 작업")}</h3>
        <p>{t("이 대화의 셸 실행 기록입니다.")}</p>
        {shellWork.map((tool) => <InspectorWorkCard key={tool.id} highlighted={tool.id === revealToolId}
          work={{ id: tool.id, label: tool.description,
            status: tool.status === "running" ? "running" : tool.status === "pending" || tool.status === "approval-required" ? "waiting" : tool.status === "failed" || tool.status === "denied" || tool.status === "cancelled" ? "failed" : "completed",
            objective: tool.command, detail: tool.output }} />)}
        {shellWork.length === 0 && <p>{t("보고된 셸 작업이 없습니다.")}</p>}
      </section>
    </aside>
  );
}

export const Inspector = memo(InspectorView);

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
            {t("재개")} </button>
        ) : (
          goal.mode !== "complete" && (
            <button
              type="button"
              disabled={busy}
              onClick={() => onOperate("pause")}
            >
              {t("일시정지")} </button>
          )
        )}
        {goal.mode !== "complete" && (
          <button
            type="button"
            disabled={busy}
            onClick={() => onOperate("complete")}
          >
            {t("완료")} </button>
        )}
        <button type="button" disabled={busy} onClick={() => onOperate("drop")}>
          {t("해제")} </button>
      </span>
    </div>
  );
}

/** One session's slice of the diff panel; another session's slice is never read. */
type SessionScoped<T> = { sessionId: string; value: T };

function scoped<T>(
  state: SessionScoped<T> | null,
  sessionId: string,
  fallback: T,
): T {
  return state?.sessionId === sessionId ? state.value : fallback;
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
  const sessionIdRef = useRef(session.id);
  sessionIdRef.current = session.id;
  const gitRequestRef = useRef(0);
  const [gitState, setGitState] = useState<SessionScoped<GitStatusSnapshot> | null>(
    null,
  );
  const [selectionState, setSelectionState] = useState<SessionScoped<string[]>>(
    { sessionId: session.id, value: [] },
  );
  const [draftState, setDraftState] = useState<SessionScoped<string>>({
    sessionId: session.id,
    value: "",
  });
  const [busyState, setBusyState] = useState<SessionScoped<boolean> | null>(
    null,
  );
  const [errorState, setErrorState] = useState<SessionScoped<string> | null>(
    null,
  );
  const commitMessageRevision = useRef(0);
  // Git state, selection and the commit draft belong to the session that made
  // them: a late answer for the previous session is dropped and the old file list
  // can never address the new session's repository.
  const git = scoped(gitState, session.id, null);
  const selected = scoped(selectionState, session.id, [] as string[]);
  const commitMessage = scoped(draftState, session.id, "");
  const gitBusy = scoped(busyState, session.id, false);
  const gitError = scoped(errorState, session.id, "");
  const refreshGit = useCallback(() => {
    const sessionId = session.id;
    const request = ++gitRequestRef.current;
    setErrorState({ sessionId, value: "" });
    void backend
      .getGitStatus(sessionId)
      .then((status) => {
        if (gitRequestRef.current !== request || sessionIdRef.current !== sessionId)
          return;
        setGitState({ sessionId, value: status });
      })
      .catch((error) => {
        if (gitRequestRef.current !== request || sessionIdRef.current !== sessionId)
          return;
        setErrorState({
          sessionId,
          value: error instanceof Error ? error.message : String(error),
        });
      });
  }, [backend, session.id]);
  useEffect(() => {
    queueMicrotask(refreshGit);
  }, [refreshGit]);

  async function mutate(
    operation: () => Promise<GitStatusSnapshot>,
  ): Promise<boolean> {
    const sessionId = session.id;
    const request = ++gitRequestRef.current;
    setBusyState({ sessionId, value: true });
    setErrorState({ sessionId, value: "" });
    try {
      const status = await operation();
      if (gitRequestRef.current !== request || sessionIdRef.current !== sessionId)
        return false;
      setGitState({ sessionId, value: status });
      setSelectionState({ sessionId, value: [] });
      onRefresh();
      return true;
    } catch (error) {
      if (gitRequestRef.current === request && sessionIdRef.current === sessionId)
        setErrorState({
          sessionId,
          value: error instanceof Error ? error.message : String(error),
        });
      return false;
    } finally {
      setBusyState((current) =>
        current?.sessionId === sessionId
          ? { sessionId, value: false }
          : current,
      );
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
        <strong>{t("변경된 파일")}</strong>
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
          {loading ? t("불러오는 중…") : t("새로 고침")}
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
                    setSelectionState((current) => {
                      const paths =
                        current?.sessionId === session.id ? current.value : [];
                      return {
                        sessionId: session.id,
                        value: event.target.checked
                          ? [...new Set([...paths, file.path])]
                          : paths.filter((path) => path !== file.path),
                      };
                    })
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
              placeholder={t("커밋 메시지")}
              value={commitMessage}
              onChange={(event) => {
                commitMessageRevision.current += 1;
                setDraftState({ sessionId: session.id, value: event.target.value });
              }}
            />
            <button
              className="button-primary"
              type="button"
              disabled={gitBusy || staged.length === 0 || !commitMessage.trim()}
              onClick={() => {
                if (
                  !window.confirm(
                    t`스테이징된 ${staged.length}개 파일을 커밋할까요?`,
                  )
                )
                  return;
                const submittedRevision = commitMessageRevision.current;
                void mutate(() =>
                  backend.commitChanges(session.id, commitMessage),
                ).then((succeeded) => {
                  if (
                    shouldClearCommitMessage(
                      succeeded,
                      submittedRevision,
                      commitMessageRevision.current,
                    )
                  ) {
                    commitMessageRevision.current += 1;
                    setDraftState({ sessionId: session.id, value: "" });
                  }
                });
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
                    t`${git?.upstream ?? "upstream"}으로 ${git?.ahead ?? 0}개 커밋을 push할까요?`,
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
          {t("Git 변경 작업은 Gajae managed worktree 세션에서만 사용할 수 있습니다.")} </p>
      )}
      {diff?.error && <p className="diff-error">{diff.error}</p>}
      {!loading && !diff?.error && (diff?.files.length ?? 0) === 0 && (
        <p className="diff-empty">{t("변경된 파일이 없습니다.")}</p>
      )}
      {diff?.files.map((file) => (
        <details key={file.id} open>
          <summary>{file.path}</summary>
          <pre>{file.patch || t("(패치 없음)")}</pre>
        </details>
      ))}
    </aside>
  );
}
