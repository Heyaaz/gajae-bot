import { describe, expect, it } from "vitest";
import type { TranscriptItem } from "./backend/types";
import {
  cacheTranscript,
  copyableMessageText,
  groupTranscriptItems,
  initialSessionId,
  isNearTranscriptBottom,
  orderedSessionsForShortcuts,
  recentUserRequests,
  updateTranscriptItem,
} from "./transcript-utils";

const tool = (id: string): TranscriptItem => ({
  id,
  sessionId: "session-1",
  kind: "tool",
  name: "bash",
  description: "bash",
  status: "completed",
  createdAt: "now",
});

const message: TranscriptItem = {
  id: "message-1",
  sessionId: "session-1",
  kind: "message",
  role: "assistant",
  content: "Hello",
  createdAt: "now",
};

const notice: TranscriptItem = {
  id: "notice-1",
  sessionId: "session-1",
  kind: "notice",
  tone: "neutral",
  title: "Ready",
  content: "Done",
  createdAt: "now",
};

describe("copyableMessageText", () => {
  it("keeps the visible request body and drops attachment instructions", () => {
    expect(
      copyableMessageText(
        'inspect this\n\n<local-images>\n- "/tmp/shot.png"\n</local-images>\nThe user attached these images. You MUST inspect every image with the read tool before responding.',
      ),
    ).toBe("inspect this");
  });
});

describe("recentUserRequests", () => {
  it("returns the latest three user requests newest first and removes attachment boilerplate", () => {
    const user = (id: string, content: string): TranscriptItem => ({
      id,
      sessionId: "session-1",
      kind: "message",
      role: "user",
      content,
      createdAt: id,
    });
    expect(
      recentUserRequests([
        user("1", "first"),
        message,
        user("2", "second"),
        user("3", "third"),
        user(
          "4",
          'inspect\n\n<local-attachments>\n- "/tmp/screen.png"\n</local-attachments>\nUse the read tool on these local paths when their contents are needed.',
        ),
      ]),
    ).toEqual([
      { id: "4", text: "inspect", createdAt: "4" },
      { id: "3", text: "third", createdAt: "3" },
      { id: "2", text: "second", createdAt: "2" },
    ]);
  });

  it("uses attachment names when the request has no text", () => {
    const item: TranscriptItem = {
      id: "1",
      sessionId: "session-1",
      kind: "message",
      role: "user",
      content:
        '<local-attachments>\n- "/tmp/report.pdf"\n</local-attachments>\nUse the read tool on these local paths when their contents are needed.',
      createdAt: "now",
    };
    expect(recentUserRequests([item])).toEqual([
      { id: "1", text: "첨부: report.pdf", createdAt: "now" },
    ]);
  });
});

describe("updateTranscriptItem", () => {
  it("clones only the changed session and item", () => {
    const otherSession = [notice];
    const transcripts = {
      "session-1": [notice, message],
      "session-2": otherSession,
    };

    const updated = updateTranscriptItem(
      transcripts,
      "session-1",
      message.id,
      (item) =>
        item.kind === "message"
          ? { ...item, content: `${item.content} world` }
          : item,
    );

    expect(updated).not.toBe(transcripts);
    expect(updated["session-1"]).not.toBe(transcripts["session-1"]);
    expect(updated["session-1"][0]).toBe(notice);
    expect(updated["session-1"][1]).toMatchObject({ content: "Hello world" });
    expect(updated["session-2"]).toBe(otherSession);
  });

  it("preserves references when the target is absent or unchanged", () => {
    const transcripts = { "session-1": [message] };

    expect(
      updateTranscriptItem(transcripts, "missing", message.id, (item) => item),
    ).toBe(transcripts);
    expect(
      updateTranscriptItem(transcripts, "session-1", "missing", (item) => item),
    ).toBe(transcripts);
    expect(
      updateTranscriptItem(
        transcripts,
        "session-1",
        message.id,
        (item) => item,
      ),
    ).toBe(transcripts);
  });
});

