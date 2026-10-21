import { describe, expect, it } from "vitest";
import type { ChatMessage, TranscriptItem } from "../shared/agent-contract.js";
import { transcriptDelivery } from "../shared/transcript-item-equal.js";
import {
  selectTranscriptPage,
  transcriptSyncWindow,
} from "../shared/transcript-page.js";

function userRequest(index: number, content = `request ${index}`): ChatMessage {
  return {
    id: `user-${index}`,
    kind: "message",
    sessionId: "session-1",
    role: "user",
    content,
    createdAt: `created-${index}`,
  };
}

function response(index: number): ChatMessage {
  return {
    id: `response-${index}`,
    kind: "message",
    sessionId: "session-1",
    role: "assistant",
    content: `response ${index}`,
    createdAt: `created-${index}`,
  };
}

function requests(count: number): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  for (let index = 0; index < count; index += 1) {
    items.push(userRequest(index), response(index));
  }
  return items;
}

function ids(items: readonly TranscriptItem[]): string[] {
  return items.map((item) => item.id);
}

function userIds(items: readonly TranscriptItem[]): string[] {
  return items
    .filter((item) => item.kind === "message" && item.role === "user")
    .map((item) => item.id);
}

describe("selectTranscriptPage", () => {
  it("defaults to the latest 20 complete user requests", () => {
    const source = requests(25);
    const page = selectTranscriptPage(source);

    expect(userIds(page.items)).toEqual(
      Array.from({ length: 20 }, (_, index) => `user-${index + 5}`),
    );
    expect(page.requests.map((request) => request.id)).toEqual(
      Array.from({ length: 25 }, (_, index) => `user-${index}`),
    );
    expect(page.items).toHaveLength(40);
    expect(page.firstId).toBe("user-5");
    expect(page.lastId).toBe("response-24");
    expect(page.hasMoreBefore).toBe(true);
    expect(page.hasMoreAfter).toBe(false);
    expect(page.items).not.toBe(source);
    expect(page.items[0]).not.toBe(source[10]);
    expect(page.requests.every((request) => request.text.length <= 240)).toBe(true);
  });

  it("trims oldest complete request blocks to the soft 1,000-item limit", () => {
    const source: TranscriptItem[] = [];
    for (let index = 0; index < 20; index += 1) {
      source.push(userRequest(index));
      for (let detail = 0; detail < 50; detail += 1) {
        source.push(response(index * 50 + detail));
      }
    }

    const page = selectTranscriptPage(source);
    expect(page.items).toHaveLength(19 * 51);
    expect(userIds(page.items)).toEqual(
      Array.from({ length: 19 }, (_, index) => `user-${index + 1}`),
    );
    expect(page.requests.map((request) => request.id)).toEqual(
      Array.from({ length: 20 }, (_, index) => `user-${index}`),
    );
    expect(page.hasMoreBefore).toBe(true);
    expect(page.hasMoreAfter).toBe(false);
  });

  it("keeps one huge latest request complete even when it exceeds the soft limit", () => {
    const source: TranscriptItem[] = [userRequest(0)];
    for (let index = 0; index < 1_005; index += 1) {
      source.push(response(index));
    }

    const page = selectTranscriptPage(source);
    expect(page.items).toHaveLength(1_006);
    expect(page.requests.map((request) => request.id)).toEqual(["user-0"]);
    expect(page.items[0]?.id).toBe("user-0");
    expect(page.items.at(-1)?.id).toBe("response-1004");
  });

  it("pages backward without overlap and preserves chronological order", () => {
    const source: TranscriptItem[] = [{
      id: "preamble",
      kind: "notice",
      sessionId: "session-1",
      tone: "neutral",
      title: "Session started",
      content: "Preamble",
      createdAt: "created-0",
    }, ...requests(45)];
    const latest = selectTranscriptPage(source);
    const middle = selectTranscriptPage(source, { beforeId: latest.firstId });
    const earliest = selectTranscriptPage(source, { beforeId: middle.firstId });

    expect(userIds(latest.items)).toEqual(
      Array.from({ length: 20 }, (_, index) => `user-${index + 25}`),
    );
    expect(userIds(middle.items)).toEqual(
      Array.from({ length: 20 }, (_, index) => `user-${index + 5}`),
    );
    expect(userIds(earliest.items)).toEqual(
      Array.from({ length: 5 }, (_, index) => `user-${index}`),
    );
    const completeIndex = Array.from({ length: 45 }, (_, index) => `user-${index}`);
    expect(latest.requests.map((request) => request.id)).toEqual(completeIndex);
    expect(middle.requests.map((request) => request.id)).toEqual(completeIndex);
    expect(earliest.requests.map((request) => request.id)).toEqual(completeIndex);
    expect(earliest.items[0]?.id).toBe("preamble");
    expect(earliest.hasMoreBefore).toBe(false);
    expect(middle.hasMoreAfter).toBe(true);
    expect(ids([...earliest.items, ...middle.items, ...latest.items])).toEqual(ids(source));
  });

  it("includes the complete request containing an earlier around target", () => {
    const source: TranscriptItem[] = [{
      id: "preamble",
      kind: "notice",
      sessionId: "session-1",
      tone: "neutral",
      title: "Session started",
      content: "Preamble",
      createdAt: "created-0",
    }, ...requests(40)];
    const page = selectTranscriptPage(source, { aroundId: "response-4" });
    const target = page.items.findIndex((item) => item.id === "response-4");

    expect(userIds(page.items)).toEqual(
      Array.from({ length: 20 }, (_, index) => `user-${index}`),
    );
    expect(page.requests.map((request) => request.id)).toEqual(
      Array.from({ length: 40 }, (_, index) => `user-${index}`),
    );
    expect(page.items[target - 1]?.id).toBe("user-4");
    expect(page.items[target]?.id).toBe("response-4");
    expect(page.hasMoreBefore).toBe(false);
    expect(page.hasMoreAfter).toBe(true);
  });

  it("throws clear errors for missing cursors", () => {
    expect(() => selectTranscriptPage(requests(1), { beforeId: "missing" })).toThrow(
      'Transcript page anchor not found: missing',
    );
    expect(() => selectTranscriptPage(requests(1), { aroundId: "missing" })).toThrow(
      'Transcript page anchor not found: missing',
    );
    expect(() => selectTranscriptPage([], { beforeId: "missing" })).toThrow(
      'Transcript page anchor not found: missing',
    );
  });

  it("accepts an empty transcript", () => {
    expect(selectTranscriptPage([])).toEqual({
      items: [],
      hasMoreBefore: false,
      hasMoreAfter: false,
      requests: [],
    });
  });

  it("summarizes only user text and bounds long previews", () => {
    const source: TranscriptItem[] = [
      userRequest(0, "x".repeat(300)),
      {
        id: "tool-0",
        kind: "tool",
        sessionId: "session-1",
        name: "tool",
        description: "tool output must not leak",
        status: "completed",
        output: "private tool body",
        createdAt: "created-0",
      },
    ];
    const page = selectTranscriptPage(source);

    expect(page.requests).toEqual([{
      id: "user-0",
      text: `${"x".repeat(239)}…`,
      createdAt: "created-0",
    }]);
  });
});

