import gajaeIconUrl from "../assets/gajae-icon-ui.png";
import type { GjcUpdateStatus } from "../../shared/agent-contract";
import type { AgentSession, BackendConnection } from "../backend/types";
import {
  ArrowDown,
  ExternalLink,
  EyeOff,
  FolderGit2,
  FolderOpen,
  GitFork,
  Layers,
  MoreHorizontal,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Settings,
  Trash2,
} from "lucide-react";
import { memo, useEffect, useMemo, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { connectionStateLabel, statusLabel } from "./format";
import { gjcVersionWarning } from "../../shared/gjc-version";
import { Dropdown } from "./primitives";
import { ALL_PROJECTS_ID } from "./project-model";
import type { ProjectGroup } from "./project-model";
import { sessionListModel } from "./sidebar-model";
import type {
  SessionFamilySummary,
  SessionGroupId,
  SessionRowNode,
} from "./sidebar-model";

/** What a closed family reports instead of the rows it is holding back. */
function familySummaryLabel(
  hidden: number,
  summary: SessionFamilySummary | null,
): string {
  const counts = [
    summary?.failed ? `Failed ${summary.failed}` : "",
    summary?.unread ? `Unread ${summary.unread}` : "",
    summary?.working ? `Working ${summary.working}` : "",
  ].filter(Boolean);
  return [`Fork ${hidden} hidden`, ...counts].join(" · ");
}

/**
 * The selector's rows: 전체 프로젝트 first, then one row per project.
 *
 * Two repositories can share a directory name, and a dropdown that showed two
 * identical labels could not be told apart, so a duplicated name carries the
 * parent directory that distinguishes it.
 */
export function projectSelectorOptions(projects: readonly ProjectGroup[]): {
  value: string;
  label: string;
}[] {
  const seen = new Map<string, number>();
  for (const project of projects)
    seen.set(project.name, (seen.get(project.name) ?? 0) + 1);
  return [
    { value: ALL_PROJECTS_ID, label: "전체 프로젝트" },
    ...projects.map((project) => ({
      value: project.id,
      label:
        (seen.get(project.name) ?? 0) > 1
          ? `${project.name} (${parentDirectoryName(project.root)})`
          : project.name,
    })),
  ];
}

/** The directory above a path, or the path itself when it has no parent. */
function parentDirectoryName(root: string): string {
  const parts = root.split("/").filter(Boolean);
  return parts.length > 1 ? parts[parts.length - 2]! : root;
}

/**
 * Escape belongs to whichever inline editor is open: it closes that field instead
 * of reaching the app-wide Escape handler, which would cancel the session running
 * under the field the user is still typing in.
 */
export function consumeEscapeKey(event: {
  key: string;
  preventDefault: () => void;
  stopPropagation: () => void;
}): boolean {
  if (event.key !== "Escape" && event.key !== "Esc") return false;
  event.preventDefault();
  event.stopPropagation();
  return true;
}

export interface SessionRowProps {
  session: AgentSession;
  shortcutNumber?: number;
  selected: boolean;
  renaming: boolean;
  renameValue: string;
  /** Nesting depth under a family head: 0 for a root row. */
  depth?: number;
  /** Set on a family head: the rows it is holding back while it is closed. */
  hidden?: number;
  hiddenSummary?: SessionFamilySummary | null;
  /** Set on a family head: opens and closes the forks under it. */
  familyOpen?: boolean;
  onToggleFamily?: () => void;
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
  depth = 0,
  hidden = 0,
  hiddenSummary = null,
  familyOpen,
  onToggleFamily,
  onSelect,
  onContextMenu,
  onRenameChange,
  onRenameCommit,
  onRenameCancel,
}: SessionRowProps) {
  const stateLabel = statusLabel(session.status, session.phase);
  return (
    <div
      className={`session-row ${selected ? "is-selected" : ""} ${
        depth > 0 ? "session-row--nested" : ""
      }`}
      role="button"
      tabIndex={0}
      data-depth={depth}
      onClick={() => {
        if (!renaming) onSelect();
      }}
      onContextMenu={onContextMenu}
      onKeyDown={(event) => {
        // A key that lands on a nested control belongs to that control: the family
        // disclosure has to toggle without also selecting the head it sits on, and
        // the rename input owns Enter and Escape while it is open.
        if (event.target !== event.currentTarget) return;
        if (event.key !== "Enter" && event.key !== " ") return;
        // The row is a div, so Space would scroll the list out from under the row
        // the user just picked.
        event.preventDefault();
        if (!renaming) onSelect();
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
                if (consumeEscapeKey(event)) onRenameCancel();
              }}
            />
          ) : (
            <strong>{session.title}</strong>
          )}
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
        <span className="session-row__subtitle">{session.subtitle}</span>
      </span>
      <span className="session-row__meta">
        {/* A fork is nested under the session it came from, and closing it has to
            leave the count of what it is holding back: the rows behind it can be
            working or unread without being on screen. */}
        {onToggleFamily && (
          <button
            type="button"
            className="session-family-toggle"
            aria-expanded={familyOpen}
            aria-label={familySummaryLabel(hidden, hiddenSummary)}
            title={familySummaryLabel(hidden, hiddenSummary)}
            onClick={(event) => {
              event.stopPropagation();
              onToggleFamily();
            }}
          >
            <span aria-hidden="true">{familyOpen ? "▾" : "▸"}</span>
            {hidden > 0 && <em>{hidden}</em>}
          </button>
        )}
        {/* The state used to sit between the title and the clock as a word, which
            pushed the title aside for something the group header already says. */}
        <span
          className={`session-state-dot session-state-dot--${session.phase === "compacting" ? "compacting" : session.status}`}
          role="img"
          aria-label={stateLabel}
          title={stateLabel}
        />
        {shortcutNumber !== undefined && <kbd>⌘{shortcutNumber}</kbd>}
        {/* The row being read is not news, and the main process clears the flag on
            selection anyway: without this the dot stayed up until that round trip
            landed and then vanished under the cursor. */}
        {session.unread && !selected && (
          <span className="unread-dot" aria-label="새 활동" />
        )}
      </span>
    </div>
  );
}

