import { describe, expect, it } from "vitest";
import type { ComposerDraft, PendingRequest } from "./composer-utils";
import {
  parkDraft,
  restoreDraft,
  compactToolCommand,
  compactToolText,
  composerQueuePreview,
  appendPendingRequest,
  isImmediateSdkCommandSubmission,
  isDuplicateSubmission,
  SUBMISSION_DEDUPE_MS,
  IME_COMMIT_WINDOW_MS,
  imeCommitSubmits,
  nextRequestToRelease,
  releaseRequests,
  withoutReleasedRequest,
  droppedImageAttachments,
  readableToolText,
  resolveModelPreset,
} from "./composer-utils";

describe("composer utilities", () => {
  it("dispatches SDK commands during a run without bypassing prompt queues", () => {
    const commands = [
      { name: "context" },
      { name: "clear" },
      { name: "skill:ralplan" },
      { name: "queue" },
    ];
    expect(isImmediateSdkCommandSubmission("/context", commands, false)).toBe(
      true,
    );
    expect(
      isImmediateSdkCommandSubmission("/clear now", commands, false),
    ).toBe(true);
    // Skills remain prompts, and explicit queue semantics stay owned by the composer.
    expect(
      isImmediateSdkCommandSubmission("/skill:ralplan plan it", commands, false),
    ).toBe(false);
    expect(isImmediateSdkCommandSubmission("/queue later", commands, false)).toBe(
      false,
    );
    // Unknown slash text is still a model prompt; attachments never become controls.
    expect(isImmediateSdkCommandSubmission("/unknown", commands, false)).toBe(
      false,
    );
    expect(isImmediateSdkCommandSubmission("/context", commands, true)).toBe(
      false,
    );
  });

  it("extracts text from ACP structured tool output and keeps a bounded tail preview", () => {
    const lines = Array.from({ length: 15 }, (_, index) => `line-${index + 1}`);
    const raw = JSON.stringify({
      content: [{ type: "text", text: lines.join("\n") }],
    });

    expect(readableToolText(raw)).toBe(lines.join("\n"));
    expect(compactToolText(raw, 5)).toMatchObject({
      text: lines.slice(-5).join("\n"),
      omittedLines: 10,
      truncated: true,
      fullText: lines.join("\n"),
    });
  });

  it("uses the command field instead of displaying raw input JSON", () => {
    expect(
      compactToolCommand(
        JSON.stringify({ command: "npm run verify", timeout: 300 }),
      ),
    ).toEqual({
      preview: "npm run verify",
      fullText: "npm run verify",
      truncated: false,
    });
  });

  it("converts dropped image files into message attachments", async () => {
    const file = new File([new Uint8Array([137, 80, 78, 71])], "capture.png", {
      type: "image/png",
    });
    await expect(droppedImageAttachments([file], 0)).resolves.toEqual([
      expect.objectContaining({
        name: "capture.png",
        mimeType: "image/png",
        data: "iVBORw==",
      }),
    ]);
  });

  it("resolves a slash-command preset name to an available profile", () => {
    const options = [
      { value: "GOAT", name: "GOAT" },
      { value: "codex-medium", name: "Codex Medium" },
      { value: "codex-pro", name: "Codex Pro" },
    ];
    expect(resolveModelPreset("GOAT", options)).toBe("GOAT");
    expect(resolveModelPreset("gajae-code/GOAT", options)).toBe("GOAT");
    expect(resolveModelPreset("codex-m", options)).toBe("codex-medium");
    expect(resolveModelPreset("codex", options)).toBeUndefined();
    expect(resolveModelPreset("missing", options)).toBeUndefined();
  });

  it("rejects unsupported or excessive dropped attachments", async () => {
    const text = new File(["not an image"], "notes.txt", {
      type: "text/plain",
    });
    await expect(droppedImageAttachments([text], 0)).rejects.toThrow(
      "not a supported",
    );
    const image = new File(["image"], "capture.png", { type: "image/png" });
    await expect(droppedImageAttachments([image], 6)).rejects.toThrow(
      "at most 6 images",
    );
  });
  it("previews ordinary live-turn input as a follow-up chip, not a user bubble", () => {
    expect(composerQueuePreview("steer 중요하다", [], [])).toEqual({
      text: "steer 중요하다",
      mode: "followUp",
    });
    expect(composerQueuePreview("/steer 지금 실행", [], [])).toEqual({
      text: "지금 실행",
      mode: "steer",
    });
  });
});

