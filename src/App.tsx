import {
  ArrowDown,
  ArrowUp,
  Brain,
  CalendarClock,
  Check,
  ChevronDown,
  CircleStop,
  Clock3,
  Command,
  Shrink,
  ExternalLink,
  FileSearch,
  FolderOpen,
  FolderGit2,
  GitBranch,
  GitFork,
  ListChecks,
  MoreHorizontal,
  PanelRight,
  Paperclip,
  Pencil,
  Play,
  Plus,
  Search,
  Settings,
  ShieldCheck,
  TerminalSquare,
  Target,
  Trash2,
  X,
  Copy,
} from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import gajaeIconUrl from "./assets/gajae-icon.png";
import { useAgentBackend } from "./backend/use-agent-backend";
import type { AgentBackend } from "./backend/agent-backend";
import {
  compactToolCommand,
  compactToolText,
  resolveModelPreset,
  composerQueuePreview,
  type PendingRequest,
  appendPendingRequest,
  nextRequestToRelease,
  withoutReleasedRequest,
} from "./composer-utils";
import {
  cacheTranscript,
  copyableMessageText,
  groupTranscriptItems,
  initialSessionId,
  isNearTranscriptBottom,
  mergeDiscoveredSessions,
  orderedSessionsForShortcuts,
  recentUserRequests,
  updateTranscriptItem,
} from "./transcript-utils";
import type {
  AgentControlPreferences,
  AgentCommand,
  AgentConfigOption,
  AgentEvent,
  AgentSession,
  BackendConnection,
  ImageAttachment,
  MessageInput,
  ToolActivity,
  TranscriptItem,
} from "./backend/types";
import type {
  ArtifactContent,
  DiffSnapshot,
  GeneratedFilePreview,
  ManagementSnapshot,
  FileAttachment,
  ManagementDesktopBridge,
  McpServerInput,
  GitStatusSnapshot,
  GjcUpdateStatus,
  GoalOperation,
  GoalSnapshot,
  MessageDelivery,
  SubagentSnapshot,
} from "../shared/agent-contract";
import type {
  GlobalSearchResult,
  LinkPreview,
} from "../shared/productivity-ipc";
import type {
  Automation,
  AutomationInput,
  AutomationRun,
} from "../shared/automation-ipc";
import "./App.css";

const EMPTY_TRANSCRIPT: TranscriptItem[] = [];

function humanErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (
    /\b(?:operation[ _-]?aborted|operation[ _-]?cancelled|operation[ _-]?canceled|aborterror|request aborted)\b/iu.test(
      message,
    )
  )
    return "작업이 취소되었습니다.";
  if (
    /uncertain_after_send|SDK request outcome is uncertain after the frame was sent/iu.test(
      message,
    )
  )
    return "작업이 이미 전달됐는지 확인하지 못했습니다. 채팅을 확인하세요.";
  return message;
}

