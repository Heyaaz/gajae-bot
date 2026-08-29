import type { TranscriptItem } from "./backend/types";

export const MAX_CACHED_TRANSCRIPTS = 3;

export interface RecentUserRequest {
  id: string;
  text: string;
  createdAt: string;
}

/** Compact user-only history for quickly recovering a session's recent intent. */
export function recentUserRequests(
  items: readonly TranscriptItem[],
  limit = 3,
): RecentUserRequest[] {
  return items
    .filter(
      (item): item is Extract<TranscriptItem, { kind: "message" }> =>
        item.kind === "message" && item.role === "user",
    )
    .map((item) => {
      const paths = [...item.content.matchAll(/^\s*-\s+"([^"]+)"\s*$/gmu)].map(
        (match) => match[1]!.split("/").at(-1)!,
      );
      const body = item.content
        .replace(
          /<local-(?:attachments|files|images)>[\s\S]*?<\/local-(?:attachments|files|images)>/gu,
          "",
        )
        .replace(
          /Use the read tool on these local (?:paths|files) when their contents are needed\./gu,
          "",
        )
        .replace(
          /The user attached these images\. You MUST inspect every image with the read tool before responding\./gu,
          "",
        )
        .replace(/\s+/gu, " ")
        .trim();
      const text =
        body || (paths.length > 0 ? `첨부: ${paths.join(", ")}` : "첨부 요청");
      return { id: item.id, text, createdAt: item.createdAt };
    })
    .filter((item) => item.text.length > 0)
    .slice(-Math.max(0, limit))
    .reverse();
}

export function orderedSessionsForShortcuts<T extends { pinned: boolean }>(
  sessions: readonly T[],
): T[] {
  return [
    ...sessions.filter((session) => session.pinned),
    ...sessions.filter((session) => !session.pinned),
  ];
}

export function initialSessionId(
  sessions: ReadonlyArray<{ id: string; unread: boolean; title?: string }>,
  current: string | null,
): string | null {
  const selected = sessions.find((session) => session.id === current);
  const selectedIsEmptyDraft = selected?.title === "새 Gajae 세션";
  return (
    sessions.find((session) => session.unread)?.id ??
    (!selectedIsEmptyDraft ? selected?.id : undefined) ??
    sessions.find((session) => session.title !== "새 Gajae 세션")?.id ??
    selected?.id ??
    sessions[0]?.id ??
    null
  );
}

export type TranscriptBlock =
  | { kind: "item"; id: string; item: TranscriptItem }
  | {
      kind: "tools";
      id: string;
      items: Extract<TranscriptItem, { kind: "tool" }>[];
    };

/**
 * Consecutive tool calls collapse into one block so a long bash/read run costs one
 * card instead of one card per call. Any other item (message, thought, plan, notice)
 * closes the run, which keeps reasoning boundaries visible.
 */
export function groupTranscriptItems(
  items: readonly TranscriptItem[],
): TranscriptBlock[] {
  const blocks: TranscriptBlock[] = [];
  for (const item of items) {
    if (item.kind !== "tool") {
      blocks.push({ kind: "item", id: item.id, item });
      continue;
    }
    const last = blocks.at(-1);
    if (last?.kind === "tools") last.items.push(item);
    else blocks.push({ kind: "tools", id: `tools-${item.id}`, items: [item] });
  }
  return blocks;
}

/**
 * Locates the block holding an item so the transcript can scroll to a search hit.
 *
 * Only a window of blocks is mounted, so a hit is usually not in the DOM and cannot be
 * found by id. Its index is what the virtualizer needs to bring it on screen first.
 * Returns -1 when the item is absent.
 */
export function transcriptBlockIndexForItem(
  blocks: readonly TranscriptBlock[],
  itemId: string,
): number {
  return blocks.findIndex((block) =>
    block.kind === "item"
      ? block.item.id === itemId
      : block.items.some((item) => item.id === itemId),
  );
}

export function isNearTranscriptBottom(
  scrollHeight: number,
  scrollTop: number,
  clientHeight: number,
  threshold = 48,
): boolean {
  return scrollHeight - scrollTop - clientHeight < threshold;
}

function sameUserRequest(
  remote: Extract<TranscriptItem, { kind: "message" }>,
  local: Extract<TranscriptItem, { kind: "message" }>,
): boolean {
  if (remote.content === local.content) return true;
  const remoteText = requestText(remote.content);
  const localText = requestText(local.content);
  if (remoteText && localText) return remoteText === localText;
  // An attachment-only request has no prose on either side, so text comparison
  // cannot confirm it. The attached file names are the only content both sides
  // carry, so they stand in for the body.
  const remoteNames = attachedNames(remote.content);
  const localNames =
    attachedNames(local.content) ||
    (local.images ?? []).map((image) => image.name).sort().join("|");
  if (!remoteText && !localText && (remoteNames || localNames))
    return remoteNames === localNames;
  if (local.images?.length) {
    const remoteHasImages =
      /<local-images>/u.test(remote.content) || Boolean(remote.images?.length);
    return remoteHasImages && (!localText || remoteText === localText);
  }
  return false;
}

