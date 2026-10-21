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
import type {
  AgentCommand,
  ChatMessage,
  ImageAttachment,
  ToolActivity,
  ThoughtActivity,
  TranscriptItem,
  SubagentSnapshot,
  SystemNoticeActivity,
  TodoSnapshotPhase,
  TodoSnapshotTask,
  ToolImage,
} from "../shared/agent-contract.js";
import { transcriptItemEqual } from "../shared/transcript-item-equal.js";
import { DEFAULT_MODEL_PRESET } from "../shared/agent-contract.js";
import type { SessionMetadataStore } from "./session-metadata-store.js";


/**
 * Transcript and event shapes.
 *
 * Gajae reads these updates from the session's own file under
 * `~/.gjc/agent/sessions/` and from `gjc sdk session tail` frames, so the shapes
 * are declared here instead of imported from a protocol package. The field names
 * match what GJC persists, which is what both sources carry.
 */
import {
  ATTACH_RETRY_INTERVAL_MS,
  AvailableCommand,
  CLOCK_LABEL,
  ContentBlock,
  EFFORT_LEVELS,
  GJC_ACCENT,
  GjcControllerOptions,
  HISTORY_SUMMARY_HEAD_BYTES,
  LIFECYCLE_RECOVERY_ATTEMPTS,
  LIFECYCLE_RECOVERY_CLOCK_SLACK_MS,
  LIFECYCLE_RECOVERY_INTERVAL_MS,
  LIVE_EVIDENCE_GRACE_MS,
  MAX_TOOL_TEXT,
  PROMPT_SETTLE_ATTEMPTS,
  PROMPT_SETTLE_INTERVAL_MS,
  PendingPermission,
  PlanEntry,
  RUN_STATE_TAIL_BYTES,
  ResolvedMessageInput,
  STARTUP_TIMEOUT_MS,
  SendMessageOptions,
  SessionConfigOption,
  SessionInfo,
  SessionNotification,
  SessionUpdate,
  TAIL_RETRY_BASE_MS,
  TAIL_RETRY_MAX_MS,
  TAIL_WINDOW_MS,
  TRANSCRIPT_RESCAN_WINDOW,
  ToolCallFields,
  ToolCallStatus,
  execFile,
  markUpdated,
  nowLabel,
  parentSessionOf,
  recentLabel,
  timestampMs,
} from "./gjc-sdk-model.js";

import {
  SDK_FAST_SERVICE_TIERS,
  SDK_RELOAD_COMPONENTS,
  SDK_SCOPED_FAST_SERVICE_TIERS,
  SDK_SERVICE_TIER_OFF,
  SDK_SLASH_COMMAND_SPECS,
  SdkSlashCommandSpec,
  agentConfigOptions,
  artifactReferences,
  boundedJson,
  configOptionValues,
  fullToolText,
  gitBranchFromHeader,
  redactSensitiveText,
  safeGitPath,
  sdkSlashCommandsForOperations,
  skillsDisabledByConfig,
  toolStatus,
} from "./gjc-sdk-commands.js";

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
export function textFromContent(content: ContentBlock): string {
  if (content.type === "text") return content.text;
  if (content.type === "audio") return "[Audio attachment]";
  if (content.type === "resource_link") return content.name ?? content.uri;
  if (content.type === "resource") return "[Attached resource]";
  return "";
}

