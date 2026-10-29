import type { AppUpdateStatus } from "./app-update.js";
import type { DesktopIntegrationPreferences } from "./desktop-integration.js";
import type { EnvironmentReport } from "./environment-check.js";

export type RuntimeKind = "gjc" | "hermes";

export type SessionStatus =
  "starting" | "idle" | "running" | "waiting" | "failed" | "unknown";

export type ConnectionState =
  "connecting" | "connected" | "disconnected" | "error";

export type GjcPermissionHandling = "prompt" | "auto" | "always-allow";

export type NotificationCategory =
  | "completed"
  | "permission"
  | "failed"
  | "message";

/** macOS built-in notification sounds; `default` uses the system sound. */
export const NOTIFICATION_SOUNDS = [
  "default",
  "none",
  "Glass",
  "Ping",
  "Pop",
  "Submarine",
] as const;

export type NotificationSound = (typeof NOTIFICATION_SOUNDS)[number];

export interface NotificationEventPreference {
  enabled: boolean;
  sound: NotificationSound;
}

export type NotificationPreferences = Record<
  NotificationCategory,
  NotificationEventPreference
>;

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  completed: { enabled: true, sound: "default" },
  permission: { enabled: true, sound: "default" },
  failed: { enabled: true, sound: "default" },
  // The incidental per-message ping stays quiet by default; it was already
  // suppressed while the window had focus.
  message: { enabled: true, sound: "none" },
};

const NOTIFICATION_KEYS: readonly NotificationCategory[] = [
  "completed",
  "permission",
  "failed",
  "message",
];

/**
 * Fills a missing or malformed event setting from the defaults.
 *
 * Display-only preferences are persisted field by field, so an older settings
 * file has no key at all. Missing means default; only a present non-object is
 * discarded rather than failing the whole settings load.
 */
export function parseNotificationPreferences(
  value: unknown,
): NotificationPreferences {
  const candidate =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const parsed = {} as NotificationPreferences;
  for (const key of NOTIFICATION_KEYS) {
    const raw =
      candidate[key] && typeof candidate[key] === "object"
        ? (candidate[key] as Record<string, unknown>)
        : {};
    const sound = NOTIFICATION_SOUNDS.includes(raw.sound as NotificationSound)
      ? (raw.sound as NotificationSound)
      : DEFAULT_NOTIFICATION_PREFERENCES[key].sound;
    parsed[key] = {
      enabled:
        typeof raw.enabled === "boolean"
          ? raw.enabled
          : DEFAULT_NOTIFICATION_PREFERENCES[key].enabled,
      sound,
    };
  }
  return parsed;
}

export function notificationDelivery(
  preference: NotificationEventPreference,
): { silent: boolean; sound?: string } {
  if (preference.sound === "none") return { silent: true };
  if (preference.sound === "default") return { silent: false };
  return { silent: false, sound: preference.sound };
}

export type ToolViewMode = "basic" | "reasoning" | "detailed";

/** Resolved UI language used by the desktop host for native text. */
export type UiLanguage = "ko" | "en";

/**
 * The conversation density new and upgraded windows start with.
 *
 * `reasoning` keeps the previous default: tool cards are shown and thought cards
 * follow the separate reasoning-card preference.
 */
export const DEFAULT_TOOL_VIEW_MODE: ToolViewMode = "reasoning";

export function isToolViewMode(value: unknown): value is ToolViewMode {
  return value === "basic" || value === "reasoning" || value === "detailed";
}

export interface AgentControlPreferences {
  workspace: string;
  workspaceLabel: string;
  modelPreset: string;
  permissionHandling: GjcPermissionHandling;
  gjcExecutable: string;
  notificationPreferences: NotificationPreferences;
  /** Power, menu bar, Dock and global input behavior. */
  desktopIntegration: DesktopIntegrationPreferences;
  /** Resolved language the desktop host uses for native dialogs and notifications. */
  language: UiLanguage;
  /**
   * How tool activity and reasoning render in the conversation.
   *
   * Saved as a window-wide reading preference so a reload or a relaunch keeps the
   * density the user chose instead of falling back to `reasoning`.
   */
  toolViewMode: ToolViewMode;
  /**
   * What Enter does while a turn is running and nothing is held yet.
   *
   * `queue` preserves the existing behavior: hold the text and release it when
   * the turn ends. `steer` hands it to the runtime as a steer at the next turn
   * boundary. Explicit `/queue` and `/steer` prefixes always win.
   */
  runningSubmission: "queue" | "steer";
  /**
   * Whether reasoning (thought) cards render expanded.
   *
   * One value for the whole window instead of a flag per card: a card is re-created
   * as the transcript streams, so state owned by the card died with it and every new
   * thought arrived collapsed again.
   */
  thoughtsExpanded: boolean;
}

