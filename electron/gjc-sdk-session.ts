import { homedir } from "node:os";
import path from "node:path";
import { execFile as execFileCb } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { constants, realpathSync, watch, type FSWatcher, type Stats } from "node:fs";
import type {
  AgentSession,
  AgentConfigOptionValue,
} from "../shared/agent-contract.js";
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

export function readableSessionTitle(
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

/**
 * Workspace on the session envelope.
 *
 * That line is the head of the file. Opening a saved session only needs this
 * one field, so the caller passes the bounded head rather than every row.
 */
export function sessionCwdFromLines(lines: readonly string[]): string | undefined {
  for (const line of lines) {
    if (!line.trim()) continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (row.type === "session" && typeof row.cwd === "string" && row.cwd)
      return row.cwd;
  }
  return undefined;
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