export function imageFromContent(
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

export function cloneTranscriptItem(item: TranscriptItem): TranscriptItem {
  if (item.kind === "plan")
    return { ...item, entries: item.entries.map((entry) => ({ ...entry })) };
  if (item.kind === "question")
    return { ...item, options: item.options.map((option) => ({ ...option })) };
  if (item.kind !== "message" || !item.images) return { ...item };
  return { ...item, images: item.images.map((image) => ({ ...image })) };
}

/**
 * Whether a rescan produced an equivalent item, so it does not need to be
 * republished.
 *
 * Field comparison replaces `JSON.stringify` of the whole row. A tool output
 * that changed without changing length still counts as a change, and an
 * unchanged output is not serialised just to learn that.
 */
export function sameTranscriptItem(
  left: TranscriptItem,
  right: TranscriptItem,
): boolean {
  return transcriptItemEqual(left, right);
}

// The prefixes the live wire names its own rows with, the same list the renderer
// retires those rows by (src/transcript-utils.ts, which this file must not import:
// the two sides mirror each other instead). A recorded rebuild of the same block is
// named from the row it was written under -- `shared-message-*`, `shared-thought-*` --
// so ids alone can never pair a streamed row with its rebuild; the text is what does.
export const LIVE_MESSAGE_PREFIXES = ["gjc-message-", "local-prompt-"] as const;
export const LIVE_THOUGHT_PREFIX = "gjc-thought-";
/**
 * Tool statuses that still owe an outcome.
 *
 * These are the statuses a cancel clears (see `cancelOpenTools`), so a card that is
 * retained while it owes work is also retired by the cancel that ended it. A decided
 * call -- approved, denied -- or a finished one is not this window's to keep: the
 * recorded row accounts for it.
 */
export const LIVE_TOOL_STATUSES: ReadonlySet<ToolActivity["status"]> = new Set([
  "pending",
  "running",
  "approval-required",
]);

export function hasLivePrefix(id: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => id.startsWith(prefix));
}

/**
 * Whether a row exists only in this process's account of the session.
 *
 * The live wire marks its rows: a streamed reply or reasoning block is `streaming`
 * until the block is finalized, and a tool card reports its own status, which reads
 * as owing an outcome while the runtime is still working the call. Everything else
 * in the transcript was built from a durable read, and the rebuild is authoritative
 * over it.
 */
export function isLiveOnlyRow(row: TranscriptItem): boolean {
  if (row.kind === "message" || row.kind === "thought")
    return row.streaming === true;
  if (row.kind === "tool") return LIVE_TOOL_STATUSES.has(row.status);
  return false;
}

/**
 * The comparable text of a transcript row.
 *
 * An attachment block is not part of what a row says -- it names the files the app
 * attached -- and the renderer strips it before pairing a rebuild with the row it
 * replaces. Whitespace is collapsed because a streamed row and its recorded twin can
 * differ only in how the streamed parts were joined.
 */
export function comparableRowText(content: string): string {
  return content
    .replace(
      /<local-(?:attachments|files|images)>[\s\S]*?<\/local-(?:attachments|files|images)>/gu,
      "",
    )
    .replace(/\s+/gu, " ")
    .trim();
}

/**
 * The durable row that accounts for a live row, when the read carries one.
 *
 * A tool call reconciles by id: the live card is named with the runtime's own
 * `toolCallId`, which the recorded call carries too. Messages and thoughts do not --
 * the wire names a streamed reply `gjc-message-<messageId>` while the recorded row is
 * `shared-message-<row>` -- so the block itself is what pairs them, compared with the
 * renderer's rule: the same prefix, the same role, and the same text once the
 * attachment block and whitespace are normalized away.
 *
 * A rebuild that carries no outcome for a call this window still shows as working is
 * not an account of it (the renderer's `supersedesRunningTool` rule): the broker
 * records no status on a tool block, so a call in flight comes back reading
 * `cancelled` with nothing in it. Taking that row would put a finished-looking card
 * over live work, so the live row keeps the block and the next read decides again.
 */
export function durableTwinOf(
  items: readonly TranscriptItem[],
  live: TranscriptItem,
): TranscriptItem | undefined {
  if (live.kind === "tool") {
    const twin = items.find(
      (item): item is ToolActivity => item.kind === "tool" && item.id === live.id,
    );
    if (!twin) return undefined;
    const owing = LIVE_TOOL_STATUSES.has(live.status);
    if (owing && twin.status === "cancelled" && !twin.output) return undefined;
    return twin;
  }
  if (live.kind === "message" && hasLivePrefix(live.id, LIVE_MESSAGE_PREFIXES)) {
    const text = comparableRowText(live.content);
    const role = live.role;
    if (!text) return undefined;
    return items.find(
      (item): item is ChatMessage =>
        item.kind === "message" &&
        item.role === role &&
        item.id.startsWith("shared-message-") &&
        comparableRowText(item.content) === text,
    );
  }
  if (live.kind === "thought" && live.id.startsWith(LIVE_THOUGHT_PREFIX)) {
    const text = comparableRowText(live.content);
    if (!text) return undefined;
    return items.find(
      (item): item is ThoughtActivity =>
        item.kind === "thought" &&
        item.id.startsWith("shared-thought-") &&
        comparableRowText(item.content) === text,
    );
  }
  return undefined;
}