describe("cacheTranscript", () => {
  it("evicts the least recently used transcript without cloning retained items", () => {
    const first = [message];
    const second = [notice];
    const third = [
      {
        ...message,
        id: "message-3",
        sessionId: "session-3",
      } satisfies TranscriptItem,
    ];
    const cached = cacheTranscript(
      { "session-1": first, "session-2": second },
      "session-3",
      third,
      2,
    );

    expect(Object.keys(cached)).toEqual(["session-2", "session-3"]);
    expect(cached["session-2"]).toBe(second);
    expect(cached["session-3"]).toBe(third);
  });

  it("refreshes cache recency and preserves an already-recent cache", () => {
    const transcripts = { "session-1": [message], "session-2": [notice] };
    const refreshed = cacheTranscript(
      transcripts,
      "session-1",
      transcripts["session-1"],
      2,
    );

    expect(Object.keys(refreshed)).toEqual(["session-2", "session-1"]);
    expect(
      cacheTranscript(refreshed, "session-1", refreshed["session-1"], 2),
    ).toBe(refreshed);
  });

  it("reuses transcript and item references when polling returns equal data", () => {
    const transcripts = { "session-1": [message, notice] };
    const refreshed = cacheTranscript(transcripts, "session-1", [
      { ...message },
      { ...notice },
    ]);

    expect(refreshed).toBe(transcripts);
    expect(refreshed["session-1"]).toBe(transcripts["session-1"]);
    expect(refreshed["session-1"][0]).toBe(message);
  });

  it("keeps an optimistic user message until polling confirms it", () => {
    const optimistic = {
      ...message,
      id: "local-user-1",
      role: "user" as const,
      content: "steer now",
    };
    const transcripts = { "session-1": [message, optimistic] };

    const pending = cacheTranscript(transcripts, "session-1", [{ ...message }]);
    expect(pending["session-1"].at(-1)).toBe(optimistic);

    const confirmed = cacheTranscript(pending, "session-1", [
      { ...message },
      { ...message, id: "remote-user-2", role: "user", content: "steer now" },
    ]);
    expect(
      confirmed["session-1"].some((item) => item.id === optimistic.id),
    ).toBe(false);
  });
  it("keeps an unmatched image or steer request at the end until it is confirmed", () => {
    const optimistic = {
      ...message,
      id: "local-user-1",
      role: "user" as const,
      content: "이런 컴팩트 한건 왜 앱에 안뜨는거지 ?",
      images: [
        { id: "img-1", name: "shot.png", mimeType: "image/png", data: "abc" },
      ],
    };
    const existing = { ...message, id: "assistant-1" };
    const toolItem = tool("search-1");
    const transcripts = { "session-1": [existing, optimistic] };

    const pending = cacheTranscript(transcripts, "session-1", [
      existing,
      toolItem,
    ]);
    expect(pending["session-1"].map((item) => item.id)).toEqual([
      "assistant-1",
      "search-1",
      "local-user-1",
    ]);

    const confirmed = cacheTranscript(pending, "session-1", [
      existing,
      {
        ...optimistic,
        id: "remote-user-2",
        content:
          '이런 컴팩트 한건 왜 앱에 안뜨는거지 ?\n\n<local-images>\n- "/tmp/shot.png"\n</local-images>\nThe user attached these images. You MUST inspect every image with the read tool before responding.',
        images: undefined,
      },
      toolItem,
    ]);
    expect(
      confirmed["session-1"].some((item) => item.id === optimistic.id),
    ).toBe(false);
  });
});

describe("groupTranscriptItems", () => {
  it("collapses a consecutive tool run into one block", () => {
    const blocks = groupTranscriptItems([tool("a"), tool("b"), tool("c")]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: "tools" });
    expect(
      blocks[0]!.kind === "tools" && blocks[0].items.map((item) => item.id),
    ).toEqual(["a", "b", "c"]);
  });

  it("starts a new run after a non-tool item interrupts it", () => {
    const blocks = groupTranscriptItems([tool("a"), message, tool("b")]);
    expect(blocks.map((block) => block.kind)).toEqual([
      "tools",
      "item",
      "tools",
    ]);
  });

  it("keeps non-tool items unwrapped and in order", () => {
    expect(groupTranscriptItems([message, notice])).toEqual([
      { kind: "item", id: message.id, item: message },
      { kind: "item", id: notice.id, item: notice },
    ]);
  });
});

describe("isNearTranscriptBottom", () => {
  it("follows only while the viewport remains near the latest content", () => {
    expect(isNearTranscriptBottom(1_000, 552, 400)).toBe(false);
    expect(isNearTranscriptBottom(1_000, 553, 400)).toBe(true);
    expect(isNearTranscriptBottom(1_000, 600, 400)).toBe(true);
  });
});

describe("initialSessionId", () => {
  it("opens unread activity before a stale empty selection", () => {
    expect(
      initialSessionId(
        [
          { id: "empty", unread: false, title: "새 Gajae 세션" },
          { id: "active", unread: true, title: "Gajae" },
        ],
        "empty",
      ),
    ).toBe("active");
  });

  it("preserves the current selection when no session has unread activity", () => {
    expect(
      initialSessionId(
        [
          { id: "first", unread: false },
          { id: "current", unread: false },
        ],
        "current",
      ),
    ).toBe("current");
  });

  it("replaces a stale empty draft with a populated named session", () => {
    expect(
      initialSessionId(
        [
          { id: "empty", unread: false, title: "새 Gajae 세션" },
          { id: "populated", unread: false, title: "Gajae" },
        ],
        "empty",
      ),
    ).toBe("populated");
  });
});

describe("orderedSessionsForShortcuts", () => {
  it("matches the pinned-then-recent sidebar order", () => {
    expect(
      orderedSessionsForShortcuts([
        { id: "recent-1", pinned: false },
        { id: "pinned-1", pinned: true },
        { id: "recent-2", pinned: false },
        { id: "pinned-2", pinned: true },
      ]).map((session) => session.id),
    ).toEqual(["pinned-1", "pinned-2", "recent-1", "recent-2"]);
  });
});
