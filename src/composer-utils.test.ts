import { describe, expect, it } from "vitest";
import {
  compactToolCommand,
  compactToolText,
  composerQueuePreview,
  appendPendingRequest,
  nextRequestToRelease,
  withoutReleasedRequest,
  droppedImageAttachments,
  readableToolText,
  resolveModelPreset,
} from "./composer-utils";

describe("composer utilities", () => {
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