/**
 * The last row before `index` in `previous` that the durable read still carries.
 *
 * It is the boundary a live row belongs after: whatever the read holds past it was
 * recorded after the live row was streamed, so it is also what says whether the row's
 * own turn is still open.
 */
export function precedingSharedRow(
  previous: readonly TranscriptItem[],
  index: number,
  ids: ReadonlySet<string>,
): TranscriptItem | undefined {
  for (let at = index - 1; at >= 0; at -= 1) {
    const candidate = previous[at]!;
    if (ids.has(candidate.id)) return candidate;
  }
  return undefined;
}

/**
 * Waits out one read window, or ends as soon as the follower is detached.
 *
 * `detached` is created once per follower: the loop polls for as long as the session
 * stays attached, and a listener per poll would pile them onto the same signal.
 */
/** Capped exponential wait before re-issuing a tail read that failed transiently. */
export function tailRetryPause(
  detached: Promise<void>,
  failures: number,
): Promise<void> {
  const delay = Math.min(
    TAIL_RETRY_MAX_MS,
    TAIL_RETRY_BASE_MS * 2 ** Math.min(Math.max(failures - 1, 0), 5),
  );
  return Promise.race([
    new Promise<void>((resolve) => {
      setTimeout(resolve, delay);
    }),
    detached,
  ]);
}

export function tailReadPause(detached: Promise<void>): Promise<void> {
  return Promise.race([
    new Promise<void>((resolve) => {
      setTimeout(resolve, TAIL_WINDOW_MS);
    }),
    detached,
  ]);
}

/**
 * Whether the durable read records a finished assistant turn after `anchor`.
 *
 * The read is the whole session, so an older turn's reply says nothing about a row
 * streamed after it: only a terminal assistant row past the last row the live block
 * followed proves the file moved past that block's own turn. A read that shows the
 * turn over without carrying the live row's block is what retires it -- the
 * alternative is a streamed card outliving every account of it.
 */
export function durableTurnEnded(
  items: readonly TranscriptItem[],
  anchor: TranscriptItem | undefined,
): boolean {
  let start = 0;
  if (anchor) {
    // A duplicated id makes the position ambiguous; the later row is the safer
    // boundary, because it retires only what the read has clearly moved past.
    for (let at = items.length - 1; at >= 0; at -= 1) {
      if (items[at]!.id === anchor.id) {
        start = at + 1;
        break;
      }
    }
  }
  for (let at = start; at < items.length; at += 1) {
    const item = items[at]!;
    if (
      item.kind === "message" &&
      item.role === "assistant" &&
      item.streaming !== true
    )
      return true;
  }
  return false;
}

/**
 * Put rows the durable read cannot account for back into it.
 *
 * Each one goes where it was -- directly after the rebuilt row it followed -- rather
 * than at the end. A rebuild that has written past a live block would otherwise
 * render that block after newer rows, and a row that jumps position is republished
 * as though the history had been rewritten. Rows with no shared row before them are
 * the newest this window made, so they stay at the end.
 */
export function composeTranscriptRows(
  items: TranscriptItem[],
  retained: ReadonlyArray<{ row: TranscriptItem; afterId: string | undefined }>,
): TranscriptItem[] {
  if (retained.length === 0) return items;
  const pending = new Map<string, TranscriptItem[]>();
  const trailing: TranscriptItem[] = [];
  for (const { row, afterId } of retained) {
    if (afterId === undefined) {
      trailing.push(row);
      continue;
    }
    const rows = pending.get(afterId);
    if (rows) rows.push(row);
    else pending.set(afterId, [row]);
  }
  const composed = [...items];
  for (const [afterId, rows] of pending) {
    const at = composed.findIndex((item) => item.id === afterId);
    if (at < 0) trailing.push(...rows);
    else composed.splice(at + 1, 0, ...rows);
  }
  if (trailing.length > 0) composed.push(...trailing);
  return composed;
}

export function transcriptTime(value: unknown): string {
  if (typeof value !== "string") return nowLabel();
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return nowLabel();
  return CLOCK_LABEL.format(new Date(parsed));
}

