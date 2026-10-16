import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AgentEvent } from "../shared/agent-contract.js";
import type { GjcEventStreamDescriptor } from "../shared/gjc-ipc.js";

/**
 * The desktop event stream.
 *
 * Runtime events used to reach a window as an IPC push (`GJC_IPC.event`). They now
 * travel over a dedicated loopback HTTP response as Server-Sent Events, and the
 * commands stay on IPC where a request/response answer is what a caller needs.
 *
 * Four rules shape this server:
 *
 * 1. It binds 127.0.0.1 on an ephemeral port, for as long as the process runs. It has
 *    nothing to do with remote access: that service is optional, while a window always
 *    needs its events.
 * 2. Every request that can read or hold a stream is authenticated with a per-process
 *    secret in an `Authorization` header. A missing or wrong secret is answered with
 *    401 before a single frame exists, and the secret is never accepted from a query
 *    string, where it would end up in logs and history.
 * 3. Frames are `id:`-numbered with a bounded replay buffer, so a client that attaches
 *    late — a window that is still loading, or a stream that dropped — asks for the
 *    frames after the position it already has. A position older than the buffer is
 *    answered with a resync frame instead of silence: the gap that cannot be replayed
 *    has to be visible to the renderer.
 * 4. The listener belongs to the process, not to a window. One port serves every
 *    window; a second start for the window that already started it is refused rather
 *    than quietly opening another one.
 */

export const EVENT_BUFFER_LIMIT = 1000;
const STREAM_HEARTBEAT_MS = 15_000;
const AUTHORIZATION_SCHEME = "Bearer";

/**
 * The renderer's own fetch is cross-origin in development, where the page is served by
 * the Vite server on 127.0.0.1:5173 while the stream listens on an ephemeral port, and
 * the bearer header makes that a preflighted request. The wildcard origin grants
 * nothing on its own: reading a frame still requires the process secret.
 */
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Authorization",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

interface BufferedFrame {
  seq: number;
  event: AgentEvent;
}

interface StreamClient {
  id: number;
  response: ServerResponse;
}

export class DesktopEventStream {
  private readonly token = randomBytes(32).toString("base64url");
  private readonly log: (message: string) => void;
  private readonly clients = new Map<number, StreamClient>();
  /**
   * The sequence each window must start reading from, taken when the window is
   * created and consumed by its first attach.
   */
  private readonly cursors = new Map<string, number>();
  private server?: Server;
  private starting?: Promise<GjcEventStreamDescriptor>;
  private owner?: string;
  private port?: number;
  private sequence = 0;
  private buffer: BufferedFrame[] = [];
  private nextClientId = 1;
  private heartbeat?: ReturnType<typeof setInterval>;

  constructor(log: (message: string) => void = () => undefined) {
    this.log = log;
  }

  /** Where the stream listens and the secret that reaches it, once it is up. */
  get descriptor(): { port: number; token: string } | undefined {
    if (this.port === undefined) return undefined;
    return { port: this.port, token: this.token };
  }

  /** Windows currently reading the stream. */
  get clientCount(): number {
    return this.clients.size;
  }

  /** Frames the replay buffer holds, newest last. */
  get bufferedFrameCount(): number {
    return this.buffer.length;
  }