/**
 * The preset new sessions start from when nothing narrower is known.
 *
 * It travels on the connection as a field of its own rather than being scraped
 * out of `detail`, which is copy the sidebar and the offline strip print.
 */
export const DEFAULT_MODEL_PRESET = "codex-medium";

/** Profiles GJC ships, which work without an entry in models.yml. */
export const BUILT_IN_MODEL_PRESETS = [
  "codex-eco",
  DEFAULT_MODEL_PRESET,
  "codex-pro",
] as const;

export interface BackendConnection {
  state: ConnectionState;
  backend: RuntimeKind | "mock";
  label: string;
  detail: string;
  workspace: string;
  modelPreset?: string;
  version?: string;
  generation?: number;
}

export type SessionOwnership = "gajae" | "external" | "available";
export type SessionAttachment =
  "attached" | "attachable" | "terminal-only" | "recovering";

export interface ManagedWorktree {
  sourceWorkspace: string;
  path: string;
  branch: string;
  managed: true;
}

export interface EffectiveRuntimeState {
  modelProfile?: string;
  model?: string;
  thinking?: string;
  mode?: string;
  permissionHandling: GjcPermissionHandling;
  mcpServers: string[];
  skills: string[];
  rules: string[];
  tools: string[];
  gjcVersion?: string;
  refreshedAt: string;
}

/** The GitHub work a session was started from on the repository screen. */
export type SessionWorkLink =
  | { kind: "issue"; number: number; url: string }
  | { kind: "pull"; number: number; url: string }
  | { kind: "ci"; branch: string; url: string };

const WORK_LINK_BRANCH = /^[A-Za-z0-9](?:[A-Za-z0-9._/-]*[A-Za-z0-9])?$/u;

/** A work link read from IPC or from disk, or undefined when it is not one. */
export function parseSessionWorkLink(value: unknown): SessionWorkLink | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  const url = candidate.url;
  if (typeof url !== "string" || url.length > 2048) return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.hostname !== "github.com") return undefined;
  } catch {
    return undefined;
  }
  if (candidate.kind === "issue" || candidate.kind === "pull") {
    const number = candidate.number;
    if (typeof number !== "number" || !Number.isSafeInteger(number) || number <= 0)
      return undefined;
    return { kind: candidate.kind, number, url };
  }
  if (candidate.kind === "ci") {
    const branch = candidate.branch;
    if (typeof branch !== "string" || branch.length > 256 || !WORK_LINK_BRANCH.test(branch))
      return undefined;
    return { kind: "ci", branch, url };
  }
  return undefined;
}

export interface AgentSession {
  id: string;
  title: string;
  subtitle: string;
  workspace: string;
  runtime: RuntimeKind;
  status: SessionStatus;
  /** Monotonic lifecycle revision used to reject stale status snapshots. */
  runRevision?: number;
  updatedAt: string;
  /**
   * When the row last changed, with the resolution the label above throws away.
   *
   * `updatedAt` is what the rail prints ("now", "8m", "2h"), so the renderer
   * cannot compare it; this is the sortable twin. Rows the backend never
   * timestamped -- mock rows and drafts -- leave it unset and keep their list
   * order instead.
   */
  updatedAtMs?: number;
  /**
   * The session this row was forked from, when the runtime recorded one.
   *
   * GJC writes the source id into the forked transcript's envelope
   * (`parentSession`), which is the only place the link survives: the broker's
   * session list reports identity and liveness, not lineage. Rows without it are
   * roots, and the rail leaves them top-level.
   */
  parentId?: string;
  pinned: boolean;
  unread: boolean;
  accent: string;
  phase?: string;
  mode?: string;
  model?: string;
  modelDisplay?: string;
  thinking?: string;
  serviceTier?: string;
  usagePercent?: number;
  usagePending?: boolean;
  ownership: SessionOwnership;
  attachment: SessionAttachment;
  worktree?: ManagedWorktree;
  workLink?: SessionWorkLink;
  runtimeState?: EffectiveRuntimeState;
}

