import gajaeIconUrl from "../assets/gajae-icon-ui.png";
import type {
  ChangedFile,
  DiffSnapshot,
  GitStatusSnapshot,
  GoalOperation,
  GoalSnapshot,
  SubagentSnapshot,
} from "../../shared/agent-contract";
import type { AgentBackend } from "../backend/agent-backend";
import type { AgentSession, ToolActivity, TranscriptItem } from "../backend/types";
import { ChevronRight, Copy, RotateCcw, Target, X } from "lucide-react";
import { todoStatusView } from "./todo-status";
import type { ReactNode } from "react";
import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { isDeclinedConfirmation, sessionTitleText, statusLabel, storyStatusLabel, subagentLabel } from "./format";
import { t, useLanguage } from "../i18n";
import {
  anchorLineKeys,
  diffLineKey,
  diffLineNumber,
  formatReview,
  isCommentable,
  parseDiffPatch,
  reviewAnchor,
  reviewComments,
  reviewLocation,
  saveReviewComments,
  subscribeReviewComments,
  type DiffLine,
  type ReviewAnchor,
  type ReviewComment,
} from "./review-model";


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
    const section = ref.current.parentElement?.closest("details");
    if (section) section.open = true;
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
      <section className="inspector-section">
        <details className="inspector-work-section" open>
          <summary><h3>{t("서브 에이전트")}</h3><ChevronRight size={12} aria-hidden /></summary>
          <div className="inspector-subagents">
        {subagents.length > 0 ? (
          subagents.map((tool) => (
            <InspectorWorkCard key={tool.id} work={tool} highlighted={tool.id === revealToolId} />
          ))
        ) : (
          <p>{t("실행된 서브 에이전트가 없습니다.")}</p>
        )}
          </div>
        </details>
      </section>
      <section className="inspector-section">
        <details className="inspector-work-section" open>
          <summary><h3>{t("셸 작업")}</h3><ChevronRight size={12} aria-hidden /></summary>
        <p>{t("이 대화의 셸 실행 기록입니다.")}</p>
        {shellWork.map((tool) => <InspectorWorkCard key={tool.id} highlighted={tool.id === revealToolId}
          work={{ id: tool.id, label: tool.description,
            status: tool.status === "running" ? "running" : tool.status === "pending" || tool.status === "approval-required" ? "waiting" : tool.status === "failed" || tool.status === "denied" || tool.status === "cancelled" ? "failed" : "completed",
            objective: tool.command, detail: tool.output }} />)}
        {shellWork.length === 0 && <p>{t("보고된 셸 작업이 없습니다.")}</p>}
        </details>
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
  const [listOpen, setListOpen] = useState(false);
  const listId = useId();
  if (!goal.enabled || !goal.objective) return null;
  const ultragoal = goal.progress?.ultragoal ?? null;
  const tasks = goal.tasks ?? [];
  const stories = ultragoal?.stories ?? [];
  const hasList = tasks.length > 0 || stories.length > 0;
  const copy = (
    <>
      <strong>{goal.objective}</strong>
      {goal.total > 0 && (
        <small>
          {goal.completed}/{goal.total}
        </small>
      )}
      {ultragoal && (
        <small className="goal-progress-stories">
          {t`스토리 ${ultragoal.counts.complete}/${ultragoal.counts.total}`}
        </small>
      )}
      {ultragoal?.current && (
        <span className="goal-progress-current">{ultragoal.current.title}</span>
      )}
    </>
  );
  return (
    <div
      className={`goal-progress-row goal-progress-row--${goal.mode ?? "active"}`}
    >
      <span className="goal-progress-icon">
        <Target size={13} />
      </span>
      {hasList ? (
        <button
          type="button"
          className="goal-progress-copy goal-progress-toggle"
          aria-expanded={listOpen}
          aria-controls={listId}
          title={listOpen ? t("목록 접기") : t("목록 펼치기")}
          onClick={() => setListOpen((open) => !open)}
        >
          {copy}
          <ChevronRight className="goal-progress-chevron" size={12} aria-hidden />
        </button>
      ) : (
        <span className="goal-progress-copy">{copy}</span>
      )}
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
      {hasList && listOpen && (
        <div className="goal-progress-list" id={listId}>
          {tasks.length > 0 && (
            <ol className="goal-task-list">
              {tasks.map((task, index) => {
                const status = todoStatusView(task.status);
                return (
                  <li
                    key={`${index}:${task.content}`}
                    className={`goal-task goal-task--${status.key}`}
                  >
                    <span className="goal-task-marker" aria-hidden>{status.marker}</span>
                    <span className="goal-task-title">{task.content}</span>
                  </li>
                );
              })}
            </ol>
          )}
          {stories.length > 0 && (
            <ol className="goal-story-list">
              {stories.map((story) => (
                <li
                  key={story.id}
                  className={`goal-story goal-story--${story.status}`}
                  data-story-id={story.id}
                >
                  <span className="goal-story-status">{storyStatusLabel(story.status)}</span>
                  <span className="goal-story-title">{story.title}</span>
                  {story.verificationReceipt && (
                    <span className="goal-story-receipt">{t("검증 기록")}</span>
                  )}
                </li>
              ))}
              {ultragoal!.omittedStories > 0 && (
                <li className="goal-story goal-story--omitted">
                  {t`스토리 ${ultragoal!.omittedStories}개 더 있음`}
                </li>
              )}
            </ol>
          )}
        </div>
      )}
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

/** Rows picked for a new comment, by line key so a refresh of the same diff keeps them. */
type LineSelection = { fileId: string; anchor: string; focus: string };

type ParsedFile = { file: ChangedFile; lines: DiffLine[] };

function rowIndex(lines: readonly DiffLine[], key: string): number {
  return lines.findIndex((line) => isCommentable(line) && diffLineKey(line) === key);
}

function commentedRows(
  parsed: ParsedFile,
  comments: readonly ReviewComment[],
): Set<number> {
  const rows = new Set<number>();
  for (const comment of comments) {
    if (comment.file !== parsed.file.path) continue;
    const [first, last] = anchorLineKeys(comment);
    const from = rowIndex(parsed.lines, first);
    const to = rowIndex(parsed.lines, last);
    if (from < 0 || to < 0) continue;
    for (let index = from; index <= to; index += 1) rows.add(index);
  }
  return rows;
}

function DiffFileLines({
  parsed,
  selected,
  commented,
  onPick,
  form,
}: {
  parsed: ParsedFile;
  selected: readonly [number, number] | null;
  commented: ReadonlySet<number>;
  onPick: (key: string, extend: boolean) => void;
  form: ReactNode;
}) {
  if (!parsed.lines.some(isCommentable))
    return <pre>{parsed.file.patch || t("(패치 없음)")}</pre>;
  return (
    <div className="diff-lines">
      {parsed.lines.map((line, index) => {
        const inSelection =
          selected !== null && index >= selected[0] && index <= selected[1];
        return (
          <Fragment key={index}>
            <div
              className={`diff-line diff-line--${line.kind}${inSelection ? " is-selected" : ""}${commented.has(index) ? " has-comment" : ""}`}
            >
              {isCommentable(line) ? (
                <button
                  type="button"
                  className="diff-line-number"
                  aria-pressed={inSelection}
                  title={t("코멘트할 줄 선택 (Shift+클릭으로 범위 선택)")}
                  onClick={(event) => onPick(diffLineKey(line), event.shiftKey)}
                >
                  {diffLineNumber(line)}
                </button>
              ) : (
                <span className="diff-line-number" />
              )}
              <code>{line.text}</code>
            </div>
            {selected?.[1] === index && form}
          </Fragment>
        );
      })}
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
  onSubmitReview,
}: {
  session: AgentSession;
  backend: AgentBackend;
  diff: DiffSnapshot | null;
  loading: boolean;
  onRefresh: () => void;
  onClose: () => void;
  /** Hands the formatted review to the session's composer rules; omitted where sending is not allowed. */
  onSubmitReview?: (sessionId: string, text: string) => void;
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
  const comments = useSyncExternalStore(
    useCallback(
      (listener: () => void) => subscribeReviewComments(session.id, listener),
      [session.id],
    ),
    () => reviewComments(session.id),
  );
  const [lineState, setLineState] = useState<SessionScoped<LineSelection | null> | null>(null);
  const lineSelection = scoped(lineState, session.id, null);
  const [noteState, setNoteState] = useState<SessionScoped<string> | null>(null);
  const note = scoped(noteState, session.id, "");
  const [editState, setEditState] = useState<
    SessionScoped<{ id: string; body: string } | null> | null
  >(null);
  const editing = scoped(editState, session.id, null);
  const parsedFiles = useMemo(
    () =>
      (diff?.files ?? []).map((file) => ({ file, lines: parseDiffPatch(file.patch) })),
    [diff],
  );
  const selectedFile = parsedFiles.find(
    (parsed) => parsed.file.id === lineSelection?.fileId,
  );
  const selectedRows: [number, number] | null =
    selectedFile && lineSelection
      ? [
          rowIndex(selectedFile.lines, lineSelection.anchor),
          rowIndex(selectedFile.lines, lineSelection.focus),
        ]
      : null;
  const selectedAnchor: ReviewAnchor | null =
    selectedFile && selectedRows && selectedRows.every((row) => row >= 0)
      ? reviewAnchor(selectedFile.file.path, selectedFile.lines, ...selectedRows)
      : null;

  function pickLine(parsed: ParsedFile, key: string, extend: boolean): void {
    const current = lineSelection;
    let next: LineSelection | null = { fileId: parsed.file.id, anchor: key, focus: key };
    if (current?.fileId === parsed.file.id) {
      const from = rowIndex(parsed.lines, current.anchor);
      // A range never leaves its hunk; a shift-click outside it starts over.
      if (extend && from >= 0 && reviewAnchor(parsed.file.path, parsed.lines, from, rowIndex(parsed.lines, key)))
        next = { ...current, focus: key };
      else if (!extend && current.anchor === key && current.focus === key) next = null;
    }
    setLineState({ sessionId: session.id, value: next });
  }

  function addComment(): void {
    const body = note.trim();
    if (!selectedAnchor || !body) return;
    saveReviewComments(session.id, [
      ...reviewComments(session.id),
      { ...selectedAnchor, id: crypto.randomUUID(), body },
    ]);
    setLineState({ sessionId: session.id, value: null });
    setNoteState({ sessionId: session.id, value: "" });
  }

  function saveEdit(): void {
    const body = editing?.body.trim();
    if (!editing || !body) return;
    saveReviewComments(
      session.id,
      reviewComments(session.id).map((comment) =>
        comment.id === editing.id ? { ...comment, body } : comment,
      ),
    );
    setEditState({ sessionId: session.id, value: null });
  }

  function sendReview(): void {
    const pending = reviewComments(session.id);
    if (!onSubmitReview || pending.length === 0) return;
    onSubmitReview(session.id, formatReview(pending));
    saveReviewComments(session.id, []);
    setEditState({ sessionId: session.id, value: null });
  }

  const commentForm = selectedAnchor && (
    <form
      className="diff-comment-form"
      onSubmit={(event) => {
        event.preventDefault();
        addComment();
      }}
    >
      <small>{reviewLocation(selectedAnchor)}</small>
      <textarea
        autoFocus
        aria-label={t("코멘트")}
        placeholder={t("이 코드에 대한 코멘트")}
        value={note}
        onChange={(event) =>
          setNoteState({ sessionId: session.id, value: event.target.value })
        }
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            addComment();
          }
        }}
      />
      <div className="diff-review-actions">
        <button
          className="button-secondary"
          type="button"
          onClick={() => setLineState({ sessionId: session.id, value: null })}
        >
          {t("취소")}
        </button>
        <button className="button-primary" type="submit" disabled={!note.trim()}>
          {t("코멘트 추가")}
        </button>
      </div>
    </form>
  );
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
      if (
        !isDeclinedConfirmation(error) &&
        gitRequestRef.current === request &&
        sessionIdRef.current === sessionId
      )
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
              onClick={() => void mutate(() => backend.pushChanges(session.id))}
            >
              Push
            </button>
          </div>
        </section>
      ) : (
        <p className="diff-empty">
          {t("Git 변경 작업은 Gajae managed worktree 세션에서만 사용할 수 있습니다.")} </p>
      )}
      {comments.length > 0 && (
        <section className="diff-review" aria-label={t("리뷰 코멘트")}>
          <header>
            <strong>{t`리뷰 코멘트 ${comments.length}개`}</strong>
            {onSubmitReview && (
              <button className="button-primary" type="button" onClick={sendReview}>
                {t("리뷰 보내기")}
              </button>
            )}
          </header>
          {comments.map((comment) => (
            <article key={comment.id} className="diff-review-card">
              <code className="diff-review-location">{reviewLocation(comment)}</code>
              <pre>{comment.excerpt}</pre>
              {editing?.id === comment.id ? (
                <>
                  <textarea
                    autoFocus
                    aria-label={t("코멘트 수정")}
                    value={editing.body}
                    onChange={(event) =>
                      setEditState({
                        sessionId: session.id,
                        value: { id: comment.id, body: event.target.value },
                      })
                    }
                  />
                  <div className="diff-review-actions">
                    <button
                      className="button-secondary"
                      type="button"
                      onClick={() => setEditState({ sessionId: session.id, value: null })}
                    >
                      {t("취소")}
                    </button>
                    <button
                      className="button-primary"
                      type="button"
                      disabled={!editing.body.trim()}
                      onClick={saveEdit}
                    >
                      {t("저장")}
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <p>{comment.body}</p>
                  <div className="diff-review-actions">
                    <button
                      className="button-secondary"
                      type="button"
                      onClick={() =>
                        setEditState({
                          sessionId: session.id,
                          value: { id: comment.id, body: comment.body },
                        })
                      }
                    >
                      {t("수정")}
                    </button>
                    <button
                      className="button-secondary"
                      type="button"
                      onClick={() =>
                        saveReviewComments(
                          session.id,
                          reviewComments(session.id).filter(
                            (entry) => entry.id !== comment.id,
                          ),
                        )
                      }
                    >
                      {t("삭제")}
                    </button>
                  </div>
                </>
              )}
            </article>
          ))}
        </section>
      )}
      {diff?.error && <p className="diff-error">{diff.error}</p>}
      {!loading && !diff?.error && (diff?.files.length ?? 0) === 0 && (
        <p className="diff-empty">{t("변경된 파일이 없습니다.")}</p>
      )}
      {parsedFiles.map((parsed) => (
        <details key={parsed.file.id} open>
          <summary>{parsed.file.path}</summary>
          <DiffFileLines
            parsed={parsed}
            selected={
              parsed === selectedFile && selectedAnchor && selectedRows
                ? [Math.min(...selectedRows), Math.max(...selectedRows)]
                : null
            }
            commented={commentedRows(parsed, comments)}
            onPick={(key, extend) => pickLine(parsed, key, extend)}
            form={parsed === selectedFile ? commentForm : null}
          />
        </details>
      ))}
    </aside>
  );
}
