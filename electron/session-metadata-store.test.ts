import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SessionMetadataStore } from "./session-metadata-store.js";

function store(
  seed?: Record<string, unknown>,
): { directory: string; open: () => SessionMetadataStore } {
  const directory = mkdtempSync(path.join(tmpdir(), "gjc-session-meta-"));
  if (seed)
    writeFileSync(
      path.join(directory, "agent-control-sessions.json"),
      JSON.stringify(seed),
    );
  return { directory, open: () => new SessionMetadataStore(directory) };
}

describe("SessionMetadataStore hidden ids", () => {
  it("forgets hidden ids the agent no longer knows about", () => {
    // `hidden` exists to keep a deleted session out of discovery. Once the agent has
    // forgotten the session there is nothing left to filter, but ids stayed on disk
    // forever -- 629 of them against three aliases on this machine -- and every
    // write rewrote the whole file.
    const gone = Array.from({ length: 200 }, (_, index) => `gone-${index}`);
    const { directory, open } = store({
      aliases: {},
      workspaces: {},
      hidden: [...gone, "still-known"],
      ownership: {},
      unread: {},
      worktrees: {},
    });
    const file = path.join(directory, "agent-control-sessions.json");
    try {
      const metadata = open();
      const before = readFileSync(file, "utf8").length;

      const dropped = metadata.forgetHiddenOutside(new Set(["still-known"]));

      expect(dropped).toBe(200);
      // The id the agent still reports has to stay hidden, otherwise a deleted
      // session reappears in the list.
      expect(metadata.isHidden("still-known")).toBe(true);
      expect(metadata.isHidden("gone-0")).toBe(false);
      expect(readFileSync(file, "utf8").length).toBeLessThan(before);
      // The pruning is persisted, not just applied in memory.
      expect(open().isHidden("gone-0")).toBe(false);
      expect(open().isHidden("still-known")).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not rewrite the file when every hidden id is still known", () => {
    // A write on every discovery pass would rewrite the whole file each poll for no
    // change at all.
    const { directory, open } = store({
      aliases: {},
      workspaces: {},
      hidden: ["known-1", "known-2"],
      ownership: {},
      unread: {},
      worktrees: {},
    });
    const file = path.join(directory, "agent-control-sessions.json");
    try {
      const metadata = open();
      const before = readFileSync(file, "utf8");

      const dropped = metadata.forgetHiddenOutside(
        new Set(["known-1", "known-2"]),
      );

      expect(dropped).toBe(0);
      expect(readFileSync(file, "utf8")).toBe(before);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps hiding a session while the agent still lists it", () => {
    // Discovery filters on this set, so dropping an id the broker still reports
    // would bring a session the user deleted back onto the list.
    const { directory, open } = store();
    try {
      const metadata = open();
      metadata.hideSession("deleted-session");
      expect(metadata.isHidden("deleted-session")).toBe(true);

      metadata.forgetHiddenOutside(new Set(["deleted-session"]));

      expect(metadata.isHidden("deleted-session")).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
