import { mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AttachmentStore } from "./attachment-store.js";

const roots: string[] = [];

async function fixture(contents = "hello"): Promise<{
  root: string;
  file: string;
  metadata: { name: string; mimeType: string; size: number; mtimeMs: number };
}> {
  const root = await mkdtemp(path.join(tmpdir(), "gajae-attachment-store-"));
  roots.push(root);
  const file = path.join(root, "note.txt");
  await writeFile(file, contents);
  const info = await stat(file);
  return {
    root,
    file,
    metadata: {
      name: "note.txt",
      mimeType: "text/plain",
      size: info.size,
      mtimeMs: info.mtimeMs,
    },
  };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("AttachmentStore", () => {
  it("returns only an opaque record and consumes it exactly once", async () => {
    const { file, metadata } = await fixture();
    const store = new AttachmentStore();
    store.activateSender(7);
    const record = await store.issue(7, "file", file, metadata);

    expect(record).toMatchObject({ kind: "file", name: "note.txt" });
    expect(record).not.toHaveProperty("nativePath");
    expect(record.token).toMatch(/^[A-Za-z0-9_-]{40,}$/u);

    const [lease] = await store.acquire(7, [record.token]);
    expect(lease?.nativePath).toBe(await realpath(file));
    store.commit(7, [record.token]);
    await expect(store.acquire(7, [record.token])).rejects.toThrow(
      "Attachment is unavailable",
    );
  });

  it("isolates capabilities by renderer sender", async () => {
    const { file, metadata } = await fixture();
    const store = new AttachmentStore();
    store.activateSender(7);
    store.activateSender(8);
    const record = await store.issue(7, "file", file, metadata);

    await expect(store.acquire(8, [record.token])).rejects.toThrow(
      "Attachment is unavailable",
    );
    expect(await store.acquire(7, [record.token])).toHaveLength(1);
  });

  it("reserves before asynchronous validation so concurrent sends cannot both win", async () => {
    const { file, metadata } = await fixture();
    const store = new AttachmentStore();
    store.activateSender(7);
    const record = await store.issue(7, "file", file, metadata);

    const results = await Promise.allSettled([
      store.acquire(7, [record.token]),
      store.acquire(7, [record.token]),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(
      1,
    );
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(
      1,
    );
  });

  it("releases a failed delivery for one bounded retry", async () => {
    const { file, metadata } = await fixture();
    const store = new AttachmentStore();
    store.activateSender(7);
    const record = await store.issue(7, "file", file, metadata);

    await store.acquire(7, [record.token]);
    store.release(7, [record.token]);
    expect(await store.acquire(7, [record.token])).toHaveLength(1);
  });

  it("does not discard a capability while delivery owns its lease", async () => {
    const { file, metadata } = await fixture();
    const store = new AttachmentStore();
    store.activateSender(7);
    const record = await store.issue(7, "file", file, metadata);

    await store.acquire(7, [record.token]);
    expect(() => store.revoke(7, [record.token])).toThrow("Attachment is in use");
    store.commit(7, [record.token]);
    await expect(store.acquire(7, [record.token])).rejects.toThrow(
      "Attachment is unavailable",
    );
  });

  it("revokes only capabilities issued by a failed preparation batch", async () => {
    const { file, metadata } = await fixture();
    const store = new AttachmentStore();
    store.activateSender(7);
    const existing = await store.issue(7, "file", file, metadata);
    const partial = await store.issue(7, "file", file, metadata);

    store.revoke(7, [partial.token]);
    await expect(store.acquire(7, [partial.token])).rejects.toThrow(
      "Attachment is unavailable",
    );
    expect(await store.acquire(7, [existing.token])).toHaveLength(1);
  });

  it("does not issue or lease capabilities after the sender is destroyed", async () => {
    const { file, metadata } = await fixture();
    const store = new AttachmentStore();
    store.activateSender(7);

    const issuing = store.issue(7, "file", file, metadata);
    store.revokeSender(7);
    await expect(issuing).rejects.toThrow("Attachment owner is unavailable");

    store.activateSender(7);
    const record = await store.issue(7, "file", file, metadata);
    const acquiring = store.acquire(7, [record.token]);
    store.revokeSender(7);
    await expect(acquiring).rejects.toThrow("Attachment owner is unavailable");
  });

  it("rejects forged metadata and revokes every handle owned by a closed sender", async () => {
    const { file, metadata } = await fixture();
    const store = new AttachmentStore();
    store.activateSender(7);
    await expect(
      store.issue(7, "file", file, { ...metadata, size: metadata.size + 1 }),
    ).rejects.toThrow("Attachment changed");

    const first = await store.issue(7, "file", file, metadata);
    const second = await store.issue(7, "file", file, metadata);
    store.revokeSender(7);
    await expect(store.acquire(7, [first.token])).rejects.toThrow(
      "Attachment owner is unavailable",
    );
    await expect(store.acquire(7, [second.token])).rejects.toThrow(
      "Attachment owner is unavailable",
    );
  });
});
