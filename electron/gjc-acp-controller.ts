import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type Agent,
  type AvailableCommand,
  type Client,
  type ContentBlock,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionInfo,
  type SessionNotification,
  type SessionConfigOption,
  type SessionUpdate,
  type ToolCallStatus,
} from "@agentclientprotocol/sdk";
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
import { Readable, Writable } from "node:stream";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { execFile as execFileCb } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { constants, watch, type FSWatcher, type Stats } from "node:fs";
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
  MessageInput,
  NoticeActivity,
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
  ToolImage,
} from "../shared/agent-contract.js";
import type { SessionMetadataStore } from "./session-metadata-store.js";
import { gjcPathCandidates, runtimeEnvironment } from "./runtime-path.js";

const GJC_ACCENT = "#ff8a34";
const STARTUP_TIMEOUT_MS = 30_000;
// How many past sessions the resume picker offers. The store keeps every session
// ever recorded, and summarising each one costs a file read.
const HISTORY_SESSION_LIMIT = 60;
// How far back a transcript rescan looks for rows that changed in place. A turn
// settles its own recent rows; a disagreement older than this is republished as
// a whole history instead of being reconciled row by row.
const TRANSCRIPT_RESCAN_WINDOW = 32;
// A fork whose lifecycle receipt could not be verified is looked up in the broker
// index, which only lists the new session once it settles.
const FORK_RECOVERY_ATTEMPTS = 20;
const MAX_TOOL_TEXT = 12_000;
const ATTACH_RETRY_INTERVAL_MS = 15_000;
const MODEL_CATALOG_PAGE_LIMIT = 16;
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

