import { describe, expect, it } from "vitest";
import {
  compactToolCommand,
  compactToolText,
  composerQueuePreview,
  droppedImageAttachments,
  isWaitingComposerText,
  mergeComposerQueue,
  readableToolText,
  releaseSettledChips,
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
    expect(
      mergeComposerQueue(
        [
          {
            id: "remote",
            text: "steer 중요하다",
            mode: "followUp",
            label: "Queued",
          },
        ],
        [
          {
            id: "local",
            text: "steer 중요하다",
            mode: "followUp",
            label: "Queued",
          },
        ],
      ),
    ).toEqual([
      {
        id: "remote",
        text: "steer 중요하다",
        mode: "followUp",
        label: "Queued",
      },
    ]);
  });

  it("matches waiting composer text against a later user echo", () => {
    expect(isWaitingComposerText("안고쳐졌는데 ?", ["안고쳐졌는데  ?"])).toBe(
      true,
    );
    expect(isWaitingComposerText("다른 요청", ["안고쳐졌는데 ?"])).toBe(false);
    expect(isWaitingComposerText("   ", ["안고쳐졌는데 ?"])).toBe(false);
  });
});

describe("releaseSettledChips", () => {
  const chip = (text: string) => ({
    id: `local-${text}`,
    text,
    mode: "steer" as const,
    label: "Steer",
  });
  const listed = (text: string) => ({
    id: `q-${text}`,
    text,
    mode: "steer" as const,
    label: "Steer",
  });

  it("releases a consumed steer once it appears in the transcript", () => {
    // A steer bypasses the queue entirely, so without the transcript signal this
    // chip has no settle condition and the composer shows a permanent
    // "1개 대기 중".
    expect(releaseSettledChips([chip("steered")], [], ["steered"])).toEqual([]);
  });

  it("keeps a steer chip that the transcript has not echoed yet", () => {
    expect(
      releaseSettledChips([chip("steered")], [], ["something else"]),
    ).toEqual([chip("steered")]);
  });

  it("releases only the chips the queue now lists", () => {
    expect(
      releaseSettledChips(
        [chip("first"), chip("second")],
        [listed("first")],
      ).map((entry) => entry.text),
    ).toEqual(["second"]);
  });

  it("keeps every chip when the listing is still empty", () => {
    // The second Enter aborts the turn before GJC reports the promotion, so an
    // empty listing must not erase the request from the window.
    expect(releaseSettledChips([chip("pending")], [])).toHaveLength(1);
  });

  it("matches on whitespace-normalized text", () => {
    expect(
      releaseSettledChips([chip("hello   world")], [listed("hello world")]),
    ).toEqual([]);
  });
});
