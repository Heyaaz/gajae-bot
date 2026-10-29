import type { GlobalSearchResult } from "../../shared/productivity-ipc";
import type {
  HistorySession,
  ImageAttachment,
  SessionWorkLink,
  WorktreePull,
} from "../../shared/agent-contract";
import type { NewSessionPrefill } from "../../shared/settings-ipc";
import type { AgentSession } from "../backend/types";
import {
  FileSearch,
  FolderOpen,
  Plus,
  RotateCcw,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { t } from "../i18n";
import { sessionTitleText } from "./format";


export interface NewSessionInput {
  title: string;
  workspace: string;
  isolation?: "workspace" | "worktree";
  worktreeBranch?: string;
  worktreeBranchExisting?: boolean;
  worktreePull?: WorktreePull;
  workLink?: SessionWorkLink;
  initialPrompt?: string;
  initialImages?: ImageAttachment[];
}

export interface NewSessionDialogProps {
  defaultWorkspace: string;
  prefill?: NewSessionPrefill;
  onCancel: () => void;
  onCreate: (input: NewSessionInput) => void;
}

export function NewSessionDialog({
  defaultWorkspace,
  prefill,
  onCancel,
  onCreate,
}: NewSessionDialogProps) {
  const defaultTitle = t("새 Gajae 세션");
  const [title, setTitle] = useState(prefill?.title || defaultTitle);
  const [workspace, setWorkspace] = useState(
    prefill?.workspace || defaultWorkspace,
  );
  const [isolation, setIsolation] = useState<"workspace" | "worktree">(
    prefill?.isolation ?? "workspace",
  );
  const [worktreeBranch, setWorktreeBranch] = useState(
    prefill?.worktreeBranch ?? "",
  );
  const [prompt, setPrompt] = useState(prefill?.prompt ?? "");
  const [choosing, setChoosing] = useState(false);
  const [workspaceError, setWorkspaceError] = useState("");
  const settingsBridge = window.agentControlDesktop?.settings;
  const images = prefill?.images ?? [];

  function cancel(): void {
    // The images were issued to this window for the new session; a dismissed
    // dialog gives them back instead of leaving them to expire.
    const tokens = images.flatMap((image) => (image.token ? [image.token] : []));
    if (tokens.length > 0)
      void settingsBridge?.discardAttachments(tokens).catch(() => undefined);
    onCancel();
  }

  async function chooseWorkspace(): Promise<void> {
    if (!settingsBridge) return;
    setChoosing(true);
    setWorkspaceError("");
    try {
      const selected = await settingsBridge.chooseWorkspace(workspace);
      if (selected) setWorkspace(selected);
    } catch (error) {
      setWorkspaceError(
        t(error instanceof Error ? error.message : String(error)),
      );
    } finally {
      setChoosing(false);
    }
  }

  function submit(event: FormEvent): void {
    event.preventDefault();
    if (!workspace) return;
    const trimmedTitle = title.trim();
    const branch = worktreeBranch.trim() || undefined;
    const suggestedBranch =
      isolation === "worktree" && branch === prefill?.worktreeBranch;
    onCreate({
      title:
        !trimmedTitle || trimmedTitle === defaultTitle
          ? "새 Gajae 세션"
          : trimmedTitle,
      workspace,
      isolation,
      worktreeBranch: branch,
      // The requirement and the fetch belong to the branch that was suggested; a
      // name the user typed instead may be a new branch.
      ...(prefill?.worktreeBranchExisting && suggestedBranch
        ? { worktreeBranchExisting: true }
        : {}),
      ...(prefill?.worktreePull && suggestedBranch
        ? { worktreePull: prefill.worktreePull }
        : {}),
      ...(prefill?.workLink ? { workLink: prefill.workLink } : {}),
      initialPrompt: prompt.trim() || undefined,
      initialImages: images.length > 0 ? images : undefined,
    });
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={cancel}>
      <form
        className="new-session-dialog"
        aria-label={t("새 GJC 세션")}
        onSubmit={submit}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <span>
            <Plus size={18} />
          </span>
          <div>
            <h2>{t("새 GJC 세션")}</h2>
            <p>{t("Gajae가 확인하고 수정할 프로젝트를 선택하세요.")}</p>
          </div>
          <button className="icon-button" type="button" onClick={cancel}>
            <X size={18} />
          </button>
        </header>
        <label>
          <span>{t("세션 이름")}</span>
          <input
            autoFocus
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <fieldset className="isolation-options">
          <legend>{t("작업 격리")}</legend>
          <label>
            <input
              type="radio"
              checked={isolation === "workspace"}
              onChange={() => setIsolation("workspace")}
            />{" "}
            {t("현재 workspace에서 작업")} </label>
          <label>
            <input
              type="radio"
              checked={isolation === "worktree"}
              onChange={() => setIsolation("worktree")}
            />{" "}
            {t("별도 worktree 생성")} </label>
          {isolation === "worktree" && (
            <input
              placeholder={t("안전한 브랜치 (선택)")}
              value={worktreeBranch}
              onChange={(e) => setWorktreeBranch(e.target.value)}
            />
          )}
          {prefill?.mainCheckout &&
            isolation === "workspace" &&
            workspace === prefill.workspace && (
              <p className="isolation-options__note">
                {t("이 폴더는 저장소의 기본 작업 폴더입니다. 커밋하지 않은 변경이 있으면 세션의 수정과 섞입니다. 따로 두려면 별도 worktree를 고르세요.")}
              </p>
            )}
        </fieldset>
        <label>
          <span>{t("프로젝트 위치")}</span>
          <div className="project-location-field">
            <FolderOpen size={17} />
            <code title={workspace}>
              {workspace || t("프로젝트 폴더를 선택하세요")}
            </code>
            <button
              type="button"
              className="button-secondary"
              disabled={choosing}
              onClick={() => void chooseWorkspace()}
            >
              {choosing ? t("선택 중…") : t("선택…")}
            </button>
          </div>
        </label>
        {workspaceError && <p role="alert">{workspaceError}</p>}
        <label>
          <span>{t("첫 요청")}</span>
          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
          />
          <small>
            {t("세션이 만들어지면 입력창에 채워 둡니다. 보내기 전에 고칠 수 있습니다.")}
          </small>
        </label>
        {images.length > 0 && (
          <div className="composer-images new-session-images">
            {images.map((image) => (
              <span key={image.id}>
                <img
                  src={`data:${image.mimeType};base64,${image.data}`}
                  alt={image.name}
                />
              </span>
            ))}
          </div>
        )}
        <footer>
          <button type="button" className="button-secondary" onClick={cancel}>
            {t("취소")} </button>
          <button
            type="submit"
            className="button-primary"
            disabled={!workspace}
          >
            <Plus size={15} /> {t("세션 만들기")} </button>
        </footer>
      </form>
    </div>
  );
}

export interface DeleteSessionDialogProps {
  session: AgentSession;
  onCancel: () => void;
  onConfirm: () => void;
}

export function DeleteSessionDialog({
  session,
  onCancel,
  onConfirm,
}: DeleteSessionDialogProps) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onCancel}>
      <section
        className="confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-label={t("세션 삭제")}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <Trash2 size={18} />
          <h2>{t("세션을 삭제할까요?")}</h2>
        </header>
        <p>
          <>
            <strong>{sessionTitleText(session.title)}</strong> {t("세션의 GJC 프로세스를 종료하고 대화 기록까지 삭제합니다. 목록에서만 숨기지 않습니다.")} </>
        </p>
        <footer>
          <button type="button" className="button-secondary" onClick={onCancel}>
            {t("취소")} </button>
          <button type="button" className="button-danger" onClick={onConfirm}>
            {t("삭제")} </button>
        </footer>
      </section>
    </div>
  );
}