/**
 * A past session on disk, whether or not it is still running.
 *
 * Discovery deliberately drops sessions the broker no longer reports as live, so
 * they cannot be listed as rows. They are still resumable -- this is what
 * `gjc --resume <id>` opens -- so they are offered separately.
 */
export interface HistorySession {
  id: string;
  title: string;
  workspace: string;
  updatedAt: string;
  messageCount: number;
  live: boolean;
  /**
   * The session this one was forked from, when its transcript recorded one.
   *
   * Same envelope field the rail reads. The picker is a recency list, so a fork is
   * marked in place rather than reordered under its source; a source older than the
   * picker's window still names where the fork came from.
   */
  parentId?: string;
}

export interface AgentCommand {
  name: string;
  description: string;
  hint?: string;
}

export interface AgentConfigOptionValue {
  value: string;
  name: string;
  description?: string;
  group?: string;
}

export interface AgentConfigOption {
  id: string;
  name: string;
  category?: string;
  type: "select" | "boolean";
  currentValue: string | boolean;
  options?: AgentConfigOptionValue[];
}

export interface ImageAttachment {
  id: string;
  name: string;
  mimeType: string;
  token?: string;
  data: string;
}

export interface FileAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  token: string;
}

export interface MessageInput {
  text: string;
  images: ImageAttachment[];
  files: FileAttachment[];
}

export interface ChatMessage {
  id: string;
  kind: "message";
  sessionId: string;
  role: "user" | "assistant";
  content: string;
  images?: ImageAttachment[];
  createdAt: string;
  streaming?: boolean;
}

export interface ToolActivity {
  id: string;
  kind: "tool";
  sessionId: string;
  name: string;
  description: string;
  command?: string;
  status:
    // GJC distinguishes a call that is queued from one that is executing, and sends
    // both: a tool arrives `pending` and can sit there for seconds before it
    // reports `in_progress`. Collapsing them showed a spinner and 작업 중 for work
    // that had not started.
    | "pending"
    | "running"
    | "completed"
    | "failed"
    | "cancelled"
    | "approval-required"
    | "approved"
    | "denied";
  createdAt: string;
  output?: string;
  inputArtifactId?: string;
  outputArtifactId?: string;
  artifactRefs?: string[];
  permissionOptions?: PermissionOption[];
  diff?: string;
  targetPath?: string;
  images?: ToolImage[];
  subagents?: SubagentSnapshot[];
}

export interface ToolImage {
  mimeType: string;
  /** Empty until a content-addressed blob is resolved into an inline data URL. */
  dataUrl: string;
  blobId?: string;
}

export type PermissionOptionKind =
  "allow_once" | "allow_always" | "reject_once" | "reject_always";

export interface PermissionOption {
  optionId: string;
  kind: PermissionOptionKind;
  name: string;
}

export const TRANSCRIPT_BODY_ARTIFACT_PREFIX = "gajae-transcript-body-";

export interface ArtifactContent {
  artifactId: string;
  text: string;
  complete: boolean;
  totalBytes: number;
}

export interface GeneratedFilePreview {
  path: string;
  name: string;
  kind: "image" | "markdown" | "text" | "html" | "pdf" | "unsupported";
  mimeType: string;
  content?: string;
  dataUrl?: string;
  size: number;
}

export interface ChangedFile {
  id: string;
  path: string;
  patch: string;
}

export interface DiffSnapshot {
  sessionId: string;
  workspace: string;
  files: ChangedFile[];
  refreshedAt: string;
  error?: string;
}

export interface GitFileStatus {
  path: string;
  index: string;
  workingTree: string;
}

export interface GitStatusSnapshot {
  workspace: string;
  branch: string;
  upstream?: string;
  ahead: number;
  behind: number;
  files: GitFileStatus[];
}

