import type { FileAttachment, ImageAttachment } from "../shared/agent-contract";

const LOCAL_COMPOSER_COMMANDS = new Set([
  "steer",
  "queue",
  "abort",
  "compact",
  "new",
  "model",
  "effort",
]);

export function isImmediateSdkCommandSubmission(
  content: string,
  commands: readonly { name: string }[],
  hasAttachments: boolean,
): boolean {
  if (hasAttachments) return false;
  const name = /^\/([^\s]+)(?:\s|$)/u.exec(content.trim())?.[1]?.toLowerCase();
  return (
    name !== undefined &&
    !name.startsWith("skill:") &&
    !LOCAL_COMPOSER_COMMANDS.has(name) &&
    commands.some((command) => command.name.toLowerCase() === name)
  );
}

export interface CompactText {
  text: string;
  omittedLines: number;
  truncated: boolean;
  fullText: string;
}

function textFromStructured(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const parts = value
      .map(textFromStructured)
      .filter((part): part is string => Boolean(part));
    return parts.length > 0 ? parts.join("\n") : undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.text === "string") return record.text;
  for (const key of ["content", "output", "result", "value"]) {
    const text = textFromStructured(record[key]);
    if (text) return text;
  }
  return undefined;
}

export function readableToolText(raw: string): string {
  const value = raw.trim();
  if (!value) return "";
  try {
    return textFromStructured(JSON.parse(value)) ?? value;
  } catch {
    return value;
  }
}

export function compactToolText(
  raw: string,
  maxLines = 10,
  maxCharacters = 1800,
): CompactText {
  const fullText = readableToolText(raw).replace(/\r\n?/g, "\n").trim();
  const lines = fullText.split("\n");
  const omittedLines = Math.max(0, lines.length - maxLines);
  let text = omittedLines > 0 ? lines.slice(-maxLines).join("\n") : fullText;
  let truncated = omittedLines > 0;
  if (text.length > maxCharacters) {
    text = `${text.slice(0, Math.floor(maxCharacters * 0.58)).trimEnd()}\n…\n${text.slice(-Math.floor(maxCharacters * 0.38)).trimStart()}`;
    truncated = true;
  }
  return { text, omittedLines, truncated, fullText };
}

export function compactToolCommand(
  raw: string,
  maxCharacters = 260,
): { preview: string; fullText: string; truncated: boolean } {
  const value = raw.trim();
  let fullText = value;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const command = (parsed as Record<string, unknown>).command;
      if (typeof command === "string") fullText = command;
    }
  } catch {
    // Keep the original command text.
  }
  const normalized = fullText.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxCharacters)
    return { preview: normalized, fullText, truncated: false };
  return {
    preview: `${normalized.slice(0, maxCharacters - 1).trimEnd()}…`,
    fullText,
    truncated: true,
  };
}

const IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_MESSAGE_IMAGES = 6;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

export async function droppedImageAttachments(
  files: readonly File[],
  existingCount: number,
): Promise<ImageAttachment[]> {
  if (files.length === 0) return [];
  if (existingCount + files.length > MAX_MESSAGE_IMAGES)
    throw new Error("Attach at most 6 images per message");
  return Promise.all(
    files.map(async (file, index) => {
      if (!IMAGE_MIME_TYPES.has(file.type))
        throw new Error(
          `${file.name} is not a supported PNG, JPEG, WebP, or GIF image`,
        );
      if (file.size > MAX_IMAGE_BYTES)
        throw new Error(`${file.name} exceeds the 10 MB image limit`);
      return {
        id: `drop-${Date.now()}-${index}`,
        name: file.name,
        mimeType: file.type,
        data: bytesToBase64(new Uint8Array(await file.arrayBuffer())),
      };
    }),
  );
}