export function sharedContentText(content: unknown): string {
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

export function sanitizeLocalAttachmentBlocks(text: string): string {
  return text.replace(/(<local-(?:images|files)>[\s\S]*?<\/local-(?:images|files)>)/gu, (block) =>
    block.split("\n").map((line) => {
      if (!line.startsWith("- ")) return line;
      const raw = line.slice(2).trim();
      try { return `- ${JSON.stringify(path.basename(JSON.parse(raw) as string))}`; }
      catch { return `- ${path.basename(raw)}`; }
    }).join("\n"),
  );
}

export function attachedPathsText(
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

/** Slash forms that cross the same confirmation boundary as their explicit action. */
export type DestructiveSlashAction =
  | "session-delete"
  | "compact"
  | "goal-complete"
  | "goal-drop";

/**
 * The destructive operation this message names, if any.
 *
 * The desktop IPC layer asks this before prompting, and the slash dispatcher asks
 * again before running one. Attachments already route a message to the prompt path,
 * so they are not a destructive command however the text reads.
 */
export function destructiveSlashAction(
  input: Pick<ResolvedMessageInput, "text" | "images" | "files">,
): DestructiveSlashAction | undefined {
  if (input.images?.length || input.files?.length) return undefined;
  const match = /^\/([a-z][a-z0-9-]*)(?:\s+([\s\S]*))?$/iu.exec(input.text.trim());
  if (!match?.[1]) return undefined;
  const name = match[1].toLowerCase();
  const args = match[2]?.trim() ?? "";
  if (name === "session" && args === "delete") return "session-delete";
  if (name === "compact" && !args) return "compact";
  if (name !== "goal") return undefined;
  const verb = args.split(/\s+/u)[0]?.toLowerCase();
  if (verb === "complete") return "goal-complete";
  if (verb === "drop") return "goal-drop";
  return undefined;
}

/** The confirmation copy for one destructive slash operation. */
export function destructiveSlashMessage(
  action: DestructiveSlashAction,
): string {
  switch (action) {
    case "session-delete":
      return "세션을 삭제할까요?";
    case "compact":
      return "이 세션을 압축할까요? 대화 기록이 다시 작성됩니다.";
    case "goal-complete":
      return "이 목표를 완료로 표시할까요?";
    case "goal-drop":
      return "이 목표를 삭제할까요?";
  }
}

/** Whether this message names a destructive operation. */
export function destructiveSlashCommand(
  input: Pick<ResolvedMessageInput, "text" | "images" | "files">,
): boolean {
  return destructiveSlashAction(input) !== undefined;
}

export function normalizeQueuedRequestText(text: string): string {
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
 * Structured `details` is kept as full, redacted JSON because it is the only
 * place a structured reply survives a rebuild. Nothing here interprets it: a
 * recorded result is shown as data, not classified into an activity kind.
 */
export function toolResultText(
  result: Record<string, unknown>,
  diff?: string,
): string | undefined {
  const body = typeof result.body === "string" ? result.body : "";
  const text = fullToolText(body || sharedContentText(result.content));
  const details = fullToolText(result.details);
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
export const ABANDONED_STOP_REASONS = new Set([
  "aborted",
  "cancelled",
  "canceled",
  "error",
]);

export const TERMINAL_STOP_REASONS = new Set([
  "stop",
  "end_turn",
  "aborted",
  "cancelled",
  "canceled",
  "error",
  "max_tokens",
]);

/**
 * Subagent snapshot statuses that release a launch marker.
 *
 * GJC 0.18.12 (`packages/coding-agent/src/tools/subagent.ts`) treats
 * `completed`, `failed`, and `cancelled` as terminal, and its group summary
 * counts `already_completed` with `completed`. Anything else, including an
 * unrecognized string, is not evidence the work ended.
 */
const TERMINAL_SUBAGENT_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
  "already_completed",
]);

/** Statuses that say the same subagent is still work. Last explicit one wins. */
const LIVE_SUBAGENT_STATUSES = new Set(["running", "paused", "queued"]);

function subagentIdentifiers(record: Record<string, unknown>): string[] {
  const ids: string[] = [];
  if (typeof record.id === "string" && record.id) ids.push(record.id);
  if (
    typeof record.jobId === "string" &&
    record.jobId &&
    record.jobId !== record.id
  )
    ids.push(record.jobId);
  return ids;
}

/**
 * How long a reconciliation of detached-task launch markers is trusted.
 *
 * A marker the runtime still reports as running has to be re-checked eventually:
 * a pause or cancel writes no release row, so only a later look at the job list
 * can notice that the work ended. The delay keeps that look off the poll loop.
 */
export const PENDING_ASYNC_RECONCILE_INTERVAL_MS = 15_000;

export interface PersistedTurnState {
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
export function persistedTurnState(rows: unknown[]): PersistedTurnState {
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
      message.toolName === "subagent"
    ) {
      // Explicit await/inspect results carry structured subagent snapshots.
      // Records in one result can disagree; the last explicit status for an id
      // wins, and only a status that was actually pending can be released or
      // restored. A missing id or an unrecognized status changes nothing.
      const releasedHere = new Set<string>();
      const keptLive = new Set<string>();
      if (Array.isArray(details?.subagents)) {
        for (const candidate of details.subagents) {
          if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
            continue;
          const subagent = candidate as Record<string, unknown>;
          const ids = subagentIdentifiers(subagent);
          const status = subagent.status;
          if (typeof status !== "string") continue;
          if (TERMINAL_SUBAGENT_STATUSES.has(status)) {
            for (const id of ids) {
              if (pendingAsyncJobs.delete(id)) releasedHere.add(id);
              keptLive.delete(id);
            }
          } else if (LIVE_SUBAGENT_STATUSES.has(status)) {
            for (const id of ids) {
              if (!pendingAsyncJobs.has(id) && !releasedHere.has(id)) continue;
              pendingAsyncJobs.add(id);
              keptLive.add(id);
              releasedHere.delete(id);
            }
          }
        }
      }
      // Legacy explicit await completion IDs remain authoritative, except where
      // this same result's snapshot says that id is still live.
      if (Array.isArray(details?.terminalIds)) {
        for (const jobId of details.terminalIds)
          if (typeof jobId === "string" && !keptLive.has(jobId))
            pendingAsyncJobs.delete(jobId);
      }
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

export function taskStatus(
  status: ToolActivity["status"],
): SubagentSnapshot["status"] {
  if (status === "running") return "running";
  if (status === "failed" || status === "denied") return "failed";
  if (status === "cancelled") return "failed";
  if (status === "approval-required") return "waiting";
  return "completed";
}

export function receiptSubagentStatus(
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
export function todoSnapshotRowId(sessionId: string): string {
  return `app-todo-${sessionId}`;
}

/** One runtime task row, as data. Unknown fields are dropped, never guessed. */
export function todoSnapshotTask(value: unknown): TodoSnapshotTask | undefined {
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
export interface TodoSnapshotState {
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
export function todoQueryErrorText(error: string | undefined): string {
  const line = error?.split("\n")[0]?.trim();
  return redactSensitiveText(line || "the runtime did not answer");
}

export function customMessageTitle(customType: unknown): string {
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
  // A call without a result was cancelled only if its own turn was abandoned:
  // an aborted assistant row at or after it. Deciding this once for the whole
  // history marked every in-flight call of a session that had *ever* been
  // aborted as Cancelled while it was still running. A finished turn's leftover
  // calls are already cancelled through `turnRunning === false`.
  let lastAbortedIndex = -1;
  records.forEach((row, index) => {
    const message =
      row.message &&
      typeof row.message === "object" &&
      !Array.isArray(row.message)
        ? (row.message as Record<string, unknown>)
        : row;
    if (
      message.role === "assistant" &&
      (message.stopReason === "aborted" ||
        message.stopReason === "cancelled" ||
        message.stopReason === "canceled")
    )
      lastAbortedIndex = index;
  });
  const items: TranscriptItem[] = [];
  for (const [recordIndex, row] of records.entries()) {
    const abortedTurn = lastAbortedIndex >= recordIndex;
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
          : { command: fullToolText(value.arguments) }),
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

export function agentCommands(commands: AvailableCommand[]): AgentCommand[] {
  return commands.map((command) => ({
    name: command.name,
    description: command.description ?? "",
    ...(command.input?.hint ? { hint: command.input.hint } : {}),
  }));
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