export interface McpServerSummary {
  name: string;
  scope: "user" | "project";
  type: "stdio" | "http" | "sse";
  enabled: boolean;
  status?: string;
  command?: string;
  url?: string;
}

export interface McpServerInput {
  name: string;
  scope: "user" | "project";
  type: "stdio" | "http" | "sse";
  command?: string;
  url?: string;
  args: string[];
  cwd?: string;
}

export interface SkillSummary {
  name: string;
  description: string;
  source: string;
  path?: string;
}

export interface PluginSummary {
  name: string;
  version?: string;
  source: string;
  enabled: boolean;
  enabledFeatures: string[];
}

export interface UsageModelSummary {
  model: string;
  provider: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheRate: number;
  cost: number;
}

export interface UsageStats {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheRate: number;
  cost: number;
  models: UsageModelSummary[];
}

export interface ManagementSnapshot {
  mcpServers: McpServerSummary[];
  skills: SkillSummary[];
  plugins: PluginSummary[];
  usage: UsageStats;
  refreshedAt: string;
}

export interface NoticeActivity {
  id: string;
  kind: "notice";
  sessionId: string;
  title: string;
  content: string;
  tone: "neutral" | "success" | "warning";
  createdAt: string;
}

export interface ThoughtActivity {
  id: string;
  kind: "thought";
  sessionId: string;
  content: string;
  createdAt: string;
  streaming: boolean;
}

export interface PlanActivity {
  id: string;
  kind: "plan";
  sessionId: string;
  entries: Array<{
    content: string;
    status: "pending" | "in_progress" | "completed";
  }>;
  createdAt: string;
}

export interface CompactionActivity {
  id: string;
  kind: "compaction";
  sessionId: string;
  tokensBefore: number;
  summary: string;
  shortSummary?: string;
  createdAt: string;
}

export interface BranchSummaryActivity {
  id: string;
  kind: "branch_summary";
  sessionId: string;
  summary: string;
  createdAt: string;
}

/**
 * Lifecycle of one gjc ask question.
 *
 * `rejected` stays open: the host refused the body, and the same card takes
 * another answer. Quarantined and accepted diagnostic rows are not answerable.
 */
export type QuestionStatus =
  | "pending"
  | "answered"
  | "cancelled"
  | "timeout"
  | "rejected";

export type QuestionGateTag = "pending" | "quarantined" | "accepted";

export interface QuestionOption {
  label: string;
  /** gjc marks the recommended choice with `description: "recommended"`. */
  recommended?: boolean;
}

/**
 * What the user sends. The controller turns this into the gate answer schema.
 *
 * `clarify` is the third schema shape. A non-blank `custom` is the free-text
 * path. Otherwise `selected` is the chosen labels.
 */
export interface QuestionSubmission {
  selected: string[];
  custom?: string;
  clarify?: string;
}

export interface QuestionActivity {
  /** gjc `gate_id`. The list row's `pending:<gate_id>` id is not this. */
  id: string;
  kind: "question";
  sessionId: string;
  /** One line, from `context.title` or `context.prompt`. */
  question: string;
  options: QuestionOption[];
  multi: boolean;
  status: QuestionStatus;
  createdAt: string;
  /** False for quarantined and accepted diagnostic rows. */
  answerable: boolean;
  tag: QuestionGateTag;
  /** Sent back as `expectedSessionId` on `workflow.gate_answer`. */
  expectedSessionId: string;
  /** A ralplan final-plan approval gate. It is answered like a question. */
  approval?: true;
  /** Chosen labels or free text, once this window has an answer to show. */
  answerSummary?: string;
  /** Schema rejection. The card stays open. */
  error?: string;
  runtimeTurnId?: string;
}

/**
 * One item of a todo snapshot, as the runtime's `todo.list` returned it.
 *
 * The status stays a plain string. The runtime's vocabulary is wider than this window
 * knows, so an unrecognized value has to reach the card as the runtime wrote it rather
 * than being folded into one of the statuses the app renders.
 */
export interface TodoSnapshotTask {
  content: string;
  status?: string;
  notes?: string[];
}

/** A named group of items in a todo snapshot. */
export interface TodoSnapshotPhase {
  name?: string;
  tasks: TodoSnapshotTask[];
}