describe("composer-owned pending queue", () => {
  const request = (id: string, text: string) => ({
    id,
    text,
    mode: "followUp" as const,
    label: "Queued",
    images: [],
    files: [],
  });

  it("releases the oldest request first", () => {
    const pending = [request("a", "first"), request("b", "second")];
    expect(nextRequestToRelease(pending)?.id).toBe("a");
  });

  it("keeps a request until its own send resolves", () => {
    // Clearing the whole queue on release lost every entry after the first when a
    // later send failed, so only the released id may leave.
    const pending = [request("a", "first"), request("b", "second")];
    expect(withoutReleasedRequest(pending, "a").map((e) => e.id)).toEqual([
      "b",
    ]);
  });

  it("keeps duplicates apart by id rather than text", () => {
    // The same words submitted twice used to collapse into one chip and then both
    // vanished together; identity keeps them independent.
    const pending = [request("a", "same"), request("b", "same")];
    expect(withoutReleasedRequest(pending, "a").map((e) => e.id)).toEqual([
      "b",
    ]);
  });

  it("reports nothing to release once the queue is drained", () => {
    expect(nextRequestToRelease([])).toBeUndefined();
  });

  it("sends each released request exactly once", async () => {
    // Reproduces the duplicate steer: the queue lives behind a ref that only
    // refreshes on render, so a loop reading a stale snapshot after its await
    // re-selected the request it had just sent.
    let live: PendingRequest[] = [request("a", "지시 하나")];
    let rendered: PendingRequest[] = live;
    const sent: string[] = [];

    await releaseRequests({
      read: () => rendered,
      write: (pending) => {
        live = pending;
        // React refreshes the render-time view asynchronously; the loop must not
        // depend on it landing before the next iteration.
        void Promise.resolve().then(() => {
          rendered = live;
        });
      },
      send: async (entry) => {
        sent.push(entry.text);
      },
    });

    expect(sent).toEqual(["지시 하나"]);
    expect(live).toEqual([]);
  });

  it("drains the whole queue in order", async () => {
    let live: PendingRequest[] = [
      request("a", "first"),
      request("b", "second"),
      request("c", "third"),
    ];
    const sent: string[] = [];

    await releaseRequests({
      read: () => live,
      write: (pending) => {
        live = pending;
      },
      send: async (entry) => {
        sent.push(entry.text);
      },
    });

    expect(sent).toEqual(["first", "second", "third"]);
    expect(live).toEqual([]);
  });

  it("keeps a failed request at the front instead of losing the text", async () => {
    let live: PendingRequest[] = [request("a", "fails"), request("b", "later")];
    const sent: string[] = [];

    await releaseRequests({
      read: () => live,
      write: (pending) => {
        live = pending;
      },
      send: async (entry) => {
        sent.push(entry.text);
        throw new Error("send failed");
      },
    });

    expect(sent).toEqual(["fails"]);
    expect(live.map((entry) => entry.id)).toEqual(["a", "b"]);
  });
});

describe("imeCommitSubmits", () => {
  it("submits the commit that follows its own Enter", () => {
    expect(imeCommitSubmits(1_000, 1_016)).toBe(true);
  });

  it("never submits when no Enter is waiting", () => {
    expect(imeCommitSubmits(undefined, 1_016)).toBe(false);
  });

  it("ignores a commit for text typed after that Enter", () => {
    // The old implementation submitted whatever the textarea held 80ms after an
    // IME Enter, which sent text the user typed later as a second message they
    // never submitted.
    expect(imeCommitSubmits(1_000, 1_000 + IME_COMMIT_WINDOW_MS)).toBe(false);
    expect(imeCommitSubmits(1_000, 9_000)).toBe(false);
  });
});

