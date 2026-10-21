import { describe, expect, it } from "vitest";
import type {
  ChatMessage,
  TranscriptItem,
  TranscriptPage,
  TranscriptRequestSummary,
} from "../shared/agent-contract.js";
import {
  mergeRequestSummaries,
  mergeTranscriptPage,
  mergeTranscriptTail,
} from "./transcript-pages.js";

function message(
  id: string,
  content: string,
  role: ChatMessage["role"] = "assistant",
  createdAt = `created-${id}`,
): ChatMessage {
  return { id, kind: "message", sessionId: "session-1", role, content, createdAt };
}

function page(items: TranscriptItem[]): TranscriptPage {
  return {
    items,
    hasMoreBefore: false,
    hasMoreAfter: false,
    requests: [],
  };
}

function ids(items: readonly TranscriptItem[]): string[] {
  return items.map((item) => item.id);
}

describe("mergeTranscriptPage", () => {
  it("replaces rows and reuses current references for equal items", () => {
    const currentItem = message("same", "unchanged");
    const current = [currentItem, message("removed", "old")];
    const equalPageItem = message("same", "unchanged");
    const pageItem = message("new", "page row");

    const merged = mergeTranscriptPage(current, page([equalPageItem, pageItem]), "replace");

    expect(merged).toEqual([currentItem, pageItem]);
    expect(merged[0]).toBe(currentItem);
    expect(merged[1]).toBe(pageItem);
  });

  it("prepends older rows, removes duplicate boundaries, and keeps current versions", () => {
    const changedCurrent = message("boundary", "newest content");
    const current = [changedCurrent, message("newest", "current tail")];
    const older = message("older", "older content");
    const staleBoundary = message("boundary", "stale page content");
    const pageItems = [older, staleBoundary];

    const merged = mergeTranscriptPage(current, page(pageItems), "prepend");

    expect(ids(merged)).toEqual(["older", "boundary", "newest"]);
    expect(merged[0]).toBe(older);
    expect(merged[1]).toBe(changedCurrent);
    expect(merged[1]).toMatchObject({ content: "newest content" });
    expect(merged[2]).toBe(current[1]);
  });

  it("does not mutate current or incoming page arrays", () => {
    const current = [message("current", "current")];
    const incoming = [message("older", "older")];
    const transcriptPage = page(incoming);
    const currentBefore = current.slice();
    const incomingBefore = incoming.slice();
    Object.freeze(current);
    Object.freeze(incoming);
    Object.freeze(transcriptPage);

    const merged = mergeTranscriptPage(current, transcriptPage, "prepend");

    expect(current).toEqual(currentBefore);
    expect(incoming).toEqual(incomingBefore);
    expect(merged).not.toBe(current);
  });
});

describe("mergeTranscriptTail", () => {
  it("keeps an older prefix and replaces the overlapping range through the end", () => {
    const prefix = message("older", "older prefix");
    const overlap = message("overlap", "same");
    const current = [prefix, overlap, message("stale", "stale trailing row")];
    const equalIncomingOverlap = message("overlap", "same");
    const updated = message("updated", "authoritative tail");
    const appended = message("appended", "new tail row");

    const merged = mergeTranscriptTail(current, [equalIncomingOverlap, updated, appended]);

    expect(ids(merged)).toEqual(["older", "overlap", "updated", "appended"]);
    expect(merged[0]).toBe(prefix);
    expect(merged[1]).toBe(overlap);
    expect(merged[2]).toBe(updated);
  });

  it("resets to an incoming tail with no overlapping first row", () => {
    const current = [message("old-1", "old"), message("old-2", "old")];
    const tail = [message("new-1", "new"), message("new-2", "new")];

    const merged = mergeTranscriptTail(current, tail);

    expect(merged).toEqual(tail);
    expect(merged).not.toBe(current);
  });

  it("does not mutate arrays and replaces the current window with an empty tail", () => {
    const current = [message("current", "current")];
    const emptyTail: TranscriptItem[] = [];
    const currentBefore = current.slice();
    Object.freeze(current);
    Object.freeze(emptyTail);

    expect(mergeTranscriptTail(current, emptyTail)).toEqual([]);
    expect(current).toEqual(currentBefore);
  });
});

describe("mergeRequestSummaries", () => {
  it("upserts user requests in place or at the end with 240-codepoint text", () => {
    const existing: TranscriptRequestSummary[] = [
      { id: "first", text: "old text", createdAt: "old time" },
      { id: "second", text: "second text", createdAt: "second time" },
    ];
    const longText = `${"a".repeat(239)}😀tail`;
    const items: TranscriptItem[] = [
      message("first", "updated text", "user", "updated time"),
      message("third", longText, "user", "third time"),
      {
        id: "tool",
        kind: "tool",
        sessionId: "session-1",
        name: "bash",
        description: "tool payload must not be summarized",
        command: "secret command",
        status: "completed",
        createdAt: "tool time",
        output: "secret output",
      },
      message("assistant", "assistant text"),
    ];

    const merged = mergeRequestSummaries(existing, items);

    expect(merged).toEqual([
      { id: "first", text: "updated text", createdAt: "updated time" },
      existing[1],
      { id: "third", text: `${"a".repeat(239)}😀`, createdAt: "third time" },
    ]);
    expect(merged[2]?.text).toHaveLength(241);
    expect(Object.keys(merged[2]!).sort()).toEqual(["createdAt", "id", "text"]);
    expect(existing[0]).toEqual({ id: "first", text: "old text", createdAt: "old time" });
  });

  it("does not mutate its existing summaries or input items", () => {
    const existing: TranscriptRequestSummary[] = [
      { id: "known", text: "known", createdAt: "known time" },
    ];
    const incoming = [message("new", "new request", "user")];
    const existingBefore = existing.slice();
    const incomingBefore = incoming.slice();
    Object.freeze(existing);
    Object.freeze(incoming);

    const merged = mergeRequestSummaries(existing, incoming);

    expect(existing).toEqual(existingBefore);
    expect(incoming).toEqual(incomingBefore);
    expect(merged).not.toBe(existing);
  });
});
