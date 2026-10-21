import type {
  TranscriptItem,
  TranscriptPage,
  TranscriptPageRequest,
  TranscriptRequestSummary,
} from "../shared/agent-contract.js";
import { transcriptItemEqual } from "../shared/transcript-item-equal.js";

function currentItemsById(items: readonly TranscriptItem[]): Map<string, TranscriptItem> {
  const byId = new Map<string, TranscriptItem>();
  for (const item of items) byId.set(item.id, item);
  return byId;
}

function reuseEqualCurrentItem(
  item: TranscriptItem,
  currentById: ReadonlyMap<string, TranscriptItem>,
): TranscriptItem {
  const current = currentById.get(item.id);
  return current && transcriptItemEqual(current, item) ? current : item;
}

function isUserRequest(item: TranscriptItem): boolean {
  return item.kind === "message" && item.role === "user";
}

function pageWithItems(
  source: TranscriptPage,
  items: TranscriptItem[],
  hasMoreBefore: boolean,
  hasMoreAfter: boolean,
): TranscriptPage {
  return {
    items,
    hasMoreBefore,
    hasMoreAfter,
    ...(items.length > 0 ? {
      firstId: items[0]!.id,
      lastId: items[items.length - 1]!.id,
    } : {}),
    requests: source.requests,
  };
}

function prependEarlierPage(
  current: readonly TranscriptItem[],
  earlier: readonly TranscriptItem[],
): TranscriptItem[] {
  const seen = new Set(current.map((item) => item.id));
  const uniqueEarlier: TranscriptItem[] = [];
  for (const item of earlier) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    uniqueEarlier.push(item);
  }
  return [...uniqueEarlier, ...current];
}

/**
 * Refreshes the loaded historical window without replacing it with a latest page.
 * The page reader must return contiguous, complete request-block pages; this
 * helper walks backward only as far as needed to cover the loaded first row.
 */
export async function refreshTranscriptWindow(
  current: readonly TranscriptItem[],
  readPage: (request?: TranscriptPageRequest) => Promise<TranscriptPage>,
): Promise<TranscriptPage> {
  if (current.length === 0) {
    const page = await readPage();
    return pageWithItems(page, page.items, page.hasMoreBefore, page.hasMoreAfter);
  }

  const firstId = current[0]!.id;
  let lastUserId: string | undefined;
  for (let index = current.length - 1; index >= 0; index -= 1) {
    const item = current[index]!;
    if (isUserRequest(item)) {
      lastUserId = item.id;
      break;
    }
  }

  if (lastUserId === undefined) {
    // With no user-request boundaries, refresh one contiguous around-page only;
    // arbitrary row cursors cannot safely reconstruct a larger request window.
    const page = await readPage({ aroundId: firstId });
    if (!page.items.some((item) => item.id === firstId)) {
      throw new Error(`Transcript page anchor not found: ${firstId}`);
    }
    return pageWithItems(page, page.items, page.hasMoreBefore, page.hasMoreAfter);
  }

  const aroundPage = await readPage({ aroundId: lastUserId });
  if (!aroundPage.items.some((item) => item.id === lastUserId)) {
    throw new Error(`Transcript page anchor not found: ${lastUserId}`);
  }

  const aroundLastUserIndex = aroundPage.items.findIndex((item) => item.id === lastUserId);
  const aroundNextUserIndex = aroundPage.items.findIndex(
    (item, index) => index > aroundLastUserIndex && isUserRequest(item),
  );
  const aroundEndIndex = aroundNextUserIndex < 0
    ? aroundPage.items.length
    : aroundNextUserIndex;
  const aroundHasMoreAfter = aroundEndIndex < aroundPage.items.length || aroundPage.hasMoreAfter;
  let items = aroundPage.items.slice(0, aroundEndIndex);
  let earliestPage = aroundPage;
  let latestReadPage = aroundPage;
  const requestedCursors = new Set<string>();
  let firstIndex = items.findIndex((item) => item.id === firstId);
  while (firstIndex < 0) {
    if (!earliestPage.hasMoreBefore) {
      throw new Error(`Transcript page anchor not found: ${firstId}`);
    }
    const cursor = items[0]?.id;
    if (cursor === undefined) {
      throw new Error(`Transcript page made no progress while refreshing anchor: ${firstId}`);
    }
    if (requestedCursors.has(cursor)) {
      throw new Error(`Transcript page cursor cycle while refreshing anchor: ${cursor}`);
    }
    requestedCursors.add(cursor);

    const earlierPage = await readPage({ beforeId: cursor });
    latestReadPage = earlierPage;
    const extended = prependEarlierPage(items, earlierPage.items);
    if (extended.length === items.length) {
      throw new Error(`Transcript page made no progress before cursor: ${cursor}`);
    }
    items = extended;
    earliestPage = earlierPage;
    firstIndex = items.findIndex((item) => item.id === firstId);
  }

  const lastUserIndex = items.findIndex((item) => item.id === lastUserId);
  if (lastUserIndex < firstIndex) {
    throw new Error(`Transcript page anchors out of order: ${firstId}, ${lastUserId}`);
  }
  const nextUserIndex = items.findIndex(
    (item, index) => index > lastUserIndex && isUserRequest(item),
  );
  const endIndex = nextUserIndex < 0 ? items.length : nextUserIndex;
  const refreshedItems = items.slice(firstIndex, endIndex);

  return pageWithItems(
    latestReadPage,
    refreshedItems,
    firstIndex > 0 || earliestPage.hasMoreBefore,
    endIndex < items.length || aroundHasMoreAfter,
  );
}

