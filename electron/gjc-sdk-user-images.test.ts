import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sharedTranscriptItems } from "./gjc-sdk-transcript.js";
import { resolveToolImages } from "./gjc-sdk-transcript-store.js";

const BLOB = "a".repeat(64);
let agentDir: string;

beforeEach(async () => {
  agentDir = await mkdtemp(path.join(tmpdir(), "gajae-user-images-"));
  await mkdir(path.join(agentDir, "blobs"));
  await writeFile(path.join(agentDir, "blobs", BLOB), Buffer.from("png bytes"));
  vi.stubEnv("GJC_CODING_AGENT_DIR", agentDir);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(agentDir, { recursive: true, force: true });
});

describe("images a prompt carried", () => {
  it("keep their place on the user's message and render from GJC's blob store", async () => {
    const items = sharedTranscriptItems("s1", [
      {
        role: "user",
        content: [
          { type: "text", text: "what is this?" },
          { type: "image", data: `blob:sha256:${BLOB}`, mimeType: "image/png" },
          { type: "image", data: "aW5saW5l", mimeType: "image/jpeg" },
        ],
      },
    ]);
    const user = items.find((item) => item.kind === "message" && item.role === "user");
    expect(user).toMatchObject({ content: "what is this?" });

    await resolveToolImages({ imageDataUrls: new Map() } as never, items);

    expect(user?.kind === "message" ? user.images?.map(({ mimeType, data }) => ({ mimeType, data })) : undefined)
      .toEqual([
        { mimeType: "image/png", data: Buffer.from("png bytes").toString("base64") },
        { mimeType: "image/jpeg", data: "aW5saW5l" },
      ]);
  });

  it("drops an image whose blob is gone instead of showing a broken one", async () => {
    const items = sharedTranscriptItems("s1", [
      { role: "user", content: [{ type: "text", text: "hi" }, { type: "image", data: `blob:sha256:${"b".repeat(64)}`, mimeType: "image/png" }] },
    ]);
    await resolveToolImages({ imageDataUrls: new Map() } as never, items);
    const user = items.find((item) => item.kind === "message" && item.role === "user");
    expect(user && "images" in user ? user.images : undefined).toBeUndefined();
  });
});
