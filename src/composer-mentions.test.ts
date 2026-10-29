import { describe, expect, it } from "vitest";
import {
  activeMention,
  mentionCandidates,
  mentionKeyAction,
  rankMentionCandidates,
  withoutMention,
} from "./composer-mentions";

describe("activeMention", () => {
  it("reads the token the caret is in from its @ to the next whitespace", () => {
    expect(activeMention("@ren", 4)).toEqual({ start: 0, end: 4, query: "ren" });
    expect(activeMention("look at @src/app please", 12)).toEqual({
      start: 8,
      end: 16,
      query: "src/app",
    });
    expect(activeMention("@", 1)).toEqual({ start: 0, end: 1, query: "" });
  });

  it("ignores an @ inside a word and a caret outside the token", () => {
    expect(activeMention("me@example.com", 14)).toBeNull();
    expect(activeMention("@ren please", 11)).toBeNull();
    expect(activeMention("/model", 6)).toBeNull();
  });
});

describe("withoutMention", () => {
  it("removes the token and the space it leaves doubled", () => {
    const value = "look at @ren please";
    expect(withoutMention(value, activeMention(value, 12)!)).toEqual({
      value: "look at please",
      caret: 8,
    });
    expect(withoutMention("@ren", activeMention("@ren", 4)!)).toEqual({
      value: "",
      caret: 0,
    });
  });
});

describe("rankMentionCandidates", () => {
  const files = mentionCandidates([
    "docs/rendering/guide.md",
    "src/app/renderer.ts",
    "src/app/composer.tsx",
    "src/app/composer.test.tsx",
    "src/composer-utils.ts",
    "scripts/attachment-render-smoke.mjs",
    "README.md",
  ]);

  it("puts a file-name prefix ahead of matches deeper in the path", () => {
    expect(rankMentionCandidates(files, "ren", 3)).toEqual([
      "src/app/renderer.ts",
      "scripts/attachment-render-smoke.mjs",
      "docs/rendering/guide.md",
    ]);
  });

  it("matches a path query and a scattered subsequence", () => {
    expect(rankMentionCandidates(files, "app/comp", 1)).toEqual([
      "src/app/composer.tsx",
    ]);
    expect(rankMentionCandidates(files, "cmpsr", 2)).toEqual([
      "src/app/composer.tsx",
      "src/composer-utils.ts",
    ]);
  });

  it("is case-insensitive, bounded, and empty when nothing matches", () => {
    expect(rankMentionCandidates(files, "README", 5)).toEqual(["README.md"]);
    expect(rankMentionCandidates(files, "", 2)).toEqual([
      "README.md",
      "src/composer-utils.ts",
    ]);
    expect(rankMentionCandidates(files, "zzz", 5)).toEqual([]);
  });
});

describe("mentionKeyAction", () => {
  const key = (overrides: Partial<Parameters<typeof mentionKeyAction>[0]>) => ({
    key: "Enter",
    shiftKey: false,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    composing: false,
    afterCommit: false,
    ...overrides,
  });

  it("navigates and chooses with the keyboard alone", () => {
    expect(mentionKeyAction(key({ key: "ArrowDown" }), true)).toBe("next");
    expect(mentionKeyAction(key({ key: "ArrowUp" }), true)).toBe("previous");
    expect(mentionKeyAction(key({ key: "Enter" }), true)).toBe("choose");
    expect(mentionKeyAction(key({ key: "Tab" }), true)).toBe("choose");
    expect(mentionKeyAction(key({ key: "Escape" }), false)).toBe("dismiss");
  });

  it("neither chooses nor sends on the Enter that commits a Korean syllable", () => {
    expect(mentionKeyAction(key({ composing: true }), true)).toBe("swallow");
    expect(mentionKeyAction(key({ afterCommit: true }), true)).toBe("swallow");
    expect(mentionKeyAction(key({ key: "ArrowDown", composing: true }), true)).toBeNull();
    expect(mentionKeyAction(key({ key: "Escape", composing: true }), true)).toBeNull();
  });

  it("leaves keys to the composer when there is nothing to choose or a modifier is held", () => {
    expect(mentionKeyAction(key({ key: "Enter" }), false)).toBeNull();
    expect(mentionKeyAction(key({ key: "ArrowDown" }), false)).toBeNull();
    expect(mentionKeyAction(key({ shiftKey: true }), true)).toBeNull();
    expect(mentionKeyAction(key({ key: "ArrowUp", altKey: true }), true)).toBeNull();
  });
});
