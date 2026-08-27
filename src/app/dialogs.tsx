import type { GlobalSearchResult } from "../../shared/productivity-ipc";
import type { AgentSession } from "../backend/types";
import { FileSearch, FolderOpen, Plus, Search, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { FormEvent } from "react";

export interface NewSessionDialogProps {
  defaultWorkspace: string;
  onCancel: () => void;
  onCreate: (input: {
    title: string;
    workspace: string;
    isolation: "workspace" | "worktree";
    worktreeBranch?: string;
  }) => void;
}

export function NewSessionDialog({
  defaultWorkspace,
  onCancel,
  onCreate,
}: NewSessionDialogProps) {
  const [title, setTitle] = useState("새 Gajae 세션");
  const [workspace, setWorkspace] = useState(defaultWorkspace);
  const [isolation, setIsolation] = useState<"workspace" | "worktree">(
    "workspace",
  );
  const [worktreeBranch, setWorktreeBranch] = useState("");
  const [choosing, setChoosing] = useState(false);
  const settingsBridge = window.agentControlDesktop?.settings;

  async function chooseWorkspace(): Promise<void> {
    if (!settingsBridge) return;
    setChoosing(true);
    try {
      const selected = await settingsBridge.chooseWorkspace(workspace);
      if (selected) setWorkspace(selected);
    } finally {
      setChoosing(false);
    }
  }

  function submit(event: FormEvent): void {
    event.preventDefault();
    if (!workspace) return;
    onCreate({
      title: title.trim() || "새 Gajae 세션",
      workspace,
      isolation,
      worktreeBranch: worktreeBranch.trim() || undefined,
    });
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onCancel}>
      <form
        className="new-session-dialog"
        aria-label="새 GJC 세션"
        onSubmit={submit}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <span>
            <Plus size={18} />
          </span>
          <div>
            <h2>새 GJC 세션</h2>
            <p>Gajae가 확인하고 수정할 프로젝트를 선택하세요.</p>
          </div>
          <button className="icon-button" type="button" onClick={onCancel}>
            <X size={18} />
          </button>
        </header>
        <label>
          <span>세션 이름</span>
          <input
            autoFocus
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <fieldset className="isolation-options">
          <legend>작업 격리</legend>
          <label>
            <input
              type="radio"
              checked={isolation === "workspace"}
              onChange={() => setIsolation("workspace")}
            />{" "}
            현재 workspace에서 작업
          </label>
          <label>
            <input
              type="radio"
              checked={isolation === "worktree"}
              onChange={() => setIsolation("worktree")}
            />{" "}
            별도 worktree 생성
          </label>
          {isolation === "worktree" && (
            <input
              placeholder="안전한 브랜치 (선택)"
              value={worktreeBranch}
              onChange={(e) => setWorktreeBranch(e.target.value)}
            />
          )}
        </fieldset>
        <label>
          <span>프로젝트 위치</span>
          <div className="project-location-field">
            <FolderOpen size={17} />
            <code title={workspace}>
              {workspace || "프로젝트 폴더를 선택하세요"}
            </code>
            <button
              type="button"
              className="button-secondary"
              disabled={choosing}
              onClick={() => void chooseWorkspace()}
            >
              {choosing ? "선택 중…" : "선택…"}
            </button>
          </div>
        </label>
        <footer>
          <button type="button" className="button-secondary" onClick={onCancel}>
            취소
          </button>
          <button
            type="submit"
            className="button-primary"
            disabled={!workspace}
          >
            <Plus size={15} /> 세션 만들기
          </button>
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
        aria-label="세션 삭제"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <Trash2 size={18} />
          <h2>세션을 삭제할까요?</h2>
        </header>
        <p>
          <>
            <strong>{session.title}</strong> 세션의 GJC 프로세스를 종료하고 대화
            기록까지 삭제합니다. 목록에서만 숨기지 않습니다.
          </>
        </p>
        <footer>
          <button type="button" className="button-secondary" onClick={onCancel}>
            취소
          </button>
          <button type="button" className="button-danger" onClick={onConfirm}>
            삭제
          </button>
        </footer>
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
        aria-label="전체 대화 검색"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <Search size={18} />
          <input
            autoFocus
            value={query}
            placeholder="메시지, 파일, 도구 실행 검색"
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
              <strong>모든 Gajae 대화를 검색합니다</strong>
              <small>
                메시지, 계획, 도구 출력과 첨부 파일 내용을 찾을 수 있습니다.
              </small>
            </div>
          )}
          {loading && (
            <div className="global-search-empty">
              <span className="mini-spinner" />
              <small>대화 인덱스를 검색하는 중…</small>
            </div>
          )}
          {error && <p className="diff-error">{error}</p>}
          {!loading &&
            resolvedQuery === query.trim() &&
            query.trim() &&
            !error &&
            results.length === 0 && (
              <div className="global-search-empty">
                <strong>검색 결과가 없습니다</strong>
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