interface PendingPermission {
  request: RequestPermissionRequest;
  resolve: (response: RequestPermissionResponse) => void;
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

function attachedPathsText(
  input: Pick<MessageInput, "images" | "files">,
): string {
  const files = input.files.map((file) => file.path);
  const images = input.images.flatMap((image) =>
    image.path ? [image.path] : [],
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

export function messageTextWithFiles(input: MessageInput): string {
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

/** Image parts of a tool result: inline base64 from ACP, or a content-addressed blob id. */
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

/** A persisted turn is active until an assistant message closes it with a terminal stop reason. */
export function persistedTranscriptRunning(rows: unknown[]): boolean {
  let lastUser = -1;
  let lastTerminalAssistant = -1;
  let lastActivity = -1;
  let abandoned = false;
  for (let index = 0; index < rows.length; index += 1) {
    const envelope = rows[index];
    if (!envelope || typeof envelope !== "object" || Array.isArray(envelope))
      continue;
    const value = envelope as Record<string, unknown>;
    const message =
      value.message &&
      typeof value.message === "object" &&
      !Array.isArray(value.message)
        ? (value.message as Record<string, unknown>)
        : value;
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
  if (lastActivity > lastTerminalAssistant) return true;
  return lastUser >= 0 && lastUser > lastTerminalAssistant;
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
} {
  let model: string | undefined;
  let thinking: string | undefined;
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
  }
  return { model, thinking };
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
  // A finished turn leaves its last `toolUse` call resultless in the persisted
  // file, and reporting that as running kept the composer showing stop and
  // routing every later message into a steer long after the turn ended.
  const unresolvedToolStatus: ToolActivity["status"] =
    options?.turnRunning === false ? "completed" : "running";
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
    const body =
      typeof row.body === "string" && row.body
        ? row.body
        : sharedContentText(row.content);
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
      if (row.display === false) continue;
      const content =
        typeof row.content === "string"
          ? row.content.trim()
          : sharedContentText(row.content).trim();
      if (content) {
        items.push({
          id: `shared-system-${sourceId}`,
          kind: "system",
          sessionId,
          title: customMessageTitle(row.customType),
          content,
          createdAt,
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
    const text =
      body ||
      content
        .flatMap((part) =>
          part &&
          typeof part === "object" &&
          !Array.isArray(part) &&
          (part as Record<string, unknown>).type === "text" &&
          typeof (part as Record<string, unknown>).text === "string"
            ? [String((part as Record<string, unknown>).text)]
            : [],
        )
        .join("");
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
      const output =
        result &&
        (typeof result.body === "string"
          ? result.body
          : sharedContentText(result.content));
      const diff = toolDiffText(result?.details, result);
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
    description: command.description,
    ...(command.input?.hint ? { hint: command.input.hint } : {}),
  }));
}

function configOptionValues(
  option: Extract<SessionConfigOption, { type: "select" }>,
): AgentConfigOption["options"] {
  return option.options
    .flatMap((item) => ("group" in item ? item.options : [item]))
    .map((item) => ({
      value: item.value,
      name: item.name,
      ...(item.description ? { description: item.description } : {}),
    }));
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
          currentValue: option.currentValue,
          options: configOptionValues(option),
        }
      : {
          id: option.id,
          name: option.name,
          category: option.category ?? undefined,
          type: "boolean",
          currentValue: option.currentValue,
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

function toolStatus(
  status: ToolCallStatus | null | undefined,
): ToolActivity["status"] {
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
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
  const text = error instanceof Error ? error.message : String(error);
  return /saved ACP session does not exist/iu.test(text);
}

function lifecycleUncertainError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /terminal_uncertain|lifecycle terminal evidence could not be verified|retained artifacts require reconciliation|cleanup authority is uncertain|cannot be deleted safely|requires durable locator authority|ownership is uncertain|authority is ambiguous|authority is pending/iu.test(
    text,
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
  const text = error instanceof Error ? error.message : String(error);
  return /ACP session already has an active prompt|turn\.prompt is unavailable while the agent is busy|agent is busy.*turn\.steer/iu.test(
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

// Shown when a session cannot be controlled because it never published an SDK
// endpoint. It names the fix rather than the internal reason.
export const TERMINAL_ONLY_CONTROL_MESSAGE =
  "터미널에서 실행 중인 세션이라 앱에서 제어할 수 없습니다. Gajae에서 새 세션을 만들어 주세요.";

// A session that never published an SDK endpoint cannot be controlled at all: the
// Router attaches through that endpoint record, so there is nothing to attach to.
// A plain `gjc --resume` in a terminal is the usual case -- it is alive and
// heartbeating, which is why it appears in the session list, but it exposes no
// control surface. The broker reports this as session_unavailable.
export function sessionUnreachableError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /session_unavailable|unavailable through the session Router|no current Router attachment|provider_lease_conflict/iu.test(
    text,
  );
}

export function sdkControlNeedsBrokerFallback(
  response: Record<string, unknown>,
): boolean {
  const error =
    response.error &&
    typeof response.error === "object" &&
    !Array.isArray(response.error)
      ? (response.error as Record<string, unknown>)
      : undefined;
  const text = `${typeof error?.code === "string" ? error.code : ""} ${typeof error?.message === "string" ? error.message : ""}`;
  // A busy agent is the right target on a live connection. Spawning the broker
  // CLI for it costs seconds before the message reaches the queue, which is the
  // opposite of what steering needs.
  if (busyPromptError(text)) return false;
  return /not_found|unknown session|no current Router attachment|provider_lease_conflict|unavailable/iu.test(
    text,
  );
}

export function sessionInfoToAgentSession(info: SessionInfo): AgentSession {
  return {
    id: info.sessionId,
    title: readableSessionTitle(info.sessionId, info.title),
    subtitle: path.basename(info.cwd) || info.cwd,
    workspace: info.cwd,
    runtime: "gjc",
    status: "idle",
    updatedAt: recentLabel(info.updatedAt),
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

export function isControllerSession(
  session: { repo?: string; endpointGeneration?: number; pid?: number },
  childPid: number | undefined,
): boolean {
  if (childPid !== undefined && session.pid === childPid) return true;
  // A generation-0 endpoint is a control placeholder with no attachable turn and
  // no transcript. Discovery reaches every repository now, so these are filtered
  // everywhere instead of only inside this app's own workspace.
  return (session.endpointGeneration ?? 0) <= 0;
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

export class GjcAcpController {
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
  // Sessions the live ACP signal currently reports as working. The persisted
  // transcript lags behind that signal, so it is not allowed to report one of
  // these idle until GJC itself says the turn ended.
  private readonly liveRunningSessions = new Set<string>();
  // Transcript size at the moment the live signal reported work, keyed by session.
  // Anything at that size is the snapshot the signal already superseded; a larger
  // file is a newer account.
  private readonly liveRunningDigests = new Map<string, number>();
  /** How long an ACP cancel gets to settle the turn before escalating. */
  private cancelSettleMs = 4000;
  /** Delay between broker polls while recovering a fork's session id. */
  private forkRecoveryIntervalMs = 250;
  /** How long the escalated session abort gets to settle the turn. */
  private cancelEscalationMs = 6000;
  private readonly sessionCommands = new Map<string, AgentCommand[]>();
  private readonly sessionConfig = new Map<string, AgentConfigOption[]>();
  private readonly terminalOnlySessions = new Set<string>();
  private readonly modelProfiles = new Map<string, AgentConfigOptionValue[]>();
  private readonly explicitSessionThinking = new Map<string, string>();
  private readonly pendingPermissions = new Map<string, PendingPermission>();
  private readonly artifactWrites = new Map<string, Promise<void>>();
  private readonly sharedSessionFiles = new Map<string, string>();
  // A transcript is append-only, so a rescan only has to parse the bytes added
  // since the last one. Device/inode identify the file so a compaction that
  // rewrites or truncates it is detected and falls back to a full parse.
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
  private child?: ChildProcessWithoutNullStreams;
  private connection?: ClientSideConnection;
  private startup?: Promise<void>;
  private disposed = false;
  private nextLocalId = 1;
  private generation = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private reconnectAttempt = 0;

  constructor(options: GjcControllerOptions) {
    this.workspace = path.resolve(options.workspace);
    this.configuredExecutable = options.executable;
    this.modelPreset = options.modelPreset ?? "codex-medium";
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
      });
    }
    return { ...this.connectionState };
  }

  async reconfigure(preferences: AgentControlPreferences): Promise<boolean> {
    const workspace = path.resolve(preferences.workspace);
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
    const child = this.child;
    this.child = undefined;
    this.connection = undefined;
    this.startup = undefined;
    this.attachedSessions.clear();
    this.activePromptSessions.clear();
    this.liveRunningSessions.clear();
    this.liveRunningDigests.clear();
    this.compactingSessions.clear();
    this.compactionRecordBaseline.clear();
    this.activeAssistantMessages.clear();
    this.activeThoughts.clear();
    this.suppressedUserMessageKeys.clear();
    this.echoedPromptTexts.clear();
    child?.kill("SIGTERM");
    await this.ensureStarted();
    return true;
  }

  async listSessions(): Promise<AgentSession[]> {
    // Discovery is a background refresh that shares one ACP channel with the
    // user's own requests. Running it while a prompt, steer, or abort is in
    // flight puts those behind a full session scan, so it yields and the caller
    // keeps the list it already has.
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
    const connection = await this.requireConnection();
    const liveRanks = new Map<string, number>();
    const controlSessionIds = new Set<string>();
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
    const brokerRows = await this.brokerSessions(connection);
    // Without the index there is no liveness or placeholder evidence, so the
    // previous result stands rather than republishing every historical session.
    if (!brokerRows)
      return this.lastDiscovered.map((session) => ({ ...session }));
    for (const session of brokerRows) {
      if (
        isControllerSession(session, this.child?.pid) &&
        this.sessionMetadata?.getOwnership(session.sessionId) !== "gajae"
      ) {
        controlSessionIds.add(session.sessionId);
        continue;
      }
      if (!session.live) {
        // The broker keeps every historical session id. Only live ones can be
        // controlled or replayed from here, so a dead id must not become a row.
        deadSessionIds.add(session.sessionId);
        continue;
      }
      const attachable = (session.endpointGeneration ?? 0) > 0;
      liveRanks.set(session.sessionId, attachable ? 2 : 1);
      if (!attachable) this.terminalOnlySessions.add(session.sessionId);
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
    const liveFingerprint = JSON.stringify([
      [...liveRanks.entries()].sort(),
      workspaces.slice().sort(),
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
          const sessions: SessionInfo[] = [];
          let cursor: string | null | undefined;
          do {
            const response = await connection.listSessions({
              cwd,
              ...(cursor ? { cursor } : {}),
            });
            sessions.push(...response.sessions);
            cursor = response.nextCursor;
          } while (cursor);
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
      .filter((session) => !controlSessionIds.has(session.sessionId))
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
      // Session discovery only carries identity/cwd metadata. Replacing the whole row
      // here erased model, thinking, context usage, phase, and status that transcript
      // replay had just restored, so the UI drifted again after every list refresh.
      const session = {
        ...existing,
        ...listedSession,
        status: existing?.status ?? "idle",
        phase: existing?.phase,
        mode: existing?.mode,
        model: existing?.model,
        modelDisplay: existing?.modelDisplay,
        thinking: existing?.thinking,
        usagePercent: existing?.usagePercent,
        usagePending: existing?.usagePending,
        ownership,
        attachment,
        unread:
          this.sessionMetadata?.getUnread(info.sessionId) ??
          existing?.unread ??
          false,
        worktree: this.sessionMetadata?.getWorktree(info.sessionId),
      };
      session.title =
        this.sessionMetadata?.getAlias(session.id) ?? session.title;
      this.sessions.set(session.id, session);
      this.sessionCwds.set(session.id, info.cwd);
    }

    this.lastDiscovered = listed.map((info) => ({
      ...this.sessions.get(info.sessionId)!,
    }));
    return this.lastDiscovered.map((session) => ({ ...session }));
  }

  /** Undefined when the broker index could not be read in full. */
  private async brokerSessions(connection: ClientSideConnection): Promise<
    | Array<{
        sessionId: string;
        repo?: string;
        live: boolean;
        endpointGeneration?: number;
        pid?: number;
      }>
    | undefined
  > {
    const sessions: Array<{
      sessionId: string;
      repo?: string;
      live: boolean;
      endpointGeneration?: number;
      pid?: number;
    }> = [];
    let cursor: string | undefined;
    // 749 sessions at 100 per page is 8 pages. The broker keeps only 32 cursors
    // for 15 minutes each, so a walk that stops early (page cap, error, throw)
    // strands one and a few polls exhaust the pool, taking session.list down for
    // everyone. The pool is the shared resource, so the walk is always drained.
    const drain = async (token: string): Promise<void> => {
      let next: string | undefined = token;
      for (let page = 0; page < 4096 && next; page += 1) {
        try {
          const response = await connection.extMethod("_gjc/sdk/global", {
            operation: "session.list",
            input: { cursor: next, limit: 100 },
          });
          if (response.ok === false) return;
          const result =
            response.result &&
            typeof response.result === "object" &&
            !Array.isArray(response.result)
              ? (response.result as Record<string, unknown>)
              : response;
          next =
            typeof result.continuationCursor === "string"
              ? result.continuationCursor
              : undefined;
        } catch {
          return;
        }
      }
    };
    try {
      for (let page = 0; page < 4096; page += 1) {
        const response = await connection.extMethod("_gjc/sdk/global", {
          operation: "session.list",
          // 100 is the broker's maximum page size. Every unfinished walk strands a
          // continuation cursor for 15 minutes and the broker only holds 32, so a
          // scan must always be drained to its final page.
          input: { ...(cursor ? { cursor } : {}), limit: 100 },
        });
        // Liveness classification comes only from this index. An empty result on
        // failure reads as "nothing is dead", which republishes every historical
        // session as a row, so an incomplete scan is reported as unusable instead.
        if (response.ok === false) {
          if (cursor) await drain(cursor);
          return undefined;
        }
        const result =
          response.result &&
          typeof response.result === "object" &&
          !Array.isArray(response.result)
            ? (response.result as Record<string, unknown>)
            : response;
        for (const value of Array.isArray(result.sessions)
          ? result.sessions
          : []) {
          if (!value || typeof value !== "object" || Array.isArray(value))
            continue;
          const candidate = value as {
            sessionId?: unknown;
            live?: unknown;
            endpointGeneration?: unknown;
            pid?: unknown;
            locator?: { repo?: unknown };
          };
          if (typeof candidate.sessionId !== "string") continue;
          sessions.push({
            sessionId: candidate.sessionId,
            repo:
              typeof candidate.locator?.repo === "string"
                ? candidate.locator.repo
                : undefined,
            live: candidate.live === true,
            endpointGeneration:
              typeof candidate.endpointGeneration === "number"
                ? candidate.endpointGeneration
                : undefined,
            pid: typeof candidate.pid === "number" ? candidate.pid : undefined,
          });
        }
        cursor =
          typeof result.continuationCursor === "string"
            ? result.continuationCursor
            : undefined;
        if (!cursor) break;
      }
      if (cursor) await drain(cursor);
      return sessions;
    } catch {
      if (cursor) await drain(cursor);
      return undefined;
    }
  }

  async createSession(input: CreateSessionInput): Promise<AgentSession> {
    if (input.runtime !== "gjc")
      throw new Error("The GJC controller only creates GJC sessions");
    const connection = await this.requireConnection();
    let sessionWorkspace = path.resolve(input.workspace);
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
      ...((await this.brokerSessions(connection)) ?? []).map(
        (session) => session.sessionId,
      ),
    ]);
    let response;
    try {
      response = await connection.newSession({
        cwd: sessionWorkspace,
        mcpServers: [],
      });
    } catch (error) {
      if (lifecycleUncertainError(error)) {
        for (let attempt = 0; attempt < 20 && !response; attempt += 1) {
          const retained = (await this.brokerSessions(connection))?.find(
            (session) =>
              !knownSessionIds.has(session.sessionId) &&
              session.live &&
              (session.endpointGeneration ?? 0) > 0 &&
              session.repo !== undefined &&
              path.resolve(session.repo) === sessionWorkspace,
          );
          if (retained) {
            try {
              this.sessionCwds.set(retained.sessionId, sessionWorkspace);
              this.transcripts.set(retained.sessionId, []);
              this.messageKeys.set(retained.sessionId, new Map());
              const loaded = await connection.loadSession({
                sessionId: retained.sessionId,
                cwd: sessionWorkspace,
                mcpServers: [],
              });
              this.attachedSessions.add(retained.sessionId);
              response = { sessionId: retained.sessionId, ...loaded };
              break;
            } catch {
              this.sessionCwds.delete(retained.sessionId);
              this.transcripts.delete(retained.sessionId);
              this.messageKeys.delete(retained.sessionId);
            }
          }
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      }
      if (!response && worktree) {
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
      if (!response && lifecycleUncertainError(error)) {
        throw new Error(
          "GJC가 세션을 생성했지만 lifecycle 영수증을 검증하지 못했습니다. 보존된 세션 자동 복구에도 실패했습니다. GJC lifecycle ledger reconciliation이 필요합니다.",
        );
      }
      if (!response) throw error;
    }
    const session: AgentSession = {
      id: response.sessionId,
      title: input.title?.trim() || "New Gajae session",
      subtitle: path.basename(sessionWorkspace) || sessionWorkspace,
      workspace: sessionWorkspace,
      runtime: "gjc",
      status: "idle",
      updatedAt: "now",
      pinned: false,
      unread: false,
      accent: GJC_ACCENT,
      ownership: "gajae",
      attachment: "attached",
      ...(worktree ? { worktree } : {}),
    };
    this.sessions.set(session.id, session);
    this.sessionCwds.set(session.id, sessionWorkspace);
    this.attachedSessions.add(session.id);
    this.transcripts.set(session.id, []);
    this.messageKeys.set(session.id, new Map());
    this.captureSessionState(
      session.id,
      response.configOptions ?? [],
      response.modes?.currentModeId,
    );
    await this.refreshModelProfiles(session.id);
    void this.refreshContextUsage(session.id);
    this.sessionMetadata?.setAlias(session.id, session.title);
    this.sessionMetadata?.setWorkspace(session.id, sessionWorkspace);
    this.sessionMetadata?.setOwnership(session.id, "gajae");
    if (worktree) this.sessionMetadata?.setWorktree(session.id, worktree);
    this.emitEvent({ type: "session.created", session: { ...session } });
    return { ...session };
  }

  async renameSession(sessionId: string, title: string): Promise<void> {
    const value = title.trim();
    if (!value) throw new Error("Session title cannot be empty");
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown GJC session: ${sessionId}`);
    this.sessionMetadata?.setAlias(sessionId, value);
    session.title = value;
    session.updatedAt = "now";
    this.emitEvent({ type: "session.updated", session: { ...session } });
  }

  async getTranscript(sessionId: string): Promise<TranscriptItem[]> {
    // Opening a session attaches it, which is what reports its real preset, thinking
    // level, and mode. Waiting for the first prompt to attach is what left a restarted
    // app showing the app-wide default preset instead of the session's own.
    if (
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
    const externallyDriven = !this.activePromptSessions.has(sessionId);
    if (this.terminalOnlySessions.has(sessionId) || externallyDriven) {
      try {
        const shared = await this.readSharedTranscript(sessionId);
        if (shared.length > 0) {
          this.transcripts.set(sessionId, shared);
          return shared.map(cloneTranscriptItem);
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
    const connection = await this.requireConnection();
    const rows: unknown[] = [];
    let cursor: string | undefined;
    for (let pageIndex = 0; pageIndex < 128; pageIndex += 1) {
      const response = await connection.extMethod("_gjc/sdk/query", {
        sessionId,
        query: "transcript.list",
        input: {},
        ...(cursor ? { cursor } : {}),
      });
      if (response.ok === false)
        throw new Error("Shared transcript is unavailable");
      const page =
        response.page &&
        typeof response.page === "object" &&
        !Array.isArray(response.page)
          ? (response.page as Record<string, unknown>)
          : response;
      if (Array.isArray(page.items)) rows.push(...page.items);
      cursor =
        typeof page.continuationCursor === "string"
          ? page.continuationCursor
          : typeof page.cursor === "string"
            ? page.cursor
            : undefined;
      if (page.complete === true || !cursor) break;
    }
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

    if (reusable && info.size === previous.size)
      return previous.envelopes.slice();

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
        this.sharedTranscriptReads.set(filePath, {
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
    this.sharedTranscriptReads.set(filePath, {
      device,
      inode,
      size: info.size,
      envelopes,
      partial,
    });
    return envelopes.slice();
  }

  private async readPersistedTranscript(
    sessionId: string,
  ): Promise<TranscriptItem[] | undefined> {
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
      const turnRunning =
        persistedTranscriptRunning(envelopes) ||
        this.activePromptSessions.has(sessionId);
      // A transcript that has not changed since the live signal reported work is the
      // same snapshot that signal already superseded, so it carries no news. Once the
      // file grows and still reports no active turn, it has observed the work end and
      // becomes the newer account. A terminal-owned session never sends
      // gjcRunning:false, so this is the only evidence its turn ended.
      const seenSize = this.liveRunningDigests.get(sessionId);
      const transcriptAdvanced =
        seenSize !== undefined && info.size !== seenSize;
      const items = sharedTranscriptItems(sessionId, rows, { turnRunning });
      await this.resolveToolImages(items);
      const effectiveModel = persistedModelState(envelopes);
      if (effectiveModel.model || effectiveModel.thinking) {
        this.patchSessionRuntime(sessionId, effectiveModel);
      }
      // A terminal-owned session gets no live phase report, so the transcript is the
      // only place its finished compaction is recorded.
      if (this.compactingSessions.has(sessionId)) {
        const baseline = this.compactionRecordBaseline.get(sessionId) ?? 0;
        if (compactionRecordCount(envelopes) > baseline) {
          this.compactingSessions.delete(sessionId);
          this.compactionRecordBaseline.delete(sessionId);
          this.patchSessionRuntime(sessionId, { phase: undefined });
        }
      }
      if (!this.activePromptSessions.has(sessionId)) {
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
          if (
            transcriptAdvanced ||
            !this.liveRunningSessions.has(sessionId)
          ) {
            this.liveRunningSessions.delete(sessionId);
            this.liveRunningDigests.delete(sessionId);
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
                this.transcripts.set(sessionId, items);
                this.publishTranscriptSync(sessionId, previousItems, items);
                // External terminal sessions do not publish ACP usage_update events to
                // this renderer. Re-query after transcript changes so the first response
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
        "This direct terminal session is visible here but does not expose an attachable ACP endpoint. Continue it in the terminal.",
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
    const connection = await this.requireConnection();
    try {
      await this.ensureAttached(sessionId, false);
      const response = await connection.setSessionConfigOption({
        sessionId,
        configId,
        value,
      });
      this.captureSessionState(sessionId, response.configOptions);
    } catch (error) {
      if (sessionUnreachableError(error)) {
        this.markTerminalOnly(sessionId);
        throw new Error(TERMINAL_ONLY_CONTROL_MESSAGE);
      }
      throw error;
    }
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

  /**
   * Counts the compactions already recorded on disk. A read failure returns 0 so a
   * later record still clears the phase; the alternative is an indicator that never
   * goes away.
   */
  private async persistedCompactionCount(sessionId: string): Promise<number> {
    try {
      const filePath = await this.locateSharedTranscriptFile(sessionId);
      if (!filePath) return 0;
      const info = await stat(filePath);
      return compactionRecordCount(
        await this.readTranscriptEnvelopes(filePath, info),
      );
    } catch {
      return 0;
    }
  }

  async compactSession(sessionId: string): Promise<void> {
    // Compaction is a session control operation, not an ACP provider attachment.
    // Terminal-owned sessions must route through the persistent control plane (or
    // broker fallback) instead of being rejected for lacking a second attachment.
    const statusBefore = this.sessions.get(sessionId)?.status;
    this.compactingSessions.add(sessionId);
    this.compactionRecordBaseline.set(
      sessionId,
      await this.persistedCompactionCount(sessionId),
    );
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
    input: MessageInput,
  ): void {
    const echoes = this.echoedPromptTexts.get(sessionId) ?? [];
    echoes.push(normalizeQueuedRequestText(text));
    this.echoedPromptTexts.set(sessionId, echoes);
    const message: ChatMessage = {
      id: `local-prompt-${this.nextLocalId++}`,
      kind: "message",
      sessionId,
      role: "user",
      content: text,
      ...(input.images?.length ? { images: input.images } : {}),
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
    input: MessageInput,
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

  async queueFollowUp(sessionId: string, input: MessageInput): Promise<void> {
    const text = messageTextWithFiles(input);
    if (!text) throw new Error("Follow-up text is required");
    const connection = await this.requireConnection();
    try {
      await this.ensureAttached(sessionId, false);
    } catch {
      /* terminal owns the attachment */
    }
    const response = await connection.extMethod("_gjc/sdk/control", {
      sessionId,
      operation: "turn.follow_up",
      input: { text },
    });
    if (response.ok === false || response.accepted === false) {
      if (response.ok === false && sdkControlNeedsBrokerFallback(response)) {
        await this.brokerControl(sessionId, "turn.follow_up", { text });
        return;
      }
      const error =
        response.error &&
        typeof response.error === "object" &&
        !Array.isArray(response.error)
          ? (response.error as { message?: unknown })
          : undefined;
      throw new Error(
        typeof error?.message === "string"
          ? error.message
          : "GJC follow-up queue rejected the message",
      );
    }
  }

  private async brokerControl(
    sessionId: string,
    operation:
      | "turn.prompt"
      | "turn.steer"
      | "turn.follow_up"
      | "turn.abort"
      | "turn.abort_and_prompt"
      | "queue.message.remove"
      | "compaction.run"
      | "mode.goal.operate"
      | "thinking.set"
      | "thinking.cycle"
      | "model.profile.set",
    input: Record<string, unknown>,
    idempotencyKeyOverride?: string,
  ): Promise<Record<string, unknown> | undefined> {
    const executable = await this.resolveExecutable();
    const repo = this.sessionCwds.get(sessionId) ?? this.workspace;
    const idempotencyKey =
      idempotencyKeyOverride ??
      (operation === "turn.abort" && input.mode === "terminal"
        ? `gajae-abort-${randomUUID()}`
        : undefined);
    let result: { stdout: string };
    try {
      result = await execFile(
        executable,
        [
          "sdk",
          "session",
          "raw",
          "control",
          sessionId,
          "--op",
          operation,
          "--json-input",
          JSON.stringify(input),
          ...(idempotencyKey ? ["--idempotency-key", idempotencyKey] : []),
          ...(operation === "turn.abort" && input.operator === true
            ? ["--confirm"]
            : []),
          "--repo",
          repo,
          "--timeout-ms",
          "8000",
        ],
        { cwd: repo, env: runtimeEnvironment(), maxBuffer: 1024 * 1024 },
      );
    } catch (error) {
      throw new Error(brokerFailureMessage(error));
    }
    let response: Record<string, unknown>;
    try {
      response = JSON.parse(result.stdout) as Record<string, unknown>;
    } catch {
      throw new Error(`GJC ${operation} broker response was not valid JSON`);
    }
    if (response.ok === false) {
      const error =
        response.error &&
        typeof response.error === "object" &&
        !Array.isArray(response.error)
          ? (response.error as { message?: unknown })
          : undefined;
      throw new Error(
        typeof error?.message === "string"
          ? error.message
          : `GJC ${operation} broker control failed`,
      );
    }
    return (response.result ?? undefined) as
      Record<string, unknown> | undefined;
  }

  private async controlSession(
    sessionId: string,
    operation:
      | "turn.prompt"
      | "turn.steer"
      | "turn.abort"
      | "turn.abort_and_prompt"
      | "queue.message.remove"
      | "compaction.run"
      | "mode.goal.operate"
      | "thinking.set"
      | "thinking.cycle"
      | "model.profile.set",
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown> | undefined> {
    const connection = this.connection;
    if (connection && !connection.signal.aborted) {
      try {
        const response = await connection.extMethod("_gjc/sdk/control", {
          sessionId,
          operation,
          input,
        });
        if (response.ok !== false && response.accepted !== false) {
          return response.result &&
            typeof response.result === "object" &&
            !Array.isArray(response.result)
            ? (response.result as Record<string, unknown>)
            : response;
        }
        if (response.ok === false && !sdkControlNeedsBrokerFallback(response)) {
          const error =
            response.error &&
            typeof response.error === "object" &&
            !Array.isArray(response.error)
              ? (response.error as { message?: unknown })
              : undefined;
          throw new Error(
            typeof error?.message === "string"
              ? error.message
              : `GJC ${operation} failed`,
          );
        }
      } catch (error) {
        if (busyPromptError(error)) throw error;
        if (
          error instanceof Error &&
          error.message.startsWith(`GJC ${operation}`)
        )
          throw error;
        if (uncertainAfterSendError(error)) return undefined;
      }
    }
    try {
      return await this.brokerControl(sessionId, operation, input);
    } catch (error) {
      // Every control operation ends here, so a session with no SDK endpoint is
      // reported once, in terms the user can act on, instead of each caller
      // surfacing the broker's "unavailable through the session Router".
      if (sessionUnreachableError(error)) {
        this.markTerminalOnly(sessionId);
        throw new Error(TERMINAL_ONLY_CONTROL_MESSAGE);
      }
      throw error;
    }
  }

  async listQueuedMessages(sessionId: string): Promise<QueuedMessage[]> {
    try {
      const connection = await this.requireConnection();
      const queued: QueuedMessage[] = [];
      let cursor: string | undefined;
      for (let pageIndex = 0; pageIndex < 16; pageIndex += 1) {
        const response = await connection.extMethod("_gjc/sdk/query", {
          sessionId,
          query: "queue.messages.list",
          input: {},
          ...(cursor ? { cursor } : {}),
        });
        if (response.ok === false)
          return await this.brokerQueuedMessages(sessionId);
        const page =
          response.page &&
          typeof response.page === "object" &&
          !Array.isArray(response.page)
            ? (response.page as Record<string, unknown>)
            : response;
        for (const row of Array.isArray(page.items) ? page.items : []) {
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
        cursor =
          typeof page.continuationCursor === "string"
            ? page.continuationCursor
            : undefined;
        if (page.complete === true || !cursor) break;
      }
      return queued;
    } catch {
      try {
        return await this.brokerQueuedMessages(sessionId);
      } catch {
        return [];
      }
    }
  }

  private async brokerQueuedMessages(
    sessionId: string,
  ): Promise<QueuedMessage[]> {
    const executable = await this.resolveExecutable();
    const repo = this.sessionCwds.get(sessionId) ?? this.workspace;
    const result = await execFile(
      executable,
      [
        "sdk",
        "session",
        "raw",
        "query",
        sessionId,
        "--query",
        "queue.messages.list",
        "--json-input",
        "{}",
        "--repo",
        repo,
        "--timeout-ms",
        "8000",
      ],
      { cwd: repo, env: runtimeEnvironment(), maxBuffer: 1024 * 1024 },
    );
    const response = JSON.parse(result.stdout) as {
      page?: { items?: unknown[] };
    };
    return (response.page?.items ?? []).flatMap((row): QueuedMessage[] => {
      if (!row || typeof row !== "object" || Array.isArray(row)) return [];
      const value = row as Record<string, unknown>;
      if (typeof value.id !== "string" || typeof value.text !== "string")
        return [];
      const mode = value.mode === "steer" ? "steer" : "followUp";
      return [
        {
          id: value.id,
          text: value.text,
          mode,
          label: mode === "steer" ? "Steer" : "Queued",
        },
      ];
    });
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
      await this.controlSession(sessionId, "turn.abort", {});
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

  async sendMessage(
    sessionId: string,
    input: MessageInput,
  ): Promise<MessageDelivery> {
    this.locallyAbortedSessions.delete(sessionId);
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
    if (this.sessionMetadata && session?.ownership !== "gajae") {
      // Spawning the broker CLI costs seconds, so the bubble and the running
      // status are published first. The prompt text is echoed once here and the
      // steer fallback below reuses it instead of echoing a second time.
      this.appendLocalUserMessage(sessionId, promptText, input);
      this.updateSessionStatus(sessionId, "running");
      try {
        await this.brokerControl(sessionId, "turn.prompt", {
          text: promptText,
          clientRef: `gajae-prompt-${randomUUID()}`,
        });
      } catch (error) {
        if (!busyPromptError(error)) throw error;
        await this.brokerControl(sessionId, "turn.steer", {
          text: promptText,
          clientRef: `gajae-steer-${randomUUID()}`,
        });
        return "steer";
      }
      return "prompt";
    }
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
      const connection = await this.requireConnection();
      await this.ensureAttached(sessionId, false);
      await connection.prompt({
        sessionId,
        prompt: [{ type: "text" as const, text: promptText }],
      });
      this.finalizeThought(sessionId);
      this.finalizeAssistantMessage(sessionId);
      await this.refreshContextUsage(sessionId);
      // updateSessionStatus announces the running -> idle transition itself.
      this.updateSessionStatus(sessionId, "idle");
    } catch (error) {
      if (busyPromptError(error)) {
        this.activePromptSessions.delete(sessionId);
        await this.steerSession(
          sessionId,
          { ...input, text: bare },
          { echo: false },
        );
        return "steer";
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

  async cancelRun(sessionId: string): Promise<void> {
    if (this.cancellingSessions.has(sessionId)) return;
    this.cancellingSessions.add(sessionId);
    this.finalizeThought(sessionId);
    this.finalizeAssistantMessage(sessionId);
    this.finalizeAllMessages(sessionId);
    this.cancelOpenTools(sessionId);
    this.cancelPermissionsForSession(sessionId);
    this.appendCancelledNotice(sessionId);
    this.locallyAbortedSessions.add(sessionId);
    // The user ended this turn, so clearing the live flags stops a late report
    // about it from putting the row back to running.
    this.liveRunningSessions.delete(sessionId);
    this.liveRunningDigests.delete(sessionId);
    this.compactingSessions.delete(sessionId);
    this.compactionRecordBaseline.delete(sessionId);
    this.updateSessionStatus(sessionId, "idle");
    await this.fireAbort(sessionId);
    this.cancellingSessions.delete(sessionId);
  }

  private async fireAbort(sessionId: string): Promise<void> {
    const connection = this.connection;
    const idempotencyKey = `gajae-abort-${randomUUID()}`;
    const terminal = {
      mode: "terminal" as const,
      scope: "owned" as const,
      operator: true as const,
    };
    if (connection && !connection.signal.aborted) {
      if (this.activePromptSessions.has(sessionId)) {
        void connection
          .cancel({
            sessionId,
            _meta: { gjc: { abortScope: "owned" } },
          })
          .catch(() => undefined);
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      let response: unknown;
      try {
        response = await Promise.race([
          connection.extMethod("_gjc/sdk/control", {
            sessionId,
            operation: "turn.abort",
            input: { ...terminal, confirm: true, idempotencyKey },
          }),
          new Promise<undefined>((resolve) => {
            timer = setTimeout(() => resolve(undefined), 750);
          }),
        ]);
      } catch {
        response = undefined;
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (this.abortControlResult(response)?.turn === "stopped") return;
    }
    this.fireBrokerAbort(sessionId, terminal, idempotencyKey);
  }

  private fireBrokerAbort(
    sessionId: string,
    terminal: { mode: "terminal"; scope: "owned"; operator: true },
    idempotencyKey: string,
  ): void {
    void this.brokerControl(sessionId, "turn.abort", terminal, idempotencyKey);
    void this.brokerControl(sessionId, "turn.abort", {});
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

  private async abortOwnedThroughControl(
    sessionId: string,
  ): Promise<Record<string, unknown>> {
    const idempotencyKey = `gajae-abort-${randomUUID()}`;
    const connection = this.connection;
    if (connection && !connection.signal.aborted) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let directResponse: unknown;
      try {
        directResponse = await Promise.race([
          connection.extMethod("_gjc/sdk/control", {
            sessionId,
            operation: "turn.abort",
            input: {
              mode: "terminal",
              scope: "owned",
              operator: true,
              confirm: true,
              idempotencyKey,
            },
          }),
          new Promise<undefined>((resolve) => {
            timer = setTimeout(() => resolve(undefined), 750);
          }),
        ]);
      } catch {
        directResponse = undefined;
      } finally {
        if (timer) clearTimeout(timer);
      }
      const directResult = this.abortControlResult(directResponse);
      if (directResult?.turn === "stopped") return directResult;
    }
    // Terminal abort is session-scoped: it cancels the current turn and exact owned
    // background work without signalling or closing the GJC session process.
    let result: Record<string, unknown> | undefined;
    try {
      result = await this.brokerControl(
        sessionId,
        "turn.abort",
        {
          mode: "terminal",
          scope: "owned",
          operator: true,
        },
        idempotencyKey,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        !/Unknown turn\.abort terminal field: operator|operator terminal abort/iu.test(
          message,
        )
      )
        throw error;
      result = undefined;
    }
    if (result?.turn === "stopped") return result;
    // A TUI-hosted session (`gjc`, `gjc --resume`) never exposes an active-prompt
    // handle to the SDK terminal-abort seam, so terminal mode is structurally a
    // no-op there and answers `no_active_turn` even mid-turn. Its plain abort is
    // the same `session.abort()` the TUI's own Esc runs, so fall back to it.
    return await this.abortThroughSessionAbort(sessionId);
  }

  /** Resolves once the app-owned prompt leaves the active set, i.e. the turn ended. */
  private async promptSettled(
    sessionId: string,
    timeoutMs: number,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (this.activePromptSessions.has(sessionId)) {
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return true;
  }

  private async abortThroughSessionAbort(
    sessionId: string,
  ): Promise<Record<string, unknown>> {
    const result = await this.brokerControl(sessionId, "turn.abort", {});
    if (result?.aborted === true) return result;
    throw new Error(
      `GJC가 작업 중지를 확정하지 못했습니다. 응답: ${JSON.stringify(result ?? null)}`,
    );
  }

  private abortControlResult(
    value: unknown,
  ): Record<string, unknown> | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return undefined;
    const record = value as Record<string, unknown>;
    if (
      record.result &&
      typeof record.result === "object" &&
      !Array.isArray(record.result)
    ) {
      return record.result as Record<string, unknown>;
    }
    return record;
  }

  private async bestEffortCancel(
    operation: Promise<unknown>,
    timeoutMs = 750,
  ): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation.then(
          () => true,
          () => false,
        ),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async resolveToolCall(toolId: string, decision: ToolDecision): Promise<void> {
    const pending = this.pendingPermissions.get(toolId);
    if (!pending)
      throw new Error(`No pending permission for tool call ${toolId}`);
    const option = pending.request.options.find(
      (candidate) => candidate.optionId === decision.optionId,
    );
    if (!option)
      throw new Error(`Unknown permission option ${decision.optionId}`);
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
    const file = path.join(this.artifactDirectory, `${artifactId}.json`);
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
      const connection = await this.requireConnection();
      await this.ensureAttached(sessionId, false);
      const chunks: Buffer[] = [];
      let offset = 0;
      let complete = false;
      while (!complete) {
        const response = await connection.extMethod("_gjc/sdk/query", {
          sessionId,
          query: "artifact.read",
          input: { artifactId, offset, length: 256 * 1024 },
        });
        if (response.ok === false) {
          const error = response.error as { message?: unknown } | undefined;
          throw new Error(
            typeof error?.message === "string"
              ? error.message
              : `Artifact ${artifactId} is unavailable`,
          );
        }
        const result =
          response.result &&
          typeof response.result === "object" &&
          !Array.isArray(response.result)
            ? (response.result as Record<string, unknown>)
            : response;
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
  ): Promise<unknown[]> {
    const connection = await this.requireConnection();
    const items: unknown[] = [];
    let cursor: string | undefined;
    for (let pageIndex = 0; pageIndex < 32; pageIndex += 1) {
      const response = await connection.extMethod("_gjc/sdk/query", {
        sessionId,
        query,
        input: {},
        ...(cursor ? { cursor } : {}),
      });
      if (response.ok === false) return [];
      const page =
        response.page &&
        typeof response.page === "object" &&
        !Array.isArray(response.page)
          ? (response.page as Record<string, unknown>)
          : response;
      if (Array.isArray(page.items)) items.push(...page.items);
      cursor =
        typeof page.continuationCursor === "string"
          ? page.continuationCursor
          : undefined;
      if (!cursor || page.complete === true) break;
    }
    return items;
  }

  async getGoal(sessionId: string): Promise<GoalSnapshot> {
    const [goalRows, todoRows] = await Promise.all([
      this.querySessionItems(sessionId, "goal.list/get"),
      this.querySessionItems(sessionId, "todo.list"),
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
    const tasks = todoRows
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
    return {
      enabled,
      ...(enabled &&
      (status === "active" || status === "paused" || status === "complete")
        ? { mode: status }
        : {}),
      ...(enabled && typeof goal?.objective === "string"
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

  async listSubagents(sessionId: string): Promise<SubagentSnapshot[]> {
    const declaredById = new Map<string, SubagentSnapshot>();
    for (const agent of (this.transcripts.get(sessionId) ?? []).flatMap(
      (item) => (item.kind === "tool" ? (item.subagents ?? []) : []),
    ))
      declaredById.set(agent.id, agent);
    const declared = [...declaredById.values()];
    const rows = await this.querySessionItems(sessionId, "runtime.jobs.list");
    const jobs = rows
      .flatMap((row) =>
        row && typeof row === "object" && !Array.isArray(row)
          ? [row as Record<string, unknown>]
          : [],
      )
      .filter((job) =>
        /subagent|task/iu.test(String(job.kind ?? job.type ?? job.name ?? "")),
      )
      .map((job, index): SubagentSnapshot => {
        const rawStatus = String(
          job.status ?? job.state ?? "running",
        ).toLowerCase();
        const status: SubagentSnapshot["status"] = /fail|error|cancel/iu.test(
          rawStatus,
        )
          ? "failed"
          : /complete|done|success/iu.test(rawStatus)
            ? "completed"
            : /wait|block|pause/iu.test(rawStatus)
              ? "waiting"
              : "running";
        return {
          id: String(job.id ?? job.jobId ?? `job-${index}`),
          label: String(
            job.label ??
              job.name ??
              job.role ??
              job.description ??
              "서브 에이전트",
          ),
          status,
          ...(typeof job.detail === "string"
            ? { detail: job.detail }
            : typeof job.description === "string"
              ? { detail: job.description }
              : {}),
        };
      });
    if (declared.length === 0) return jobs;
    const jobById = new Map(jobs.map((job) => [job.id, job]));
    return declared.map((agent) => {
      const live = jobById.get(agent.id);
      return live
        ? {
            ...agent,
            ...live,
            label: agent.label,
            role: agent.role,
            objective: agent.objective,
          }
        : agent;
    });
  }

  async getDiff(sessionId: string): Promise<DiffSnapshot> {
    const workspace = this.sessionCwds.get(sessionId) ?? this.workspace;
    try {
      const connection = await this.requireConnection();
      await this.ensureAttached(sessionId, false);
      const files: DiffSnapshot["files"] = [];
      let cursor: string | undefined;
      for (let i = 0; i < 32; i += 1) {
        const response = await connection.extMethod("_gjc/sdk/query", {
          sessionId,
          query: "diff.list_files",
          input: {},
          ...(cursor ? { cursor } : {}),
        });
        const page =
          response.page && typeof response.page === "object"
            ? (response.page as Record<string, unknown>)
            : response;
        const rows = Array.isArray(page.items) ? page.items : [];
        for (const row of rows)
          if (row && typeof row === "object") {
            const value = row as Record<string, unknown>;
            if (typeof value.path === "string")
              files.push({
                id: typeof value.id === "string" ? value.id : value.path,
                path: value.path,
                patch: typeof value.body === "string" ? value.body : "",
              });
          }
        cursor =
          typeof page.continuationCursor === "string"
            ? page.continuationCursor
            : undefined;
        if (!cursor || page.complete === true) break;
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
    const connection = await this.requireConnection();
    await this.ensureAttached(sessionId, false);
    const query = async (name: string): Promise<unknown[]> => {
      const items: unknown[] = [];
      let cursor: string | undefined;
      for (let pageIndex = 0; pageIndex < 32; pageIndex += 1) {
        const response = await connection.extMethod("_gjc/sdk/query", {
          sessionId,
          query: name,
          input: {},
          ...(cursor ? { cursor } : {}),
        });
        if (response.ok === false) return items;
        if (response.result !== undefined) items.push(response.result);
        const page =
          response.page &&
          typeof response.page === "object" &&
          !Array.isArray(response.page)
            ? (response.page as {
                items?: unknown;
                continuationCursor?: unknown;
                complete?: unknown;
              })
            : undefined;
        if (Array.isArray(page?.items)) items.push(...page.items);
        cursor =
          typeof page?.continuationCursor === "string"
            ? page.continuationCursor
            : undefined;
        if (page?.complete === true || !cursor) break;
      }
      return items;
    };
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
    const child = this.child;
    this.child = undefined;
    this.connection = undefined;
    this.startup = undefined;
    this.attachedSessions.clear();
    this.generation += 1;
    child?.kill("SIGTERM");
    await this.ensureStarted();
    await this.recoverOwnedSessions();
    return { ...this.connectionState };
  }

  async deleteSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    try {
      if (!session || session.ownership === "gajae") {
        const connection = await this.requireConnection();
        try {
          await connection.deleteSession({ sessionId });
        } catch (error) {
          if (!missingSessionError(error))
            await this.brokerLifecycleDelete(sessionId);
        }
      } else {
        await this.brokerLifecycleDelete(sessionId);
      }
    } catch (error) {
      if (missingSessionError(error) || missingLifecycleSessionError(error)) {
        this.removeLocalSession(sessionId, false);
        return;
      }
      if (liveSessionDeleteError(error)) {
        throw new Error(
          "실행 중인 세션은 삭제할 수 없습니다. 해당 GJC 프로세스를 종료한 뒤 다시 시도하세요.",
        );
      }
      if (lifecycleUncertainError(error)) {
        throw new Error(
          "GJC가 세션을 종료·삭제하지 못했습니다. 세션이 아직 실행 중이거나 삭제 권한이 불확실합니다.",
        );
      }
      throw error;
    }
    this.removeLocalSession(sessionId, false);
  }

  private async brokerLifecycleDelete(sessionId: string): Promise<void> {
    try {
      await this.brokerLifecycle("session.close", { sessionId });
    } catch (error) {
      if (
        !missingLifecycleSessionError(error) &&
        !lifecycleUncertainError(error) &&
        !liveSessionDeleteError(error)
      )
        throw error;
    }
    if (await this.sessionIsLive(sessionId)) {
      throw new Error(
        "실행 중인 세션은 삭제할 수 없습니다. 해당 GJC 프로세스를 종료한 뒤 다시 시도하세요.",
      );
    }
    const cwd = this.sessionCwds.get(sessionId) ?? this.workspace;
    const sessionPath = await this.locateSharedTranscriptFile(sessionId);
    if (!sessionPath) return;
    try {
      await this.brokerLifecycle("session.delete", {
        sessionId,
        cwd,
        stateRoot: path.join(cwd, ".gjc", "state"),
        sessionPath,
      });
    } catch (error) {
      if (missingLifecycleSessionError(error) || missingSessionError(error))
        return;
      if (await this.sessionIsLive(sessionId)) throw error;
      if (lifecycleUncertainError(error) || liveSessionDeleteError(error)) {
        await this.removeSessionFiles(sessionId, sessionPath);
        return;
      }
      throw error;
    }
  }

  private async sessionIsLive(sessionId: string): Promise<boolean> {
    const connection = this.connection;
    if (!connection || connection.signal.aborted) return false;
    try {
      const listed = await this.brokerSessions(connection);
      return (
        listed?.some(
          (session) => session.sessionId === sessionId && session.live,
        ) ?? false
      );
    } catch {
      return false;
    }
  }

  private async removeSessionFiles(
    sessionId: string,
    sessionPath: string,
  ): Promise<void> {
    if (!sessionPath.endsWith(`_${sessionId}.jsonl`)) {
      throw new Error("세션 파일 경로가 세션 ID와 일치하지 않습니다.");
    }
    await rm(sessionPath, { force: true });
    if (sessionPath.endsWith(".jsonl")) {
      await rm(sessionPath.slice(0, -".jsonl".length), {
        recursive: true,
        force: true,
      });
    }
    this.sharedSessionFiles.delete(sessionId);
    this.sharedTranscriptReads.delete(sessionPath);
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
        const match = (await readdir(directory, { withFileTypes: true })).find(
          (entry) => entry.isFile() && entry.name.endsWith(suffix),
        );
        if (!match) continue;
        filePath = path.join(directory, match.name);
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
    const executable = await this.resolveExecutable();
    const sessionId =
      typeof input.sessionId === "string" ? input.sessionId : undefined;
    const repo =
      (sessionId ? this.sessionCwds.get(sessionId) : undefined) ??
      this.workspace;
    let result: { stdout: string };
    try {
      result = await execFile(
        executable,
        [
          "sdk",
          "session",
          "raw",
          "global",
          "--op",
          operation,
          "--json-input",
          JSON.stringify(input),
          "--idempotency-key",
          `gajae-${operation}-${randomUUID()}`,
          "--repo",
          repo,
          "--confirm",
        ],
        { cwd: repo, env: runtimeEnvironment(), maxBuffer: 1024 * 1024 },
      );
    } catch (error) {
      throw new Error(brokerFailureMessage(error));
    }
    try {
      const response = JSON.parse(result.stdout) as {
        ok?: unknown;
        error?: { message?: unknown };
      };
      if (response.ok === false) {
        throw new Error(
          typeof response.error?.message === "string"
            ? response.error.message
            : `GJC ${operation} failed`,
        );
      }
    } catch (error) {
      if (error instanceof SyntaxError)
        throw new Error(`GJC ${operation} response was not valid JSON`);
      throw error;
    }
  }

  private removeLocalSession(sessionId: string, hide: boolean): void {
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
    this.compactingSessions.delete(sessionId);
    this.compactionRecordBaseline.delete(sessionId);
    this.suppressedUserMessageKeys.delete(sessionId);
    this.echoedPromptTexts.delete(sessionId);
    this.locallyAbortedSessions.delete(sessionId);
    this.sessionCommands.delete(sessionId);
    this.sessionConfig.delete(sessionId);
    this.terminalOnlySessions.delete(sessionId);
    this.modelProfiles.delete(sessionId);
    this.explicitSessionThinking.delete(sessionId);
    this.sharedSessionWatchers.get(sessionId)?.close();
    this.sharedSessionWatchers.delete(sessionId);
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
    this.child?.kill("SIGTERM");
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.child = undefined;
    this.connection = undefined;
    this.startup = undefined;
    this.sessions.clear();
    this.sessionCwds.clear();
    this.attachedSessions.clear();
    this.transcripts.clear();
    this.messageKeys.clear();
    this.activeAssistantMessages.clear();
    this.activeThoughts.clear();
    this.activePromptSessions.clear();
    this.liveRunningSessions.clear();
    this.liveRunningDigests.clear();
    this.compactingSessions.clear();
    this.compactionRecordBaseline.clear();
    this.suppressedUserMessageKeys.clear();
    this.echoedPromptTexts.clear();
    this.sessionCommands.clear();
    this.sessionConfig.clear();
    this.terminalOnlySessions.clear();
    this.modelProfiles.clear();
    this.explicitSessionThinking.clear();
    this.artifactWrites.clear();
    for (const watcher of this.sharedSessionWatchers.values()) watcher.close();
    for (const timer of this.sharedSessionRefreshTimers.values())
      clearTimeout(timer);
    this.sharedSessionWatchers.clear();
    this.sharedSessionRefreshTimers.clear();
  }

  private async ensureStarted(): Promise<void> {
    if (this.connection && !this.connection.signal.aborted) return;
    if (this.startup) return this.startup;
    if (this.disposed) throw new Error("GJC controller is disposed");

    this.startup = this.start().finally(() => {
      this.startup = undefined;
    });
    return this.startup;
  }

  private async start(): Promise<void> {
    const generation = ++this.generation;
    this.setConnection({
      state: "connecting",
      backend: "gjc",
      label: "GJC",
      detail: "Starting ACP runtime",
      workspace: this.workspace,
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
    const child = spawn(
      executable,
      [
        "--mode=acp",
        "--mpreset",
        this.modelPreset,
        ...(profileThinking ? ["--thinking", profileThinking] : []),
      ],
      {
        cwd: this.workspace,
        env: runtimeEnvironment({
          GJC_ACP_PERMISSION_MODE: this.permissionHandling,
        }),
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    this.child = child;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      const text = chunk.trim();
      if (text) console.error(`[gjc] ${redactSensitiveText(text)}`);
    });
    child.once("exit", (code, signal) => {
      if (this.child !== child || generation !== this.generation) return;
      this.child = undefined;
      this.connection = undefined;
      this.attachedSessions.clear();
      this.activePromptSessions.clear();
      this.liveRunningSessions.clear();
      this.liveRunningDigests.clear();
      this.compactingSessions.clear();
      this.compactionRecordBaseline.clear();
      this.activeAssistantMessages.clear();
      this.activeThoughts.clear();
        this.suppressedUserMessageKeys.clear();
      this.echoedPromptTexts.clear();
      for (const session of this.sessions.values()) {
        session.attachment = "recovering";
        session.status = "failed";
        this.emitEvent({ type: "session.updated", session: { ...session } });
      }
      this.cancelAllPermissions();
      if (!this.disposed) {
        this.setConnection({
          state: "disconnected",
          backend: "gjc",
          label: "GJC disconnected",
          detail: signal
            ? `Exited with ${signal}`
            : `Exited with code ${code ?? "unknown"}`,
          workspace: this.workspace,
        });
        this.scheduleReconnect();
      }
    });

    const stream = ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    );
    const connection = new ClientSideConnection(
      (_agent: Agent): Client => ({
        requestPermission: (request) => this.requestPermission(request),
        sessionUpdate: (notification) => this.handleSessionUpdate(notification),
      }),
      stream,
    );
    this.connection = connection;

    const initialization = connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientInfo: { name: "Gajae", version: "0.1.0" },
      clientCapabilities: {
        terminal: false,
        fs: { readTextFile: false, writeTextFile: false },
        _meta: { gjc: { permissionHandling: this.permissionHandling } },
      },
    });
    const response = await Promise.race([
      initialization,
      new Promise<never>((_resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("GJC ACP initialization timed out")),
          STARTUP_TIMEOUT_MS,
        );
        initialization
          .finally(() => clearTimeout(timer))
          .catch(() => undefined);
      }),
    ]);
    this.setConnection({
      state: "connected",
      backend: "gjc",
      label: response.agentInfo?.name || "GJC",
      detail: `ACP connected · ${this.modelPreset}`,
      workspace: this.workspace,
      version: response.agentInfo?.version,
      generation,
    });
    this.reconnectAttempt = 0;
    queueMicrotask(() => {
      void this.recoverOwnedSessions();
    });
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
    const connection = this.connection;
    if (!connection || connection.signal.aborted) return;
    for (const session of this.sessions.values()) {
      if (
        session.ownership !== "gajae" ||
        this.attachedSessions.has(session.id)
      )
        continue;
      const cwd = this.sessionCwds.get(session.id);
      if (!cwd) continue;
      try {
        const response = await connection.resumeSession({
          sessionId: session.id,
          cwd,
          mcpServers: [],
        });
        this.captureSessionState(
          session.id,
          response.configOptions ?? [],
          response.modes?.currentModeId,
        );
        await this.refreshModelProfiles(session.id);
        this.attachedSessions.add(session.id);
        session.attachment = "attached";
        session.status = "idle";
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

  private async requireConnection(): Promise<ClientSideConnection> {
    await this.ensureStarted();
    if (!this.connection || this.connection.signal.aborted)
      throw new Error("GJC ACP connection is unavailable");
    return this.connection;
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
    let connection: ClientSideConnection | undefined;
    try {
      connection = await this.requireConnection();
    } catch {
      // Liveness is decoration here; the files still list fine without it.
    }
    const liveIds = new Set(
      ((connection ? await this.brokerSessions(connection) : undefined) ?? [])
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
      let summary: ReturnType<typeof historySessionSummary>;
      try {
        const text = await readFile(file.path, "utf8");
        summary = historySessionSummary(text.split("\n"));
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

  private async ensureAttached(
    sessionId: string,
    replay: boolean,
  ): Promise<void> {
    if (this.attachedSessions.has(sessionId)) return;
    const connection = await this.requireConnection();
    const cwd = this.sessionCwds.get(sessionId) ?? this.workspace;
    if (replay) {
      this.transcripts.set(sessionId, []);
      this.messageKeys.set(sessionId, new Map());
      const response = await connection.loadSession({
        sessionId,
        cwd,
        mcpServers: [],
      });
      this.captureSessionState(
        sessionId,
        response.configOptions ?? [],
        response.modes?.currentModeId,
      );
      await this.refreshModelProfiles(sessionId);
      this.finalizeAllMessages(sessionId);
    } else {
      const response = await connection.resumeSession({
        sessionId,
        cwd,
        mcpServers: [],
      });
      this.captureSessionState(
        sessionId,
        response.configOptions ?? [],
        response.modes?.currentModeId,
      );
      await this.refreshModelProfiles(sessionId);
    }
    this.attachedSessions.add(sessionId);
    const session = this.sessions.get(sessionId);
    if (session) {
      session.attachment = "attached";
      if (session.status === "failed") session.status = "idle";
      this.emitEvent({ type: "session.updated", session: { ...session } });
    }
    void this.refreshContextUsage(sessionId);
  }

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
        const commands = agentCommands(update.availableCommands);
        this.sessionCommands.set(sessionId, commands);
        this.emitEvent({ type: "session.commands", sessionId, commands });
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
        ? `acp-thought-${update.messageId}`
        : `acp-thought-${this.nextLocalId++}`,
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
      id: existing?.id ?? `acp-plan-${this.nextLocalId++}`,
      kind: "plan",
      sessionId,
      entries: entries.map((entry) => ({
        content: entry.content,
        status: entry.status,
      })),
      createdAt: existing?.createdAt ?? nowLabel(),
    };
    if (existing) Object.assign(existing, plan);
    else this.appendTranscript(plan);
    this.emitEvent({
      type: "plan.updated",
      plan: { ...plan, entries: plan.entries.map((entry) => ({ ...entry })) },
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
   * ACP resume advertises the preset the ACP agent process was launched with, not the
   * preset the session itself runs. Only the session-scoped SDK config answers that, so
   * a restored session reports its own model instead of the app-wide default.
   */
  private async refreshSessionSettings(sessionId: string): Promise<void> {
    try {
      const connection = await this.requireConnection();
      const response = await connection.extMethod("_gjc/sdk/query", {
        sessionId,
        query: "config.list/get",
        input: {},
      });
      if (response.ok === false) return;
      const page =
        response.page &&
        typeof response.page === "object" &&
        !Array.isArray(response.page)
          ? (response.page as { items?: unknown })
          : undefined;
      const row = (Array.isArray(page?.items) ? page.items : []).find(
        (item): item is Record<string, unknown> =>
          Boolean(item) && typeof item === "object" && !Array.isArray(item),
      );
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
      if (!preset && !thinking && !mode) return;
      const current = this.sessions.get(sessionId);
      this.patchSessionRuntime(sessionId, {
        ...(preset ? { model: preset } : {}),
        ...(thinking ? { thinking } : {}),
        ...(mode ? { mode } : {}),
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
      const connection = await this.requireConnection();
      const response = await connection.extMethod("_gjc/sdk/query", {
        sessionId,
        query: "models.profiles.list",
        input: {},
      });
      const page =
        response.page &&
        typeof response.page === "object" &&
        !Array.isArray(response.page)
          ? (response.page as { items?: unknown })
          : undefined;
      const items = Array.isArray(page?.items) ? page.items : [];
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
      // The active session remains usable with ACP's initial model options when discovery is unavailable.
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
      const connection = await this.requireConnection();
      const items: unknown[] = [];
      let cursor: string | undefined;
      for (
        let pageIndex = 0;
        pageIndex < MODEL_CATALOG_PAGE_LIMIT;
        pageIndex += 1
      ) {
        const response = await connection.extMethod("_gjc/sdk/query", {
          sessionId,
          query: "models.list/current",
          input: {},
          ...(cursor ? { cursor } : {}),
        });
        const page =
          response.page &&
          typeof response.page === "object" &&
          !Array.isArray(response.page)
            ? (response.page as {
                items?: unknown;
                complete?: unknown;
                continuationCursor?: unknown;
              })
            : undefined;
        if (Array.isArray(page?.items)) items.push(...page.items);
        const nextCursor =
          typeof page?.continuationCursor === "string"
            ? page.continuationCursor
            : undefined;
        if (page?.complete === true || !nextCursor) break;
        cursor = nextCursor;
      }
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
   * Every transcript write asked for this, and the query shares one ACP channel
   * with the user's prompt, steer, and abort. Several subagents writing at once
   * queued the user's own requests behind a burst of usage lookups, so a request
   * that arrives while one is running joins it instead of adding another.
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
      const connection = await this.requireConnection();
      const response = await connection.extMethod("_gjc/sdk/query", {
        sessionId,
        query: "context.get",
        input: {},
      });
      const page =
        response.page &&
        typeof response.page === "object" &&
        !Array.isArray(response.page)
          ? (response.page as { items?: unknown })
          : undefined;
      const first = Array.isArray(page?.items) ? page.items[0] : undefined;
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
        ? imageFromContent(update.content, `acp-image-${this.nextLocalId++}`)
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
      ? `acp-message-${update.messageId}`
      : `acp-message-${this.nextLocalId++}`;
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
      void this.persistArtifact(id, update.rawInput).catch((error) =>
        console.error(`Failed to persist tool input artifact ${id}`, error),
      );
    }
    if (update.rawOutput !== undefined || update.content !== undefined) {
      const id = `${sessionId}-${update.toolCallId}-output`.replace(
        /[^A-Za-z0-9._-]/g,
        "_",
      );
      patch.outputArtifactId = id;
      void this.persistArtifact(id, update.rawOutput ?? update.content).catch(
        (error) =>
          console.error(`Failed to persist tool output artifact ${id}`, error),
      );
    }
    if (existing) {
      Object.assign(existing, patch);
      this.emitEvent({ type: "tool.updated", tool: { ...existing } });
    } else {
      this.appendTranscript(patch);
    }
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
    artifactId: string,
    value: unknown,
  ): Promise<void> {
    const text = redactSensitiveText(
      typeof value === "string" ? value : JSON.stringify(value, null, 2),
    );
    const file = path.join(this.artifactDirectory, `${artifactId}.json`);
    const previous = this.artifactWrites.get(artifactId) ?? Promise.resolve();
    const operation = previous
      .catch(() => undefined)
      .then(async () => {
        await mkdir(this.artifactDirectory, { recursive: true });
        const temporary = `${file}.${process.pid}.${this.nextLocalId++}.tmp`;
        await writeFile(temporary, JSON.stringify({ text }), { mode: 0o600 });
        await rename(temporary, file);
      });
    this.artifactWrites.set(artifactId, operation);
    try {
      await operation;
    } finally {
      if (this.artifactWrites.get(artifactId) === operation)
        this.artifactWrites.delete(artifactId);
    }
  }

  private requestPermission(
    request: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    const { toolCall } = request;
    this.upsertTool(request.sessionId, {
      sessionUpdate: "tool_call_update",
      ...toolCall,
      status: toolCall.status ?? "pending",
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
    if (update.updatedAt) session.updatedAt = recentLabel(update.updatedAt);
    const phase =
      typeof update._meta?.gjcPhase === "string"
        ? update._meta.gjcPhase
        : undefined;
    const running = update._meta?.gjcRunning;
    if (phase === "compacting") {
      session.phase = "compacting";
      this.compactingSessions.add(sessionId);
      if (!this.locallyAbortedSessions.has(sessionId))
        session.status = "running";
    } else if (phase) {
      // GJC reporting any other phase is the authority that compaction ended, so
      // this is where a locally started compaction is released. Returning from the
      // control call only meant the request was accepted.
      if (phase === "responding" || phase === "idle")
        this.compactingSessions.delete(sessionId);
        this.compactionRecordBaseline.delete(sessionId);
      session.phase =
        phase === "responding" || phase === "idle" ? undefined : phase;
    }
    if (running === true && !this.locallyAbortedSessions.has(sessionId)) {
      session.status = "running";
      if (!this.liveRunningSessions.has(sessionId)) {
        this.liveRunningSessions.add(sessionId);
        // Record how much transcript existed when the work was reported, so a later
        // read can tell an unchanged stale snapshot from one that watched it end.
        void this.rememberLiveRunningTranscriptSize(sessionId);
      }
    }
    // A prompt this window sent owns the status until its own round trip settles,
    // because GJC reports gjcRunning:false for the state *before* the prompt was
    // accepted. Telling the two apart needs one bit of history: a stale report
    // arrives without GJC ever having confirmed the turn started, while a genuine
    // completion always follows a gjcRunning:true for that same turn. Ignoring
    // every report instead left the row running forever whenever the prompt never
    // got its reply.
    const staleForActivePrompt =
      this.activePromptSessions.has(sessionId) &&
      !this.liveRunningSessions.has(sessionId);
    if (
      running === false &&
      session.status !== "failed" &&
      !staleForActivePrompt &&
      !this.compactingSessions.has(sessionId)
    ) {
      // A turn this window did not start -- a steer, or work driven from the
      // terminal -- ends here rather than in sendMessage, so this is where its
      // completion is announced. A cancel is excluded: the user performed it and
      // is already watching, so announcing it is noise.
      const wasRunning = session.status === "running";
      session.status = "idle";
      this.liveRunningSessions.delete(sessionId);
      this.liveRunningDigests.delete(sessionId);
      this.compactingSessions.delete(sessionId);
      this.compactionRecordBaseline.delete(sessionId);
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
    const connection = await this.requireConnection();
    await this.ensureAttached(source.id, false);
    type ForkConnection = ClientSideConnection & {
      unstable_forkSession(args: {
        sessionId: string;
        cwd: string;
        mcpServers: [];
      }): Promise<{
        sessionId: string;
        configOptions?: SessionConfigOption[];
        modes?: { currentModeId?: string | null };
      }>;
    };
    // The fork itself is what creates the session; the lifecycle receipt is only
    // the evidence that it was recorded. A receipt that cannot be verified was
    // reported as a failed fork even though the broker had already created the
    // session -- which is why discovery listed it moments later. The broker index
    // is the authority on whether that happened, so it is consulted instead of
    // surfacing an error for a fork that succeeded.
    const knownSessionIds = new Set([
      ...this.sessions.keys(),
      ...((await this.brokerSessions(connection)) ?? []).map(
        (listed) => listed.sessionId,
      ),
    ]);
    let response;
    try {
      response = await (connection as ForkConnection).unstable_forkSession({
        sessionId: source.id,
        cwd,
        mcpServers: [],
      });
    } catch (error) {
      if (!lifecycleUncertainError(error)) throw error;
      response = await this.recoverForkedSession(
        connection,
        cwd,
        knownSessionIds,
      );
      if (!response)
        throw new Error(
          "GJC가 세션을 포크했지만 lifecycle 영수증을 검증하지 못했습니다. 보존된 포크 자동 복구에도 실패했습니다. GJC lifecycle ledger reconciliation이 필요합니다.",
        );
    }
    const session: AgentSession = {
      id: response.sessionId,
      title: input.title?.trim() || `${source.title} (fork)`,
      subtitle: path.basename(cwd) || cwd,
      workspace: cwd,
      runtime: "gjc",
      status: "idle",
      updatedAt: "now",
      pinned: false,
      unread: false,
      accent: GJC_ACCENT,
      ownership: "gajae",
      attachment: "attached",
    };
    this.sessions.set(session.id, session);
    this.sessionCwds.set(session.id, cwd);
    this.attachedSessions.add(session.id);
    this.captureSessionState(
      session.id,
      response.configOptions ?? [],
      response.modes?.currentModeId,
    );
    this.sessionMetadata?.setAlias(session.id, session.title);
    this.sessionMetadata?.setWorkspace(session.id, cwd);
    this.sessionMetadata?.setOwnership(session.id, "gajae");
    this.emitEvent({ type: "session.created", session: { ...session } });
    return { ...session };
  }

  /**
   * The session a fork created, recovered from the broker index when the fork's
   * own lifecycle receipt could not be verified. Undefined when no new session
   * for this workspace appears, which means the fork really did not happen.
   */
  private async recoverForkedSession(
    connection: ClientSideConnection,
    cwd: string,
    knownSessionIds: ReadonlySet<string>,
  ): Promise<
    | {
        sessionId: string;
        configOptions?: SessionConfigOption[];
        modes?: { currentModeId?: string | null };
      }
    | undefined
  > {
    const workspace = path.resolve(cwd);
    for (let attempt = 0; attempt < FORK_RECOVERY_ATTEMPTS; attempt += 1) {
      const retained = (await this.brokerSessions(connection))?.find(
        (listed) =>
          !knownSessionIds.has(listed.sessionId) &&
          listed.live &&
          (listed.endpointGeneration ?? 0) > 0 &&
          listed.repo !== undefined &&
          path.resolve(listed.repo) === workspace,
      );
      if (retained) {
        this.sessionCwds.set(retained.sessionId, workspace);
        this.transcripts.set(retained.sessionId, []);
        this.messageKeys.set(retained.sessionId, new Map());
        try {
          const loaded = await connection.loadSession({
            sessionId: retained.sessionId,
            cwd: workspace,
            mcpServers: [],
          });
          this.attachedSessions.add(retained.sessionId);
          return {
            sessionId: retained.sessionId,
            ...(loaded.configOptions
              ? { configOptions: loaded.configOptions }
              : {}),
            ...(loaded.modes ? { modes: loaded.modes } : {}),
          };
        } catch {
          this.sessionCwds.delete(retained.sessionId);
          this.transcripts.delete(retained.sessionId);
          this.messageKeys.delete(retained.sessionId);
        }
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
    const result = await execFile(
      "git",
      ["-C", workspace, "status", "--porcelain=v1", "-z", "--branch"],
      { maxBuffer: 2 * 1024 * 1024 },
    );
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
      session.status = status;
      session.updatedAt = "now";
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
