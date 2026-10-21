import { mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GjcSdkController } from "./gjc-sdk-controller.js";

describe("sharedTranscriptReads bounds", () => {
  it("holds the cache to the transcripts still being re-read", async () => {
    // Every entry retains a transcript's parsed envelopes. Measured at 6.3MB each,
    // an unbounded map reached 372MB across 60 transcripts and would pass 2GB across
    // the 400 on this machine, so the cache is capped and evicts the oldest read.
    const directory = await mkdtemp(path.join(tmpdir(), "gjc-cache-bound-"));
    const controller = new GjcSdkController({
      workspace: "/tmp/project",
      emit: () => undefined,
    });
    const internals = controller as unknown as {
      sharedTranscriptReads: Map<string, { envelopes: unknown[] }>;
      readTranscriptEnvelopes: (
        file: string,
        info: Awaited<ReturnType<typeof stat>>,
      ) => Promise<unknown[]>;
    };
    try {
      const files: string[] = [];
      for (let index = 0; index < 24; index += 1) {
        const file = path.join(directory, `session-${index}.jsonl`);
        await writeFile(
          file,
          `${JSON.stringify({ type: "message", id: index })}\n`,
        );
        files.push(file);
        await internals.readTranscriptEnvelopes(file, await stat(file));
      }

      expect(internals.sharedTranscriptReads.size).toBeLessThanOrEqual(8);
      // The most recent read survives; the first one was evicted long ago.
      expect(internals.sharedTranscriptReads.has(files.at(-1)!)).toBe(true);
      expect(internals.sharedTranscriptReads.has(files[0]!)).toBe(false);

      controller.dispose();
      expect(internals.sharedTranscriptReads.size).toBe(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("evicts the transcript read longest ago, not the one just re-read", async () => {
    // Insertion order is the only thing making this an LRU, and a plain `set` on an
    // existing key does not change it. Without re-inserting, a transcript being
    // polled every few seconds is evicted on schedule while idle ones survive, and
    // every eviction costs a full re-parse of the file that is actually in use.
    const directory = await mkdtemp(path.join(tmpdir(), "gjc-cache-lru-"));
    const controller = new GjcSdkController({
      workspace: "/tmp/project",
      emit: () => undefined,
    });
    const internals = controller as unknown as {
      sharedTranscriptReads: Map<string, { envelopes: unknown[] }>;
      readTranscriptEnvelopes: (
        file: string,
        info: Awaited<ReturnType<typeof stat>>,
      ) => Promise<unknown[]>;
    };
    try {
      const files: string[] = [];
      for (let index = 0; index < 8; index += 1) {
        const file = path.join(directory, `session-${index}.jsonl`);
        await writeFile(
          file,
          `${JSON.stringify({ type: "message", id: index })}\n`,
        );
        files.push(file);
        await internals.readTranscriptEnvelopes(file, await stat(file));
      }

      // Re-read the oldest entry: it must now be the newest and survive the next
      // eviction, while the entry that has gone untouched longest leaves.
      const revived = files[0]!;
      await internals.readTranscriptEnvelopes(revived, await stat(revived));

      const extra = path.join(directory, "session-extra.jsonl");
      await writeFile(
        extra,
        `${JSON.stringify({ type: "message", id: 99 })}\n`,
      );
      await internals.readTranscriptEnvelopes(extra, await stat(extra));

      expect(internals.sharedTranscriptReads.has(revived)).toBe(true);
      expect(internals.sharedTranscriptReads.has(files[1]!)).toBe(false);
      controller.dispose();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("re-parses a same-size overwrite even when the mtime is restored", async () => {
    // A writer that replaces the file contents and puts the old mtime back leaves
    // size and mtime identical. The cached parse has to notice the ctime moving,
    // or the safety net keeps returning the previous conversation forever.
    const directory = await mkdtemp(path.join(tmpdir(), "gjc-cache-rewrite-"));
    const controller = new GjcSdkController({
      workspace: "/tmp/project",
      emit: () => undefined,
    });
    const internals = controller as unknown as {
      sharedTranscriptReads: Map<string, { envelopes: unknown[] }>;
      sharedSessionFiles: Map<string, string>;
      readTranscriptEnvelopes: (
        file: string,
        info: Awaited<ReturnType<typeof stat>>,
      ) => Promise<Record<string, unknown>[]>;
    };
    try {
      const file = path.join(directory, "session.jsonl");
      const beforeLine = `${JSON.stringify({ type: "message", id: "before" })}\n`;
      const afterLine = `${JSON.stringify({ type: "message", id: "after!" })}\n`;
      expect(Buffer.byteLength(afterLine)).toBe(Buffer.byteLength(beforeLine));
      const stamp = new Date(1_700_000_000_000);

      await writeFile(file, beforeLine);
      await utimes(file, stamp, stamp);
      const before = await stat(file);
      const first = await internals.readTranscriptEnvelopes(file, before);
      expect(first).toEqual([{ type: "message", id: "before" }]);

      // ctime is the rewrite signal, and this filesystem does not advance it
      // inside one timestamp tick. The pause is what lets the next write move it.
      await new Promise((resolve) => setTimeout(resolve, 20));
      await writeFile(file, afterLine);
      await utimes(file, stamp, stamp);
      const after = await stat(file);
      expect(after.size).toBe(before.size);
      expect(after.mtimeMs).toBe(before.mtimeMs);

      const second = await internals.readTranscriptEnvelopes(file, after);
      expect(second).toEqual([{ type: "message", id: "after!" }]);

      // The durable revision follows the same rule, so the safety net does not
      // skip the body read on the strength of a matching size and mtime.
      internals.sharedSessionFiles.set("s-1", file);
      const firstRevision = await controller.getTranscriptRevision("s-1");
      await new Promise((resolve) => setTimeout(resolve, 20));
      await writeFile(file, beforeLine);
      await utimes(file, stamp, stamp);
      const secondRevision = await controller.getTranscriptRevision("s-1");
      expect(secondRevision).not.toBe(firstRevision);
      controller.dispose();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("still reuses a cached parse instead of re-reading the whole file", async () => {
    // The bound must not defeat the cache: a transcript read twice in a row has to
    // come from the cached envelopes, which is what made tail reads 0.12ms.
    const directory = await mkdtemp(path.join(tmpdir(), "gjc-cache-reuse-"));
    const controller = new GjcSdkController({
      workspace: "/tmp/project",
      emit: () => undefined,
    });
    const internals = controller as unknown as {
      sharedTranscriptReads: Map<string, { envelopes: unknown[]; bytesRead: number }>;
      readTranscriptEnvelopes: (
        file: string,
        info: Awaited<ReturnType<typeof stat>>,
      ) => Promise<unknown[]>;
    };
    try {
      const file = path.join(directory, "session.jsonl");
      const firstLine = `${JSON.stringify({ type: "message", id: 1 })}\n`;
      const secondLine = `${JSON.stringify({ type: "message", id: 2 })}\n`;
      await writeFile(file, firstLine);
      const first = await internals.readTranscriptEnvelopes(
        file,
        await stat(file),
      );

      await writeFile(file, firstLine + secondLine);
      const second = await internals.readTranscriptEnvelopes(
        file,
        await stat(file),
      );

      expect(first).toHaveLength(1);
      expect(second).toHaveLength(2);
      expect(internals.sharedTranscriptReads.size).toBe(1);
      // One appended line reads that line's bytes, not the history already parsed.
      expect(internals.sharedTranscriptReads.get(file)?.bytesRead).toBe(
        Buffer.byteLength(secondLine),
      );
      controller.dispose();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