/**
 * Names of the files and images a prompt attached, in the order they were attached.
 *
 * The paths live in a block addressed to the agent, and the bubble strips that block
 * so the instructions do not read as the user's own words. That left an attachment
 * invisible: a thumbnail alone does not say a file was sent, and an image the model
 * read by path had nothing to show at all. The renderer lists these names next to the
 * message so the user can see what went with it.
 */
export function attachmentSummaryText(content: string): string[] {
  const blocks = content.matchAll(
    /<local-(?:attachments|files|images)>([\s\S]*?)<\/local-(?:attachments|files|images)>/gu,
  );
  const names: string[] = [];
  for (const block of blocks)
    for (const line of block[1]!.matchAll(/^\s*-\s+"([^"]+)"\s*$/gmu))
      names.push(line[1]!.split("/").at(-1)!);
  return names;
}

/** File names from a prompt's attachment block, order-independent. */
function attachedNames(content: string): string {
  return [...content.matchAll(/^\s*-\s+"([^"]+)"\s*$/gmu)]
    .map((match) => match[1]!.split("/").at(-1)!)
    .sort()
    .join("|");
}

export function copyableMessageText(content: string): string {
  return content
    .replace(
      /<local-(?:attachments|files|images)>[\s\S]*?<\/local-(?:attachments|files|images)>/gu,
      "",
    )
    .replace(
      /Use the read tool on these local (?:paths|files) when their contents are needed\./gu,
      "",
    )
    .replace(
      /The user attached these images\. You MUST inspect every image with the read tool before responding\./gu,
      "",
    )
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function requestText(content: string): string {
  return copyableMessageText(content).replace(/\s+/gu, " ").trim();
}

// A user bubble the app rendered itself, before GJC confirmed the request. The
// controller echoes prompts and steers as `local-prompt-`; the renderer used to
// add its own `local-user-` bubbles. Both must survive a transcript sync until a
// matching remote message arrives, or a just-sent message disappears mid-turn.
function isLocalEcho(id: string): boolean {
  return id.startsWith("local-user-") || id.startsWith("local-prompt-");
}

export function cacheTranscript(
  transcripts: Record<string, TranscriptItem[]>,
  sessionId: string,
  items: TranscriptItem[],
  maximum = MAX_CACHED_TRANSCRIPTS,
): Record<string, TranscriptItem[]> {
  const previous = transcripts[sessionId];
  if (previous) {
    const optimistic = previous.filter(
      (item): item is Extract<TranscriptItem, { kind: "message" }> =>
        item.kind === "message" && isLocalEcho(item.id),
    );
    // Each remote user message confirms at most one echo. Matching by text alone
    // let a single remote row confirm nothing when it was already on screen
    // before the echo -- the old "must be a newly seen id" rule -- which left the
    // echo pinned forever and rendered the request twice. Consuming candidates
    // instead keeps two identical requests independent while guaranteeing every
    // confirmed echo is dropped.
    const unconsumed = items.filter(
      (item): item is Extract<TranscriptItem, { kind: "message" }> =>
        item.kind === "message" && item.role === "user",
    );
    for (const local of optimistic) {
      const match = unconsumed.findIndex((item) =>
        sameUserRequest(item, local),
      );
      if (match >= 0) unconsumed.splice(match, 1);
      else items = [...items, local];
    }
  }
  if (previous && previous !== items) {
    let changed = previous.length !== items.length;
    items = items.map((item, index) => {
      const current = previous[index];
      if (
        current?.id === item.id &&
        JSON.stringify(current) === JSON.stringify(item)
      )
        return current;
      changed = true;
      return item;
    });
    if (!changed) items = previous;
  }
  const keys = Object.keys(transcripts);
  if (
    transcripts[sessionId] === items &&
    keys.at(-1) === sessionId &&
    keys.length <= maximum
  )
    return transcripts;

  const cached = { ...transcripts };
  delete cached[sessionId];
  cached[sessionId] = items;
  while (Object.keys(cached).length > maximum) {
    const oldest = Object.keys(cached)[0];
    if (oldest === undefined) break;
    delete cached[oldest];
  }
  return cached;
}

/**
 * Merge a single published item into a session's history.
 *
 * A transcript rescan republishes a row once its status or output changes, so an
 * id that is already present is replaced rather than appended -- appending it
 * again showed the same tool call twice.
 */
export function mergeTranscriptItem(
  items: readonly TranscriptItem[],
  item: TranscriptItem,
): TranscriptItem[] {
  const index = items.findIndex((existing) => existing.id === item.id);
  if (index >= 0)
    return items.map((existing, at) => (at === index ? item : existing));
  // Every row this window shows before GJC persists it carries a local id, and
  // the persisted rebuild of that same row carries a different one. An id-only
  // match treated the rebuild as a brand new row and appended it, so a request,
  // a reply, or a cancellation notice rendered twice.
  const superseded = supersededLocalIndex(items, item);
  if (superseded >= 0)
    return items.map((existing, at) =>
      at === superseded ? withLocalImages(item, existing) : existing,
    );
  return [...items, item];
}

/**
 * Carries a replaced row's inline images onto its persisted rebuild.
 *
 * Only this window ever holds the image bytes: the app reads the file and echoes the
 * bubble with inline base64, while the persisted transcript stores the path inside the
 * prompt text and nothing else. So the rebuild always arrives without images, and
 * replacing the row wholesale erased the thumbnail the user had just seen.
 */
function withLocalImages(
  item: TranscriptItem,
  replaced: TranscriptItem,
): TranscriptItem {
  if (item.kind !== "message" || replaced.kind !== "message") return item;
  if (item.images?.length || !replaced.images?.length) return item;
  return { ...item, images: replaced.images };
}

// Local ids and the persisted ids that replace them. The renderer draws whatever
// the transcript holds, so a rebuilt row must retire the local copy of itself
// rather than sit next to it.
const LOCAL_MESSAGE_PREFIXES = [
  "acp-message-",
  "local-prompt-",
  "local-user-",
];
const LOCAL_NOTICE_PREFIXES = ["gjc-cancelled-"];

function hasLocalPrefix(id: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => id.startsWith(prefix));
}