// A session title is the whole first request, which runs to hundreds of
// characters. The row is one line, so it is cut to something readable rather
// than left to overflow the dialog.
export function sessionSummaryLine(title: string, limit = 72): string {
  const value = title.replace(/\s+/gu, " ").trim();
  return value.length > limit ? `${value.slice(0, limit - 1).trimEnd()}\u2026` : value;
}

// The full path is rarely the useful part; the project folder is.
export function workspaceLabelFor(workspace: string): string {
  const trimmed = workspace.replace(/\/+$/u, "");
  if (!trimmed) return "";
  const parts = trimmed.split("/").filter(Boolean);
  return parts.length <= 2 ? trimmed : `…/${parts.slice(-2).join("/")}`;
}

/**
 * Past sessions on disk, the way `gjc --resume` offers them in a terminal.
 *
 * The sidebar only lists sessions the broker still reports as live, so anything
 * older is unreachable from the window without this.
 */
const HISTORY_PAGE_SIZE = 100;

export function ResumeSessionDialog({
  sessions,
  loading,
  error,
  busyId,
  onClose,
  onOpen,
}: {
  sessions: HistorySession[];
  loading: boolean;
  error: string;
  busyId: string | null;
  onClose: () => void;
  onOpen: (sessionId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState(HISTORY_PAGE_SIZE);
  const value = query.trim().toLowerCase();
  // An id prefix is how the CLI addresses a session, so it is matched too.
  const visible = value
    ? sessions.filter(
        (session) =>
          session.id.toLowerCase().startsWith(value) ||
          session.title.toLowerCase().includes(value) ||
          session.workspace.toLowerCase().includes(value),
      )
    : sessions;
  // The list is no longer capped, but rendering thousands of rows at once is not
  // free. Newest rows render first and the rest arrive a page at a time; search
  // still looks at every session, not only the rendered page.
  useEffect(() => {
    setShown(HISTORY_PAGE_SIZE);
  }, [sessions, value]);
  const rendered = visible.slice(0, shown);
  // A fork is named where it sits: the list is ordered by recency, so moving a fork
  // under a source that may be hundreds of rows down would hide it instead of
  // showing what it is. The source is named when the same window lists it.
  const titlesById = new Map(visible.map((session) => [session.id, sessionTitleText(session.title)]));
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="resume-session-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t("지난 세션 이어서 진행")}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <RotateCcw size={16} />
          <input
            autoFocus
            value={query}
            placeholder={t("세션 ID, 제목, 폴더로 찾기")}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") onClose();
            }}
          />
          <button className="icon-button" type="button" onClick={onClose}>
            <X size={16} />
          </button>
        </header>
        <div className="resume-session-list">
          {loading && (
            <div className="global-search-empty">
              <span className="mini-spinner" />
              <small>{t("세션 기록을 읽는 중…")}</small>
            </div>
          )}
          {error && <p className="diff-error">{error}</p>}
          {!loading && !error && visible.length === 0 && (
            <div className="global-search-empty">
              <strong>{t("이어서 진행할 세션이 없습니다")}</strong>
            </div>
          )}
          {rendered.map((session) => (
            <button
              type="button"
              key={session.id}
              disabled={busyId !== null}
              onClick={() => onOpen(session.id)}
            >
              <span className="resume-session-head">
                <strong>{sessionSummaryLine(sessionTitleText(session.title))}</strong>
                {session.live && <em className="resume-live">{t("진행 중")}</em>}
                {session.parentId && (
                  <em
                    className="resume-fork"
                    title={
                      titlesById.get(session.parentId)
                        ? t`${titlesById.get(session.parentId)}에서 포크`
                        : t`포크: ${session.parentId}`
                    }
                  >
                    {t("포크")} </em>
                )}
              </span>
              <small>
                {workspaceLabelFor(session.workspace) || t("폴더 정보 없음")}
              </small>
              <span className="resume-session-meta">
                {/* 8 chars collide across real sessions; 12 is unambiguous. */}
                <code>{session.id.slice(0, 12)}</code>
                <time>{session.updatedAt}</time>
                <small>{session.messageCount}{t("개 대화")}</small>
                {busyId === session.id && <span className="mini-spinner" />}
              </span>
            </button>
          ))}
          {visible.length > rendered.length && (
            <button
              type="button"
              className="resume-session-more"
              onClick={() => setShown((current) => current + HISTORY_PAGE_SIZE)}
            >
              {t("더 보기 (")}{visible.length - rendered.length})
            </button>
          )}
        </div>
      </section>
    </div>
  );
}