export interface SystemNoticeActivity {
  id: string;
  kind: "system";
  sessionId: string;
  title: string;
  content: string;
  createdAt: string;
  /**
   * Where the row's content came from: a recorded custom message's `customType`,
   * or the runtime query an app-owned snapshot row was read through.
   *
   * An unrecognized value stays exactly as recorded rather than being classified
   * into a known kind of activity.
   */
  sourceType?: string;
  /**
   * The runtime recorded this activity as `display: false`.
   *
   * The app's visibility policy keeps recorded activity readable, so such a row is
   * still shown as system material; this flag is retained so the card can say the
   * runtime marked it hidden instead of presenting it as something it meant to show.
   */
  runtimeHidden?: boolean;
  /**
   * The phases behind an app-owned todo snapshot (`sourceType: "todo.list"`), kept in
   * the shape the runtime returned them so the card can render the list itself instead
   * of the snapshot's raw JSON.
   *
   * Presence means the store answered, which is why a read that failed has to leave this
   * out: the card renders a row with no phases as prose, and an empty list as a store that
   * answered with nothing. Reporting an unreadable store as `todoPhases: []` would claim
   * the work was finished or never registered.
   */
  todoPhases?: TodoSnapshotPhase[];
  /**
   * When that snapshot was read, as the runtime's own ISO timestamp. The card shows it
   * as a clock time; a value that does not parse is left out rather than guessed at.
   */
  observedAt?: string;
}

export type TranscriptItem =
  | ChatMessage
  | ToolActivity
  | NoticeActivity
  | ThoughtActivity
  | PlanActivity
  | CompactionActivity
  | BranchSummaryActivity
  | SystemNoticeActivity
  | QuestionActivity;

/**
 * A safety-net read of a transcript the caller already has.
 *
 * `full` is the current synchronization window. `patch` is only rows that
 * changed or were appended within that window, in their current order.
 */
export type TranscriptChange =
  | { kind: "full"; items: TranscriptItem[] }
  | { kind: "patch"; items: TranscriptItem[] };

export interface TranscriptPageRequest {
  beforeId?: string;
  aroundId?: string;
}

export interface TranscriptRequestSummary {
  id: string;
  text: string;
  createdAt: string;
}

export interface TranscriptPage {
  items: TranscriptItem[];
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
  firstId?: string;
  lastId?: string;
  requests: TranscriptRequestSummary[];
}

export type AgentEvent =
  | { type: "connection.updated"; connection: BackendConnection }
  | { type: "session.created"; session: AgentSession }
  | { type: "session.updated"; session: AgentSession }
  | { type: "session.deleted"; sessionId: string }
  | { type: "transcript.appended"; item: TranscriptItem }
  | { type: "transcript.invalidated"; sessionId: string }
  | { type: "transcript.synced"; sessionId: string; items: TranscriptItem[] }
  | {
      type: "message.delta";
      sessionId: string;
      messageId: string;
      delta: string;
      streaming: boolean;
    }
  | { type: "message.updated"; message: ChatMessage }
  | {
      type: "thought.delta";
      sessionId: string;
      thoughtId: string;
      delta: string;
      streaming: boolean;
    }
  | { type: "plan.updated"; plan: PlanActivity }
  | { type: "session.commands"; sessionId: string; commands: AgentCommand[] }
  | { type: "session.config"; sessionId: string; options: AgentConfigOption[] }
  | { type: "tool.updated"; tool: ToolActivity }
  | { type: "question.updated"; question: QuestionActivity }
  | {
      type: "session.activity";
      sessionId: string;
      /** Session title, so a notification can name the work that finished. */
      title: string;
      unread: boolean;
      category: "completed" | "failed" | "permission" | "message" | "recovered";
    }
  | {
      type: "runtime.updated";
      sessionId: string;
      runtimeState: EffectiveRuntimeState;
    };

/**
 * The session an event belongs to. Search invalidation and remote replay repair
 * must use the same rule: several events carry the id inside their row, not at
 * the envelope's top level.
 */
