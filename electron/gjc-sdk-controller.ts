import {
  access,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { execFile as execFileCb } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { constants, realpathSync, watch, type FSWatcher, type Stats } from "node:fs";
import type {
  AgentEvent,
  AgentSession,
  AgentControlPreferences,
  AgentCommand,
  AgentConfigOption,
  AgentConfigOptionValue,
  BackendConnection,
  ChatMessage,
  CreateSessionInput,
  ImageAttachment,
  MessageDelivery,
  NoticeActivity,
  PermissionOption,
  PlanActivity,
  ToolActivity,
  ToolDecision,
  ThoughtActivity,
  TranscriptItem,
  ArtifactContent,
  DiffSnapshot,
  EffectiveRuntimeState,
  GeneratedFilePreview,
  GitStatusSnapshot,
  GoalOperation,
  GoalSnapshot,
  HistorySession,
  QueuedMessage,
  SubagentSnapshot,
  SystemNoticeActivity,
  TodoSnapshotPhase,
  TodoSnapshotTask,
  ToolImage,
} from "../shared/agent-contract.js";
import { DEFAULT_MODEL_PRESET } from "../shared/agent-contract.js";
import type { SessionMetadataStore } from "./session-metadata-store.js";
import { gjcPathCandidates, runtimeEnvironment } from "./runtime-path.js";
import {
  GjcSdkCli,
  SdkCliError,
  brokerExec,
  freshOperationRef,
  isLifecycleUncertain,
  isSessionMissing,
  isSessionUnreachable,
  type SdkSessionRow,
} from "./gjc-sdk-cli.js";

export { brokerExec };

/**
 * Transcript and event shapes.
 *
 * Gajae reads these updates from the session's own file under
 * `~/.gjc/agent/sessions/` and from `gjc sdk session tail` frames, so the shapes
 * are declared here instead of imported from a protocol package. The field names
 * match what GJC persists, which is what both sources carry.
 */
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string; uri?: string }
  | { type: "audio"; data?: string; mimeType?: string }
  | { type: "resource_link"; uri: string; name?: string }
  | { type: "resource"; resource?: unknown }
  | { type: "unknown" };

/** GJC's tool lifecycle states. `pending` is queued work, not running work. */
export type ToolCallStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "failed"
  | string;

export interface AvailableCommand {
  name: string;
  description?: string | null;
  input?: { hint?: string } | null;
}

/** One model/thinking/mode selector exposed by a session. */
export type SessionConfigOption =
  | {
      type: "select";
      id: string;
      name: string;
      category?: string | null;
      currentValue?: string | boolean | null;
      options: Array<Record<string, unknown>>;
    }
  | {
      type: "boolean";
      id: string;
      name: string;
      category?: string | null;
      currentValue?: string | boolean | null;
    };

/** A session summary row as the picker and session list consume it. */
export interface SessionInfo {
  sessionId: string;
  title?: string | null;
  cwd?: string | null;
  updatedAt?: string | null;
}

export interface PlanEntry {
  content: string;
  status?: "pending" | "in_progress" | "completed" | string;
  priority?: string;
}

/** The tool fields a projected tool row carries. */
interface ToolCallFields {
  toolCallId: string;
  title?: string;
  kind?: string;
  status?: ToolCallStatus;
  content?: unknown[];
  rawInput?: unknown;
  rawOutput?: unknown;
  locations?: Array<{ path?: string }>;
  _meta?: Record<string, unknown>;
}

/**
 * One projected session update.
 *
 * The variants are exactly the ones the transcript projection handles. Tail frames
 * and session-file rows are both normalised into these before projection, so there
 * is one place that decides what a row means.
 */
export type SessionUpdate =
  | { sessionUpdate: "user_message_chunk"; content: ContentBlock; messageId?: string }
  | {
      sessionUpdate: "agent_message_chunk";
      content: ContentBlock;
      messageId?: string;
    }
  | {
      sessionUpdate: "agent_thought_chunk";
      content: ContentBlock;
      messageId?: string;
    }
  | ({ sessionUpdate: "tool_call" } & ToolCallFields)
  | ({ sessionUpdate: "tool_call_update" } & ToolCallFields)
  | {
      sessionUpdate: "session_info_update";
      title?: string | null;
      updatedAt?: string | null;
      phase?: string | null;
      _meta?: Record<string, unknown>;
    }
  | { sessionUpdate: "plan"; entries: PlanEntry[] }
  | { sessionUpdate: "available_commands_update"; availableCommands: AvailableCommand[] }
  | { sessionUpdate: "config_option_update"; configOptions: SessionConfigOption[] }
  | { sessionUpdate: "current_mode_update"; currentModeId?: string }
  | { sessionUpdate: "usage_update"; used: number; size: number };

export interface SessionNotification {
  sessionId: string;
  update: SessionUpdate;
}

export interface ResolvedMessageInput {
  text: string;
  images: Array<Omit<ImageAttachment, "token"> & { nativePath?: string }>;
  files: Array<Omit<import("../shared/agent-contract.js").FileAttachment, "token"> & {
    nativePath: string;
  }>;
}

const GJC_ACCENT = "#ff8a34";
const STARTUP_TIMEOUT_MS = 30_000;
// How many past sessions the resume picker offers. The store keeps every session
// ever recorded and each one needs a summary, but the summary is read from a
// bounded head rather than the whole transcript, so the cap is about how long a
// list stays useful to scroll rather than what it costs to build. 402 sessions
// were on disk here; 60 hid most of them behind a search box.
const HISTORY_SESSION_LIMIT = 250;
// How much of a session file the picker reads to title it. The title is the first
// user message and the envelope is the first line, so both are near the top. Real
// transcripts here reach 43 MB, and reading them whole to find the first message
// pulled 645 MB through memory for one list.
const HISTORY_SUMMARY_HEAD_BYTES = 128 * 1024;
// How far back a transcript rescan looks for rows that changed in place. A turn
// settles its own recent rows; a disagreement older than this is republished as
// a whole history instead of being reconciled row by row.
const TRANSCRIPT_RESCAN_WINDOW = 32;
// A fork whose lifecycle receipt could not be verified is looked up in the broker
// index, which only lists the new session once it settles.
const FORK_RECOVERY_ATTEMPTS = 20;
const MAX_TOOL_TEXT = 12_000;
// How long a prompt is followed through its own record before the transcript is
// left as the only account. A turn can legitimately run for many minutes, so this
// is a ceiling on polling, not a deadline on the work: reaching it leaves the run
// alone rather than reporting it stopped.
const PROMPT_SETTLE_ATTEMPTS = 900;
const PROMPT_SETTLE_INTERVAL_MS = 400;
const ATTACH_RETRY_INTERVAL_MS = 15_000;
const EFFORT_LEVELS = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
const execFile = promisify(execFileCb);

/**
 * Runs a GJC CLI control command and resolves as soon as its response is complete,
 * without waiting for the process to exit.
 *
 * The CLI writes one JSON object and is done, but older builds then lingered before
 * exiting (0.15.3: response at 728ms, exit at 5735ms), so waiting for exit charged
 * every steer, follow-up, and abort an extra 5 seconds during which the window
 * looked frozen. gjc/0.18.11 no longer lingers (response 425ms, exit 434ms), and
 * resolving on the response keeps the window off that path either way.
 *
 * The child is left to exit on its own once its response has been read.
 */
/** Initial window for finding the current persisted cycle's user boundary. */
const RUN_STATE_TAIL_BYTES = 256 * 1024;

/**
 * Parses the last rows of a transcript.
 *
 * Whether a turn is open depends on every continuation since its latest user row.
 * Start with a small tail, then double only when that boundary is outside the window.
 * This keeps ordinary discovery cheap without calling a terminal row authoritative
 * when a long detached task launch sits 300KB or more behind it. The first line in
 * each window is dropped unless it starts at byte zero because it may be cut in half.
 *
 * Returns undefined when the tail holds no usable row, so the caller can decline to
 * guess rather than reporting a wrong state.
 */
/**
 * The first lines of a session file, for summarising it.
 *
 * The envelope and the first user message are both near the top, so a bounded head
 * answers what the picker needs. A trailing partial line is dropped: it is cut at
 * the window edge and would only parse by luck.
 */
export async function transcriptHeadLines(
  filePath: string,
): Promise<string[]> {
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(HISTORY_SUMMARY_HEAD_BYTES);
    const { bytesRead } = await handle.read(
      buffer,
      0,
      HISTORY_SUMMARY_HEAD_BYTES,
      0,
    );
    const lines = buffer.subarray(0, bytesRead).toString("utf8").split("\n");
    // Only when the window actually filled: a file smaller than the window ends
    // with a complete line, and dropping it would lose a one-message session.
    if (bytesRead === HISTORY_SUMMARY_HEAD_BYTES) lines.pop();
    return lines;
  } finally {
    await handle.close();
  }
}

export async function readTranscriptTail(
  filePath: string,
  size: number,
  expandTerminalCycle = false,
): Promise<Record<string, unknown>[] | undefined> {
  const handle = await open(filePath, "r");
  try {
    if (size <= 0) return undefined;
    let length = Math.min(size, RUN_STATE_TAIL_BYTES);
    while (length > 0) {
      const start = size - length;
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, start);
      const lines = buffer.toString("utf8").split("\n");
      if (start > 0) lines.shift();
      const rows: Record<string, unknown>[] = [];
      for (const line of lines) {
        const text = line.trim();
        if (!text) continue;
        try {
          rows.push(JSON.parse(text) as Record<string, unknown>);
        } catch {
          // A torn line at either edge of the window is skipped.
        }
      }
      const turn = persistedTurnState(rows);
      if (
        start === 0 ||
        !expandTerminalCycle ||
        turn.running ||
        (rows.length > 0 && turn.hasUserBoundary)
      )
        return rows.length > 0 ? rows : undefined;
      length = Math.min(size, length * 2);
    }
    return undefined;
  } finally {
    await handle.close();
  }
}

/**
 * A tool call awaiting the user's approval decision.
 *
 * Broker-hosted session hosts have no reverse channel to an external controller:
 * `permission.request` is a host-to-client operation the CLI cannot carry, so a
 * session left in `prompt` mode fails its tool calls with "no permission provider
 * is connected" instead of asking. Gajae therefore sets the session's permission
 * mode explicitly (see `applyPermissionMode`) and only tracks a pending decision
 * for the approvals GJC records in the transcript itself.
 */
interface PendingPermission {
  request: {
    sessionId: string;
    toolCall: { toolCallId: string; title?: string };
    options: Array<{
      optionId: string;
      name: string;
      kind: PermissionOption["kind"];
    }>;
  };
  resolve: (response: { outcome: { outcome: string; optionId?: string } }) => void;
}

interface GjcControllerOptions {
  workspace: string;
  executable?: string;
  modelPreset?: AgentControlPreferences["modelPreset"];
  permissionHandling?: AgentControlPreferences["permissionHandling"];
  sessionMetadata?: SessionMetadataStore;
  artifactDirectory?: string;
  emit: (event: AgentEvent) => void;
}

// Constructing a DateTimeFormat costs far more than formatting with one, and a
// transcript rescan labels every row. Building one per row was ~59ms per 2500
// rows against ~1.4ms shared, which was the bulk of a full transcript rebuild.
const CLOCK_LABEL = new Intl.DateTimeFormat("en", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function nowLabel(): string {
  return CLOCK_LABEL.format(new Date());
}

function recentLabel(timestamp: string | null | undefined): string {
  if (!timestamp) return "now";
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) return "now";
  const elapsed = Math.max(0, Date.now() - parsed);
  if (elapsed < 60_000) return "now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h`;
  return `${Math.floor(elapsed / 86_400_000)}d`;
}

/**
 * The sortable twin of `recentLabel`, and undefined when the backend never said
 * when the row changed.
 */
function timestampMs(timestamp: string | null | undefined): number | undefined {
  if (!timestamp) return undefined;
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Stamps a row as changed.
 *
 * The rail prints `updatedAt` and orders by `updatedAtMs`, so the two have to
 * move together: a label without its timestamp left the list sorted by whichever
 * change last carried one.
 */
function markUpdated(session: AgentSession, timestamp?: string): void {
  session.updatedAt = recentLabel(timestamp);
  session.updatedAtMs = timestampMs(timestamp) ?? Date.now();
}

/**
 * The session a transcript's envelope says it was forked from.
 *
 * GJC writes `parentSession` next to the id and cwd on the first line, and some of
 * its paths store the source's *file path* there instead of its id, so the value is
 * reduced the same way the file layout spells it: drop the directory, the ".jsonl"
 * suffix, and everything before the last `_`. A session that names itself is not
 * its own parent.
 */
export function parentSessionOf(
  envelope: string | undefined,
  sessionId: string,
): string | undefined {
  if (!envelope) return undefined;
  let row: Record<string, unknown>;
  try {
    row = JSON.parse(envelope) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (row.type !== "session" || typeof row.parentSession !== "string")
    return undefined;
  const name = row.parentSession.trim().split("/").at(-1) ?? "";
  const id = (
    name.endsWith(".jsonl") ? name.slice(0, -`.jsonl`.length) : name
  )
    .split("_")
    .at(-1);
  return id && id !== sessionId ? id : undefined;
}

function textFromContent(content: ContentBlock): string {
  if (content.type === "text") return content.text;
  if (content.type === "audio") return "[Audio attachment]";
  if (content.type === "resource_link") return content.name ?? content.uri;
  if (content.type === "resource") return "[Attached resource]";
  return "";
}

function imageFromContent(
  content: ContentBlock,
  id: string,
): ImageAttachment | undefined {
  if (content.type !== "image") return undefined;
  return {
    id,
    name: content.uri?.split("/").at(-1) || "Image",
    mimeType: content.mimeType,
    data: content.data,
  };
}

function cloneTranscriptItem(item: TranscriptItem): TranscriptItem {
  if (item.kind === "plan")
    return { ...item, entries: item.entries.map((entry) => ({ ...entry })) };
  if (item.kind !== "message" || !item.images) return { ...item };
  return { ...item, images: item.images.map((image) => ({ ...image })) };
}

/**
 * Whether a rescan produced an equivalent item, so it does not need to be
 * republished. Transcript items are plain JSON-shaped records, so a structural
 * compare is both correct and cheaper than the IPC hop it avoids.
 */
export function sameTranscriptItem(
  left: TranscriptItem,
  right: TranscriptItem,
): boolean {
  if (left === right) return true;
  if (left.kind !== right.kind || left.id !== right.id) return false;
  // A rebuilt row is never reference-equal to the one it replaces, so the cheap
  // discriminators are checked before falling back to a structural compare.
  if (left.kind === "message" && right.kind === "message") {
    if (
      left.content.length !== right.content.length ||
      left.streaming !== right.streaming ||
      left.role !== right.role
    )
      return false;
  }
  if (left.kind === "tool" && right.kind === "tool") {
    if (
      left.status !== right.status ||
      left.output?.length !== right.output?.length
    )
      return false;
  }
  return JSON.stringify(left) === JSON.stringify(right);
}

function transcriptTime(value: unknown): string {
  if (typeof value !== "string") return nowLabel();
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return nowLabel();
  return CLOCK_LABEL.format(new Date(parsed));
}

function sharedContentText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) => {
      if (!part || typeof part !== "object" || Array.isArray(part)) return [];
      const value = part as Record<string, unknown>;
      return value.type === "text" && typeof value.text === "string"
        ? [value.text]
        : [];
    })
    .join("");
}

function sanitizeLocalAttachmentBlocks(text: string): string {
  return text.replace(/(<local-(?:images|files)>[\s\S]*?<\/local-(?:images|files)>)/gu, (block) =>
    block.split("\n").map((line) => {
      if (!line.startsWith("- ")) return line;
      const raw = line.slice(2).trim();
      try { return `- ${JSON.stringify(path.basename(JSON.parse(raw) as string))}`; }
      catch { return `- ${path.basename(raw)}`; }
    }).join("\n"),
  );
}

function attachedPathsText(
  input: Pick<ResolvedMessageInput, "images" | "files">,
): string {
  const files = input.files.map((file) => file.nativePath);
  const images = input.images.flatMap((image) =>
    image.nativePath ? [image.nativePath] : [],
  );
  if (files.length === 0 && images.length === 0) return "";
  const blocks = [
    files.length > 0
      ? `<local-files>\n${files.map((filePath) => `- ${JSON.stringify(filePath)}`).join("\n")}\n</local-files>\nUse the read tool on these local files when their contents are needed.`
      : "",
    images.length > 0
      ? `<local-images>\n${images.map((filePath) => `- ${JSON.stringify(filePath)}`).join("\n")}\n</local-images>\nThe user attached these images. You MUST inspect every image with the read tool before responding.`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  return `\n\n${blocks}`;
}

export function messageTextWithFiles(input: ResolvedMessageInput): string {
  return `${input.text.trim()}${attachedPathsText(input)}`.trim();
}

function normalizeQueuedRequestText(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

/** Unified diff produced by an edit/write tool, wherever the transport parked it. */
export function toolDiffText(...candidates: unknown[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.startsWith("@@"))
      return candidate;
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
      continue;
    const value = candidate as Record<string, unknown>;
    if (typeof value.diff === "string" && value.diff) return value.diff;
    const nested = toolDiffText(value.details, value.result, value.output);
    if (nested) return nested;
  }
  return undefined;
}

/**
 * The readable text a recorded tool result actually holds.
 *
 * `body` is preferred when it has content, but an empty or missing body is not an
 * answer: the recorded text content still carries what the tool returned. That
 * fall-through matters after a durable rebuild, where the caller has only the row
 * -- an empty body used to win over populated content and end the search, so the
 * tool card came back empty for a result the file had recorded in full.
 *
 * Structured `details` is kept as bounded, redacted JSON because it is the only
 * place a structured reply survives a rebuild. Nothing here interprets it: a
 * recorded result is shown as data, not classified into an activity kind.
 */
export function toolResultText(
  result: Record<string, unknown>,
  diff?: string,
): string | undefined {
  const body = typeof result.body === "string" ? result.body : "";
  const text = boundedJson(body || sharedContentText(result.content));
  const details = boundedJson(result.details);
  const parts = [
    ...(text ? [text] : []),
    // A diff already rendered on its own is not repeated as structured payload.
    ...(details && details !== text && details !== diff
      ? [`details\n${details}`]
      : []),
  ];
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

/** Image parts of a tool result: inline base64, or a content-addressed blob id. */
export function toolImageRefs(content: unknown): ToolImage[] {
  if (!Array.isArray(content)) return [];
  return content
    .flatMap((part): ToolImage[] => {
      if (!part || typeof part !== "object" || Array.isArray(part)) return [];
      const value = part as Record<string, unknown>;
      const image =
        value.type === "image"
          ? value
          : value.type === "content" &&
              value.content &&
              typeof value.content === "object" &&
              !Array.isArray(value.content)
            ? (value.content as Record<string, unknown>)
            : undefined;
      if (
        !image ||
        (image.type === undefined && typeof image.data !== "string")
      )
        return [];
      if (typeof image.data !== "string" || typeof image.mimeType !== "string")
        return [];
      const blob = /^blob:sha256:([0-9a-f]{64})$/u.exec(image.data);
      if (blob)
        return [{ mimeType: image.mimeType, dataUrl: "", blobId: blob[1]! }];
      return [
        {
          mimeType: image.mimeType,
          dataUrl: `data:${image.mimeType};base64,${image.data}`,
        },
      ];
    })
    .slice(0, 4);
}

/** Model id reported by the most recent assistant turn in a shared transcript. */
export function lastReportedModel(rows: unknown[]): string | undefined {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const value = row as Record<string, unknown>;
    if (value.role !== "assistant") continue;
    if (typeof value.model === "string" && value.model) return value.model;
  }
  return undefined;
}

export function readableModelLabel(model: string): string {
  const id = model.split("/").at(-1) ?? model;
  if (/^gpt-/iu.test(id))
    return id
      .replace(/^gpt/iu, "GPT")
      .replace(/-([a-z])/gu, (_, letter: string) => ` ${letter.toUpperCase()}`);
  return id;
}

export function configuredProfileDefaultThinking(
  source: string,
  preset: string,
): string | undefined {
  let selected = false;
  for (const line of source.split("\n")) {
    const profile = line.match(/^  ([^ ][^:]*):\s*$/u)?.[1];
    if (profile) {
      selected = profile === preset;
      continue;
    }
    if (!selected) continue;
    const effort = line.match(/^      default:\s+\S+:([a-z]+)\s*$/u)?.[1];
    if (effort) return EFFORT_LEVELS.has(effort) ? effort : undefined;
  }
  return undefined;
}

/**
 * Stop reasons for a turn that ended without finishing. Tool rows written after
 * one of these are leftovers from the abandoned turn, not a run still in flight.
 */
const ABANDONED_STOP_REASONS = new Set([
  "aborted",
  "cancelled",
  "canceled",
  "error",
]);

const TERMINAL_STOP_REASONS = new Set([
  "stop",
  "end_turn",
  "aborted",
  "cancelled",
  "canceled",
  "error",
  "max_tokens",
]);

/**
 * How long a reconciliation of detached-task launch markers is trusted.
 *
 * A marker the runtime still reports as running has to be re-checked eventually:
 * a pause or cancel writes no release row, so only a later look at the job list
 * can notice that the work ended. The delay keeps that look off the poll loop.
 */
const PENDING_ASYNC_RECONCILE_INTERVAL_MS = 15_000;

interface PersistedTurnState {
  running: boolean;
  /** Launch markers of detached work no later row has released. */
  pendingAsyncJobIds: string[];
  /**
   * The markers are the only reason this reads running: the newest terminal
   * assistant row closed the cycle after they were written, and no tool row or
   * user request came later. Only the runtime can settle that verdict, because a
   * job paused or cancelled from outside writes no release row.
   */
  pendingAsyncWorkOnly: boolean;
  hasUserBoundary: boolean;
}

/**
 * Whole-cycle state recovered from the durable transcript.
 *
 * A detached `task` returns immediately with `details.async.state=running`, so an
 * assistant can write a terminal response while the task is still alive. GJC later
 * appends `custom_message/async-result` and automatically resumes the model without a
 * new user row. Treating that first response as the turn boundary is the exact
 * running -> idle -> running flicker this state machine must prevent.
 *
 * A job the user paused or cancelled delivers no such row, so its launch marker
 * outlives the work it described. `pendingAsyncWorkOnly` names the one verdict the
 * transcript cannot settle alone.
 */
function persistedTurnState(rows: unknown[]): PersistedTurnState {
  let lastUser = -1;
  let lastTerminalAssistant = -1;
  let lastActivity = -1;
  let abandoned = false;
  const pendingAsyncJobs = new Set<string>();
  for (let index = 0; index < rows.length; index += 1) {
    const envelope = rows[index];
    if (!envelope || typeof envelope !== "object" || Array.isArray(envelope))
      continue;
    const value = envelope as Record<string, unknown>;
    if (value.type === "custom_message" && value.customType === "async-result") {
      const details =
        value.details &&
        typeof value.details === "object" &&
        !Array.isArray(value.details)
          ? (value.details as Record<string, unknown>)
          : undefined;
      if (Array.isArray(details?.jobs)) {
        for (const candidate of details.jobs) {
          if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
            continue;
          const jobId = (candidate as Record<string, unknown>).jobId;
          if (typeof jobId === "string") pendingAsyncJobs.delete(jobId);
        }
      }
      // An async result is an input that tells the model to resume. It bridges the
      // completed detached job to the assistant row that will actually close the
      // continued cycle. An abandoned/cancelled turn is deliberately not reopened.
      if (!abandoned) lastActivity = index;
    }
    const message =
      value.message &&
      typeof value.message === "object" &&
      !Array.isArray(value.message)
        ? (value.message as Record<string, unknown>)
        : value;
    const details =
      message.details &&
      typeof message.details === "object" &&
      !Array.isArray(message.details)
        ? (message.details as Record<string, unknown>)
        : undefined;
    if (message.role === "toolResult" && message.toolName === "task") {
      const asyncState =
        details?.async &&
        typeof details.async === "object" &&
        !Array.isArray(details.async)
          ? (details.async as Record<string, unknown>)
          : undefined;
      const jobId = asyncState?.jobId;
      if (typeof jobId === "string") {
        if (asyncState?.state === "running") pendingAsyncJobs.add(jobId);
        else pendingAsyncJobs.delete(jobId);
      }
    }
    if (
      message.role === "toolResult" &&
      message.toolName === "subagent" &&
      Array.isArray(details?.terminalIds)
    ) {
      // An explicit `subagent await` consumes completion inside the tool result, so
      // GJC does not need to append a later custom_message/async-result. terminalIds
      // is the tool's authoritative set: timed-out and interrupted waits omit it for
      // jobs that are still alive.
      for (const jobId of details.terminalIds)
        if (typeof jobId === "string") pendingAsyncJobs.delete(jobId);
    }
    if (
      message.role === "toolResult" &&
      message.toolName === "job" &&
      Array.isArray(details?.jobs)
    ) {
      // The generic job inspector is the fallback completion channel used when a
      // detached task is polled instead of awaited through `subagent`. Its snapshot
      // includes running entries too, so only explicit terminal task states release
      // durable launch markers.
      for (const candidate of details.jobs) {
        if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
          continue;
        const job = candidate as Record<string, unknown>;
        if (
          job.type === "task" &&
          typeof job.id === "string" &&
          (job.status === "completed" ||
            job.status === "failed" ||
            job.status === "cancelled")
        )
          pendingAsyncJobs.delete(job.id);
      }
    }
    if (message.role === "user") {
      lastUser = index;
      abandoned = false;
    }
    if (
      message.role === "assistant" &&
      typeof message.stopReason === "string" &&
      TERMINAL_STOP_REASONS.has(message.stopReason)
    ) {
      lastTerminalAssistant = index;
      abandoned = ABANDONED_STOP_REASONS.has(message.stopReason);
    }
    // An assistant row that stopped to call a tool, or a tool result, is work in
    // progress. Tracking only the last user row missed the case where the request
    // has not been flushed yet but the reply to it already has: the newest rows
    // were mid-turn, while the last user row still pointed at the previous turn,
    // so a working session read as finished.
    if (
      (message.role === "assistant" &&
        typeof message.stopReason === "string" &&
        !TERMINAL_STOP_REASONS.has(message.stopReason)) ||
      value.type === "toolResult" ||
      message.role === "toolResult"
    ) {
      // Rows after an abandoned turn are that turn's leftovers, not new work. Only a
      // fresh request reopens the session, and that is handled by the user-row check.
      if (!abandoned) lastActivity = index;
    }
  }
  const workAfterTerminal = lastActivity > lastTerminalAssistant;
  const userAfterTerminal = lastUser >= 0 && lastUser > lastTerminalAssistant;
  const pendingAsyncJobIds = abandoned ? [] : [...pendingAsyncJobs];
  const pendingAsyncWork = pendingAsyncJobIds.length > 0;
  return {
    running: pendingAsyncWork || workAfterTerminal || userAfterTerminal,
    pendingAsyncJobIds,
    // A launch marker is itself a tool result row, so `!workAfterTerminal` already
    // proves the newest terminal assistant row is newer than the newest marker.
    pendingAsyncWorkOnly:
      pendingAsyncWork && !workAfterTerminal && !userAfterTerminal,
    hasUserBoundary: lastUser >= 0,
  };
}

/** A persisted cycle is active until all continuations reach a terminal assistant row. */
export function persistedTranscriptRunning(rows: unknown[]): boolean {
  return persistedTurnState(rows).running;
}

/** How many finished compactions the persisted transcript records. */
export function compactionRecordCount(rows: unknown[]): number {
  let count = 0;
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    if ((row as Record<string, unknown>).type === "compaction") count += 1;
  }
  return count;
}

export function persistedModelState(rows: unknown[]): {
  model?: string;
  thinking?: string;
  serviceTier?: string;
} {
  let model: string | undefined;
  let thinking: string | undefined;
  let serviceTier: string | undefined;
  let serviceTierRecorded = false;
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const value = row as Record<string, unknown>;
    if (
      value.type === "configured_model_chain" &&
      value.role === "default" &&
      typeof value.identity === "string"
    ) {
      model = value.identity;
      const selector =
        Array.isArray(value.entries) && typeof value.entries[0] === "string"
          ? value.entries[0].match(/:([a-z]+)$/u)?.[1]
          : undefined;
      if (selector && EFFORT_LEVELS.has(selector)) thinking = selector;
    }
    if (
      value.type === "thinking_level_change" &&
      value.operatorIntent === true &&
      typeof value.thinkingLevel === "string"
    ) {
      thinking = value.thinkingLevel;
    }
    if (value.type === "service_tier_change") {
      if (typeof value.serviceTier === "string") {
        serviceTier = value.serviceTier;
        serviceTierRecorded = true;
      } else if (value.serviceTier === null) {
        serviceTier = undefined;
        serviceTierRecorded = true;
      }
    }
  }
  return {
    model,
    thinking,
    ...(serviceTierRecorded ? { serviceTier } : {}),
  };
}

function taskStatus(
  status: ToolActivity["status"],
): SubagentSnapshot["status"] {
  if (status === "running") return "running";
  if (status === "failed" || status === "denied") return "failed";
  if (status === "cancelled") return "failed";
  if (status === "approval-required") return "waiting";
  return "completed";
}

function receiptSubagentStatus(
  output: string | undefined,
  id: string,
): SubagentSnapshot["status"] | undefined {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const value = output?.match(
    new RegExp(
      `<agent\\s+id=["']${escaped}["'][^>]*>[\\s\\S]*?<status>([^<]+)</status>`,
      "u",
    ),
  )?.[1];
  if (!value) return undefined;
  if (/fail|error|cancel/iu.test(value)) return "failed";
  if (/complete|success/iu.test(value)) return "completed";
  if (/wait|block|pause/iu.test(value)) return "waiting";
  return "running";
}

export function taskSubagents(
  input: unknown,
  status: ToolActivity["status"],
  output?: string,
): SubagentSnapshot[] {
  if (!input || typeof input !== "object" || Array.isArray(input)) return [];
  const value = input as Record<string, unknown>;
  if (!Array.isArray(value.tasks)) return [];
  const defaultRole = typeof value.agent === "string" ? value.agent : undefined;
  return value.tasks.flatMap((candidate, index) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
      return [];
    const task = candidate as Record<string, unknown>;
    const id =
      typeof task.id === "string" && task.id ? task.id : `task-${index + 1}`;
    const assignment =
      typeof task.assignment === "string" ? task.assignment : "";
    const target = assignment
      .match(/(?:^|\n)# Target\s*\n([\s\S]*?)(?=\n# |$)/u)?.[1]
      ?.replace(/\s+/gu, " ")
      .trim();
    const projectedStatus =
      receiptSubagentStatus(output, id) ?? taskStatus(status);
    return [
      {
        id,
        label:
          typeof task.description === "string" && task.description
            ? task.description
            : id,
        status: projectedStatus,
        ...(typeof task.agent === "string"
          ? { role: task.agent }
          : defaultRole
            ? { role: defaultRole }
            : {}),
        ...(target ? { objective: target.slice(0, 360) } : {}),
      },
    ];
  });
}

/**
 * The stable transcript id of this window's todo snapshot row.
 *
 * The id names the app's presentation row, not a task: the runtime returns no task
 * identity this controller can rely on, so every read updates the same row instead
 * of inventing per-task rows.
 */
function todoSnapshotRowId(sessionId: string): string {
  return `app-todo-${sessionId}`;
}

/** One runtime task row, as data. Unknown fields are dropped, never guessed. */
function todoSnapshotTask(value: unknown): TodoSnapshotTask | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const content =
    typeof record.content === "string"
      ? record.content
      : typeof record.title === "string"
        ? record.title
        : typeof record.task === "string"
          ? record.task
          : undefined;
  if (!content) return undefined;
  const notes = Array.isArray(record.notes)
    ? record.notes.filter((note): note is string => typeof note === "string")
    : [];
  return {
    content,
    ...(typeof record.status === "string" ? { status: record.status } : {}),
    ...(notes.length > 0 ? { notes } : {}),
  };
}

/**
 * The runtime's todo rows as phases, without inventing a shape.
 *
 * GJC stores `TodoPhase { name, tasks: TodoItem[] }`, and the renderer draws this
 * checklist from the real status strings. A row that carries no `tasks` array is
 * kept as a single unnamed task when it has a text field, and a row that matches
 * neither is left out -- its raw JSON is still on screen in `content`, so dropping
 * it here cannot hide data.
 */
export function todoSnapshotPhases(rows: readonly unknown[]): TodoSnapshotPhase[] {
  const phases: TodoSnapshotPhase[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const record = row as Record<string, unknown>;
    if (Array.isArray(record.tasks)) {
      phases.push({
        ...(typeof record.name === "string" ? { name: record.name } : {}),
        tasks: record.tasks
          .map(todoSnapshotTask)
          .filter((task): task is TodoSnapshotTask => task !== undefined),
      });
      continue;
    }
    const task = todoSnapshotTask(record);
    if (task) phases.push({ tasks: [task] });
  }
  return phases;
}

/**
 * The runtime's todo store as this window last observed it.
 *
 * `rows` and `json` only exist once a read succeeded, which is what lets a failed
 * read report the previous snapshot as stale instead of an empty list.
 */
interface TodoSnapshotState {
  /** The row currently published for this session's todo store. */
  row: SystemNoticeActivity;
  /** The records the last successful read returned. */
  rows?: unknown[];
  /** The bounded JSON of those records, as shown in the row. */
  json?: string;
  /** When that successful read was observed. */
  observedAt?: string;
}

/** One redacted line describing why a todo read could not answer. */
function todoQueryErrorText(error: string | undefined): string {
  const line = error?.split("\n")[0]?.trim();
  return redactSensitiveText(line || "the runtime did not answer");
}

function customMessageTitle(customType: unknown): string {
  if (customType === "async-result") return "백그라운드 작업 완료";
  if (customType === "subagent:steer" || customType === "subagent:steer:relay")
    return "서브에이전트 steer";
  if (customType === "skill-prompt") return "스킬";
  if (typeof customType === "string" && customType.trim()) return customType;
  return "시스템 메시지";
}