export function GlobalSearchDialog({
  query,
  onQueryChange,
  onClose,
  onPick,
}: {
  query: string;
  onQueryChange: (value: string) => void;
  onClose: () => void;
  onPick: (result: GlobalSearchResult) => void;
}) {
  const [results, setResults] = useState<GlobalSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [resolvedQuery, setResolvedQuery] = useState("");

  useEffect(() => {
    const bridge = window.agentControlDesktop?.productivity;
    const value = query.trim();
    if (!bridge || !value) {
      queueMicrotask(() => {
        setLoading(false);
        setResults([]);
        setResolvedQuery("");
      });
      return;
    }
    let active = true;
    const timer = window.setTimeout(() => {
      setLoading(true);
      setError("");
      void bridge
        .searchTranscripts(value, 40)
        .then((hits) => {
          if (active) {
            setResults(hits);
            setResolvedQuery(value);
          }
        })
        .catch((reason) => {
          if (active)
            setError(reason instanceof Error ? reason.message : String(reason));
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    }, 180);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [query]);

  return (
    <div
      className="modal-backdrop global-search-backdrop"
      role="presentation"
      onMouseDown={onClose}
    >
      <section
        className="global-search-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t("전체 대화 검색")}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <Search size={18} />
          <input
            autoFocus
            value={query}
            placeholder={t("메시지, 파일, 도구 실행 검색")}
            onChange={(event) => onQueryChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") onClose();
            }}
          />
          <kbd>ESC</kbd>
        </header>
        <div className="global-search-results">
          {!query.trim() && (
            <div className="global-search-empty">
              <FileSearch size={24} />
              <strong>{t("모든 Gajae 대화를 검색합니다")}</strong>
              <small>
                {t("메시지, 계획, 도구 출력과 첨부 파일 내용을 찾을 수 있습니다.")} </small>
            </div>
          )}
          {loading && (
            <div className="global-search-empty">
              <span className="mini-spinner" />
              <small>{t("대화 인덱스를 검색하는 중…")}</small>
            </div>
          )}
          {error && <p className="diff-error">{error}</p>}
          {!loading &&
            resolvedQuery === query.trim() &&
            query.trim() &&
            !error &&
            results.length === 0 && (
              <div className="global-search-empty">
                <strong>{t("검색 결과가 없습니다")}</strong>
              </div>
            )}
          {!loading &&
            resolvedQuery === query.trim() &&
            results.map((result) => (
              <button
                type="button"
                key={`${result.sessionId}-${result.itemId}`}
                onClick={() => onPick(result)}
              >
                <span>
                  <strong>{result.sessionTitle}</strong>
                  <small>{result.workspace}</small>
                </span>
                <p>{result.snippet || result.displayText}</p>
                <code>{result.kind}</code>
              </button>
            ))}
        </div>
      </section>
    </div>
  );
}
