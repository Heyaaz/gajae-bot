import { homedir } from "node:os";
import path from "node:path";
import { execFile as execFileCb } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import type {
  AgentEvent,
  AgentSession,
  AgentControlPreferences,
  ImageAttachment,
  PermissionOption,
} from "../shared/agent-contract.js";
import { DEFAULT_MODEL_PRESET } from "../shared/agent-contract.js";
import type { SessionMetadataStore } from "./session-metadata-store.js";
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
export interface ToolCallFields {
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

export interface SendMessageOptions {
  /**
   * Only the desktop renderer's confirmed path sets this. Remote control and any
   * other caller leave it unset, so a destructive slash command carried as message
   * text cannot cross the same approval boundary as the explicit action.
   */
  allowDestructive?: boolean;
}

export interface ResolvedMessageInput {
  text: string;
  images: Array<Omit<ImageAttachment, "token"> & { nativePath?: string }>;
  files: Array<Omit<import("../shared/agent-contract.js").FileAttachment, "token"> & {
    nativePath: string;
  }>;
}

export const GJC_ACCENT = "#ff8a34";
export const STARTUP_TIMEOUT_MS = 30_000;
// How many past sessions the resume picker offers. The store keeps every session
// ever recorded and each one needs a summary, but the summary is read from a
// bounded head rather than the whole transcript, so the cap is about how long a
// list stays useful to scroll rather than what it costs to build. 402 sessions
// were on disk here; 60 hid most of them behind a search box.
// How much of a session file the picker reads to title it. The title is the first
// user message and the envelope is the first line, so both are near the top. Real
// transcripts here reach 43 MB, and reading them whole to find the first message
// pulled 645 MB through memory for one list.
export const HISTORY_SUMMARY_HEAD_BYTES = 128 * 1024;
// How far back a transcript rescan looks for rows that changed in place. A turn
// settles its own recent rows; a disagreement older than this is republished as
// a whole history instead of being reconciled row by row.
export const TRANSCRIPT_RESCAN_WINDOW = 32;
/**
 * How long one `sdk session tail` reader waits inside the CLI before it answers.
 *
 * The CLI is a batch command, not a stream: it accumulates frames in-process and
 * answers when the observed turn goes idle or this window elapses. The window is
 * therefore the worst-case latency of everything it carries -- reasoning and bash
 * cards arrived in the batch that followed the window, which the user read as
 * "only when it finishes" -- so it is short enough to feel live. The trade is one
 * short-lived CLI process per poll, which the per-session follower bounds to a
 * single reader at a time; the session file watch remains the durable account, and
 * a reader that answers with no frames is paced by one window before the next read.
 *
 * What this cannot shorten is a tool's own output: the protocol carries no partial
 * tool result (`shared/agent-contract.ts` has no tool delta), so a card gained its
 * result only when the call reported one, and nothing here may invent the rest.
 */
export const TAIL_WINDOW_MS = 1_200;
/** First delay after a transient tail transport failure; doubled per failure. */
export const TAIL_RETRY_BASE_MS = 200;
/** A stalled broker is retried at this cadence instead of spawning readers hot. */
export const TAIL_RETRY_MAX_MS = 5_000;
// A create or fork whose lifecycle receipt could not be verified is looked up in
// the broker index, which only lists the new session once it settles. GJC strips
// the caller's lifecycle request id from every public list/inspect row, so the
// retained session cannot be matched by idempotency key; it is the one new live
// session in this workspace whose endpoint appeared after the request began.
export const LIFECYCLE_RECOVERY_ATTEMPTS = 20;
export const LIFECYCLE_RECOVERY_INTERVAL_MS = 250;
export const LIFECYCLE_RECOVERY_CLOCK_SLACK_MS = 2_000;
export const MAX_TOOL_TEXT = 12_000;
// How long a prompt is followed through its own record before the transcript is
// left as the only account. A turn can legitimately run for many minutes, so this
// is a ceiling on polling, not a deadline on the work: reaching it leaves the run
// alone rather than reporting it stopped.
export const PROMPT_SETTLE_ATTEMPTS = 900;
export const PROMPT_SETTLE_INTERVAL_MS = 400;
export const ATTACH_RETRY_INTERVAL_MS = 15_000;
/**
 * How long a live work signal outranks a transcript that already reads idle.
 *
 * GJC's live reports and its persisted transcript are two accounts of the same turn,
 * and the transcript is written last: for the gap between a turn starting and its
 * first row reaching disk the file still describes the previous turn, so the live
 * signal wins by default. That default is not a deadline on the evidence, though.
 * Genuine work reports far inside this window -- the attach pair arrives 0.1s apart,
 * every tool boundary emits a phase, and a prompt this window sends is tracked
 * separately -- so a signal whose reports simply stopped (a dropped stream, a report
 * consumed by a phase guard, a turn driven elsewhere that ended without one) leaves
 * the transcript as the newer account once it elapses. Measured against the
 * alternative: one stale latch kept a finished row in the working group for 16 hours.
 */
export const LIVE_EVIDENCE_GRACE_MS = 25_000;
export const EFFORT_LEVELS = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
export const execFile = promisify(execFileCb);

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
export const RUN_STATE_TAIL_BYTES = 256 * 1024;

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
export interface PendingPermission {
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

export interface GjcControllerOptions {
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
export const CLOCK_LABEL = new Intl.DateTimeFormat("en", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

export function nowLabel(): string {
  return CLOCK_LABEL.format(new Date());
}

export function recentLabel(timestamp: string | null | undefined): string {
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
export function timestampMs(timestamp: string | null | undefined): number | undefined {
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
export function markUpdated(session: AgentSession, timestamp?: string): void {
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

