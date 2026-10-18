import { describe, expect, it } from "vitest";
import type { TranscriptItem } from "./backend/types";
import {
  cacheTranscript,
  copyableMessageText,
  groupTranscriptItems,
  initialSessionId,
  isNearTranscriptBottom,
  transcriptScrollIntent,
  shouldFollowTranscript,
  mergeDiscoveredSessions,
  attachmentSummaryText,
  mergeTranscriptItem,
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

describe("attachmentSummaryText", () => {
  it("names the attached images so the bubble shows what was sent", () => {
    // The prompt carries the paths inside a block addressed to the agent, and the
    // bubble strips that block. With only a thumbnail left, an attachment the model
    // did read looked like it was never sent -- and a path-only attachment showed
    // nothing at all.
    expect(
      attachmentSummaryText(
        'inspect this\n\n<local-images>\n- "/tmp/shot.png"\n- "/tmp/two.png"\n</local-images>\nThe user attached these images. You MUST inspect every image with the read tool before responding.',
      ),
    ).toEqual(["shot.png", "two.png"]);
  });

  it("names attached files too", () => {
    expect(
      attachmentSummaryText(
        'read it\n\n<local-files>\n- "/tmp/a/report.pdf"\n</local-files>\nUse the read tool on these local files when their contents are needed.',
      ),
    ).toEqual(["report.pdf"]);
  });

  it("stays empty for a plain message", () => {
    expect(attachmentSummaryText("just text")).toEqual([]);
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

describe("mergeTranscriptItem", () => {
  const message = (id: string, content: string): TranscriptItem =>
    ({
      kind: "message",
      id,
      sessionId: "s",
      role: "assistant",
      content,
      createdAt: "00:00",
    }) as TranscriptItem;

  const tool = (
    id: string,
    status: string,
    output?: string,
  ): TranscriptItem =>
    ({
      kind: "tool",
      id,
      sessionId: "s",
      name: "bash",
      description: "bash",
      status,
      createdAt: "00:00",
      ...(output ? { output } : {}),
    }) as unknown as TranscriptItem;

  it("keeps a running tool call running when a rescan reports no outcome", () => {
    // The live connection reports a tool call the moment it starts. A transcript rescan
    // rebuilds the same row from the persisted file, where the broker writes no status on
    // a tool block at all -- verified against a live session: 55 blocks, none with one --
    // so a call still in flight comes back with nothing but the fact it was never
    // resolved. Replacing the row wholesale let that overwrite 상태 and the card flipped to
    // a finished state while the tool was still working.
    const merged = mergeTranscriptItem(
      [tool("call-1", "running")],
      tool("call-1", "cancelled"),
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ id: "call-1", status: "running" });
  });

  it("accepts a real outcome for a running tool call", () => {
    // The guard above must not freeze a card: a rescan that carries an actual result still
    // settles the row.
    expect(
      mergeTranscriptItem(
        [tool("call-1", "running")],
        tool("call-1", "completed", "done"),
      )[0],
    ).toMatchObject({ status: "completed", output: "done" });
    expect(
      mergeTranscriptItem([tool("c", "running")], tool("c", "failed"))[0],
    ).toMatchObject({ status: "failed" });
  });

  it("appends an item the history has not seen", () => {
    const items = [message("a", "one")];
    expect(mergeTranscriptItem(items, message("b", "two")).map((i) => i.id)).toEqual([
      "a",
      "b",
    ]);
  });

  it("replaces a republished item instead of duplicating it", () => {
    // A rescan re-sends a tool row when it finishes. Appending it again put the
    // same call in the transcript twice.
    const items = [message("a", "one"), message("b", "running")];
    const merged = mergeTranscriptItem(items, message("b", "done"));
    expect(merged.map((i) => i.id)).toEqual(["a", "b"]);
    expect(
      merged.find((i) => i.id === "b") as Extract<
        TranscriptItem,
        { kind: "message" }
      >,
    ).toMatchObject({ content: "done" });
  });

  it("keeps the local thumbnails when the persisted rebuild replaces the row", () => {
    // Only this window holds the image bytes: the app reads the file and echoes the
    // bubble with inline base64, while the persisted transcript stores just the path
    // inside the prompt text. The rebuild therefore arrives with no `images`, and
    // replacing the row wholesale erased the thumbnail the user had just seen.
    const local = {
      kind: "message",
      id: "local-prompt-1",
      sessionId: "s",
      role: "user",
      content:
        '이거 봐줘\n\n<local-images>\n- "/tmp/shot.png"\n</local-images>\nThe user attached these images. You MUST inspect every image with the read tool before responding.',
      createdAt: "00:00",
      images: [
        {
          id: "img-1",
          name: "shot.png",
          mimeType: "image/png",
          data: "AAAA",
          path: "/tmp/shot.png",
        },
      ],
    } as unknown as TranscriptItem;
    const rebuilt = {
      kind: "message",
      id: "shared-message-9",
      sessionId: "s",
      role: "user",
      content: local.kind === "message" ? local.content : "",
      createdAt: "00:01",
    } as unknown as TranscriptItem;

    const merged = mergeTranscriptItem([local], rebuilt);

    expect(merged).toHaveLength(1);
    expect(merged[0]!.id).toBe("shared-message-9");
    expect(
      (merged[0] as Extract<TranscriptItem, { kind: "message" }>).images,
    ).toEqual(local.kind === "message" ? local.images : undefined);
  });

  it("keeps untouched items by reference so memoized rows do not re-render", () => {
    const first = message("a", "one");
    const merged = mergeTranscriptItem([first], message("b", "two"));
    expect(merged[0]).toBe(first);
  });

  it("retires the streamed copy when the persisted rebuild of the same reply arrives", () => {
    // The live stream names a reply `gjc-message-<messageId>`; the persisted
    // rebuild names the same reply `shared-message-<rowId>`. An id-only match
    // appended the rebuild as a new row, so one reply rendered twice -- once
    // above and once below the tool card it wrapped.
    const items = [
      message("gjc-message-m1", "답이 나왔습니다."),
      message("call-1", "tool"),
    ];
    const merged = mergeTranscriptItem(
      items,
      message("shared-message-r1", "답이 나왔습니다."),
    );
    expect(merged.map((i) => i.id)).toEqual(["shared-message-r1", "call-1"]);
  });

  it("does not retire a streamed message whose body differs", () => {
    const items = [message("gjc-message-m1", "first reply")];
    const merged = mergeTranscriptItem(
      items,
      message("shared-message-r1", "second reply"),
    );
    expect(merged.map((i) => i.id)).toEqual([
      "gjc-message-m1",
      "shared-message-r1",
    ]);
  });

  it("retires the echoed request when its persisted rebuild arrives", () => {
    // Aborting a turn republishes the tail, so the request the window echoed as
    // `local-prompt-` met its `shared-message-` rebuild through the appended
    // path and rendered as two identical bubbles.
    const echo = {
      ...message("local-prompt-9", "음 좀 고셔진거 같네"),
      role: "user" as const,
    };
    const rebuilt = {
      ...message("shared-message-abc", "음 좀 고셔진거 같네"),
      role: "user" as const,
    };
    expect(mergeTranscriptItem([echo], rebuilt).map((i) => i.id)).toEqual([
      "shared-message-abc",
    ]);
  });

  it("retires the local cancellation notice when the persisted one arrives", () => {
    const local = {
      kind: "notice",
      id: "gjc-cancelled-3",
      sessionId: "s",
      title: "작업 취소됨",
      content: "진행 중인 작업이 취소되어 종료됐습니다.",
      tone: "neutral",
      createdAt: "08:50",
    } as unknown as TranscriptItem;
    const rebuilt = {
      ...local,
      id: "shared-cancelled-def",
    } as TranscriptItem;
    expect(mergeTranscriptItem([local], rebuilt).map((i) => i.id)).toEqual([
      "shared-cancelled-def",
    ]);
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

  it("does not serialize unchanged rows when one row is appended", () => {
    const history = Array.from({ length: 500 }, (_value, index) => ({
      ...message,
      id: `message-${index}`,
    })) as TranscriptItem[];
    const poison = { ...message, id: "message-0" } as TranscriptItem;
    Object.defineProperty(poison, "poison", {
      enumerable: true,
      get() {
        throw new Error("serialized an unchanged row");
      },
    });
    history[0] = poison;
    const transcripts = { "session-1": history };
    let cached: Record<string, TranscriptItem[]> | undefined;
    expect(() => {
      cached = cacheTranscript(transcripts, "session-1", [
        ...history,
        { ...message, id: "message-new" } as TranscriptItem,
      ]);
    }).not.toThrow();
    expect(cached?.["session-1"]).toHaveLength(history.length + 1);
    expect(cached?.["session-1"][0]).toBe(poison);
    expect(cached?.["session-1"].at(-1)?.id).toBe("message-new");
  });

  it("keeps an optimistic user message until polling confirms it", () => {
    const optimistic = {
      ...message,
      id: "local-prompt-1",
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
  it("keeps a controller-echoed prompt or steer until the sync confirms it", () => {
    // The controller echoes its own bubbles as `local-prompt-`; a persisted
    // transcript sync that has not caught up yet must not erase them, or a
    // just-sent message vanishes for seconds mid-turn.
    const echo = {
      ...message,
      id: "local-prompt-7",
      role: "user" as const,
      content: "지금 바로 확인해",
    };
    const transcripts = { "session-1": [message, echo] };

    const pending = cacheTranscript(transcripts, "session-1", [{ ...message }]);
    expect(pending["session-1"].at(-1)).toBe(echo);

    const confirmed = cacheTranscript(pending, "session-1", [
      { ...message },
      {
        ...message,
        id: "gjc-message-9",
        role: "user" as const,
        content: "지금 바로 확인해",
      },
    ]);
    expect(confirmed["session-1"].some((item) => item.id === echo.id)).toBe(
      false,
    );
  });

  it("drops the echo when the confirming remote row was already on screen", () => {
    // The persisted sync publishes the remote user row first, then a rescan
    // republishes the same history. The echo has to retire against that already
    // known row; requiring a newly seen id pinned it forever and the request
    // rendered as two identical bubbles.
    const remote = {
      ...message,
      id: "shared-message-user-1",
      role: "user" as const,
      content: "만약 저거 반영 안하면 앱에는 어떤 일이 있지 ?",
    };
    const echo = {
      ...message,
      id: "local-prompt-3",
      role: "user" as const,
      content: "만약 저거 반영 안하면 앱에는 어떤 일이 있지 ?",
    };
    const settled = cacheTranscript({ "session-1": [remote, echo] }, "session-1", [
      remote,
    ]);
    expect(settled["session-1"].map((item) => item.id)).toEqual([remote.id]);
  });

  it("keeps two identical requests when only one has been confirmed", () => {
    const echoOne = {
      ...message,
      id: "local-prompt-1",
      role: "user" as const,
      content: "다시 해",
    };
    const echoTwo = { ...echoOne, id: "local-prompt-2" };
    const settled = cacheTranscript(
      { "session-1": [echoOne, echoTwo] },
      "session-1",
      [{ ...message, id: "shared-message-1", role: "user", content: "다시 해" }],
    );
    expect(settled["session-1"]).toHaveLength(2);
  });

  it("confirms an attachment-only request by its file names", () => {
    const echo = {
      ...message,
      id: "local-prompt-8",
      role: "user" as const,
      content: '\n\n<local-files>\n- "/tmp/a/report.pdf"\n</local-files>',
    };
    const settled = cacheTranscript({ "session-1": [echo] }, "session-1", [
      {
        ...message,
        id: "shared-message-2",
        role: "user" as const,
        content: '<local-files>\n- "/other/report.pdf"\n</local-files>',
      },
    ]);
    expect(settled["session-1"].map((item) => item.id)).toEqual([
      "shared-message-2",
    ]);
  });

  it("keeps an unmatched image or steer request at the end until it is confirmed", () => {
    const optimistic = {
      ...message,
      id: "local-prompt-1",
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
      "local-prompt-1",
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

describe("shouldFollowTranscript", () => {
  const clientHeight = 477;
  const scrollHeight = 168_000;
  const at = (px: number, scrolledAway: boolean) =>
    shouldFollowTranscript(
      scrollHeight,
      scrollHeight - clientHeight - px,
      clientHeight,
      scrolledAway,
    );

  it("leaves a small deliberate scroll up alone", () => {
    // The bug this encodes, measured with real wheel events on a ~1200-block session:
    // one notch moves 109px, the follow threshold is a third of a 477px viewport (159px),
    // so the view was still "near the bottom" and the 120ms settle timer pulled it back.
    // Net movement was 0px -- the scroll simply did not happen as far as the user could
    // tell. Two notches (198px) cleared the threshold and worked, which is why this only
    // showed up on small scrolls.
    expect(at(109, true)).toBe(false);
    expect(at(40, true)).toBe(false);
    // Any distance at all, once it was asked for.
    expect(at(2, true)).toBe(false);
  });

  it("still absorbs the estimation error from unmounted rows", () => {
    // Rows above the viewport are unmounted, so the scroll height is an estimate and a
    // drag to the end can land a couple hundred pixels short. That is not a scroll away,
    // and reading it as one leaves a blank band under the newest message with the
    // 최신 내용으로 button stuck on screen.
    expect(at(200, false)).toBe(true);
    expect(at(158, false)).toBe(true);
    expect(at(0, false)).toBe(true);
  });

  it("resumes following once the view is back at the bottom", () => {
    // Scrolling back down has to re-arm following, or new messages stop arriving in view
    // for the rest of the session.
    expect(at(0, true)).toBe(true);
    expect(at(1, true)).toBe(true);
  });

  it("keeps a genuine scroll away from following", () => {
    // Past one viewport nothing can explain the distance as estimation error.
    expect(at(2_000, false)).toBe(false);
    expect(at(478, false)).toBe(false);
    // And with a gesture behind it, any distance counts.
    expect(at(400, true)).toBe(false);
  });
});

describe("transcriptScrollIntent", () => {
  it("reverses an upward scroll intent as soon as the user heads back down", () => {
    // Keeping the earlier upward gesture active until an exact 0-1px landing left the
    // 최신 내용으로 chip stuck when a trackpad coasted to 2-40px from the bottom.
    // Direction reversal is the intent: once the wheel heads toward the latest content,
    // virtualization slack may finish the last few pixels for it.
    expect(transcriptScrollIntent(true, 109)).toBe(false);
    expect(transcriptScrollIntent(true, 1)).toBe(false);
  });

  it("marks upward input as leaving the latest content", () => {
    expect(transcriptScrollIntent(false, -109)).toBe(true);
    expect(transcriptScrollIntent(false, -1)).toBe(true);
  });

  it("does not invent a direction for a zero-delta wheel event", () => {
    expect(transcriptScrollIntent(true, 0)).toBe(true);
    expect(transcriptScrollIntent(false, 0)).toBe(false);
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

describe("mergeDiscoveredSessions", () => {
  const session = (id: string, status: string, unread = false) => ({
    id,
    status,
    unread,
  });

  it("adds newly discovered CLI sessions while keeping live local state", () => {
    // The named concern is that a refresh must not discard what this window
    // tracks about an open row. Status is excluded: the main process already
    // decides whether a row's own turn or its transcript is the authority, so
    // preferring the on-screen copy here only re-pinned a stale value.
    expect(
      mergeDiscoveredSessions(
        [{ ...session("open", "running"), model: "opus" }],
        [
          { ...session("open", "idle"), model: undefined },
          { ...session("cli-new", "idle"), model: undefined },
        ],
      ),
    ).toEqual([
      { ...session("open", "idle"), model: "opus" },
      { ...session("cli-new", "idle"), model: undefined },
    ]);
  });

  it("keeps the focused session when a refresh momentarily misses it", () => {
    // Losing the open conversation from the list moves focus to another session,
    // so a refresh that does not report it must not drop it.
    expect(
      mergeDiscoveredSessions(
        [session("open", "running"), session("other", "idle")],
        [session("other", "idle")],
        "open",
      ).map((entry) => entry.id),
    ).toEqual(["open", "other"]);
  });

  it("still removes an unfocused session that discovery stopped reporting", () => {
    expect(
      mergeDiscoveredSessions(
        [session("gone", "idle"), session("open", "running")],
        [session("open", "idle")],
        "open",
      ).map((entry) => entry.id),
    ).toEqual(["open"]);
  });

  it("takes the status discovery derived from the transcript", () => {
    // Discovery reads run state from the session's transcript, which is the only
    // account of work another process is driving. Preferring the on-screen value
    // pinned a row to whatever it was listed as, so a working session read 완료.
    expect(
      mergeDiscoveredSessions(
        [session("a", "idle")],
        [session("a", "running")],
      ).map((entry) => entry.status),
    ).toEqual(["running"]);
  });

  it("does not let an older discovery response replace a newer live status", () => {
    expect(
      mergeDiscoveredSessions(
        [{ ...session("open", "running"), runRevision: 2 }],
        [{ ...session("open", "idle"), runRevision: 1 }],
      )[0],
    ).toMatchObject({ status: "running", runRevision: 2 });
    expect(
      mergeDiscoveredSessions(
        [{ ...session("open", "idle"), runRevision: 1 }],
        [{ ...session("open", "running"), runRevision: 2 }],
      )[0],
    ).toMatchObject({ status: "running", runRevision: 2 });
  });

  it("takes a settled status over a stale running row", () => {
    expect(
      mergeDiscoveredSessions(
        [session("a", "running")],
        [session("a", "idle")],
      ).map((entry) => entry.status),
    ).toEqual(["idle"]);
  });

  it("holds row order steady when discovery reranks by activity", () => {
    expect(
      mergeDiscoveredSessions(
        [session("a", "idle"), session("b", "idle"), session("c", "idle")],
        [session("c", "idle"), session("a", "idle"), session("b", "idle")],
      ).map((entry) => entry.id),
    ).toEqual(["a", "b", "c"]);
  });

  it("keeps a session that is still being created locally", () => {
    expect(
      mergeDiscoveredSessions(
        [session("draft-1", "starting")],
        [session("kept", "idle")],
      ).map((entry) => entry.id),
    ).toEqual(["draft-1", "kept"]);
  });

  it("removes a session discovery no longer reports", () => {
    expect(
      mergeDiscoveredSessions(
        [session("closed", "idle"), session("kept", "idle")],
        [session("kept", "idle")],
      ).map((entry) => entry.id),
    ).toEqual(["kept"]);
  });
});