export function resolveModelPreset(
  query: string,
  options: ReadonlyArray<{ value: string; name?: string }> | undefined,
): string | undefined {
  const needle = query
    .trim()
    .replace(/^gajae-code\//iu, "")
    .toLowerCase();
  if (!needle || !options?.length) return undefined;
  const exact = options.find((option) => {
    const value = option.value.replace(/^gajae-code\//iu, "").toLowerCase();
    const name = option.name?.toLowerCase();
    return value === needle || name === needle;
  });
  if (exact) return exact.value;
  const prefixed = options.filter((option) => {
    const value = option.value.replace(/^gajae-code\//iu, "").toLowerCase();
    const name = option.name?.toLowerCase() ?? "";
    return value.startsWith(needle) || name.startsWith(needle);
  });
  return prefixed.length === 1 ? prefixed[0]?.value : undefined;
}
export function composerQueuePreview(
  content: string,
  files: ReadonlyArray<{ name: string }>,
  images: ReadonlyArray<{ name: string }>,
): { text: string; mode: "steer" | "followUp" } {
  const explicitSteer = /^\/steer(?:\s+|$)/u.test(content);
  const text =
    content.replace(/^\/(?:steer|queue)(?:\s+|$)/u, "").trim() ||
    [...files.map((file) => file.name), ...images.map((image) => image.name)]
      .join(", ")
      .trim();
  return { text, mode: explicitSteer ? "steer" : "followUp" };
}

// The composer owns its pending queue outright: a request is held here and is
// never handed to GJC until the user releases it, so nothing has to be inferred
// from transcript text or from a server-side listing. GJC has no notion of a
// waiting steer -- turn.steer is consumed by the open turn immediately -- which
// is why every attempt to reconcile these chips against a remote queue failed.
export interface PendingRequest {
  id: string;
  text: string;
  mode: "steer" | "followUp";
  label: string;
  images: ImageAttachment[];
  files: FileAttachment[];
  /** A rejected send may already have been accepted. Only the user may resubmit it. */
  blocked?: true;
}

export function normalizeComposerText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

// A release hands requests over one at a time, oldest first, and drops an entry
// only once its send resolves. Returning the remaining queue keeps that rule
// testable without driving the composer through the DOM.
export function withoutReleasedRequest(
  pending: readonly PendingRequest[],
  releasedId: string,
): PendingRequest[] {
  return pending.filter((entry) => entry.id !== releasedId);
}

export function nextRequestToRelease(
  pending: readonly PendingRequest[],
): PendingRequest | undefined {
  return pending[0]?.blocked ? undefined : pending[0];
}

// Hand held requests over one at a time, oldest first.
//
// The queue lives behind a ref because the loop awaits between sends, and React
// only refreshes a ref on render -- which lands after the await. Reading the
// rendered value re-selected the request that was just sent and steered it a
// second time, so the entry is claimed from the live queue *before* awaiting.
// A rejected send does not prove that the runtime never accepted it. Preserve its
// text but block further releases until the user reviews/removes the request.
export async function releaseRequests(queue: {
  canSend: () => boolean;
  read: () => readonly PendingRequest[];
  write: (pending: PendingRequest[]) => void;
  send: (request: PendingRequest) => Promise<unknown>;
}): Promise<void> {
  for (;;) {
    if (!queue.canSend()) return;
    const next = nextRequestToRelease(queue.read());
    if (!next) return;
    queue.write(withoutReleasedRequest(queue.read(), next.id));
    try {
      await queue.send(next);
    } catch {
      queue.write([{ ...next, blocked: true }, ...queue.read()]);
      return;
    }
  }
}

// Submitting the same draft twice must produce two independent entries, while a
// duplicated event for one keystroke must not. The composer clears the textarea
// synchronously so a repeated read yields an empty draft, and this helper keeps
// that contract observable: an empty draft never enqueues.
export function appendPendingRequest(
  pending: readonly PendingRequest[],
  request: PendingRequest,
): PendingRequest[] {
  if (!normalizeComposerText(request.text)) return [...pending];
  return [...pending, request];
}

/** Which held request a pull gesture takes: an end of the queue, or one clicked chip. */
export type QueuePullTarget = "newest" | "oldest" | { id: string };

/**
 * The pull an Option+Arrow keydown asks for, if it asks for one.
 *
 * Option+ArrowUp reaches for the request the user queued last, Option+ArrowDown
 * for the one that has been waiting longest, so repeated presses walk the queue
 * from either end. The keydown is only consumed when a pull can actually happen:
 * over an empty queue the native caret movement has to survive, and a release in
 * flight has already claimed the entry it is sending, so pulling beside it would
 * race that loop.
 */
export function consumeQueuePullKey(
  event: {
    key: string;
    altKey: boolean;
    metaKey: boolean;
    ctrlKey: boolean;
    shiftKey: boolean;
    preventDefault: () => void;
  },
  queue: { pending: readonly PendingRequest[]; releasing: boolean },
): QueuePullTarget | undefined {
  if (!event.altKey || event.metaKey || event.ctrlKey || event.shiftKey)
    return undefined;
  const target =
    event.key === "ArrowUp"
      ? ("newest" as const)
      : event.key === "ArrowDown"
        ? ("oldest" as const)
        : undefined;
  if (!target || queue.releasing || queue.pending.length === 0)
    return undefined;
  event.preventDefault();
  return target;
}

/**
 * Take one held request out of the queue.
 *
 * The caller owns the returned list and writes it back through the queue's own
 * channel; nothing here mutates the array it was given, so a release loop holding
 * a live snapshot is never rewritten under itself.
 */
export function pullQueuedRequest(
  pending: readonly PendingRequest[],
  target: QueuePullTarget,
): { entry: PendingRequest; pending: PendingRequest[] } | undefined {
  const index =
    target === "newest"
      ? pending.length - 1
      : target === "oldest"
        ? 0
        : pending.findIndex((entry) => entry.id === target.id);
  const entry = pending[index];
  if (!entry) return undefined;
  return {
    entry,
    pending: pending.filter((_, position) => position !== index),
  };
}

/**
 * Compose the draft a pulled request restores.
 *
 * The queue stores the body with its `/steer` prefix already stripped, so a steer
 * has to be spelled out again -- and at the *head* of the draft, which is the only
 * place the submit path looks for it -- or re-submitting would quietly downgrade
 * the request to a follow-up. Anything already typed stays where it is, with the
 * pulled text on the line after it, and the entry's attachments come back too.
 */
export function restorePulledDraft(
  draft: ComposerDraft,
  entry: PendingRequest,
): ComposerDraft {
  const body = draft.value ? `${draft.value}\n${entry.text}` : entry.text;
  return {
    value:
      entry.mode === "steer" && !/^\/steer(?:\s+|$)/u.test(draft.value)
        ? `/steer ${body}`
        : body,
    images: [...draft.images, ...entry.images],
    files: [...draft.files, ...entry.files],
  };
}

// One physical Enter can reach submit() from the form handler and from an IME
// composition callback in the same input frame. Those are the same submission, so
// the second is dropped. A deliberate resend is always further apart than one
// frame, and pressing Enter twice quickly on *different* text is never suppressed.
export const SUBMISSION_DEDUPE_MS = 120;

// How long an Enter pressed mid-composition waits for the IME to commit. The
// commit for that keystroke lands within a frame or two; anything later is a
// different edit and must not be submitted on the earlier Enter's behalf.
export const IME_COMMIT_WINDOW_MS = 400;

// How long after a commit a second Enter is still read as the IME's own delivery
// of the Enter that ended the composition, rather than as a fresh keypress.
export const IME_FOLLOWUP_WINDOW_MS = 100;

// Whether an IME commit may submit on behalf of an earlier Enter.
//
// The Korean IME delivers Enter while the final syllable is still composing, so
// the submission has to wait for the commit that follows. It must not wait
// indefinitely: a commit arriving much later belongs to text typed after that
// Enter, and submitting it sends a message the user never asked to send.
export function imeCommitSubmits(
  armedAt: number | undefined,
  now: number,
): boolean {
  if (armedAt === undefined) return false;
  return now - armedAt < IME_COMMIT_WINDOW_MS;
}

export function isDuplicateSubmission(
  last: { text: string; at: number },
  text: string,
  now: number,
): boolean {
  const body = normalizeComposerText(text);
  if (!body) return false;
  return (
    normalizeComposerText(last.text) === body &&
    now - last.at < SUBMISSION_DEDUPE_MS
  );
}

/** Unsent composer contents belonging to one session. */
export interface ComposerDraft {
  value: string;
  images: ImageAttachment[];
  files: FileAttachment[];
}

export function isEmptyDraft(draft: ComposerDraft): boolean {
  return (
    draft.value.length === 0 &&
    draft.images.length === 0 &&
    draft.files.length === 0
  );
}

/**
 * Park a session's unsent draft.
 *
 * The composer is a single mounted component shared by every session, so its text
 * state survives a session switch and would otherwise show up in -- and be sent
 * from -- whichever session the user moved to. Drafts are stored per session id
 * instead, and an empty draft is removed rather than stored so a session never
 * holds an empty entry.
 */
export function parkDraft(
  drafts: Map<string, ComposerDraft>,
  sessionId: string,
  draft: ComposerDraft,
): Map<string, ComposerDraft> {
  if (isEmptyDraft(draft)) drafts.delete(sessionId);
  else drafts.set(sessionId, draft);
  return drafts;
}

/** The draft to show for a session, or an empty one when it has never typed. */
export function restoreDraft(
  drafts: Map<string, ComposerDraft>,
  sessionId: string,
): ComposerDraft {
  return (
    drafts.get(sessionId) ?? { value: "", images: [], files: [] }
  );
}
