export type RuntimeKind = "gjc" | "hermes";

export type SessionStatus =
  "starting" | "idle" | "running" | "waiting" | "failed";

export type ConnectionState =
  "connecting" | "connected" | "disconnected" | "error";

export type GjcPermissionHandling = "prompt" | "auto" | "always-allow";

export interface AgentControlPreferences {
  workspace: string;
  workspaceLabel: string;
  modelPreset: string;
  permissionHandling: GjcPermissionHandling;
  gjcExecutable: string;
}

export interface BackendConnection {
  state: ConnectionState;
  backend: RuntimeKind | "mock";
  label: string;
  detail: string;
  workspace: string;
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

export interface AgentSession {
  id: string;
  title: string;
  subtitle: string;
  workspace: string;
  runtime: RuntimeKind;
  status: SessionStatus;
  updatedAt: string;
  pinned: boolean;
  unread: boolean;
  accent: string;
  phase?: string;
  mode?: string;
  model?: string;
  modelDisplay?: string;
  thinking?: string;
  usagePercent?: number;
  usagePending?: boolean;
  ownership: SessionOwnership;
  attachment: SessionAttachment;
  worktree?: ManagedWorktree;
  runtimeState?: EffectiveRuntimeState;
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
  path?: string;
  data: string;
}

export interface FileAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  path: string;
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

export interface SystemNoticeActivity {
  id: string;
  kind: "system";
  sessionId: string;
  title: string;
  content: string;
  createdAt: string;
}

export type TranscriptItem =
  | ChatMessage
  | ToolActivity
  | NoticeActivity
  | ThoughtActivity
  | PlanActivity
  | CompactionActivity
  | BranchSummaryActivity
  | SystemNoticeActivity;

export type AgentEvent =
  | { type: "connection.updated"; connection: BackendConnection }
  | { type: "session.created"; session: AgentSession }
  | { type: "session.updated"; session: AgentSession }
  | { type: "session.deleted"; sessionId: string }
  | { type: "transcript.appended"; item: TranscriptItem }
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

export interface CreateSessionInput {
  title?: string;
  workspace: string;
  runtime: RuntimeKind;
  isolation: "workspace" | "worktree";
  worktreeBranch?: string;
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

export type MessageDelivery = "prompt" | "steer";

export interface GoalSnapshot {
  enabled: boolean;
  mode?: "active" | "paused" | "complete";
  objective?: string;
  completed: number;
  total: number;
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
  renameSession(sessionId: string, title: string): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
  getTranscript(sessionId: string): Promise<TranscriptItem[]>;
  setSessionConfig(
    sessionId: string,
    configId: string,
    value: string,
  ): Promise<void>;
  cycleThinking(sessionId: string): Promise<string | undefined>;
  compactSession(sessionId: string): Promise<void>;
  queueFollowUp(sessionId: string, input: MessageInput): Promise<void>;
  listQueuedMessages(sessionId: string): Promise<QueuedMessage[]>;
  flushQueuedNow(sessionId: string): Promise<boolean>;
  steerSession(sessionId: string, input: MessageInput): Promise<void>;
  sendMessage(sessionId: string, input: MessageInput): Promise<MessageDelivery>;
  cancelRun(sessionId: string): Promise<void>;
  resolveToolCall(toolId: string, decision: ToolDecision): Promise<void>;
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
  pathForFile(file: File): string;
  readImages(paths: string[]): Promise<ImageAttachment[]>;
  readFiles(paths: string[]): Promise<FileAttachment[]>;
  setWorkspaceLabel(label: string): Promise<string>;
  savePreferences(preferences: AgentControlPreferences): Promise<{
    preferences: AgentControlPreferences;
    runtimeReconnected: boolean;
  }>;
  checkGjcUpdate(): Promise<GjcUpdateStatus>;
  installGjcUpdate(): Promise<GjcUpdateStatus>;
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
): boolean {
  if (
    category === "completed" ||
    category === "failed" ||
    category === "permission"
  )
    return true;
  return !windowFocused;
}

/**
 * Notification text for a session activity. Several sessions run at once, so the
 * body names the one that changed instead of saying "백그라운드 작업".
 */
export function sessionActivityBody(event: {
  title: string;
  category: "completed" | "failed" | "permission" | "message" | "recovered";
}): string {
  const name = event.title.trim() || "세션";
  switch (event.category) {
    case "permission":
      return `${name} 승인이 필요합니다.`;
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
