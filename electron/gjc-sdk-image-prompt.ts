import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { SdkCliError } from "./gjc-sdk-cli.js";

/** An image read from disk and checked against what GJC stages. */
export interface UploadImage {
  mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  bytes: Buffer;
}

/** GJC refuses a staged image over 20 MiB. */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
/** Raw bytes per append. Base64 of this stays well inside GJC's 256 KiB request frame. */
const CHUNK_BYTES = 96 * 1024;

/**
 * The images in a message, when every one of them can be staged with GJC. A single
 * image GJC would refuse (another format, too large, unreadable) sends the whole
 * message the old way, so its images never arrive split across two mechanisms.
 */
export async function readUploadImages(
  images: ReadonlyArray<{ nativePath?: string }>,
): Promise<UploadImage[] | undefined> {
  if (images.length === 0) return undefined;
  const read: UploadImage[] = [];
  for (const image of images) {
    if (!image.nativePath) return undefined;
    let bytes: Buffer;
    try {
      bytes = await readFile(image.nativePath);
    } catch {
      return undefined;
    }
    const mimeType = imageMimeType(bytes);
    if (!mimeType || bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) return undefined;
    read.push({ mimeType, bytes });
  }
  return read;
}

function imageMimeType(bytes: Buffer): UploadImage["mimeType"] | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.subarray(0, 4).toString("latin1") === "GIF8") return "image/gif";
  if (bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP")
    return "image/webp";
  return undefined;
}

/**
 * GJC did not run the prompt: the upload failed, or GJC refused the prompt outright.
 * Sending the same message another way cannot run it twice.
 */
export class ImagePromptNotSentError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
    this.name = "ImagePromptNotSentError";
  }
}

export interface ImagePromptTransport {
  executable: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** Per request. A finish verifies and decodes the whole image. */
  timeoutMs?: number;
}

/**
 * Stages each image and submits the prompt that carries them, all on one relay.
 *
 * GJC owns a staged image by the connection that uploaded it and drops it when that
 * connection closes, so every `gjc sdk session raw control` call -- a process, and a
 * connection, of its own -- cannot hand an image to the next. `clientRef` is the
 * prompt's operation reference, the same one `gjc sdk session status` reconciles.
 */
export async function promptWithImages(
  transport: ImagePromptTransport,
  sessionId: string,
  prompt: { text: string; clientRef: string; images: readonly UploadImage[] },
): Promise<{ turnId?: string }> {
  const relay = openRelay(transport, sessionId);
  let promptSent = false;
  try {
    await relay.ready;
    const staged: Array<{ id: string }> = [];
    for (const image of prompt.images) {
      const begun = await relay.control("turn.image.begin", {
        mimeType: image.mimeType,
        byteLength: image.bytes.length,
        sha256: createHash("sha256").update(image.bytes).digest("hex"),
      });
      const id = typeof begun.id === "string" ? begun.id : "";
      if (!id) throw new ImagePromptNotSentError("GJC did not open an image upload");
      let sequence = typeof begun.nextSequence === "number" ? begun.nextSequence : 0;
      for (let at = 0; at < image.bytes.length; at += CHUNK_BYTES) {
        const appended = await relay.control("turn.image.append", {
          id,
          sequence,
          data: image.bytes.subarray(at, at + CHUNK_BYTES).toString("base64"),
        });
        sequence = typeof appended.nextSequence === "number" ? appended.nextSequence : sequence + 1;
      }
      await relay.control("turn.image.finish", { id });
      staged.push({ id });
    }
    promptSent = true;
    const accepted = await relay.control("turn.prompt", {
      text: prompt.text,
      clientRef: prompt.clientRef,
      stagedImages: staged,
    });
    return typeof accepted.turnId === "string" ? { turnId: accepted.turnId } : {};
  } catch (error) {
    if (error instanceof RelayRefusal) throw new ImagePromptNotSentError(error.message, error.code);
    if (!promptSent) {
      throw error instanceof ImagePromptNotSentError
        ? error
        : new ImagePromptNotSentError(error instanceof Error ? error.message : String(error));
    }
    // The prompt frame left this process and nothing came back: GJC may be running it.
    throw new SdkCliError(
      "uncertain_after_send",
      "The image prompt was sent but its outcome is uncertain",
    );
  } finally {
    relay.close();
  }
}

/** A `control_response` with `ok: false`: GJC answered, and the answer was no. */
class RelayRefusal extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
  }
}

function openRelay(transport: ImagePromptTransport, sessionId: string) {
  const child = spawn(transport.executable, ["sdk", "serve", "--stdio", "--session", sessionId], {
    cwd: transport.cwd,
    env: transport.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const waiting = new Map<string, { resolve: (frame: Record<string, unknown>) => void; reject: (error: Error) => void }>();
  let failure: Error | undefined;
  const fail = (error: Error): void => {
    if (failure) return;
    failure = error;
    for (const pending of waiting.values()) pending.reject(error);
    waiting.clear();
    rejectReady(error);
  };
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  ready.catch(() => undefined);
  const handshake = setTimeout(() => fail(new Error("GJC image relay handshake timed out")), 12_000);

  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let boundary: number;
    while ((boundary = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, boundary).trim();
      buffer = buffer.slice(boundary + 1);
      if (!line) continue;
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (frame.type === "hello") {
        child.stdin.write(`${JSON.stringify({ type: "hello", protocolVersion: 3, capabilities: [] })}\n`);
        clearTimeout(handshake);
        resolveReady();
      } else if (frame.type === "control_response" && typeof frame.id === "string") {
        const pending = waiting.get(frame.id);
        waiting.delete(frame.id);
        pending?.resolve(frame);
      }
    }
  });
  child.stderr.resume();
  child.stdin.on("error", (error) => fail(error));
  child.once("error", (error) => fail(error));
  child.once("close", () => fail(new Error("GJC image relay closed")));

  const control = async (
    operation: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    if (failure) throw failure;
    const id = randomUUID();
    const frame = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(new Error(`GJC ${operation} timed out`));
      }, transport.timeoutMs ?? 15_000);
      waiting.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      child.stdin.write(
        `${JSON.stringify({ type: "control_request", id, operation, input, idempotencyKey: randomUUID() })}\n`,
      );
    });
    if (frame.ok !== true) {
      const error = frame.error as { code?: unknown; message?: unknown } | undefined;
      throw new RelayRefusal(
        typeof error?.message === "string" ? error.message : `GJC refused ${operation}`,
        typeof error?.code === "string" ? error.code : undefined,
      );
    }
    const result = frame.result;
    return result && typeof result === "object" && !Array.isArray(result)
      ? (result as Record<string, unknown>)
      : {};
  };

  return {
    ready,
    control,
    close(): void {
      clearTimeout(handshake);
      // Only the relay is ours; the session host it attached to keeps running.
      child.kill("SIGTERM");
    },
  };
}
