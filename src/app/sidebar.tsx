import gajaeIconUrl from "../assets/gajae-icon.png";
import type { GjcUpdateStatus } from "../../shared/agent-contract";
import type { AgentSession, BackendConnection } from "../backend/types";
import {
  ArrowDown,
  Clock3,
  Command,
  GitFork,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Settings,
  Trash2,
} from "lucide-react";
import { useEffect, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { connectionStateLabel } from "./format";

export interface SessionRowProps {
  session: AgentSession;
  shortcutNumber?: number;
  selected: boolean;
  renaming: boolean;
  renameValue: string;
  onSelect: () => void;
  onContextMenu: (event: ReactMouseEvent) => void;
  onRenameChange: (value: string) => void;
  onRenameCommit: () => void;
  onRenameCancel: () => void;
}

export function SessionRow({
  session,
  shortcutNumber,
  selected,
  renaming,
  renameValue,
  onSelect,
  onContextMenu,
  onRenameChange,
  onRenameCommit,
  onRenameCancel,
}: SessionRowProps) {
  return (
    <div
      className={`session-row ${selected ? "is-selected" : ""}`}
      role="button"
      tabIndex={0}
      onClick={() => {
        if (!renaming) onSelect();
      }}
      onContextMenu={onContextMenu}
      onKeyDown={(event) => {
        if (!renaming && (event.key === "Enter" || event.key === " "))
          onSelect();
      }}
      aria-pressed={selected}
    >
      <span className="session-row__copy">
        <span className="session-row__topline">
          {renaming ? (
            <input
              className="session-rename-input"
              value={renameValue}
              autoFocus
              onChange={(event) => onRenameChange(event.target.value)}
              onClick={(event) => event.stopPropagation()}
              onBlur={onRenameCommit}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "Enter") onRenameCommit();
                if (event.key === "Escape") onRenameCancel();
              }}
            />
          ) : (
            <strong>{session.title}</strong>
          )}
          <span
            className={`session-state-badge session-state-badge--${session.phase === "compacting" ? "compacting" : session.status}`}
            aria-label={session.phase === "compacting" ? "압축 중" : undefined}
            title={session.phase === "compacting" ? "압축 중" : undefined}
          >
            {session.phase === "compacting"
              ? "압축 중"
              : session.status === "running"
                ? "진행 중"
                : session.status === "waiting"
                  ? "확인 대기"
                  : session.status === "failed"
                    ? "실패"
                    : session.status === "starting"
                      ? "시작 중"
                      : "완료"}
          </span>
          {session.usagePending ? (
            <span
              className="session-context-usage session-context-usage--pending"
              aria-label="컨텍스트 사용량 계산 중"
              title="컨텍스트 사용량 계산 중"
            >
              ?
            </span>
          ) : (
            session.usagePercent !== undefined && (
              <span className="session-context-usage">
                {session.usagePercent.toFixed(1)}%
              </span>
            )
          )}
          <time>{session.updatedAt}</time>
        </span>
        <span className="session-row__subtitle">
          <span
            className={`presence-inline presence-inline--${session.status}`}
          />
          {session.subtitle}
        </span>
      </span>
      <span className="session-row__meta">
        {shortcutNumber !== undefined && <kbd>⌘{shortcutNumber}</kbd>}
        {session.unread && <span className="unread-dot" aria-label="새 활동" />}
      </span>
    </div>
  );
}

export interface SidebarProps {
  sessions: AgentSession[];
  connection: BackendConnection;
  selectedId: string | null;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  onSearchOpen: () => void;
  onSelect: (sessionId: string) => void;
  onCreate: () => void;
  onFork: (session: AgentSession) => void;
  onRename: (sessionId: string, title: string) => void;
  onDelete: (session: AgentSession) => void;
  onSettings: () => void;
  workspaceLabel: string;
  onWorkspaceLabelChange: (label: string) => void;
  updateStatus: GjcUpdateStatus | null;
  updateBusy: boolean;
  onUpdate: () => void;
}

