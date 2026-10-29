import type {
  MessageDelivery,
  TranscriptRequestSummary,
} from "../../shared/agent-contract";
import type {
  AgentSession,
  BackendConnection,
  MessageInput,
  TranscriptItem,
} from "../backend/types";
import type { MessageDeliverySessionState } from "../message-delivery";
import { t } from "../i18n";
import type { InvalidLinkReason } from "../../shared/settings-ipc";

export interface ShellSendOptions {
  quiet?: boolean;
  retryId?: string;
}

export type ShellSendMessage = (
  sessionId: string,
  input: MessageInput,
  options?: ShellSendOptions,
) => Promise<MessageDelivery>;

export type TranscriptPageScope =
  | { kind: "latest" }
  | { kind: "around"; id: string };

export type TranscriptPageMergeMode = "replace" | "prepend" | "tail" | "around";

export interface SessionTranscriptPageState {
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
  firstId?: string;
  lastId?: string;
  scope: TranscriptPageScope;
  loadingPage: boolean;
  pageError: string;
  loadingEarlier: boolean;
  earlierError: string;
}

export const EMPTY_TRANSCRIPT_PAGE_STATE: SessionTranscriptPageState = {
  hasMoreBefore: false,
  hasMoreAfter: false,
  scope: { kind: "latest" },
  loadingPage: false,
  pageError: "",
  loadingEarlier: false,
  earlierError: "",
};

export function reconcilePageRequestIndex(
  existing: TranscriptRequestSummary[],
  incoming: TranscriptRequestSummary[],
  eventVersions: ReadonlyMap<string, number> | undefined,
  readVersion: number,
): TranscriptRequestSummary[] {
  const existingById = new Map(existing.map((request) => [request.id, request]));
  const incomingIds = new Set(incoming.map((request) => request.id));
  const requests = incoming.map((request) =>
    (eventVersions?.get(request.id) ?? 0) > readVersion
      ? existingById.get(request.id) ?? request
      : request,
  );
  for (const request of existing) {
    if (
      !incomingIds.has(request.id) &&
      (eventVersions?.get(request.id) ?? 0) > readVersion
    )
      requests.push(request);
  }
  return requests;
}

export function lastDurableUserRequest(
  items: readonly TranscriptItem[],
): Extract<TranscriptItem, { kind: "message" }> | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!;
    if (
      item.kind === "message" &&
      item.role === "user" &&
      !item.id.startsWith("local-prompt-")
    )
      return item;
  }
  return undefined;
}

/**
 * Whether a key press is the shell's abort gesture.
 *
 * This is the whole of the shortcut's claim to Escape. It used to be read in the
 * capture phase, ahead of every handler nearer the key, so pressing Escape while
 * typing a session name cancelled the run behind the editor the user was closing.
 * The key now travels the bubble phase and each of these guards hands it back.
 */
export function escapeCancelsRun(input: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  defaultPrevented: boolean;
  textEntry: boolean;
  surfaceOpen: boolean;
}): boolean {
  if (input.key !== "Escape" && input.key !== "Esc") return false;
  if (input.metaKey || input.ctrlKey || input.altKey || input.shiftKey)
    return false;
  // A nearer handler already took the key -- the rename field consumes Escape.
  if (input.defaultPrevented) return false;
  // Typing owns Escape. The composer cancels the run from its own handler, so
  // claiming the key here as well would cancel the same run twice; an editor or a
  // dialog field only closes itself.
  if (input.textEntry) return false;
  // While a dismissible surface is up, Escape closes it and nothing else.
  if (input.surfaceOpen) return false;
  return true;
}

/**
 * Whether the key landed in a field the user is typing into.
 *
 * Duck-typed instead of `instanceof HTMLElement` so the rule stays readable and
 * testable outside a DOM.
 */
export function isTextEntryTarget(target: unknown): boolean {
  const element = target as
    | { tagName?: unknown; isContentEditable?: unknown }
    | null;
  if (!element || typeof element !== "object") return false;
  if (element.isContentEditable === true) return true;
  return (
    element.tagName === "INPUT" ||
    element.tagName === "TEXTAREA" ||
    element.tagName === "SELECT"
  );
}

