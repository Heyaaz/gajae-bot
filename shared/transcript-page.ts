import type {
  TranscriptItem,
  TranscriptPage,
  TranscriptPageRequest,
  TranscriptRequestSummary,
} from "./agent-contract.js";

const PAGE_REQUEST_LIMIT = 20;
const SOFT_ITEM_LIMIT = 1_000;
const REQUEST_PREVIEW_LIMIT = 240;

interface RequestBlock {
  start: number;
  end: number;
}

interface ItemRange {
  start: number;
  end: number;
}

function isUserRequest(item: TranscriptItem): item is Extract<TranscriptItem, { kind: "message" }> {
  return item.kind === "message" && item.role === "user";
}

function requestBlocks(items: readonly TranscriptItem[]): RequestBlock[] {
  const blocks: RequestBlock[] = [];
  for (let index = 0; index < items.length; index += 1) {
    if (!isUserRequest(items[index]!)) continue;
    const previous = blocks[blocks.length - 1];
    if (previous) previous.end = index;
    blocks.push({ start: index, end: items.length });
  }
  return blocks;
}

function rangeForBlocks(
  blocks: readonly RequestBlock[],
  firstBlock: number,
  endBlock: number,
  itemCount: number,
): ItemRange {
  if (firstBlock === endBlock) {
    if (firstBlock === 0) {
      return { start: 0, end: blocks[0]!.start };
    }
    const boundary = firstBlock < blocks.length ? blocks[firstBlock]!.start : itemCount;
    return { start: boundary, end: boundary };
  }
  return {
    start: firstBlock === 0 ? 0 : blocks[firstBlock]!.start,
    end: blocks[endBlock - 1]!.end,
  };
}

function requestSummary(item: Extract<TranscriptItem, { kind: "message" }>): TranscriptRequestSummary {
  const text = item.content
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
  let preview = text;
  let characterCount = 0;
  let end = 0;
  let endOfPrefix = 0;
  for (const character of text) {
    if (characterCount === REQUEST_PREVIEW_LIMIT - 1) {
      endOfPrefix = end;
    }
    if (characterCount === REQUEST_PREVIEW_LIMIT) {
      preview = `${text.slice(0, endOfPrefix)}…`;
      break;
    }
    characterCount += 1;
    end += character.length;
  }
  return { id: item.id, text: preview, createdAt: item.createdAt };
}

function pageFromRange(
  items: readonly TranscriptItem[],
  range: ItemRange,
): TranscriptPage {
  const pageItems = items
    .slice(range.start, range.end)
    .map((item) => ({ ...item }));
  const requests: TranscriptRequestSummary[] = [];
  for (const item of items) {
    if (isUserRequest(item)) requests.push(requestSummary(item));
  }
  return {
    items: pageItems,
    hasMoreBefore: range.start > 0,
    hasMoreAfter: range.end < items.length,
    ...(pageItems.length > 0 ? {
      firstId: pageItems[0]!.id,
      lastId: pageItems[pageItems.length - 1]!.id,
    } : {}),
    requests,
  };
}

function trimToSoftLimit(
  items: readonly TranscriptItem[],
  blocks: readonly RequestBlock[],
  firstBlock: number,
  endBlock: number,
  protectedBlock?: number,
): ItemRange {
  let first = firstBlock;
  let end = endBlock;
  let range = rangeForBlocks(blocks, first, end, items.length);
  while (range.end - range.start > SOFT_ITEM_LIMIT && end - first > 1) {
    if (protectedBlock === first) end -= 1;
    else first += 1;
    range = rangeForBlocks(blocks, first, end, items.length);
  }
  return range;
}

/** Selects a stable page of complete user-request blocks from a transcript. */
export function selectTranscriptPage(
  source: readonly TranscriptItem[],
  request?: TranscriptPageRequest,
): TranscriptPage {
  if (request?.beforeId !== undefined && request.aroundId !== undefined) {
    throw new Error("Transcript page request cannot use both beforeId and aroundId");
  }

  const items = source;
  const blocks = requestBlocks(items);
  const cursorId = request?.beforeId ?? request?.aroundId;
  let cursorIndex = -1;
  if (cursorId !== undefined) {
    cursorIndex = items.findIndex((item) => item.id === cursorId);
    if (cursorIndex < 0) {
      throw new Error(`Transcript page anchor not found: ${cursorId}`);
    }
  }
  if (items.length === 0) return pageFromRange(items, { start: 0, end: 0 });
  if (blocks.length === 0) {
    if (request?.beforeId !== undefined) {
      return pageFromRange(items, { start: 0, end: cursorIndex });
    }
    return pageFromRange(items, { start: 0, end: items.length });
  }

  if (request?.beforeId !== undefined) {
    const anchorBlock = blocks.findIndex(
      (block) => cursorIndex >= block.start && cursorIndex < block.end,
    );
    if (anchorBlock < 0) {
      return pageFromRange(items, { start: 0, end: cursorIndex });
    }
    const endBlock = anchorBlock;
    const firstBlock = Math.max(0, endBlock - PAGE_REQUEST_LIMIT);
    return pageFromRange(
      items,
      trimToSoftLimit(items, blocks, firstBlock, endBlock),
    );
  }

  if (request?.aroundId !== undefined) {
    const targetBlock = blocks.findIndex(
      (block) => cursorIndex >= block.start && cursorIndex < block.end,
    );
    if (targetBlock < 0) {
      const endBlock = Math.min(blocks.length, PAGE_REQUEST_LIMIT);
      return pageFromRange(
        items,
        trimToSoftLimit(items, blocks, 0, endBlock, 0),
      );
    }

    const preceding = Math.floor(PAGE_REQUEST_LIMIT / 2);
    let firstBlock = Math.max(0, targetBlock - preceding);
    let endBlock = Math.min(blocks.length, firstBlock + PAGE_REQUEST_LIMIT);
    firstBlock = Math.max(0, endBlock - PAGE_REQUEST_LIMIT);
    return pageFromRange(
      items,
      trimToSoftLimit(items, blocks, firstBlock, endBlock, targetBlock),
    );
  }

  const endBlock = blocks.length;
  const firstBlock = Math.max(0, endBlock - PAGE_REQUEST_LIMIT);
  return pageFromRange(
    items,
    trimToSoftLimit(items, blocks, firstBlock, endBlock),
  );
}

/**
 * Selects the retained window for transcript safety-net synchronization.
 * Subsequent windows preserve the original first row and include its suffix;
 * if that row disappeared, synchronization restarts from the latest page.
 */
export function transcriptSyncWindow(
  items: readonly TranscriptItem[],
  previous?: readonly TranscriptItem[],
): TranscriptItem[] {
  const firstId = previous?.[0]?.id;
  if (firstId !== undefined) {
    const firstIndex = items.findIndex((item) => item.id === firstId);
    if (firstIndex >= 0) return items.slice(firstIndex);
  }
  return selectTranscriptPage(items).items;
}