export function eventSessionId(event: AgentEvent): string | undefined {
  switch (event.type) {
    case "connection.updated":
      return undefined;
    case "session.created":
    case "session.updated":
      return event.session.id;
    case "transcript.appended":
      return event.item.sessionId;
    case "transcript.invalidated":
      return event.sessionId;
    case "message.updated":
      return event.message.sessionId;
    case "plan.updated":
      return event.plan.sessionId;
    case "tool.updated":
      return event.tool.sessionId;
    case "question.updated":
      return event.question.sessionId;
    default:
      return "sessionId" in event && typeof event.sessionId === "string"
        ? event.sessionId
        : undefined;
  }
}

export interface CreateSessionInput {
  title?: string;
  workspace: string;
  runtime: RuntimeKind;
  isolation: "workspace" | "worktree";
  worktreeBranch?: string;
  /**
   * The worktree checks out a branch that already exists, locally or on exactly
   * one remote. Without it a missing branch is created from HEAD.
   */
  worktreeBranchExisting?: boolean;
  workLink?: SessionWorkLink;
}

export interface ForkSessionInput {
  sourceSessionId: string;
  title?: string;
}

export interface ToolDecision {
  optionId: string;
}

export interface QueuedMessage {
  id: string;
  text: string;
  mode: "steer" | "followUp";
  label: string;
}

export type MessageDelivery =
  | "prompt"
  | "steer"
  | { kind: "not_executed"; detail: string };

export interface GoalSnapshot {
  enabled: boolean;
  mode?: "active" | "paused" | "complete";
  objective?: string;
  completed: number;
  total: number;
  /** Present only when the session advertises `session.progress` and a read succeeded. */
  progress?: SessionProgress;
}

/**
 * The parts of gjc's `session.progress` snapshot (`gjc.project_progress.v1`)
 * this window shows: the ultragoal story ledger and the active workflow HUDs.
 */
export interface SessionProgress {
  ultragoal: UltragoalProgress | null;
  workflows: WorkflowStatus[];
  /** Active workflows the runtime left out of its bounded list. */
  omittedWorkflows: number;
}

export interface UltragoalProgress {
  objective: string;
  counts: {
    total: number;
    complete: number;
    active: number;
    pending: number;
    blocked: number;
    superseded: number;
  };
  stories: UltragoalStory[];
  omittedStories: number;
  /** The active story, else the next pending one (`activeWork.story`). */
  current: { id: string; title: string } | null;
}

export interface UltragoalStory {
  id: string;
  title: string;
  /**
   * Kept as the runtime wrote it. gjc 0.19.0 sends pending, active, complete,
   * failed, blocked, review_blocked or superseded; a newer value is shown raw.
   */
  status: string;
  verificationReceipt: boolean;
}

export type WorkflowChipSeverity = "info" | "warning" | "blocked" | "error" | "success";

export interface WorkflowChip {
  label: string;
  value: string | null;
  severity: WorkflowChipSeverity | null;
}

/** One active workflow HUD (`activeWork.workflows`), such as ralplan or autoresearch. */
export interface WorkflowStatus {
  skill: string;
  phase: string;
  summary: string | null;
  chips: WorkflowChip[];
  /** This workflow's entry in `verification.reviewVerdicts`. */
  verdict: string | null;
}

export interface SubagentSnapshot {
  id: string;
  label: string;
  status: "running" | "completed" | "failed" | "waiting";
  role?: string;
  objective?: string;
  detail?: string;
}

export type GoalOperation = "pause" | "resume" | "complete" | "drop";