/**
 * Whether a transcript still shows work in progress: something streaming, or a
 * tool mid-execution.
 *
 * Two states deliberately do NOT count, because both outlive their turn and
 * treating either as running left the composer queueing every later message
 * while the header read idle -- the message only went out after some unrelated
 * interaction: a tool card awaiting approval, and a plan entry left at
 * in_progress once the turn ended.
 */
export function transcriptHasLiveWork(transcript: readonly TranscriptItem[]): boolean {
  return transcript.some((item) => {
    if (item.kind === "message" || item.kind === "thought")
      return item.streaming === true;
    if (item.kind === "tool") return item.status === "running";
    return false;
  });
}

export function deliverySessionState(
  session: AgentSession | undefined,
  connection: BackendConnection["state"],
): MessageDeliverySessionState | undefined {
  if (!session) return undefined;
  return {
    status: session.status,
    phase: session.phase,
    attachment: session.attachment,
    connection,
  };
}

export function isNotExecutedDelivery(
  value: MessageDelivery,
): value is Extract<MessageDelivery, { kind: "not_executed" }> {
  return typeof value !== "string" && value.kind === "not_executed";
}

/**
 * Whether the composer has to treat the selected session as mid-turn.
 *
 * The session row is the runtime's own account of the run, so a terminal status
 * settles this outright. The transcript is the weaker account: a row synced while
 * a turn was open carries `streaming` on its message or thought and `running` on
 * an unresolved tool card, and nothing re-syncs that row once the turn ends, so
 * those flags outlive the work they describe. Letting them outrank an idle row
 * kept the composer on 이어서 보내기 and held every later message as a steer
 * behind a turn that was already done -- the row read 완료 while the next prompt
 * queued forever. Nothing in the transcript can date its own evidence, so the
 * stale flag and a freshly started turn look identical there; the row, which the
 * runtime advances as work begins and ends, is the only account that
 * distinguishes them.
 *
 * `starting` is the other side of that: the row exists but has not reported a
 * turn yet, so the transcript is the only account of work already underway. A
 * session with no row at all has nothing to go on.
 *
 * Compaction and a waiting approval outlive the turn that started them and have
 * no live transcript row of their own, so they are read from the row directly.
 */
export function composerTurnLive(
  // A row can arrive without a status yet (a freshly listed session), and the
  // caller then has only the transcript to go on, so the field is optional here
  // even though a fully read AgentSession always carries one.
  session: { status?: AgentSession["status"]; phase?: AgentSession["phase"] } | null,
  transcript: readonly TranscriptItem[],
): boolean {
  if (!session) return false;
  if (session.phase === "compacting") return true;
  if (session.status === "running" || session.status === "waiting") return true;
  // A terminal status is the runtime stating the turn is over. Any live-looking
  // row under it belongs to that finished turn, not to the next one.
  if (session.status === "idle" || session.status === "failed") return false;
  return transcriptHasLiveWork(transcript);
}

export function unreadBadgeCount(
  sessions: ReadonlyArray<Pick<AgentSession, "unread">>,
): number {
  return sessions.filter((session) => session.unread).length;
}

type BadgingNavigator = Navigator & {
  setAppBadge?: (contents?: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
};

/**
 * Mirrors unread sessions onto the installed PWA icon.
 *
 * The badge is what a phone can see without opening the app. Inside the desktop
 * app the same API writes the Dock badge, which the main process owns: it also
 * counts sessions waiting for input, so a renderer clear would erase those.
 * Rejection is non-fatal: a browser without the Badging API has no icon badge.
 */
export function syncAppBadge(
  count: number,
  nav: BadgingNavigator | undefined =
    typeof navigator === "undefined" ? undefined : navigator,
): void {
  if (!nav) return;
  if (typeof window !== "undefined" && window.agentControlDesktop) return;
  if (count > 0) void nav.setAppBadge?.(count).catch(() => undefined);
  else void nav.clearAppBadge?.().catch(() => undefined);
}

export function invalidLinkMessage(reason: InvalidLinkReason): string {
  if (reason.kind === "path")
    return t("링크의 경로가 없거나 폴더가 아닙니다. 절대 경로로 된 폴더여야 합니다: {path}", {
      path: reason.path,
    });
  if (reason.kind === "prompt")
    return t("링크의 첫 요청이 너무 깁니다. {limit}자까지 받을 수 있습니다.", {
      limit: reason.limit,
    });
  return t("링크가 가리키는 세션을 찾지 못했습니다.");
}
