import { describe, expect, it } from "vitest";
import type {
  ChatMessage,
  TranscriptItem,
  TranscriptPage,
  TranscriptPageRequest,
  TranscriptRequestSummary,
} from "../shared/agent-contract.js";
import { selectTranscriptPage } from "../shared/transcript-page.js";
import {
  mergeRequestSummaries,
  mergeTranscriptPage,
  mergeTranscriptPatch,
  mergeTranscriptTail,
  refreshTranscriptWindow,
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

function requestHistory(count: number): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  for (let index = 0; index < count; index += 1) {
    items.push(
      message(`user-${index}`, `request ${index}`, "user"),
      message(`response-${index}`, `response ${index}`),
    );
  }
  return items;
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

describe("mergeTranscriptPatch", () => {
  it("replaces changed rows in place and appends new rows", () => {
    const first = message("first", "one");
    const second = message("second", "two");
    const replacement = message("first", "one updated");
    const appended = message("third", "three");
    expect(
      mergeTranscriptPatch([first, second], [replacement, appended]),
    ).toEqual([replacement, second, appended]);
  });

  it("reuses the current object when the patch row is equal", () => {
    const first = message("first", "one");
    const equal = message("first", "one");
    const merged = mergeTranscriptPatch([first], [equal]);
    expect(merged[0]).toBe(first);
  });
});

describe("refreshTranscriptWindow", () => {
  it("refreshes a prepended historical range through the complete last request", async () => {
    const original = requestHistory(40);
    const current = original.slice(2, 70);
    const fresh = original.map((item) =>
      item.id === "response-20" ? message("response-20", "updated response") : item,
    );
    const nextRequestIndex = fresh.findIndex((item) => item.id === "user-35");
    fresh.splice(nextRequestIndex, 0, message("response-34-followup", "continued response"));
    const calls: (TranscriptPageRequest | undefined)[] = [];

    const refreshed = await refreshTranscriptWindow(current, async (request) => {
      calls.push(request);
      return selectTranscriptPage(fresh, request);
    });

    const expectedStart = fresh.findIndex((item) => item.id === "user-1");
    const expectedEnd = fresh.findIndex((item) => item.id === "user-35");
    expect(refreshed.items).toEqual(fresh.slice(expectedStart, expectedEnd));
    expect(ids(refreshed.items)).toContain("response-34-followup");
    expect(ids(refreshed.items)).not.toContain("user-35");
    expect(refreshed.items.find((item) => item.id === "response-20")).toMatchObject({
      content: "updated response",
    });
    expect(refreshed.firstId).toBe("user-1");
    expect(refreshed.lastId).toBe("response-34-followup");
    expect(refreshed.requests.map((request) => request.id)).toEqual(
      Array.from({ length: 40 }, (_, index) => `user-${index}`),
    );
    expect(refreshed.hasMoreBefore).toBe(true);
    expect(refreshed.hasMoreAfter).toBe(true);
    expect(calls[0]).toEqual({ aroundId: "user-34" });
    expect(calls.slice(1).every((call) => call?.beforeId !== undefined)).toBe(true);
  });

  it("sets page flags from actual source bounds instead of the clipped source pages", async () => {
    const source = requestHistory(35);
    const refreshed = await refreshTranscriptWindow(source, (request) =>
      Promise.resolve(selectTranscriptPage(source, request)),
    );

    expect(ids(refreshed.items)).toEqual(ids(source));
    expect(refreshed.hasMoreBefore).toBe(false);
    expect(refreshed.hasMoreAfter).toBe(false);
  });

  it("rejects a missing loaded anchor instead of returning a replacement page", async () => {
    const source = requestHistory(30);
    const current = [
      message("missing-first-row", "old anchor"),
      ...source.slice(source.findIndex((item) => item.id === "user-20")),
    ];

    await expect(
      refreshTranscriptWindow(current, (request) =>
        Promise.resolve(selectTranscriptPage(source, request)),
      ),
    ).rejects.toThrow("Transcript page anchor not found: missing-first-row");
  });

  it("rejects a repeated page cursor that cannot make progress", async () => {
    const repeated = {
      ...page([message("user-2", "request", "user"), message("response-2", "response")]),
      hasMoreBefore: true,
    };
    const current = [message("missing-first-row", "old anchor"), ...repeated.items];
    const calls: (TranscriptPageRequest | undefined)[] = [];

    await expect(
      refreshTranscriptWindow(current, async (request) => {
        calls.push(request);
        return repeated;
      }),
    ).rejects.toThrow("Transcript page made no progress before cursor: user-2");
    expect(calls).toEqual([{ aroundId: "user-2" }, { beforeId: "user-2" }]);
  });

  it("uses one contiguous around-page when the loaded rows have no user request", async () => {
    const source = [message("notice-1", "first"), message("notice-2", "second")];
    const calls: (TranscriptPageRequest | undefined)[] = [];
    const refreshed = await refreshTranscriptWindow([source[0]!], async (request) => {
      calls.push(request);
      return selectTranscriptPage(source, request);
    });

    expect(ids(refreshed.items)).toEqual(ids(source));
    expect(calls).toEqual([{ aroundId: "notice-1" }]);
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
