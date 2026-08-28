import { describe, expect, it } from "vitest";
import { humanErrorMessage } from "./format";

describe("humanErrorMessage", () => {
  it("masks credentials that reached an error message", () => {
    // Errors are surfaced verbatim in the UI, and a failure from a lower layer
    // carries whatever was on the wire. A rejected auth header put the token itself
    // on screen. The main process already redacts what it writes to artifacts; this
    // is the same guarantee for what the user is shown.
    const masked = [
      "Request rejected: Bearer sk-abc123def456ghi789",
      "invalid key sk-proj-abcdefgh12345678",
      "config error: api_key=supersecretvalue123",
      "spawn failed: GITHUB_TOKEN=ghp_abcdef123456",
      'response: {"authorization": "Token abcdef123456"}',
    ];
    for (const input of masked) {
      const output = humanErrorMessage(new Error(input));
      expect(output).toContain("[삭제됨]");
      expect(output).not.toMatch(/sk-[A-Za-z0-9_-]{8,}/u);
      expect(output).not.toMatch(/ghp_[A-Za-z0-9]+/u);
      expect(output).not.toContain("supersecretvalue123");
      expect(output).not.toContain("abcdef123456");
    }
  });

  it("keeps the file path a failure is about", () => {
    // Redaction must not eat the detail that makes an error actionable: the user
    // needs to know which file could not be opened.
    const output = humanErrorMessage(
      new Error("ENOENT: no such file or directory, open '/tmp/project/main.ts'"),
    );
    expect(output).toContain("/tmp/project/main.ts");
    expect(output).not.toContain("[삭제됨]");
  });

  it("still translates the messages it recognizes", () => {
    // The redaction pass runs before the known-message checks, so it must not break
    // the matching those rely on.
    expect(humanErrorMessage(new Error("operation aborted"))).toBe(
      "작업이 취소되었습니다.",
    );
    expect(humanErrorMessage(new Error("uncertain_after_send"))).toContain(
      "확인하지 못했습니다",
    );
  });

  it("handles a thrown value that is not an Error", () => {
    expect(humanErrorMessage("Bearer sk-abcdefgh12345678")).toContain("[삭제됨]");
    expect(humanErrorMessage(undefined)).toBe("undefined");
  });
});