export function sharedTranscriptItems(
  sessionId: string,
  rows: unknown[],
  options?: { turnRunning?: boolean },
): TranscriptItem[] {
  const records = rows.flatMap((row) =>
    row && typeof row === "object" && !Array.isArray(row)
      ? [row as Record<string, unknown>]
      : [],
  );
  const toolResults = new Map(
    records.flatMap((row) =>
      row.role === "toolResult" && typeof row.toolCallId === "string"
        ? [[row.toolCallId, row] as const]
        : [],
    ),
  );
  // A tool call with no result row is only still running while the turn itself is.
  // A finished turn leaves its last `toolUse` call resultless in the persisted file, and
  // reporting that as running kept the composer showing stop and routing every later
  // message into a steer long after the turn ended.
  //
  // Once the turn is over it reads `cancelled`, never `completed`. The broker writes no
  // status on a tool block at all -- 55 blocks in a live session, none with one -- so a
  // resultless call is one whose outcome was never recorded, not one that succeeded. The
  // turn-running read comes from a bounded tail and can lag by a beat, and in that window
  // `completed` put 완료 on the card of a tool that was still working. `cancelled` is
  // accurate either way and carries no spinner.
  const unresolvedToolStatus: ToolActivity["status"] =
    options?.turnRunning === false ? "cancelled" : "running";
  const abortedTurn = records.some((row) => {
    const message =
      row.message &&
      typeof row.message === "object" &&
      !Array.isArray(row.message)
        ? (row.message as Record<string, unknown>)
        : row;
    return (
      message.role === "assistant" &&
      (message.stopReason === "aborted" ||
        message.stopReason === "cancelled" ||
        message.stopReason === "canceled")
    );
  });
  const items: TranscriptItem[] = [];
  for (const row of records) {
    const sourceId =
      typeof row.id === "string" && row.id ? row.id : `row-${items.length}`;
    const createdAt = transcriptTime(row.ts ?? row.timestamp);
    const body = sanitizeLocalAttachmentBlocks(
      typeof row.body === "string" && row.body
        ? row.body
        : sharedContentText(row.content),
    );
    if (row.type === "compaction") {
      const summary = typeof row.summary === "string" ? row.summary.trim() : "";
      const tokensBefore =
        typeof row.tokensBefore === "number" &&
        Number.isFinite(row.tokensBefore)
          ? row.tokensBefore
          : 0;
      if (summary) {
        items.push({
          id: `shared-compaction-${sourceId}`,
          kind: "compaction",
          sessionId,
          tokensBefore,
          summary,
          ...(typeof row.shortSummary === "string" && row.shortSummary.trim()
            ? { shortSummary: row.shortSummary.trim() }
            : {}),
          createdAt,
        });
      }
      continue;
    }
    if (row.type === "branch_summary") {
      const summary = typeof row.summary === "string" ? row.summary.trim() : "";
      if (summary) {
        items.push({
          id: `shared-branch-${sourceId}`,
          kind: "branch_summary",
          sessionId,
          summary,
          createdAt,
        });
      }
      continue;
    }
    if (row.type === "custom_message") {
      const content =
        typeof row.content === "string"
          ? row.content.trim()
          : sharedContentText(row.content).trim();
      // `display: false` is the runtime's instruction to its own renderer, not a
      // reason to drop the row: activity the runtime recorded as hidden is still
      // recorded activity, and this window shows it as system material. The flag
      // travels with the row so a card can say it was marked hidden, and the
      // recorded `customType` travels as its source label -- an unrecognized one
      // stays unrecognized rather than being folded into a known activity kind.
      if (content) {
        const sourceType =
          typeof row.customType === "string" ? row.customType.trim() : "";
        items.push({
          id: `shared-system-${sourceId}`,
          kind: "system",
          sessionId,
          title: customMessageTitle(row.customType),
          content,
          createdAt,
          ...(sourceType ? { sourceType } : {}),
          ...(row.display === false ? { runtimeHidden: true } : {}),
        });
      }
      continue;
    }
    if (row.role === "user") {
      items.push({
        id: `shared-message-${sourceId}`,
        kind: "message",
        sessionId,
        role: "user",
        content: body,
        createdAt,
      });
      continue;
    }
    if (row.role !== "assistant") continue;
    const content = Array.isArray(row.content) ? row.content : [];
    const aborted =
      row.stopReason === "aborted" ||
      row.stopReason === "cancelled" ||
      row.stopReason === "canceled";
    if (aborted) {
      items.push({
        id: `shared-cancelled-${sourceId}`,
        kind: "notice",
        sessionId,
        title: "작업 취소됨",
        content: "진행 중인 작업이 취소되어 종료됐습니다.",
        tone: "neutral",
        createdAt,
      });
      if (content.length === 0) continue;
    }
    if (
      row.stopReason === "error" &&
      typeof row.errorMessage === "string" &&
      row.errorMessage
    ) {
      items.push({
        id: `shared-error-${sourceId}`,
        kind: "notice",
        sessionId,
        title: "작업 실패",
        content: row.errorMessage,
        tone: "warning",
        createdAt,
      });
      continue;
    }
    let emittedAssistantText = false;
    // One assistant row can carry several text parts -- a short lead-in, a
    // thinking part, then the full answer. Every part must get its own id: they
    // all shared `shared-message-${sourceId}`, and a transcript keyed by id
    // rendered the same row twice, once above and once below the tool card.
    const pushAssistantText = (value: string): void => {
      if (!value) return;
      items.push({
        id: emittedAssistantText
          ? `shared-message-${sourceId}-${items.length}`
          : `shared-message-${sourceId}`,
        kind: "message",
        sessionId,
        role: "assistant",
        content: value,
        createdAt,
        streaming: false,
      });
      emittedAssistantText = true;
    };
    for (let index = 0; index < content.length; index += 1) {
      const part = content[index];
      if (!part || typeof part !== "object" || Array.isArray(part)) continue;
      const value = part as Record<string, unknown>;
      if (
        value.type === "thinking" &&
        typeof value.thinking === "string" &&
        value.thinking
      ) {
        items.push({
          id: `shared-thought-${sourceId}-${index}`,
          kind: "thought",
          sessionId,
          content: value.thinking,
          createdAt,
          streaming: false,
        });
        continue;
      }
      if (
        value.type === "text" &&
        typeof value.text === "string" &&
        value.text
      ) {
        pushAssistantText(value.text);
        continue;
      }
      if (value.type !== "toolCall" || typeof value.id !== "string") continue;
      const result = toolResults.get(value.id);
      const diff = toolDiffText(result?.details, result);
      const output = result ? toolResultText(result, diff) : undefined;
      const images = toolImageRefs(result?.content);
      const target =
        value.arguments &&
        typeof value.arguments === "object" &&
        !Array.isArray(value.arguments)
          ? (value.arguments as Record<string, unknown>).path
          : undefined;
      items.push({
        id: value.id,
        kind: "tool",
        sessionId,
        name: typeof value.name === "string" ? value.name : "tool",
        description: typeof value.name === "string" ? value.name : "Tool call",
        ...(value.arguments === undefined
          ? {}
          : { command: boundedJson(value.arguments) }),
        status: result
          ? result.isError === true
            ? "failed"
            : "completed"
          : abortedTurn
            ? "cancelled"
            : unresolvedToolStatus,
        createdAt,
        ...(output ? { output } : {}),
        ...(diff ? { diff } : {}),
        ...(typeof target === "string" && target ? { targetPath: target } : {}),
        ...(images.length > 0 ? { images } : {}),
        ...(value.name === "task"
          ? {
              subagents: taskSubagents(
                value.arguments,
                result
                  ? result.isError === true
                    ? "failed"
                    : "completed"
                  : abortedTurn
                    ? "cancelled"
                    : unresolvedToolStatus,
                output,
              ),
            }
          : {}),
      });
    }
    if (!emittedAssistantText) pushAssistantText(body);
  }
  return items;
}

function agentCommands(commands: AvailableCommand[]): AgentCommand[] {
  return commands.map((command) => ({
    name: command.name,
    description: command.description ?? "",
    ...(command.input?.hint ? { hint: command.input.hint } : {}),
  }));
}

type SdkSlashCommandSpec = AgentCommand & {
  operations: readonly string[];
};

/**
 * Desktop slash commands backed by public GJC SDK operations.
 *
 * This is an adapter from the SDK's semantic operation names to the CLI spelling,
 * not an independent claim about availability. The live `runtime.capabilities`
 * response is authoritative and filters the list before it reaches the renderer.
 * TUI-only commands are intentionally absent: they have no SDK operation to invoke.
 */
/**
 * Components `runtime.reload` accepts. Mirrors the runtime's own adapter
 * validation (`sdk/protocol/adapter-validation.ts`), which rejects anything else
 * with `invalid_reload_component`.
 */
const SDK_RELOAD_COMPONENTS = [
  "config",
  "models",
  "skills",
  "extensions",
  "tools",
] as const;

/**
 * The `service_tier.set` tier that means "send no service_tier parameter".
 *
 * GJC's own `/fast off` clears the tier (`setServiceTier(undefined)`), and the SDK
 * control cannot carry `undefined` -- the host validates `tier` as one of the
 * settings values. `none` is that settings value ("Omit service_tier parameter"),
 * and `resolveServiceTier`/`shouldSendServiceTier` treat it exactly like
 * `undefined` on the wire, so this is the same request the CLI ends up sending.
 */
const SDK_SERVICE_TIER_OFF = "none";

/** Tiers GJC counts as fast-mode intent (`isFastModeEnabled`). */
const SDK_FAST_SERVICE_TIERS = new Set(["priority", "claude-only", "openai-only"]);

/**
 * Fast tiers scoped to one provider family. An explicit `/fast on` for one of
 * these keeps the user's scope instead of widening it to `priority`
 * (`AgentSession.setFastMode` re-arms an already-enabled tier rather than
 * replacing it).
 */
const SDK_SCOPED_FAST_SERVICE_TIERS = new Set(["claude-only", "openai-only"]);

/**
 * Whether the session's config explicitly turns skills off.
 *
 * Only an explicit false counts: a host that reports nothing about skills leaves
 * its own default (skill commands are enabled) in force. Both shapes a runtime may
 * report are read -- flat `skills.enabled` / `skills.enableSkillCommands` keys, and
 * a nested `skills` group object.
 */
function skillsDisabledByConfig(config: readonly unknown[]): boolean {
  const disabled = (value: unknown): boolean =>
    value === false || value === "false";
  const groupDisables = (group: unknown): boolean => {
    if (!group || typeof group !== "object" || Array.isArray(group)) return false;
    const value = group as Record<string, unknown>;
    return (
      disabled(value.enabled) || disabled(value.enableSkillCommands)
    );
  };
  for (const row of config) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const item = row as Record<string, unknown>;
    if (
      disabled(item["skills.enabled"]) ||
      disabled(item["skills.enableSkillCommands"])
    )
      return true;
    const key = String(item.key ?? item.name ?? item.id ?? "");
    const value = item.value ?? item.currentValue;
    if (key === "skills.enabled" || key === "skills.enableSkillCommands") {
      if (disabled(value)) return true;
      continue;
    }
    const group = key === "skills" ? value ?? item.skills : item.skills;
    if (group !== undefined && groupDisables(group)) return true;
  }
  return false;
}

const SDK_SLASH_COMMAND_SPECS: readonly SdkSlashCommandSpec[] = [
  {
    name: "context",
    description: "Show active context token usage",
    operations: ["context.get"],
  },
  {
    name: "usage",
    description: "Show token usage",
    operations: ["usage.get"],
  },
  {
    name: "tools",
    description: "Show tools available to this session",
    operations: ["tools.list"],
  },
  {
    name: "jobs",
    description: "Show background jobs",
    operations: ["runtime.jobs.list"],
  },
  {
    name: "session",
    description: "Show session information or delete it",
    hint: "info|delete",
    operations: ["session.metadata", "session.stats"],
  },
  {
    name: "transcript",
    description: "Show transcript entries",
    operations: ["transcript.list"],
  },
  {
    name: "dump",
    description: "Return the transcript as text",
    operations: ["transcript.list"],
  },
  {
    name: "extensions",
    description: "Show active extensions",
    operations: ["extensions.list"],
  },
  {
    name: "provider",
    description: "Show active providers or start login",
    hint: "[login <provider>]",
    operations: ["providers.list/active", "auth.providers", "auth.login"],
  },
  {
    name: "credential",
    description: "Show credential provider status",
    operations: ["auth.providers"],
  },
  {
    name: "goal",
    description: "Show or operate goal mode",
    hint: "[set|show|pause|resume|complete|drop] [objective]",
    operations: ["goal.list/get", "mode.goal.operate"],
  },
  {
    name: "model",
    description: "Select the active model profile",
    hint: "[profile]",
    operations: ["model.profile.set", "model.set", "models.profiles.list"],
  },
  {
    name: "effort",
    description: "Show or set model reasoning effort",
    hint: "[inherit|off|minimal|low|medium|high|xhigh|max]",
    operations: ["thinking.set"],
  },
  {
    name: "fast",
    description: "Toggle the priority service tier intent",
    hint: "[toggle|on|off|status]",
    operations: ["service_tier.set"],
  },
  {
    name: "skills",
    description: "List the skills this session can run",
    operations: ["skill.list/state"],
  },
  {
    name: "progress",
    description: "Show the project progress snapshot",
    operations: ["session.progress"],
  },
  {
    name: "reload",
    description: "Reload runtime components",
    hint: "[config|models|skills|extensions|tools]",
    operations: ["runtime.reload"],
  },
  {
    name: "plan",
    description: "Turn plan mode on or off",
    hint: "[on|off]",
    operations: ["mode.plan.set"],
  },
  {
    name: "export",
    description: "Export this session to HTML",
    operations: ["session.export_html"],
  },
  {
    name: "clear",
    description: "Clear context while preserving this session ID",
    operations: ["context.clear"],
  },
  {
    name: "compact",
    description: "Compact context and continue this session",
    operations: ["compaction.run"],
  },
  {
    name: "retry",
    description: "Retry the last interrupted turn",
    operations: ["retry.last"],
  },
  {
    name: "background",
    description: "Move the active managed bash job to the background",
    operations: ["bash.background"],
  },
  {
    name: "rename",
    description: "Rename the current session",
    hint: "<title>",
    operations: ["session.rename"],
  },
  {
    name: "move",
    description: "Move the session working directory",
    hint: "<path>",
    operations: ["session.cwd.move"],
  },
];

export function sdkSlashCommandsForOperations(
  operations: readonly string[],
): AgentCommand[] {
  const available = new Set(operations);
  return SDK_SLASH_COMMAND_SPECS.flatMap((spec) =>
    spec.operations.some((operation) => available.has(operation))
      ? [
          {
            name: spec.name,
            description:
              spec.name === "provider" && !available.has("auth.login")
                ? "Show active provider status"
                : spec.description,
            ...(spec.hint &&
            !(spec.name === "provider" && !available.has("auth.login"))
              ? { hint: spec.hint }
              : {}),
          },
        ]
      : [],
  );
}

function configOptionValues(
  option: Extract<SessionConfigOption, { type: "select" }>,
): AgentConfigOption["options"] {
  // A select carries either flat items or groups of items; both shapes reach here.
  return option.options
    .flatMap((item) =>
      "group" in item && Array.isArray(item.options)
        ? (item.options as Array<Record<string, unknown>>)
        : [item],
    )
    .flatMap((item) => {
      const value = item.id ?? item.value;
      if (typeof value !== "string") return [];
      const name = typeof item.name === "string" ? item.name : value;
      const description =
        typeof item.description === "string" ? item.description : undefined;
      const group = typeof item.group === "string" ? item.group : undefined;
      return [
        {
          value,
          name,
          ...(description ? { description } : {}),
          ...(group ? { group } : {}),
        },
      ];
    });
}

function agentConfigOptions(
  options: SessionConfigOption[],
): AgentConfigOption[] {
  return options.map((option) =>
    option.type === "select"
      ? {
          id: option.id,
          name: option.name,
          category: option.category ?? undefined,
          type: "select",
          currentValue: option.currentValue ?? "",
          options: configOptionValues(option),
        }
      : {
          id: option.id,
          name: option.name,
          category: option.category ?? undefined,
          type: "boolean",
          currentValue: option.currentValue ?? false,
        },
  );
}

function boundedJson(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  try {
    const text = redactSensitiveText(
      typeof value === "string" ? value : JSON.stringify(value, null, 2),
    );
    return text.length > MAX_TOOL_TEXT
      ? `${text.slice(0, MAX_TOOL_TEXT)}…`
      : text;
  } catch {
    return String(value);
  }
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]{12,}/giu, "$1[REDACTED]")
    .replace(/\b(sk-[A-Za-z0-9_-]{12,})\b/gu, "[REDACTED]")
    .replace(
      /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret)["']?\s*[:=]\s*["']?)[^\s,"'}]+/giu,
      "$1[REDACTED]",
    )
    .replace(
      /\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD))=([^\s]+)/gu,
      "$1=[REDACTED]",
    );
}

function artifactReferences(value: unknown): string[] {
  let text: string | undefined;
  try {
    text =
      typeof value === "string"
        ? value
        : value == null
          ? undefined
          : JSON.stringify(value);
  } catch {
    text = undefined;
  }
  if (!text) return [];
  return [
    ...new Set(
      [...text.matchAll(/artifact:\/\/([A-Za-z0-9._-]+)/gu)].map(
        (match) => match[1]!,
      ),
    ),
  ];
}

/**
 * `## No commits yet on main` is the header of an unborn branch. Splitting it on
 * whitespace reports the branch as "No", which is what the header indicator showed
 * for a repository whose first commit does not exist yet.
 */
export function gitBranchFromHeader(header: string): string {
  const unborn = /^No commits yet on (.+)$/u.exec(header);
  if (unborn) return unborn[1]!.trim();
  if (header.startsWith("HEAD (no branch)")) return "HEAD";
  return header.split(" ")[0] ?? "";
}

function safeGitPath(value: string): boolean {
  return (
    Boolean(value) &&
    !path.isAbsolute(value) &&
    !value.includes("\0") &&
    value !== ".." &&
    !value.startsWith("../")
  );
}

/**
 * GJC tool state as this app displays it.
 *
 * `pending` and `in_progress` are separate states and GJC sends both: a call
 * arrives pending and can sit there for seconds before it starts. Mapping both to
 * running spun a spinner and said 작업 중 for work that had not begun.
 *
 * An update carrying no status says nothing about the call, so the caller's existing
 * state stands and running is the safe assumption for a brand new one.
 */
export function toolStatus(
  status: ToolCallStatus | null | undefined,
): ToolActivity["status"] {
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "pending") return "pending";
  return "running";
}

export function inferToolName(
  update: Extract<
    SessionUpdate,
    { sessionUpdate: "tool_call" | "tool_call_update" }
  >,
  existing?: ToolActivity,
): string {
  if (existing?.name) return existing.name;
  const reported =
    "name" in update && typeof update.name === "string"
      ? update.name
      : undefined;
  if (reported) return reported;

  const input =
    update.rawInput &&
    typeof update.rawInput === "object" &&
    !Array.isArray(update.rawInput)
      ? (update.rawInput as Record<string, unknown>)
      : undefined;
  if (Array.isArray(input?.ops)) return "todo_write";
  if (typeof input?.command === "string") return "bash";
  if (typeof input?.agent === "string" && Array.isArray(input.tasks))
    return "task";
  if (
    typeof input?.action === "string" &&
    (typeof input.id === "string" || Array.isArray(input.ids))
  )
    return "subagent";
  if (typeof input?.objective === "string" && typeof input.op === "string")
    return "goal";
  if (Array.isArray(input?.paths))
    return typeof input.pattern === "string" ? "search" : "find";
  if (
    typeof input?.input === "string" &&
    input.input.includes("*** Begin Patch")
  )
    return "edit";
  if (typeof input?.path === "string" && typeof input.content === "string")
    return "write";
  if (typeof input?.path === "string") return "read";
  if (
    typeof input?.query === "string" &&
    typeof input.limit === "number" &&
    update.kind === "other"
  )
    return "search_tool_bm25";

  if (update.kind === "execute") return "bash";
  if (update.kind === "read") return "read";
  if (update.kind === "edit") return "edit";
  if (update.kind === "delete") return "delete";
  if (update.kind === "move") return "move";
  if (update.kind === "search") return "search";
  if (update.kind === "fetch") return "web_search";
  if (update.kind === "think") return "todo_write";
  return "tool";
}

function readableSessionTitle(
  sessionId: string,
  title: string | null | undefined,
): string {
  const reportedTitle = title?.trim();
  const titleLooksGenerated =
    !reportedTitle ||
    reportedTitle === sessionId ||
    /^[0-9a-f]{8}-[0-9a-f-]{27,}$/iu.test(reportedTitle);
  return titleLooksGenerated
    ? `GJC session · ${sessionId.slice(0, 8)}`
    : reportedTitle;
}

function missingSessionError(error: unknown): boolean {
  if (isSessionMissing(error)) return true;
  const text = error instanceof Error ? error.message : String(error);
  return /saved session does not exist|session is not indexed|unknown GJC session/iu.test(
    text,
  );
}

function lifecycleUncertainError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /terminal_uncertain|lifecycle terminal evidence could not be verified|retained artifacts require reconciliation|cleanup authority is uncertain|cannot be deleted safely|requires durable locator authority|ownership is uncertain|authority is ambiguous|authority is pending/iu.test(
    text,
  );
}

/**
 * A lifecycle mutation whose outcome GJC could not establish.
 *
 * gjc/0.18.11 answers `session.delete` with `operation_failed` and "The operation
 * failed. Its outcome could not be established." (`outcomeCertainty: unknown`,
 * retryability `unknown`, next step "do not blindly retry") on the installed build,
 * reproducibly and in a fresh agent directory, while the broker row stays
 * `deleted: false`. It is not proof that the delete landed or failed, so it must be
 * handled the way this file handles every other unknown lifecycle outcome: re-read
 * the broker row and let only that evidence decide.
 */
function uncertainLifecycleOutcomeError(error: unknown): boolean {
  if (!(error instanceof SdkCliError)) return false;
  return (
    error.code === "operation_failed" &&
    /outcome could not be established/iu.test(error.message)
  );
}

function liveSessionDeleteError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /live_session|refusing to delete a live session/iu.test(text);
}

function missingLifecycleSessionError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /not_found|session is not indexed|does not exist/iu.test(text);
}

export function busyPromptError(error: unknown): boolean {
  // gjc/0.18.11 answers a second prompt with the typed code `busy` and the text
  // "The session is running a turn and refused the request." (verified). The
  // message patterns below are the older ones and no longer match that text, so
  // without the code check a follow-up typed during a run surfaced as a raw error
  // instead of being delivered as a steer.
  if (error instanceof SdkCliError) {
    if (error.code === "busy" || error.code === "prompt_busy" || error.code === "agent_busy")
      return true;
  }
  const text = error instanceof Error ? error.message : String(error);
  return /already has an active prompt|is running a turn and refused|turn\.prompt is unavailable while the agent is busy|agent is busy.*turn\.steer|prompt_busy|agent_busy/iu.test(
    text,
  );
}

export function cancelledOperationError(error: unknown): boolean {
  const value =
    error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return /\b(?:operation[ _-]?aborted|operation[ _-]?cancelled|operation[ _-]?canceled|aborterror|request aborted)\b/iu.test(
    value,
  );
}
export function uncertainAfterSendError(error: unknown): boolean {
  if (error instanceof SdkCliError && error.code === "uncertain_after_send")
    return true;
  const text = error instanceof Error ? error.message : String(error);
  return /uncertain_after_send|SDK request outcome is uncertain after the frame was sent/iu.test(
    text,
  );
}

export function brokerFailureMessage(error: unknown): string {
  const candidate =
    error && typeof error === "object"
      ? (error as { stdout?: unknown; stderr?: unknown; message?: unknown })
      : undefined;
  for (const output of [candidate?.stdout, candidate?.stderr]) {
    if (typeof output !== "string" || !output.trim()) continue;
    try {
      const parsed = JSON.parse(output) as { error?: { message?: unknown } };
      if (typeof parsed.error?.message === "string" && parsed.error.message)
        return parsed.error.message;
    } catch {
      return output.trim();
    }
  }
  return typeof candidate?.message === "string"
    ? candidate.message
    : String(error);
}

// Shown when a live session has no shared control route this window can use. It
// names the route and the retry rather than the process that might hold the
// session: a live row the broker cannot route to is not proof that a terminal owns
// it, and the session itself is never closed, resumed, or replaced by this message.
export const SHARED_ROUTE_UNAVAILABLE_MESSAGE =
  "이 세션의 공유 제어 경로를 확인할 수 없습니다. 세션과 기록은 그대로 유지됩니다. GJC에서 세션을 다시 열거나 잠시 뒤 다시 시도하면 이어서 제어할 수 있습니다.";

// Shown when the session answers this window but GJC refuses the operator-owned
// Stop. The broker control route requires the session's indexed
// `lifecycleRequestId` (`Broker.#sessionControlAuthority`) and the host compares it
// against `GJC_LIFECYCLE_REQUEST_ID` (`hasBrokerRuntimeAbortCapability`); a directly
// launched TUI host need not carry that identity, so metadata, prompts, and
// steering keep working while Stop is refused. There is no ordinary `turn.abort`
// fallback: it has a different contract and cannot substantiate that owned work
// stopped, so this reports the refusal instead of claiming the work is gone.
export const OWNED_STOP_UNAVAILABLE_MESSAGE =
  "이 세션은 앱에서 계속 제어할 수 있지만, GJC가 이 호스트의 소유자 중지(Stop) 권한을 확인할 수 없습니다. 작업과 백그라운드 작업이 멈췄다면 그 결과는 확정되지 않았습니다. 세션이 중지를 허용하면 다시 시도해 주세요.";

/**
 * Canonical identity for a workspace directory.
 *
 * The same directory reaches this controller in two forms: the path a caller hands
 * in, and the resolved `cwd` GJC reports in its broker locator. On macOS those are
 * `/var/folders/...` and `/private/var/folders/...`, which name one directory but
 * compare as two strings. Creating a session in the first form and then re-hosting
 * it left the sidebar and this controller holding both, so a fork of the re-hosted
 * session was reported in a different workspace than the session it came from. One
 * canonical form per directory keeps every comparison in this file meaningful.
 */
export function canonicalWorkspace(directory: string): string {
  try {
    return realpathSync.native(directory);
  } catch {
    return path.resolve(directory);
  }
}

export function sessionInfoToAgentSession(info: SessionInfo): AgentSession {
  const cwd = info.cwd ?? "";
  return {
    id: info.sessionId,
    title: readableSessionTitle(info.sessionId, info.title),
    subtitle: path.basename(cwd) || cwd,
    workspace: cwd,
    runtime: "gjc",
    status: "idle",
    updatedAt: recentLabel(info.updatedAt),
    updatedAtMs: timestampMs(info.updatedAt),
    pinned: false,
    unread: false,
    accent: GJC_ACCENT,
    ownership: "external",
    attachment: "attachable",
  };
}

/**
 * A session file's title, message count, and last activity.
 *
 * The first line is the session envelope (`cwd`, id); the rest are messages. The
 * first user message is what identifies the session to a human, because a
 * persisted session carries no title of its own.
 */
export function historySessionSummary(
  lines: readonly string[],
): { cwd?: string; title?: string; messageCount: number } | undefined {
  let cwd: string | undefined;
  let title: string | undefined;
  let messageCount = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (row.type === "session" && typeof row.cwd === "string") {
      cwd = row.cwd;
      continue;
    }
    if (row.type !== "message") continue;
    const message =
      row.message && typeof row.message === "object" && !Array.isArray(row.message)
        ? (row.message as Record<string, unknown>)
        : row;
    if (message.role !== "user" && message.role !== "assistant") continue;
    messageCount += 1;
    if (title || message.role !== "user") continue;
    const text = Array.isArray(message.content)
      ? message.content
          .flatMap((part) =>
            part &&
            typeof part === "object" &&
            !Array.isArray(part) &&
            (part as Record<string, unknown>).type === "text" &&
            typeof (part as Record<string, unknown>).text === "string"
              ? [String((part as Record<string, unknown>).text)]
              : [],
          )
          .join(" ")
      : typeof message.content === "string"
        ? message.content
        : "";
    // Attachment blocks are machinery, not intent, so they never become a title.
    const body = text
      .replace(
        /<local-(?:attachments|files|images)>[\s\S]*?<\/local-(?:attachments|files|images)>/gu,
        "",
      )
      .replace(/\s+/gu, " ")
      .trim();
    if (body) title = body.slice(0, 80);
  }
  if (messageCount === 0) return undefined;
  return {
    ...(cwd ? { cwd } : {}),
    ...(title ? { title } : {}),
    messageCount,
  };
}