describe("appendPendingRequest", () => {
  const request = (id: string, text: string) => ({
    id,
    text,
    mode: "followUp" as const,
    label: "Queued",
    images: [],
    files: [],
  });

  it("ignores an empty draft so a duplicated submit cannot re-queue", () => {
    // The Korean IME routes one Enter through both a rAF callback and the form
    // handler. submit() clears the textarea synchronously, so the second read sees
    // an empty draft -- and that must not append anything.
    expect(
      appendPendingRequest([request("a", "first")], request("b", "  ")),
    ).toEqual([request("a", "first")]);
  });

  it("keeps two deliberate submissions of the same text apart", () => {
    const once = appendPendingRequest([], request("a", "같은 말"));
    expect(
      appendPendingRequest(once, request("b", "같은 말")).map((e) => e.id),
    ).toEqual(["a", "b"]);
  });
});

describe("isDuplicateSubmission", () => {
  it("drops the second delivery of one Enter", () => {
    // The form handler and the IME composition callback both fire for a single
    // keypress, a few milliseconds apart, with identical text.
    const last = { text: "steer 테스트", at: 1_000 };
    expect(isDuplicateSubmission(last, "steer 테스트", 1_004)).toBe(true);
  });

  it("allows the same text again once the frame has passed", () => {
    const last = { text: "steer 테스트", at: 1_000 };
    expect(
      isDuplicateSubmission(last, "steer 테스트", 1_000 + SUBMISSION_DEDUPE_MS),
    ).toBe(false);
  });

  it("never suppresses different text", () => {
    const last = { text: "steer 테스트", at: 1_000 };
    expect(isDuplicateSubmission(last, "다른 요청", 1_002)).toBe(false);
  });

  it("matches across the whitespace the IME leaves behind", () => {
    const last = { text: "steer 테스트", at: 1_000 };
    expect(isDuplicateSubmission(last, "steer  테스트 ", 1_002)).toBe(true);
  });

  it("ignores an empty draft", () => {
    expect(isDuplicateSubmission({ text: "", at: 1_000 }, "   ", 1_001)).toBe(
      false,
    );
  });
});

describe("session drafts", () => {
  const draft = (value: string): ComposerDraft => ({
    value,
    images: [],
    files: [],
  });

  it("keeps unsent text with the session it was typed in", () => {
    // One composer serves every session, so text typed in A and left unsent used
    // to still be sitting there after switching to B -- and would have been sent
    // to B's agent.
    const drafts = new Map<string, ComposerDraft>();
    parkDraft(drafts, "session-a", draft("A에게 보낼 말"));
    expect(restoreDraft(drafts, "session-b").value).toBe("");
    expect(restoreDraft(drafts, "session-a").value).toBe("A에게 보낼 말");
  });

  it("gives a session its own draft back after a detour", () => {
    const drafts = new Map<string, ComposerDraft>();
    parkDraft(drafts, "session-a", draft("절반만 쓴 요청"));
    parkDraft(drafts, "session-b", draft("다른 요청"));
    expect(restoreDraft(drafts, "session-a").value).toBe("절반만 쓴 요청");
    expect(restoreDraft(drafts, "session-b").value).toBe("다른 요청");
  });

  it("forgets a draft once it has been sent", () => {
    // Submitting empties the composer, so the next park stores an empty draft.
    // Storing it would resurrect the sent text the next time the session opened.
    const drafts = new Map<string, ComposerDraft>();
    parkDraft(drafts, "session-a", draft("보낸 뒤"));
    parkDraft(drafts, "session-a", draft(""));
    expect(drafts.has("session-a")).toBe(false);
    expect(restoreDraft(drafts, "session-a").value).toBe("");
  });

  it("parks attachments even with no text", () => {
    const drafts = new Map<string, ComposerDraft>();
    parkDraft(drafts, "session-a", {
      value: "",
      images: [],
      files: [
        {
          id: "file-1",
          name: "note.md",
          mimeType: "text/markdown",
          size: 12,
          token: "file-capability",
        },
      ],
    });
    expect(restoreDraft(drafts, "session-a").files).toHaveLength(1);
  });

  it("hands a never-typed session an empty draft, not undefined", () => {
    expect(restoreDraft(new Map(), "fresh")).toEqual({
      value: "",
      images: [],
      files: [],
    });
  });
});
