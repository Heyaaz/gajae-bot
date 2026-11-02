import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SdkCliError } from "./gjc-sdk-cli.js";
import { ImagePromptNotSentError, promptWithImages, readUploadImages } from "./gjc-sdk-image-prompt.js";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200_000, 7)]);

// A stand-in for `gjc sdk serve --stdio`: answers each control request the way
// GJC does, records every frame, and misbehaves on the operation named in FAIL_AT.
const RELAY = `#!/usr/bin/env node
const fs = require("node:fs");
const log = process.env.RELAY_LOG;
const failAt = process.env.FAIL_AT;
const send = (frame) => process.stdout.write(JSON.stringify(frame) + "\\n");
send({ type: "hello", protocolVersion: 3 });
let buffer = "";
let sequence = 0;
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf("\\n")) >= 0) {
    const frame = JSON.parse(buffer.slice(0, i));
    buffer = buffer.slice(i + 1);
    fs.appendFileSync(log, JSON.stringify(frame) + "\\n");
    if (frame.type !== "control_request") continue;
    if (frame.operation === failAt && process.env.FAIL_MODE === "exit") process.exit(0);
    if (frame.operation === failAt) {
      send({ type: "control_response", id: frame.id, ok: false, error: { code: "busy", message: "Too many concurrent image uploads." } });
      continue;
    }
    const result = frame.operation === "turn.image.begin" ? { id: "img-1", nextSequence: 0 }
      : frame.operation === "turn.image.append" ? { id: "img-1", nextSequence: ++sequence }
      : frame.operation === "turn.prompt" ? { accepted: true, turnId: "turn-1", clientRef: frame.input.clientRef }
      : { id: "img-1" };
    send({ type: "control_response", id: frame.id, ok: true, result });
  }
});
`;

let directory: string;
let relay: string;
let log: string;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "gajae-image-relay-"));
  relay = path.join(directory, "gjc");
  log = path.join(directory, "frames.jsonl");
  await writeFile(relay, RELAY);
  await chmod(relay, 0o755);
  await writeFile(log, "");
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

const transport = (env: Record<string, string> = {}) => ({
  executable: relay,
  env: { ...process.env, RELAY_LOG: log, ...env },
  cwd: directory,
  timeoutMs: 5_000,
});
const frames = async () =>
  (await readFile(log, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as {
    type: string; operation?: string; input?: Record<string, unknown>;
  });
const prompt = { text: "what is this?", clientRef: "ref-1", images: [{ mimeType: "image/png" as const, bytes: PNG }] };

describe("promptWithImages", () => {
  it("stages the image in order on one relay and submits it with the prompt's reference", async () => {
    await expect(promptWithImages(transport(), "s1", prompt)).resolves.toEqual({ turnId: "turn-1" });
    const sent = (await frames()).filter((frame) => frame.type === "control_request");
    expect(sent.map((frame) => frame.operation)).toEqual([
      "turn.image.begin", "turn.image.append", "turn.image.append", "turn.image.append", "turn.image.finish", "turn.prompt",
    ]);
    expect(sent[0]!.input).toMatchObject({ mimeType: "image/png", byteLength: PNG.length });
    expect(sent.slice(1, 4).map((frame) => frame.input!.sequence)).toEqual([0, 1, 2]);
    const uploaded = Buffer.concat(sent.slice(1, 4).map((frame) => Buffer.from(frame.input!.data as string, "base64")));
    expect(uploaded.equals(PNG)).toBe(true);
    expect(sent[5]!.input).toEqual({ text: "what is this?", clientRef: "ref-1", stagedImages: [{ id: "img-1" }] });
  });

  it("reports a refused upload or prompt as never run", async () => {
    for (const failAt of ["turn.image.begin", "turn.prompt"]) {
      const sending = promptWithImages(transport({ FAIL_AT: failAt }), "s1", prompt);
      await expect(sending).rejects.toBeInstanceOf(ImagePromptNotSentError);
      await expect(sending).rejects.toMatchObject({ code: "busy" });
    }
  });

  it("calls a prompt whose relay vanished after sending it uncertain, not unsent", async () => {
    const lost = promptWithImages(transport({ FAIL_AT: "turn.prompt", FAIL_MODE: "exit" }), "s1", prompt);
    await expect(lost).rejects.toBeInstanceOf(SdkCliError);
    await expect(lost).rejects.toMatchObject({ code: "uncertain_after_send" });
    const lostUpload = promptWithImages(transport({ FAIL_AT: "turn.image.finish", FAIL_MODE: "exit" }), "s1", prompt);
    await expect(lostUpload).rejects.toBeInstanceOf(ImagePromptNotSentError);
  });
});

describe("readUploadImages", () => {
  it("reads images GJC stages and gives up on the message when one cannot be", async () => {
    const png = path.join(directory, "shot.png");
    const heic = path.join(directory, "photo.heic");
    await writeFile(png, PNG);
    await writeFile(heic, Buffer.from("....ftypheic"));
    await expect(readUploadImages([{ nativePath: png }])).resolves.toEqual([{ mimeType: "image/png", bytes: PNG }]);
    await expect(readUploadImages([{ nativePath: png }, { nativePath: heic }])).resolves.toBeUndefined();
    await expect(readUploadImages([{ nativePath: path.join(directory, "gone.png") }])).resolves.toBeUndefined();
    await expect(readUploadImages([{}])).resolves.toBeUndefined();
  });
});