export interface GjcDesktopBridge {
  getConnection(): Promise<BackendConnection>;
  listSessions(): Promise<AgentSession[]>;
  createSession(input: CreateSessionInput): Promise<AgentSession>;
  forkSession(input: ForkSessionInput): Promise<AgentSession>;
  resumeSession(sessionId: string): Promise<AgentSession>;
  listHistorySessions(): Promise<HistorySession[]>;
  openHistorySession(sessionId: string): Promise<AgentSession>;
  renameSession(sessionId: string, title: string): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
  hideSession(sessionId: string): Promise<void>;
  getTranscript(sessionId: string): Promise<TranscriptItem[]>;
  getTranscriptPage(
    sessionId: string,
    request?: TranscriptPageRequest,
  ): Promise<TranscriptPage>;
  /**
   * Safety-net read that sends changed rows instead of the whole conversation.
   * The first read is `full`.
   */
  getTranscriptChanges(sessionId: string): Promise<TranscriptChange>;
  /** Cheap durable-file revision used by the selected-transcript safety net. */
  getTranscriptRevision(sessionId: string): Promise<string | undefined>;
  /**
   * Sessions whose transcripts a desktop replay gap may re-read. The renderer
   * reports the selected session and the transcripts it has cached.
   */
  watchTranscripts(sessionIds: readonly string[]): void;
  /**
   * Loads command/todo context when a session opens or its palette is requested.
   *
   * Repeated requests inside the reuse window are served from the loaded context;
   * this is never part of a transcript poll.
   */
  refreshSessionContext(sessionId: string): Promise<void>;
  setSessionConfig(
    sessionId: string,
    configId: string,
    value: string,
  ): Promise<void>;
  cycleThinking(sessionId: string): Promise<string | undefined>;
  compactSession(sessionId: string): Promise<void>;
  queueFollowUp(sessionId: string, input: MessageInput): Promise<MessageDelivery>;
  listQueuedMessages(sessionId: string): Promise<QueuedMessage[]>;
  flushQueuedNow(sessionId: string): Promise<boolean>;
  steerSession(sessionId: string, input: MessageInput): Promise<MessageDelivery>;
  sendMessage(sessionId: string, input: MessageInput): Promise<MessageDelivery>;
  cancelRun(sessionId: string): Promise<void>;
  resolveToolCall(toolId: string, decision: ToolDecision): Promise<void>;
  /**
   * Answers one pending ask gate through `workflow.gate_answer`.
   *
   * `idempotencyKey` is the gjc key for this attempt. A repeat of the same
   * attempt replays; a second client that loses the race sees the first answer.
   */
  answerQuestion(
    sessionId: string,
    gateId: string,
    submission: QuestionSubmission,
    idempotencyKey: string,
  ): Promise<void>;
  /** Pending and rejected question cards. The gates list is the source. */
  listPendingQuestions(sessionId: string): Promise<QuestionActivity[]>;
  markSessionRead(sessionId: string): Promise<void>;
  getDiff(sessionId: string): Promise<DiffSnapshot>;
  readArtifact(sessionId: string, artifactId: string): Promise<ArtifactContent>;
  previewFile(
    sessionId: string,
    filePath: string,
  ): Promise<GeneratedFilePreview>;
  getGoal(sessionId: string): Promise<GoalSnapshot>;
  operateGoal(
    sessionId: string,
    operation: GoalOperation,
  ): Promise<GoalSnapshot>;
  listSubagents(sessionId: string): Promise<SubagentSnapshot[]>;
  refreshRuntimeState(sessionId: string): Promise<EffectiveRuntimeState>;
  reconnect(): Promise<BackendConnection>;
  getGitStatus(sessionId: string): Promise<GitStatusSnapshot>;
  stageFiles(sessionId: string, paths: string[]): Promise<GitStatusSnapshot>;
  unstageFiles(sessionId: string, paths: string[]): Promise<GitStatusSnapshot>;
  commitChanges(sessionId: string, message: string): Promise<GitStatusSnapshot>;
  pushChanges(sessionId: string): Promise<GitStatusSnapshot>;
  onEvent(listener: (event: AgentEvent) => void): () => void;
}

