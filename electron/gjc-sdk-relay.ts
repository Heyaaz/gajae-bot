import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

export interface RelayTransport {
  executable: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** Per request. */
  timeoutMs?: number;
}

/** A response with `ok: false`: GJC answered, and the answer was no. */
export class RelayRefusal extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
  }
}

export interface Relay {
  readonly ready: Promise<void>;
  control(operation: string, input: Record<string, unknown>): Promise<Record<string, unknown>>;
  query(query: string, input?: Record<string, unknown>): Promise<Record<string, unknown>>;
  close(): void;
}

/**
 * One authenticated connection to a session's host through `gjc sdk serve --stdio`.
 *
 * Every `gjc sdk session raw` call is a process and a connection of its own; a
 * relay keeps one open, for state GJC ties to the connection (staged images) and
 * for requests too frequent to pay a process each.
 */
export function openRelay(transport: RelayTransport, sessionId: string): Relay {
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
  const handshake = setTimeout(() => fail(new Error("GJC relay handshake timed out")), 12_000);

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
      } else if (
        (frame.type === "control_response" || frame.type === "query_response") &&
        typeof frame.id === "string"
      ) {
        const pending = waiting.get(frame.id);
        waiting.delete(frame.id);
        pending?.resolve(frame);
      }
    }
  });
  child.stderr.resume();
  child.stdin.on("error", (error) => fail(error));
  child.once("error", (error) => fail(error));
  child.once("close", () => fail(new Error("GJC relay closed")));

  const request = async (
    name: string,
    frame: (id: string) => Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    if (failure) throw failure;
    const id = randomUUID();
    const response = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(new Error(`GJC ${name} timed out`));
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
      child.stdin.write(`${JSON.stringify(frame(id))}\n`);
    });
    if (response.ok !== true) {
      const error = response.error as { code?: unknown; message?: unknown } | undefined;
      throw new RelayRefusal(
        typeof error?.message === "string" ? error.message : `GJC refused ${name}`,
        typeof error?.code === "string" ? error.code : undefined,
      );
    }
    const result = response.result;
    return result && typeof result === "object" && !Array.isArray(result)
      ? (result as Record<string, unknown>)
      : {};
  };

  return {
    ready,
    control: (operation, input) =>
      request(operation, (id) => ({ type: "control_request", id, operation, input, idempotencyKey: randomUUID() })),
    query: (query, input = {}) => request(query, (id) => ({ type: "query_request", id, query, input })),
    close(): void {
      clearTimeout(handshake);
      // Only the relay is ours; the session host it attached to keeps running.
      child.kill("SIGTERM");
    },
  };
}