export function Sidebar({
  sessions,
  connection,
  selectedId,
  searchQuery,
  onSearchChange,
  onSearchOpen,
  onSelect,
  onCreate,
  onFork,
  onRename,
  onDelete,
  onSettings,
  workspaceLabel,
  onWorkspaceLabelChange,
  updateStatus,
  updateBusy,
  onUpdate,
}: SidebarProps) {
  const [contextMenu, setContextMenu] = useState<{
    session: AgentSession;
    x: number;
    y: number;
  } | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [editingWorkspace, setEditingWorkspace] = useState(false);
  const [workspaceValue, setWorkspaceValue] = useState(workspaceLabel);
  const pinned = sessions.filter((session) => session.pinned);
  const recent = sessions.filter((session) => !session.pinned);
  const shortcutNumbers = new Map(
    [...pinned, ...recent]
      .slice(0, 9)
      .map((session, index) => [session.id, index + 1]),
  );

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener("pointerdown", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("blur", close);
    };
  }, [contextMenu]);

  function beginRename(session: AgentSession): void {
    setContextMenu(null);
    setRenamingId(session.id);
    setRenameValue(session.title);
  }

  function commitRename(): void {
    if (!renamingId) return;
    const sessionId = renamingId;
    const value = renameValue.trim();
    setRenamingId(null);
    if (value) onRename(sessionId, value);
  }

  function commitWorkspaceName(): void {
    const value = workspaceValue.trim();
    setEditingWorkspace(false);
    if (value && value !== workspaceLabel) onWorkspaceLabelChange(value);
    else setWorkspaceValue(workspaceLabel);
  }

  function renderSession(session: AgentSession) {
    return (
      <SessionRow
        key={session.id}
        session={session}
        shortcutNumber={shortcutNumbers.get(session.id)}
        selected={session.id === selectedId}
        renaming={session.id === renamingId}
        renameValue={renameValue}
        onSelect={() => onSelect(session.id)}
        onContextMenu={(event) => {
          event.preventDefault();
          onSelect(session.id);
          setContextMenu({ session, x: event.clientX, y: event.clientY });
        }}
        onRenameChange={setRenameValue}
        onRenameCommit={commitRename}
        onRenameCancel={() => setRenamingId(null)}
      />
    );
  }

  return (
    <aside className="sidebar">
      <div className="window-drag-region" aria-hidden="true" />

      <div className="sidebar-actions">
        <label className="search-field">
          <Search size={15} />
          <input
            aria-label="세션 검색"
            placeholder="검색"
            value={searchQuery}
            onFocus={onSearchOpen}
            onChange={(event) => onSearchChange(event.target.value)}
          />
          <kbd>⌘K</kbd>
        </label>
        <button
          className="icon-button"
          type="button"
          title="새 Gajae 세션"
          onClick={onCreate}
        >
          <Plus size={18} />
        </button>
      </div>

      <div className="sidebar-scroll">
        {pinned.length > 0 && (
          <section className="session-section">
            <header>
              <span>고정됨</span>
              <MoreHorizontal size={15} />
            </header>
            {pinned.map(renderSession)}
          </section>
        )}

        {recent.length > 0 && (
          <section className="session-section">
            <header>
              <span>최근 세션</span>
              <Clock3 size={14} />
            </header>
            {recent.map(renderSession)}
          </section>
        )}

        {sessions.length === 0 && (
          <div className="sidebar-empty">
            <Search size={18} />
            <span>세션이 없습니다</span>
          </div>
        )}
      </div>

      <div className="sidebar-footer">
        <button type="button" onClick={onCreate}>
          <Command size={16} />
          <span>새 Gajae 세션</span>
        </button>
        <button type="button" onClick={onSettings}>
          <Settings size={16} />
          <span>설정</span>
        </button>
        <div
          className="profile-row"
          onDoubleClick={() => {
            setWorkspaceValue(workspaceLabel);
            setEditingWorkspace(true);
          }}
        >
          <span className="profile-avatar">
            <img src={gajaeIconUrl} alt="" />
          </span>
          <span>
            {editingWorkspace ? (
              <input
                className="workspace-name-input"
                value={workspaceValue}
                autoFocus
                onChange={(event) => setWorkspaceValue(event.target.value)}
                onBlur={commitWorkspaceName}
                onKeyDown={(event) => {
                  if (event.key === "Enter") commitWorkspaceName();
                  if (event.key === "Escape") {
                    setEditingWorkspace(false);
                    setWorkspaceValue(workspaceLabel);
                  }
                }}
              />
            ) : (
              <strong>{workspaceLabel}</strong>
            )}
            <small>
              {connection.label} · {connectionStateLabel(connection.state)}
            </small>
          </span>
          {!editingWorkspace && (
            <button
              type="button"
              className="workspace-rename-button"
              title="Workspace 이름 변경"
              onClick={() => {
                setWorkspaceValue(workspaceLabel);
                setEditingWorkspace(true);
              }}
            >
              <Pencil size={12} />
            </button>
          )}
          <span className="profile-actions">
            {updateStatus?.updateAvailable ? (
              <button
                type="button"
                className="profile-update-button"
                title={`GJC ${updateStatus.latestVersion} 업데이트`}
                disabled={updateBusy}
                onClick={onUpdate}
              >
                {updateBusy ? (
                  <span className="mini-spinner" />
                ) : (
                  <ArrowDown size={13} />
                )}
              </button>
            ) : (
              <span
                className={`connection-dot connection-dot--${connection.state}`}
                title={connection.detail}
              />
            )}
          </span>
        </div>
      </div>
      {contextMenu && (
        <div
          className="session-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            onClick={() => {
              setContextMenu(null);
              onFork(contextMenu.session);
            }}
          >
            <GitFork size={14} /> 현재 상태에서 포크
          </button>
          <button
            type="button"
            onClick={() => beginRename(contextMenu.session)}
          >
            <Pencil size={14} /> 이름 변경
          </button>
          <button
            type="button"
            className="is-danger"
            onClick={() => {
              setContextMenu(null);
              onDelete(contextMenu.session);
            }}
          >
            <Trash2 size={14} /> 삭제
          </button>
        </div>
      )}
    </aside>
  );
}