export interface SidebarProps {
  sessions: AgentSession[];
  connection: BackendConnection;
  selectedId: string | null;
  /** Every project the rail can filter by, in selector order. */
  projects: ProjectGroup[];
  /** The active selector value: `ALL_PROJECTS_ID` or a project root. */
  projectId: string;
  onProjectChange: (projectId: string) => void;
  /** Opens the repository screen; only offered for one selected project. */
  onOpenRepository: () => void;
  /** Opens the project list, which is what 전체 프로젝트 can offer instead. */
  onOpenProjects: () => void;
  /** Right-click helpers: the browsable GitHub page and the local folder. */
  onOpenProjectGithub: () => void;
  onOpenProjectFolder: () => void;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  onSearchOpen: () => void;
  onSelect: (sessionId: string) => void;
  onCreate: () => void;
  onFork: (session: AgentSession) => void;
  onResume: (session: AgentSession) => void;
  onResumePicker: () => void;
  onRename: (sessionId: string, title: string) => void;
  onDelete: (session: AgentSession) => void;
  onHide: (session: AgentSession) => void;
  onSettings: () => void;
  workspaceLabel: string;
  onWorkspaceLabelChange: (label: string) => void;
  updateStatus: GjcUpdateStatus | null;
  updateBusy: boolean;
  onUpdate: () => void;
}

/**
 * The session list.
 *
 * Memoized because a streamed transcript chunk changes state the shell owns, which
 * re-runs every child. Measured at 1.1-1.7ms per pass across 10 to 80 sessions, so
 * a forty-chunk reply was spending 43-66ms redrawing a list that had not changed.
 * The shell keeps every callback prop stable for this to hold.
 */
