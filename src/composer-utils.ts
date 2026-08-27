import type { FileAttachment, ImageAttachment } from "../shared/agent-contract";
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
) {
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
  return pending[0];
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