function humanRuntimeText(value: string): string {
  return /^\s*(?:error:\s*)?(?:operation[ _-]?aborted|operation[ _-]?cancelled|operation[ _-]?canceled)\.?\s*$/iu.test(
    value,
  )
    ? "작업이 취소되었습니다."
    : value;
}
const HTTP_URL_PATTERN = /https?:\/\/[^\s<>"')\]]+/giu;

function httpUrls(value: string, limit = 3): string[] {
  return [...new Set(value.match(HTTP_URL_PATTERN) ?? [])].slice(0, limit);
}

function LinkPreviewCard({
  url,
  compact = false,
}: {
  url: string;
  compact?: boolean;
}) {
  const [preview, setPreview] = useState<LinkPreview | null>(null);

  useEffect(() => {
    const bridge = window.agentControlDesktop?.productivity;
    if (!bridge) return;
    let active = true;
    const timer = window.setTimeout(
      () => {
        void bridge
          .previewLink(url)
          .then((value) => {
            if (active) setPreview(value);
          })
          .catch(() => undefined);
      },
      compact ? 350 : 0,
    );
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [compact, url]);

  if (!preview) return null;
  return (
    <a
      className={`link-preview ${compact ? "link-preview--compact" : ""}`}
      href={preview.url}
      target="_blank"
      rel="noreferrer"
    >
      <span>
        <strong>{preview.title}</strong>
        {preview.description && <small>{preview.description}</small>}
        <code>{preview.siteName || new URL(preview.url).hostname}</code>
      </span>
      <ExternalLink size={14} />
    </a>
  );
}
const BUNDLED_GJC_COMMANDS: AgentCommand[] = [
  {
    name: "steer",
    description: "대기 중인 지시를 지금 실행 (빈 Enter와 같음)",
    hint: "[지시]",
  },
  {
    name: "queue",
    description: "현재 작업 다음에 실행할 후속 작업 예약",
    hint: "[요청]",
  },
  { name: "abort", description: "진행 중인 작업 중단" },
  { name: "compact", description: "현재 세션 context 압축" },
  { name: "new", description: "이 workspace에서 새 세션 시작" },
  { name: "model", description: "세션 모델 프로필 선택" },
  { name: "effort", description: "추론 effort 변경 (단축키: ⇧⇥)" },
  {
    name: "skill:deep-interview",
    description: "요구사항을 구체화하고 구현 가능한 명세 작성",
    hint: "[요청]",
  },
  {
    name: "skill:ralplan",
    description: "검토된 합의형 구현 계획 작성",
    hint: "[요청]",
  },
  {
    name: "skill:ultragoal",
    description: "목표를 기준으로 구현하고 검증",
    hint: "[요청]",
  },
  {
    name: "skill:autoresearch",
    description: "목표 중심 리서치 실행",
    hint: "[요청]",
  },
];

function statusLabel(status: AgentSession["status"], phase?: string): string {
  if (phase === "compacting") return "압축 중";
  if (status === "starting") return "시작 중";
  if (status === "running") return "작업 중";
  if (status === "waiting") return "확인 필요";
  if (status === "failed") return "실패";
  return "대기 중";
}

function connectionStateLabel(state: BackendConnection["state"]): string {
  if (state === "connected") return "연결됨";
  if (state === "connecting") return "연결 중";
  if (state === "error") return "오류";
  return "연결 끊김";
}

function directoryName(value: string): string {
  return value.split("/").filter(Boolean).at(-1) ?? (value || "Workspace");
}

function profileFromDetail(detail: string): string {
  return detail.match(/ACP connected · (.+)$/u)?.[1]?.trim() || "codex-medium";
}

interface SessionRowProps {
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

function SessionRow({
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

interface SidebarProps {
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

function Sidebar({
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

interface TranscriptProps {
  items: TranscriptItem[];
  compacting?: boolean;
  revealItemId?: string;
  onRevealComplete?: (itemId: string) => void;
  onResolveTool: (toolId: string, optionId: string) => void;
  onReadArtifact?: (artifactId: string) => Promise<ArtifactContent>;
  onPreviewFile?: (path: string) => Promise<GeneratedFilePreview>;
}

function Transcript({
  items,
  compacting = false,
  revealItemId,
  onRevealComplete,
  onResolveTool,
  onReadArtifact,
  onPreviewFile,
}: TranscriptProps) {
  const endRef = useRef<HTMLDivElement>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(true);
  const [following, setFollowing] = useState(true);

  useEffect(() => {
    if (!followingRef.current) return;
    const frame = requestAnimationFrame(() => {
      const transcript = transcriptRef.current;
      if (!transcript) return;
      transcript.scrollTop = transcript.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [items]);

  useEffect(() => {
    if (!revealItemId || !items.some((item) => item.id === revealItemId))
      return;
    const frame = requestAnimationFrame(() => {
      const target = document.getElementById(
        `transcript-${encodeURIComponent(revealItemId)}`,
      );
      target?.scrollIntoView({ block: "center", behavior: "smooth" });
      target?.classList.add("is-search-reveal");
      window.setTimeout(
        () => target?.classList.remove("is-search-reveal"),
        2200,
      );
      onRevealComplete?.(revealItemId);
    });
    return () => cancelAnimationFrame(frame);
  }, [items, onRevealComplete, revealItemId]);

  function updateScrollFollowing(): void {
    const transcript = transcriptRef.current;
    if (!transcript) return;
    const nearBottom = isNearTranscriptBottom(
      transcript.scrollHeight,
      transcript.scrollTop,
      transcript.clientHeight,
    );
    followingRef.current = nearBottom;
    setFollowing(nearBottom);
  }

  function scrollToLatest(): void {
    followingRef.current = true;
    setFollowing(true);
    const transcript = transcriptRef.current;
    if (!transcript) return;
    transcript.scrollTo({ top: transcript.scrollHeight, behavior: "smooth" });
  }

  if (items.length === 0 && !compacting) {
    return (
      <div className="empty-conversation">
        <span className="empty-conversation__mark">
          <img src={gajaeIconUrl} alt="" />
        </span>
        <h2>Gajae에게 어떤 작업을 맡길까요?</h2>
      </div>
    );
  }

  return (
    <div
      className="transcript"
      aria-live="polite"
      ref={transcriptRef}
      onScroll={updateScrollFollowing}
    >
      <div className="transcript-column">
        {groupTranscriptItems(items).map((block) =>
          block.kind === "item" ? (
            <div
              className="transcript-entry"
              id={`transcript-${encodeURIComponent(block.item.id)}`}
              key={block.id}
            >
              <TranscriptItemView
                item={block.item}
                onResolveTool={onResolveTool}
                onReadArtifact={onReadArtifact}
                onPreviewFile={onPreviewFile}
              />
            </div>
          ) : (
            <div className="transcript-entry tool-run" key={block.id}>
              {block.items.map((tool) => (
                <div
                  className="tool-run-entry"
                  id={`transcript-${encodeURIComponent(tool.id)}`}
                  key={tool.id}
                >
                  <TranscriptItemView
                    item={tool}
                    onResolveTool={onResolveTool}
                    onReadArtifact={onReadArtifact}
                    onPreviewFile={onPreviewFile}
                  />
                </div>
              ))}
            </div>
          ),
        )}
        {compacting && (
          <article className="compaction-card compaction-card--progress">
            <header>
              <Shrink size={15} />
              <strong>compaction</strong>
              <span>압축 중</span>
            </header>
            <p className="compaction-progress">
              <span className="mini-spinner" />
              세션 context를 압축하고 있습니다
            </p>
          </article>
        )}
        <div ref={endRef} />
      </div>
      {!following && (
        <button
          className="scroll-to-latest"
          type="button"
          onClick={scrollToLatest}
        >
          최신 내용으로
        </button>
      )}
    </div>
  );
}

function CompactionCard({
  item,
}: {
  item: Extract<TranscriptItem, { kind: "compaction" }>;
}) {
  const [expanded, setExpanded] = useState(false);
  const tokens = item.tokensBefore.toLocaleString("en-US");
  const preview = item.shortSummary || item.summary;
  return (
    <article className={`compaction-card ${expanded ? "is-expanded" : ""}`}>
      <header>
        <Shrink size={15} />
        <strong>compaction</strong>
        <span>{tokens} 토큰에서 압축됨</span>
      </header>
      <button
        type="button"
        className="compaction-toggle"
        onClick={() => setExpanded((value) => !value)}
      >
        {expanded ? "요약 접기" : "요약 펼치기"}
      </button>
      {expanded ? (
        <div className="compaction-summary markdown-body">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {item.summary}
          </ReactMarkdown>
        </div>
      ) : (
        preview && (
          <div className="compaction-short markdown-body">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{preview}</ReactMarkdown>
          </div>
        )
      )}
    </article>
  );
}

function BranchSummaryCard({
  item,
}: {
  item: Extract<TranscriptItem, { kind: "branch_summary" }>;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <article className={`compaction-card ${expanded ? "is-expanded" : ""}`}>
      <header>
        <GitFork size={15} />
        <strong>branch</strong>
        <span>분기 요약</span>
      </header>
      <button
        type="button"
        className="compaction-toggle"
        onClick={() => setExpanded((value) => !value)}
      >
        {expanded ? "요약 접기" : "요약 펼치기"}
      </button>
      {expanded && (
        <div className="compaction-summary markdown-body">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {item.summary}
          </ReactMarkdown>
        </div>
      )}
    </article>
  );
}

function SystemNoticeCard({
  item,
}: {
  item: Extract<TranscriptItem, { kind: "system" }>;
}) {
  const [expanded, setExpanded] = useState(false);
  const preview = item.content.split("\n").slice(0, 4).join("\n");
  const truncated = item.content !== preview;
  return (
    <article className="system-card">
      <header>
        <TerminalSquare size={15} />
        <strong>{item.title}</strong>
      </header>
      <div className="system-card-body markdown-body">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>
          {expanded ? item.content : preview}
        </ReactMarkdown>
      </div>
      {truncated && (
        <button
          type="button"
          className="compaction-toggle"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "접기" : "더 보기"}
        </button>
      )}
    </article>
  );
}

function ThoughtCard({
  item,
}: {
  item: Extract<TranscriptItem, { kind: "thought" }>;
}) {
  const [expanded, setExpanded] = useState(false);
  const open = item.streaming || expanded;
  return (
    <article className={`thought-card ${item.streaming ? "is-streaming" : ""}`}>
      <header>
        <Brain size={15} />
        <strong>Gajae</strong>
        <span>{item.streaming ? "생각 중…" : "추론"}</span>
        {item.streaming && <span className="mini-spinner" />}
        {!item.streaming && (
          <button
            type="button"
            className="thought-toggle"
            onClick={() => setExpanded((value) => !value)}
          >
            {open ? "접기" : "펼치기"}
          </button>
        )}
      </header>
      {open && (
        <div
          className={`thought-content ${item.streaming ? "is-streaming" : "markdown-body"}`}
        >
          {item.streaming ? (
            item.content
          ) : (
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {item.content}
            </ReactMarkdown>
          )}
        </div>
      )}
    </article>
  );
}

function MessageCopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      setCopied(false);
    }
  }
  if (!text.trim()) return null;
  return (
    <button
      type="button"
      className={`message-copy ${copied ? "is-copied" : ""}`}
      title={copied ? "복사됨" : "복사"}
      onClick={() => void copy()}
    >
      {copied ? <Check size={13} /> : <Copy size={13} />}
    </button>
  );
}

const TranscriptItemView = memo(function TranscriptItemView({
  item,
  onResolveTool,
  onReadArtifact,
  onPreviewFile,
}: {
  item: TranscriptItem;
  onResolveTool: TranscriptProps["onResolveTool"];
  onReadArtifact: TranscriptProps["onReadArtifact"];
  onPreviewFile: TranscriptProps["onPreviewFile"];
}) {
  if (item.kind === "message") {
    const copyText = copyableMessageText(item.content);
    return (
      <article className={`message message--${item.role}`}>
        {item.role === "assistant" && (
          <div className="message-author">
            <span className="assistant-mark">
              <img src={gajaeIconUrl} alt="" />
            </span>
            <strong>Gajae</strong>
            <time>{item.createdAt}</time>
          </div>
        )}
        {(item.content || item.streaming) && (
          <div
            className={`message-body ${item.role === "assistant" && !item.streaming ? "markdown-body" : ""}`}
          >
            {item.content ? (
              item.role === "assistant" ? (
                item.streaming ? (
                  item.content
                ) : (
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {item.content}
                  </ReactMarkdown>
                )
              ) : (
                copyText || item.content
              )
            ) : (
              <span className="typing-dots">
                <i />
                <i />
                <i />
              </span>
            )}
            {item.streaming && <span className="streaming-caret" />}
          </div>
        )}
        {item.images && item.images.length > 0 && (
          <div className="message-images">
            {item.images.map((image) => (
              <img
                key={image.id}
                src={`data:${image.mimeType};base64,${image.data}`}
                alt={image.name}
                title={image.name}
              />
            ))}
          </div>
        )}
        {item.role === "user" &&
          httpUrls(item.content).map((url) => (
            <LinkPreviewCard key={url} url={url} />
          ))}
        {item.role === "user" && (
          <div className="message-meta">
            <time className="user-time">{item.createdAt}</time>
            {copyText ? <MessageCopyButton text={copyText} /> : null}
          </div>
        )}
        {item.role === "assistant" && !item.streaming && copyText ? (
          <div className="message-meta message-meta--assistant">
            <MessageCopyButton text={copyText} />
          </div>
        ) : null}
      </article>
    );
  }

  if (item.kind === "notice") {
    return (
      <article className={`notice-card notice-card--${item.tone}`}>
        <Check size={16} />
        <span>
          <strong>{item.title}</strong>
          <small>{item.content}</small>
        </span>
      </article>
    );
  }

  if (item.kind === "compaction") {
    return <CompactionCard item={item} />;
  }

  if (item.kind === "branch_summary") {
    return <BranchSummaryCard item={item} />;
  }

  if (item.kind === "system") {
    return <SystemNoticeCard item={item} />;
  }

  if (item.kind === "thought") {
    return <ThoughtCard item={item} />;
  }

  if (item.kind === "plan") {
    return (
      <article className="plan-card">
        <header>
          <ListChecks size={15} />
          <strong>계획</strong>
          <span>
            {
              item.entries.filter((entry) => entry.status === "completed")
                .length
            }
            /{item.entries.length}
          </span>
        </header>
        <ol>
          {item.entries.map((entry, index) => (
            <li
              key={`${index}-${entry.content}`}
              className={`plan-entry--${entry.status}`}
            >
              <span />
              {entry.content}
            </li>
          ))}
        </ol>
      </article>
    );
  }

  return (
    <ToolCard
      tool={item}
      onResolve={onResolveTool}
      onReadArtifact={onReadArtifact}
      onPreviewFile={onPreviewFile}
    />
  );
});

interface DiffLine {
  kind: "added" | "removed" | "context" | "hunk";
  text: string;
}

function parseDiffLines(diff: string): DiffLine[] {
  return diff.split("\n").map((line) => {
    if (line.startsWith("@@")) return { kind: "hunk" as const, text: line };
    if (line.startsWith("+"))
      return { kind: "added" as const, text: line.slice(1) };
    if (line.startsWith("-"))
      return { kind: "removed" as const, text: line.slice(1) };
    return { kind: "context" as const, text: line.replace(/^ /u, "") };
  });
}

function DiffView({ diff, path }: { diff: string; path?: string }) {
  const [open, setOpen] = useState(false);
  const lines = parseDiffLines(diff);
  const added = lines.filter((line) => line.kind === "added").length;
  const removed = lines.filter((line) => line.kind === "removed").length;
  const hunks = lines.filter((line) => line.kind === "hunk").length;
  return (
    <div className="tool-diff">
      <button
        className="tool-diff-summary"
        type="button"
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronDown size={12} className={open ? "is-open" : ""} />
        {path && <span className="tool-diff-path">{path}</span>}
        <span className="tool-diff-added">+{added}</span>
        <span className="tool-diff-removed">-{removed}</span>
        <small>{hunks || 1} hunk</small>
      </button>
      {open && (
        <pre className="tool-diff-body">
          {lines.map((line, index) => (
            <span key={index} className={`diff-line diff-line--${line.kind}`}>
              <span className="diff-marker">
                {line.kind === "added"
                  ? "+"
                  : line.kind === "removed"
                    ? "-"
                    : " "}
              </span>
              {line.text}
            </span>
          ))}
        </pre>
      )}
    </div>
  );
}

interface ToolCardProps {
  tool: ToolActivity;
  onResolve: (toolId: string, optionId: string) => void;
  onReadArtifact?: (artifactId: string) => Promise<ArtifactContent>;
  onPreviewFile?: (path: string) => Promise<GeneratedFilePreview>;
}

function ToolCard({
  tool,
  onResolve,
  onReadArtifact,
  onPreviewFile,
}: ToolCardProps) {
  const approvalRequired = tool.status === "approval-required";
  const [expanded, setExpanded] = useState(false);
  const [artifact, setArtifact] = useState<ArtifactContent | null>(null);
  const [artifactError, setArtifactError] = useState("");
  const [preview, setPreview] = useState<GeneratedFilePreview | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const command = tool.command ? compactToolCommand(tool.command) : undefined;
  const output = tool.output
    ? compactToolText(humanRuntimeText(tool.output))
    : undefined;
  const hasDetails = Boolean(command?.fullText || output?.fullText);
  return (
    <>
      <div className="activity-progress">
        <strong>gajae</strong>
        <span>{tool.description}</span>
      </div>
      <article
        className={`tool-card ${approvalRequired ? "tool-card--approval" : ""}`}
      >
        <header>
          <span className="tool-icon">
            <TerminalSquare size={16} />
          </span>
          <span>
            <strong>{toolDisplayName(tool.name)}</strong>
            <small>{tool.description}</small>
          </span>
          <span className={`tool-status tool-status--${tool.status}`}>
            {tool.status === "running" && <span className="mini-spinner" />}
            {toolStatusLabel(tool.status)}
          </span>
        </header>
        {command?.preview && <code>{command.preview}</code>}
        {tool.diff && <DiffView diff={tool.diff} path={tool.targetPath} />}
        {tool.images?.map((image, index) => (
          <img
            key={`${tool.id}-image-${index}`}
            className="tool-image"
            src={image.dataUrl}
            alt={tool.targetPath ?? "도구가 읽은 이미지"}
          />
        ))}
        {tool.targetPath && /^(write|edit)$/iu.test(tool.name) && (
          <button
            className="generated-preview-button"
            type="button"
            disabled={previewBusy}
            onClick={() => {
              if (!onPreviewFile) return;
              setPreviewBusy(true);
              void onPreviewFile(tool.targetPath!)
                .then(setPreview)
                .catch((error) =>
                  setArtifactError(
                    error instanceof Error ? error.message : String(error),
                  ),
                )
                .finally(() => setPreviewBusy(false));
            }}
          >
            <FileSearch size={12} />
            {previewBusy ? "미리보기 여는 중…" : "결과물 미리보기"}
          </button>
        )}
        {!tool.diff && output?.text && (
          <div className="tool-output-preview">
            {output.omittedLines > 0 && (
              <small>앞부분 {output.omittedLines}줄 생략</small>
            )}
            <pre>{output.text}</pre>
          </div>
        )}
        {hasDetails && (
          <button
            className="tool-expand"
            type="button"
            onClick={() => setExpanded((open) => !open)}
          >
            {expanded ? "상세 내용 닫기" : "상세 내용 보기"}{" "}
            <ChevronDown size={12} />
          </button>
        )}
        {expanded && (
          <div className="tool-full-details">
            {command?.fullText && (
              <section>
                <strong>입력</strong>
                <pre>{command.fullText}</pre>
              </section>
            )}
            {output?.fullText && (
              <section>
                <strong>출력</strong>
                <pre>{output.fullText}</pre>
              </section>
            )}
          </div>
        )}
        {(tool.inputArtifactId ||
          tool.outputArtifactId ||
          tool.artifactRefs?.length) && (
          <div className="artifact-links">
            {[
              tool.inputArtifactId,
              tool.outputArtifactId,
              ...(tool.artifactRefs ?? []),
            ]
              .filter((id): id is string => Boolean(id))
              .map((id) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => {
                    if (!onReadArtifact) return;
                    setArtifactError("");
                    void onReadArtifact(id)
                      .then(setArtifact)
                      .catch((e) =>
                        setArtifactError(
                          e instanceof Error ? e.message : String(e),
                        ),
                      );
                  }}
                >
                  {id.startsWith("artifact://") ? id : `artifact://${id}`}
                </button>
              ))}
          </div>
        )}
        {artifactError && (
          <small className="artifact-error">{artifactError}</small>
        )}
        {artifact && (
          <div className="tool-full-details">
            <section>
              <strong>
                Artifact {artifact.artifactId}{" "}
                {artifact.complete ? "" : "(미완료)"}
              </strong>
              <pre>{artifact.text}</pre>
              <small>
                {artifact.complete
                  ? "전체 내용"
                  : `일부만 로드됨 · ${artifact.totalBytes} bytes`}
              </small>
            </section>
          </div>
        )}
        {approvalRequired && (
          <footer>
            <span>
              <ShieldCheck size={14} /> 승인이 필요합니다
            </span>
            <div className="permission-options">
              {(tool.permissionOptions ?? []).map((option) => (
                <button
                  key={option.optionId}
                  type="button"
                  className={
                    option.kind.startsWith("reject")
                      ? "button-secondary"
                      : "button-primary"
                  }
                  onClick={() => onResolve(tool.id, option.optionId)}
                >
                  {option.name}
                </button>
              ))}
            </div>
          </footer>
        )}
      </article>
      {preview && (
        <GeneratedPreviewModal
          preview={preview}
          onClose={() => setPreview(null)}
        />
      )}
    </>
  );
}

function GeneratedPreviewModal({
  preview,
  onClose,
}: {
  preview: GeneratedFilePreview;
  onClose: () => void;
}) {
  return (
    <div className="preview-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="generated-preview"
        role="dialog"
        aria-label={`${preview.name} 미리보기`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <span>
            <strong>{preview.name}</strong>
            <small>
              {preview.path} · {(preview.size / 1024).toFixed(1)} KB
            </small>
          </span>
          <button className="icon-button" type="button" onClick={onClose}>
            <X size={16} />
          </button>
        </header>
        <div className="generated-preview-body">
          {preview.kind === "image" && preview.dataUrl && (
            <img src={preview.dataUrl} alt={preview.name} />
          )}
          {preview.kind === "pdf" && preview.dataUrl && (
            <iframe src={preview.dataUrl} title={preview.name} />
          )}
          {preview.kind === "markdown" && preview.content !== undefined && (
            <article className="markdown-body">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {preview.content}
              </ReactMarkdown>
            </article>
          )}
          {preview.kind === "html" && (
            <iframe sandbox="" srcDoc={preview.content} title={preview.name} />
          )}
          {preview.kind === "text" && <pre>{preview.content}</pre>}
          {preview.kind === "unsupported" && (
            <p>
              이 파일 형식은 앱에서 미리 볼 수 없습니다. 경로는 GJC에서 계속
              사용할 수 있습니다.
            </p>
          )}
        </div>
      </section>
    </div>
  );
}

function toolDisplayName(name: string): string {
  const labels: Record<string, string> = {
    bash: "Bash",
    edit: "Edit",
    find: "Find",
    goal: "Goal",
    read: "Read",
    search: "Search",
    search_tool_bm25: "SearchTools",
    subagent: "Subagent",
    task: "Task",
    todo_write: "Todo Write",
    web_search: "Web Search",
    write: "Write",
  };
  return labels[name] ?? name;
}

interface ComposerProps {
  sessionId: string;
  running: boolean;
  sessionTitle: string;
  workspace: string;
  workspaces: string[];
  commands: AgentCommand[];
  configOptions: AgentConfigOption[];
  modelDisplay?: string;
  thinking?: string;
  usagePercent?: number;
  onSend: (input: MessageInput) => Promise<MessageDelivery | undefined>;
  onCancel: () => void;
  onFlushQueued: () => Promise<void>;
  onCompact: () => void;
  onNewSession: () => void;
  onWorkspaceChange: (workspace: string) => void;
  onConfigChange: (configId: string, value: string) => void;
  onCycleThinking: () => void;
}

function configOptionGroups(
  options: AgentConfigOption["options"],
): Array<{ name: string; options: NonNullable<AgentConfigOption["options"]> }> {
  const groups = new Map<string, NonNullable<AgentConfigOption["options"]>>();
  for (const option of options ?? []) {
    const name = option.group ?? "Session profiles";
    groups.set(name, [...(groups.get(name) ?? []), option]);
  }
  return [...groups].map(([name, groupedOptions]) => ({
    name,
    options: groupedOptions,
  }));
}

function Composer({
  sessionId,
  running,
  sessionTitle,
  workspace,
  workspaces,
  commands,
  configOptions,
  modelDisplay,
  thinking,
  usagePercent,
  onSend,
  onCancel,
  onFlushQueued,
  onCompact,
  onNewSession,
  onWorkspaceChange,
  onConfigChange,
  onCycleThinking,
}: ComposerProps) {
  const [value, setValue] = useState("");
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [files, setFiles] = useState<FileAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState("");
  const [choosingImages, setChoosingImages] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [configMenu, setConfigMenu] = useState<string | null>(null);
  const [commandIndex, setCommandIndex] = useState(0);
  // The composer is the single owner of pending work. GJC is only told about a
  // request when it is actually released, so there is no remote queue to
  // reconcile against and nothing can retire a chip behind the user's back.
  const [pendingQueue, setPendingQueue] = useState<PendingRequest[]>([]);
  const [historyCursor, setHistoryCursor] = useState(-1);
  const composerRef = useRef<HTMLFormElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const submitAfterCompositionRef = useRef(false);
  const compositionEndedAtRef = useRef(0);
  const compositionSubmitScheduledRef = useRef(false);
  // The release loop reads the queue between awaits, so it needs the live value
  // rather than the render-time closure.
  const pendingQueueRef = useRef<PendingRequest[]>([]);
  pendingQueueRef.current = pendingQueue;
  const imageInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const promptHistoryRef = useRef(new Map<string, string[]>());
  const historyDraftRef = useRef("");
  const settingsBridge = window.agentControlDesktop?.settings;
  const slashBody =
    value.startsWith("/") && !value.includes("\n") ? value.slice(1) : null;
  const commandQuery =
    slashBody !== null && !/\s/u.test(slashBody)
      ? slashBody.toLowerCase()
      : null;
  const matchingCommands =
    commandQuery === null
      ? []
      : commands
          .filter((command) =>
            command.name.toLowerCase().includes(commandQuery),
          )
          .slice(0, 8);
  const modelOption = configOptions.find(
    (option) =>
      option.type === "select" &&
      (option.category === "model" || option.id === "model"),
  );
  const thinkingOption = configOptions.find(
    (option) =>
      option.type === "select" &&
      (option.category === "thought_level" || option.id === "thinking"),
  );
  const currentEffort = String(
    thinking ?? thinkingOption?.currentValue ?? "off",
  );
  const draftUrl = httpUrls(value, 1)[0];
  const effortValueRef = useRef(currentEffort);
  effortValueRef.current = currentEffort;

  const addDroppedImages = useCallback(
    async (files: FileList | readonly File[]): Promise<void> => {
      if (!settingsBridge) return;
      setAttachmentError("");
      try {
        if (images.length + files.length > 6)
          throw new Error("이미지는 메시지당 최대 6장까지 첨부할 수 있습니다");
        const paths = Array.from(files).map((file) =>
          settingsBridge.pathForFile(file),
        );
        const attachments = await settingsBridge.readImages(paths);
        setImages((current) => [...current, ...attachments]);
      } catch (error) {
        setAttachmentError(
          error instanceof Error ? error.message : String(error),
        );
      }
    },
    [images.length, settingsBridge],
  );

  const addDroppedAttachments = useCallback(
    async (dropped: FileList | readonly File[]): Promise<void> => {
      const all = Array.from(dropped);
      const imageFiles = all.filter((file) => file.type.startsWith("image/"));
      const textFiles = all.filter((file) => !file.type.startsWith("image/"));
      setAttachmentError("");
      try {
        if (imageFiles.length > 0) await addDroppedImages(imageFiles);
        if (textFiles.length > 0) {
          if (!settingsBridge)
            throw new Error("파일 읽기 브리지를 사용할 수 없습니다");
          const paths = textFiles.map((file) =>
            settingsBridge.pathForFile(file),
          );
          const selected = await settingsBridge.readFiles(paths);
          setFiles((current) => [...current, ...selected].slice(0, 5));
        }
      } catch (error) {
        setAttachmentError(
          error instanceof Error ? error.message : String(error),
        );
      }
    },
    [addDroppedImages, settingsBridge],
  );

  useEffect(() => {
    effortValueRef.current = currentEffort;
  }, [currentEffort]);

  useEffect(() => {
    queueMicrotask(() => {
      setHistoryCursor(-1);
      historyDraftRef.current = "";
      setPendingQueue([]);
    });
  }, [sessionId]);

  useEffect(() => {
    function applyEffortCycle(): void {
      setConfigMenu(null);
      onCycleThinking();
    }
    function handleKeyboard(event: globalThis.KeyboardEvent): void {
      if (
        !event.shiftKey ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.key !== "Tab"
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      applyEffortCycle();
    }
    const unsubscribeNative =
      window.agentControlDesktop?.onCycleEffort(applyEffortCycle);
    window.addEventListener("keydown", handleKeyboard, true);
    return () => {
      unsubscribeNative?.();
      window.removeEventListener("keydown", handleKeyboard, true);
    };
  }, [onCycleThinking]);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(Math.max(textarea.scrollHeight, 52), 196)}px`;
    textarea.style.overflowY = textarea.scrollHeight > 196 ? "auto" : "hidden";
  }, [value]);

  useEffect(() => {
    function closePopovers(event: Event): void {
      if (
        event.type === "pointerdown" &&
        composerRef.current?.contains(event.target as Node)
      )
        return;
      setWorkspaceOpen(false);
      setConfigMenu(null);
    }
    window.addEventListener("pointerdown", closePopovers);
    window.addEventListener("blur", closePopovers);
    return () => {
      window.removeEventListener("pointerdown", closePopovers);
      window.removeEventListener("blur", closePopovers);
    };
  }, []);

  useEffect(() => {
    const candidate = composerRef.current?.closest(".app-shell");
    if (!(candidate instanceof HTMLElement)) return;
    const dropTarget = candidate;
    let dragDepth = 0;
    function hasFiles(event: DragEvent): boolean {
      return event.dataTransfer?.types.includes("Files") ?? false;
    }
    function handleDragEnter(event: DragEvent): void {
      if (!hasFiles(event)) return;
      event.preventDefault();
      dragDepth += 1;
      dropTarget.classList.add("is-dragging-files");
      setDragActive(true);
    }
    function handleDragOver(event: DragEvent): void {
      if (!hasFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    }
    function handleDragLeave(event: DragEvent): void {
      if (dragDepth === 0) return;
      event.preventDefault();
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth > 0) return;
      dropTarget.classList.remove("is-dragging-files");
      setDragActive(false);
    }
    function handleDrop(event: DragEvent): void {
      if (!event.dataTransfer?.files.length) return;
      event.preventDefault();
      dragDepth = 0;
      dropTarget.classList.remove("is-dragging-files");
      setDragActive(false);
      void addDroppedAttachments(event.dataTransfer.files);
    }
    dropTarget.addEventListener("dragenter", handleDragEnter);
    dropTarget.addEventListener("dragover", handleDragOver);
    dropTarget.addEventListener("dragleave", handleDragLeave);
    dropTarget.addEventListener("drop", handleDrop);
    return () => {
      dropTarget.classList.remove("is-dragging-files");
      dropTarget.removeEventListener("dragenter", handleDragEnter);
      dropTarget.removeEventListener("dragover", handleDragOver);
      dropTarget.removeEventListener("dragleave", handleDragLeave);
      dropTarget.removeEventListener("drop", handleDrop);
    };
  }, [addDroppedAttachments]);

  const releasingRef = useRef(false);

  // Interrupt the open turn, then hand the held requests over in order. Each entry
  // leaves the queue only after onSend resolves for it, so a failed release keeps
  // the request visible instead of losing the user's text.
  async function releasePendingQueue(): Promise<void> {
    if (releasingRef.current) return;
    releasingRef.current = true;
    try {
      await onFlushQueued();
      for (;;) {
        const next = nextRequestToRelease(pendingQueueRef.current);
        if (!next) break;
        await onSend({
          text: next.text,
          images: next.images,
          files: next.files,
        });
        setPendingQueue((current) => withoutReleasedRequest(current, next.id));
      }
    } finally {
      releasingRef.current = false;
    }
  }

  function submit(): void {
    const content = (textareaRef.current?.value ?? value).trim();
    // GJC CLI semantics: an empty submit during a live turn interrupts the run and
    // releases the queue this composer has been holding.
    if (running && !content && images.length === 0 && files.length === 0) {
      if (pendingQueue.length === 0) return;
      void releasePendingQueue();
      return;
    }
    if (!content && images.length === 0 && files.length === 0) return;
    const modelCommand = content.match(/^\/(?:model|models)(?:\s+(.+))?$/iu);
    if (modelCommand && images.length === 0 && files.length === 0) {
      const query = modelCommand[1]?.trim();
      if (!query) {
        if (modelOption) {
          setValue("");
          setConfigMenu(modelOption.id);
        }
        return;
      }
      const preset = resolveModelPreset(query, modelOption?.options);
      if (!preset) {
        setAttachmentError(`알 수 없는 모델 프리셋: ${query}`);
        return;
      }
      onConfigChange(modelOption?.id ?? "model", preset);
      setValue("");
      setConfigMenu(null);
      setAttachmentError("");
      return;
    }
    if (content) {
      const history = promptHistoryRef.current.get(sessionId) ?? [];
      if (history.at(-1) !== content)
        promptHistoryRef.current.set(
          sessionId,
          [...history, content].slice(-100),
        );
    }
    const liveTurn = running || pendingQueue.length > 0;
    if (liveTurn) {
      // Held locally, not sent. GJC consumes turn.steer into the open turn the
      // moment it arrives, so submitting now would run the request against the
      // turn the user is still waiting on.
      const preview = composerQueuePreview(content, files, images);
      setPendingQueue((current) =>
        appendPendingRequest(current, {
          id: `local-${crypto.randomUUID()}`,
          text: preview.text,
          mode: preview.mode,
          label: preview.mode === "steer" ? "Steer" : "Queued",
          images,
          files,
        }),
      );
    } else {
      void onSend({ text: content, images, files });
    }
    // submit() reads the textarea's DOM value, so clearing React state alone left
    // the same text readable until the next render. A second Enter arriving in that
    // window -- routine with the Korean IME, which submits from a rAF callback and
    // from the form handler -- queued the request twice.
    if (textareaRef.current) textareaRef.current.value = "";
    setValue("");
    setHistoryCursor(-1);
    historyDraftRef.current = "";
    setImages([]);
    setFiles([]);
    // Clicking the send arrow removes that focused button when the draft clears and
    // leaves focus on <body>. The advertised second Enter can only reach handleKeyDown
    // when the textarea owns focus, so restore it after every submission.
    requestAnimationFrame(() => textareaRef.current?.focus());
  }

  async function acceptImages(selectedFiles: FileList | null): Promise<void> {
    if (!settingsBridge || !selectedFiles?.length || choosingImages) return;
    setAttachmentError("");
    setChoosingImages(true);
    try {
      const paths = Array.from(selectedFiles).map((file) =>
        settingsBridge.pathForFile(file),
      );
      const selected = await settingsBridge.readImages(paths);
      if (selected.length > 0)
        setImages((current) => [...current, ...selected].slice(0, 6));
    } catch (error) {
      setAttachmentError(
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setChoosingImages(false);
      if (imageInputRef.current) imageInputRef.current.value = "";
    }
  }

  async function acceptFiles(selectedFiles: FileList | null): Promise<void> {
    if (!settingsBridge || !selectedFiles?.length) return;
    setAttachmentError("");
    try {
      const paths = Array.from(selectedFiles).map((file) =>
        settingsBridge.pathForFile(file),
      );
      const selected = await settingsBridge.readFiles(paths);
      setFiles((current) => [...current, ...selected].slice(0, 5));
    } catch (error) {
      setAttachmentError(
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function browseWorkspace(): Promise<void> {
    if (!settingsBridge) return;
    setWorkspaceOpen(false);
    try {
      const selected = await settingsBridge.chooseWorkspace(workspace);
      if (selected && selected !== workspace) onWorkspaceChange(selected);
    } catch (error) {
      setAttachmentError(
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  function selectCommand(command: AgentCommand): void {
    if (command.name === "abort") {
      setValue("");
      if (running) {
        onCancel();
        setPendingQueue([]);
      } else setAttachmentError("중단할 실행 작업이 없습니다");
      return;
    }
    if (command.name === "steer") {
      setValue("/steer ");
      requestAnimationFrame(() => textareaRef.current?.focus());
      return;
    }
    if (command.name === "compact") {
      setValue("");
      onCompact();
      return;
    }
    if (command.name === "new") {
      setValue("");
      onNewSession();
      return;
    }
    if (command.name === "model" && modelOption) {
      setValue("");
      setConfigMenu(modelOption.id);
      return;
    }
    if (command.name === "effort" && thinkingOption) {
      setValue("");
      setConfigMenu(thinkingOption.id);
      return;
    }
    setValue(`/${command.name}${command.hint ? " " : ""}`);
    setCommandIndex(0);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }

  function selectConfig(configId: string, selectedValue: string): void {
    onConfigChange(configId, selectedValue);
    setConfigMenu(null);
  }

  function handleSubmit(event: FormEvent): void {
    event.preventDefault();
    submit();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === "Escape" || event.key === "Esc") {
      setPendingQueue([]);
      setWorkspaceOpen(false);
      setConfigMenu(null);
      if (matchingCommands.length > 0) setValue("");
      if (!event.metaKey && !event.ctrlKey && !event.altKey) {
        onCancel();
      }
      return;
    }
    // macOS Korean IME emits Enter while the final syllable is still composing.
    // Treating that keydown as submit sends the full sentence and then the last
    // syllable again as a second steer (for example "steer 테스트" + "트").
    if (
      event.key === "Enter" &&
      (event.nativeEvent.isComposing ||
        event.keyCode === 229 ||
        composingRef.current)
    ) {
      if (!(textareaRef.current?.value ?? value).trim()) {
        event.preventDefault();
        return;
      }
      event.preventDefault();
      submitAfterCompositionRef.current = true;
      window.setTimeout(() => {
        if (
          !submitAfterCompositionRef.current ||
          compositionSubmitScheduledRef.current
        )
          return;
        submitAfterCompositionRef.current = false;
        composingRef.current = false;
        compositionSubmitScheduledRef.current = true;
        requestAnimationFrame(() => {
          // Released only after the submission runs. Clearing it first reopened the
          // window the other IME paths test against, so a single Enter could queue
          // the request twice.
          try {
            submit();
          } finally {
            compositionSubmitScheduledRef.current = false;
          }
        });
      }, 80);
      return;
    }
    if (
      event.key === "Enter" &&
      performance.now() - compositionEndedAtRef.current < 100
    ) {
      event.preventDefault();
      if (!(textareaRef.current?.value ?? value).trim()) return;
      if (!compositionSubmitScheduledRef.current) {
        compositionSubmitScheduledRef.current = true;
        requestAnimationFrame(() => {
          // Released only after the submission runs. Clearing it first reopened the
          // window the other IME paths test against, so a single Enter could queue
          // the request twice.
          try {
            submit();
          } finally {
            compositionSubmitScheduledRef.current = false;
          }
        });
      }
      return;
    }
    if (matchingCommands.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setCommandIndex((current) => (current + 1) % matchingCommands.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setCommandIndex(
          (current) =>
            (current - 1 + matchingCommands.length) % matchingCommands.length,
        );
        return;
      }
      if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
        event.preventDefault();
        selectCommand(
          matchingCommands[
            Math.min(commandIndex, matchingCommands.length - 1)
          ]!,
        );
        return;
      }
    }
    const history = promptHistoryRef.current.get(sessionId) ?? [];
    const textarea = event.currentTarget;
    const plainArrow =
      !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
    if (
      plainArrow &&
      event.key === "ArrowUp" &&
      history.length > 0 &&
      (!value.includes("\n") || textarea.selectionStart === 0)
    ) {
      event.preventDefault();
      const nextCursor =
        historyCursor < 0 ? history.length - 1 : Math.max(0, historyCursor - 1);
      if (historyCursor < 0) historyDraftRef.current = value;
      setHistoryCursor(nextCursor);
      setValue(history[nextCursor] ?? "");
      requestAnimationFrame(() =>
        textareaRef.current?.setSelectionRange(
          history[nextCursor]?.length ?? 0,
          history[nextCursor]?.length ?? 0,
        ),
      );
      return;
    }
    if (
      plainArrow &&
      event.key === "ArrowDown" &&
      historyCursor >= 0 &&
      (!value.includes("\n") || textarea.selectionStart === value.length)
    ) {
      event.preventDefault();
      const nextCursor = historyCursor + 1;
      if (nextCursor >= history.length) {
        setHistoryCursor(-1);
        setValue(historyDraftRef.current);
        requestAnimationFrame(() =>
          textareaRef.current?.setSelectionRange(
            historyDraftRef.current.length,
            historyDraftRef.current.length,
          ),
        );
      } else {
        setHistoryCursor(nextCursor);
        setValue(history[nextCursor] ?? "");
        requestAnimationFrame(() =>
          textareaRef.current?.setSelectionRange(
            history[nextCursor]?.length ?? 0,
            history[nextCursor]?.length ?? 0,
          ),
        );
      }
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  }

  return (
    <form
      ref={composerRef}
      className={`composer ${dragActive ? "is-dragging" : ""}`}
      onSubmit={handleSubmit}
    >
      {images.length > 0 && (
        <div className="composer-images">
          {images.map((image) => (
            <span key={image.id}>
              <img
                src={`data:${image.mimeType};base64,${image.data}`}
                alt={image.name}
              />
              <button
                type="button"
                aria-label={`Remove ${image.name}`}
                onClick={() =>
                  setImages((current) =>
                    current.filter((item) => item.id !== image.id),
                  )
                }
              >
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
      {files.length > 0 && (
        <div className="composer-files">
          {files.map((file) => (
            <span className="attachment-chip" key={file.id}>
              <span>{file.name}</span>
              <button
                type="button"
                aria-label={`Remove ${file.name}`}
                onClick={() =>
                  setFiles((current) =>
                    current.filter((item) => item.id !== file.id),
                  )
                }
              >
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
      {attachmentError && (
        <small className="composer-error">{attachmentError}</small>
      )}
      {pendingQueue.length > 0 && (
        <span className="composer-queue">
          <strong>{pendingQueue.length}개 대기 중</strong>
          <span className="composer-queue-items">
            {pendingQueue.map((entry) => (
              <span
                key={entry.id}
                className={`composer-queue-item composer-queue-item--${entry.mode}`}
              >
                <em>{entry.mode === "steer" ? "즉시" : "대기"}</em>
                {entry.text}
              </span>
            ))}
          </span>
          <small>Enter를 한 번 더 누르면 바로 실행합니다</small>
        </span>
      )}
      {draftUrl && <LinkPreviewCard url={draftUrl} compact />}
      <textarea
        ref={textareaRef}
        aria-label={`${sessionTitle}에게 메시지 보내기`}
        placeholder="무엇이든 요청하세요"
        rows={1}
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
          setHistoryCursor(-1);
          historyDraftRef.current = "";
        }}
        onCompositionStart={() => {
          composingRef.current = true;
        }}
        onCompositionEnd={() => {
          composingRef.current = false;
          compositionEndedAtRef.current = performance.now();
          if (
            !submitAfterCompositionRef.current ||
            compositionSubmitScheduledRef.current
          )
            return;
          submitAfterCompositionRef.current = false;
          compositionSubmitScheduledRef.current = true;
          requestAnimationFrame(() => {
            try {
              submit();
            } finally {
              compositionSubmitScheduledRef.current = false;
            }
          });
        }}
        onKeyDown={handleKeyDown}
      />
      {matchingCommands.length > 0 && (
        <div className="command-palette">
          <header>
            <Command size={14} /> GJC 명령어
          </header>
          {matchingCommands.map((command, index) => (
            <button
              key={command.name}
              type="button"
              className={index === commandIndex ? "is-selected" : ""}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => selectCommand(command)}
            >
              <span>
                <strong>/{command.name}</strong>
                <small>{command.description}</small>
              </span>
              {command.hint && <code>{command.hint}</code>}
            </button>
          ))}
        </div>
      )}
      <div className="composer-toolbar">
        <div>
          <input
            ref={imageInputRef}
            hidden
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            multiple
            onChange={(event) => void acceptImages(event.currentTarget.files)}
          />
          <input
            ref={fileInputRef}
            hidden
            type="file"
            multiple
            onChange={(event) => void acceptFiles(event.currentTarget.files)}
          />
          <button
            className="icon-button"
            type="button"
            title="이미지 첨부"
            disabled={images.length >= 6}
            aria-busy={choosingImages}
            onClick={() => imageInputRef.current?.click()}
          >
            <Paperclip size={17} />
          </button>
          <button
            className="icon-button"
            type="button"
            title="파일 첨부"
            disabled={files.length >= 5}
            onClick={() => fileInputRef.current?.click()}
          >
            <FolderOpen size={16} />
          </button>
          <span className="workspace-switcher">
            <button
              className="composer-context"
              type="button"
              title={workspace}
              onClick={() => setWorkspaceOpen((open) => !open)}
            >
              <FolderGit2 size={15} /> {directoryName(workspace)}{" "}
              <ChevronDown size={13} />
            </button>
            {workspaceOpen && (
              <span className="workspace-menu">
                <strong>세션을 시작할 workspace</strong>
                {workspaces.map((candidate) => (
                  <button
                    type="button"
                    key={candidate}
                    className={candidate === workspace ? "is-current" : ""}
                    onClick={() => {
                      setWorkspaceOpen(false);
                      if (candidate !== workspace) onWorkspaceChange(candidate);
                    }}
                  >
                    <FolderGit2 size={14} />
                    <span>
                      {directoryName(candidate)}
                      <small>{candidate}</small>
                    </span>
                    {candidate === workspace && <Check size={13} />}
                  </button>
                ))}
                <button type="button" onClick={() => void browseWorkspace()}>
                  <FolderOpen size={14} />
                  <span>다른 폴더 선택…</span>
                </button>
              </span>
            )}
          </span>
          {modelOption && (
            <span className="composer-model">
              <button
                type="button"
                disabled={running}
                title="Model: /model · Effort: ⇧⇥"
                onClick={() =>
                  setConfigMenu((open) =>
                    open === modelOption.id ? null : modelOption.id,
                  )
                }
              >
                <strong>
                  {modelDisplay ??
                    modelOption.options?.find(
                      (choice) => choice.value === modelOption.currentValue,
                    )?.name ??
                    String(modelOption.currentValue)}
                </strong>
                <i />
                <span>{currentEffort}</span>
                <i />
                <span>
                  {usagePercent === undefined
                    ? "—"
                    : `${usagePercent.toFixed(1)}%`}
                </span>
              </button>
              {configMenu === modelOption.id && (
                <span className="config-option-menu config-option-menu--model">
                  <header>
                    <strong>모델 프로필</strong>
                    <small>
                      {modelOption.options?.length ?? 0}개 사용 가능
                    </small>
                  </header>
                  <span className="config-option-scroll">
                    {configOptionGroups(modelOption.options).map((group) => (
                      <span className="config-option-group" key={group.name}>
                        <strong>{group.name}</strong>
                        {group.options.map((choice) => (
                          <button
                            key={choice.value}
                            type="button"
                            className={
                              choice.value === modelOption.currentValue
                                ? "is-current"
                                : ""
                            }
                            onClick={() =>
                              selectConfig(modelOption.id, choice.value)
                            }
                          >
                            <span>
                              <strong>{choice.name}</strong>
                              {choice.description && (
                                <small>{choice.description}</small>
                              )}
                            </span>
                            {choice.value === modelOption.currentValue && (
                              <Check size={13} />
                            )}
                          </button>
                        ))}
                      </span>
                    ))}
                  </span>
                </span>
              )}
              {thinkingOption && configMenu === thinkingOption.id && (
                <span className="config-option-menu config-option-menu--effort">
                  <header>
                    <strong>추론 Effort</strong>
                    <small>⇧⇥</small>
                  </header>
                  {thinkingOption.options?.map((choice) => (
                    <button
                      key={choice.value}
                      type="button"
                      className={
                        choice.value === thinkingOption.currentValue
                          ? "is-current"
                          : ""
                      }
                      onClick={() =>
                        selectConfig(thinkingOption.id, choice.value)
                      }
                    >
                      <span>{choice.name}</span>
                      {choice.value === thinkingOption.currentValue && (
                        <Check size={12} />
                      )}
                    </button>
                  ))}
                </span>
              )}
            </span>
          )}
        </div>
        <div className="composer-submit-actions">
          {running && (
            <button
              className="send-button send-button--stop"
              type="button"
              onClick={() => {
                onCancel();
                setPendingQueue([]);
              }}
              title="작업 중단 (Esc)"
            >
              <CircleStop size={18} />
            </button>
          )}
          {(!running ||
            value.trim() ||
            images.length > 0 ||
            files.length > 0) && (
            <button
              className="send-button"
              type="submit"
              disabled={
                !value.trim() && images.length === 0 && files.length === 0
              }
              title="메시지 보내기"
            >
              <ArrowUp size={18} />
            </button>
          )}
        </div>
      </div>
    </form>
  );
}

interface InspectorProps {
  session: AgentSession;
  transcript: TranscriptItem[];
  liveSubagents: SubagentSnapshot[];
  onClose: () => void;
}

function subagentLabel(tool: ToolActivity): string {
  try {
    const input = tool.command
      ? (JSON.parse(tool.command) as Record<string, unknown>)
      : undefined;
    for (const key of ["agent", "role", "name", "description"]) {
      if (typeof input?.[key] === "string" && input[key])
        return String(input[key]);
    }
  } catch {
    // Fall back to the ACP title when raw input is partial or truncated.
  }
  return tool.description || "서브 에이전트";
}

function toolStatusLabel(status: ToolActivity["status"]): string {
  if (status === "running") return "작업 중";
  if (status === "completed" || status === "approved") return "완료";
  if (status === "failed" || status === "denied") return "실패";
  if (status === "cancelled") return "취소됨";
  return "승인 대기";
}

function Inspector({
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

function GoalProgressRow({
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

function RecentRequestStrip({
  items,
  onReveal,
}: {
  items: TranscriptItem[];
  onReveal: (id: string) => void;
}) {
  const requests = useMemo(() => recentUserRequests(items), [items]);
  if (requests.length === 0) return null;
  return (
    <section className="recent-requests" aria-label="최근 요청">
      <header>
        <Clock3 size={11} />
        <strong>최근 요청</strong>
      </header>
      <div>
        {requests.map((request, index) => (
          <button
            type="button"
            key={request.id}
            title={request.text}
            onClick={() => onReveal(request.id)}
          >
            <span>{index + 1}</span>
            <strong>{request.text}</strong>
            <time>{request.createdAt}</time>
          </button>
        ))}
      </div>
    </section>
  );
}

function DiffPanel({
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

interface SettingsDialogProps {
  connection: BackendConnection;
  onClose: () => void;
  onSaved: (preferences: AgentControlPreferences) => void;
  updateStatus: GjcUpdateStatus | null;
  updateBusy: "checking" | "installing" | null;
  updateError: string;
  onCheckUpdate: () => void;
  onInstallUpdate: () => void;
}

interface DeleteSessionDialogProps {
  session: AgentSession;
  onCancel: () => void;
  onConfirm: () => void;
}

interface NewSessionDialogProps {
  defaultWorkspace: string;
  onCancel: () => void;
  onCreate: (input: {
    title: string;
    workspace: string;
    isolation: "workspace" | "worktree";
    worktreeBranch?: string;
  }) => void;
}

function NewSessionDialog({
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

function DeleteSessionDialog({
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

interface SelectOption<T extends string> {
  value: T;
  label: string;
}

function Dropdown<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: T;
  options: SelectOption<T>[];
  onChange: (value: T) => void;
  ariaLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const selected = options.find((option) => option.value === value);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: globalThis.PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  function pick(next: T): void {
    onChange(next);
    setOpen(false);
  }

  return (
    <div className={`dropdown ${open ? "is-open" : ""}`} ref={rootRef}>
      <button
        type="button"
        className="dropdown-trigger"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span>{selected?.label ?? value}</span>
        <ChevronDown size={13} />
      </button>
      {open && (
        <div className="dropdown-menu" role="listbox" aria-label={ariaLabel}>
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={option.value === value}
              className={option.value === value ? "is-selected" : ""}
              onClick={() => pick(option.value)}
            >
              <Check size={12} />
              <span>{option.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function GlobalSearchDialog({
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

interface ManagementPanelProps {
  tab: "mcp" | "skills" | "usage";
  snapshot: ManagementSnapshot;
  workspace: string;
  bridge: ManagementDesktopBridge;
  onSnapshot: (snapshot: ManagementSnapshot) => void;
  onError: (message: string) => void;
}

function ManagementPanel({
  tab,
  snapshot,
  workspace,
  bridge,
  onSnapshot,
  onError,
}: ManagementPanelProps) {
  const [busy, setBusy] = useState("");
  const [mcpName, setMcpName] = useState("");
  const [mcpScope, setMcpScope] = useState<"user" | "project">("project");
  const [mcpType, setMcpType] = useState<"stdio" | "http" | "sse">("stdio");
  const [mcpEndpoint, setMcpEndpoint] = useState("");
  const [mcpArgs, setMcpArgs] = useState("");
  const [pluginTarget, setPluginTarget] = useState("");
  const [pluginScope, setPluginScope] = useState<"user" | "project">("project");

  async function mutate(
    label: string,
    operation: () => Promise<ManagementSnapshot>,
  ): Promise<void> {
    setBusy(label);
    onError("");
    try {
      onSnapshot(await operation());
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy("");
    }
  }

  function addMcp(event: FormEvent): void {
    event.preventDefault();
    const input: McpServerInput = {
      name: mcpName.trim(),
      scope: mcpScope,
      type: mcpType,
      args: mcpArgs
        .split("\n")
        .map((value) => value.trim())
        .filter(Boolean),
      ...(mcpType === "stdio"
        ? { command: mcpEndpoint.trim() }
        : { url: mcpEndpoint.trim() }),
    };
    void mutate("mcp-add", () => bridge.addMcpServer(workspace, input)).then(
      () => {
        setMcpName("");
        setMcpEndpoint("");
        setMcpArgs("");
      },
    );
  }

  if (tab === "mcp") {
    return (
      <div className="management-panel">
        <form className="management-form" onSubmit={addMcp}>
          <h3>MCP 서버 추가</h3>
          <div>
            <input
              required
              placeholder="서버 이름"
              value={mcpName}
              onChange={(event) => setMcpName(event.target.value)}
            />
            <Dropdown
              value={mcpScope}
              ariaLabel="MCP scope"
              options={[
                { value: "project", label: "Project" },
                { value: "user", label: "User" },
              ]}
              onChange={setMcpScope}
            />
            <Dropdown
              value={mcpType}
              ariaLabel="MCP type"
              options={[
                { value: "stdio", label: "STDIO" },
                { value: "http", label: "HTTP" },
                { value: "sse", label: "SSE" },
              ]}
              onChange={setMcpType}
            />
          </div>
          <input
            required
            placeholder={
              mcpType === "stdio" ? "절대 실행 파일 경로" : "HTTPS URL"
            }
            value={mcpEndpoint}
            onChange={(event) => setMcpEndpoint(event.target.value)}
          />
          {mcpType === "stdio" && (
            <textarea
              placeholder="인수 — 한 줄에 하나"
              value={mcpArgs}
              onChange={(event) => setMcpArgs(event.target.value)}
            />
          )}
          <small>환경변수와 인증 헤더는 보안상 앱에서 입력하지 않습니다.</small>
          <button
            className="button-primary"
            type="submit"
            disabled={Boolean(busy)}
          >
            추가
          </button>
        </form>
        <div className="management-list">
          <h3>등록된 서버</h3>
          {snapshot.mcpServers.length === 0 ? (
            <p>등록된 MCP 서버가 없습니다.</p>
          ) : (
            snapshot.mcpServers.map((server) => (
              <article key={`${server.scope}-${server.name}`}>
                <span>
                  <strong>{server.name}</strong>
                  <small>
                    {server.scope} · {server.type} ·{" "}
                    {server.status ?? (server.enabled ? "enabled" : "disabled")}
                  </small>
                </span>
                <button
                  className="button-danger"
                  type="button"
                  disabled={Boolean(busy)}
                  onClick={() => {
                    if (window.confirm(`${server.name} MCP 서버를 제거할까요?`))
                      void mutate(`mcp-${server.name}`, () =>
                        bridge.removeMcpServer(
                          workspace,
                          server.scope,
                          server.name,
                        ),
                      );
                  }}
                >
                  제거
                </button>
              </article>
            ))
          )}
        </div>
      </div>
    );
  }

  if (tab === "skills") {
    return (
      <div className="management-panel">
        <form
          className="management-form"
          onSubmit={(event) => {
            event.preventDefault();
            const target = pluginTarget.trim();
            if (
              !target ||
              !window.confirm(
                `${target} 패키지의 코드를 ${pluginScope} 범위에 설치하고 실행 가능하게 할까요? 신뢰하는 정확한 버전인지 확인하세요.`,
              )
            )
              return;
            void mutate(`plugin-install-${target}`, () =>
              bridge.installPlugin(workspace, target, pluginScope),
            ).then(() => setPluginTarget(""));
          }}
        >
          <h3>Plugin 설치</h3>
          <div>
            <input
              required
              placeholder="정확한 npm 버전: package@1.2.3"
              value={pluginTarget}
              onChange={(event) => setPluginTarget(event.target.value)}
            />
            <Dropdown
              value={pluginScope}
              ariaLabel="Plugin scope"
              options={[
                { value: "project", label: "Project" },
                { value: "user", label: "User" },
              ]}
              onChange={setPluginScope}
            />
            <button
              className="button-primary"
              type="submit"
              disabled={Boolean(busy)}
            >
              검토 후 설치
            </button>
          </div>
          <small>
            태그, latest, Git URL, 로컬 경로는 허용하지 않습니다. 설치된
            플러그인은 GJC 프로세스에서 코드를 실행할 수 있습니다.
          </small>
        </form>
        <div className="management-list">
          <h3>Skills</h3>
          {snapshot.skills.length === 0 ? (
            <p>발견된 스킬이 없습니다.</p>
          ) : (
            snapshot.skills.map((skill) => (
              <article key={`${skill.source}-${skill.name}`}>
                <span>
                  <strong>{skill.name}</strong>
                  <small>
                    {skill.source} · {skill.description || "설명 없음"}
                  </small>
                </span>
              </article>
            ))
          )}
        </div>
        <div className="management-list">
          <h3>Plugins</h3>
          {snapshot.plugins.length === 0 ? (
            <p>설치된 플러그인이 없습니다.</p>
          ) : (
            snapshot.plugins.map((plugin) => (
              <article key={`${plugin.source}-${plugin.name}`}>
                <span>
                  <strong>{plugin.name}</strong>
                  <small>
                    {plugin.source} · {plugin.version ?? "unknown"} ·{" "}
                    {plugin.enabled ? "enabled" : "disabled"}
                  </small>
                </span>
                <div>
                  {plugin.source !== "npm" && (
                    <button
                      className="button-secondary"
                      type="button"
                      disabled={Boolean(busy)}
                      onClick={() =>
                        void mutate(`plugin-toggle-${plugin.name}`, () =>
                          bridge.setPluginEnabled(
                            workspace,
                            plugin.name,
                            !plugin.enabled,
                          ),
                        )
                      }
                    >
                      {plugin.enabled ? "비활성화" : "활성화"}
                    </button>
                  )}
                  <button
                    className="button-danger"
                    type="button"
                    disabled={Boolean(busy)}
                    onClick={() => {
                      if (
                        window.confirm(
                          `${plugin.name} 플러그인을 제거할까요? 설치된 코드가 삭제됩니다.`,
                        )
                      )
                        void mutate(`plugin-remove-${plugin.name}`, () =>
                          bridge.uninstallPlugin(workspace, plugin.name),
                        );
                    }}
                  >
                    제거
                  </button>
                </div>
              </article>
            ))
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="management-panel">
      <section className="usage-summary">
        <span>
          <strong>{snapshot.usage.requests.toLocaleString()}</strong>
          <small>요청</small>
        </span>
        <span>
          <strong>{snapshot.usage.inputTokens.toLocaleString()}</strong>
          <small>입력 토큰</small>
        </span>
        <span>
          <strong>{snapshot.usage.outputTokens.toLocaleString()}</strong>
          <small>출력 토큰</small>
        </span>
        <span>
          <strong>{(snapshot.usage.cacheRate * 100).toFixed(1)}%</strong>
          <small>캐시율</small>
        </span>
        <span>
          <strong>${snapshot.usage.cost.toFixed(2)}</strong>
          <small>비용</small>
        </span>
      </section>
      <div className="management-list">
        <h3>모델별 사용량</h3>
        {snapshot.usage.models.map((model) => (
          <article key={`${model.provider}-${model.model}`}>
            <span>
              <strong>{model.model}</strong>
              <small>
                {model.provider} · {model.requests.toLocaleString()}회 · $
                {(model.cacheRate * 100).toFixed(1)}% cache
              </small>
            </span>
            <strong>${model.cost.toFixed(2)}</strong>
          </article>
        ))}
      </div>
    </div>
  );
}

function AutomationPanel({
  defaultWorkspace,
  defaultModel,
}: {
  defaultWorkspace: string;
  defaultModel: string;
}) {
  const bridge = window.agentControlDesktop?.automations;
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [runs, setRuns] = useState<AutomationRun[]>([]);
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [workspace, setWorkspace] = useState(defaultWorkspace);
  const [kind, setKind] = useState<"daily" | "weekdays" | "weekly">("weekdays");
  const [time, setTime] = useState("09:00");
  const [weekday, setWeekday] = useState("1");
  const [modelProfile, setModelProfile] = useState(defaultModel);
  const [thinking, setThinking] = useState("medium");
  const [worktree, setWorktree] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const reload = useCallback(async (): Promise<void> => {
    if (!bridge) return;
    const [items, history] = await Promise.all([
      bridge.list(),
      bridge.listRuns(),
    ]);
    setAutomations(items);
    setRuns(
      history
        .slice()
        .sort((left, right) => right.startedAt.localeCompare(left.startedAt)),
    );
  }, [bridge]);

  useEffect(() => {
    queueMicrotask(
      () =>
        void reload().catch((reason) =>
          setError(reason instanceof Error ? reason.message : String(reason)),
        ),
    );
  }, [reload]);

  async function mutate(
    label: string,
    operation: () => Promise<unknown>,
  ): Promise<void> {
    setBusy(label);
    setError("");
    try {
      await operation();
      await reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy("");
    }
  }

  function createAutomation(event: FormEvent): void {
    event.preventDefault();
    if (!bridge) return;
    const input: AutomationInput = {
      name: name.trim(),
      prompt: prompt.trim(),
      workspace: workspace.trim(),
      enabled: true,
      worktree,
      schedule: {
        kind,
        time: time as AutomationInput["schedule"]["time"],
        ...(kind === "weekly" ? { weekday: Number(weekday) } : {}),
      },
      ...(modelProfile.trim() ? { modelProfile: modelProfile.trim() } : {}),
      ...(thinking ? { thinking } : {}),
    };
    void mutate("create", () => bridge.create(input)).then(() => {
      setName("");
      setPrompt("");
    });
  }

  return (
    <div className="automation-panel">
      <form className="automation-form" onSubmit={createAutomation}>
        <h3>예약 작업 만들기</h3>
        <input
          required
          maxLength={200}
          placeholder="자동화 이름"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <textarea
          required
          maxLength={20000}
          placeholder="GJC에 실행할 작업을 구체적으로 작성하세요"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
        />
        <input
          required
          placeholder="절대 workspace 경로"
          value={workspace}
          onChange={(event) => setWorkspace(event.target.value)}
        />
        <div className="automation-form-grid">
          <Dropdown
            value={kind}
            ariaLabel="자동화 주기"
            options={[
              { value: "daily", label: "매일" },
              { value: "weekdays", label: "평일" },
              { value: "weekly", label: "매주" },
            ]}
            onChange={setKind}
          />
          {kind === "weekly" && (
            <Dropdown
              value={weekday}
              ariaLabel="실행 요일"
              options={[
                { value: "0", label: "일요일" },
                { value: "1", label: "월요일" },
                { value: "2", label: "화요일" },
                { value: "3", label: "수요일" },
                { value: "4", label: "목요일" },
                { value: "5", label: "금요일" },
                { value: "6", label: "토요일" },
              ]}
              onChange={setWeekday}
            />
          )}
          <input
            required
            type="time"
            value={time}
            onChange={(event) => setTime(event.target.value)}
          />
        </div>
        <div className="automation-form-grid">
          <input
            placeholder="모델 프로필"
            value={modelProfile}
            onChange={(event) => setModelProfile(event.target.value)}
          />
          <Dropdown
            value={thinking}
            ariaLabel="자동화 추론 effort"
            options={[
              { value: "off", label: "Off" },
              { value: "low", label: "Low" },
              { value: "medium", label: "Medium" },
              { value: "high", label: "High" },
              { value: "xhigh", label: "XHigh" },
              { value: "max", label: "Max" },
            ]}
            onChange={setThinking}
          />
        </div>
        <label className="automation-check">
          <input
            type="checkbox"
            checked={worktree}
            onChange={(event) => setWorktree(event.target.checked)}
          />
          <span>
            <strong>별도 worktree에서 실행</strong>
            <small>
              예약 작업이 현재 작업 폴더를 직접 건드리지 않게 격리합니다.
            </small>
          </span>
        </label>
        <button
          className="button-primary"
          type="submit"
          disabled={!bridge || Boolean(busy)}
        >
          자동화 추가
        </button>
      </form>
      {error && <p className="diff-error">{error}</p>}
      <section className="automation-list">
        <h3>등록된 자동화</h3>
        {automations.length === 0 && <p>등록된 자동화가 없습니다.</p>}
        {automations.map((automation) => {
          const latest = runs.find((run) => run.automationId === automation.id);
          return (
            <article key={automation.id}>
              <header>
                <span>
                  <strong>{automation.name}</strong>
                  <small>
                    {automation.schedule.kind} · {automation.schedule.time} ·{" "}
                    {automation.worktree ? "worktree" : "workspace"}
                  </small>
                </span>
                <button
                  className={`automation-toggle ${automation.enabled ? "is-enabled" : ""}`}
                  type="button"
                  disabled={Boolean(busy)}
                  onClick={() => {
                    if (bridge)
                      void mutate(`toggle-${automation.id}`, () =>
                        bridge.updateEnabled(
                          automation.id,
                          !automation.enabled,
                        ),
                      );
                  }}
                >
                  {automation.enabled ? "활성" : "중지"}
                </button>
              </header>
              <p>{automation.prompt}</p>
              <small>
                {automation.nextRunAt
                  ? `다음 실행 ${new Date(automation.nextRunAt).toLocaleString("ko-KR")}`
                  : "예약 중지됨"}
                {latest ? ` · 최근 ${latest.status}` : ""}
              </small>
              <footer>
                <button
                  className="button-secondary"
                  type="button"
                  disabled={Boolean(busy)}
                  onClick={() => {
                    if (bridge)
                      void mutate(`run-${automation.id}`, () =>
                        bridge.runNow(automation.id),
                      );
                  }}
                >
                  <Play size={12} /> 지금 실행
                </button>
                <button
                  className="button-danger"
                  type="button"
                  disabled={Boolean(busy)}
                  onClick={() => {
                    if (
                      bridge &&
                      window.confirm(`${automation.name} 자동화를 삭제할까요?`)
                    )
                      void mutate(`delete-${automation.id}`, () =>
                        bridge.delete(automation.id),
                      );
                  }}
                >
                  <Trash2 size={12} /> 삭제
                </button>
              </footer>
              {latest && (latest.output || latest.error) && (
                <details>
                  <summary>최근 실행 결과</summary>
                  <pre>{latest.output || latest.error}</pre>
                </details>
              )}
            </article>
          );
        })}
      </section>
    </div>
  );
}

function SettingsDialog({
  connection,
  onClose,
  onSaved,
  updateStatus,
  updateBusy,
  updateError,
  onCheckUpdate,
  onInstallUpdate,
}: SettingsDialogProps) {
  const detectedPreset = profileFromDetail(connection.detail);
  const fallbackPreferences: AgentControlPreferences = {
    workspace: connection.workspace,
    workspaceLabel: "개인 Workspace",
    modelPreset: detectedPreset,
    permissionHandling: "prompt",
    gjcExecutable: "",
  };
  const [tab, setTab] = useState<
    "gjc" | "workspace" | "mcp" | "skills" | "usage" | "automations"
  >("gjc");
  const [management, setManagement] = useState<ManagementSnapshot | null>(null);
  const [managementError, setManagementError] = useState("");
  const [managementLoading, setManagementLoading] = useState(false);
  const [preferences, setPreferences] =
    useState<AgentControlPreferences>(fallbackPreferences);
  const [original, setOriginal] =
    useState<AgentControlPreferences>(fallbackPreferences);
  const [saving, setSaving] = useState(false);
  const settingsBridge = window.agentControlDesktop?.settings;
  const managementBridge = window.agentControlDesktop?.management;
  const dirty = JSON.stringify(preferences) !== JSON.stringify(original);
  const runtimeDirty =
    preferences.modelPreset !== original.modelPreset ||
    preferences.permissionHandling !== original.permissionHandling ||
    preferences.gjcExecutable !== original.gjcExecutable;
  const tabTitle = {
    gjc: "GJC",
    workspace: "Workspace 범위",
    mcp: "MCP 서버",
    skills: "Skills & Plugins",
    usage: "Usage",
    automations: "Automations",
  }[tab];
  const tabDescription = {
    gjc: "새 세션에서 사용할 로컬 ACP runtime을 설정합니다.",
    workspace: "GJC가 확인하고 수정할 폴더를 선택합니다.",
    mcp: "GJC가 자동으로 로드할 MCP 서버를 관리합니다.",
    skills: "발견된 스킬과 설치된 플러그인을 확인합니다.",
    usage: "모델별 토큰, 캐시율, 비용을 확인합니다.",
    automations: "앱이 닫혀 있어도 GJC 작업을 정해진 시간에 실행합니다.",
  }[tab];

  useEffect(() => {
    if (!settingsBridge) return;
    let active = true;
    void settingsBridge.getPreferences().then((loaded) => {
      if (!active) return;
      setPreferences(loaded);
      setOriginal(loaded);
    });
    return () => {
      active = false;
    };
  }, [settingsBridge]);

  useEffect(() => {
    if (
      !managementBridge ||
      management ||
      !["mcp", "skills", "usage"].includes(tab)
    )
      return;
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      setManagementLoading(true);
      setManagementError("");
      void managementBridge
        .getSnapshot(preferences.workspace)
        .then((snapshot) => {
          if (active) setManagement(snapshot);
        })
        .catch((error) => {
          if (active)
            setManagementError(
              error instanceof Error ? error.message : String(error),
            );
        })
        .finally(() => {
          if (active) setManagementLoading(false);
        });
    });
    return () => {
      active = false;
    };
  }, [management, managementBridge, preferences.workspace, tab]);

  async function chooseWorkspace(): Promise<void> {
    if (!settingsBridge) return;
    const selected = await settingsBridge.chooseWorkspace(
      preferences.workspace,
    );
    if (selected) {
      setPreferences((current) => ({ ...current, workspace: selected }));
      setManagement(null);
    }
  }

  async function saveSettings(): Promise<void> {
    if (!settingsBridge || !dirty) return;
    setSaving(true);
    try {
      const saved = await settingsBridge.savePreferences(preferences);
      setPreferences(saved.preferences);
      setOriginal(saved.preferences);
      onSaved(saved.preferences);
      onClose();
    } catch (error) {
      setSaving(false);
      console.error(error);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="설정"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <nav>
          <h2>설정</h2>
          <button
            type="button"
            className={tab === "gjc" ? "is-active" : ""}
            onClick={() => setTab("gjc")}
          >
            <Command size={17} /> GJC
          </button>
          <button
            type="button"
            className={tab === "workspace" ? "is-active" : ""}
            onClick={() => setTab("workspace")}
          >
            <FolderOpen size={17} /> Workspace
          </button>
          <button
            type="button"
            className={tab === "mcp" ? "is-active" : ""}
            onClick={() => setTab("mcp")}
          >
            MCP
          </button>
          <button
            type="button"
            className={tab === "skills" ? "is-active" : ""}
            onClick={() => setTab("skills")}
          >
            Skills/Plugins
          </button>
          <button
            type="button"
            className={tab === "usage" ? "is-active" : ""}
            onClick={() => setTab("usage")}
          >
            Usage
          </button>
          <button
            type="button"
            className={tab === "automations" ? "is-active" : ""}
            onClick={() => setTab("automations")}
          >
            <CalendarClock size={17} /> Automations
          </button>
        </nav>
        <div className="settings-content">
          <header>
            <div>
              <h2>{tabTitle}</h2>
              <p>{tabDescription}</p>
            </div>
            <button className="icon-button" type="button" onClick={onClose}>
              <X size={19} />
            </button>
          </header>

          {tab === "gjc" && (
            <div className="settings-stack">
              <article className="backend-card">
                <span className="backend-logo backend-logo--gjc">
                  <img src={gajaeIconUrl} alt="" />
                </span>
                <span>
                  <strong>{connection.label}</strong>
                  <small>{connection.detail}</small>
                </span>
                <span
                  className={`ready-badge ready-badge--${connection.state}`}
                >
                  <Check size={13} /> {connectionStateLabel(connection.state)}
                </span>
              </article>
              <div className="settings-panel">
                <label>
                  <span>
                    <strong>모델 프로필</strong>
                    <small>기본 preset 또는 models.yml의 custom ID</small>
                  </span>
                  <input
                    list="gjc-model-profiles"
                    value={preferences.modelPreset}
                    onChange={(event) =>
                      setPreferences((current) => ({
                        ...current,
                        modelPreset: event.target.value,
                      }))
                    }
                    placeholder="codex-medium or custom profile ID"
                  />
                  <datalist id="gjc-model-profiles">
                    <option value="codex-eco" />
                    <option value="codex-medium" />
                    <option value="codex-pro" />
                  </datalist>
                </label>
                <label>
                  <span>
                    <strong>도구 승인</strong>
                    <small>위험한 작업을 GJC가 처리하는 방식</small>
                  </span>
                  <Dropdown
                    value={preferences.permissionHandling}
                    ariaLabel="도구 승인"
                    options={[
                      { value: "prompt", label: "매번 확인" },
                      { value: "auto", label: "GJC 스마트 정책" },
                      { value: "always-allow", label: "항상 허용" },
                    ]}
                    onChange={(value) =>
                      setPreferences((current) => ({
                        ...current,
                        permissionHandling:
                          value as AgentControlPreferences["permissionHandling"],
                      }))
                    }
                  />
                </label>
                <label className="settings-field-wide">
                  <span>
                    <strong>GJC 실행 파일</strong>
                    <small>비워 두면 로컬 설치를 자동으로 찾습니다</small>
                  </span>
                  <input
                    value={preferences.gjcExecutable}
                    placeholder="Auto-detect (~/.bun/bin/gjc)"
                    onChange={(event) =>
                      setPreferences((current) => ({
                        ...current,
                        gjcExecutable: event.target.value,
                      }))
                    }
                  />
                </label>
                <div className="gjc-update-row">
                  <span>
                    <strong>GJC 업데이트</strong>
                    <small>
                      {updateError ||
                        (updateStatus
                          ? updateStatus.updateAvailable
                            ? `${updateStatus.currentVersion} → ${updateStatus.latestVersion} 사용 가능`
                            : `최신 버전 ${updateStatus.currentVersion}`
                          : "업데이트 정보를 확인합니다")}
                    </small>
                  </span>
                  <span className="gjc-update-actions">
                    <button
                      type="button"
                      disabled={Boolean(updateBusy)}
                      onClick={onCheckUpdate}
                    >
                      {updateBusy === "checking" ? "확인 중…" : "다시 확인"}
                    </button>
                    {updateStatus?.updateAvailable && (
                      <button
                        type="button"
                        className="button-primary"
                        disabled={Boolean(updateBusy)}
                        onClick={onInstallUpdate}
                      >
                        {updateBusy === "installing"
                          ? "업데이트 중…"
                          : "업데이트"}
                      </button>
                    )}
                  </span>
                </div>
              </div>
            </div>
          )}
          {["mcp", "skills", "usage"].includes(tab) && (
            <div className="settings-stack">
              {managementLoading && (
                <p className="settings-note">불러오는 중…</p>
              )}
              {managementError && (
                <p className="diff-error">{managementError}</p>
              )}
              {!managementLoading &&
                !managementError &&
                management &&
                managementBridge && (
                  <ManagementPanel
                    tab={tab as "mcp" | "skills" | "usage"}
                    snapshot={management}
                    workspace={preferences.workspace}
                    bridge={managementBridge}
                    onSnapshot={setManagement}
                    onError={setManagementError}
                  />
                )}
              {!managementLoading && !managementError && !management && (
                <p className="settings-note">데이터가 없습니다.</p>
              )}
            </div>
          )}
          {tab === "automations" && (
            <AutomationPanel
              defaultWorkspace={preferences.workspace}
              defaultModel={preferences.modelPreset}
            />
          )}

          {tab === "workspace" && (
            <div className="settings-stack">
              <div className="workspace-card">
                <span>
                  <FolderOpen size={22} />
                </span>
                <div>
                  <strong>
                    {preferences.workspace.split("/").filter(Boolean).at(-1) ??
                      preferences.workspace}
                  </strong>
                  <code>{preferences.workspace}</code>
                </div>
                <button
                  type="button"
                  className="button-secondary"
                  onClick={() => void chooseWorkspace()}
                >
                  선택…
                </button>
              </div>
              <div className="scope-notice">
                <ShieldCheck size={17} />
                <span>
                  <strong>폴더 범위</strong>
                  <small>
                    새 GJC 세션은 이 폴더에서 시작하며 파일 작업과 저장소 탐색의
                    기준으로 사용합니다.
                  </small>
                </span>
              </div>
            </div>
          )}

          {tab !== "automations" && (
            <footer className="settings-footer">
              <span>
                {dirty
                  ? runtimeDirty
                    ? "저장하면 GJC runtime만 다시 연결됩니다."
                    : "앱 재실행 없이 바로 적용됩니다."
                  : "설정이 최신 상태입니다."}
              </span>
              <button
                type="button"
                className="button-primary"
                disabled={!dirty || saving || !settingsBridge}
                onClick={() => void saveSettings()}
              >
                {saving
                  ? runtimeDirty
                    ? "GJC 재연결 중…"
                    : "저장 중…"
                  : "저장"}
              </button>
            </footer>
          )}
        </div>
      </section>
    </div>
  );
}

export default function App() {
  const backend = useAgentBackend();
  const [connection, setConnection] = useState<BackendConnection>({
    state: "connecting",
    backend: "mock",
    label: "Gajae runtime",
    detail: "Connecting",
    workspace: "",
  });
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [transcripts, setTranscripts] = useState<
    Record<string, TranscriptItem[]>
  >({});
  const [commands, setCommands] = useState<Record<string, AgentCommand[]>>({});
  const [configOptions, setConfigOptions] = useState<
    Record<string, AgentConfigOption[]>
  >({});
  const [searchQuery, setSearchQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [revealTarget, setRevealTarget] = useState<{
    sessionId: string;
    itemId: string;
  } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<GjcUpdateStatus | null>(
    null,
  );
  const [updateBusy, setUpdateBusy] = useState<
    "checking" | "installing" | null
  >(null);
  const [updateError, setUpdateError] = useState("");
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [diffOpen, setDiffOpen] = useState(false);
  const [diff, setDiff] = useState<DiffSnapshot | null>(null);
  const [selectedGit, setSelectedGit] = useState<GitStatusSnapshot | null>(
    null,
  );
  const [goal, setGoal] = useState<GoalSnapshot>({
    enabled: false,
    completed: 0,
    total: 0,
  });
  const [goalBusy, setGoalBusy] = useState(false);
  const [liveSubagents, setLiveSubagents] = useState<SubagentSnapshot[]>([]);
  const [diffLoading, setDiffLoading] = useState(false);
  const [deleteCandidate, setDeleteCandidate] = useState<AgentSession | null>(
    null,
  );
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const [appError, setAppError] = useState("");
  const [workspaceLabel, setWorkspaceLabel] = useState("개인 Workspace");
  const pendingSessions = useRef(new Map<string, Promise<AgentSession>>());
  const selectedIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!appError) return;
    const timer = window.setTimeout(() => setAppError(""), 4_500);
    return () => window.clearTimeout(timer);
  }, [appError]);
  const updateCheckedRef = useRef(false);
  const settingsBridge = window.agentControlDesktop?.settings;

  const checkForUpdate = useCallback(async (): Promise<void> => {
    if (!settingsBridge) return;
    setUpdateBusy("checking");
    setUpdateError("");
    try {
      setUpdateStatus(await settingsBridge.checkGjcUpdate());
    } catch (error) {
      setUpdateError(error instanceof Error ? error.message : String(error));
    } finally {
      setUpdateBusy(null);
    }
  }, [settingsBridge]);

  const installUpdate = useCallback(async (): Promise<void> => {
    if (!settingsBridge || !updateStatus?.updateAvailable) return;
    if (
      !window.confirm(
        `GJC ${updateStatus.latestVersion}(으)로 업데이트할까요? 업데이트 후 GJC runtime이 다시 연결됩니다.`,
      )
    )
      return;
    setUpdateBusy("installing");
    setUpdateError("");
    try {
      setUpdateStatus(await settingsBridge.installGjcUpdate());
    } catch (error) {
      setUpdateError(error instanceof Error ? error.message : String(error));
      setSettingsOpen(true);
    } finally {
      setUpdateBusy(null);
    }
  }, [settingsBridge, updateStatus]);

  useEffect(() => {
    if (updateCheckedRef.current) return;
    updateCheckedRef.current = true;
    queueMicrotask(() => void checkForUpdate());
  }, [checkForUpdate]);

  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  useEffect(() => {
    function openGlobalSearch(event: globalThis.KeyboardEvent): void {
      if (
        !event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.shiftKey ||
        event.key.toLowerCase() !== "k"
      )
        return;
      event.preventDefault();
      setSearchOpen(true);
    }
    window.addEventListener("keydown", openGlobalSearch);
    return () => window.removeEventListener("keydown", openGlobalSearch);
  }, []);

  useEffect(() => {
    const settingsBridge = window.agentControlDesktop?.settings;
    if (!settingsBridge) return;
    let active = true;
    void settingsBridge.getPreferences().then((preferences) => {
      if (active) setWorkspaceLabel(preferences.workspaceLabel);
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    void backend.getConnection().then((currentConnection) => {
      if (active) setConnection(currentConnection);
    });
    // A GJC session started from the CLI after this window opened only shows up if
    // discovery runs again, so the list refreshes instead of loading once.
    const loadSessions = (initial: boolean): void => {
      void backend
        .listSessions()
        .then((loadedSessions) => {
          if (!active) return;
          setSessions((current) =>
            mergeDiscoveredSessions(
              current,
              loadedSessions,
              selectedIdRef.current,
            ),
          );
          if (initial)
            setSelectedId((selected) =>
              initialSessionId(loadedSessions, selected),
            );
        })
        .catch(() => undefined);
    };
    loadSessions(true);
    // A full scan costs seconds on a large broker index, so polling faster than
    // that just queues overlapping scans. Focus refresh covers the case where the
    // user switches to this window right after starting a CLI session.
    const discoveryTimer = window.setInterval(
      () => loadSessions(false),
      15_000,
    );
    const refreshOnFocus = (): void => loadSessions(false);
    window.addEventListener("focus", refreshOnFocus);

    const unsubscribe = backend.subscribe((event: AgentEvent) => {
      if (event.type === "connection.updated") {
        setConnection(event.connection);
      } else if (event.type === "session.created") {
        setSessions((current) => [
          event.session,
          ...current.filter((session) => session.id !== event.session.id),
        ]);
      } else if (event.type === "session.updated") {
        setSessions((current) =>
          current.map((session) =>
            session.id === event.session.id ? event.session : session,
          ),
        );
      } else if (event.type === "session.deleted") {
        setSessions((current) => {
          const remaining = current.filter(
            (session) => session.id !== event.sessionId,
          );
          setSelectedId((selected) =>
            selected === event.sessionId
              ? (remaining[0]?.id ?? null)
              : selected,
          );
          return remaining;
        });
        setTranscripts((current) => {
          const next = { ...current };
          delete next[event.sessionId];
          return next;
        });
      } else if (event.type === "transcript.appended") {
        setTranscripts((current) => {
          const items = current[event.item.sessionId];
          if (!items) return current;
          return cacheTranscript(current, event.item.sessionId, [
            ...items,
            event.item,
          ]);
        });
      } else if (event.type === "transcript.synced") {
        setTranscripts((current) =>
          cacheTranscript(current, event.sessionId, event.items),
        );
      } else if (event.type === "message.delta") {
        setTranscripts((current) =>
          updateTranscriptItem(
            current,
            event.sessionId,
            event.messageId,
            (item) =>
              item.kind === "message"
                ? {
                    ...item,
                    content: item.content + event.delta,
                    streaming: event.streaming,
                  }
                : item,
          ),
        );
      } else if (event.type === "message.updated") {
        setTranscripts((current) =>
          updateTranscriptItem(
            current,
            event.message.sessionId,
            event.message.id,
            () => event.message,
          ),
        );
      } else if (event.type === "thought.delta") {
        setTranscripts((current) =>
          updateTranscriptItem(
            current,
            event.sessionId,
            event.thoughtId,
            (item) =>
              item.kind === "thought"
                ? {
                    ...item,
                    content: item.content + event.delta,
                    streaming: event.streaming,
                  }
                : item,
          ),
        );
      } else if (event.type === "plan.updated") {
        setTranscripts((current) =>
          updateTranscriptItem(
            current,
            event.plan.sessionId,
            event.plan.id,
            () => event.plan,
          ),
        );
      } else if (event.type === "session.commands") {
        setCommands((current) => ({
          ...current,
          [event.sessionId]: event.commands,
        }));
      } else if (event.type === "session.config") {
        setConfigOptions((current) => ({
          ...current,
          [event.sessionId]: event.options,
        }));
      } else if (event.type === "tool.updated") {
        setTranscripts((current) =>
          updateTranscriptItem(
            current,
            event.tool.sessionId,
            event.tool.id,
            () => event.tool,
          ),
        );
      } else if (event.type === "session.activity") {
        setSessions((current) =>
          current.map((s) =>
            s.id === event.sessionId
              ? {
                  ...s,
                  unread:
                    event.sessionId !== selectedIdRef.current && event.unread,
                }
              : s,
          ),
        );
      }
    });

    return () => {
      active = false;
      window.clearInterval(discoveryTimer);
      window.removeEventListener("focus", refreshOnFocus);
      unsubscribe();
    };
  }, [backend]);

  const selectedSession =
    sessions.find((session) => session.id === selectedId) ?? null;
  const selectedSessionId = selectedSession?.id;
  const selectedSessionStatus = selectedSession?.status;
  const selectedSessionRef = useRef(selectedSession);
  selectedSessionRef.current = selectedSession;

  useEffect(() => {
    if (!selectedId) return;
    if (transcripts[selectedId]) return;
    let active = true;
    void backend
      .getTranscript(selectedId)
      .then((items) => {
        if (active)
          setTranscripts((current) =>
            cacheTranscript(current, selectedId, items),
          );
      })
      .catch((error) => {
        if (!active) return;
        setTranscripts((current) => cacheTranscript(current, selectedId, []));
        setAppError(humanErrorMessage(error));
      });
    return () => {
      active = false;
    };
  }, [backend, selectedId, transcripts]);

  useEffect(() => {
    if (!selectedSessionId) return;
    let active = true;
    const refresh = (): void => {
      void backend
        .getGoal(selectedSessionId)
        .then((snapshot) => {
          if (active) setGoal(snapshot);
        })
        .catch(() => {
          if (active) setGoal({ enabled: false, completed: 0, total: 0 });
        });
    };
    queueMicrotask(refresh);
    // Goal and todo state advance at tool-call pace, not at streaming pace. Two
    // round trips every 1.5s on the shared ACP channel cost more than the
    // freshness is worth while a turn is running.
    const timer = window.setInterval(
      refresh,
      selectedSessionStatus === "running" ? 4_000 : 10_000,
    );
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [backend, selectedSessionId, selectedSessionStatus]);

  useEffect(() => {
    if (!selectedSessionId || !inspectorOpen) {
      queueMicrotask(() => setLiveSubagents([]));
      return;
    }
    let active = true;
    const refresh = (): void => {
      void backend
        .listSubagents(selectedSessionId)
        .then((jobs) => {
          if (active) setLiveSubagents(jobs);
        })
        .catch(() => undefined);
    };
    queueMicrotask(refresh);
    // Subagent rows only change when a delegated job starts or finishes, and the
    // inspector is the only surface that shows them.
    const timer = window.setInterval(refresh, 4_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [backend, inspectorOpen, selectedSessionId]);

  useEffect(() => {
    if (!selectedId) return;
    void backend.markSessionRead(selectedId);
  }, [backend, selectedId]);

  useEffect(() => {
    if (!selectedSessionId) {
      queueMicrotask(() => setSelectedGit(null));
      return;
    }
    let active = true;
    const refresh = (): void => {
      void backend
        .getGitStatus(selectedSessionId)
        .then((status) => {
          if (active) setSelectedGit(status);
        })
        .catch(() => {
          if (active) setSelectedGit(null);
        });
    };
    queueMicrotask(refresh);
    window.addEventListener("focus", refresh);
    return () => {
      active = false;
      window.removeEventListener("focus", refresh);
    };
  }, [backend, selectedSessionId, selectedSessionStatus]);

  async function refreshDiff(): Promise<void> {
    if (!selectedId) return;
    setDiffLoading(true);
    try {
      setDiff(await backend.getDiff(selectedId));
    } catch (e) {
      setDiff({
        sessionId: selectedId,
        workspace: selectedSession?.workspace ?? "",
        files: [],
        refreshedAt: new Date().toISOString(),
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setDiffLoading(false);
    }
  }

  async function operateGoal(operation: GoalOperation): Promise<void> {
    if (!selectedId || goalBusy) return;
    setGoalBusy(true);
    try {
      setGoal(await backend.operateGoal(selectedId, operation));
    } catch (error) {
      setAppError(humanErrorMessage(error));
    } finally {
      setGoalBusy(false);
    }
  }

  const filteredSessions = sessions;
  const shortcutSessions = useMemo(
    () => orderedSessionsForShortcuts(filteredSessions),
    [filteredSessions],
  );

  // Nothing is hidden any more: a request the composer is still holding was never
  // sent, so it cannot appear here, and anything that did reach GJC is an ordinary
  // user message.
  const selectedTranscript = selectedId
    ? (transcripts[selectedId] ?? EMPTY_TRANSCRIPT)
    : EMPTY_TRANSCRIPT;
  const transcriptHasLiveWork = selectedTranscript.some((item) => {
    if (item.kind === "message" || item.kind === "thought")
      return item.streaming === true;
    if (item.kind === "tool")
      return item.status === "running" || item.status === "approval-required";
    if (item.kind === "plan")
      return item.entries.some((entry) => entry.status === "in_progress");
    return false;
  });
  // Queue state changes when the turn starts or ends, not on every streamed
  // chunk. Keying this on transcript length re-listed the queue over the shared
  // ACP channel for each chunk, which is what made sending feel slow.
  const resolveToolCall = useCallback(
    (toolId: string, optionId: string) => {
      void backend.resolveToolCall(toolId, { optionId });
    },
    [backend],
  );
  const readArtifact = useCallback(
    (artifactId: string) => {
      if (!selectedId)
        return Promise.reject(new Error("선택된 세션이 없습니다."));
      return backend.readArtifact(
        selectedId,
        artifactId.replace(/^artifact:\/\//u, ""),
      );
    },
    [backend, selectedId],
  );
  const previewFile = useCallback(
    (filePath: string) => {
      if (!selectedId)
        return Promise.reject(new Error("선택된 세션이 없습니다."));
      return backend.previewFile(selectedId, filePath);
    },
    [backend, selectedId],
  );
  const completeReveal = useCallback((itemId: string) => {
    setRevealTarget((current) => (current?.itemId === itemId ? null : current));
  }, []);
  const selectedCommands = useMemo(() => {
    const live = selectedId ? (commands[selectedId] ?? []) : [];
    return [
      ...new Map(
        [...BUNDLED_GJC_COMMANDS, ...live].map((command) => [
          command.name,
          command,
        ]),
      ).values(),
    ];
  }, [commands, selectedId]);
  const selectedConfigOptions = selectedId
    ? (configOptions[selectedId] ?? [])
    : [];
  const composerConfigOptions = selectedConfigOptions.some(
    (option) => option.category === "model" || option.id === "model",
  )
    ? selectedConfigOptions
    : [
        {
          id: "model",
          name: "프리셋",
          category: "model",
          type: "select" as const,
          currentValue:
            selectedSession?.model ?? profileFromDetail(connection.detail),
          options: [
            {
              value:
                selectedSession?.model ?? profileFromDetail(connection.detail),
              name: selectedSession?.modelDisplay ?? "모델 확인 중…",
            },
          ],
        },
        ...selectedConfigOptions,
      ];
  const recentWorkspaces = useMemo(
    () => [
      ...new Set(sessions.map((session) => session.workspace).filter(Boolean)),
    ],
    [sessions],
  );

  const selectSession = useCallback((sessionId: string): void => {
    setSelectedId(sessionId);
    setTranscripts((current) =>
      current[sessionId]
        ? cacheTranscript(current, sessionId, current[sessionId])
        : current,
    );
  }, []);

  const createSession = useCallback(
    (input: {
      title: string;
      workspace: string;
      isolation?: "workspace" | "worktree";
      worktreeBranch?: string;
    }): void => {
      const draftId = `draft-${crypto.randomUUID()}`;
      const draft: AgentSession = {
        id: draftId,
        title: input.title,
        subtitle: directoryName(input.workspace),
        workspace: input.workspace,
        runtime: "gjc",
        status: "starting",
        updatedAt: "now",
        pinned: false,
        unread: false,
        accent: "#ff8a34",
        ownership: "gajae",
        attachment: "attached",
      };
      setSessions((current) => [draft, ...current]);
      setSelectedId(draftId);
      setTranscripts((current) => cacheTranscript(current, draftId, []));
      setNewSessionOpen(false);
      setAppError("");

      const creation = backend.createSession({
        runtime: "gjc",
        title: input.title,
        workspace: input.workspace,
        isolation: input.isolation ?? "workspace",
        worktreeBranch: input.worktreeBranch,
      });
      pendingSessions.current.set(draftId, creation);
      void creation
        .then((session) => {
          setSessions((current) => [
            session,
            ...current.filter(
              (item) => item.id !== draftId && item.id !== session.id,
            ),
          ]);
          setSelectedId((current) =>
            current === draftId ? session.id : current,
          );
          setTranscripts((current) => {
            const next = { ...current };
            const items = current[session.id] ?? current[draftId] ?? [];
            delete next[draftId];
            return cacheTranscript(next, session.id, items);
          });
        })
        .catch((error) => {
          setSessions((current) =>
            current.map((session) =>
              session.id === draftId
                ? { ...session, status: "failed" }
                : session,
            ),
          );
          setAppError(humanErrorMessage(error));
        });
    },
    [backend],
  );

  useEffect(() => {
    const unsubscribe = window.agentControlDesktop?.onSessionShortcut(
      (shortcut) => {
        if (shortcut.type === "abort") {
          const session = selectedSessionRef.current;
          if (session) void cancelRun(session.id);
          return;
        }
        if (shortcut.type === "new") {
          const workspace = selectedSession?.workspace || connection.workspace;
          if (workspace) createSession({ title: "새 Gajae 세션", workspace });
          else setNewSessionOpen(true);
          return;
        }
        const session = shortcutSessions[shortcut.index];
        if (session) selectSession(session.id);
      },
    );
    const unsubscribeAbort = window.agentControlDesktop?.onAbortRun(() => {
      const session = selectedSessionRef.current;
      if (session) void cancelRun(session.id);
    });
    function abortWithEscape(event: globalThis.KeyboardEvent): void {
      if (
        (event.key !== "Escape" && event.key !== "Esc") ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey
      )
        return;
      if (searchOpen || settingsOpen || newSessionOpen || deleteCandidate)
        return;
      event.preventDefault();
      const session = selectedSessionRef.current;
      if (session) void cancelRun(session.id);
    }
    window.addEventListener("keydown", abortWithEscape, true);
    return () => {
      unsubscribe?.();
      unsubscribeAbort?.();
      window.removeEventListener("keydown", abortWithEscape, true);
    };
  }, [
    connection.workspace,
    createSession,
    deleteCandidate,
    newSessionOpen,
    searchOpen,
    selectSession,
    selectedSession?.workspace,
    settingsOpen,
    shortcutSessions,
  ]);

  async function resolveSessionId(sessionId: string): Promise<string> {
    return (await pendingSessions.current.get(sessionId))?.id ?? sessionId;
  }

  async function sendMessage(
    sessionId: string,
    input: MessageInput,
  ): Promise<MessageDelivery | undefined> {
    try {
      return await backend.sendMessage(
        await resolveSessionId(sessionId),
        input,
      );
    } catch (error) {
      setAppError(humanErrorMessage(error));
      return undefined;
    }
  }

  async function setSessionConfig(
    sessionId: string,
    configId: string,
    value: string,
  ): Promise<void> {
    const previousValue = configOptions[sessionId]?.find(
      (option) => option.id === configId,
    )?.currentValue;
    setConfigOptions((current) => ({
      ...current,
      [sessionId]: (current[sessionId] ?? []).map((option) =>
        option.id === configId ? { ...option, currentValue: value } : option,
      ),
    }));
    try {
      await backend.setSessionConfig(
        await resolveSessionId(sessionId),
        configId,
        value,
      );
    } catch (error) {
      if (previousValue !== undefined) {
        setConfigOptions((current) => ({
          ...current,
          [sessionId]: (current[sessionId] ?? []).map((option) =>
            option.id === configId && option.currentValue === value
              ? { ...option, currentValue: previousValue }
              : option,
          ),
        }));
      }
      setAppError(error instanceof Error ? error.message : String(error));
    }
  }

  async function cycleThinking(sessionId: string): Promise<void> {
    try {
      const level = await backend.cycleThinking(
        await resolveSessionId(sessionId),
      );
      if (!level) {
        setAppError("현재 모델은 추론 effort 전환을 지원하지 않습니다.");
      }
    } catch (error) {
      setAppError(humanErrorMessage(error));
    }
  }

  async function compactSession(sessionId: string): Promise<void> {
    try {
      await backend.compactSession(await resolveSessionId(sessionId));
    } catch (error) {
      setAppError(humanErrorMessage(error));
    }
  }

  async function cancelRun(sessionId: string): Promise<void> {
    try {
      await backend.cancelRun(await resolveSessionId(sessionId));
    } catch (error) {
      setAppError(humanErrorMessage(error));
    }
  }

  async function flushQueuedNow(sessionId: string): Promise<void> {
    try {
      const resolved = await resolveSessionId(sessionId);
      await backend.flushQueuedNow(resolved);
    } catch (error) {
      setAppError(humanErrorMessage(error));
    }
  }

  async function renameWorkspace(label: string): Promise<void> {
    try {
      const saved =
        await window.agentControlDesktop?.settings.setWorkspaceLabel(label);
      if (saved) setWorkspaceLabel(saved);
    } catch (error) {
      setAppError(error instanceof Error ? error.message : String(error));
    }
  }

  async function renameSession(
    sessionId: string,
    title: string,
  ): Promise<void> {
    await backend.renameSession(await resolveSessionId(sessionId), title);
  }

  async function forkSession(session: AgentSession): Promise<void> {
    try {
      const fork = await backend.forkSession({
        sourceSessionId: await resolveSessionId(session.id),
        title: `${session.title} (포크)`,
      });
      setSessions((current) => [
        fork,
        ...current.filter((item) => item.id !== fork.id),
      ]);
      setSelectedId(fork.id);
      setTranscripts((current) => cacheTranscript(current, fork.id, []));
      setSearchQuery("");
    } catch (error) {
      setAppError(error instanceof Error ? error.message : String(error));
    }
  }

  async function deleteSession(sessionId: string): Promise<void> {
    try {
      await backend.deleteSession(await resolveSessionId(sessionId));
      setDeleteCandidate(null);
    } catch (error) {
      setAppError(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <div className="app-shell">
      <Sidebar
        sessions={filteredSessions}
        connection={connection}
        selectedId={selectedId}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        onSearchOpen={() => setSearchOpen(true)}
        onSelect={selectSession}
        onCreate={() => setNewSessionOpen(true)}
        onFork={(session) => void forkSession(session)}
        onRename={(sessionId, title) => void renameSession(sessionId, title)}
        onDelete={setDeleteCandidate}
        onSettings={() => setSettingsOpen(true)}
        workspaceLabel={workspaceLabel}
        onWorkspaceLabelChange={(label) => void renameWorkspace(label)}
        updateStatus={updateStatus}
        updateBusy={Boolean(updateBusy)}
        onUpdate={() => void installUpdate()}
      />

      {selectedSession ? (
        <main className="workspace">
          <header className="chat-header">
            <div className="chat-identity">
              <span className="header-avatar">
                <img src={gajaeIconUrl} alt="" />
              </span>
              <span>
                <strong>{selectedSession.title}</strong>
                <small>
                  <span
                    className={`presence-inline presence-inline--${selectedSession.phase === "compacting" ? "compacting" : selectedSession.status}`}
                  />
                  {statusLabel(selectedSession.status, selectedSession.phase)}
                  {selectedSession.attachment === "terminal-only" && (
                    <span className="chat-sync">터미널 읽기 전용 동기화</span>
                  )}
                  {(selectedGit?.branch ||
                    selectedSession.worktree?.branch) && (
                    <span
                      className="chat-branch"
                      title={`${selectedGit?.workspace ?? selectedSession.workspace}의 현재 Git 브랜치`}
                    >
                      <GitBranch size={11} />
                      {selectedGit?.branch || selectedSession.worktree?.branch}
                    </span>
                  )}
                </small>
              </span>
            </div>
            <div className="chat-header__actions">
              <button
                className={`icon-button ${diffOpen ? "is-active" : ""}`}
                type="button"
                title="변경 파일"
                onClick={() => {
                  setDiffOpen((open) => !open);
                  if (!diffOpen) void refreshDiff();
                }}
              >
                <FolderGit2 size={18} />
              </button>
              <button
                className={`icon-button ${inspectorOpen ? "is-active" : ""}`}
                type="button"
                title="세션 정보"
                onClick={() => setInspectorOpen((open) => !open)}
              >
                <PanelRight size={18} />
              </button>
              {(connection.state === "disconnected" ||
                connection.state === "error") && (
                <button
                  className="button-secondary"
                  type="button"
                  onClick={() => void backend.reconnect().then(setConnection)}
                >
                  재연결
                </button>
              )}
            </div>
          </header>

          <div className="workspace-body">
            <section
              className={`conversation conversation--${selectedSession.phase === "compacting" ? "compacting" : selectedSession.status}`}
            >
              <RecentRequestStrip
                items={selectedTranscript}
                onReveal={(itemId) =>
                  setRevealTarget({ sessionId: selectedSession.id, itemId })
                }
              />
              <Transcript
                items={selectedTranscript}
                compacting={selectedSession.phase === "compacting"}
                revealItemId={
                  revealTarget?.sessionId === selectedSession.id
                    ? revealTarget.itemId
                    : undefined
                }
                onRevealComplete={completeReveal}
                onResolveTool={resolveToolCall}
                onReadArtifact={readArtifact}
                onPreviewFile={previewFile}
              />
              <div className="composer-wrap">
                <GoalProgressRow
                  goal={goal}
                  busy={goalBusy}
                  onOperate={(operation) => void operateGoal(operation)}
                />
                <Composer
                  sessionId={selectedSession.id}
                  running={
                    selectedSession.phase === "compacting" ||
                    selectedSession.status === "running" ||
                    selectedSession.status === "waiting" ||
                    transcriptHasLiveWork ||
                    transcriptHasLiveWork
                  }
                  sessionTitle={selectedSession.title}
                  workspace={selectedSession.workspace}
                  workspaces={recentWorkspaces}
                  commands={selectedCommands}
                  configOptions={composerConfigOptions}
                  modelDisplay={selectedSession.modelDisplay}
                  thinking={selectedSession.thinking}
                  usagePercent={selectedSession.usagePercent}
                  onSend={(input) => sendMessage(selectedSession.id, input)}
                  onCancel={() => void cancelRun(selectedSession.id)}
                  onFlushQueued={() => flushQueuedNow(selectedSession.id)}
                  onCompact={() => void compactSession(selectedSession.id)}
                  onNewSession={() =>
                    createSession({
                      title: "새 Gajae 세션",
                      workspace: selectedSession.workspace,
                    })
                  }
                  onWorkspaceChange={(workspace) =>
                    createSession({ title: "새 Gajae 세션", workspace })
                  }
                  onConfigChange={(configId, value) =>
                    void setSessionConfig(selectedSession.id, configId, value)
                  }
                  onCycleThinking={() => void cycleThinking(selectedSession.id)}
                />
              </div>
            </section>
            {inspectorOpen && (
              <Inspector
                session={selectedSession}
                transcript={selectedTranscript}
                liveSubagents={liveSubagents}
                onClose={() => setInspectorOpen(false)}
              />
            )}
            {diffOpen && (
              <DiffPanel
                session={selectedSession}
                backend={backend}
                diff={diff}
                loading={diffLoading}
                onRefresh={() => void refreshDiff()}
                onClose={() => setDiffOpen(false)}
              />
            )}
          </div>
        </main>
      ) : (
        <main className="workspace workspace--empty">
          <span className="workspace-empty__mark">
            <img src={gajaeIconUrl} alt="" />
          </span>
          <h1>선택된 Gajae 세션이 없습니다</h1>
          <button
            className="button-primary"
            type="button"
            onClick={() => setNewSessionOpen(true)}
          >
            <Plus size={16} /> 새 세션
          </button>
        </main>
      )}

      {appError && (
        <div className="app-error">
          <span>{appError}</span>
          <button type="button" onClick={() => setAppError("")}>
            <X size={14} />
          </button>
        </div>
      )}
      {searchOpen && (
        <GlobalSearchDialog
          query={searchQuery}
          onQueryChange={setSearchQuery}
          onClose={() => setSearchOpen(false)}
          onPick={(result) => {
            setRevealTarget({
              sessionId: result.sessionId,
              itemId: result.itemId,
            });
            selectSession(result.sessionId);
            setSearchOpen(false);
            setSearchQuery("");
          }}
        />
      )}
      {newSessionOpen && (
        <NewSessionDialog
          defaultWorkspace={connection.workspace}
          onCancel={() => setNewSessionOpen(false)}
          onCreate={createSession}
        />
      )}
      {settingsOpen && (
        <SettingsDialog
          connection={connection}
          onClose={() => setSettingsOpen(false)}
          onSaved={(preferences) => {
            setWorkspaceLabel(preferences.workspaceLabel);
            setConnection((current) => ({
              ...current,
              workspace: preferences.workspace,
            }));
          }}
          updateStatus={updateStatus}
          updateBusy={updateBusy}
          updateError={updateError}
          onCheckUpdate={() => void checkForUpdate()}
          onInstallUpdate={() => void installUpdate()}
        />
      )}
      {deleteCandidate && (
        <DeleteSessionDialog
          session={deleteCandidate}
          onCancel={() => setDeleteCandidate(null)}
          onConfirm={() => void deleteSession(deleteCandidate.id)}
        />
      )}
    </div>
  );
}