function SidebarView({
  sessions,
  connection,
  selectedId,
  projects,
  projectId,
  onProjectChange,
  onOpenRepository,
  onOpenProjects,
  onOpenProjectGithub,
  onOpenProjectFolder,
  searchQuery,
  onSearchChange,
  onSearchOpen,
  onSelect,
  onCreate,
  onFork,
  onResume,
  onResumePicker,
  onRename,
  onDelete,
  onHide,
  onSettings,
  workspaceLabel,
  onWorkspaceLabelChange,
  updateStatus,
  updateBusy,
  onUpdate,
}: SidebarProps) {
  const versionWarning = gjcVersionWarning(connection.version);
  const [contextMenu, setContextMenu] = useState<
    | { kind: "session"; session: AgentSession; x: number; y: number }
    | { kind: "project"; x: number; y: number }
    | null
  >(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [editingWorkspace, setEditingWorkspace] = useState(false);
  const [workspaceValue, setWorkspaceValue] = useState(workspaceLabel);
  const [expandedGroups, setExpandedGroups] = useState<
    ReadonlySet<SessionGroupId>
  >(() => new Set());
  // Forks are nested until the user closes them, so this holds the closed ones.
  const [collapsedFamilies, setCollapsedFamilies] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const model = useMemo(
    () =>
      sessionListModel(sessions, {
        expanded: expandedGroups,
        collapsedFamilies,
        selectedId,
      }),
    [sessions, expandedGroups, collapsedFamilies, selectedId],
  );
  // The digits the main process sends for ⌘1-⌘9 index the same list, so the numbers on
  // the rows have to come from the model rather than from a second reading of the
  // sessions array that could disagree with the rail.
  const shortcutNumbers = new Map(
    model.shortcuts.map((session, index) => [session.id, index + 1]),
  );

  function toggleGroup(id: SessionGroupId): void {
    setExpandedGroups((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleFamily(headId: string): void {
    setCollapsedFamilies((current) => {
      const next = new Set(current);
      if (next.has(headId)) next.delete(headId);
      else next.add(headId);
      return next;
    });
  }

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

  function renderNode(node: SessionRowNode) {
    const { session } = node;
    return (
      <SessionRow
        key={session.id}
        session={session}
        shortcutNumber={shortcutNumbers.get(session.id)}
        selected={session.id === selectedId}
        renaming={session.id === renamingId}
        renameValue={renameValue}
        depth={node.depth}
        hidden={node.hidden}
        hiddenSummary={node.hiddenSummary}
        familyOpen={!collapsedFamilies.has(session.id)}
        onToggleFamily={
          node.familyHead ? () => toggleFamily(session.id) : undefined
        }
        onSelect={() => onSelect(session.id)}
        onContextMenu={(event) => {
          event.preventDefault();
          onSelect(session.id);
          setContextMenu({
            kind: "session",
            session,
            x: event.clientX,
            y: event.clientY,
          });
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

      <div className="project-bar">
        <Dropdown
          value={projectId}
          options={projectSelectorOptions(projects)}
          onChange={onProjectChange}
          ariaLabel="프로젝트 선택"
        />
        {/* The repository entry point is offered for a chosen project and the
            project list for the whole rail. A single 레포 보기 in 전체 프로젝트
            would have to guess which repository to open. */}
        <button
          type="button"
          className="project-entry"
          title={
            projectId === ALL_PROJECTS_ID
              ? "프로젝트 목록"
              : "선택한 프로젝트의 레포 보기"
          }
          onClick={
            projectId === ALL_PROJECTS_ID ? onOpenProjects : onOpenRepository
          }
          // Right-click only carries the auxiliary actions; the repository
          // screen itself stays on the button above. In 전체 프로젝트 there is no
          // single project to point these at, so the menu is not offered.
          onContextMenu={
            projectId === ALL_PROJECTS_ID
              ? undefined
              : (event) => {
                  event.preventDefault();
                  setContextMenu({
                    kind: "project",
                    x: event.clientX,
                    y: event.clientY,
                  });
                }
          }
        >
          {projectId === ALL_PROJECTS_ID ? (
            <Layers size={15} />
          ) : (
            <FolderGit2 size={15} />
          )}
          <span>
            {projectId === ALL_PROJECTS_ID ? "프로젝트 목록" : "레포 보기"}
          </span>
        </button>
      </div>

      <div className="sidebar-scroll">
        {model.pinned.length > 0 && (
          <section className="session-section">
            <header>
              <span>고정됨</span>
              <MoreHorizontal size={15} />
            </header>
            {model.pinned.map(renderNode)}
          </section>
        )}

        {model.groups.map((group) => (
          <section className="session-section" key={group.id}>
            <header>
              <span>{group.label}</span>
            </header>
            {group.rows.map(renderNode)}
            {group.overflow > 0 && (
              <button
                type="button"
                className="session-more"
                onClick={() => toggleGroup(group.id)}
              >
                {expandedGroups.has(group.id)
                  ? "접기"
                  : `더 보기 (${group.overflow})`}
              </button>
            )}
          </section>
        ))}

        {sessions.length === 0 && (
          <div className="sidebar-empty">
            <Search size={18} />
            {/* Which way to get out depends on why the list is empty: a project
                with no sessions is a filter to widen, not a missing session. */}
            <span>
              {projectId === ALL_PROJECTS_ID
                ? "세션이 없습니다"
                : "이 프로젝트에 세션이 없습니다"}
            </span>
            {projectId === ALL_PROJECTS_ID ? (
              <button type="button" onClick={onResumePicker}>
                지난 세션 여기
              </button>
            ) : (
              <button
                type="button"
                onClick={() => onProjectChange(ALL_PROJECTS_ID)}
              >
                전체 프로젝트 보기
              </button>
            )}
          </div>
        )}
      </div>

      <div className="sidebar-footer">
        {/* The title is what the narrow rail leans on: it hides footer labels, so
            without it this button becomes an unlabelled icon. */}
        <button
          type="button"
          title="지난 세션 이어서 진행"
          onClick={onResumePicker}
        >
          <RotateCcw size={16} />
          <span>지난 세션 이어서 진행</span>
        </button>
        <button type="button" title="설정" onClick={onSettings}>
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
                  if (consumeEscapeKey(event)) {
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
        {versionWarning && (
          <div className="gjc-version-warning" role="alert">
            {versionWarning}
          </div>
        )}
      </div>
      {contextMenu && (
        <div
          className="session-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {contextMenu.kind === "project" ? (
            <>
              <button
                type="button"
                onClick={() => {
                  setContextMenu(null);
                  onOpenProjectGithub();
                }}
              >
                <ExternalLink size={14} /> GitHub에서 열기
              </button>
              <button
                type="button"
                onClick={() => {
                  setContextMenu(null);
                  onOpenProjectFolder();
                }}
              >
                <FolderOpen size={14} /> 로컬 폴더 열기
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => {
                  setContextMenu(null);
                  onFork(contextMenu.session);
                }}
              >
                <GitFork size={14} /> 현재 상태에서 포크
              </button>
              {contextMenu.session.attachment !== "attached" && (
                <button
                  type="button"
                  onClick={() => {
                    const session = contextMenu.session;
                    setContextMenu(null);
                    onResume(session);
                  }}
                >
                  <RotateCcw size={14} /> 세션 이어서 진행
                </button>
              )}
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
              {/* gjc/0.18.12 cannot delete saved history through the public SDK, so
                  the only removal that actually completes is hiding the row here.
                  It is a separate item, not a silent substitute: the label says the
                  history stays. */}
              <button
                type="button"
                onClick={() => {
                  setContextMenu(null);
                  onHide(contextMenu.session);
                }}
              >
                <EyeOff size={14} /> 목록에서 숨기기
              </button>
            </>
          )}
        </div>
      )}
    </aside>
  );
}

export const Sidebar = memo(SidebarView);