export function thinkingOptionsForModelCatalog(
  items: unknown[],
  selectedModel: string,
): AgentConfigOptionValue[] | undefined {
  const rows = items.flatMap((item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? [item as Record<string, unknown>]
      : [],
  );
  const selected =
    rows.find(
      (row) => row.provider === "gajae-code" && row.id === selectedModel,
    ) ??
    rows.find(
      (row) =>
        `${String(row.provider ?? "")}/${String(row.id ?? "")}` ===
        selectedModel,
    ) ??
    rows.find((row) => row.id === selectedModel && row.current === true) ??
    rows.find((row) => row.current === true);
  const thinking = selected?.thinking;
  if (!thinking || typeof thinking !== "object" || Array.isArray(thinking))
    return undefined;
  const validLevels = (thinking as Record<string, unknown>).validLevels;
  if (!Array.isArray(validLevels)) return undefined;
  const levels = validLevels.filter(
    (level): level is string =>
      typeof level === "string" && EFFORT_LEVELS.has(level),
  );
  return levels.length > 0
    ? levels.map((level) => ({ value: level, name: level }))
    : undefined;
}

export function profileDefaultModelLabel(
  items: unknown[],
  selectedModel: string,
): string | undefined {
  const row = items
    .flatMap((item) =>
      item && typeof item === "object" && !Array.isArray(item)
        ? [item as Record<string, unknown>]
        : [],
    )
    .find(
      (item) => item.provider === "gajae-code" && item.id === selectedModel,
    );
  const defaultModel = row?.profileDefaultModel;
  if (
    !defaultModel ||
    typeof defaultModel !== "object" ||
    Array.isArray(defaultModel)
  )
    return undefined;
  const model = defaultModel as { name?: unknown; id?: unknown };
  return typeof model.name === "string" && model.name
    ? model.name
    : typeof model.id === "string"
      ? model.id
      : undefined;
}

export class GjcSdkController {
  private workspace: string;
  private configuredExecutable?: string;
  private modelPreset: AgentControlPreferences["modelPreset"];
  private modelPresetThinking?: string;
  private permissionHandling: AgentControlPreferences["permissionHandling"];
  private readonly sessionMetadata?: SessionMetadataStore;
  private readonly emitEvent: (event: AgentEvent) => void;
  private readonly artifactDirectory: string;
  private readonly sessions = new Map<string, AgentSession>();
  private readonly sessionCwds = new Map<string, string>();
  private readonly attachedSessions = new Set<string>();
  private readonly transcripts = new Map<string, TranscriptItem[]>();
  private readonly messageKeys = new Map<string, Map<string, string>>();
  private readonly activeAssistantMessages = new Map<string, string>();
  private readonly activeThoughts = new Map<string, string>();
  private readonly activePromptSessions = new Set<string>();
  private readonly cancellingSessions = new Set<string>();
  private readonly cancellationPromises = new Map<string, Promise<void>>();
  private readonly flushingSessions = new Set<string>();
  private readonly pendingSteers = new Map<string, Promise<void>>();
  private readonly suppressedUserMessageKeys = new Map<string, Set<string>>();
  // A prompt renders its own user bubble immediately so an ordinary chat message
  // appears without waiting for the agent round trip. GJC echoes the same prompt
  // back as a user update, so the first echo of each text is dropped.
  private readonly echoedPromptTexts = new Map<string, string[]>();
  private readonly locallyAbortedSessions = new Set<string>();
  /** Compaction is finished only when GJC says so, never when the request returns. */
  private readonly compactingSessions = new Set<string>();
  // How many compaction records the transcript held when compaction started. A
  // terminal-owned session never receives session_info_update, so the live signal
  // cannot release the phase for it; a new record appearing is the evidence that
  // GJC finished. Without this the indicator stayed up for the rest of the session.
  private readonly compactionRecordBaseline = new Map<string, number>();
  // Latest durable compaction record timestamp observed for each session. Live
  // phase updates at or before this watermark are delayed stale delivery.
  private readonly compactionRecordWatermark = new Map<string, number>();
  // Timestamped compacting phases start a distinct cycle. A durable record older
  // than this boundary belongs to the preceding cycle and cannot finish this one.
  private readonly compactionStartedAt = new Map<string, number>();
  // Sessions live SDK evidence currently reports as working. The persisted
  // transcript lags behind that signal, so it is not allowed to report one of
  // these idle until GJC itself says the turn ended.
  private readonly liveRunningSessions = new Set<string>();
  // Transcript size at the moment the live signal reported work, keyed by session.
  // Anything at that size is the snapshot the signal already superseded; a larger
  // file is a newer account.
  private readonly liveRunningDigests = new Map<string, number>();
  /**
   * Sessions whose running state was read out of their transcript.
   *
   * Attaching to a session makes GJC publish a bootstrap `gjcRunning:false` about
   * this connection's own prompt state. For a session another process is driving that
   * report is uninformative, and taking it as a completion flipped the row to 완료 the
   * moment it was clicked. Remembering where the running state came from is what
   * tells that report apart from a real one.
   */
  private readonly transcriptRunningSessions = new Set<string>();
  /**
   * Sessions whose current work cycle GJC confirmed with a non-idle phase.
   *
   * The marker survives runtime idle until the transcript confirms the final assistant
   * row. The phase is the only signal that separates a turn waiting on a tool result
   * from one that ended, because `gjcRunning:false` also describes this connection's
   * idle prompt slot while a steer drives the actual work.
   */
  private readonly workingPhaseSessions = new Set<string>();
  /**
   * Sessions whose runtime has reported a real idle transition after a working phase.
   *
   * Neither side closes a cycle alone. Runtime idle can arrive while the model is
   * still responding after a tool, and the transcript can contain a `stop` row before
   * more tool calls are appended. A session that emitted a working phase settles only
   * after this marker and a terminal transcript agree.
   */
  private readonly runtimeIdleSessions = new Set<string>();
  /** Sessions with a detached task that has not delivered its async-result yet. */
  private readonly pendingAsyncWorkSessions = new Set<string>();
  /**
   * Launch markers a session's transcript carried when the runtime was last asked
   * which jobs it still has running.
   *
   * `runtime.jobs.list` is the only authority that can retire a marker whose job was
   * paused, cancelled, or taken down with its process -- none of those deliver the
   * `async-result` release a completed detached task writes. A retired marker is
   * remembered because the transcript rows that wrote it never change: without that,
   * every later read of the same file would re-arm the latch it belongs to.
   */
  private readonly asyncJobReconciliations = new Map<
    string,
    { checkedAt: number; deadJobIds: Set<string> }
  >();
  /** Monotonic per-session lifecycle generation for async status reads and IPC merges. */
  private readonly runRevisions = new Map<string, number>();
  /**
   * Transcript-derived run state per session, keyed by the file size it was read at.
   *
   * `runningJobIds` records the launch markers the verdict at that size rests on,
   * so a size-unchanged read can still notice that the job behind them ended.
   */
  private readonly discoveredRunStates = new Map<
    string,
    { size: number; status: AgentSession["status"]; runningJobIds?: string[] }
  >();
  /** Delay between broker polls while recovering a fork's session id. */
  private forkRecoveryIntervalMs = 250;
  private readonly sessionCommands = new Map<string, AgentCommand[]>();
  /**
   * Commands the runtime itself advertised (`available_commands_update`).
   *
   * This is the authoritative set and is replaced wholesale on every event, so a
   * command the runtime withdraws disappears from the palette. It is kept apart
   * from the merged cache because that cache is also fed by this window's adapter
   * specs and by runtime state discovery, and neither of those may speak for GJC.
   */
  private readonly sessionAdvertisedCommands = new Map<string, AgentCommand[]>();
  /**
   * Dynamic commands discovered from runtime state on attach/create rather than
   * from an `available_commands_update`. Replaced wholesale by each discovery pass.
   */
  private readonly sessionDiscoveredCommands = new Map<string, AgentCommand[]>();
  private readonly sessionSdkOperations = new Map<string, Set<string>>();
  private readonly sessionConfig = new Map<string, AgentConfigOption[]>();
  /**
   * The last plan the runtime reported for a session.
   *
   * `sessionUpdate=plan` is the only plan source, and the durable session file does
   * not record plans. A rescan therefore replaced the transcript array with file
   * rows and the plan of a session that was still running it disappeared, so the
   * row is retained here and composed back into every install of that transcript.
   */
  private readonly sessionPlans = new Map<string, PlanActivity>();
  /** The runtime's todo store as this window last observed it, per session. */
  private readonly sessionTodoSnapshots = new Map<string, TodoSnapshotState>();
  /**
   * The in-flight todo read per session.
   *
   * Nothing pushes todo changes, so reads are event-driven: a transcript bootstrap
   * and an observed todo tool completion. Sharing the pending promise keeps a burst
   * of those from becoming a burst of runtime calls, and no timer polls it.
   */
  private readonly todoReads = new Map<string, Promise<unknown[] | undefined>>();
  private readonly terminalOnlySessions = new Set<string>();
  private readonly modelProfiles = new Map<string, AgentConfigOptionValue[]>();
  private readonly explicitSessionThinking = new Map<string, string>();
  private readonly pendingPermissions = new Map<string, PendingPermission>();
  private readonly artifactWrites = new Map<string, Promise<void>>();
  private readonly artifactSessionIds = new Map<string, Set<string>>();
  private readonly deletingSessions = new Set<string>();
  private readonly deletionPromises = new Map<string, Promise<void>>();
  private readonly sharedSessionFiles = new Map<string, string>();
  // A transcript is append-only, so a rescan only has to parse the bytes added
  // since the last one. Device/inode identify the file so a compaction that
  // rewrites or truncates it is detected and falls back to a full parse.
  //
  // Every entry retains the file's parsed envelopes, so the map is held to the
  // transcripts actually being re-read. Measured at 6.3MB per entry, an unbounded
  // map reached 372MB across 60 transcripts and would pass 2GB across the 400 on
  // this machine. Insertion order makes it an LRU: the oldest key is evicted first.
  private static readonly SHARED_TRANSCRIPT_CACHE_LIMIT = 8;
  private readonly sharedTranscriptReads = new Map<
    string,
    {
      device: number;
      inode: number;
      size: number;
      envelopes: Record<string, unknown>[];
      partial: string;
    }
  >();
  private readonly sharedSessionWatchers = new Map<string, FSWatcher>();
  private readonly sharedSessionRefreshTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly imageDataUrls = new Map<string, string>();
  private readonly attachAttempts = new Map<string, number>();
  private readonly contextUsageQueries = new Map<string, Promise<void>>();

  private connectionState: BackendConnection;
  /**
   * The `gjc sdk session` client.
   *
   * There is no resident agent process and no connection object: each call is its
   * own short-lived CLI invocation. `readiness` only memoises resolving the
   * executable and reading the broker index once per start, so the window can
   * report a real state instead of pretending to be connected.
   */
  private cli?: GjcSdkCli;
  private startup?: Promise<void>;
  private disposed = false;
  private nextLocalId = 1;
  private generation = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private reconnectAttempt = 0;
  /** Sessions whose permission mode has been applied for this runtime generation. */
  private readonly permissionModeApplied = new Set<string>();
  /** Live tail catch-up reads in flight, keyed by session. */
  private readonly tailReads = new Map<string, Promise<void>>();
  /** Abort handles for the short-lived tail CLI child currently reading a session. */
  private readonly tailControllers = new Map<string, AbortController>();
  /** Latest tail checkpoint claim per session, so a re-read resumes rather than rewinds. */
  private readonly tailCheckpoints = new Map<string, string>();

  constructor(options: GjcControllerOptions) {
    this.workspace = canonicalWorkspace(options.workspace);
    this.configuredExecutable = options.executable;
    this.modelPreset = options.modelPreset ?? DEFAULT_MODEL_PRESET;
    this.permissionHandling = options.permissionHandling ?? "prompt";
    this.sessionMetadata = options.sessionMetadata;
    this.emitEvent = options.emit;
    this.artifactDirectory = path.resolve(
      options.artifactDirectory ??
        path.join(this.workspace, ".gajae-artifacts"),
    );
    this.connectionState = {
      state: "disconnected",
      backend: "gjc",
      label: "GJC",
      detail: "Not connected",
      workspace: this.workspace,
      modelPreset: this.modelPreset,
    };
  }

  async getConnection(): Promise<BackendConnection> {
    try {
      await this.ensureStarted();
    } catch (error) {
      this.setConnection({
        state: "error",
        backend: "gjc",
        label: "GJC unavailable",
        detail: error instanceof Error ? error.message : String(error),
        workspace: this.workspace,
        modelPreset: this.modelPreset,
      });
    }
    return { ...this.connectionState };
  }

  async reconfigure(preferences: AgentControlPreferences): Promise<boolean> {
    const workspace = canonicalWorkspace(preferences.workspace);
    const executable = preferences.gjcExecutable || undefined;
    const runtimeChanged =
      this.configuredExecutable !== executable ||
      this.modelPreset !== preferences.modelPreset ||
      this.permissionHandling !== preferences.permissionHandling;
    this.workspace = workspace;
    this.configuredExecutable = executable;
    this.modelPreset = preferences.modelPreset;
    this.permissionHandling = preferences.permissionHandling;
    if (!runtimeChanged) {
      this.setConnection({ ...this.connectionState, workspace });
      return false;
    }

    for (const pending of this.pendingPermissions.values())
      pending.resolve({ outcome: { outcome: "cancelled" } });
    this.pendingPermissions.clear();
    // No resident process to stop: dropping the client is the whole teardown, and
    // the next call rebuilds it against the new runtime.
    this.cli = undefined;
    this.startup = undefined;
    this.permissionModeApplied.clear();
    for (const sessionId of this.tailControllers.keys())
      this.stopTailFollower(sessionId);
    this.attachedSessions.clear();
    // The new runtime re-attaches from scratch, so last run's throttle stamps must
    // not delay the first attempt against it.
    this.attachAttempts.clear();
    this.activePromptSessions.clear();
    this.liveRunningSessions.clear();
    this.liveRunningDigests.clear();
    this.transcriptRunningSessions.clear();
    this.workingPhaseSessions.clear();
    this.runtimeIdleSessions.clear();
    this.pendingAsyncWorkSessions.clear();
    this.asyncJobReconciliations.clear();
    this.discoveredRunStates.clear();
    this.compactingSessions.clear();
    this.compactionRecordBaseline.clear();
    this.compactionRecordWatermark.clear();
    this.compactionStartedAt.clear();
    this.activeAssistantMessages.clear();
    this.activeThoughts.clear();
    this.suppressedUserMessageKeys.clear();
    this.echoedPromptTexts.clear();
    this.sessionSdkOperations.clear();
    await this.ensureStarted();
    return true;
  }

  async listSessions(): Promise<AgentSession[]> {
    // Discovery is a background refresh that spawns broker CLI requests. Running
    // it while a prompt, steer, or abort is in flight adds avoidable process and
    // broker work, so it yields and the caller keeps the list it already has.
    if (
      this.lastDiscovered.length > 0 &&
      (this.activePromptSessions.size > 0 || this.pendingSteers.size > 0)
    )
      return this.lastDiscovered.map((session) => ({ ...session }));
    if (this.discoveryInFlight) return this.discoveryInFlight;
    const discovery = this.discoverSessions().finally(() => {
      this.discoveryInFlight = undefined;
    });
    this.discoveryInFlight = discovery;
    return discovery;
  }

  private discoveryInFlight: Promise<AgentSession[]> | undefined;
  // The session map is a durable cache keyed by every id ever seen, including
  // rows discovery later filtered out. Yielding must replay the last discovered
  // list instead, or skipping a scan resurrects dead sessions in the sidebar.
  private lastDiscovered: AgentSession[] = [];
  private lastLiveFingerprint: string | undefined;

  private async discoverSessions(): Promise<AgentSession[]> {
    const liveRanks = new Map<string, number>();
    // Every live GJC session is worth controlling from this window, so discovery
    // follows the broker's own repositories instead of only folders this app has
    // opened. Without it a session started by the CLI elsewhere stayed invisible.
    const liveWorkspaces = new Set<string>();
    const deadSessionIds = new Set<string>();
    // Not cleared here. A rescan re-derives terminal-only from broker liveness,
    // but a session that already failed a control operation is proven
    // uncontrollable by evidence the index does not carry -- discarding that made
    // the row advertise controls that fail again on the next click. Entries are
    // dropped when the session row itself goes away (removeLocalSession).
    const brokerRows = await this.brokerSessions();
    // Without the index there is no liveness or placeholder evidence, so the
    // previous result stands rather than republishing every historical session.
    if (!brokerRows)
      return this.lastDiscovered.map((session) => ({ ...session }));
    // The broker index is the full set of session ids that still exist anywhere. A
    // hidden id outside it has nothing left to hide, so it is dropped instead of
    // being carried in the metadata file for the life of the install.
    this.sessionMetadata?.forgetHiddenOutside(
      new Set(brokerRows.map((session) => session.sessionId)),
    );
    for (const session of brokerRows) {
      if (!session.live) {
        // The broker keeps every historical session id. Only live ones can be
        // controlled or replayed from here, so a dead id must not become a row.
        deadSessionIds.add(session.sessionId);
        continue;
      }
      const attachable = (session.endpointGeneration ?? 0) > 0;
      liveRanks.set(session.sessionId, attachable ? 2 : 1);
      if (attachable && this.terminalOnlySessions.has(session.sessionId)) {
        try {
          const cli = await this.requireCli();
          await cli.queryItems(session.sessionId, "session.metadata", {}, { repo: session.repo ?? this.workspace });
          this.terminalOnlySessions.delete(session.sessionId);
          const cached = this.sessions.get(session.sessionId);
          if (cached) cached.attachment = "attachable";
          this.lastLiveFingerprint = undefined;
        } catch {
          // Index liveness alone cannot establish a usable shared route.
        }
      }
      if (session.repo) liveWorkspaces.add(session.repo);
    }
    const workspaces = [
      ...new Set([
        this.workspace,
        ...(this.sessionMetadata?.listWorkspaces() ?? []),
        ...liveWorkspaces,
      ]),
    ];
    // The broker index only grows, so a scan costs the same whether or not
    // anything changed. When the live session set and its repositories are
    // identical to the previous scan there is nothing new to list, so the
    // per-workspace stage is skipped and the previous result is reused.
    //
    // Session identity alone is not enough to decide that: an agent starting or
    // finishing work changes no id and no repository, so a list whose rows were
    // first seen idle was replayed unchanged for the rest of the session and the
    // transcript was never consulted again. The transcript sizes of the rows this
    // window is not driving are part of what the answer depends on, so they are
    // part of the fingerprint.
    const observedSessionIds = [...liveRanks.keys()].filter(
      (sessionId) =>
        !this.activePromptSessions.has(sessionId) &&
        !this.liveRunningSessions.has(sessionId),
    );
    // Polling/fingerprint eligibility intentionally excludes a live signal: its
    // transcript may still be the pre-start snapshot. Watcher eligibility is
    // broader, though. A live signal without a matching idle report still needs
    // the transcript watcher to notice the eventual terminal row.
    const watchedSessionIds = [...liveRanks.keys()].filter(
      (sessionId) => !this.activePromptSessions.has(sessionId),
    );
    // Reconcile watchers before the fingerprint fast path. A session can become
    // watchable after an earlier scan failed to locate its transcript, even when
    // all polling inputs remain unchanged.
    await this.syncRunStateWatchers(watchedSessionIds);
    const runStates = await Promise.all(
      observedSessionIds
        .slice()
        .sort()
        .map(async (sessionId) => [
          sessionId,
          await this.discoveredRunState(sessionId),
        ]),
    );
    // `failed` and `starting` are written by this window rather than derived from
    // the transcript, so neither changes an id, a repository, or a transcript size.
    // Without them here a runtime failure could leave the fingerprint untouched and
    // replay previous rows, hiding the disconnect already recorded by the window.
    const ownStatuses = observedSessionIds
      .slice()
      .sort()
      .map((sessionId) => {
        const status = this.sessions.get(sessionId)?.status;
        return [
          sessionId,
          status === "failed" || status === "starting" ? status : "",
        ];
      })
      .filter(([, status]) => status !== "");
    const liveFingerprint = JSON.stringify([
      [...liveRanks.entries()].sort(),
      workspaces.slice().sort(),
      runStates,
      ownStatuses,
    ]);
    if (
      this.lastDiscovered.length > 0 &&
      liveFingerprint === this.lastLiveFingerprint
    )
      return this.lastDiscovered.map((session) => ({ ...session }));
    this.lastLiveFingerprint = liveFingerprint;
    const pages = await Promise.all(
      workspaces.map(async (cwd) => {
        try {
          // Sessions for this workspace come from the broker index, which already
          // carries every session id and repository; the session file supplies the
          // title and last activity.
          const sessions: SessionInfo[] = [];
          for (const row of brokerRows) {
            if (!row.repo || path.resolve(row.repo) !== path.resolve(cwd))
              continue;
            if (row.deleted) continue;
            const filePath = await this.locateSharedTranscriptFile(
              row.sessionId,
            );
            let title: string | undefined;
            let updatedAt: string | undefined;
            if (filePath) {
              try {
                const summary = historySessionSummary(
                  await transcriptHeadLines(filePath),
                );
                title = summary?.title;
                const info = await stat(filePath);
                updatedAt = new Date(info.mtimeMs).toISOString();
              } catch {
                /* an unreadable file still lists as a session */
              }
            }
            sessions.push({
              sessionId: row.sessionId,
              cwd: row.repo,
              ...(title ? { title } : {}),
              ...(updatedAt ? { updatedAt } : {}),
            });
          }
          return sessions;
        } catch (error) {
          if (cwd === this.workspace) throw error;
          return [];
        }
      }),
    );
    const listed = [
      ...new Map(
        pages.flat().map((session) => [session.sessionId, session]),
      ).values(),
    ]
      .filter((session) => !this.sessionMetadata?.isHidden(session.sessionId))
      .filter((session) => !deadSessionIds.has(session.sessionId))
      .sort(
        (left, right) =>
          (liveRanks.get(right.sessionId) ?? 0) -
            (liveRanks.get(left.sessionId) ?? 0) ||
          (Date.parse(right.updatedAt ?? "") || 0) -
            (Date.parse(left.updatedAt ?? "") || 0),
      );

    for (const info of listed) {
      const existing = this.sessions.get(info.sessionId);
      const persistedOwnership = this.sessionMetadata?.getOwnership(
        info.sessionId,
      );
      const ownership =
        persistedOwnership ??
        (existing?.ownership === "gajae"
          ? "gajae"
          : (liveRanks.get(info.sessionId) ?? 0) >= 2
            ? "available"
            : "external");
      const attachment = this.attachedSessions.has(info.sessionId)
        ? ("attached" as const)
        : this.terminalOnlySessions.has(info.sessionId)
          ? ("terminal-only" as const)
          : ("attachable" as const);
      const listedSession = sessionInfoToAgentSession(info);
      // Discovery metadata says nothing about whether the agent is working, and a
      // session this window has never opened has no other source, so it used to
      // default to idle -- work started from a terminal listed as finished. The
      // persisted transcript is the one account that exists for those sessions.
      const statusRevision = this.currentRunRevision(info.sessionId);
      const transcriptStatus = await this.discoveredRunState(info.sessionId);
      const currentSession = this.sessions.get(info.sessionId) ?? existing;
      const revisionChanged =
        statusRevision !== this.currentRunRevision(info.sessionId);
      const discoveredStatus =
        revisionChanged && currentSession
          ? currentSession.status
          : this.activePromptSessions.has(info.sessionId) ||
              this.liveRunningSessions.has(info.sessionId)
            ? (currentSession?.status ?? "idle")
            : currentSession?.status === "failed" ||
                currentSession?.status === "starting"
              ? currentSession.status
              : (transcriptStatus ?? currentSession?.status ?? "idle");
      // Lineage is not on the broker row this loop is reading, so it comes from the
      // session's own envelope.
      const parentId = await this.sessionParentId(info.sessionId);
      if (
        !revisionChanged &&
        currentSession &&
        currentSession.status !== discoveredStatus
      )
        this.advanceRunRevision(info.sessionId);
      // Session discovery only carries identity/cwd metadata. Replacing the whole row
      // here erased model, thinking, context usage, phase, and status that transcript
      // replay had just restored, so the UI drifted again after every list refresh.
      const session = {
        ...currentSession,
        ...listedSession,
        // Only a turn this window is actually driving keeps the status its own round
        // trip maintains. Being attached is not enough: attachment happens just by
        // opening a session, while the live `session_info_update` that would move the
        // status only arrives for prompts this process sent. A session someone else is
        // driving is attached, silent, and described solely by its transcript.
        //
        // `failed` and `starting` outrank the transcript. Both describe this window's
        // runtime rather than the turn: `failed` is written after a runtime error,
        // and `starting` covers a session whose first round trip has not landed. A
        // transcript that ended cleanly long ago would
        // otherwise report `idle` and erase a disconnect the user has not seen yet.
        status: discoveredStatus,
        runRevision: this.currentRunRevision(info.sessionId),
        phase: currentSession?.phase,
        mode: currentSession?.mode,
        model: currentSession?.model,
        modelDisplay: currentSession?.modelDisplay,
        thinking: currentSession?.thinking,
        usagePercent: currentSession?.usagePercent,
        usagePending: currentSession?.usagePending,
        ownership,
        attachment,
        unread:
          this.sessionMetadata?.getUnread(info.sessionId) ??
          currentSession?.unread ??
          false,
        worktree: this.sessionMetadata?.getWorktree(info.sessionId),
        parentId: parentId ?? currentSession?.parentId,
      };
      session.title =
        this.sessionMetadata?.getAlias(session.id) ?? session.title;
      this.sessions.set(session.id, session);
      if (info.cwd) this.sessionCwds.set(session.id, info.cwd);
    }

    this.lastDiscovered = listed.map((info) => ({
      ...this.sessions.get(info.sessionId)!,
    }));
    return this.lastDiscovered.map((session) => ({ ...session }));
  }

  private readonly runStateWatchers = new Map<string, FSWatcher>();
  private readonly runStateTimers = new Map<string, NodeJS.Timeout>();

  /**
   * Keeps a run-state watcher for exactly the sessions handed in.
   *
   * A watcher is cheap next to a poll -- it reads only when the file changes -- but it
   * is still one file descriptor per session, so the set is bounded to the live rows
   * and pruned as soon as a session leaves them.
   */
  private async syncRunStateWatchers(sessionIds: readonly string[]): Promise<void> {
    if (this.disposed) return;
    const wanted = new Set(sessionIds);
    for (const [sessionId, watcher] of this.runStateWatchers) {
      if (wanted.has(sessionId)) continue;
      watcher.close();
      this.runStateWatchers.delete(sessionId);
      const timer = this.runStateTimers.get(sessionId);
      if (timer) clearTimeout(timer);
      this.runStateTimers.delete(sessionId);
    }
    for (const sessionId of wanted) {
      if (this.runStateWatchers.has(sessionId)) continue;
      // An already-open transcript has its own watcher doing strictly more work, so a
      // second one here would read the same file twice for the same change.
      if (this.sharedSessionWatchers.has(sessionId)) continue;
      // The first scan may have had no transcript yet. Retry resolution on every
      // reconciliation so an unchanged discovery fingerprint does not strand a
      // live session without a watcher.
      const filePath = await this.locateSharedTranscriptFile(sessionId);
      if (!filePath) continue;
      try {
        const fileName = path.basename(filePath);
        const watcher = watch(
          path.dirname(filePath),
          { persistent: false },
          (_event, changedFile) => {
            if (changedFile && changedFile.toString() !== fileName) return;
            const previous = this.runStateTimers.get(sessionId);
            if (previous) clearTimeout(previous);
            this.runStateTimers.set(
              sessionId,
              setTimeout(() => {
                this.runStateTimers.delete(sessionId);
                void this.republishRunState(sessionId);
              }, 150),
            );
          },
        );
        watcher.on("error", () => {
          watcher.close();
          this.runStateWatchers.delete(sessionId);
        });
        this.runStateWatchers.set(sessionId, watcher);
      } catch {
        // Polling still covers the row when the filesystem cannot be watched.
      }
    }
  }

  /** Re-reads one session's run state and publishes the row if it moved. */
  private async republishRunState(sessionId: string): Promise<void> {
    if (this.disposed) return;
    if (this.activePromptSessions.has(sessionId)) return;
    const generation = this.generation;
    const revision = this.currentRunRevision(sessionId);
    // A session enters liveRunningSessions on gjcRunning:true and only leaves it on a
    // matching gjcRunning:false. A terminal-owned session never sends that close, and
    // a completion report is lost outright across a disconnect, so excluding the whole
    // set here stopped run-state reads for the rest of the process and pinned the row
    // to whatever it was left with.
    //
    // The transcript is still older than the live signal for the gap between a turn
    // starting and its first row reaching disk, so it only overrules that signal once
    // the file has grown past the size recorded when the work was reported -- the same
    // rule readSharedTranscript uses. Without a baseline the transcript wins, matching
    // rememberLiveRunningTranscriptSize's own fallback.
    if (this.liveRunningSessions.has(sessionId)) {
      const seenSize = this.liveRunningDigests.get(sessionId);
      if (seenSize !== undefined) {
        const filePath = await this.locateSharedTranscriptFile(sessionId);
        if (!filePath) return;
        try {
          if ((await stat(filePath)).size === seenSize) return;
        } catch {
          return;
        }
      }
    }
    const status = await this.discoveredRunState(sessionId);
    if (
      generation !== this.generation ||
      revision !== this.currentRunRevision(sessionId)
    )
      return;
    if (!status) return;
    if (status === "idle") {
      this.liveRunningSessions.delete(sessionId);
      this.liveRunningDigests.delete(sessionId);
      this.transcriptRunningSessions.delete(sessionId);
      this.workingPhaseSessions.delete(sessionId);
      this.runtimeIdleSessions.delete(sessionId);
    }
    const session = this.sessions.get(sessionId);
    if (!session || session.status === status) return;
    if (session.status === "failed" || session.status === "starting") return;
    this.advanceRunRevision(sessionId);
    session.status = status;
    this.lastDiscovered = this.lastDiscovered.map((row) =>
      row.id === sessionId
        ? { ...row, status, runRevision: session.runRevision }
        : row,
    );
    this.emitEvent({ type: "session.updated", session: { ...session } });
  }

  /**
   * Parent session ids, keyed by session id, with `null` for a transcript that was
   * read and named no source.
   *
   * A fork writes the link into the new session's envelope when it creates the
   * file and never revises it, so one read per session is enough -- and the negative
   * answer has to be cached too, or every discovery pass would re-read the head of
   * every root session in the list.
   */
  private readonly sessionParents = new Map<string, string | null>();

  /**
   * The session a row was forked from, read from its transcript envelope.
   *
   * The broker's session list carries identity and liveness only, so lineage comes
   * from the same session file the history scan already reads a bounded head of.
   * A session whose file is not on disk yet answers with the id it already carries,
   * which keeps a fork this window made from losing its link to a slow write.
   */
  private async sessionParentId(
    sessionId: string,
  ): Promise<string | undefined> {
    const cached = this.sessionParents.get(sessionId);
    if (cached !== undefined) return cached ?? undefined;
    try {
      const filePath = await this.locateSharedTranscriptFile(sessionId);
      if (!filePath) return this.sessions.get(sessionId)?.parentId;
      const id = parentSessionOf(
        (await transcriptHeadLines(filePath))[0],
        sessionId,
      );
      this.sessionParents.set(sessionId, id ?? null);
      return id;
    } catch {
      // An unreadable transcript is not evidence of a root: keep whatever the row
      // already reports rather than erasing a link we had.
      return this.sessions.get(sessionId)?.parentId;
    }
  }

  /**
   * Run state for a session discovery is listing, read from its transcript.
   *
   * Discovery covers every session the broker knows, so this must not turn a list
   * refresh into hundreds of full file reads. Only the tail of the file is parsed,
   * and the result is cached against the file's size so an unchanged transcript is
   * answered without touching the disk again.
   */
  private async discoveredRunState(
    sessionId: string,
  ): Promise<AgentSession["status"] | undefined> {
    try {
      const filePath = await this.locateSharedTranscriptFile(sessionId);
      if (!filePath) return undefined;
      const info = await stat(filePath);
      if (!info.isFile() || info.size > 64 * 1024 * 1024) return undefined;
      const cached = this.discoveredRunStates.get(sessionId);
      if (cached && cached.size === info.size) {
        if (!cached.runningJobIds || cached.runningJobIds.length === 0)
          return this.effectiveTranscriptRunState(sessionId, cached.status);
        // The transcript cannot move while its size is unchanged, so the only part
        // of this verdict that still can is the detached work it rested on: a job
        // paused or cancelled from outside writes no release row, and nothing else
        // in the read path asks the runtime about it again.
        const surviving = await this.reconciledAsyncJobIds(
          sessionId,
          cached.runningJobIds,
        );
        const status = surviving.length > 0 ? cached.status : ("idle" as const);
        this.discoveredRunStates.set(sessionId, {
          size: info.size,
          status,
          ...(surviving.length > 0 ? { runningJobIds: surviving } : {}),
        });
        if (surviving.length === 0)
          this.pendingAsyncWorkSessions.delete(sessionId);
        return this.effectiveTranscriptRunState(sessionId, status);
      }
      // Never parse whole transcripts here. Measured across 399 local sessions
      // (640MB), a full parse of each costs ~23s, which would stall every list
      // refresh. Run state only depends on how the newest rows end, so a bounded
      // tail is read instead.
      // Expanding is only needed for a running -> idle decision whose user boundary
      // fell outside the first window. Ordinary discovery stays at 256KB, preserving
      // the measured ~30ms all-session scan instead of regressing toward full parses.
      const envelopes = await readTranscriptTail(
        filePath,
        info.size,
        this.sessions.get(sessionId)?.status === "running" ||
          this.liveRunningSessions.has(sessionId),
      );
      if (!envelopes) return undefined;
      const turn = persistedTurnState(envelopes);
      let runningJobIds: string[] | undefined;
      let running = this.transcriptRunning(sessionId, turn);
      if (turn.pendingAsyncWorkOnly) {
        // The one verdict a transcript cannot settle alone. A detached task that is
        // paused, cancelled, or lost with its process writes no release row, so its
        // launch marker stays in the file long after the work ended. The runtime's
        // own job list decides -- and it is asked only when nothing else in the
        // transcript keeps the session running.
        runningJobIds = await this.reconciledAsyncJobIds(
          sessionId,
          turn.pendingAsyncJobIds,
        );
        running = runningJobIds.length > 0;
        if (!running) this.pendingAsyncWorkSessions.delete(sessionId);
      }
      const status = running ? ("running" as const) : ("idle" as const);
      if (status === "running") this.transcriptRunningSessions.add(sessionId);
      else this.transcriptRunningSessions.delete(sessionId);
      this.discoveredRunStates.set(sessionId, {
        size: info.size,
        status,
        ...(runningJobIds ? { runningJobIds } : {}),
      });
      return this.effectiveTranscriptRunState(sessionId, status);
    } catch {
      return undefined;
    }
  }

  private effectiveTranscriptRunState(
    sessionId: string,
    status: AgentSession["status"],
  ): AgentSession["status"] {
    if (
      status === "idle" &&
      ((this.workingPhaseSessions.has(sessionId) &&
        !this.runtimeIdleSessions.has(sessionId)) ||
        this.pendingAsyncWorkSessions.has(sessionId))
    )
      return "running";
    return status;
  }

  /**
   * A transcript's verdict, minus the launch markers a reconciliation has retired.
   *
   * A marker the reconciliation record does not name has not been put to the
   * runtime yet, and a marker awaiting that answer is still work in progress. The
   * transcript read path uses this rather than the raw verdict so a rebuild cannot
   * re-arm a latch from rows it has already retired.
   */
  private transcriptRunning(
    sessionId: string,
    turn: PersistedTurnState,
  ): boolean {
    if (!turn.pendingAsyncWorkOnly) return turn.running;
    return this.unreconciledAsyncJobIds(sessionId, turn.pendingAsyncJobIds)
      .length > 0;
  }

  /** The launch markers a reconciliation has not retired. */
  private unreconciledAsyncJobIds(
    sessionId: string,
    jobIds: readonly string[],
  ): string[] {
    const dead = this.asyncJobReconciliations.get(sessionId)?.deadJobIds;
    if (!dead || dead.size === 0) return [...jobIds];
    return jobIds.filter((jobId) => !dead.has(jobId));
  }

  /**
   * The launch markers among `jobIds` the runtime still reports as running.
   *
   * A marker the runtime no longer lists was finished, paused, cancelled, or taken
   * down with its process, and none of those are work in progress. A query that
   * cannot be answered is not evidence the work ended, so every marker survives it --
   * but the time of the attempt is remembered either way, so the run-state read path
   * never turns into a query loop over a runtime that cannot answer.
   */
  private async reconciledAsyncJobIds(
    sessionId: string,
    jobIds: readonly string[],
  ): Promise<string[]> {
    const pending = this.unreconciledAsyncJobIds(sessionId, jobIds);
    if (pending.length === 0) return pending;
    const record = this.asyncJobReconciliations.get(sessionId);
    const now = Date.now();
    if (record && now - record.checkedAt < PENDING_ASYNC_RECONCILE_INTERVAL_MS)
      return pending;
    const dead = record?.deadJobIds ?? new Set<string>();
    const live = await this.runningAsyncJobIds(sessionId);
    this.asyncJobReconciliations.set(sessionId, {
      checkedAt: now,
      deadJobIds: dead,
    });
    if (!live) return pending;
    for (const jobId of pending) if (!live.has(jobId)) dead.add(jobId);
    return pending.filter((jobId) => live.has(jobId));
  }

  /**
   * The jobs a session's runtime currently reports as running, or undefined when it
   * did not answer.
   *
   * `runtime.jobs.list` answers one wrapper row holding `running`, the entries the
   * runtime still considers alive, next to `recent` and `delivery` bookkeeping. Only
   * that list can retire a launch marker, and an empty answer is never fabricated:
   * it resolves every marker as dead, so a runtime that could not be reached must
   * not be reported as one that answered nothing.
   */
  private async runningAsyncJobIds(
    sessionId: string,
  ): Promise<Set<string> | undefined> {
    let rows: unknown[];
    try {
      rows = await this.querySessionItems(sessionId, "runtime.jobs.list", {}, {
        strict: true,
      });
    } catch {
      return undefined;
    }
    let answered = false;
    const running = new Set<string>();
    for (const row of rows) {
      if (!row || typeof row !== "object" || Array.isArray(row)) continue;
      const entries = (row as Record<string, unknown>).running;
      if (!Array.isArray(entries)) continue;
      answered = true;
      for (const entry of entries) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
        const job = entry as Record<string, unknown>;
        // An entry the runtime still carries with a status of its own -- paused, or
        // cancelled and not yet reaped -- is not work in progress. A missing status
        // is not evidence of an end either: the live list itself is the authority.
        if (typeof job.id !== "string") continue;
        if (job.status === undefined || job.status === "running")
          running.add(job.id);
      }
    }
    return answered ? running : undefined;
  }

  /**
   * The broker's session index, or undefined when it could not be read in full.
   *
   * Liveness classification comes only from this index. An empty result on failure
   * would read as "nothing is dead", which republishes every historical session as
   * a live row, so an incomplete scan is reported as unusable instead.
   *
   * Continuation cursors are drained inside the CLI client: the broker keeps only a
   * small pool of cursors for a limited window, and a walk that stops early strands
   * one for every other caller.
   */
  private async brokerSessions(options?: {
    scope?: "repo" | "cwd" | "worktree" | "all";
  }): Promise<SdkSessionRow[] | undefined> {
    try {
      const cli = await this.requireCli();
      return await cli.listSessions({
        scope: options?.scope ?? "all",
      });
    } catch {
      return undefined;
    }
  }

  async createSession(input: CreateSessionInput): Promise<AgentSession> {
    if (input.runtime !== "gjc")
      throw new Error("The GJC controller only creates GJC sessions");
    const cli = await this.requireCli();
    let sessionWorkspace = canonicalWorkspace(input.workspace);
    let worktree:
      | { sourceWorkspace: string; path: string; branch: string; managed: true }
      | undefined;
    if (input.isolation === "worktree") {
      const root = (
        await execFile("git", [
          "-C",
          sessionWorkspace,
          "rev-parse",
          "--show-toplevel",
        ])
      ).stdout.trim();
      if (!root) throw new Error("Workspace is not a git repository");
      const suffix = `${Date.now().toString(36)}-${this.nextLocalId++}`;
      const branch = input.worktreeBranch?.trim() || `gajae/${suffix}`;
      const worktreePath = path.join(
        path.dirname(root),
        `${path.basename(root)}.gajae-worktrees`,
        suffix,
      );
      await execFile("git", [
        "-C",
        root,
        "worktree",
        "add",
        "-b",
        branch,
        worktreePath,
      ]);
      sessionWorkspace = worktreePath;
      worktree = {
        sourceWorkspace: root,
        path: worktreePath,
        branch,
        managed: true,
      };
    }
    const knownSessionIds = new Set([
      ...this.sessions.keys(),
      ...(await this.brokerSessions())?.map((session) => session.sessionId) ??
        [],
    ]);
    let response: { sessionId: string } | undefined;
    const createRequestId = `gajae-session-create-${randomUUID()}`;
    try {
      const created = await cli.rawGlobal(
        "session.create",
        {
          cwd: sessionWorkspace,
          modelPreset: this.modelPreset,
        },
        { repo: sessionWorkspace, idempotencyKey: createRequestId },
      );
      const sessionId =
        typeof created?.sessionId === "string" ? created.sessionId : undefined;
      if (sessionId) response = { sessionId };
    } catch (error) {
      // A create whose receipt could not be verified may still have produced a live
      // session. Verified against gjc/0.15.6: `session.create` answers
      // `terminal_uncertain` while `list` shows the new session live with a pid, so
      // the index is what settles it. Adopting it is not optimism -- it is reading
      // the authoritative account instead of the unverifiable receipt.
      if (isLifecycleUncertain(error)) {
        for (let attempt = 0; attempt < 20 && !response; attempt += 1) {
          const retained = (await this.brokerSessions())?.find(
            (session) =>
              !knownSessionIds.has(session.sessionId) &&
              session.live &&
              !session.deleted &&
              (session.endpointGeneration ?? 0) > 0 &&
              session.repo !== undefined &&
              path.resolve(session.repo) === sessionWorkspace &&
              (session.lifecycleRequestId === undefined ||
                session.lifecycleRequestId === createRequestId),
          );
          if (retained) {
            this.sessionCwds.set(retained.sessionId, sessionWorkspace);
            this.transcripts.set(retained.sessionId, []);
            this.messageKeys.set(retained.sessionId, new Map());
            response = { sessionId: retained.sessionId };
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      }
      if (!response && worktree && !isLifecycleUncertain(error)) {
        try {
          const status = (
            await execFile("git", [
              "-C",
              worktree.path,
              "status",
              "--porcelain",
            ])
          ).stdout.trim();
          if (!status) {
            await execFile("git", [
              "-C",
              worktree.sourceWorkspace,
              "worktree",
              "remove",
              worktree.path,
            ]);
            await execFile("git", [
              "-C",
              worktree.sourceWorkspace,
              "branch",
              "-D",
              worktree.branch,
            ]);
          }
        } catch {
          /* Preserve a dirty or otherwise uncertain worktree for manual recovery. */
        }
      }
      if (!response && isLifecycleUncertain(error)) {
        throw new Error(
          "GJC가 세션을 생성했지만 lifecycle 영수증을 검증하지 못했습니다. 보존된 세션 자동 복구에도 실패했습니다. GJC lifecycle ledger reconciliation이 필요합니다.",
        );
      }
      if (!response) throw error;
    }
    if (!response) throw new Error("GJC did not report a new session id");
    const createdSessionId = response.sessionId;
    const session: AgentSession = {
      id: createdSessionId,
      title: input.title?.trim() || "New Gajae session",
      subtitle: path.basename(sessionWorkspace) || sessionWorkspace,
      workspace: sessionWorkspace,
      runtime: "gjc",
      status: "idle",
      updatedAt: "now",
      updatedAtMs: Date.now(),
      pinned: false,
      unread: false,
      accent: GJC_ACCENT,
      ownership: "gajae",
      attachment: "recovering",
      ...(worktree ? { worktree } : {}),
    };
    this.sessions.set(session.id, session);
    this.sessionCwds.set(session.id, sessionWorkspace);
    this.transcripts.set(session.id, []);
    this.messageKeys.set(session.id, new Map());
    this.sessionMetadata?.setAlias(session.id, session.title);
    this.sessionMetadata?.setWorkspace(session.id, sessionWorkspace);
    this.sessionMetadata?.setOwnership(session.id, "gajae");
    if (worktree) this.sessionMetadata?.setWorktree(session.id, worktree);
    try {
      await this.applyPermissionMode(session.id);
    } catch (error) {
      // A session whose safety mode was not confirmed must remain readable but is
      // never advertised as sendable. Preserve its worktree and metadata so the
      // user can retry resume after fixing the broker/runtime failure.
      session.status = "failed";
      session.attachment = "recovering";
      this.emitEvent({ type: "session.created", session: { ...session } });
      throw error;
    }
    session.attachment = "attached";
    this.attachedSessions.add(session.id);
    this.startTailFollower(session.id);
    void this.refreshSdkCommands(session.id);
    await this.refreshModelProfiles(session.id);
    await this.refreshSessionConfigOptions(session.id);
    void this.refreshContextUsage(session.id);
    // The new session's file is the live account for everything it does next.
    const createdFile = await this.locateSharedTranscriptFile(session.id);
    if (createdFile) this.watchSharedTranscript(session.id, createdFile);
    this.emitEvent({ type: "session.created", session: { ...session } });
    return { ...session };
  }

  /** Renames through the live SDK, then mirrors the title into app metadata. */
  async renameSession(sessionId: string, title: string): Promise<void> {
    const value = title.trim();
    if (!value) throw new Error("Session title cannot be empty");
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown GJC session: ${sessionId}`);
    const operations = await this.sdkOperations(sessionId);
    if (operations.has("session.rename"))
      await this.controlSession(sessionId, "session.rename", { name: value });
    this.sessionMetadata?.setAlias(sessionId, value);
    session.title = value;
    markUpdated(session);
    this.emitEvent({ type: "session.updated", session: { ...session } });
  }

  async getTranscript(sessionId: string): Promise<TranscriptItem[]> {
    // Opening a session attaches it, which is what reports its real preset, thinking
    // level, and mode. Waiting for the first prompt to attach is what left a restarted
    // app showing the app-wide default preset instead of the session's own.
    if (
      this.sessions.get(sessionId)?.attachment === "attachable" &&
      !this.terminalOnlySessions.has(sessionId) &&
      !this.attachedSessions.has(sessionId)
    ) {
      const lastAttempt = this.attachAttempts.get(sessionId) ?? 0;
      if (Date.now() - lastAttempt > ATTACH_RETRY_INTERVAL_MS) {
        this.attachAttempts.set(sessionId, Date.now());
        // A refused attachment is not authority to call the session terminal-only: the
        // lease can be held for one turn and released, and the later transcript load
        // still owns that decision.
        try {
          await this.ensureAttached(sessionId, false);
          await this.refreshSessionSettings(sessionId);
        } catch {
          /* still owned elsewhere */
        }
      }
    }
    // The controller survives renderer reloads, while command discovery is a
    // session event. Re-opening the transcript is the renderer's bootstrap, so
    // replay the cached snapshot and then rebuild it from the runtime, which is the
    // only source that still knows the session's commands when GJC has no reason to
    // publish its bootstrap updates again.
    const commands = this.sessionCommands.get(sessionId);
    if (commands)
      this.emitEvent({
        type: "session.commands",
        sessionId,
        commands: commands.map((command) => ({ ...command })),
      });
    void this.refreshSdkCommands(sessionId);
    // Nothing pushes todo changes either, so the same bootstrap pass reads the
    // store. It runs whether or not a goal is enabled: a todo list is its own
    // runtime state, and gating it on goal mode is what hid it.
    void this.readTodoRecords(sessionId);
    const externallyDriven = !this.activePromptSessions.has(sessionId);
    if (this.terminalOnlySessions.has(sessionId) || externallyDriven) {
      try {
        const shared = await this.readSharedTranscript(sessionId);
        if (shared.length > 0) {
          const installed = this.installTranscript(sessionId, shared);
          return installed.map(cloneTranscriptItem);
        }
        if (this.terminalOnlySessions.has(sessionId))
          return [this.terminalOnlyNotice(sessionId)];
      } catch {
        if (this.terminalOnlySessions.has(sessionId))
          return [this.terminalOnlyNotice(sessionId)];
      }
    }
    try {
      await this.ensureAttached(sessionId, true);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        /no current Router attachment|provider_lease_conflict/iu.test(message)
      ) {
        this.terminalOnlySessions.add(sessionId);
        const session = this.sessions.get(sessionId);
        if (session) {
          session.attachment = "terminal-only";
          session.ownership = "external";
          this.emitEvent({ type: "session.updated", session: { ...session } });
        }
        return [this.terminalOnlyNotice(sessionId)];
      }
      if (lifecycleUncertainError(error)) {
        const session = this.sessions.get(sessionId);
        if (session) {
          session.attachment = "recovering";
          session.status = "failed";
          this.emitEvent({ type: "session.updated", session: { ...session } });
        }
        return [this.lifecycleUncertainNotice(sessionId)];
      }
      if (!missingSessionError(error)) throw error;
      this.removeLocalSession(sessionId, true);
      return [];
    }
    await this.refreshModelProfiles(sessionId);
    return (this.transcripts.get(sessionId) ?? []).map(cloneTranscriptItem);
  }

  private async readSharedTranscript(
    sessionId: string,
  ): Promise<TranscriptItem[]> {
    const persisted = await this.readPersistedTranscript(sessionId);
    if (persisted) return persisted;
    // No session file yet: ask the session for its retained transcript instead. The
    // file is the durable account and wins whenever it exists.
    const rows = await this.querySessionItems(
      sessionId,
      "transcript.list",
      {},
      { strict: true },
    );
    return sharedTranscriptItems(sessionId, rows);
  }

  /**
   * Parsed envelopes for an append-only transcript, reusing the previous parse
   * and reading only the appended tail. Re-parsing the whole file on every write
   * cost ~24ms per sync on a 14MB transcript, which several subagents writing at
   * once turned into visible lag.
   */
  private async readTranscriptEnvelopes(
    filePath: string,
    info: Stats,
  ): Promise<Record<string, unknown>[]> {
    const parseInto = (
      target: Record<string, unknown>[],
      chunk: string,
      carry: string,
    ): string => {
      const text = carry + chunk;
      const lines = text.split("\n");
      // A write can land mid-line, so the trailing fragment is held back until
      // the newline that completes it arrives.
      const tail = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          target.push(JSON.parse(line) as Record<string, unknown>);
        } catch {
          // A torn or malformed line is skipped, matching the full-file parse.
        }
      }
      return tail;
    };

    const device = Number(info.dev);
    const inode = Number(info.ino);
    const previous = this.sharedTranscriptReads.get(filePath);
    const reusable =
      previous !== undefined &&
      previous.device === device &&
      previous.inode === inode &&
      // Shrinking means the file was rewritten (compaction), so nothing carries over.
      info.size >= previous.size;

    if (reusable && info.size === previous.size) {
      // An unchanged file is still a read, and the eviction order is what decides
      // which transcript survives. Returning early without touching it made the
      // most frequently polled session look like the stalest one.
      this.rememberTranscriptRead(filePath, previous);
      return previous.envelopes.slice();
    }

    if (reusable) {
      const handle = await open(filePath, "r");
      try {
        const length = info.size - previous.size;
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, previous.size);
        const envelopes = previous.envelopes.slice();
        const partial = parseInto(
          envelopes,
          buffer.toString("utf8"),
          previous.partial,
        );
        this.rememberTranscriptRead(filePath, {
          device,
          inode,
          size: info.size,
          envelopes,
          partial,
        });
        return envelopes.slice();
      } finally {
        await handle.close();
      }
    }

    const envelopes: Record<string, unknown>[] = [];
    const partial = parseInto(envelopes, await readFile(filePath, "utf8"), "");
    this.rememberTranscriptRead(filePath, {
      device,
      inode,
      size: info.size,
      envelopes,
      partial,
    });
    return envelopes.slice();
  }

  /** Caches a parsed transcript, evicting the least recently read one past the limit. */
  private rememberTranscriptRead(
    filePath: string,
    entry: {
      device: number;
      inode: number;
      size: number;
      envelopes: Record<string, unknown>[];
      partial: string;
    },
  ): void {
    // Re-inserting moves the key to the end, so the first key is always the one
    // read longest ago.
    this.sharedTranscriptReads.delete(filePath);
    this.sharedTranscriptReads.set(filePath, entry);
    while (
      this.sharedTranscriptReads.size >
      GjcSdkController.SHARED_TRANSCRIPT_CACHE_LIMIT
    ) {
      const oldest = this.sharedTranscriptReads.keys().next();
      if (oldest.done) break;
      this.sharedTranscriptReads.delete(oldest.value);
    }
  }

  private async readPersistedTranscript(
    sessionId: string,
  ): Promise<TranscriptItem[] | undefined> {
    const generation = this.generation;
    const revision = this.currentRunRevision(sessionId);
    const filePath = await this.locateSharedTranscriptFile(sessionId);
    if (!filePath) return undefined;
    this.watchSharedTranscript(sessionId, filePath);
    try {
      const info = await stat(filePath);
      if (!info.isFile() || info.size > 64 * 1024 * 1024) return undefined;
      const envelopes = await this.readTranscriptEnvelopes(filePath, info);
      const rows = envelopes.flatMap((envelope) => {
        if (
          envelope.type === "compaction" ||
          envelope.type === "branch_summary" ||
          envelope.type === "custom_message"
        ) {
          return [
            {
              ...envelope,
              ts:
                typeof envelope.timestamp === "string"
                  ? envelope.timestamp
                  : envelope.ts,
            },
          ];
        }
        if (
          envelope.type !== "message" ||
          !envelope.message ||
          typeof envelope.message !== "object" ||
          Array.isArray(envelope.message)
        )
          return [];
        const message = envelope.message as Record<string, unknown>;
        return [
          {
            ...message,
            id: typeof envelope.id === "string" ? envelope.id : message.id,
            ts:
              typeof envelope.timestamp === "string"
                ? envelope.timestamp
                : message.timestamp,
          },
        ];
      });
      const compactionTimestamps = envelopes
        .filter((envelope) => envelope.type === "compaction")
        .map((envelope) =>
          typeof envelope.timestamp === "string"
            ? Date.parse(envelope.timestamp)
            : typeof envelope.ts === "string"
              ? Date.parse(envelope.ts)
              : NaN,
        )
        .filter((timestamp) => Number.isFinite(timestamp));
      const latestCompactionTimestamp =
        compactionTimestamps.length > 0
          ? Math.max(...compactionTimestamps)
          : undefined;
      if (
        latestCompactionTimestamp !== undefined &&
        generation === this.generation &&
        this.sessions.has(sessionId)
      ) {
        // This is a monotonic fact from the durable transcript, not a verdict about
        // the active run revision. Record it before any await so an older live phase
        // arriving from live events cannot overtake the file completion receipt.
        const previous = this.compactionRecordWatermark.get(sessionId);
        if (
          previous === undefined ||
          latestCompactionTimestamp > previous
        )
          this.compactionRecordWatermark.set(
            sessionId,
            latestCompactionTimestamp,
          );
      }
      const persistedTurn = persistedTurnState(envelopes);
      // A new compaction record is the durable completion receipt for the requested
      // cycle. It outranks a live `compacting` phase because that phase can remain
      // stuck in the in-memory marker when no separate idle update is delivered.
      // Only clear those live markers when the persisted turn is terminal; a real
      // concurrent prompt remains authoritative while its transcript is running.
      const baseline = this.compactionRecordBaseline.get(sessionId);
      const compactionCompleted =
        this.compactingSessions.has(sessionId) &&
        baseline !== undefined &&
        compactionRecordCount(envelopes) > baseline &&
        (this.compactionStartedAt.get(sessionId) === undefined ||
          (latestCompactionTimestamp !== undefined &&
            latestCompactionTimestamp >
              this.compactionStartedAt.get(sessionId)!)) &&
        !persistedTurn.running;

      // The launch markers a reconciliation already retired are not work again just
      // because this read met the same rows: a job that was paused or cancelled
      // leaves its marker in the file for good.
      const transcriptRunning = this.transcriptRunning(sessionId, persistedTurn);
      const turnRunning =
        transcriptRunning ||
        this.activePromptSessions.has(sessionId) ||
        (this.workingPhaseSessions.has(sessionId) &&
          !this.runtimeIdleSessions.has(sessionId) &&
          !compactionCompleted);
      // A transcript that has not changed since the live signal reported work is the
      // same snapshot that signal already superseded, so it carries no news. Once the
      // file grows and still reports no active turn, it has observed the work end and
      // becomes the newer account. A terminal-owned session never sends
      // gjcRunning:false, so this is sufficient evidence for that kind of session. A
      // cycle that did emit a working phase also needs runtime idle before it settles.
      const seenSize = this.liveRunningDigests.get(sessionId);
      const transcriptAdvanced =
        seenSize !== undefined && info.size !== seenSize;
      const items = sharedTranscriptItems(sessionId, rows, { turnRunning });
      await this.resolveToolImages(items);
      const lifecycleCurrent =
        generation === this.generation &&
        revision === this.currentRunRevision(sessionId);
      if (lifecycleCurrent) {
        if (compactionCompleted) {
          this.compactingSessions.delete(sessionId);
          this.compactionRecordBaseline.delete(sessionId);
          this.compactionStartedAt.delete(sessionId);
          this.liveRunningSessions.delete(sessionId);
          this.liveRunningDigests.delete(sessionId);
          this.transcriptRunningSessions.delete(sessionId);
          this.discoveredRunStates.delete(sessionId);
          this.workingPhaseSessions.delete(sessionId);
          this.runtimeIdleSessions.delete(sessionId);
          this.patchSessionRuntime(sessionId, { phase: undefined });
        }
        if (
          this.unreconciledAsyncJobIds(sessionId, persistedTurn.pendingAsyncJobIds)
            .length > 0
        )
          this.pendingAsyncWorkSessions.add(sessionId);
        else this.pendingAsyncWorkSessions.delete(sessionId);
      }
      const effectiveModel = persistedModelState(envelopes);
      if (
        effectiveModel.model ||
        effectiveModel.thinking ||
        Object.hasOwn(effectiveModel, "serviceTier")
      ) {
        this.patchSessionRuntime(sessionId, effectiveModel);
      }
      // A terminal-owned session gets no live phase report, so the transcript is the
      // only place its finished compaction is recorded.
      // `compactionCompleted` was handled before computing turnRunning so the
      // completion receipt can settle status in this same transcript read.
      if (lifecycleCurrent && !this.activePromptSessions.has(sessionId)) {
        const status = turnRunning ? "running" : "idle";
        const current = this.sessions.get(sessionId)?.status;
        if (status === "idle") {
          // The transcript is written after the fact, so it reads idle for the gap
          // between a turn starting and its first row reaching disk. That snapshot is
          // older than the live signal and must not overrule it.
          //
          // A transcript that records the turn's own stop reason is different: it is
          // evidence the turn ended, not evidence it never started. A terminal-owned
          // session never receives gjcRunning:false, so refusing this too left the row
          // running for the rest of the session.
          // The terminal row predates a newly accepted compaction. Only a new
          // compaction record or a live non-compacting phase can release it.
          if (
            (!this.compactingSessions.has(sessionId) || compactionCompleted) &&
            (transcriptAdvanced || !this.liveRunningSessions.has(sessionId))
          ) {
            this.liveRunningSessions.delete(sessionId);
            this.liveRunningDigests.delete(sessionId);
            this.transcriptRunningSessions.delete(sessionId);
            this.discoveredRunStates.delete(sessionId);
            // The transcript has observed the work end, which outranks the last phase
            // GJC reported: leaving the marker set would keep rejecting every later
            // idle report and strand the row at 진행 중.
            this.workingPhaseSessions.delete(sessionId);
            this.runtimeIdleSessions.delete(sessionId);
            this.updateSessionStatus(sessionId, "idle");
          }
        } else if (
          current !== "idle" &&
          !this.locallyAbortedSessions.has(sessionId)
        ) {
          this.updateSessionStatus(sessionId, status);
        }
      }
      // A session owned by a terminal never attaches here, so its own transcript is the
      // only place that states which model it is actually running.
      const model = lastReportedModel(rows);
      if (model && this.sessions.get(sessionId)?.modelDisplay !== model) {
        this.patchSessionRuntime(sessionId, {
          modelDisplay: readableModelLabel(model),
        });
      }
      return items;
    } catch {
      this.sharedSessionFiles.delete(sessionId);
      return undefined;
    }
  }

  private watchSharedTranscript(sessionId: string, filePath: string): void {
    if (this.sharedSessionWatchers.has(sessionId) || this.disposed) return;
    try {
      const fileName = path.basename(filePath);
      const watcher = watch(
        path.dirname(filePath),
        { persistent: false },
        (_event, changedFile) => {
          if (changedFile && changedFile.toString() !== fileName) return;
          const previous = this.sharedSessionRefreshTimers.get(sessionId);
          if (previous) clearTimeout(previous);
          this.sharedSessionRefreshTimers.set(
            sessionId,
            setTimeout(() => {
              this.sharedSessionRefreshTimers.delete(sessionId);
              if (this.disposed) return;
              const previousItems = this.transcripts.get(sessionId);
              void this.readPersistedTranscript(sessionId).then((items) => {
                if (!items || this.disposed) return;
                const installed = this.installTranscript(sessionId, items);
                this.publishTranscriptSync(sessionId, previousItems, installed);
                // External terminal sessions do not publish usage events to this
                // renderer. Re-query after transcript changes so the first response
                // following compaction replaces the pending usage indicator immediately.
                void this.refreshContextUsage(sessionId);
              });
            }, 25),
          );
        },
      );
      watcher.on("error", () => {
        watcher.close();
        this.sharedSessionWatchers.delete(sessionId);
      });
      this.sharedSessionWatchers.set(sessionId, watcher);
    } catch {
      // Initial transcript loading still works when the filesystem cannot be watched.
    }
  }

  /**
   * Publish a transcript rescan as the items that actually changed.
   *
   * A rescan usually adds one row to an unchanged history, so shipping the whole
   * array cost a full clone plus a multi-megabyte IPC hop each time, and handed
   * the renderer fresh objects for every row -- which defeats the memo on each
   * transcript item and re-renders the entire list. Appends go out as individual
   * items; a rewritten history (compaction) still needs the full array.
   */
  private publishTranscriptSync(
    sessionId: string,
    previous: TranscriptItem[] | undefined,
    items: TranscriptItem[],
  ): void {
    const syncWholeHistory = (): void => {
      this.emitEvent({
        type: "transcript.synced",
        sessionId,
        items: items.map(cloneTranscriptItem),
      });
    };

    // No prior history, or a shorter one because compaction rewrote it.
    if (!previous || previous.length > items.length) {
      syncWholeHistory();
      return;
    }

    // Rows already published can still change -- a tool call gains its result, a
    // streamed message settles -- but only recent ones do, so the scan walks back
    // from the end and stops at the first row that still matches. Comparing the
    // whole shared prefix instead cost ~9ms per rescan on a 2500-row transcript,
    // because a rebuilt row is never reference-equal to the one it replaces.
    let changedFrom = previous.length;
    let steps = 0;
    while (changedFrom > 0 && steps < TRANSCRIPT_RESCAN_WINDOW) {
      const index = changedFrom - 1;
      const before = previous[index];
      const after = items[index];
      if (before && after && sameTranscriptItem(before, after)) break;
      changedFrom = index;
      steps += 1;
    }

    // The shared rows disagree further back than a settling turn explains, so the
    // history is republished rather than reconciled row by row.
    if (steps >= TRANSCRIPT_RESCAN_WINDOW) {
      syncWholeHistory();
      return;
    }

    const changed = items.slice(changedFrom);
    if (changed.length === 0) return;
    // Replacing many rows is cheaper as one array than as a burst of events.
    if (changed.length > 16) {
      syncWholeHistory();
      return;
    }
    for (const item of changed) {
      this.emitEvent({
        type: "transcript.appended",
        item: cloneTranscriptItem(item),
      });
    }
  }

  /** Inline the GJC blob store bytes so a read image renders in the transcript. */
  private async resolveToolImages(items: TranscriptItem[]): Promise<void> {
    const blobDirectory = path.join(
      path.resolve(
        process.env.GJC_CODING_AGENT_DIR ?? path.join(homedir(), ".gjc/agent"),
      ),
      "blobs",
    );
    await Promise.all(
      items.map(async (item) => {
        if (item.kind !== "tool" || !item.images) return;
        item.images = (
          await Promise.all(
            item.images.map(async (image) => {
              if (image.dataUrl || !image.blobId) return image;
              const cached = this.imageDataUrls.get(image.blobId);
              if (cached) return { mimeType: image.mimeType, dataUrl: cached };
              try {
                const file = path.join(blobDirectory, image.blobId);
                const info = await stat(file);
                if (!info.isFile() || info.size > 12 * 1024 * 1024)
                  return undefined;
                const dataUrl = `data:${image.mimeType};base64,${(await readFile(file)).toString("base64")}`;
                if (this.imageDataUrls.size > 64) this.imageDataUrls.clear();
                this.imageDataUrls.set(image.blobId, dataUrl);
                return { mimeType: image.mimeType, dataUrl };
              } catch {
                return undefined;
              }
            }),
          )
        ).filter(
          (image): image is NonNullable<typeof image> => image !== undefined,
        );
        if (item.images.length === 0) delete item.images;
      }),
    );
  }

  private terminalOnlyNotice(sessionId: string): NoticeActivity {
    return {
      id: `terminal-only-${sessionId}`,
      kind: "notice",
      sessionId,
      title: "Terminal session is active",
      content:
        "This direct terminal session is visible here but does not expose an attachable SDK endpoint. Continue it in the terminal.",
      tone: "neutral",
      createdAt: nowLabel(),
    };
  }

  private lifecycleUncertainNotice(sessionId: string): NoticeActivity {
    return {
      id: `lifecycle-uncertain-${sessionId}`,
      kind: "notice",
      sessionId,
      title: "저장된 세션을 검증할 수 없습니다",
      content:
        "네트워크 연결 문제가 아니라 GJC의 로컬 lifecycle 기록이 저장 결과와 일치하지 않는 상태입니다. GJC를 재시작한 뒤 다시 열어 보세요. 계속 발생하면 이 세션은 GJC reconciliation이 필요합니다.",
      tone: "warning",
      createdAt: nowLabel(),
    };
  }

  async setSessionConfig(
    sessionId: string,
    configId: string,
    value: string,
  ): Promise<void> {
    if (configId === "thinking") {
      this.explicitSessionThinking.set(sessionId, value);
      this.patchSessionRuntime(sessionId, { thinking: value });
      const existing = this.sessionConfig.get(sessionId);
      if (existing) {
        const updated = existing.map((option) =>
          option.category === "thought_level" || option.id === "thinking"
            ? { ...option, currentValue: value }
            : option,
        );
        this.sessionConfig.set(sessionId, updated);
        this.emitEvent({ type: "session.config", sessionId, options: updated });
      }
      await this.controlSession(sessionId, "thinking.set", { level: value });
      return;
    }
    if (configId === "model") {
      this.explicitSessionThinking.delete(sessionId);
      const existing = this.sessionConfig.get(sessionId);
      const selected = existing?.find(
        (option) => option.category === "model" || option.id === "model",
      );
      const display =
        selected?.options?.find((option) => option.value === value)?.name ??
        value;
      this.patchSessionRuntime(sessionId, {
        model: value,
        modelDisplay: display,
      });
      if (existing) {
        const updated = existing.map((option) =>
          option.category === "model" || option.id === "model"
            ? { ...option, currentValue: value }
            : option,
        );
        this.sessionConfig.set(sessionId, updated);
        this.emitEvent({ type: "session.config", sessionId, options: updated });
      }
      await this.controlSession(sessionId, "model.profile.set", { id: value });
      await this.refreshSessionSettings(sessionId);
      await this.refreshModelProfiles(sessionId);
      return;
    }
    // Any other selector is a session config value; `config.patch` is the control
    // operation that sets one, and the session's own config is re-read after.
    await this.ensureAttached(sessionId, false);
    await this.controlSession(sessionId, "config.patch", {
      patch: { [configId]: value },
    });
    await this.refreshSessionConfigOptions(sessionId);
  }

  async cycleThinking(sessionId: string): Promise<string | undefined> {
    const result = await this.controlSession(sessionId, "thinking.cycle", {});
    const level =
      result && typeof result.level === "string" ? result.level : undefined;
    if (!level) return undefined;
    this.explicitSessionThinking.set(sessionId, level);
    this.patchSessionRuntime(sessionId, { thinking: level });
    const existing = this.sessionConfig.get(sessionId);
    if (existing) {
      const updated = existing.map((option) =>
        option.category === "thought_level" || option.id === "thinking"
          ? { ...option, currentValue: level }
          : option,
      );
      this.sessionConfig.set(sessionId, updated);
      this.emitEvent({ type: "session.config", sessionId, options: updated });
    }
    return level;
  }

  // A session proven uncontrollable is recorded so the row stops advertising a
  // control surface it does not have, instead of failing again on the next action.
  private markTerminalOnly(sessionId: string): void {
    this.terminalOnlySessions.add(sessionId);
    this.attachedSessions.delete(sessionId);
    this.stopTailFollower(sessionId);
    // The reuse fingerprint only covers broker liveness, which this discovery does
    // not change. Without invalidating it the next scan replays the snapshot taken
    // before the failure and the row goes back to advertising controls.
    this.lastLiveFingerprint = undefined;
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.attachment = "terminal-only";
    session.ownership = "external";
    this.lastDiscovered = this.lastDiscovered.map((row) =>
      row.id === sessionId ? { ...session } : row,
    );
    this.emitEvent({ type: "session.updated", session: { ...session } });
  }

  /**
   * Notes the transcript size at the moment live work was reported. A read failure
   * leaves no baseline, which makes the next transcript snapshot authoritative --
   * the safe direction, since the alternative is a row stuck on running.
   */
  private async rememberLiveRunningTranscriptSize(
    sessionId: string,
  ): Promise<void> {
    try {
      const filePath = await this.locateSharedTranscriptFile(sessionId);
      if (!filePath) return;
      const info = await stat(filePath);
      if (this.liveRunningSessions.has(sessionId))
        this.liveRunningDigests.set(sessionId, info.size);
    } catch {
      // No baseline recorded: the transcript wins next time.
    }
  }

  /** Counts compactions already recorded on disk, or reports an unavailable baseline. */
  private async persistedCompactionCount(
    sessionId: string,
  ): Promise<number | undefined> {
    try {
      const filePath = await this.locateSharedTranscriptFile(sessionId);
      if (!filePath) return undefined;
      const info = await stat(filePath);
      return compactionRecordCount(
        await this.readTranscriptEnvelopes(filePath, info),
      );
    } catch {
      // Zero means the transcript was read and contained no compactions. Treating
      // an I/O failure as zero lets any historical record falsely finish new work.
      return undefined;
    }
  }

  async compactSession(sessionId: string): Promise<void> {
    // Compaction is a session control operation. Terminal-owned sessions route
    // through the broker instead of requiring a second runtime attachment.
    const statusBefore = this.sessions.get(sessionId)?.status;
    const baseline = await this.persistedCompactionCount(sessionId);
    this.compactingSessions.add(sessionId);
    this.compactionStartedAt.delete(sessionId);
    if (baseline === undefined)
      this.compactionRecordBaseline.delete(sessionId);
    else this.compactionRecordBaseline.set(sessionId, baseline);
    this.patchSessionRuntime(sessionId, {
      phase: "compacting",
      status: "running",
    });
    try {
      await this.controlSession(sessionId, "compaction.run", {});
      // GJC intentionally reports null usage after compaction until a later model
      // response provides a trustworthy provider anchor. Never leave the stale
      // pre-compaction percentage visible while that new value is pending.
      this.patchSessionRuntime(sessionId, {
        usagePercent: undefined,
        usagePending: true,
      });
      await this.refreshContextUsage(sessionId);
    } catch (error) {
      // Compaction marked the row running. Leaving it there after a failure keeps
      // the composer queueing behind a turn that never started, so the status it
      // replaced is restored -- and only that one, or a real turn running
      // underneath would be reported idle.
      this.compactingSessions.delete(sessionId);
      this.compactionRecordBaseline.delete(sessionId);
      this.compactionStartedAt.delete(sessionId);
      this.patchSessionRuntime(sessionId, {
        phase: undefined,
        ...(statusBefore && statusBefore !== "running"
          ? { status: statusBefore }
          : {}),
      });
      throw error;
    }
    // The control call returning means GJC accepted the request, not that the
    // history has been rewritten. Clearing the phase here reported compaction
    // finished while it was still running, so the phase is left standing until
    // GJC reports a non-compacting phase through patchSessionInfo.
  }

  private appendLocalUserMessage(
    sessionId: string,
    text: string,
    input: ResolvedMessageInput,
  ): void {
    const echoes = this.echoedPromptTexts.get(sessionId) ?? [];
    echoes.push(normalizeQueuedRequestText(text));
    this.echoedPromptTexts.set(sessionId, echoes);
    const message: ChatMessage = {
      id: `local-prompt-${this.nextLocalId++}`,
      kind: "message",
      sessionId,
      role: "user",
      content: sanitizeLocalAttachmentBlocks(text),
      ...(input.images?.length
        ? {
            images: input.images.map(
              ({ nativePath: _nativePath, ...image }) => image,
            ),
          }
        : {}),
      createdAt: nowLabel(),
      streaming: false,
    };
    this.appendTranscript(message);
  }

  // Returns true when this user update is GJC repeating a prompt already shown.
  private consumePromptEcho(sessionId: string, text: string): boolean {
    const echoes = this.echoedPromptTexts.get(sessionId);
    if (!echoes?.length) return false;
    const normalized = normalizeQueuedRequestText(text);
    const index = echoes.indexOf(normalized);
    if (index < 0) return false;
    echoes.splice(index, 1);
    if (echoes.length === 0) this.echoedPromptTexts.delete(sessionId);
    return true;
  }

  // Waiting work is hidden from the transcript only while it is still waiting.
  // The count is what makes this correct: two identical queued requests must
  // survive one being consumed, and the last release must un-hide the bubble so a
  // consumed steer reads like any other user message.

  // The authoritative queue is the only thing that says what is still waiting.
  // Anything the app once hid but GJC no longer lists has been consumed, so its
  // suppression is dropped and the message becomes a visible user bubble.



  async steerSession(
    sessionId: string,
    input: ResolvedMessageInput,
    options?: { echo?: boolean },
  ): Promise<void> {
    const text = messageTextWithFiles(input)
      .replace(/^\/steer(?:\s+|$)/u, "")
      .trim();
    if (!text) throw new Error("Steering instructions are required");
    // A steer is a user message too. Echoing it before the round trip is what
    // makes it appear immediately; without this the bubble waits for GJC to
    // stream its own user_message_chunk back, which is seconds late on a busy
    // turn and reads as the window having swallowed the message. Callers that
    // already echoed the same text pass echo: false so it is not shown twice.
    if (options?.echo !== false) this.appendLocalUserMessage(sessionId, text, input);
    const pending = this.controlSession(sessionId, "turn.steer", {
      text,
      clientRef: `gajae-steer-${randomUUID()}`,
    }).then(() => undefined);
    const previous = this.pendingSteers.get(sessionId);
    const chained = previous
      ? previous.then(
          () => pending,
          () => pending,
        )
      : pending;
    this.pendingSteers.set(sessionId, chained);
    try {
      await pending;
    } finally {
      if (this.pendingSteers.get(sessionId) === chained)
        this.pendingSteers.delete(sessionId);
    }
  }

  async queueFollowUp(sessionId: string, input: ResolvedMessageInput): Promise<void> {
    const text = messageTextWithFiles(input);
    if (!text) throw new Error("Follow-up text is required");
    try {
      await this.ensureAttached(sessionId, false);
    } catch {
      /* terminal owns the attachment */
    }
    await this.controlSession(sessionId, "turn.follow_up", { text });
  }

  /**
   * One control operation over `gjc sdk session raw control`.
   *
   * There used to be a private in-process extension path with this CLI as fallback,
   * and the two could disagree about whether an operation was accepted. The CLI is
   * now the only path, so there is one answer per operation and no fallback to
   * reconcile.
   */
  private async controlSession(
    sessionId: string,
    operation:
      | "turn.prompt"
      | "turn.steer"
      | "turn.follow_up"
      | "turn.abort"
      | "queue.message.remove"
      | "compaction.run"
      | "mode.goal.operate"
      | "mode.plan.set"
      | "thinking.set"
      | "thinking.cycle"
      | "model.profile.set"
      | "permission_mode.set"
      | "config.patch"
      | "service_tier.set"
      | "session.export_html"
      | "context.clear"
      | "session.rename"
      | "session.cwd.move"
      | "retry.last"
      | "bash.background"
      | "runtime.reload"
      | "auth.login",
    input: Record<string, unknown>,
    options?: { confirm?: boolean; idempotencyKey?: string },
  ): Promise<Record<string, unknown> | undefined> {
    const cli = await this.requireCli();
    // A terminal abort is the only operation that needs a key of its own, and the
    // key must be stable across a retry of the same user action.
    const idempotencyKey =
      options?.idempotencyKey ??
      (operation === "turn.abort" && input.mode === "terminal"
        ? `gajae-abort-${randomUUID()}`
        : undefined);
    try {
      return await cli.rawControl(sessionId, operation, input, {
        repo: this.repoFor(sessionId),
        ...(idempotencyKey ? { idempotencyKey } : {}),
        // An operator terminal abort is destructive and the host requires the flag.
        confirm: options?.confirm === true || input.operator === true,
      });
    } catch (error) {
      if (busyPromptError(error)) throw error;
      // A session with no SDK endpoint is reported once, in terms the user can act
      // on, instead of each caller surfacing the broker's routing language.
      if (isSessionUnreachable(error)) {
        if (operation === "turn.abort" && input.operator === true) {
          try {
            await cli.queryItems(sessionId, "session.metadata", {}, { repo: this.repoFor(sessionId) });
          } catch {
            this.markTerminalOnly(sessionId);
            throw new Error(SHARED_ROUTE_UNAVAILABLE_MESSAGE);
          }
          this.terminalOnlySessions.delete(sessionId);
          throw new Error(OWNED_STOP_UNAVAILABLE_MESSAGE);
        }
        this.markTerminalOnly(sessionId);
        throw new Error(SHARED_ROUTE_UNAVAILABLE_MESSAGE);
      }
      throw new Error(brokerFailureMessage(error));
    }
  }

  async listQueuedMessages(sessionId: string): Promise<QueuedMessage[]> {
    try {
      const queued: QueuedMessage[] = [];
      for (const row of await this.querySessionItems(
        sessionId,
        "queue.messages.list",
        {},
        { strict: true },
      )) {
        if (!row || typeof row !== "object" || Array.isArray(row)) continue;
        const value = row as Record<string, unknown>;
        if (typeof value.id !== "string" || typeof value.text !== "string")
          continue;
        const mode = value.mode === "steer" ? "steer" : "followUp";
        queued.push({
          id: value.id,
          text: value.text,
          mode,
          label:
            typeof value.label === "string" && value.label
              ? value.label
              : mode === "steer"
                ? "Steer"
                : "Queued",
        });
      }
      return queued;
    } catch {
      return [];
    }
  }

  /**
   * GJC CLI empty submit: interrupt the current stream so the window can hand over
   * the requests it is holding.
   */
  async flushQueuedNow(sessionId: string): Promise<boolean> {
    if (this.flushingSessions.has(sessionId)) return true;
    this.flushingSessions.add(sessionId);
    try {
      const pendingSteer = this.pendingSteers.get(sessionId);
      if (pendingSteer) await pendingSteer.catch(() => undefined);
      // The window owns its pending queue, so it already knows there is work to
      // release. GJC reports no waiting steer of its own -- turn.steer is consumed
      // by the open turn -- so there is nothing here to confirm against.
      await this.abortOwnedThroughControl(sessionId);
      this.updateSessionStatus(sessionId, "running");
      return true;
    } catch (error) {
      if (uncertainAfterSendError(error) || cancelledOperationError(error)) {
        this.updateSessionStatus(sessionId, "running");
        return true;
      }
      throw error;
    } finally {
      this.flushingSessions.delete(sessionId);
    }
  }

  private appendSdkCommandOutput(
    sessionId: string,
    content: string,
  ): void {
    const message: ChatMessage = {
      id: `sdk-command-${this.nextLocalId++}`,
      kind: "message",
      sessionId,
      role: "assistant",
      content,
      createdAt: nowLabel(),
      streaming: false,
    };
    this.appendTranscript(message);
    const session = this.sessions.get(sessionId);
    if (session)
      this.emitEvent({ type: "session.updated", session: { ...session } });
  }

  private sdkCommandJson(value: unknown): string {
    const text = JSON.stringify(value, null, 2) ?? String(value);
    const bounded =
      text.length <= MAX_TOOL_TEXT
        ? text
        : `${text.slice(0, MAX_TOOL_TEXT)}\n… output truncated`;
    return `\`\`\`json\n${bounded}\n\`\`\``;
  }

  private async executeSdkSlashCommand(
    sessionId: string,
    input: ResolvedMessageInput,
  ): Promise<boolean> {
    if (input.images?.length || input.files?.length) return false;
    const match = /^\/([a-z][a-z0-9-]*)(?:\s+([\s\S]*))?$/iu.exec(
      input.text.trim(),
    );
    if (!match?.[1]) return false;
    const name = match[1].toLowerCase();
    const args = match[2]?.trim() ?? "";
    const spec = SDK_SLASH_COMMAND_SPECS.find(
      (candidate) => candidate.name === name,
    );
    if (!spec) return false;
    const operations = await this.sdkOperations(sessionId);
    // A recognized command whose capability this runtime does not advertise is
    // refused rather than forwarded as prompt text: the same characters would reach
    // the model as a user request for work GJC just said it cannot dispatch.
    if (!spec.operations.some((operation) => operations.has(operation)))
      throw new Error(
        `/${name} is unavailable in this GJC runtime (${spec.operations.join(" and ")} not advertised)`,
      );

    const requireOperation = (operation: string): void => {
      if (!operations.has(operation))
        throw new Error(
          `/${name} is unavailable in this GJC runtime (${operation} is not advertised)`,
        );
    };
    const output = (content: string): true => {
      this.appendSdkCommandOutput(sessionId, content);
      return true;
    };
    const query = async (
      operation: string,
      queryInput: Record<string, unknown> = {},
    ): Promise<unknown[]> => {
      requireOperation(operation);
      return await this.querySessionItems(sessionId, operation, queryInput, {
        strict: true,
      });
    };
    const control = async (
      operation:
        | "mode.goal.operate"
        | "model.profile.set"
        | "thinking.set"
        | "service_tier.set"
        | "session.export_html"
        | "context.clear"
        | "compaction.run"
        | "session.rename"
        | "session.cwd.move"
        | "retry.last"
        | "bash.background"
        | "runtime.reload"
        | "mode.plan.set"
        | "auth.login",
      controlInput: Record<string, unknown> = {},
      options?: { confirm?: boolean },
    ): Promise<Record<string, unknown> | undefined> => {
      requireOperation(operation);
      return await this.controlSession(
        sessionId,
        operation,
        controlInput,
        options,
      );
    };

    switch (name) {
      case "context": {
        if (args) throw new Error("Usage: /context");
        const rows = await query("context.get");
        const row = rows[0] as Record<string, unknown> | undefined;
        const usage =
          row?.usage &&
          typeof row.usage === "object" &&
          !Array.isArray(row.usage)
            ? (row.usage as Record<string, unknown>)
            : undefined;
        return output(
          [
            "## Context",
            `- Window: ${typeof usage?.contextWindow === "number" ? usage.contextWindow.toLocaleString() : "unknown"} tokens`,
            `- Used: ${typeof usage?.percent === "number" ? `${usage.percent.toFixed(1)}%` : "unknown"}`,
            `- Source: ${typeof usage?.source === "string" ? usage.source : "unknown"}`,
            `- Streaming: ${row?.isStreaming === true ? "yes" : "no"}`,
            `- Steers queued: ${typeof row?.steeringQueueDepth === "number" ? row.steeringQueueDepth : 0}`,
            `- Follow-ups queued: ${typeof row?.followupQueueDepth === "number" ? row.followupQueueDepth : 0}`,
          ].join("\n"),
        );
      }
      case "usage":
        if (args) throw new Error("Usage: /usage");
        return output(this.sdkCommandJson(await query("usage.get")));
      case "tools":
        if (args) throw new Error("Usage: /tools");
        return output(
          `## Tools\n${(await query("tools.list")).map((tool) => `- ${String(tool)}`).join("\n")}`,
        );
      case "jobs":
        if (args) throw new Error("Usage: /jobs");
        return output(this.sdkCommandJson(await query("runtime.jobs.list")));
      case "session": {
        const subcommand = args || "info";
        if (subcommand === "delete") {
          await this.deleteSession(sessionId);
          return true;
        }
        if (subcommand !== "info")
          throw new Error("Usage: /session [info|delete]");
        const [metadata, stats] = await Promise.all([
          query("session.metadata"),
          query("session.stats"),
        ]);
        return output(this.sdkCommandJson({ metadata: metadata[0], stats: stats[0] }));
      }
      case "transcript":
      case "dump":
        if (args) throw new Error(`Usage: /${name}`);
        return output(this.sdkCommandJson(await query("transcript.list")));
      case "extensions":
        if (args) throw new Error("Usage: /extensions");
        return output(this.sdkCommandJson(await query("extensions.list")));
      case "provider": {
        const login = /^login\s+(.+)$/iu.exec(args);
        if (login?.[1]) {
          const result = await control("auth.login", {
            provider: login[1].trim(),
          });
          return output(this.sdkCommandJson(result ?? { accepted: true }));
        }
        if (args) throw new Error("Usage: /provider [login <provider>]");
        const [active, auth] = await Promise.all([
          operations.has("providers.list/active")
            ? query("providers.list/active")
            : Promise.resolve([]),
          operations.has("auth.providers")
            ? query("auth.providers")
            : Promise.resolve([]),
        ]);
        return output(this.sdkCommandJson({ active, authentication: auth }));
      }
      case "credential":
        if (args) throw new Error("Credential switching is not exposed by this SDK runtime");
        return output(this.sdkCommandJson(await query("auth.providers")));
      case "goal": {
        const [verb = "show", ...rest] = args.split(/\s+/u).filter(Boolean);
        if (verb === "show" || verb === "get")
          return output(this.sdkCommandJson(await query("goal.list/get")));
        const op = verb === "set" ? "create" : verb;
        if (!new Set(["create", "pause", "resume", "complete", "drop"]).has(op))
          throw new Error(
            "Usage: /goal [set|show|pause|resume|complete|drop] [objective]",
          );
        const objective = rest.join(" ");
        if (op === "create" && !objective)
          throw new Error("Usage: /goal set <objective>");
        const result = await control("mode.goal.operate", {
          op,
          ...(objective ? { objective } : {}),
        });
        return output(this.sdkCommandJson(result ?? { accepted: true }));
      }
      case "model": {
        if (!args)
          return output(
            this.sdkCommandJson(await query("models.profiles.list")),
          );
        const result = await control("model.profile.set", { id: args });
        return output(this.sdkCommandJson(result ?? { profile: args }));
      }
      case "effort": {
        if (!args)
          return output(
            `Current effort: ${this.sessions.get(sessionId)?.thinking ?? "inherit"}`,
          );
        const result = await control("thinking.set", { level: args });
        return output(this.sdkCommandJson(result ?? { level: args }));
      }
      case "fast": {
        const verb = (args || "toggle").toLowerCase();
        if (!["toggle", "on", "off", "status"].includes(verb))
          throw new Error("Usage: /fast [toggle|on|off|status]");
        // The window only knows the tier the session reported (its transcript's
        // last `service_tier_change` or a tier this window set itself), and GJC
        // resolves that intent per provider. Every branch below therefore reports
        // the configured tier, never a claim that the provider honored it.
        const current = this.sessions.get(sessionId)?.serviceTier;
        const enabled =
          current !== undefined && SDK_FAST_SERVICE_TIERS.has(current);
        if (verb === "status")
          return output(
            [
              "## Fast mode",
              // A session that never recorded a tier reports none, and none means
              // no fast intent. The line says which of the two it is instead of
              // presenting an unread tier as a state the runtime confirmed.
              `- Intent: ${enabled ? "on" : current ? "off" : "off (no tier reported)"}`,
              `- Configured tier: ${current ?? "none reported"}`,
              "- Configured intent only: GJC decides per provider and model whether a",
              "  request actually carries the fast/priority tier.",
            ].join("\n"),
          );
        const enable = verb === "on" ? true : verb === "off" ? false : !enabled;
        // A toggle has to know the tier it is inverting: the runtime's own tier can
        // come from the user's global serviceTier setting, so guessing "off" would
        // silently downgrade a scoped tier. Ask the session's config once, and
        // refuse rather than flip a state this window cannot read.
        const tierSource =
          verb === "toggle" && current === undefined
            ? ((await this.sessionConfigRow(sessionId))?.serviceTier as
                | string
                | undefined)
            : current;
        if (verb === "toggle" && tierSource === undefined)
          throw new Error(
            "This session does not report its current service tier, so /fast cannot toggle it. Use /fast on or /fast off.",
          );
        const tier =
          enable
            ? tierSource && SDK_SCOPED_FAST_SERVICE_TIERS.has(tierSource)
              ? tierSource
              : "priority"
            : SDK_SERVICE_TIER_OFF;
        const result = await control("service_tier.set", { tier });
        // Mirror what the runtime recorded, including the "none" that stands for a
        // cleared tier, so the next status reads off instead of unknown.
        this.patchSessionRuntime(sessionId, { serviceTier: tier });
        return output(
          `Fast mode ${enable ? "enabled" : "disabled"} (configured tier: ${tier}).\n${this.sdkCommandJson(result ?? { tier })}`,
        );
      }
      case "skills": {
        if (args) throw new Error("Usage: /skills");
        const skills = (await query("skill.list/state")).flatMap((row) => {
          if (!row || typeof row !== "object" || Array.isArray(row)) return [];
          const value = row as Record<string, unknown>;
          if (typeof value.name !== "string" || !value.name) return [];
          const description =
            typeof value.description === "string" ? value.description : "";
          return [`- ${value.name}${description ? ` — ${description}` : ""}`];
        });
        return output(
          [
            "## Skills",
            ...(skills.length > 0
              ? skills
              : ["- This session reports no skills."]),
            "Run one as agent work with `/skill:<name> <request>`.",
          ].join("\n"),
        );
      }
      case "progress":
        if (args) throw new Error("Usage: /progress");
        return output(this.sdkCommandJson(await query("session.progress")));
      case "reload": {
        const requested = args.split(/[\s,]+/u).filter(Boolean);
        const unknown = requested.filter(
          (component) =>
            !(SDK_RELOAD_COMPONENTS as readonly string[]).includes(component),
        );
        if (unknown.length > 0)
          throw new Error(
            `Unknown reload component: ${unknown.join(", ")}. Use one or more of ${SDK_RELOAD_COMPONENTS.join(", ")}.`,
          );
        const components =
          requested.length > 0
            ? [...new Set(requested)]
            : [...SDK_RELOAD_COMPONENTS];
        // gjc/0.18.11 validates this list and then reloads the whole session
        // (`AgentSession.reload`); the per-component split is the runtime's to
        // apply, so the reply reports what was requested and what it answered.
        const result = await control("runtime.reload", { components });
        // A reload re-reads skills, extensions, and config from disk, so the
        // palette this window derived from the old ones is stale the moment it
        // succeeds. Rebuild both sides of the session's reported surface.
        await Promise.all([
          this.refreshSdkCommands(sessionId),
          this.refreshModelProfiles(sessionId).catch(() => undefined),
          this.refreshSessionConfigOptions(sessionId).catch(() => undefined),
        ]);
        return output(
          `Reload requested for ${components.join(", ")}.\n${this.sdkCommandJson(result ?? { reloaded: true })}`,
        );
      }
      case "plan": {
        if (args !== "on" && args !== "off")
          throw new Error("Usage: /plan [on|off]");
        const on = args === "on";
        const result = await control("mode.plan.set", { on });
        if (typeof result?.enabled === "boolean")
          this.patchSessionRuntime(sessionId, {
            mode: result.enabled ? "plan" : "default",
          });
        return output(this.sdkCommandJson(result ?? { enabled: on }));
      }
      case "export": {
        if (args) throw new Error("This SDK exports to its managed HTML path; use /export without a path");
        const result = await control("session.export_html");
        return output(this.sdkCommandJson(result ?? { exported: true }));
      }
      case "clear":
        if (args) throw new Error("Usage: /clear");
        await control("context.clear", {}, { confirm: true });
        return output("Context cleared. The session ID and durable transcript were preserved.");
      case "compact":
        if (args) throw new Error("Use the compact action without inline instructions in this client");
        await this.compactSession(sessionId);
        return true;
      case "retry":
        if (args) throw new Error("Usage: /retry");
        return output(
          this.sdkCommandJson((await control("retry.last")) ?? { accepted: true }),
        );
      case "background":
        if (args) throw new Error("Usage: /background");
        return output(
          this.sdkCommandJson(
            (await control("bash.background")) ?? { accepted: true },
          ),
        );
      case "rename":
        if (!args) throw new Error("Usage: /rename <title>");
        await this.renameSession(sessionId, args);
        return output(`Session renamed to **${args}**.`);
      case "move":
        if (!args) throw new Error("Usage: /move <path>");
        {
          const result = await control("session.cwd.move", { path: args });
          const cwd =
            typeof result?.cwd === "string"
              ? result.cwd
              : path.resolve(this.sessionCwds.get(sessionId) ?? this.workspace, args);
          const session = this.sessions.get(sessionId);
          if (session) {
            this.sessionCwds.set(sessionId, cwd);
            this.sessionMetadata?.setWorkspace(sessionId, cwd);
            session.workspace = cwd;
            session.subtitle = path.basename(cwd) || cwd;
            markUpdated(session);
            this.emitEvent({ type: "session.updated", session: { ...session } });
          }
          return output(this.sdkCommandJson(result ?? { moved: true, cwd }));
        }
      default:
        return false;
    }
  }

  async sendMessage(
    sessionId: string,
    input: ResolvedMessageInput,
  ): Promise<MessageDelivery> {
    this.locallyAbortedSessions.delete(sessionId);
    if (await this.executeSdkSlashCommand(sessionId, input)) return "prompt";
    const value = input.text.trim();
    if (/^\/steer(?:\s+|$)/u.test(value)) {
      await this.steerSession(sessionId, input);
      return "steer";
    }
    // `bare` is the user's own text; `promptText` adds the attachment block.
    // steerSession composes the block itself, so the steer fallbacks below hand
    // it `bare` -- passing promptText appended the same block a second time.
    const bare = value.replace(/^\/queue(?:\s+|$)/u, "").trim();
    const promptText = bare + attachedPathsText(input);
    if (!promptText) return "prompt";
    const session = this.sessions.get(sessionId);
    if (
      this.activePromptSessions.has(sessionId) ||
      session?.status === "running"
    ) {
      await this.steerSession(sessionId, { ...input, text: bare });
      return "steer";
    }
    this.activePromptSessions.add(sessionId);

    // The bubble is echoed before any await so the window shows the request the
    // moment it is submitted. Connecting and attaching are round trips, and doing
    // them first left the composer looking like it had swallowed the message.
    this.activeAssistantMessages.delete(sessionId);
    this.finalizeThought(sessionId);
    this.appendLocalUserMessage(sessionId, promptText, input);
    this.updateSessionStatus(sessionId, "running");

    try {
      const cli = await this.requireCli();
      await this.ensureAttached(sessionId, false);
      // One fresh operation reference per logical prompt. A reused reference is
      // rejected as a conflict while its record is retained, and after eviction it
      // could be admitted again with the first outcome unknown, so a retry must
      // never recycle one.
      const operationRef = freshOperationRef();
      let accepted: Awaited<ReturnType<GjcSdkCli["send"]>> | undefined;
      let alreadySettled = false;
      try {
        accepted = await cli.send(sessionId, promptText, {
          repo: this.repoFor(sessionId),
          opRef: operationRef,
        });
      } catch (error) {
        if (!uncertainAfterSendError(error)) throw error;
        // The frame may already have reached the host. Never retry the logical
        // prompt or reuse its reference; reconcile that exact reference instead.
        const outcome = await this.awaitPromptSettlement(
          sessionId,
          operationRef,
        );
        if (outcome === "unknown") {
          this.updateSessionStatus(sessionId, "running");
          return "prompt";
        }
        alreadySettled = true;
      }
      if (accepted?.status === "failed")
        throw new Error("GJC rejected the prompt");
      // `send` returning means the prompt was *accepted*, not that the agent
      // stopped. A follow-up turn, a released steer, or background work keeps running
      // and keeps appending to the transcript, so closing the row here reported 완료
      // over live work. The prompt record and the session's own transcript are the
      // accounts that cover what a single CLI call cannot see, so they decide.
      const settlement = alreadySettled
        ? "terminal"
        : await this.awaitPromptSettlement(sessionId, operationRef);
      if (settlement === "unknown") {
        // Poll exhaustion or unavailable evidence is not a terminal event. The
        // file watcher and tail follower remain responsible for the later state.
        this.updateSessionStatus(sessionId, "running");
        return "prompt";
      }
      this.finalizeThought(sessionId);
      this.finalizeAssistantMessage(sessionId);
      await this.refreshContextUsage(sessionId);
      // updateSessionStatus announces the running -> idle transition itself.
      //
      // The prompt is released before the read because the run-state cache is keyed on
      // the file, not the caller, and leaving this session marked as actively prompted
      // would let a concurrent republish skip it. `finally` releasing it again is a
      // no-op on a Set.
      const settlementGeneration = this.generation;
      const settlementRevision = this.currentRunRevision(sessionId);
      this.activePromptSessions.delete(sessionId);
      const stillRunning = await this.discoveredRunState(sessionId);
      if (
        settlementGeneration === this.generation &&
        settlementRevision === this.currentRunRevision(sessionId)
      )
        this.updateSessionStatus(
          sessionId,
          stillRunning === "running" ? "running" : "idle",
        );
    } catch (caught) {
      let error: unknown = caught;
      if (busyPromptError(error)) {
        this.activePromptSessions.delete(sessionId);
        await this.steerSession(
          sessionId,
          { ...input, text: bare },
          { echo: false },
        );
        return "steer";
      }
      if (isSessionUnreachable(error)) {
        this.markTerminalOnly(sessionId);
        error = new Error(SHARED_ROUTE_UNAVAILABLE_MESSAGE);
      }
      this.finalizeThought(sessionId);
      this.finalizeAssistantMessage(sessionId);
      void this.refreshContextUsage(sessionId);
      if (cancelledOperationError(error)) {
        // A cancel is the user's own action, so it settles quietly.
        this.updateSessionStatus(sessionId, "idle", { announce: false });
        this.appendCancelledNotice(sessionId);
        return "prompt";
      }
      // A failed run is announced as a failure below, so the idle transition must
      // not also announce a completion.
      this.updateSessionStatus(sessionId, "idle", { announce: false });
      const notice: NoticeActivity = {
        id: `gjc-error-${this.nextLocalId++}`,
        kind: "notice",
        sessionId,
        title: "GJC run failed",
        content: error instanceof Error ? error.message : String(error),
        tone: "warning",
        createdAt: nowLabel(),
      };
      this.appendTranscript(notice);
      this.emitActivity(sessionId, "failed");
      throw error;
    } finally {
      this.activePromptSessions.delete(sessionId);
    }
    return "prompt";
  }

  /**
   * Waits for an accepted prompt to reach a terminal record.
   *
   * The semantic `send` call returns at acceptance rather than holding open for the
   * whole turn, so the window's spinner and final status need reconciliation. The
   * turn is followed here instead: `status` is the lossless record, and the
   * transcript is watched in parallel by the session-file watcher.
   *
   * A prompt that is still running when the poll budget ends is left running. This
   * never forces the row idle and never reports a cancel, because `unknown` and
   * "still going" are both uncertainty, not proof the work stopped.
   */
  private async awaitPromptSettlement(
    sessionId: string,
    operationRef: string,
  ): Promise<"terminal" | "unknown"> {
    const generation = this.generation;
    for (let attempt = 0; attempt < PROMPT_SETTLE_ATTEMPTS; attempt += 1) {
      // A cancel or a newer turn owns the row now; stop following this one.
      if (
        this.disposed ||
        generation !== this.generation ||
        this.locallyAbortedSessions.has(sessionId)
      )
        return "unknown";
      await new Promise((resolve) =>
        setTimeout(resolve, PROMPT_SETTLE_INTERVAL_MS),
      );
      let record: Awaited<ReturnType<GjcSdkCli["promptStatus"]>> | undefined;
      try {
        const cli = await this.requireCli();
        record = await cli.promptStatus(sessionId, operationRef, {
          repo: this.repoFor(sessionId),
        });
      } catch (error) {
        // A session that cannot answer its own prompt record is not proof the prompt
        // failed; the transcript still accounts for it.
        if (isSessionMissing(error)) return "unknown";
        continue;
      }
      if (!record.completed) continue;
      if (record.status === "failed") {
        const message = record.error?.message ?? "GJC run failed";
        // A cancel is the user's own action and settles quietly upstream.
        if (
          record.error?.code === "aborted" ||
          /abort|cancel/iu.test(message)
        )
          return "terminal";
        throw new Error(message);
      }
      return "terminal";
    }
    return "unknown";
  }

  async cancelRun(sessionId: string): Promise<void> {
    const previous = this.cancellationPromises.get(sessionId);
    if (previous) return previous;
    let resolveCancellation!: () => void;
    let rejectCancellation!: (error: unknown) => void;
    const completion = new Promise<void>((resolve, reject) => {
      resolveCancellation = resolve;
      rejectCancellation = reject;
    });
    // The initiating caller receives the original error below; keep the shared
    // promise from becoming an unhandled rejection when no concurrent caller
    // is waiting on it.
    void completion.catch(() => undefined);
    this.cancellationPromises.set(sessionId, completion);
    this.cancellingSessions.add(sessionId);
    try {
      await this.fireAbort(sessionId);
      this.finalizeThought(sessionId);
      this.finalizeAssistantMessage(sessionId);
      this.finalizeAllMessages(sessionId);
      this.cancelOpenTools(sessionId);
      this.cancelPermissionsForSession(sessionId);
      this.appendCancelledNotice(sessionId);
      this.locallyAbortedSessions.add(sessionId);
      // Only confirmed aborts may clear run authority and publish idle.
      this.liveRunningSessions.delete(sessionId);
      this.liveRunningDigests.delete(sessionId);
      this.transcriptRunningSessions.delete(sessionId);
      this.workingPhaseSessions.delete(sessionId);
      this.runtimeIdleSessions.delete(sessionId);
      this.pendingAsyncWorkSessions.delete(sessionId);
      this.discoveredRunStates.delete(sessionId);
      this.compactingSessions.delete(sessionId);
      this.compactionRecordBaseline.delete(sessionId);
      this.compactionStartedAt.delete(sessionId);
      this.updateSessionStatus(sessionId, "idle");
      resolveCancellation();
    } catch (error) {
      // No state was cleared before confirmation, so keep whatever the runtime
      // currently reports instead of inventing running work for an idle session.
      rejectCancellation(error);
      throw error;
    } finally {
      this.cancellingSessions.delete(sessionId);
      if (this.cancellationPromises.get(sessionId) === completion)
        this.cancellationPromises.delete(sessionId);
    }
    return completion;
  }

  private async fireAbort(sessionId: string): Promise<void> {
    await this.abortOwnedThroughControl(sessionId);
  }

  private appendCancelledNotice(sessionId: string): void {
    const items = this.transcripts.get(sessionId) ?? [];
    // The persisted transcript reports an aborted turn as `shared-cancelled-`,
    // so checking only for this window's own prefix announced the same
    // cancellation a second time once the rebuild had already landed.
    if (
      items.some(
        (item) => item.kind === "notice" && item.title === "작업 취소됨",
      )
    )
      return;
    this.appendTranscript({
      id: `gjc-cancelled-${this.nextLocalId++}`,
      kind: "notice",
      sessionId,
      title: "작업 취소됨",
      content: "진행 중인 작업이 취소되어 종료됐습니다.",
      tone: "neutral",
      createdAt: nowLabel(),
    });
  }

  /**
   * Stops the current turn and this window's own background work.
   *
   * Terminal abort is session-scoped: it cancels the current turn and exactly the
   * owned background work without signalling or closing the GJC session process.
   * A signal is never sent -- SIGINT would take down a session the user may be
   * sharing with a terminal.
   *
   * The payload carries only `mode`/`scope`/`operator`: the host validates terminal
   * abort input strictly and rejects any other key (including `confirm` and
   * `idempotencyKey`, which travel as CLI flags) with `usage`. Verified against
   * gjc/0.18.11: adding a `clientRef` or `turnId` field to the terminal payload is
   * rejected before dispatch.
   *
   * Only `turn: "stopped"` is a confirmation. gjc/0.18.11 answers the typed
   * disposition `{turn:"no_active_turn", terminal:"terminal_no_effect"}` when the
   * broker route cannot see the host's active prompt -- reproducible while a turn is
   * verifiably running (`status` in_flight and `turn.steer` accepted on the same
   * session) -- and the turn keeps running. Reporting that as a cancellation would
   * tell the user work stopped while it is still going, so the failure is surfaced
   * instead and the local run state is left untouched.
   */
  private async abortOwnedThroughControl(
    sessionId: string,
  ): Promise<Record<string, unknown>> {
    const idempotencyKey = `gajae-abort-${randomUUID()}`;
    const result = await this.controlSession(
      sessionId,
      "turn.abort",
      {
        mode: "terminal",
        scope: "owned",
        operator: true,
      },
      { idempotencyKey, confirm: true },
    );
    if (result?.turn === "stopped") return result;
    throw new Error(
      `GJC가 작업 중지를 확정하지 못했습니다. 응답: ${JSON.stringify(result ?? null)}`,
    );
  }

  toolDecisionInfo(
    toolId: string,
    decision: ToolDecision,
  ): { name: string; requiresConfirmation: boolean } {
    const option = this.permissionOption(toolId, decision);
    return {
      name: option.name,
      requiresConfirmation: option.kind.startsWith("allow"),
    };
  }

  private permissionOption(toolId: string, decision: ToolDecision) {
    const pending = this.pendingPermissions.get(toolId);
    if (!pending)
      throw new Error(`No pending permission for tool call ${toolId}`);
    const option = pending.request.options.find(
      (candidate) => candidate.optionId === decision.optionId,
    );
    if (!option)
      throw new Error(`Unknown permission option ${decision.optionId}`);
    return option;
  }

  async resolveToolCall(toolId: string, decision: ToolDecision): Promise<void> {
    const pending = this.pendingPermissions.get(toolId)!;
    const option = this.permissionOption(toolId, decision);
    this.pendingPermissions.delete(toolId);
    pending.resolve({
      outcome: { outcome: "selected", optionId: option.optionId },
    });
    this.patchTool(toolId, {
      status: option.kind.startsWith("allow") ? "approved" : "denied",
    });
  }

  async markSessionRead(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.unread = false;
      this.sessionMetadata?.setUnread(sessionId, false);
      this.emitEvent({ type: "session.updated", session: { ...session } });
    }
  }

  async readArtifact(
    sessionId: string,
    artifactId: string,
  ): Promise<ArtifactContent> {
    if (!/^[A-Za-z0-9._-]+$/.test(artifactId))
      throw new Error("Invalid artifact id");
    const file = path.join(
      this.artifactDirectory,
      this.artifactNamespace(sessionId),
      `${artifactId}.json`,
    );
    try {
      const raw = JSON.parse(await readFile(file, "utf8")) as { text?: string };
      const text = raw.text ?? "";
      return {
        artifactId,
        text,
        complete: true,
        totalBytes: Buffer.byteLength(text),
      };
    } catch {
      const cli = await this.requireCli();
      await this.ensureAttached(sessionId, false);
      const chunks: Buffer[] = [];
      let offset = 0;
      let complete = false;
      while (!complete) {
        const envelope = await cli.rawQuery(
          sessionId,
          "artifact.read",
          { artifactId, offset, length: 256 * 1024 },
          { repo: this.repoFor(sessionId) },
        );
        const result =
          envelope.result &&
          typeof envelope.result === "object" &&
          !Array.isArray(envelope.result)
            ? (envelope.result as Record<string, unknown>)
            : envelope;
        if (typeof result.bytes !== "string")
          throw new Error(`Artifact ${artifactId} returned invalid data`);
        const chunk = Buffer.from(result.bytes, "base64");
        if (chunk.length === 0 && result.complete !== true)
          throw new Error(`Artifact ${artifactId} made no read progress`);
        chunks.push(chunk);
        offset += chunk.length;
        if (offset > 64 * 1024 * 1024)
          throw new Error(
            `Artifact ${artifactId} exceeds the 64 MB desktop read limit`,
          );
        complete = result.complete === true;
      }
      return {
        artifactId,
        text: Buffer.concat(chunks).toString("utf8"),
        complete,
        totalBytes: offset,
      };
    }
  }

  async previewFile(
    sessionId: string,
    requestedPath: string,
  ): Promise<GeneratedFilePreview> {
    const workspace = await realpath(
      this.sessionCwds.get(sessionId) ?? this.workspace,
    );
    const resolved = await realpath(
      path.isAbsolute(requestedPath)
        ? requestedPath
        : path.join(workspace, requestedPath),
    );
    if (
      resolved !== workspace &&
      !resolved.startsWith(`${workspace}${path.sep}`)
    )
      throw new Error("Preview file must be inside the session workspace");
    const info = await stat(resolved);
    if (!info.isFile()) throw new Error("Preview target is not a file");
    const extension = path.extname(resolved).toLowerCase();
    const imageTypes: Record<string, string> = {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".webp": "image/webp",
      ".gif": "image/gif",
      ".svg": "image/svg+xml",
    };
    const textTypes: Record<string, string> = {
      ".txt": "text/plain",
      ".json": "application/json",
      ".yaml": "application/yaml",
      ".yml": "application/yaml",
      ".toml": "application/toml",
      ".csv": "text/csv",
      ".ts": "text/typescript",
      ".tsx": "text/typescript",
      ".js": "text/javascript",
      ".jsx": "text/javascript",
      ".css": "text/css",
      ".py": "text/x-python",
      ".rs": "text/x-rust",
      ".go": "text/x-go",
    };
    const base = {
      path: resolved,
      name: path.basename(resolved),
      size: info.size,
    };
    if (imageTypes[extension]) {
      if (info.size > 20 * 1024 * 1024)
        throw new Error("Image preview exceeds 20 MiB");
      const bytes = await readFile(resolved);
      return {
        ...base,
        kind: "image",
        mimeType: imageTypes[extension]!,
        dataUrl: `data:${imageTypes[extension]};base64,${bytes.toString("base64")}`,
      };
    }
    if (extension === ".pdf") {
      if (info.size > 30 * 1024 * 1024)
        throw new Error("PDF preview exceeds 30 MiB");
      const bytes = await readFile(resolved);
      return {
        ...base,
        kind: "pdf",
        mimeType: "application/pdf",
        dataUrl: `data:application/pdf;base64,${bytes.toString("base64")}`,
      };
    }
    if (
      extension === ".md" ||
      extension === ".markdown" ||
      extension === ".html" ||
      extension === ".htm" ||
      textTypes[extension]
    ) {
      if (info.size > 2 * 1024 * 1024)
        throw new Error("Text preview exceeds 2 MiB");
      const content = await readFile(resolved, "utf8");
      const kind =
        extension === ".md" || extension === ".markdown"
          ? "markdown"
          : extension === ".html" || extension === ".htm"
            ? "html"
            : "text";
      return {
        ...base,
        kind,
        mimeType:
          kind === "html"
            ? "text/html"
            : kind === "markdown"
              ? "text/markdown"
              : textTypes[extension]!,
        content,
      };
    }
    return {
      ...base,
      kind: "unsupported",
      mimeType: "application/octet-stream",
    };
  }

  private async querySessionItems(
    sessionId: string,
    query: string,
    input: Record<string, unknown> = {},
    options?: { strict?: boolean },
  ): Promise<unknown[]> {
    try {
      const cli = await this.requireCli();
      return await cli.queryItems(sessionId, query, input, {
        repo: this.repoFor(sessionId),
      });
    } catch (error) {
      if (!options?.strict) return [];
      throw error;
    }
  }

  /**
   * Rebuilds one session's command palette.
   *
   * Three sources feed it:
   *  - this window's adapter specs, filtered by the operations the runtime
   *    advertises (`runtime.capabilities`);
   *  - dynamic commands synthesized from runtime state (`discoverDynamicCommands`),
   *    which is what fills a skill palette on create/attach before GJC has published
   *    anything of its own;
   *  - the runtime's advertised commands (`available_commands_update`), which win on
   *    a name collision.
   *
   * The palette is rebuilt from those sources whole, so a command the runtime stops
   * listing leaves with it. An authoritative update is also authority over the
   * synthesized set: once one arrives, even an empty one, the runtime's own list is
   * used alone and the synthesized entries are dropped instead of being merged back
   * in. A failing source contributes nothing rather than clearing the palette.
   */
  private async refreshSdkCommands(
    sessionId: string,
    advertised?: AgentCommand[],
  ): Promise<void> {
    if (advertised) this.sessionAdvertisedCommands.set(sessionId, advertised);
    // A capability query that answers nothing is not the same as one that answered
    // "no": the cached set is reused when there is one, and the adapter specs stay
    // out of the palette rather than reporting a guess either way.
    const operations = await this.sdkOperations(sessionId);
    const authoritative = this.sessionAdvertisedCommands.get(sessionId);
    const discovered =
      authoritative === undefined
        ? await this.discoverDynamicCommands(sessionId, operations).catch(
            () => undefined,
          )
        : undefined;
    if (discovered) this.sessionDiscoveredCommands.set(sessionId, discovered);
    else this.sessionDiscoveredCommands.delete(sessionId);
    if (
      operations.size === 0 &&
      authoritative === undefined &&
      discovered === undefined
    )
      // Nothing to rebuild from: never publish an empty palette over a good cache.
      return;
    const commands = [
      ...new Map(
        [
          ...sdkSlashCommandsForOperations([...operations]),
          ...(discovered ?? []),
          ...(authoritative ?? []),
        ].map((command) => [command.name, command]),
      ).values(),
    ];
    this.sessionCommands.set(sessionId, commands);
    this.emitEvent({ type: "session.commands", sessionId, commands });
  }

  /**
   * Dynamic commands synthesized from runtime state, used only until the runtime
   * publishes its own list.
   *
   * `skill.list/state` is the only dynamic command source gjc/0.18.11 exposes through
   * the SDK query surface: there is no query for the slash-command snapshot the
   * runtime builds for its own UI (`getSessionSlashCommands`, which filters
   * `skillsSettings.enableSkillCommands` and `skill.hide`), and this window does not
   * pretend to reproduce that registry. Rows that carry a visibility flag are honored
   * and a config that explicitly disables skills removes the whole set, but a hidden
   * skill in a row that carries no flag cannot be told apart from a visible one, so
   * these entries are advertised as selectable agent work only: `/skill:<name>` is
   * still delivered to the runtime as a prompt, and the runtime decides whether the
   * skill runs. They are also dropped as soon as an `available_commands_update`
   * arrives, since the runtime's own list is the authority on its own commands.
   */
  private async discoverDynamicCommands(
    sessionId: string,
    operations: ReadonlySet<string>,
  ): Promise<AgentCommand[] | undefined> {
    if (!operations.has("skill.list/state")) return undefined;
    const [skills, config] = await Promise.all([
      this.querySessionItems(sessionId, "skill.list/state"),
      operations.has("config.list/get")
        ? this.querySessionItems(sessionId, "config.list/get")
        : Promise.resolve([]),
    ]);
    if (skillsDisabledByConfig(config)) return [];
    const commands = new Map<string, AgentCommand>();
    for (const row of skills) {
      if (!row || typeof row !== "object" || Array.isArray(row)) continue;
      const skill = row as Record<string, unknown>;
      const name = typeof skill.name === "string" ? skill.name.trim() : "";
      if (!name) continue;
      if (
        skill.hide === true ||
        skill.hidden === true ||
        skill.enabled === false ||
        skill.visible === false
      )
        continue;
      const commandName = `skill:${name}`;
      if (commands.has(commandName)) continue;
      const description =
        typeof skill.description === "string" ? skill.description : "";
      commands.set(commandName, {
        name: commandName,
        description: description || `Run the ${name} skill`,
        hint: "[instructions]",
      });
    }
    return [...commands.values()];
  }

  private async sdkOperations(sessionId: string): Promise<Set<string>> {
    const cached = this.sessionSdkOperations.get(sessionId);
    if (cached) return cached;
    const rows = await this.querySessionItems(
      sessionId,
      "runtime.capabilities",
    );
    const operations = new Set(
      rows.flatMap((row) => {
        if (!row || typeof row !== "object" || Array.isArray(row)) return [];
        const value = row as Record<string, unknown>;
        return Array.isArray(value.operations)
          ? value.operations.filter(
              (operation): operation is string => typeof operation === "string",
            )
          : [];
      }),
    );
    if (operations.size > 0) this.sessionSdkOperations.set(sessionId, operations);
    return operations;
  }

  async getGoal(sessionId: string): Promise<GoalSnapshot> {
    // The todo read is shared with the transcript snapshot row, so the counters here
    // and the row a user can expand are the same observation of the same store.
    const [goalRows, todoRows] = await Promise.all([
      this.querySessionItems(sessionId, "goal.list/get"),
      this.readTodoRecords(sessionId),
    ]);
    const state =
      goalRows[0] &&
      typeof goalRows[0] === "object" &&
      !Array.isArray(goalRows[0])
        ? (goalRows[0] as Record<string, unknown>)
        : undefined;
    const goal =
      state?.goal &&
      typeof state.goal === "object" &&
      !Array.isArray(state.goal)
        ? (state.goal as Record<string, unknown>)
        : undefined;
    const tasks = (todoRows ?? [])
      .flatMap((row) => {
        if (!row || typeof row !== "object" || Array.isArray(row)) return [];
        const value = row as Record<string, unknown>;
        return Array.isArray(value.tasks) ? value.tasks : [value];
      })
      .filter(
        (task): task is Record<string, unknown> =>
          Boolean(task) && typeof task === "object" && !Array.isArray(task),
      );
    const enabled = state?.enabled === true && Boolean(goal);
    const status =
      typeof goal?.status === "string"
        ? goal.status
        : typeof state?.mode === "string"
          ? state.mode
          : undefined;
    // A dropped goal is discarded, so it must not occupy the progress row. It used
    // to arrive as enabled with no mode, which the inspector rendered as an active
    // goal because it only checks `enabled` and `objective`.
    const live = enabled && status !== "dropped";
    return {
      enabled: live,
      ...(live &&
      (status === "active" || status === "paused" || status === "complete")
        ? { mode: status }
        : {}),
      ...(live && typeof goal?.objective === "string"
        ? { objective: goal.objective }
        : {}),
      completed: tasks.filter((task) => task.status === "completed").length,
      total: tasks.length,
    };
  }

  async operateGoal(
    sessionId: string,
    operation: GoalOperation,
  ): Promise<GoalSnapshot> {
    await this.controlSession(sessionId, "mode.goal.operate", {
      op: operation,
    });
    return this.getGoal(sessionId);
  }

  /**
   * The subagents a session launched, read from the task tool's own arguments.
   *
   * This used to also query `runtime.jobs.list` and merge anything whose kind matched
   * /subagent|task/. Verified against gjc/0.18.11, that query answers a single wrapper
   * row shaped `{running, recent, delivery}` whose entries are background *tool* runs
   * with `type` set to the tool name ("bash"). No entry is ever a subagent and no
   * top-level row has a `kind`, so the filter matched nothing: the merge was dead code
   * whose only live effect was making this method require a live runtime, so a
   * session whose subagents were already in the transcript failed to list them
   * whenever the runtime was unreachable.
   */
  async listSubagents(sessionId: string): Promise<SubagentSnapshot[]> {
    const declaredById = new Map<string, SubagentSnapshot>();
    for (const agent of (this.transcripts.get(sessionId) ?? []).flatMap(
      (item) => (item.kind === "tool" ? (item.subagents ?? []) : []),
    ))
      declaredById.set(agent.id, agent);
    return [...declaredById.values()];
  }

  async getDiff(sessionId: string): Promise<DiffSnapshot> {
    const workspace = this.sessionCwds.get(sessionId) ?? this.workspace;
    try {
      await this.ensureAttached(sessionId, false);
      const files: DiffSnapshot["files"] = [];
      for (const row of await this.querySessionItems(
        sessionId,
        "diff.list_files",
      ))
        if (row && typeof row === "object") {
          const value = row as Record<string, unknown>;
          if (typeof value.path === "string")
            files.push({
              id: typeof value.id === "string" ? value.id : value.path,
              path: value.path,
              patch: typeof value.body === "string" ? value.body : "",
            });
        }
      return {
        sessionId,
        workspace,
        files,
        refreshedAt: new Date().toISOString(),
      };
    } catch (error) {
      return {
        sessionId,
        workspace,
        files: [],
        refreshedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async refreshRuntimeState(sessionId: string): Promise<EffectiveRuntimeState> {
    await this.ensureAttached(sessionId, false);
    const query = async (name: string): Promise<unknown[]> =>
      await this.querySessionItems(sessionId, name);
    const [metadata, skills, config, capabilities, tools] = await Promise.all([
      query("session.metadata"),
      query("skill.list/state"),
      query("config.list/get"),
      query("runtime.capabilities"),
      query("tools.list"),
    ]);
    const names = (values: unknown[]): string[] =>
      [
        ...new Set(
          values.flatMap((value) => {
            if (typeof value === "string") return [value];
            if (!value || typeof value !== "object" || Array.isArray(value))
              return [];
            const item = value as Record<string, unknown>;
            const name = item.name ?? item.id ?? item.key;
            return typeof name === "string" && name ? [name] : [];
          }),
        ),
      ].sort();
    const configRows = config.flatMap((value) =>
      value && typeof value === "object" && !Array.isArray(value)
        ? [value as Record<string, unknown>]
        : [],
    );
    const namedConfig = (pattern: RegExp): string[] =>
      [
        ...new Set(
          configRows.flatMap((item) => {
            const key = String(item.key ?? item.name ?? item.id ?? "");
            if (!pattern.test(key)) return [];
            const value = item.value ?? item.currentValue;
            if (Array.isArray(value))
              return value.filter(
                (entry): entry is string => typeof entry === "string",
              );
            return typeof value === "string" && value ? [value] : [];
          }),
        ),
      ].sort();
    const session = this.sessions.get(sessionId);
    const runtimeState: EffectiveRuntimeState = {
      modelProfile: session?.model ?? this.modelPreset,
      model: session?.modelDisplay,
      thinking: session?.thinking,
      mode: session?.mode,
      permissionHandling: this.permissionHandling,
      mcpServers: namedConfig(/mcp/iu),
      skills: names(skills),
      rules: namedConfig(/rule/iu),
      tools: [...new Set([...names(tools), ...names(capabilities)])].sort(),
      gjcVersion: this.connectionState.version,
      refreshedAt: new Date().toISOString(),
    };
    if (metadata.length > 0 && !runtimeState.model) {
      const first = metadata[0];
      if (first && typeof first === "object" && !Array.isArray(first)) {
        const model = (first as Record<string, unknown>).model;
        if (typeof model === "string") runtimeState.model = model;
      }
    }
    if (session) {
      session.runtimeState = runtimeState;
      this.emitEvent({ type: "session.updated", session: { ...session } });
    }
    this.emitEvent({ type: "runtime.updated", sessionId, runtimeState });
    return runtimeState;
  }

  async reconnect(): Promise<BackendConnection> {
    if (this.disposed) throw new Error("GJC controller is disposed");
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    // Reconnect is a re-resolve, not a restart: there is no process to signal, so
    // nothing owned by another window can be disturbed by it.
    this.cli = undefined;
    this.startup = undefined;
    this.permissionModeApplied.clear();
    for (const sessionId of this.tailControllers.keys())
      this.stopTailFollower(sessionId);
    this.attachedSessions.clear();
    this.sessionSdkOperations.clear();
    this.generation += 1;
    await this.ensureStarted();
    await this.recoverOwnedSessions();
    return { ...this.connectionState };
  }

  deleteSession(sessionId: string): Promise<void> {
    const previous = this.deletionPromises.get(sessionId);
    if (previous) return previous;
    const operation = this.performDeleteSession(sessionId);
    this.deletionPromises.set(sessionId, operation);
    void operation
      .finally(() => {
        if (this.deletionPromises.get(sessionId) === operation)
          this.deletionPromises.delete(sessionId);
      })
      .catch(() => undefined);
    return operation;
  }

  private async performDeleteSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    this.deletingSessions.add(sessionId);
    try {
      // Close, then delete. Both are lifecycle globals over the session CLI; there
      // is no separate owned-session path any more because this window never hosts
      // a session runtime.
      const outcome = await this.brokerLifecycleDelete(sessionId);
      if (outcome === "recovering") {
        if (session) {
          session.attachment = "recovering";
          this.attachedSessions.delete(sessionId);
          this.stopTailFollower(sessionId);
          this.emitEvent({ type: "session.updated", session: { ...session } });
        }
        return;
      }
      await this.removeSessionArtifacts(sessionId);
      this.removeLocalSession(sessionId, false);
    } catch (error) {
      if (missingSessionError(error) || missingLifecycleSessionError(error)) {
        await this.removeSessionArtifacts(sessionId);
        this.removeLocalSession(sessionId, false);
        return;
      }
      if (liveSessionDeleteError(error)) {
        throw new Error(
          "실행 중인 세션은 삭제할 수 없습니다. 해당 GJC 프로세스를 종료한 뒤 다시 시도하세요.",
        );
      }
      if (lifecycleUncertainError(error) || uncertainLifecycleOutcomeError(error)) {
        if (session) {
          session.attachment = "recovering";
          this.attachedSessions.delete(sessionId);
          this.stopTailFollower(sessionId);
          this.emitEvent({ type: "session.updated", session: { ...session } });
        }
        return;
      }
      throw error;
    } finally {
      this.deletingSessions.delete(sessionId);
    }
  }

  private async brokerLifecycleDelete(
    sessionId: string,
  ): Promise<"deleted" | "recovering"> {
    let closeUncertain = false;
    try {
      await this.brokerLifecycle("session.close", { sessionId });
    } catch (error) {
      if (missingLifecycleSessionError(error) || missingSessionError(error)) {
        // Still issue delete: a saved transcript can exist without a live endpoint.
      } else if (
        lifecycleUncertainError(error) ||
        uncertainLifecycleOutcomeError(error)
      )
        closeUncertain = true;
      else throw error;
    }
    const afterClose = await this.sessionBrokerRow(sessionId);
    if (afterClose === undefined) return "recovering";
    if (afterClose?.live === true) {
      if (closeUncertain) return "recovering";
      throw new Error(
        "실행 중인 세션은 삭제할 수 없습니다. 해당 GJC 프로세스를 종료한 뒤 다시 시도하세요.",
      );
    }
    const cwd =
      afterClose?.repo ?? this.sessionCwds.get(sessionId) ?? this.workspace;
    const sessionPath = await this.locateSharedTranscriptFile(sessionId);
    try {
      await this.brokerLifecycle("session.delete", {
        sessionId,
        cwd,
        ...(afterClose?.stateRoot ? { stateRoot: afterClose.stateRoot } : {}),
        ...(sessionPath ? { sessionPath } : {}),
      });
      return "deleted";
    } catch (error) {
      if (missingLifecycleSessionError(error) || missingSessionError(error))
        return "deleted";
      if (
        lifecycleUncertainError(error) ||
        liveSessionDeleteError(error) ||
        uncertainLifecycleOutcomeError(error)
      ) {
        // The receipt is not proof of either success or failure. Only an absent or
        // tombstoned broker row proves deletion; every other outcome preserves the
        // transcript, artifacts, metadata, and worktree for reconciliation.
        const afterDelete = await this.sessionBrokerRow(sessionId);
        if (afterDelete === null || afterDelete?.deleted === true) return "deleted";
        return "recovering";
      }
      throw error;
    }
  }

  /** `null` means proven absent; `undefined` means the broker index was unavailable. */
  private async sessionBrokerRow(
    sessionId: string,
  ): Promise<SdkSessionRow | null | undefined> {
    const listed = await this.brokerSessions();
    if (!listed) return undefined;
    return listed.find((session) => session.sessionId === sessionId) ?? null;
  }

  private async removeSessionArtifacts(sessionId: string): Promise<void> {
    const ids = this.artifactSessionIds.get(sessionId) ?? new Set<string>();
    const writes = [...ids]
      .map((id) => this.artifactWrites.get(this.artifactWriteKey(sessionId, id)))
      .filter((write): write is Promise<void> => Boolean(write));
    if (writes.length > 0) await Promise.all(writes);
    await rm(
      path.join(this.artifactDirectory, this.artifactNamespace(sessionId)),
      { recursive: true, force: true },
    );
    this.artifactSessionIds.delete(sessionId);
  }

  private artifactNamespace(sessionId: string): string {
    return Buffer.from(sessionId, "utf8").toString("base64url");
  }

  private artifactWriteKey(sessionId: string, artifactId: string): string {
    return `${this.artifactNamespace(sessionId)}\0${artifactId}`;
  }

  private async locateSharedTranscriptFile(
    sessionId: string,
  ): Promise<string | undefined> {
    let filePath = this.sharedSessionFiles.get(sessionId);
    if (filePath) {
      try {
        await access(filePath);
        return filePath;
      } catch {
        this.sharedSessionFiles.delete(sessionId);
      }
    }
    const agentDirectory = path.resolve(
      process.env.GJC_CODING_AGENT_DIR ?? path.join(homedir(), ".gjc/agent"),
    );
    const sessionsDirectory = path.join(agentDirectory, "sessions");
    const suffix = `_${sessionId}.jsonl`;
    try {
      for (const bucket of await readdir(sessionsDirectory, {
        withFileTypes: true,
      })) {
        if (!bucket.isDirectory()) continue;
        const directory = path.join(sessionsDirectory, bucket.name);
        const candidates = (await readdir(directory, { withFileTypes: true }))
          .filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
          .map((entry) => path.join(directory, entry.name));
        if (candidates.length === 0) continue;
        // A re-host writes a new timestamped session file and leaves the older ones
        // in place, so the current generation is the newest match rather than
        // whichever the directory listing happens to return first. Handing GJC a
        // stale file made `session.delete` refuse with an unknown outcome.
        const stamped = await Promise.all(
          candidates.map(async (candidate) => ({
            candidate,
            mtimeMs: (await stat(candidate)).mtimeMs,
          })),
        );
        stamped.sort((left, right) => right.mtimeMs - left.mtimeMs);
        filePath = stamped[0].candidate;
        this.sharedSessionFiles.set(sessionId, filePath);
        return filePath;
      }
    } catch {
      return undefined;
    }
    return undefined;
  }

  private async brokerLifecycle(
    operation: "session.close" | "session.delete",
    input: Record<string, unknown>,
  ): Promise<void> {
    const sessionId =
      typeof input.sessionId === "string" ? input.sessionId : undefined;
    const repo =
      (sessionId ? this.sessionCwds.get(sessionId) : undefined) ??
      this.workspace;
    const cli = await this.requireCli();
    await cli.rawGlobal(operation, input, {
      repo,
      idempotencyKey: `gajae-${operation.replace(".", "-")}-${randomUUID()}`,
    });
  }

  private removeLocalSession(sessionId: string, hide: boolean): void {
    this.stopTailFollower(sessionId);
    this.sessions.delete(sessionId);
    this.sessionCwds.delete(sessionId);
    this.attachedSessions.delete(sessionId);
    this.transcripts.delete(sessionId);
    this.messageKeys.delete(sessionId);
    this.activeAssistantMessages.delete(sessionId);
    this.activeThoughts.delete(sessionId);
    this.activePromptSessions.delete(sessionId);
    this.liveRunningSessions.delete(sessionId);
    this.liveRunningDigests.delete(sessionId);
    this.transcriptRunningSessions.delete(sessionId);
    this.workingPhaseSessions.delete(sessionId);
    this.runtimeIdleSessions.delete(sessionId);
    this.pendingAsyncWorkSessions.delete(sessionId);
    this.asyncJobReconciliations.delete(sessionId);
    this.runRevisions.delete(sessionId);
    this.discoveredRunStates.delete(sessionId);
    this.compactingSessions.delete(sessionId);
    this.compactionRecordBaseline.delete(sessionId);
    this.compactionRecordWatermark.delete(sessionId);
    this.compactionStartedAt.delete(sessionId);
    this.suppressedUserMessageKeys.delete(sessionId);
    this.echoedPromptTexts.delete(sessionId);
    this.locallyAbortedSessions.delete(sessionId);
    this.sessionCommands.delete(sessionId);
    this.sessionAdvertisedCommands.delete(sessionId);
    this.sessionDiscoveredCommands.delete(sessionId);
    this.sessionPlans.delete(sessionId);
    this.sessionTodoSnapshots.delete(sessionId);
    this.todoReads.delete(sessionId);
    this.sessionSdkOperations.delete(sessionId);
    this.sessionConfig.delete(sessionId);
    this.terminalOnlySessions.delete(sessionId);
    this.modelProfiles.delete(sessionId);
    this.explicitSessionThinking.delete(sessionId);
    this.sharedSessionWatchers.get(sessionId)?.close();
    this.sharedSessionWatchers.delete(sessionId);
    this.runStateWatchers.get(sessionId)?.close();
    this.runStateWatchers.delete(sessionId);
    const runStateTimer = this.runStateTimers.get(sessionId);
    if (runStateTimer) clearTimeout(runStateTimer);
    this.runStateTimers.delete(sessionId);
    const refreshTimer = this.sharedSessionRefreshTimers.get(sessionId);
    if (refreshTimer) clearTimeout(refreshTimer);
    this.sharedSessionRefreshTimers.delete(sessionId);
    this.cancelPermissionsForSession(sessionId);
    if (hide) this.sessionMetadata?.hideSession?.(sessionId);
    else this.sessionMetadata?.deleteAlias?.(sessionId);
    // Removing a row changes what the next scan should produce even though the
    // broker's live set is untouched, so the reuse fingerprint is invalidated.
    this.lastLiveFingerprint = undefined;
    this.lastDiscovered = this.lastDiscovered.filter(
      (session) => session.id !== sessionId,
    );
    this.emitEvent({ type: "session.deleted", sessionId });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const pending of this.pendingPermissions.values()) {
      pending.resolve({ outcome: { outcome: "cancelled" } });
    }
    this.pendingPermissions.clear();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    // No agent process is owned here, so disposal never kills a running session.
    for (const controller of this.tailControllers.values()) controller.abort();
    this.tailControllers.clear();
    this.cli = undefined;
    this.startup = undefined;
    this.permissionModeApplied.clear();
    this.tailReads.clear();
    this.tailCheckpoints.clear();
    this.sessions.clear();
    this.sessionCwds.clear();
    this.attachedSessions.clear();
    // Only a successful attach removes a session's throttle stamp, so sessions that
    // never attach -- terminal-only rows, dead endpoints -- held one for the life of
    // the process while every other map here was already being cleared.
    this.attachAttempts.clear();
    // Each entry holds a transcript's parsed envelopes, measured at 6.3MB apiece.
    this.sharedTranscriptReads.clear();
    this.sharedSessionFiles.clear();
    this.sessionParents.clear();
    this.transcripts.clear();
    this.messageKeys.clear();
    this.activeAssistantMessages.clear();
    this.activeThoughts.clear();
    this.activePromptSessions.clear();
    this.liveRunningSessions.clear();
    this.liveRunningDigests.clear();
    this.transcriptRunningSessions.clear();
    this.workingPhaseSessions.clear();
    this.runtimeIdleSessions.clear();
    this.pendingAsyncWorkSessions.clear();
    this.asyncJobReconciliations.clear();
    this.runRevisions.clear();
    this.discoveredRunStates.clear();
    this.compactingSessions.clear();
    this.compactionRecordBaseline.clear();
    this.compactionRecordWatermark.clear();
    this.compactionStartedAt.clear();
    this.suppressedUserMessageKeys.clear();
    this.echoedPromptTexts.clear();
    this.sessionCommands.clear();
    this.sessionAdvertisedCommands.clear();
    this.sessionDiscoveredCommands.clear();
    this.sessionPlans.clear();
    this.sessionTodoSnapshots.clear();
    this.todoReads.clear();
    this.sessionSdkOperations.clear();
    this.sessionConfig.clear();
    this.terminalOnlySessions.clear();
    this.modelProfiles.clear();
    this.explicitSessionThinking.clear();
    this.artifactWrites.clear();
    this.artifactSessionIds.clear();
    this.deletingSessions.clear();
    this.deletionPromises.clear();
    // In-flight bookkeeping. Each entry is normally removed in a `finally`, so what
    // is left here is whatever a rejected or abandoned call did not reach. Teardown
    // claims to release everything, so it has to include these too.
    this.cancellingSessions.clear();
    this.cancellationPromises.clear();
    this.flushingSessions.clear();
    this.pendingSteers.clear();
    this.locallyAbortedSessions.clear();
    this.imageDataUrls.clear();
    this.contextUsageQueries.clear();
    for (const watcher of this.sharedSessionWatchers.values()) watcher.close();
    for (const watcher of this.runStateWatchers.values()) watcher.close();
    this.runStateWatchers.clear();
    for (const timer of this.runStateTimers.values()) clearTimeout(timer);
    this.runStateTimers.clear();
    for (const timer of this.sharedSessionRefreshTimers.values())
      clearTimeout(timer);
    this.sharedSessionWatchers.clear();
    this.sharedSessionRefreshTimers.clear();
  }

  private async ensureStarted(): Promise<void> {
    if (this.cli) return;
    if (this.startup) return this.startup;
    if (this.disposed) throw new Error("GJC controller is disposed");

    this.startup = this.start().finally(() => {
      this.startup = undefined;
    });
    return this.startup;
  }

  /**
   * Prepares the CLI client.
   *
   * There is nothing to connect to: the broker is started on demand by the CLI
   * itself, and every operation is its own process. "Ready" therefore means the
   * executable resolves and the broker answers a session list -- proof the app can
   * actually reach the runtime, without holding anything open. A runtime crash or
   * upgrade can no longer take the window's connection down with it, because there
   * is no connection to lose.
   */
  private async start(): Promise<void> {
    const generation = ++this.generation;
    this.setConnection({
      state: "connecting",
      backend: "gjc",
      label: "GJC",
      detail: "Reaching the GJC broker",
      workspace: this.workspace,
      modelPreset: this.modelPreset,
    });
    const executable = await this.resolveExecutable();
    let profileThinking: string | undefined;
    try {
      const modelsFile = path.join(
        path.resolve(
          process.env.GJC_CODING_AGENT_DIR ??
            path.join(homedir(), ".gjc/agent"),
        ),
        "models.yml",
      );
      profileThinking = configuredProfileDefaultThinking(
        await readFile(modelsFile, "utf8"),
        this.modelPreset,
      );
    } catch {
      /* built-in profiles resolve their own defaults */
    }
    this.modelPresetThinking = profileThinking;
    const cli = new GjcSdkCli({
      executable,
      repo: this.workspace,
      env: runtimeEnvironment(),
      timeoutMs: STARTUP_TIMEOUT_MS,
    });
    // The broker index doubles as the reachability check: it fails closed with a
    // typed operational error when the broker cannot be started at all.
    await cli.listSessions();
    if (generation !== this.generation || this.disposed) return;
    this.cli = cli;
    this.permissionModeApplied.clear();
    this.setConnection({
      state: "connected",
      backend: "gjc",
      label: "GJC",
      detail: `SDK session CLI · ${this.modelPreset}`,
      workspace: this.workspace,
      modelPreset: this.modelPreset,
      generation,
    });
    this.reconnectAttempt = 0;
    queueMicrotask(() => {
      void this.recoverOwnedSessions();
    });
  }

  /**
   * The CLI client, starting it if this is the first use.
   *
   * Replaces the old `requireConnection`: there is no liveness to check because no
   * process is held between calls.
   */
  private async requireCli(): Promise<GjcSdkCli> {
    await this.ensureStarted();
    if (!this.cli) throw new Error("GJC SDK session CLI is unavailable");
    return this.cli;
  }

  /** The workspace a session's CLI calls must resolve against. */
  private repoFor(sessionId: string): string {
    return this.sessionCwds.get(sessionId) ?? this.workspace;
  }

  /**
   * Applies the configured permission handling to a session.
   *
   * The old permission environment variable applied only to the removed child
   * protocol process. A broker-hosted session host instead keeps a per-session SDK
   * permission mode, set through the `permission_mode.set` control operation and
   * defaulting to `allow`.
   *
   * Fail-closed note: the host has no reverse channel to ask an external
   * controller for a decision (`permission.request` is a host-to-client operation
   * the session CLI cannot carry). A session left in `prompt` mode therefore
   * *rejects* tool calls with "no permission provider is connected" rather than
   * prompting anyone. So `prompt` and `deny` are both mapped to the host's `deny`,
   * which refuses the tool call with a decision the transcript records, instead of
   * silently granting what the user did not approve. `always-allow` maps to
   * `allow`. If GJC ever gains a way to answer a permission request from an
   * external controller, `prompt` should move to it rather than to `deny`.
   */
  private async applyPermissionMode(sessionId: string): Promise<void> {
    if (this.permissionModeApplied.has(sessionId)) return;
    const mode =
      this.permissionHandling === "always-allow" ||
      this.permissionHandling === "auto"
        ? "always-allow"
        : "deny";
    const cli = await this.requireCli();
    await cli.rawControl(
      sessionId,
      "permission_mode.set",
      { mode },
      { repo: this.repoFor(sessionId) },
    );
    this.permissionModeApplied.add(sessionId);
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer) return;
    const delay = Math.min(
      30_000,
      500 * 2 ** Math.min(this.reconnectAttempt, 6),
    );
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.ensureStarted()
        .then(() => this.recoverOwnedSessions())
        .catch(() => this.scheduleReconnect());
    }, delay);
  }

  private async recoverOwnedSessions(): Promise<void> {
    if (!this.cli) return;
    for (const session of this.sessions.values()) {
      if (
        session.ownership !== "gajae" ||
        this.attachedSessions.has(session.id)
      )
        continue;
      const cwd = this.sessionCwds.get(session.id);
      if (!cwd) continue;
      try {
        await this.ensureAttached(session.id, false);
        session.attachment = "attached";
        // Re-attaching says this window can talk to the session again, not that its
        // turn ended. Another process may have kept working through the disconnect,
        // so the transcript decides; `idle` is only the answer when it has none.
        session.status = (await this.discoveredRunState(session.id)) ?? "idle";
        session.unread = true;
        this.sessionMetadata?.setUnread(session.id, true);
        this.emitEvent({ type: "session.updated", session: { ...session } });
        this.emitEvent({
          type: "session.activity",
          sessionId: session.id,
          title: session.title,
          unread: true,
          category: "recovered",
        });
      } catch {
        session.attachment = "recovering";
        session.status = "failed";
        this.emitEvent({ type: "session.updated", session: { ...session } });
      }
    }
  }

  private async resolveExecutable(): Promise<string> {
    // Resolve the same GJC the user's shell resolves. A fixed preference list
    // silently disagreed with PATH: `~/.bun/bin` was checked before
    // `~/.local/bin`, so the app ran an older install than the terminal did
    // (0.15.2 against 0.15.3) and an upgrade to the PATH-visible one changed
    // nothing here. An explicit setting or GJC_BIN still wins.
    const candidates = [
      this.configuredExecutable,
      process.env.GJC_BIN,
      ...gjcPathCandidates(),
    ].filter((candidate): candidate is string => Boolean(candidate));
    for (const candidate of candidates) {
      try {
        await access(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Try the next installation path.
      }
    }
    return "gjc";
  }

  /**
   * Past sessions on disk, newest first.
   *
   * Discovery only lists sessions the broker still reports as live, so everything
   * else is unreachable from the window even though `gjc --resume <id>` opens it
   * fine. The session files are the authority on what exists.
   */
  async listHistorySessions(): Promise<HistorySession[]> {
    const agentDirectory = path.resolve(
      process.env.GJC_CODING_AGENT_DIR ?? path.join(homedir(), ".gjc/agent"),
    );
    const sessionsDirectory = path.join(agentDirectory, "sessions");
    // Liveness is decoration here; the files still list fine without it.
    const liveIds = new Set(
      ((await this.brokerSessions()) ?? [])
        .filter((session) => session.live)
        .map((session) => session.sessionId),
    );
    const files: Array<{ path: string; id: string; modified: number }> = [];
    try {
      for (const bucket of await readdir(sessionsDirectory, {
        withFileTypes: true,
      })) {
        if (!bucket.isDirectory()) continue;
        const directory = path.join(sessionsDirectory, bucket.name);
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
          const id = entry.name.slice(0, -".jsonl".length).split("_").at(-1);
          if (!id) continue;
          const filePath = path.join(directory, entry.name);
          try {
            const info = await stat(filePath);
            // A huge transcript is still listed, but its summary is read from a
            // bounded head rather than the whole file.
            files.push({ path: filePath, id, modified: info.mtimeMs });
          } catch {
            /* the file went away between listing and reading */
          }
        }
      }
    } catch {
      return [];
    }
    files.sort((left, right) => right.modified - left.modified);
    const sessions: HistorySession[] = [];
    for (const file of files.slice(0, HISTORY_SESSION_LIMIT)) {
      let headLines: string[];
      let summary: ReturnType<typeof historySessionSummary>;
      try {
        headLines = await transcriptHeadLines(file.path);
        summary = historySessionSummary(headLines);
      } catch {
        continue;
      }
      if (!summary) continue;
      const workspace = summary.cwd ?? "";
      sessions.push({
        id: file.id,
        title: summary.title ?? readableSessionTitle(file.id, undefined),
        workspace,
        updatedAt: recentLabel(new Date(file.modified).toISOString()),
        messageCount: summary.messageCount,
        live: liveIds.has(file.id),
        // The same envelope line the summary already reads, so a fork is marked by
        // having been read rather than by a second pass over the file.
        parentId: parentSessionOf(headLines[0], file.id),
      });
    }
    return sessions;
  }

  /**
   * Open a past session as a row in this window, the way `gjc --resume <id>` does
   * in a terminal. A session already listed is simply re-attached.
   */
  async openHistorySession(sessionId: string): Promise<AgentSession> {
    if (this.sessions.has(sessionId)) return this.resumeSession(sessionId);
    const filePath = await this.locateSharedTranscriptFile(sessionId);
    if (!filePath)
      throw new Error(`세션 기록을 찾지 못했습니다: ${sessionId}`);
    let cwd: string | undefined;
    try {
      const text = await readFile(filePath, "utf8");
      cwd = historySessionSummary(text.split("\n"))?.cwd;
    } catch {
      /* the workspace falls back below */
    }
    const workspace = cwd ?? this.workspace;
    const session: AgentSession = {
      id: sessionId,
      title: readableSessionTitle(sessionId, undefined),
      subtitle: path.basename(workspace) || workspace,
      workspace,
      runtime: "gjc",
      status: "idle",
      updatedAt: "now",
      updatedAtMs: Date.now(),
      pinned: false,
      unread: false,
      accent: GJC_ACCENT,
      ownership: "gajae",
      attachment: "recovering",
    };
    this.sessions.set(sessionId, session);
    this.sessionCwds.set(sessionId, workspace);
    this.sessionMetadata?.setWorkspace(sessionId, workspace);
    this.sessionMetadata?.setOwnership(sessionId, "gajae");
    this.emitEvent({ type: "session.created", session: { ...session } });
    try {
      return await this.resumeSession(sessionId);
    } catch (error) {
      // The row stays so its transcript remains readable, which is what the
      // persisted file supports even when the agent refuses to attach.
      const items = await this.getTranscript(sessionId).catch(() => []);
      this.emitEvent({
        type: "transcript.synced",
        sessionId,
        items: items.map(cloneTranscriptItem),
      });
      throw error;
    }
  }

  /**
   * Re-attach a session this window lost control of.
   *
   * A session goes `terminal-only` when a terminal held the lease, and
   * `recovering` when a reconnect could not resume it. Both states are dead ends
   * in the window: the transcript is readable but nothing can be sent. Attaching
   * again is the only recovery, and it has to be user-driven because the lease
   * may still be held -- retrying on a timer would just fail repeatedly.
   */
  async resumeSession(sessionId: string): Promise<AgentSession> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown GJC session: ${sessionId}`);
    // The refusal that produced terminal-only is not permanent, so the flag is
    // cleared before retrying or ensureAttached would be skipped entirely.
    this.terminalOnlySessions.delete(sessionId);
    this.stopTailFollower(sessionId);
    this.attachedSessions.delete(sessionId);
    this.attachAttempts.delete(sessionId);
    try {
      await this.ensureAttached(sessionId, true);
      await this.refreshSessionSettings(sessionId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/no current Router attachment|provider_lease_conflict/iu.test(message)) {
        this.terminalOnlySessions.add(sessionId);
        session.attachment = "terminal-only";
        session.ownership = "external";
        this.emitEvent({ type: "session.updated", session: { ...session } });
        throw new Error(
          "다른 터미널이 이 세션을 잡고 있어 이어서 진행할 수 없습니다. 해당 GJC를 종료한 뒤 다시 시도하세요.",
        );
      }
      // A lifecycle receipt is evidence that the attach was recorded, not whether
      // it happened. The transcript is read from the session file either way, so
      // an unverifiable receipt leaves the session readable instead of failing
      // the resume outright -- it only means live control is not guaranteed.
      if (!lifecycleUncertainError(error)) throw error;
      this.attachedSessions.delete(sessionId);
      session.attachment = "recovering";
      this.emitEvent({ type: "session.updated", session: { ...session } });
    }
    const resumed = this.sessions.get(sessionId);
    if (!resumed) throw new Error(`Unknown GJC session: ${sessionId}`);
    // The transcript is republished so the window shows the history the resumed
    // session actually has, not the read-only snapshot it was left with.
    const items = await this.getTranscript(sessionId);
    this.emitEvent({
      type: "transcript.synced",
      sessionId,
      items: items.map(cloneTranscriptItem),
    });
    return { ...resumed };
  }

  /**
   * Makes a session controllable from this window.
   *
   * An SDK session that is already live needs no attach: the broker routes control
   * to its host and this window is just another client. Only a session with no live
   * endpoint is resumed, which is what re-hosts it. `replay` reloads the transcript
   * from the session file rather than asking a connection to stream it back.
   */
  private async ensureAttached(
    sessionId: string,
    replay: boolean,
  ): Promise<void> {
    if (this.attachedSessions.has(sessionId)) return;
    const cli = await this.requireCli();
    const cwd = this.repoFor(sessionId);
    if (replay) {
      this.installTranscript(sessionId, []);
      this.messageKeys.set(sessionId, new Map());
    }
    const row = await cli.inspectSession(sessionId, { repo: cwd });
    if (row?.deleted)
      throw new SdkCliError(
        "session_deleted",
        `Session ${sessionId} was deleted.`,
      );
    // A live terminal host can serve several clients. Probe its public route;
    // generation zero is not proof of an exclusive terminal lease.
    if (row?.live === true)
      await cli.queryItems(sessionId, "session.metadata", {}, { repo: cwd });
    let rehosted = false;
    if (!row?.live) {
      // Resume re-hosts a session whose endpoint is gone. `sessionPath` is passed
      // when known so the host adopts this exact transcript rather than resolving a
      // same-id file elsewhere.
      const sessionPath = await this.locateSharedTranscriptFile(sessionId);
      await cli.rawGlobal(
        "session.resume",
        {
          sessionId,
          cwd,
          ...(sessionPath ? { sessionPath } : {}),
          modelPreset: this.modelPreset,
        },
        { repo: cwd },
      );
      rehosted = true;
      // The re-host writes a new timestamped session file. Drop the path this window
      // cached, or the next lifecycle call (delete especially) hands GJC the previous
      // generation's file and the operation comes back with an unknown outcome.
      this.sharedSessionFiles.delete(sessionId);
    }
    // Only a session this window hosts may have its permission handling applied.
    // A session already live in another host belongs to that host, and rewriting its
    // policy changes how *that* agent runs tools: the desktop smoke attached to a
    // live session to read its model profiles, set the app's fail-closed `deny`, and
    // left the session rejecting every tool call afterwards. Reading a session is not
    // authority over it.
    const owned = rehosted || this.sessions.get(sessionId)?.ownership === "gajae";
    if (owned) await this.applyPermissionMode(sessionId);
    await this.refreshSessionConfigOptions(sessionId);
    await this.refreshModelProfiles(sessionId);
    if (replay) {
      const restored = await this.readSharedTranscript(sessionId).catch(() => []);
      if (restored.length > 0) this.installTranscript(sessionId, restored);
      this.finalizeAllMessages(sessionId);
    }
    this.attachedSessions.add(sessionId);
    this.terminalOnlySessions.delete(sessionId);
    this.startTailFollower(sessionId);
    // Command discovery must not wait for GJC to publish a bootstrap update: a
    // session opened in an already-running process never re-sends one, and the tail
    // frame that carried it may be long past. Ask the runtime directly.
    void this.refreshSdkCommands(sessionId);
    // The session file is the live account now that no connection streams updates.
    const watched = await this.locateSharedTranscriptFile(sessionId);
    if (watched) this.watchSharedTranscript(sessionId, watched);
    const session = this.sessions.get(sessionId);
    if (session) {
      session.attachment = "attached";
      // A successful attach clears the failure this window recorded, but it does not
      // observe the turn. Opening a session someone else is driving must not report
      // that work as finished, so the transcript answers and `idle` is the fallback.
      if (session.status === "failed")
        session.status = (await this.discoveredRunState(sessionId)) ?? "idle";
      this.emitEvent({ type: "session.updated", session: { ...session } });
    }
    void this.refreshContextUsage(sessionId);
  }

  /**
   * Starts the bounded `sdk session tail --all-events` catch-up loop.
   *
   * In gjc/0.18.11 tail is a batch command, not NDJSON: it returns one JSON envelope
   * when an observed turn becomes idle or the wait window elapses, and an elapsed
   * window reports `terminal:false` with the frames it had collected. The session-file
   * watcher stays the durable transcript account; this loop is supplemental
   * lifecycle evidence. Each invocation is short-lived, resumes from the last
   * checkpoint claim, and is abortable so detach, close, delete, and app shutdown
   * cannot leak a `gjc` reader process.
   */
  private startTailFollower(sessionId: string): void {
    if (
      this.disposed ||
      this.tailReads.has(sessionId) ||
      !this.attachedSessions.has(sessionId)
    )
      return;
    const abortController = new AbortController();
    this.tailControllers.set(sessionId, abortController);
    const follow = this.followSessionTail(sessionId, abortController).finally(
      () => {
        if (this.tailReads.get(sessionId) === follow)
          this.tailReads.delete(sessionId);
        if (this.tailControllers.get(sessionId) === abortController)
          this.tailControllers.delete(sessionId);
      },
    );
    this.tailReads.set(sessionId, follow);
    void follow.catch(() => undefined);
  }

  private stopTailFollower(sessionId: string): void {
    this.tailControllers.get(sessionId)?.abort();
    this.tailControllers.delete(sessionId);
    // Ownership of the slot ends synchronously. The old promise's `finally`
    // checks identity before cleanup, so it cannot remove a replacement follower.
    this.tailReads.delete(sessionId);
    this.tailCheckpoints.delete(sessionId);
  }

  private async followSessionTail(
    sessionId: string,
    controller: AbortController,
  ): Promise<void> {
    while (
      !this.disposed &&
      !controller.signal.aborted &&
      this.attachedSessions.has(sessionId)
    ) {
      try {
        const cli = await this.requireCli();
        const tail = await cli.tail(sessionId, {
          repo: this.repoFor(sessionId),
          ...(this.tailCheckpoints.get(sessionId)
            ? { cursor: this.tailCheckpoints.get(sessionId) }
            : {}),
          untilIdle: true,
          timeoutMs: 8_000,
          signal: controller.signal,
        });
        if (tail.gap) {
          this.tailCheckpoints.delete(sessionId);
          await this.refreshTranscriptFromFile(sessionId);
          continue;
        }
        if (tail.checkpointToken)
          this.tailCheckpoints.set(sessionId, tail.checkpointToken);
        this.projectTailItems(sessionId, tail.items);
        if (tail.source === "offline") return;
      } catch (error) {
        if (controller.signal.aborted || this.disposed) return;
        if (error instanceof SdkCliError) {
          if (error.code === "aborted") return;
          // A timeout means only that no terminal turn event arrived inside this
          // bounded window. It is not a failed run and never clears the spinner.
          if (error.code === "tail_timeout") continue;
          if (error.code === "retention_gap") {
            this.tailCheckpoints.delete(sessionId);
            await this.refreshTranscriptFromFile(sessionId);
            continue;
          }
          if (
            error.code === "session_deleted" ||
            error.code === "session_unavailable"
          )
            return;
        }
        // A transient broker failure should not spin. The next user-driven attach
        // or discovery pass restarts the follower.
        return;
      }
    }
  }

  private projectTailItems(
    sessionId: string,
    items: Array<{ kind: string; payload: unknown }>,
  ): void {
    let transcriptEvidence = false;
    for (const item of items) {
      const payload =
        item.payload &&
        typeof item.payload === "object" &&
        !Array.isArray(item.payload)
          ? (item.payload as Record<string, unknown>)
          : undefined;
      const directUpdate = payload?.sessionUpdate;
      const nested =
        payload?.update &&
        typeof payload.update === "object" &&
        !Array.isArray(payload.update)
          ? (payload.update as Record<string, unknown>)
          : undefined;
      if (typeof directUpdate === "string")
        this.handleSessionUpdate({
          sessionId,
          update: payload as unknown as SessionUpdate,
        });
      else if (typeof nested?.sessionUpdate === "string")
        this.handleSessionUpdate({
          sessionId,
          update: nested as unknown as SessionUpdate,
        });
      if (item.kind === "transcript") transcriptEvidence = true;
      if (item.kind === "turn_start" || item.kind === "agent_start")
        this.updateSessionStatus(sessionId, "running");
      if (item.kind === "agent_failed")
        this.updateSessionStatus(sessionId, "failed", { announce: false });
      if (item.kind === "turn_end" || item.kind === "agent_end")
        void this.reconcileTailTerminalState(sessionId);
      if (item.kind === "session_closed" || item.kind === "session_terminated")
        this.stopTailFollower(sessionId);
    }
    if (transcriptEvidence) void this.refreshTranscriptFromFile(sessionId);
  }

  private async refreshTranscriptFromFile(sessionId: string): Promise<void> {
    const previous = this.transcripts.get(sessionId);
    const items = await this.readPersistedTranscript(sessionId).catch(
      () => undefined,
    );
    if (!items || this.disposed) return;
    const installed = this.installTranscript(sessionId, items);
    this.publishTranscriptSync(sessionId, previous, installed);
  }

  private async reconcileTailTerminalState(sessionId: string): Promise<void> {
    const state = await this.discoveredRunState(sessionId);
    if (state !== "running") this.updateSessionStatus(sessionId, "idle");
  }

  /**
   * Projects one session update into the transcript.
   *
   * These come from `gjc sdk session tail` frames and from rows read
   * out of the session file, both of which carry the same shapes. Keeping this
   * switch as the single projection point is what lets the renderer stay unchanged.
   */
  private handleSessionUpdate(notification: SessionNotification): void {
    const { sessionId, update } = notification;
    switch (update.sessionUpdate) {
      case "user_message_chunk":
        this.projectMessageChunk(sessionId, "user", update);
        break;
      case "agent_message_chunk":
        this.finalizeThought(sessionId);
        this.projectMessageChunk(sessionId, "assistant", update);
        break;
      case "agent_thought_chunk":
        this.projectThoughtChunk(sessionId, update);
        break;
      case "tool_call":
        this.finalizeThought(sessionId);
        this.upsertTool(sessionId, update);
        break;
      case "tool_call_update":
        this.upsertTool(sessionId, update);
        break;
      case "session_info_update":
        this.patchSessionInfo(sessionId, update);
        break;
      case "plan":
        this.upsertPlan(sessionId, update.entries);
        break;
      case "available_commands_update": {
        // GJC's own command list for this session. An empty update is authoritative
        // too -- it says the session has no dynamic commands, so the synthesized
        // skill entries must not be merged back over it.
        void this.refreshSdkCommands(
          sessionId,
          agentCommands(update.availableCommands),
        );
        break;
      }
      case "config_option_update":
        this.captureSessionState(sessionId, update.configOptions);
        if (this.attachedSessions.has(sessionId))
          void this.refreshModelProfiles(sessionId);
        break;
      case "current_mode_update":
        this.patchSessionRuntime(sessionId, { mode: update.currentModeId });
        break;
      case "usage_update":
        if (update.size > 0)
          this.patchSessionRuntime(sessionId, {
            usagePercent: Math.min(
              100,
              Math.max(0, (update.used / update.size) * 100),
            ),
            usagePending: false,
          });
        break;
      default:
        break;
    }
  }

  private projectThoughtChunk(
    sessionId: string,
    update: Extract<SessionUpdate, { sessionUpdate: "agent_thought_chunk" }>,
  ): void {
    const text = textFromContent(update.content);
    if (!text) return;
    const existingId = this.activeThoughts.get(sessionId);
    if (existingId) {
      const thought = (this.transcripts.get(sessionId) ?? []).find(
        (item): item is ThoughtActivity =>
          item.kind === "thought" && item.id === existingId,
      );
      if (!thought) return;
      thought.content += text;
      this.emitEvent({
        type: "thought.delta",
        sessionId,
        thoughtId: thought.id,
        delta: text,
        streaming: true,
      });
      return;
    }
    const thought: ThoughtActivity = {
      id: update.messageId
        ? `gjc-thought-${update.messageId}`
        : `gjc-thought-${this.nextLocalId++}`,
      kind: "thought",
      sessionId,
      content: text,
      createdAt: nowLabel(),
      streaming: true,
    };
    this.activeThoughts.set(sessionId, thought.id);
    this.appendTranscript(thought);
  }

  private finalizeThought(sessionId: string): void {
    const thoughtId = this.activeThoughts.get(sessionId);
    if (!thoughtId) return;
    const thought = (this.transcripts.get(sessionId) ?? []).find(
      (item): item is ThoughtActivity =>
        item.kind === "thought" && item.id === thoughtId,
    );
    if (thought) {
      thought.streaming = false;
      this.emitEvent({
        type: "thought.delta",
        sessionId,
        thoughtId,
        delta: "",
        streaming: false,
      });
    }
    this.activeThoughts.delete(sessionId);
  }

  private upsertPlan(
    sessionId: string,
    entries: Extract<SessionUpdate, { sessionUpdate: "plan" }>["entries"],
  ): void {
    const items = this.transcripts.get(sessionId) ?? [];
    const existing = items.find(
      (item): item is PlanActivity => item.kind === "plan",
    );
    const plan: PlanActivity = {
      id: existing?.id ?? `gjc-plan-${this.nextLocalId++}`,
      kind: "plan",
      sessionId,
      entries: entries.map((entry) => ({
        content: entry.content,
        status:
          entry.status === "in_progress" || entry.status === "completed"
            ? entry.status
            : "pending",
      })),
      createdAt: existing?.createdAt ?? nowLabel(),
    };
    if (existing) Object.assign(existing, plan);
    else this.appendTranscript(plan);
    // The row the session actually carries is the retained one, so a later durable
    // rebuild composes the same plan state instead of an earlier copy of it. An
    // update with no entries is still an update: it clears them.
    this.sessionPlans.set(sessionId, existing ?? plan);
    this.emitEvent({
      type: "plan.updated",
      plan: { ...plan, entries: plan.entries.map((entry) => ({ ...entry })) },
    });
  }

  /**
   * Install a transcript read as this session's account, keeping what only this
   * process observed.
   *
   * A durable read is authoritative over recorded rows, but it cannot speak for a
   * live plan or for a todo snapshot this window queried, and both were being
   * deleted by the replacement. The retained rows are appended in a fixed order so
   * every rebuild of the same views the same sequence.
   */
  private installTranscript(
    sessionId: string,
    items: TranscriptItem[],
  ): TranscriptItem[] {
    const retained: TranscriptItem[] = [];
    const plan = this.sessionPlans.get(sessionId);
    if (plan) retained.push(plan);
    const todo = this.sessionTodoSnapshots.get(sessionId)?.row;
    if (todo) retained.push(todo);
    const missing = retained.filter(
      (row) => !items.some((item) => item.id === row.id),
    );
    const composed = missing.length > 0 ? [...items, ...missing] : items;
    this.transcripts.set(sessionId, composed);
    return composed;
  }

  /**
   * Read the runtime's todo store and publish it as one transcript row.
   *
   * `todo.list` is the only todo source this window has: the tail protocol carries
   * no todo event and the returned records have no documented schema beyond rows
   * that may be wrapped in `tasks`. They are therefore retained and shown as data
   * rather than reduced into task state this window would have to invent, and the
   * query is strict -- a runtime that cannot answer is recorded as unreadable,
   * which is not the same thing as an empty list.
   */
  private async readTodoRecords(
    sessionId: string,
  ): Promise<unknown[] | undefined> {
    const pending = this.todoReads.get(sessionId);
    if (pending) return pending;
    const read = this.queryTodoRecords(sessionId);
    this.todoReads.set(sessionId, read);
    try {
      return await read;
    } finally {
      if (this.todoReads.get(sessionId) === read) this.todoReads.delete(sessionId);
    }
  }

  private async queryTodoRecords(
    sessionId: string,
  ): Promise<unknown[] | undefined> {
    const observedAt = nowLabel();
    let rows: unknown[] | undefined;
    let failure: string | undefined;
    try {
      rows = await this.querySessionItems(
        sessionId,
        "todo.list",
        {},
        { strict: true },
      );
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    // A session this controller no longer holds must not have its row resurrected
    // by a read that was already in flight when the session was removed.
    if (this.disposed || !this.sessions.has(sessionId)) return undefined;
    if (rows === undefined)
      this.publishTodoSnapshot(sessionId, { error: failure, observedAt });
    else this.publishTodoSnapshot(sessionId, { rows, observedAt });
    return rows;
  }

  /**
   * Record what the todo store held, or that it could not be read.
   *
   * A failed read keeps the last successful snapshot on screen and says it is
   * stale; with no earlier success it says the store is unavailable. Neither case
   * may render as an empty list.
   */
  private publishTodoSnapshot(
    sessionId: string,
    observed:
      | { rows: unknown[]; observedAt: string }
      | { error: string | undefined; observedAt: string },
  ): void {
    const previous = this.sessionTodoSnapshots.get(sessionId);
    const header = ["- source: todo.list (strict read)"];
    let rows = previous?.rows;
    let json = previous?.json;
    let observedAt = previous?.observedAt;
    if ("rows" in observed) {
      rows = observed.rows;
      observedAt = observed.observedAt;
      json = boundedJson(observed.rows) ?? "[]";
      header.push(
        `- observed: ${observed.observedAt}`,
        `- records: ${observed.rows.length}`,
      );
    } else if (json !== undefined) {
      header.push(
        `- last success: ${observedAt ?? "unknown"}`,
        `- read failed: ${todoQueryErrorText(observed.error)}`,
        "- state: showing the last successful snapshot (stale)",
      );
    } else {
      header.push(
        `- observed: ${observed.observedAt}`,
        `- read failed: ${todoQueryErrorText(observed.error)}`,
        "- state: the todo store could not be read (this is not an empty list)",
      );
    }
    const row: SystemNoticeActivity = {
      id: todoSnapshotRowId(sessionId),
      kind: "system",
      sessionId,
      title: "Todos",
      content: [
        ...header,
        ...(json === undefined ? [] : ["```json", json, "```"]),
      ].join("\n"),
      createdAt: previous?.row.createdAt ?? nowLabel(),
      sourceType: "todo.list",
      // Phases are attached only when the store answered: a row without them falls
      // back to the text card that already says the snapshot is stale or unreadable,
      // because a checklist drawn from an older read would claim it is current.
      ...("rows" in observed
        ? {
            todoPhases: todoSnapshotPhases(observed.rows),
            observedAt: observed.observedAt,
          }
        : {}),
    };
    this.sessionTodoSnapshots.set(sessionId, {
      row,
      ...(rows === undefined ? {} : { rows }),
      ...(json === undefined ? {} : { json }),
      ...(observedAt === undefined ? {} : { observedAt }),
    });
    this.publishAppRow(sessionId, row);
  }

  /**
   * Put an app-owned row into a session's transcript.
   *
   * A row that has not changed is not republished: the goal panel and a transcript
   * bootstrap both read the same store, and each read would otherwise emit an IPC
   * row with identical content. A session with no installed transcript keeps the row
   * in its snapshot state, and the next install composes it in.
   */
  private publishAppRow(sessionId: string, row: SystemNoticeActivity): void {
    const items = this.transcripts.get(sessionId);
    if (items) {
      const index = items.findIndex((item) => item.id === row.id);
      const existing = index >= 0 ? items[index] : undefined;
      if (existing && sameTranscriptItem(existing, row)) return;
      if (index >= 0) items[index] = row;
      else items.push(row);
    }
    this.emitEvent({
      type: "transcript.appended",
      item: cloneTranscriptItem(row),
    });
  }

  private captureSessionState(
    sessionId: string,
    options: SessionConfigOption[],
    mode?: string | null,
  ): void {
    const normalized = agentConfigOptions(options);
    const discoveredProfiles = this.modelProfiles.get(sessionId);
    const modelOption = normalized.find(
      (option) => option.category === "model" || option.id === "model",
    );
    const selectedPreset =
      typeof modelOption?.currentValue === "string"
        ? modelOption.currentValue.replace(/^gajae-code\//u, "")
        : undefined;
    const thinkingOption = normalized.find(
      (option) =>
        option.category === "thought_level" || option.id === "thinking",
    );
    if (
      thinkingOption &&
      selectedPreset === this.modelPreset &&
      this.modelPresetThinking
    ) {
      thinkingOption.currentValue =
        this.explicitSessionThinking.get(sessionId) ?? this.modelPresetThinking;
    }
    if (modelOption && discoveredProfiles?.length)
      modelOption.options = discoveredProfiles;
    this.sessionConfig.set(sessionId, normalized);
    this.emitEvent({ type: "session.config", sessionId, options: normalized });
    const model = normalized.find(
      (option) => option.category === "model" || option.id === "model",
    );
    const thinking = normalized.find(
      (option) =>
        option.category === "thought_level" || option.id === "thinking",
    );
    const modelValue =
      typeof model?.currentValue === "string" ? model.currentValue : undefined;
    const currentSession = this.sessions.get(sessionId);
    const modelChanged =
      modelValue !== undefined && currentSession?.model !== modelValue;
    this.patchSessionRuntime(sessionId, {
      ...(mode ? { mode } : {}),
      ...(modelValue !== undefined ? { model: modelValue } : {}),
      ...(modelChanged ? { modelDisplay: undefined } : {}),
      ...(typeof thinking?.currentValue === "string"
        ? { thinking: thinking.currentValue }
        : {}),
    });
  }

  /**
   * Builds this session's config options from the session-scoped SDK config.
   *
   * The model/thinking selectors behind `/model` and Shift+Tab read these values.
   * The
   * session's own `config.list/get` is the authoritative source, and it answers the
   * session's real preset rather than a process-wide launch flag.
   */
  private async refreshSessionConfigOptions(sessionId: string): Promise<void> {
    const row = await this.sessionConfigRow(sessionId);
    if (!row) return;
    const preset =
      typeof row.modelPreset === "string" && row.modelPreset
        ? row.modelPreset
        : undefined;
    const thinking =
      typeof row.thinking === "string" && row.thinking ? row.thinking : undefined;
    const mode = typeof row.mode === "string" && row.mode ? row.mode : undefined;
    const options: SessionConfigOption[] = [
      {
        type: "select",
        id: "model",
        name: "Model",
        category: "model",
        currentValue: preset ?? this.modelPreset,
        options: (this.modelProfiles.get(sessionId) ?? []).map((profile) => ({
          type: "item",
          id: profile.value,
          name: profile.name,
          ...(profile.group ? { group: profile.group } : {}),
          ...(profile.description ? { description: profile.description } : {}),
        })),
      },
      {
        type: "select",
        id: "thinking",
        name: "Thinking",
        category: "thought_level",
        currentValue:
          this.explicitSessionThinking.get(sessionId) ??
          thinking ??
          this.modelPresetThinking,
        options: [...EFFORT_LEVELS].map((level) => ({
          type: "item",
          id: level,
          name: level,
        })),
      },
      ...(mode
        ? [
            {
              type: "select" as const,
              id: "mode",
              name: "Mode",
              category: "mode",
              currentValue: mode,
              options: [{ type: "item", id: mode, name: mode }],
            },
          ]
        : []),
    ];
    this.captureSessionState(sessionId, options, mode);
  }

  /** One row of the session's own config, or undefined when it cannot answer. */
  private async sessionConfigRow(
    sessionId: string,
  ): Promise<Record<string, unknown> | undefined> {
    try {
      const cli = await this.requireCli();
      const items = await cli.queryItems(
        sessionId,
        "config.list/get",
        {},
        { repo: this.repoFor(sessionId) },
      );
      return items.find(
        (item): item is Record<string, unknown> =>
          Boolean(item) && typeof item === "object" && !Array.isArray(item),
      );
    } catch {
      return undefined;
    }
  }

  /**
   * Reconciles the session's reported model/thinking/mode after a change.
   *
   * The session-scoped SDK config is the only thing that answers what the session
   * itself runs, so a restored session reports its own model instead of the
   * app-wide default.
   */
  private async refreshSessionSettings(sessionId: string): Promise<void> {
    try {
      const row = await this.sessionConfigRow(sessionId);
      if (!row) return;
      const preset =
        typeof row.modelPreset === "string" && row.modelPreset
          ? row.modelPreset
          : undefined;
      const thinking =
        typeof row.thinking === "string" && row.thinking
          ? row.thinking
          : undefined;
      const mode =
        typeof row.mode === "string" && row.mode ? row.mode : undefined;
      // A host that reports the session's service tier here is read too: /fast
      // inverts this value, and guessing the direction is how a scoped fast tier
      // gets silently downgraded.
      const serviceTier =
        typeof row.serviceTier === "string" && row.serviceTier
          ? row.serviceTier
          : undefined;
      if (!preset && !thinking && !mode && !serviceTier) return;
      const current = this.sessions.get(sessionId);
      this.patchSessionRuntime(sessionId, {
        ...(preset ? { model: preset } : {}),
        ...(thinking ? { thinking } : {}),
        ...(mode ? { mode } : {}),
        ...(serviceTier ? { serviceTier } : {}),
      });
      const options = this.sessionConfig.get(sessionId);
      if (options && (preset || thinking || mode)) {
        const updated = options.map((option) => {
          if ((option.category === "model" || option.id === "model") && preset)
            return { ...option, currentValue: preset };
          if (
            (option.category === "thought_level" || option.id === "thinking") &&
            thinking
          )
            return { ...option, currentValue: thinking };
          if ((option.category === "mode" || option.id === "mode") && mode)
            return { ...option, currentValue: mode };
          return option;
        });
        this.sessionConfig.set(sessionId, updated);
        this.emitEvent({ type: "session.config", sessionId, options: updated });
      }
      if (preset && (current?.model !== preset || !current.modelDisplay)) {
        const capabilities = await this.modelCapabilities(sessionId, preset);
        this.patchSessionRuntime(sessionId, {
          modelDisplay:
            capabilities.modelDisplay ??
            this.modelProfiles
              .get(sessionId)
              ?.find((profile) => profile.value === preset)?.name ??
            preset,
        });
      }
    } catch {
      // A session that cannot answer a config query keeps the values it already had.
    }
  }

  private async refreshModelProfiles(sessionId: string): Promise<void> {
    try {
      const cli = await this.requireCli();
      const items = await cli.queryItems(
        sessionId,
        "models.profiles.list",
        {},
        { repo: this.repoFor(sessionId) },
      );
      const profiles = items
        .flatMap((item): AgentConfigOptionValue[] => {
          if (!item || typeof item !== "object") return [];
          const profile = item as {
            id?: unknown;
            displayName?: unknown;
            source?: unknown;
            available?: unknown;
          };
          if (typeof profile.id !== "string" || profile.available === false)
            return [];
          const configured = profile.source === "configured";
          return [
            {
              value: profile.id,
              name:
                typeof profile.displayName === "string" && profile.displayName
                  ? profile.displayName
                  : profile.id,
              group: configured ? "Custom profiles" : "Built-in profiles",
              description: configured
                ? "From ~/.gjc/agent/models.yml"
                : "Bundled with GJC",
            },
          ];
        })
        .sort((left, right) => {
          if (left.group !== right.group)
            return left.group === "Custom profiles" ? -1 : 1;
          return left.name.localeCompare(right.name);
        });
      if (profiles.length > 0) this.modelProfiles.set(sessionId, profiles);
      const existing = this.sessionConfig.get(sessionId) ?? [];
      if (existing.length > 0) {
        const selectedModel = existing.find(
          (option) => option.category === "model" || option.id === "model",
        )?.currentValue;
        const modelCapabilities =
          typeof selectedModel === "string"
            ? await this.modelCapabilities(sessionId, selectedModel)
            : undefined;
        const thinkingOptions = modelCapabilities?.thinkingOptions;
        // A preset whose catalog row carries no default-model label must still resolve to a
        // name: the profile list, then the raw preset id. Leaving it undefined is what pinned
        // the composer at "모델 확인 중…" after every preset change.
        const modelDisplay =
          modelCapabilities?.modelDisplay ??
          (typeof selectedModel === "string"
            ? (profiles.find((profile) => profile.value === selectedModel)
                ?.name ?? selectedModel)
            : undefined);
        if (modelDisplay) this.patchSessionRuntime(sessionId, { modelDisplay });
        const updated = existing.map((option) => {
          if (
            (option.category === "model" || option.id === "model") &&
            profiles.length > 0
          )
            return { ...option, options: profiles };
          if (
            (option.category === "thought_level" || option.id === "thinking") &&
            thinkingOptions
          ) {
            return { ...option, options: thinkingOptions };
          }
          return option;
        });
        this.sessionConfig.set(sessionId, updated);
        this.emitEvent({ type: "session.config", sessionId, options: updated });
      }
    } catch {
      // The active session keeps its cached model options when discovery is unavailable.
    }
  }

  private async modelCapabilities(
    sessionId: string,
    selectedModel: string,
  ): Promise<{
    thinkingOptions?: AgentConfigOptionValue[];
    modelDisplay?: string;
  }> {
    try {
      const cli = await this.requireCli();
      const items = await cli.queryItems(
        sessionId,
        "models.list/current",
        {},
        { repo: this.repoFor(sessionId) },
      );
      return {
        thinkingOptions: thinkingOptionsForModelCatalog(items, selectedModel),
        modelDisplay: profileDefaultModelLabel(items, selectedModel),
      };
    } catch {
      return {};
    }
  }

  /**
   * Context usage for a session, at most one query in flight per session.
   *
   * Every transcript write asks for this. Several subagents writing at once can
   * otherwise spawn a burst of redundant usage lookups, so a request that arrives
   * while one is running joins it instead of adding another.
   */
  private refreshContextUsage(sessionId: string): Promise<void> {
    const inFlight = this.contextUsageQueries.get(sessionId);
    if (inFlight) return inFlight;
    const query = this.queryContextUsage(sessionId).finally(() => {
      this.contextUsageQueries.delete(sessionId);
    });
    this.contextUsageQueries.set(sessionId, query);
    return query;
  }

  private async queryContextUsage(sessionId: string): Promise<void> {
    try {
      const items = await this.querySessionItems(sessionId, "context.get");
      const first = items[0];
      const usage =
        first && typeof first === "object" && !Array.isArray(first)
          ? (first as { usage?: unknown }).usage
          : undefined;
      if (!usage || typeof usage !== "object" || Array.isArray(usage)) return;
      const snapshot = usage as {
        percent?: unknown;
        tokens?: unknown;
        contextWindow?: unknown;
      };
      const percent =
        typeof snapshot.percent === "number"
          ? snapshot.percent
          : typeof snapshot.tokens === "number" &&
              typeof snapshot.contextWindow === "number" &&
              snapshot.contextWindow > 0
            ? (snapshot.tokens / snapshot.contextWindow) * 100
            : undefined;
      if (percent !== undefined) {
        this.patchSessionRuntime(sessionId, {
          usagePercent: Math.min(100, Math.max(0, percent)),
          usagePending: false,
        });
      } else if (snapshot.percent === null || snapshot.tokens === null) {
        this.patchSessionRuntime(sessionId, {
          usagePercent: undefined,
          usagePending: true,
        });
      }
    } catch {
      // Usage is advisory and must not block session attachment or prompting.
    }
  }

  private patchSessionRuntime(
    sessionId: string,
    patch: Partial<
      Pick<
        AgentSession,
        | "phase"
        | "status"
        | "mode"
        | "model"
        | "modelDisplay"
        | "thinking"
        | "serviceTier"
        | "usagePercent"
        | "usagePending"
      >
    >,
  ): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    // A turn re-asserts the same runtime state repeatedly (status already running,
    // unchanged usage percent). Every emit is an IPC broadcast that re-renders the
    // renderer's whole session subtree, so a patch that changes nothing is dropped.
    const changed = Object.entries(patch).some(
      ([key, value]) => session[key as keyof AgentSession] !== value,
    );
    if (!changed) return;
    if (
      Object.hasOwn(patch, "status") &&
      patch.status !== undefined &&
      session.status !== patch.status
    )
      this.advanceRunRevision(sessionId);
    Object.assign(session, patch);
    this.emitEvent({ type: "session.updated", session: { ...session } });
  }

  private projectMessageChunk(
    sessionId: string,
    role: ChatMessage["role"],
    update: Extract<
      SessionUpdate,
      { sessionUpdate: "user_message_chunk" | "agent_message_chunk" }
    >,
  ): void {
    const text = textFromContent(update.content);
    const image =
      update.content.type === "image"
        ? imageFromContent(update.content, `gjc-image-${this.nextLocalId++}`)
        : undefined;
    const userMessageKey =
      role === "user" && update.messageId
        ? `user:${update.messageId}`
        : undefined;
    if (
      userMessageKey &&
      this.suppressedUserMessageKeys.get(sessionId)?.has(userMessageKey)
    )
      return;
    if (role === "user" && text && this.consumePromptEcho(sessionId, text)) {
      if (userMessageKey) {
        const suppressed =
          this.suppressedUserMessageKeys.get(sessionId) ?? new Set<string>();
        suppressed.add(userMessageKey);
        this.suppressedUserMessageKeys.set(sessionId, suppressed);
      }
      return;
    }
    if (!text && !image) return;
    const activeAssistantId =
      role === "assistant"
        ? this.activeAssistantMessages.get(sessionId)
        : undefined;
    const fallbackKey =
      role === "assistant"
        ? `assistant-${this.nextLocalId++}`
        : `user-${this.nextLocalId++}`;
    const externalKey = `${role}:${update.messageId ?? fallbackKey}`;
    const keys = this.messageKeys.get(sessionId) ?? new Map<string, string>();
    const existingId = activeAssistantId ?? keys.get(externalKey);

    if (existingId) {
      const items = this.transcripts.get(sessionId) ?? [];
      const message = items.find((item) => item.id === existingId);
      if (message?.kind !== "message") return;
      message.content += text;
      if (image) message.images = [...(message.images ?? []), image];
      message.streaming = role === "assistant";
      if (image)
        this.emitEvent({
          type: "message.updated",
          message: cloneTranscriptItem(message) as ChatMessage,
        });
      if (text) {
        this.emitEvent({
          type: "message.delta",
          sessionId,
          messageId: message.id,
          delta: text,
          streaming: message.streaming,
        });
      }
      return;
    }

    const id = update.messageId
      ? `gjc-message-${update.messageId}`
      : `gjc-message-${this.nextLocalId++}`;
    keys.set(externalKey, id);
    this.messageKeys.set(sessionId, keys);
    if (role === "assistant") this.activeAssistantMessages.set(sessionId, id);
    const message: ChatMessage = {
      id,
      kind: "message",
      sessionId,
      role,
      content: text,
      ...(image ? { images: [image] } : {}),
      createdAt: nowLabel(),
      streaming: role === "assistant",
    };
    this.appendTranscript(message);
  }

  private upsertTool(
    sessionId: string,
    update: Extract<
      SessionUpdate,
      { sessionUpdate: "tool_call" | "tool_call_update" }
    >,
  ): void {
    const items = this.transcripts.get(sessionId) ?? [];
    const existing = items.find(
      (item): item is ToolActivity =>
        item.kind === "tool" && item.id === update.toolCallId,
    );
    if (
      this.locallyAbortedSessions.has(sessionId) &&
      update.sessionUpdate === "tool_call" &&
      !existing
    )
      return;
    if (update.sessionUpdate === "tool_call" && !existing)
      this.finalizeAssistantMessage(sessionId);
    const name = inferToolName(update, existing);
    const input =
      update.rawInput &&
      typeof update.rawInput === "object" &&
      !Array.isArray(update.rawInput)
        ? (update.rawInput as Record<string, unknown>)
        : undefined;
    const diff =
      toolDiffText(update.rawOutput, update.content) ?? existing?.diff;
    const images = [
      ...toolImageRefs(update.content),
      ...toolImageRefs(update.rawOutput),
    ];
    const projectedStatus = update.status
      ? toolStatus(update.status)
      : (existing?.status ?? "running");
    const rawOutput = update.rawOutput ?? update.content;
    const outputText =
      rawOutput === undefined
        ? undefined
        : typeof rawOutput === "string"
          ? rawOutput
          : JSON.stringify(rawOutput);
    const subagents =
      name === "task"
        ? input
          ? taskSubagents(input, projectedStatus, outputText)
          : existing?.subagents?.map((agent) => ({
              ...agent,
              status:
                receiptSubagentStatus(outputText, agent.id) ??
                taskStatus(projectedStatus),
            }))
        : undefined;
    const patch: ToolActivity = {
      id: update.toolCallId,
      kind: "tool",
      sessionId,
      name,
      description: update.title ?? existing?.description ?? name,
      command: boundedJson(update.rawInput) ?? existing?.command,
      status: projectedStatus,
      createdAt: existing?.createdAt ?? nowLabel(),
      output:
        boundedJson(update.rawOutput ?? update.content) ?? existing?.output,
      artifactRefs: [
        ...new Set([
          ...(existing?.artifactRefs ?? []),
          ...artifactReferences(update.rawInput),
          ...artifactReferences(update.rawOutput ?? update.content),
        ]),
      ],
      ...(diff ? { diff } : {}),
      ...(typeof input?.path === "string" && input.path
        ? { targetPath: input.path }
        : existing?.targetPath
          ? { targetPath: existing.targetPath }
          : {}),
      ...(images.length > 0
        ? { images }
        : existing?.images
          ? { images: existing.images }
          : {}),
      ...(subagents && subagents.length > 0 ? { subagents } : {}),
    };
    if (update.rawInput !== undefined) {
      const id = `${sessionId}-${update.toolCallId}-input`.replace(
        /[^A-Za-z0-9._-]/g,
        "_",
      );
      patch.inputArtifactId = id;
      void this.persistArtifact(sessionId, id, update.rawInput).catch((error) =>
        console.error(`Failed to persist tool input artifact ${id}`, error),
      );
    }
    if (update.rawOutput !== undefined || update.content !== undefined) {
      const id = `${sessionId}-${update.toolCallId}-output`.replace(
        /[^A-Za-z0-9._-]/g,
        "_",
      );
      patch.outputArtifactId = id;
      void this.persistArtifact(
        sessionId,
        id,
        update.rawOutput ?? update.content,
      ).catch((error) =>
        console.error(`Failed to persist tool output artifact ${id}`, error),
      );
    }
    if (existing) {
      Object.assign(existing, patch);
      this.emitEvent({ type: "tool.updated", tool: { ...existing } });
    } else {
      this.appendTranscript(patch);
    }
    // A todo tool that finished is the only live signal that the store may have
    // changed, and it is not a todo record: it is a request. The store itself is
    // read back so what is shown is what the runtime recorded, not the input op.
    if (name === "todo_write" && patch.status === "completed")
      void this.readTodoRecords(sessionId);
    if (patch.images?.some((image) => image.blobId && !image.dataUrl)) {
      const settled = existing ?? patch;
      void this.resolveToolImages([settled])
        .then(() => {
          this.emitEvent({ type: "tool.updated", tool: { ...settled } });
        })
        .catch(() => undefined);
    }
  }

  private async persistArtifact(
    sessionId: string,
    artifactId: string,
    value: unknown,
  ): Promise<void> {
    if (this.deletingSessions.has(sessionId)) return;
    let sessionArtifacts = this.artifactSessionIds.get(sessionId);
    if (!sessionArtifacts) {
      sessionArtifacts = new Set<string>();
      this.artifactSessionIds.set(sessionId, sessionArtifacts);
    }
    sessionArtifacts.add(artifactId);
    const text = redactSensitiveText(
      typeof value === "string" ? value : JSON.stringify(value, null, 2),
    );
    const namespace = this.artifactNamespace(sessionId);
    const file = path.join(
      this.artifactDirectory,
      namespace,
      `${artifactId}.json`,
    );
    const writeKey = this.artifactWriteKey(sessionId, artifactId);
    const previous = this.artifactWrites.get(writeKey) ?? Promise.resolve();
    const operation = previous
      .catch(() => undefined)
      .then(async () => {
        if (this.deletingSessions.has(sessionId)) return;
        await mkdir(path.dirname(file), { recursive: true });
        const temporary = `${file}.${process.pid}.${this.nextLocalId++}.tmp`;
        await writeFile(temporary, JSON.stringify({ text }), { mode: 0o600 });
        await rename(temporary, file);
      });
    this.artifactWrites.set(writeKey, operation);
    try {
      await operation;
    } finally {
      if (this.artifactWrites.get(writeKey) === operation)
        this.artifactWrites.delete(writeKey);
    }
  }

  /**
   * Records a tool call that is waiting on an approval decision.
   *
   * A broker-hosted session host cannot ask an external controller for a decision,
   * so nothing calls this over a live channel any more; the session's permission
   * mode is set instead (see `applyPermissionMode`). It stays because a transcript
   * row can still report a tool as awaiting approval, and the window has to show
   * that state and be able to clear it on cancel.
   */
  private requestPermission(
    request: PendingPermission["request"],
  ): Promise<{ outcome: { outcome: string; optionId?: string } }> {
    const { toolCall } = request;
    this.upsertTool(request.sessionId, {
      sessionUpdate: "tool_call_update",
      ...toolCall,
      status: "pending",
    });
    this.patchTool(toolCall.toolCallId, { status: "approval-required" });
    this.patchTool(toolCall.toolCallId, {
      permissionOptions: request.options.map((option) => ({
        optionId: option.optionId,
        kind: option.kind,
        name: option.name,
      })),
    });
    return new Promise((resolve) => {
      this.pendingPermissions.set(toolCall.toolCallId, { request, resolve });
    });
  }

  private patchTool(toolId: string, patch: Partial<ToolActivity>): void {
    for (const items of this.transcripts.values()) {
      const tool = items.find(
        (item): item is ToolActivity =>
          item.kind === "tool" && item.id === toolId,
      );
      if (!tool) continue;
      Object.assign(tool, patch);
      this.emitEvent({ type: "tool.updated", tool: { ...tool } });
      return;
    }
  }

  private patchSessionInfo(
    sessionId: string,
    update: Extract<SessionUpdate, { sessionUpdate: "session_info_update" }>,
  ): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (update.title?.trim() && !this.sessionMetadata?.getAlias(sessionId)) {
      session.title = readableSessionTitle(sessionId, update.title);
    }
    if (update.updatedAt) markUpdated(session, update.updatedAt);
    const phase =
      typeof update._meta?.gjcPhase === "string"
        ? update._meta.gjcPhase
        : undefined;
    const running = update._meta?.gjcRunning;
    const compactionState =
      update._meta?.gjcCompactionState === "start" ||
      update._meta?.gjcCompactionState === "end"
        ? update._meta.gjcCompactionState
        : undefined;
    const phaseTimestamp =
      typeof update.updatedAt === "string" ? Date.parse(update.updatedAt) : NaN;
    const staleOrderedPhase =
      (phase === "compacting" || phase === "working") &&
      Number.isFinite(phaseTimestamp) &&
      (this.compactionRecordWatermark.get(sessionId) ?? -Infinity) >=
        phaseTimestamp;
    if (phase === "compacting" && !staleOrderedPhase) {
      session.phase = "compacting";
      this.compactingSessions.add(sessionId);
      if (Number.isFinite(phaseTimestamp))
        this.compactionStartedAt.set(sessionId, phaseTimestamp);
      if (!this.locallyAbortedSessions.has(sessionId))
        session.status = "running";
    } else if (phase && !staleOrderedPhase) {
      // GJC reporting any other phase is the authority that compaction ended, so
      // this is where a locally started compaction is released. Returning from the
      // control call only meant the request was accepted.
      if (
        (phase === "working" && update.updatedAt !== undefined) ||
        phase === "responding" ||
        phase === "idle"
      ) {
        this.compactingSessions.delete(sessionId);
        this.compactionRecordBaseline.delete(sessionId);
        this.compactionStartedAt.delete(sessionId);
      }
      session.phase =
        phase === "responding" || phase === "idle" ? undefined : phase;
    }
    // A report carrying `updatedAt` is describing an actual change of state; GJC's
    // explicit compaction start/end events are ordered lifecycle evidence too, even
    // though current releases omit updatedAt on those two notifications.
    const lifecycleChanged =
      update.updatedAt !== undefined || compactionState !== undefined;
    const runtimeConfirmedWorkingCycle =
      lifecycleChanged &&
      !staleOrderedPhase &&
      (running === true || (phase !== undefined && phase !== "idle"));
    if (runtimeConfirmedWorkingCycle) {
      this.advanceRunRevision(sessionId);
      this.workingPhaseSessions.add(sessionId);
      this.runtimeIdleSessions.delete(sessionId);
    }
    const runtimeFinishedWorkingCycle =
      lifecycleChanged &&
      (phase === "idle" || (phase === undefined && running === false)) &&
      this.workingPhaseSessions.has(sessionId);
    if (runtimeFinishedWorkingCycle) {
      this.runtimeIdleSessions.add(sessionId);
      // The transcript may already contain the final assistant row. If it does not,
      // its watcher will call this again when that row arrives.
      void this.readPersistedTranscript(sessionId);
    }
    if (
      running === true &&
      !staleOrderedPhase &&
      !this.locallyAbortedSessions.has(sessionId)
    ) {
      if (session.status !== "running" && !runtimeConfirmedWorkingCycle)
        this.advanceRunRevision(sessionId);
      session.status = "running";
      if (!this.liveRunningSessions.has(sessionId)) {
        this.liveRunningSessions.add(sessionId);
        // Record how much transcript existed when the work was reported, so a later
        // read can tell an unchanged stale snapshot from one that watched it end.
        void this.rememberLiveRunningTranscriptSize(sessionId);
      }
    }
    if (phase === "compacting" && !staleOrderedPhase) {
      // Capture the revision only after this event has advanced it. Starting this
      // read earlier made it stale itself synchronously, so a completion record
      // already on disk could never clear the newly armed working marker.
      void this.readPersistedTranscript(sessionId).catch(() => undefined);
    }
    // A prompt this window sent owns the status until its own round trip settles,
    // because GJC reports gjcRunning:false for the state *before* the prompt was
    // accepted. Telling the two apart needs one bit of history: a stale report
    // arrives without GJC ever having confirmed the turn started, while a genuine
    // completion always follows a gjcRunning:true for that same turn. Ignoring
    // every report instead left the row running forever whenever the prompt never
    // got its reply.
    //
    // The same reasoning covers a turn nobody here started. Attaching to a session
    // makes GJC publish a bootstrap `gjcRunning:false` describing *this connection's*
    // prompt state, which says nothing about work another process is driving. Reading
    // it as a completion is what flipped a working session to 완료 the moment it was
    // clicked. Only a report that follows a confirmed start closes a turn.
    const neverConfirmedRunning = !this.liveRunningSessions.has(sessionId);
    const staleForActivePrompt =
      this.activePromptSessions.has(sessionId) && neverConfirmedRunning;
    // Which report to discard depends on where the row's running state came from. A
    // status this window set for its own command is answered by that command's own
    // live report. A status read out of the transcript belongs to work in another
    // process, and the bootstrap report carries no information about it.
    const bootstrapForForeignTurn =
      !this.activePromptSessions.has(sessionId) &&
      neverConfirmedRunning &&
      this.transcriptRunningSessions.has(sessionId);
    // Attaching delivers two reports 0.1s apart, captured from the running app:
    //   {updatedAt, _meta:{gjcPhase:"working", gjcRunning:true}}
    //   {           _meta:{gjcPhase:"idle",    gjcRunning:false}}
    // The second is the bootstrap restatement of this connection's prompt slot, and it
    // has no `updatedAt` because nothing changed. The guard below already ignored it, but
    // only while nothing had confirmed the session running -- and the report 0.1s earlier
    // had just done exactly that, so the idle won and the row read 완료 while a tool was
    // still working.
    //
    // A real runtime transition states when it happened, so requiring `updatedAt`
    // rejects the restatement. It still does not finish the row by itself: the
    // transcript must also contain the cycle's terminal assistant response.
    const bootstrapIdleAfterWorking =
      update.updatedAt === undefined &&
      this.workingPhaseSessions.has(sessionId);
    if (
      running === false &&
      session.status !== "failed" &&
      !staleForActivePrompt &&
      !bootstrapForForeignTurn &&
      !bootstrapIdleAfterWorking &&
      !this.workingPhaseSessions.has(sessionId) &&
      !this.pendingAsyncWorkSessions.has(sessionId) &&
      !this.compactingSessions.has(sessionId)
    ) {
      // A turn this window did not start -- a steer, or work driven from the
      // terminal -- ends here rather than in sendMessage, so this is where its
      // completion is announced. A cancel is excluded: the user performed it and
      // is already watching, so announcing it is noise.
      const wasRunning = session.status === "running";
      if (session.status !== "idle") this.advanceRunRevision(sessionId);
      session.status = "idle";
      this.liveRunningSessions.delete(sessionId);
      this.liveRunningDigests.delete(sessionId);
      this.transcriptRunningSessions.delete(sessionId);
      this.discoveredRunStates.delete(sessionId);
      this.compactingSessions.delete(sessionId);
      this.compactionRecordBaseline.delete(sessionId);
      this.compactionStartedAt.delete(sessionId);
      this.workingPhaseSessions.delete(sessionId);
      this.runtimeIdleSessions.delete(sessionId);
      if (session.phase === "compacting") session.phase = undefined;
      if (
        wasRunning &&
        !this.cancellingSessions.has(sessionId) &&
        !this.locallyAbortedSessions.has(sessionId)
      )
        this.emitActivity(sessionId, "completed");
    }
    if (typeof update._meta?.gjcThinkingLevel === "string")
      session.thinking = update._meta.gjcThinkingLevel;
    this.emitEvent({ type: "session.updated", session: { ...session } });
  }

  async forkSession(input: {
    sourceSessionId: string;
    title?: string;
  }): Promise<AgentSession> {
    const source = this.sessions.get(input.sourceSessionId);
    if (!source)
      throw new Error(`Unknown GJC session: ${input.sourceSessionId}`);
    const cwd = this.sessionCwds.get(source.id);
    if (!cwd || path.resolve(cwd) !== path.resolve(source.workspace))
      throw new Error("Fork requires the canonical source workspace");
    await this.ensureAttached(source.id, false);
    // The fork itself is what creates the session; the lifecycle receipt is only
    // the evidence that it was recorded. A receipt that cannot be verified was
    // reported as a failed fork even though the broker had already created the
    // session -- which is why discovery listed it moments later. The broker index
    // is the authority on whether that happened, so it is consulted instead of
    // surfacing an error for a fork that succeeded.
    const knownSessionIds = new Set([
      ...this.sessions.keys(),
      ...((await this.brokerSessions()) ?? []).map((listed) => listed.sessionId),
    ]);
    const cli = await this.requireCli();
    let forkedId: string | undefined;
    const forkRequestId = `gajae-session-fork-${randomUUID()}`;
    try {
      const forked = await cli.rawGlobal(
        "session.fork",
        {
          cwd,
          sourceSessionId: source.id,
          modelPreset: this.modelPreset,
        },
        { repo: cwd, idempotencyKey: forkRequestId },
      );
      if (typeof forked?.sessionId === "string") forkedId = forked.sessionId;
    } catch (error) {
      if (!isLifecycleUncertain(error)) throw error;
    }
    if (!forkedId)
      forkedId = await this.recoverForkedSession(
        cwd,
        knownSessionIds,
        forkRequestId,
      );
    if (!forkedId)
      throw new Error(
        "GJC가 세션을 포크했지만 lifecycle 영수증을 검증하지 못했습니다. 보존된 포크 자동 복구에도 실패했습니다. GJC lifecycle ledger reconciliation이 필요합니다.",
      );
    const inheritedWorktree =
      source.worktree?.managed === true &&
      path.resolve(source.worktree.path) === path.resolve(cwd)
        ? source.worktree
        : undefined;
    const session: AgentSession = {
      id: forkedId,
      title: input.title?.trim() || `${source.title} (fork)`,
      subtitle: path.basename(cwd) || cwd,
      workspace: cwd,
      runtime: "gjc",
      status: "idle",
      updatedAt: "now",
      updatedAtMs: Date.now(),
      // The fork this window asked for already knows the source; the envelope read
      // only has to cover sessions this window did not create.
      parentId: input.sourceSessionId,
      pinned: false,
      unread: false,
      accent: GJC_ACCENT,
      ownership: "gajae",
      attachment: "recovering",
      ...(inheritedWorktree ? { worktree: inheritedWorktree } : {}),
    };
    this.sessions.set(session.id, session);
    this.sessionCwds.set(session.id, cwd);
    this.sessionMetadata?.setAlias(session.id, session.title);
    this.sessionMetadata?.setWorkspace(session.id, cwd);
    this.sessionMetadata?.setOwnership(session.id, "gajae");
    if (inheritedWorktree)
      this.sessionMetadata?.setWorktree(session.id, inheritedWorktree);
    try {
      await this.applyPermissionMode(session.id);
    } catch (error) {
      session.status = "failed";
      this.emitEvent({ type: "session.created", session: { ...session } });
      throw error;
    }
    session.attachment = "attached";
    this.attachedSessions.add(session.id);
    this.startTailFollower(session.id);
    await this.refreshSessionConfigOptions(session.id);
    const forkedFile = await this.locateSharedTranscriptFile(session.id);
    if (forkedFile) this.watchSharedTranscript(session.id, forkedFile);
    this.emitEvent({ type: "session.created", session: { ...session } });
    return { ...session };
  }

  /**
   * The id of the session a fork created, recovered from the broker index when the
   * fork's own lifecycle receipt could not be verified. Undefined when no new
   * session for this workspace appears, which means the fork really did not happen.
   */
  private async recoverForkedSession(
    cwd: string,
    knownSessionIds: ReadonlySet<string>,
    lifecycleRequestId: string,
  ): Promise<string | undefined> {
    const workspace = canonicalWorkspace(cwd);
    for (let attempt = 0; attempt < FORK_RECOVERY_ATTEMPTS; attempt += 1) {
      const retained = (await this.brokerSessions())?.find(
        (listed) =>
          !knownSessionIds.has(listed.sessionId) &&
          listed.live &&
          !listed.deleted &&
          (listed.endpointGeneration ?? 0) > 0 &&
          listed.repo !== undefined &&
          path.resolve(listed.repo) === workspace &&
          (listed.lifecycleRequestId === undefined ||
            listed.lifecycleRequestId === lifecycleRequestId),
      );
      if (retained) {
        this.sessionCwds.set(retained.sessionId, workspace);
        this.transcripts.set(retained.sessionId, []);
        this.messageKeys.set(retained.sessionId, new Map());
        return retained.sessionId;
      }
      if (attempt < FORK_RECOVERY_ATTEMPTS - 1)
        await new Promise((resolve) =>
          setTimeout(resolve, this.forkRecoveryIntervalMs),
        );
    }
    return undefined;
  }

  async getGitStatus(sessionId: string): Promise<GitStatusSnapshot> {
    const workspace = this.sessionCwds.get(sessionId) ?? this.workspace;
    // A session can live in a directory that is not a repository at all. `git status`
    // exits non-zero there, and that rejection reached the IPC handler as an
    // unhandled error every time the panel polled. No repository is a state, not a
    // failure, so it is reported as one.
    let result: { stdout: string };
    try {
      result = await execFile(
        "git",
        ["-C", workspace, "status", "--porcelain=v1", "-z", "--branch"],
        { maxBuffer: 2 * 1024 * 1024 },
      );
    } catch {
      return { workspace, branch: "", ahead: 0, behind: 0, files: [] };
    }
    let branch = "";
    let upstream: string | undefined;
    let ahead = 0;
    let behind = 0;
    const files: GitStatusSnapshot["files"] = [];
    const entries = result.stdout.split("\0").filter(Boolean);
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index]!;
      if (entry.startsWith("## ")) {
        const header = entry.slice(3);
        const match =
          /^(.*?)\.\.\.([^ ]+)(?: \[ahead (\d+)(?:, behind (\d+))?\]| \[behind (\d+)\])?$/u.exec(
            header,
          );
        if (match) {
          branch = match[1] ?? "";
          upstream = match[2];
          ahead = Number(match[3] ?? 0);
          behind = Number(match[4] ?? match[5] ?? 0);
        } else branch = gitBranchFromHeader(header);
        continue;
      }
      if (entry.length < 4) continue;
      const indexStatus = entry[0] ?? ".";
      const workingTree = entry[1] ?? ".";
      const filePath = entry.slice(3);
      if (safeGitPath(filePath))
        files.push({ path: filePath, index: indexStatus, workingTree });
      if (indexStatus === "R" || indexStatus === "C") index += 1;
    }
    return {
      workspace,
      branch,
      ...(upstream ? { upstream } : {}),
      ahead,
      behind,
      files,
    };
  }

  private async mutateGit(
    sessionId: string,
    args: string[],
  ): Promise<GitStatusSnapshot> {
    const session = this.sessions.get(sessionId);
    const worktree = session?.worktree;
    if (
      !session ||
      !worktree?.managed ||
      path.resolve(session.workspace) !== path.resolve(worktree.path)
    )
      throw new Error("Git mutation requires a managed Gajae worktree");
    const root = (
      await execFile("git", [
        "-C",
        worktree.path,
        "rev-parse",
        "--show-toplevel",
      ])
    ).stdout.trim();
    if (path.resolve(root) !== path.resolve(worktree.path))
      throw new Error("Managed worktree path verification failed");
    await execFile("git", ["-C", worktree.path, ...args]);
    return this.getGitStatus(sessionId);
  }
  async stageFiles(
    sessionId: string,
    paths: string[],
  ): Promise<GitStatusSnapshot> {
    const status = await this.getGitStatus(sessionId);
    const allowed = new Set(status.files.map((file) => file.path));
    if (
      paths.some((filePath) => !allowed.has(filePath) || !safeGitPath(filePath))
    )
      throw new Error(
        "Path is not an eligible repository-relative changed file",
      );
    return this.mutateGit(sessionId, ["add", "--", ...paths]);
  }
  async unstageFiles(
    sessionId: string,
    paths: string[],
  ): Promise<GitStatusSnapshot> {
    const status = await this.getGitStatus(sessionId);
    const allowed = new Set(status.files.map((file) => file.path));
    if (
      paths.some((filePath) => !allowed.has(filePath) || !safeGitPath(filePath))
    )
      throw new Error(
        "Path is not an eligible repository-relative changed file",
      );
    return this.mutateGit(sessionId, ["restore", "--staged", "--", ...paths]);
  }
  async commitChanges(
    sessionId: string,
    message: string,
  ): Promise<GitStatusSnapshot> {
    const text = message.trim();
    if (!text || text.length > 512)
      throw new Error("Commit message is required and bounded");
    return this.mutateGit(sessionId, ["commit", "-m", text]);
  }
  async pushChanges(sessionId: string): Promise<GitStatusSnapshot> {
    return this.mutateGit(sessionId, ["push"]);
  }

  private appendTranscript(item: TranscriptItem): void {
    const items = this.transcripts.get(item.sessionId) ?? [];
    items.push(item);
    this.transcripts.set(item.sessionId, items);
    this.emitEvent({
      type: "transcript.appended",
      item: cloneTranscriptItem(item),
    });
  }

  private emitActivity(
    sessionId: string,
    category: Extract<AgentEvent, { type: "session.activity" }>["category"],
  ): void {
    // A session this window prompted may not be in the discovered set yet. The
    // outcome still has to be announced, so an unknown session falls back to a
    // readable title rather than swallowing the notification.
    const session = this.sessions.get(sessionId);
    if (session) {
      session.unread = true;
      this.sessionMetadata?.setUnread(sessionId, true);
    }
    this.emitEvent({
      type: "session.activity",
      sessionId,
      title: session?.title ?? readableSessionTitle(sessionId, undefined),
      unread: true,
      category,
    });
  }

  private finalizeAssistantMessage(sessionId: string): void {
    const messageId = this.activeAssistantMessages.get(sessionId);
    if (!messageId) return;
    const items = this.transcripts.get(sessionId) ?? [];
    const message = items.find((item) => item.id === messageId);
    if (message?.kind === "message") {
      message.streaming = false;
      this.emitEvent({
        type: "message.delta",
        sessionId,
        messageId,
        delta: "",
        streaming: false,
      });
    }
    this.activeAssistantMessages.delete(sessionId);
  }

  private finalizeAllMessages(sessionId: string): void {
    const items = this.transcripts.get(sessionId) ?? [];
    for (const item of items) {
      if (item.kind !== "message" || !item.streaming) continue;
      item.streaming = false;
      this.emitEvent({
        type: "message.delta",
        sessionId,
        messageId: item.id,
        delta: "",
        streaming: false,
      });
    }
    this.activeAssistantMessages.delete(sessionId);
  }

  private currentRunRevision(sessionId: string): number {
    return (
      this.runRevisions.get(sessionId) ??
      this.sessions.get(sessionId)?.runRevision ??
      0
    );
  }

  private advanceRunRevision(sessionId: string): number {
    const revision = this.currentRunRevision(sessionId) + 1;
    this.runRevisions.set(sessionId, revision);
    const session = this.sessions.get(sessionId);
    if (session) session.runRevision = revision;
    return revision;
  }

  private updateSessionStatus(
    sessionId: string,
    status: AgentSession["status"],
    options?: { announce?: boolean },
  ): void {
    const session = this.sessions.get(sessionId);
    if (status === "running" && this.locallyAbortedSessions.has(sessionId))
      return;
    // Any running -> idle transition is a finished turn, and the finish is what
    // the user is waiting for, so the announcement lives here rather than at each
    // callsite. A session owned by a terminal reaches idle through the persisted
    // transcript watcher, which is why announcing only from sendMessage left
    // those runs finishing silently.
    //
    // A session this window prompted before discovery listed it has no record
    // here yet; its turn still ran, so the announcement does not depend on one.
    //
    // A cancel is excluded: the user performed it and is already looking at the
    // window, so telling them about it is noise.
    const finishedTurn =
      options?.announce !== false &&
      status === "idle" &&
      (session?.status ?? "running") === "running" &&
      !this.cancellingSessions.has(sessionId) &&
      !this.locallyAbortedSessions.has(sessionId);
    if (session) {
      if (session.status !== status) this.advanceRunRevision(sessionId);
      session.status = status;
      markUpdated(session);
      this.emitEvent({ type: "session.updated", session: { ...session } });
    }
    if (finishedTurn) this.emitActivity(sessionId, "completed");
  }

  private cancelOpenTools(sessionId: string): void {
    const items = this.transcripts.get(sessionId) ?? [];
    for (const item of items) {
      if (item.kind !== "tool") continue;
      if (item.status !== "running" && item.status !== "approval-required")
        continue;
      item.status = "cancelled";
      if (item.subagents) {
        item.subagents = item.subagents.map((agent) =>
          agent.status === "running" || agent.status === "waiting"
            ? { ...agent, status: "failed" }
            : agent,
        );
      }
      this.emitEvent({ type: "tool.updated", tool: { ...item } });
    }
  }

  private cancelPermissionsForSession(sessionId: string): void {
    for (const [toolId, pending] of this.pendingPermissions) {
      if (pending.request.sessionId !== sessionId) continue;
      pending.resolve({ outcome: { outcome: "cancelled" } });
      this.pendingPermissions.delete(toolId);
    }
  }

  private cancelAllPermissions(): void {
    for (const pending of this.pendingPermissions.values()) {
      pending.resolve({ outcome: { outcome: "cancelled" } });
    }
    this.pendingPermissions.clear();
  }

  private setConnection(connection: BackendConnection): void {
    this.connectionState = connection;
    this.emitEvent({
      type: "connection.updated",
      connection: { ...connection },
    });
  }
}
