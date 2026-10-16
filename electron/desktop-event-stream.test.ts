import {
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
} from "node:http";
import { createServer as createNetServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentEvent } from "../shared/agent-contract.js";
import { DesktopEventStream, EVENT_BUFFER_LIMIT } from "./desktop-event-stream.js";

/**
 * These tests drive the stream over real loopback sockets: the acceptance question is
 * whether a client sees frames while the response is still open, whether the secret is
 * actually required, and whether a dropped client is really dropped. A mocked request
 * object could not answer any of them.
 */

const WAIT_MS = 3000;
const POLL_MS = 10;

function event(id: string): AgentEvent {
  return { type: "session.deleted", sessionId: id };
}

/** One real SSE client, reading whole frames off the socket as they arrive. */
class StreamClient {
  readonly frames: string[] = [];
  readonly names: string[] = [];
  readonly data: string[] = [];
  readonly ids: number[] = [];
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  ended = false;
  private readonly tracker: StopTracker;
  private readonly chunks: string[] = [];
  private readonly response: IncomingMessage;
  private pending = "";

  constructor(response: IncomingMessage) {
    this.response = response;
    this.status = response.statusCode ?? 0;
    this.headers = response.headers;
    this.tracker = new StopTracker();
    response.setEncoding("utf8");
    response.on("data", (chunk: string) => {
      this.chunks.push(chunk);
      this.pending += chunk;
      let separator = this.pending.indexOf("\n\n");
      while (separator !== -1) {
        this.readFrame(this.pending.slice(0, separator));
        this.pending = this.pending.slice(separator + 2);
        separator = this.pending.indexOf("\n\n");
      }
      this.tracker.notify();
    });
    const finished = (): void => {
      this.ended = true;
      this.tracker.notify();
    };
    response.on("end", finished);
    response.on("error", finished);
  }

  get body(): string {
    return this.chunks.join("");
  }

  async waitForFrames(count: number): Promise<void> {
    await this.tracker.waitUntil(
      () => this.frames.length >= count,
      `${count} frames`,
    );
  }

  async waitForEnd(): Promise<void> {
    await this.tracker.waitUntil(() => this.ended, "the response to end");
  }

  /** Destroys the socket the way a window that is closed mid-stream would. */
  close(): void {
    this.response.destroy();
  }

  private readFrame(frame: string): void {
    let name = "";
    let id = -1;
    const data: string[] = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith("event:")) name = line.slice("event:".length).trim();
      else if (line.startsWith("id:"))
        id = Number.parseInt(line.slice("id:".length).trim(), 10);
      else if (line.startsWith("data:"))
        data.push(line.slice("data:".length).trimStart());
    }
    this.frames.push(frame);
    this.names.push(name);
    this.ids.push(id);
    this.data.push(data.join("\n"));
  }
}
/** Waits for a condition, rechecking on every notification and by polling in between. */
class StopTracker {
  private readonly waiters = new Set<() => void>();

  notify(): void {
    for (const wake of [...this.waiters]) wake();
  }

  async waitUntil(ready: () => boolean, what: string): Promise<void> {
    const deadline = Date.now() + WAIT_MS;
    while (!ready()) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
      await new Promise<void>((resolve) => {
        const wake = (): void => {
          clearTimeout(timer);
          this.waiters.delete(wake);
          resolve();
        };
        const timer = setTimeout(wake, POLL_MS);
        this.waiters.add(wake);
      });
    }
  }
}

interface StreamOptions {
  /** `null` sends no Authorization header at all. */
  token?: string | null;
  path?: string;
  since?: number;
  host?: string;
  method?: string;
}

function openStream(
  stream: DesktopEventStream,
  options: StreamOptions = {},
): Promise<StreamClient> {
  const descriptor = stream.descriptor;
  if (!descriptor)
    return Promise.reject(new Error("The event stream is not listening"));
  const path =
    options.path ??
    `/events${options.since === undefined ? "" : `?since=${options.since}`}`;
  const headers: Record<string, string> = {};
  if (options.token !== null)
    headers.Authorization = `Bearer ${options.token ?? descriptor.token}`;
  if (options.host) headers.Host = options.host;
  return new Promise<StreamClient>((resolve, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port: descriptor.port,
        path,
        method: options.method ?? "GET",
        headers,
      },
      (response) => resolve(new StreamClient(response)),
    );
    request.on("error", reject);
    request.end();
  });
}