export interface SettingsDesktopBridge {
  getPreferences(): Promise<AgentControlPreferences>;
  chooseWorkspace(currentPath: string): Promise<string | null>;
  isNativeFile(file: File): boolean;
  prepareImages(files: File[]): Promise<ImageAttachment[]>;
  prepareFiles(files: File[]): Promise<FileAttachment[]>;
  discardAttachments(tokens: string[]): Promise<void>;
  setWorkspaceLabel(label: string): Promise<string>;
  /**
   * Persists the reasoning-card preference alone.
   *
   * A whole-object save would re-run the runtime-settings authorization prompt, so a
   * reading preference gets its own non-destructive channel.
   */
  setThoughtsExpanded(expanded: boolean): Promise<boolean>;
  /** Persists the conversation density alone, without a runtime reconnect. */
  setToolViewMode(mode: ToolViewMode): Promise<ToolViewMode>;
  /**
   * Persists the notification toggles and sounds alone.
   *
   * They change window behavior, not runtime wiring, so they must not trigger the
   * whole-settings confirmation or reconnect the GJC runtime.
   */
  setNotificationPreferences(
    preferences: NotificationPreferences,
  ): Promise<NotificationPreferences>;
  /** Desktop integration settings, saved without the runtime confirmation. */
  setDesktopIntegration(
    preferences: DesktopIntegrationPreferences,
  ): Promise<DesktopIntegrationPreferences>;
  /** Persists the resolved UI language used by the desktop host. */
  setLanguage(language: UiLanguage): Promise<UiLanguage>;
  /** Persists the running-turn Enter behavior alone. */
  setRunningSubmission(value: "queue" | "steer"): Promise<"queue" | "steer">;
  /** Names the session a window is currently showing, for notification suppression. */
  setViewedSession(sessionId: string | null): Promise<void>;
  savePreferences(preferences: AgentControlPreferences): Promise<{
    preferences: AgentControlPreferences;
    runtimeReconnected: boolean;
  }>;
  checkGjcUpdate(): Promise<GjcUpdateStatus>;
  installGjcUpdate(): Promise<GjcUpdateStatus>;
  /** The last Gajae release check, without asking GitHub again. */
  getAppUpdateStatus(): Promise<AppUpdateStatus>;
  /** Asks GitHub for the latest Gajae release now. */
  checkAppUpdate(): Promise<AppUpdateStatus>;
  /** Looks for bun, GJC, the model profile, gh and tailscale. Installs nothing. */
  checkEnvironment(): Promise<EnvironmentReport>;
  /** Whether the environment check should open at launch. */
  environmentCheckDue(): Promise<boolean>;
}

export interface GjcUpdateStatus {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
}

export interface ManagementDesktopBridge {
  getSnapshot(workspace: string): Promise<ManagementSnapshot>;
  addMcpServer(
    workspace: string,
    input: McpServerInput,
  ): Promise<ManagementSnapshot>;
  removeMcpServer(
    workspace: string,
    scope: "user" | "project",
    name: string,
  ): Promise<ManagementSnapshot>;
  setPluginEnabled(
    workspace: string,
    name: string,
    enabled: boolean,
  ): Promise<ManagementSnapshot>;
  installPlugin(
    workspace: string,
    target: string,
    scope: "user" | "project",
  ): Promise<ManagementSnapshot>;
  uninstallPlugin(workspace: string, name: string): Promise<ManagementSnapshot>;
}

/**
 * Whether a session activity is announced to the OS.
 *
 * A finished, failed, or approval-blocked turn is the outcome the user is waiting
 * for, so it is announced even while the window has focus: a long run usually
 * ends while they are reading something else on screen. Only the incidental
 * per-message ping is suppressed for a focused window.
 */
export function announcesSessionActivity(
  category: "completed" | "failed" | "permission" | "message" | "recovered",
  windowFocused: boolean,
  viewingSession = false,
): boolean {
  if (
    category === "completed" ||
    category === "failed" ||
    category === "permission"
  )
    return !viewingSession;
  return !windowFocused;
}

/**
 * Notification text for a session activity. Several sessions run at once, so the
 * body names the one that changed instead of saying "백그라운드 작업".
 */
export function sessionActivityBody(event: {
  title: string;
  category: "completed" | "failed" | "permission" | "message" | "recovered";
}, language: UiLanguage = "ko"): string {
  const name = event.title.trim() || (language === "en" ? "Session" : "세션");
  if (language === "en") {
    switch (event.category) {
      case "permission":
        return `${name} is waiting for approval or an answer.`;
      case "failed":
        return `${name} failed.`;
      case "recovered":
        return `${name} reconnected.`;
      case "completed":
        return `${name} completed.`;
      default:
        return `${name} sent a new response.`;
    }
  }
  switch (event.category) {
    case "permission":
      return `${name} 승인 또는 질문을 기다립니다.`;
    case "failed":
      return `${name} 작업이 실패했습니다.`;
    case "recovered":
      return `${name} 연결이 복구되었습니다.`;
    case "completed":
      return `${name} 작업이 완료되었습니다.`;
    default:
      return `${name} 새 응답이 도착했습니다.`;
  }
}
