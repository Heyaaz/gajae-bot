import type {
  TranscriptItem,
  TranscriptPage,
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