  /**
   * Starts the loopback listener for one window and returns the endpoint its renderer
   * should attach to.
   *
   * The window's cursor is taken here, when the window is created, rather than when its
   * preload asks for the endpoint: an event published while the document is still
   * loading is then replayed to that window instead of being lost.
   */
  start(owner: string): Promise<GjcEventStreamDescriptor> {
    if (!this.cursors.has(owner)) this.cursors.set(owner, this.sequence);
    if (this.starting) return this.starting;
    if (this.server) {
      if (this.owner === owner)
        return Promise.reject(
          new Error(`The desktop event stream is already listening for ${owner}`),
        );
      return Promise.resolve(this.endpointFor(owner));
    }
    this.owner = owner;
    this.starting = new Promise<GjcEventStreamDescriptor>((resolve, reject) => {
      let settled = false;
      const server = createServer((request, response) =>
        this.handle(request, response),
      );
      // A malformed request from a local misbehaving client must not take the
      // listener down with it.
      server.on("clientError", (_error, socket) => socket.destroy());
      server.on("error", (error) => {
        if (settled) {
          this.log(`listener failed: ${describeError(error)}`);
          return;
        }
        settled = true;
        this.starting = undefined;
        this.owner = undefined;
        reject(error);
      });
      // Loopback on an ephemeral port, always: the endpoint is a bearer secret for
      // this process, so it must never be reachable from another host.
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (settled) return;
        if (!address || typeof address !== "object") {
          settled = true;
          this.starting = undefined;
          this.owner = undefined;
          reject(new Error("The desktop event stream bound no TCP port"));
          return;
        }
        settled = true;
        this.port = address.port;
        this.server = server;
        this.heartbeat = setInterval(() => this.beat(), STREAM_HEARTBEAT_MS);
        this.heartbeat.unref?.();
        this.log(`listening on 127.0.0.1:${address.port}`);
        // The listener is up: a later start() for this same window must be refused as a
        // second listener rather than handed this one as if it had just been started.
        this.starting = undefined;
        resolve(this.endpointFor(owner));
      });
    });
    return this.starting;
  }

  /**
   * The endpoint a window whose preload is attaching now must read from.
   *
   * The first attach of a window starts at the cursor taken when the window was
   * created, so events published while its document loaded are replayed. A later
   * attach — a reload — starts at the current sequence instead: the reloaded document
   * rebuilds its state from the runtime directly and must not re-apply a history its
   * predecessor already showed.
   */
  async descriptorFor(owner: string): Promise<GjcEventStreamDescriptor> {
    if (this.starting) await this.starting;
    else if (!this.server) await this.start(owner);
    if (this.port === undefined)
      throw new Error("The desktop event stream is not listening");
    const pending = this.cursors.get(owner);
    this.cursors.delete(owner);
    return {
      port: this.port,
      token: this.token,
      seq: pending ?? this.sequence,
    };
  }

  /**
   * Fans one runtime event out to every attached window.
   *
   * Buffering happens whether or not a window is attached: that is what lets a window
   * created after the event still read it back.
   */
  publish(event: AgentEvent): void {
    this.sequence += 1;
    const frame: BufferedFrame = { seq: this.sequence, event };
    this.buffer.push(frame);
    if (this.buffer.length > EVENT_BUFFER_LIMIT)
      this.buffer.splice(0, this.buffer.length - EVENT_BUFFER_LIMIT);
    for (const client of [...this.clients.values()]) {
      if (this.writeFrame(client.response, frame)) continue;
      this.clients.delete(client.id);
      client.response.end();
    }
  }

  /** Ends every stream and releases the port. */
  async close(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    for (const client of [...this.clients.values()]) {
      this.clients.delete(client.id);
      client.response.end();
    }
    const server = this.server;
    this.server = undefined;
    this.starting = undefined;
    this.owner = undefined;
    this.port = undefined;
    this.cursors.clear();
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      // A window holding a keep-alive socket would otherwise keep the port bound past
      // this call, and the port has to be free the moment close() resolves.
      server.closeAllConnections();
    });
  }

  private endpointFor(owner: string): GjcEventStreamDescriptor {
    if (this.port === undefined)
      throw new Error("The desktop event stream is not listening");
    return {
      port: this.port,
      token: this.token,
      seq: this.cursors.get(owner) ?? this.sequence,
    };
  }

  private handle(request: IncomingMessage, response: ServerResponse): void {
    const method = request.method ?? "GET";
    const url = new URL(
      request.url ?? "/",
      `http://${request.headers.host ?? "127.0.0.1"}`,
    );
    if (!this.hostAllowed(request)) {
      this.sendJson(response, 403, {
        error: { code: "forbidden", message: "Unexpected host" },
      });
      return;
    }
    // A browser preflight cannot carry a secret, so it is answered with headers only:
    // it opens no stream and no frame is written for it.
    if (method === "OPTIONS") {
      response.writeHead(204, { ...CORS_HEADERS, Allow: "GET, OPTIONS" });
      response.end();
      return;
    }
    if (method !== "GET") {
      this.sendJson(response, 405, {
        error: { code: "invalid", message: "Method is not supported" },
      });
      return;
    }
    if (!this.authorized(request)) {
      this.sendJson(response, 401, {
        error: { code: "unauthorized", message: "A stream token is required" },
      });
      return;
    }
    this.openStream(request, response, url);
  }

  private openStream(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): void {
    const since = Number.parseInt(url.searchParams.get("since") ?? "", 10);
    const wantsReplay = Number.isFinite(since) && since >= 0;
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      ...CORS_HEADERS,
    });
    // Node holds the headers back until the first body write, which would leave a client
    // that attaches with nothing to replay waiting on a response that has in fact been
    // accepted. Attaching has to be observable on its own.
    response.flushHeaders();
    const client: StreamClient = { id: this.nextClientId++, response };
    this.clients.set(client.id, client);
    const cleanup = (): void => {
      this.clients.delete(client.id);
    };
    request.on("close", cleanup);
    response.on("close", cleanup);
    response.on("error", cleanup);
    if (!wantsReplay) return;
    const oldest = this.buffer[0]?.seq ?? this.sequence + 1;
    if (since + 1 < oldest) {
      // The buffer no longer reaches back to the requested position. Saying so beats
      // silence: the client learns that a gap it cannot replay exists, and its own
      // cursor still moves to the newest frame.
      response.write(
        `id: ${this.sequence}\nevent: resync\ndata: ${JSON.stringify({
          seq: this.sequence,
          resync: true,
          reason: "the replay buffer no longer covers the requested position",
        })}\n\n`,
      );
      return;
    }
    for (const frame of this.buffer) {
      if (frame.seq <= since) continue;
      this.writeFrame(response, frame);
    }
  }

  private writeFrame(response: ServerResponse, frame: BufferedFrame): boolean {
    try {
      if (response.writableEnded || response.destroyed) return false;
      response.write(`id: ${frame.seq}\ndata: ${JSON.stringify(frame.event)}\n\n`);
      return true;
    } catch {
      // A window that vanished mid-write is dropped from the fan-out; the event stays
      // in the buffer for whoever reads it back.
      return false;
    }
  }

  private beat(): void {
    for (const client of [...this.clients.values()]) {
      try {
        client.response.write(": ping\n\n");
      } catch {
        this.clients.delete(client.id);
        client.response.end();
      }
    }
  }

  private authorized(request: IncomingMessage): boolean {
    const header = request.headers.authorization;
    const expected = `${AUTHORIZATION_SCHEME} ${this.token}`;
    const provided = Buffer.from(typeof header === "string" ? header : "");
    const wanted = Buffer.from(expected);
    return provided.length === wanted.length && timingSafeEqual(provided, wanted);
  }

  /**
   * Only a loopback `Host` is answered.
   *
   * A name that resolves to 127.0.0.1 would otherwise let a page on the open internet
   * address this port from its own origin; the token still has to be presented, and the
   * host gate is the cheap half of that defence.
   */
  private hostAllowed(request: IncomingMessage): boolean {
    const host = request.headers.host;
    if (typeof host !== "string" || !host) return false;
    const name = hostnameOf(host);
    return name === "127.0.0.1" || name === "localhost" || name === "::1";
  }

  private sendJson(
    response: ServerResponse,
    status: number,
    body: unknown,
  ): void {
    if (response.writableEnded) return;
    const payload = `${JSON.stringify(body)}\n`;
    response.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Length": Buffer.byteLength(payload),
      ...CORS_HEADERS,
    });
    response.end(payload);
  }
}

function hostnameOf(host: string): string {
  if (host.startsWith("[")) {
    const closing = host.indexOf("]");
    return closing === -1
      ? host.toLowerCase()
      : host.slice(1, closing).toLowerCase();
  }
  const separator = host.lastIndexOf(":");
  return (separator === -1 ? host : host.slice(0, separator)).toLowerCase();
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim() || "Unknown failure";
}