/** Index of the locally rendered row that `item` is the persisted rebuild of. */
function supersededLocalIndex(
  items: readonly TranscriptItem[],
  item: TranscriptItem,
): number {
  if (item.kind === "message" && item.id.startsWith("shared-message-")) {
    const body = requestText(item.content);
    if (!body) return -1;
    return items.findIndex(
      (existing) =>
        existing.kind === "message" &&
        existing.role === item.role &&
        hasLocalPrefix(existing.id, LOCAL_MESSAGE_PREFIXES) &&
        requestText(existing.content) === body,
    );
  }
  // A cancelled turn is announced locally the moment the user aborts, and the
  // persisted transcript reports the same stop as its own notice row.
  if (item.kind === "notice" && item.id.startsWith("shared-cancelled-")) {
    return items.findIndex(
      (existing) =>
        existing.kind === "notice" &&
        hasLocalPrefix(existing.id, LOCAL_NOTICE_PREFIXES) &&
        existing.title === item.title,
    );
  }
  return -1;
}

export function updateTranscriptItem(
  transcripts: Record<string, TranscriptItem[]>,
  sessionId: string,
  itemId: string,
  update: (item: TranscriptItem) => TranscriptItem,
): Record<string, TranscriptItem[]> {
  const items = transcripts[sessionId];
  if (!items) return transcripts;

  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index].id !== itemId) continue;

    const updatedItem = update(items[index]);
    if (updatedItem === items[index]) return transcripts;

    const updatedItems = items.slice();
    updatedItems[index] = updatedItem;
    return { ...transcripts, [sessionId]: updatedItems };
  }

  return transcripts;
}

/**
 * Merges a discovery refresh into the rows already on screen.
 *
 * Local runtime state (phase, model, usage) is authoritative while a session is
 * open, so a refresh adds newly discovered sessions and drops closed ones without
 * overwriting what this window tracks. `status` is the exception: discovery now
 * derives it from the session's transcript, which is the only account of work this
 * window is not driving. Keeping the on-screen value there pinned a row to the
 * state it happened to be listed in, so an agent working in another process stayed
 * on 완료 for its whole run.
 */
export function mergeDiscoveredSessions<
  T extends { id: string; unread: boolean; status?: string },
>(
  current: readonly T[],
  discovered: readonly T[],
  protectedId?: string | null,
): T[] {
  const known = new Map(current.map((session) => [session.id, session]));
  const discoveredIds = new Set(discovered.map((session) => session.id));
  // A session being created locally is not discoverable yet, so it survives a
  // refresh. The focused session is kept too: a refresh that momentarily misses
  // it would otherwise drop the open conversation and move focus elsewhere.
  // Anything else discovery stopped reporting is gone and must leave the list
  // instead of lingering as a dead row.
  const retained = current.filter(
    (session) =>
      !discoveredIds.has(session.id) &&
      (session.status === "starting" ||
        session.status === "failed" ||
        session.id === protectedId),
  );
  const merged = discovered.map((session) => {
    const existing = known.get(session.id);
    if (!existing) return session;
    return { ...session, ...existing, status: session.status };
  });
  // Discovery order is activity-ranked and churns between refreshes. Rows already
  // on screen keep their position so the list does not reshuffle under the
  // pointer, while newly discovered sessions arrive at the top.
  const order = new Map(current.map((session, index) => [session.id, index]));
  const seen = merged.filter((session) => order.has(session.id));
  const fresh = merged.filter((session) => !order.has(session.id));
  seen.sort(
    (left, right) => (order.get(left.id) ?? 0) - (order.get(right.id) ?? 0),
  );
  return [...retained, ...seen, ...fresh];
}