describe("transcriptSyncWindow", () => {
  it("starts with the latest bounded page", () => {
    const source = requests(25);
    const window = transcriptSyncWindow(source);

    expect(ids(window)).toEqual(ids(selectTranscriptPage(source).items));
    expect(window).toHaveLength(40);
    expect(window[0]?.id).toBe("user-5");
    expect(window.at(-1)?.id).toBe("response-24");
  });

  it("preserves the delivered beginning while appending later requests", () => {
    const initial = requests(25);
    const baseline = transcriptSyncWindow(initial);
    const source = requests(27);
    const next = transcriptSyncWindow(source, baseline);

    expect(ids(next).slice(0, baseline.length)).toEqual(ids(baseline));
    expect(next[0]?.id).toBe("user-5");
    expect(next.at(-1)?.id).toBe("response-26");
    expect(next).toHaveLength(44);
  });

  it("restarts from the latest page when the previous first row disappeared", () => {
    const baseline = transcriptSyncWindow(requests(25));
    const source = requests(30).slice(20);

    expect(source.some((item) => item.id === baseline[0]?.id)).toBe(false);
    expect(transcriptSyncWindow(source, baseline)).toEqual(
      selectTranscriptPage(source).items,
    );
    expect(transcriptSyncWindow(source, baseline)[0]?.id).toBe("user-10");
  });

  it("delivers an edit and new requests as a small patch", () => {
    const initial = requests(3);
    const baseline = transcriptSyncWindow(initial);
    const source = requests(4);
    const edited = response(0);
    source[1] = { ...edited, content: "edited response" };

    const change = transcriptDelivery(baseline, transcriptSyncWindow(source, baseline));

    expect(change).toMatchObject({
      kind: "patch",
      items: [
        { id: "response-0", content: "edited response" },
        { id: "user-3", content: "request 3" },
        { id: "response-3", content: "response 3" },
      ],
    });
    expect(change.items).toHaveLength(3);
  });
});
