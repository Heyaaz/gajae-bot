import { describe, expect, it } from "vitest";
import {
  DEEP_LINK_PROMPT_LIMIT,
  deepLinksInArgv,
  sessionShortcutForDeepLink,
} from "./deep-link.js";

const folders = new Set(["/Users/me/project"]);
const parse = (url: string) =>
  sessionShortcutForDeepLink(url, (candidate) => folders.has(candidate));

describe("gajae:// links", () => {
  it("opens the new-session dialog with the prompt and folder, never a session", () => {
    expect(parse("gajae://new?prompt=fix%20the%20build&path=%2FUsers%2Fme%2Fproject")).toEqual({
      type: "new",
      prefill: { workspace: "/Users/me/project", prompt: "fix the build" },
    });
    expect(parse("gajae://new/?prompt=a+b")).toEqual({ type: "new", prefill: { prompt: "a b" } });
    expect(parse("gajae://new")).toEqual({ type: "new", prefill: {} });
  });

  it("opens a session by id", () => {
    expect(parse("gajae://session/0198-abc")).toEqual({ type: "open", sessionId: "0198-abc" });
    expect(parse("gajae://session/a%20b")).toEqual({ type: "open", sessionId: "a b" });
  });

  it("refuses a folder that is relative, missing, or not a directory, and says which", () => {
    for (const requested of ["project", "/Users/me/missing", "~/project"])
      expect(parse(`gajae://new?path=${encodeURIComponent(requested)}`)).toEqual({
        type: "invalidLink",
        reason: { kind: "path", path: requested },
      });
  });

  it("refuses a prompt over the limit instead of cutting it", () => {
    const prompt = "x".repeat(DEEP_LINK_PROMPT_LIMIT + 1);
    expect(parse(`gajae://new?prompt=${prompt}`)).toEqual({
      type: "invalidLink",
      reason: { kind: "prompt", limit: DEEP_LINK_PROMPT_LIMIT },
    });
    expect(parse(`gajae://new?prompt=${"x".repeat(DEEP_LINK_PROMPT_LIMIT)}`)).toMatchObject({
      type: "new",
    });
  });

  it("refuses a session link without a usable id", () => {
    for (const url of [
      "gajae://session",
      "gajae://session/",
      "gajae://session/a/b",
      "gajae://session/%E0%A4%A",
      `gajae://session/${"x".repeat(257)}`,
    ])
      expect(parse(url)).toEqual({ type: "invalidLink", reason: { kind: "session" } });
  });

  it("ignores anything that is not a Gajae link", () => {
    for (const url of [
      "https://example.com/new?prompt=x",
      "gajae://settings",
      "gajae://new/extra",
      "gajae:new",
      "not a url",
    ])
      expect(parse(url)).toBeUndefined();
  });

  it("finds links among launch arguments", () => {
    expect(
      deepLinksInArgv(["/Applications/Gajae.app", "--flag", "gajae://session/1", "https://x"]),
    ).toEqual(["gajae://session/1"]);
  });
});
