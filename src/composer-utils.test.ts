import { describe, expect, it } from "vitest";
import {
  compactToolCommand,
  compactToolText,
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
});
