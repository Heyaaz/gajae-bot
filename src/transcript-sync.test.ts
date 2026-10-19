import { describe, expect, it, vi } from "vitest";
import type { TranscriptItem } from "./backend/types";
import {
  readTranscriptForSafetyNet,
  stableTranscriptRevision,
} from "./transcript-sync";

const row = (content: string): TranscriptItem => ({
  id: "m-1",
  kind: "message",
  sessionId: "s-1",
  role: "assistant",
  content,
  createdAt: "now",
});

describe("transcript safety-net revision", () => {
  it("keeps a revision only when it did not move during the read", () => {
    expect(stableTranscriptRevision("rev-1", "rev-1")).toBe("rev-1");
    expect(stableTranscriptRevision("rev-1", "rev-2")).toBeUndefined();
    expect(stableTranscriptRevision(undefined, "rev-2")).toBeUndefined();
  });

  it("skips the body when the known revision is still current", async () => {
    const readItems = vi.fn(async () => [row("new")]);
    const outcome = await readTranscriptForSafetyNet({
      knownRevision: "rev-1",
      readRevision: async () => "rev-1",
      readItems,
    });
    expect(outcome).toEqual({ kind: "skipped" });
    expect(readItems).not.toHaveBeenCalled();
  });

  it("does not pin a revision that moved while the body was read", async () => {
    let revision = "rev-1";
    const readItems = vi.fn(async () => {
      revision = "rev-2";
      return [row("old")];
    });
    const raced = await readTranscriptForSafetyNet({
      knownRevision: undefined,
      readRevision: async () => revision,
      readItems,
    });
    expect(raced).toEqual({
      kind: "loaded",
      items: [row("old")],
      change: { kind: "full", items: [row("old")] },
      revision: undefined,
    });

    const caughtUp = await readTranscriptForSafetyNet({
      knownRevision: undefined,
      readRevision: async () => revision,
      readItems: async () => [row("new")],
    });
    expect(caughtUp).toEqual({
      kind: "loaded",
      items: [row("new")],
      change: { kind: "full", items: [row("new")] },
      revision: "rev-2",
    });
  });

  it("reads again after a raced sample instead of trusting the missed revision", async () => {
    let revision = "rev-1";
    let body = "old";
    const reads: string[] = [];
    const first = await readTranscriptForSafetyNet({
      knownRevision: undefined,
      readRevision: async () => revision,
      readItems: async () => {
        const snapshot = body;
        revision = "rev-2";
        body = "new";
        reads.push(snapshot);
        return [row(snapshot)];
      },
    });
    expect(first.kind).toBe("loaded");
    if (first.kind !== "loaded") return;
    expect(first.revision).toBeUndefined();

    const second = await readTranscriptForSafetyNet({
      knownRevision: first.revision,
      readRevision: async () => revision,
      readItems: async () => {
        reads.push(body);
        return [row(body)];
      },
    });
    expect(second).toMatchObject({ kind: "loaded", revision: "rev-2" });
    expect(reads).toEqual(["old", "new"]);
  });
});