/** Installs a transcript page or prepends its older rows without overwriting live rows. */
export function mergeTranscriptPage(
  current: TranscriptItem[],
  page: TranscriptPage,
  mode: "replace" | "prepend",
): TranscriptItem[] {
  const currentById = currentItemsById(current);
  if (mode === "replace") {
    return page.items.map((item) => reuseEqualCurrentItem(item, currentById));
  }

  const currentIds = new Set(currentById.keys());
  const prepended: TranscriptItem[] = [];
  for (const item of page.items) {
    if (!currentIds.has(item.id)) {
      prepended.push(item);
      currentIds.add(item.id);
    }
  }
  return [...prepended, ...current];
}

/** Replaces changed rows in place and appends rows the current window lacks. */
export function mergeTranscriptPatch(
  current: readonly TranscriptItem[],
  patch: readonly TranscriptItem[],
): TranscriptItem[] {
  const currentById = currentItemsById(current);
  const patchById = new Map(patch.map((item) => [item.id, item]));
  const next = current.map((item) => {
    const incoming = patchById.get(item.id);
    return incoming ? reuseEqualCurrentItem(incoming, currentById) : item;
  });
  for (const item of patch) {
    if (!currentById.has(item.id)) next.push(item);
  }
  return next;
}

/** Applies a fresh tail, retaining the loaded prefix only when the tail overlaps it. */
export function mergeTranscriptTail(
  current: TranscriptItem[],
  tail: TranscriptItem[],
): TranscriptItem[] {
  const currentById = currentItemsById(current);
  const overlapIndex = tail.length === 0
    ? -1
    : current.findIndex((item) => item.id === tail[0]!.id);
  const prefix = overlapIndex < 0 ? [] : current.slice(0, overlapIndex);
  const incoming = tail.map((item) => reuseEqualCurrentItem(item, currentById));
  return [...prefix, ...incoming];
}

function previewText(content: string): string {
  let end = 0;
  for (let count = 0; count < 240 && end < content.length; count += 1) {
    const codePoint = content.codePointAt(end)!;
    end += codePoint > 0xffff ? 2 : 1;
  }
  return content.slice(0, end);
}

/** Upserts compact summaries for user messages, retaining existing request order. */
export function mergeRequestSummaries(
  existing: TranscriptRequestSummary[],
  items: readonly TranscriptItem[],
): TranscriptRequestSummary[] {
  const summaries = existing.slice();
  const positions = new Map<string, number>();
  for (let index = 0; index < summaries.length; index += 1) {
    positions.set(summaries[index]!.id, index);
  }

  for (const item of items) {
    if (item.kind !== "message" || item.role !== "user") continue;
    const summary: TranscriptRequestSummary = {
      id: item.id,
      text: previewText(item.content),
      createdAt: item.createdAt,
    };
    const position = positions.get(item.id);
    if (position === undefined) {
      positions.set(item.id, summaries.length);
      summaries.push(summary);
    } else {
      summaries[position] = summary;
    }
  }
  return summaries;
}