/** Whether a fresh listener can take the port, i.e. whether close() released it. */
function portIsFree(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const server = createNetServer();
    server.on("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

const streams: DesktopEventStream[] = [];

function createStream(): DesktopEventStream {
  const stream = new DesktopEventStream();
  streams.push(stream);
  return stream;
}

afterEach(async () => {
  for (const stream of streams.splice(0)) await stream.close();
});

describe("the desktop event stream", () => {
  it("writes each event as its own frame while the response is still open", async () => {
    const stream = createStream();
    const descriptor = await stream.start("window:1");
    expect(typeof descriptor.token).toBe("string");
    expect(descriptor.token.length).toBeGreaterThan(20);
    const client = await openStream(stream);
    expect(client.status).toBe(200);
    expect(String(client.headers["content-type"])).toContain(
      "text/event-stream",
    );

    stream.publish(event("first"));
    await client.waitForFrames(1);
    // The frame is already here and the response is still open: a response buffered
    // until it ends, or one JSON document holding every event, could show neither.
    expect(client.ended).toBe(false);
    expect(JSON.parse(client.data[0])).toEqual(event("first"));

    stream.publish(event("second"));
    await client.waitForFrames(2);
    expect(JSON.parse(client.data[1])).toEqual(event("second"));

    stream.publish(event("third"));
    await client.waitForFrames(3);
    expect(client.ids).toEqual([1, 2, 3]);
    expect(client.ended).toBe(false);
    expect(client.names).toEqual(["", "", ""]);
    client.close();
  });

  it("refuses a request without the process secret before a frame exists", async () => {
    const stream = createStream();
    const descriptor = await stream.start("window:1");
    const missing = await openStream(stream, { token: null });
    const wrong = await openStream(stream, { token: "not-the-process-secret" });
    // The secret is only ever read from the header; a query string is where it would
    // end up in logs and history.
    const queryString = await openStream(stream, {
      token: null,
      path: `/events?token=${descriptor.token}`,
    });
    for (const client of [missing, wrong, queryString]) {
      await client.waitForEnd();
      expect(client.status).toBe(401);
      expect(client.frames).toEqual([]);
      expect(String(client.headers["content-type"])).toContain(
        "application/json",
      );
    }
    expect(JSON.parse(missing.body)).toMatchObject({
      error: { code: "unauthorized" },
    });
    // A name that merely resolves to loopback gets no further than the host gate.
    const rebound = await openStream(stream, { host: "gajae.example" });
    await rebound.waitForEnd();
    expect(rebound.status).toBe(403);
    expect(rebound.frames).toEqual([]);
  });

  it("answers the preflight a cross-origin bearer fetch needs without opening a stream", async () => {
    const stream = createStream();
    await stream.start("window:1");
    const preflight = await openStream(stream, {
      token: null,
      method: "OPTIONS",
    });
    await preflight.waitForEnd();
    expect(preflight.status).toBe(204);
    // The development renderer is served from another loopback port, so its fetch of
    // this stream is cross-origin and carries the bearer header.
    expect(preflight.headers["access-control-allow-origin"]).toBe("*");
    expect(String(preflight.headers["access-control-allow-headers"])).toContain(
      "Authorization",
    );
    expect(preflight.frames).toEqual([]);
    expect(stream.clientCount).toBe(0);
  });

  it("drops a client that disconnects and keeps fanning out", async () => {
    const stream = createStream();
    await stream.start("window:1");
    const kept = await openStream(stream);
    const dropped = await openStream(stream);
    stream.publish(event("before"));
    await kept.waitForFrames(1);
    await dropped.waitForFrames(1);
    expect(stream.clientCount).toBe(2);

    dropped.close();
    await new StopTracker().waitUntil(
      () => stream.clientCount === 1,
      "the closed client to leave the fan-out",
    );
    // Writing to the window that just vanished must not throw in the publisher.
    expect(() => stream.publish(event("after"))).not.toThrow();
    await kept.waitForFrames(2);
    expect(JSON.parse(kept.data[1])).toEqual(event("after"));
    kept.close();
  });

  it("replays exactly the frames after ?since=", async () => {
    const stream = createStream();
    await stream.start("window:1");
    for (const id of ["one", "two", "three"]) stream.publish(event(id));

    // The oldest buffered frame is sequence 1 and the newest is 3, so a client sitting
    // at 1 must receive exactly the two it missed.
    const client = await openStream(stream, { since: 1 });
    await client.waitForFrames(2);
    expect(client.ids).toEqual([2, 3]);
    expect(client.data.map((value) => JSON.parse(value))).toEqual([
      event("two"),
      event("three"),
    ]);
    // The next frame follows the replayed ones, so the replay delivered the frames the
    // client was missing and nothing else.
    stream.publish(event("four"));
    await client.waitForFrames(3);
    expect(client.ids).toEqual([2, 3, 4]);
    expect(client.names).toEqual(["", "", ""]);
    client.close();
  });

  it("answers a resync frame when ?since= is older than the buffer", async () => {
    const stream = createStream();
    await stream.start("window:1");
    for (let index = 0; index <= EVENT_BUFFER_LIMIT; index += 1)
      stream.publish(event(String(index)));
    expect(stream.bufferedFrameCount).toBe(EVENT_BUFFER_LIMIT);

    const behind = await openStream(stream, { since: 0 });
    await behind.waitForFrames(1);
    expect(behind.names).toEqual(["resync"]);
    expect(JSON.parse(behind.data[0])).toMatchObject({
      resync: true,
      seq: EVENT_BUFFER_LIMIT + 1,
    });

    // The live stream carries on from the resync position.
    stream.publish(event("after"));
    await behind.waitForFrames(2);
    expect(JSON.parse(behind.data[1])).toEqual(event("after"));
    behind.close();

    // A position the buffer still covers replays without one: 1002 events were published
    // and the buffer holds the newest 1000, so position 1000 is still reachable.
    const covered = await openStream(stream, { since: EVENT_BUFFER_LIMIT });
    await covered.waitForFrames(2);
    expect(covered.ids).toEqual([
      EVENT_BUFFER_LIMIT + 1,
      EVENT_BUFFER_LIMIT + 2,
    ]);
    expect(covered.names).toEqual(["", ""]);
    expect(JSON.parse(covered.data[1])).toEqual(event("after"));
    covered.close();
  });

  it("refuses a second listener for the same window and releases the port on close", async () => {
    const stream = createStream();
    const descriptor = await stream.start("window:1");
    await expect(stream.start("window:1")).rejects.toThrow(
      /already listening for window:1/u,
    );
    // A later window reuses the one listener instead of opening a second port, and a
    // second process instance gets a secret of its own.
    const secondWindow = await stream.start("window:2");
    expect(secondWindow.port).toBe(descriptor.port);
    expect(secondWindow.token).toBe(descriptor.token);
    const other = createStream();
    expect((await other.start("window:1")).token).not.toBe(descriptor.token);

    const client = await openStream(stream);
    await stream.close();
    expect(stream.descriptor).toBeUndefined();
    expect(stream.clientCount).toBe(0);
    expect(await portIsFree(descriptor.port)).toBe(true);
    await client.waitForEnd();
    expect(client.ended).toBe(true);
  });

  it("hands a window the cursor taken when it was created, then the current position", async () => {
    const stream = createStream();
    const created = await stream.start("window:1");
    // Published while the window's document is still loading.
    stream.publish(event("while-loading"));
    const attach = await stream.descriptorFor("window:1");
    expect(attach.seq).toBe(created.seq);
    const client = await openStream(stream, { since: attach.seq });
    await client.waitForFrames(1);
    expect(JSON.parse(client.data[0])).toEqual(event("while-loading"));

    // A reload starts from the current position instead of replaying what the window
    // already showed.
    const reload = await stream.descriptorFor("window:1");
    expect(reload.seq).toBe(1);
    client.close();
  });
});
