import { randomUUID } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import path from "node:path";
import type { AgentEvent } from "../../shared/agent-contract.js";
import {
  REMOTE_API,
  REMOTE_PROTOCOL_VERSION,
  isRemoteOperationId,
  permissionAllows,
  type RemoteDeviceIdentity,
  type RemoteErrorCode,
  type RemoteEventFrame,
  type RemoteOperationName,
  type RemoteOperationOutcome,
  type RemotePermission,
  type RemoteResyncFrame,
} from "../../shared/remote-protocol.js";
import type { DeviceStore } from "./devices.js";
import { requiredId } from "../gjc-input-validation.js";
import {
  runRemoteOperation,
  type RemoteOperationParams,
  type RemoteOperationsHost,
} from "./operations.js";

/**
 * The host-side remote access server.
 *
 * It binds to loopback only; Tailscale Serve publishes it to the tailnet over
 * HTTPS. Three rules shape every request path here:
 *
 * 1. A request is authenticated before it can see or change anything, and the
 *    device's permission is checked per operation rather than per session.
 * 2. Revocation is immediate: the token stops resolving and every live stream of
 *    that device is closed.
 * 3. A control request carries an operation ID, and a repeat replays the stored
 *    outcome instead of running the instruction again. A dropped connection must
 *    never become a second execution.
 */

const MAX_BODY_BYTES = 16 * 1024 * 1024;
const EVENT_BUFFER_LIMIT = 1000;
const OPERATION_LOG_LIMIT = 256;
const OPERATION_LOG_TTL_MS = 10 * 60 * 1000;
const STREAM_HEARTBEAT_MS = 15_000;
const STREAM_RETRY_MS = 3000;

export interface RemoteServerOptions {
  /** Directory holding the built web client. */
  webRoot: string;
  version: string;
  workspace: string;
  devices: DeviceStore;
  host: RemoteOperationsHost;
  port: number;
  /** Hostnames, without port, that may address this server. */
  allowedHosts: () => string[];
  /** Exact `scheme://host` origins the web client is served from. */
  allowedOrigins: () => string[];
  /**
   * The login that owns this machine's Tailscale node, or undefined when Tailscale
   * cannot name one. Read per request so a daemon that stops answering closes
   * identity access instead of leaving it open.
   */
  identity?: () => Promise<{ login: string } | undefined>;
  now?: () => number;
  log?: (message: string) => void;
}

export interface RemoteServerAddress {
  port: number;
}

/**
 * What one request is allowed to do.
 *
 * A paired device carries the permission the owner granted it. The owner's own
 * tailnet device is admitted by identity and is never view-only: the owner is the
 * one who decides what other devices may do.
 */
interface RemoteAccess {
  id: string;
  name: string;
  permission: RemotePermission;
  identity: boolean;
}

interface StreamClient {
  id: number;
  deviceId: string;
  response: ServerResponse;
}

interface OperationLogEntry {
  outcome: RemoteOperationOutcome;
  at: number;
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/vnd.microsoft.icon",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
};

export class RemoteOperationLog {
  private readonly entries = new Map<string, OperationLogEntry>();

  constructor(
    private readonly limit = OPERATION_LOG_LIMIT,
    private readonly ttlMs = OPERATION_LOG_TTL_MS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  get(key: string): RemoteOperationOutcome | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (this.now() - entry.at > this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.outcome;
  }

  set(key: string, outcome: RemoteOperationOutcome): void {
    this.entries.delete(key);
    this.entries.set(key, { outcome, at: this.now() });
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }
}

export class RemoteServer {
  private readonly options: RemoteServerOptions;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private readonly operationLog = new RemoteOperationLog();
  /**
   * Control operations currently running, keyed by device + operation ID.
   *
   * The operation log only has completed outcomes, so two concurrent retries used
   * to both miss it and both instruct the host. The first request now reserves the
   * ID; a duplicate waits for that same outcome instead of running again.
   */
  private readonly inFlightOperations = new Map<string, Promise<RemoteOperationOutcome>>();
  private server?: Server;
  private port: number;
  private sequence = 0;
  /** Identifies this process's event log, so clients can tell a restart from a gap. */
  private readonly instance = randomUUID();
  private buffer: RemoteEventFrame[] = [];
  private streams = new Map<number, StreamClient>();
  private nextStreamId = 1;
  private heartbeat?: ReturnType<typeof setInterval>;
  private starting?: Promise<RemoteServerAddress>;
  private readonly unsubscribeDevices: () => void;

  constructor(options: RemoteServerOptions) {
    this.options = options;
    this.port = options.port;
    this.now = options.now ?? (() => Date.now());
    this.log = options.log ?? (() => undefined);
    // Streams belong to this server, so revocation closes them here: a device
    // whose access was removed must lose the live connection, not just the
    // ability to make new requests.
    this.unsubscribeDevices = options.devices.subscribe((change) => {
      if (change.type === "revoked" || change.type === "removed")
        this.closeDeviceStreams(change.deviceId);
    });
  }

  get address(): RemoteServerAddress {
    return { port: this.port };
  }

  get running(): boolean {
    return Boolean(this.server?.listening);
  }

  /** Attached event streams; exposed so tests can observe a stalled client leaving. */
  get streamCount(): number {
    return this.streams.size;
  }

  start(): Promise<RemoteServerAddress> {
    if (this.starting) return this.starting;
    this.starting = new Promise<RemoteServerAddress>((resolve, reject) => {
      const server = createServer((request, response) => {
        void this.handle(request, response).catch((error: unknown) => {
          this.log(`remote request failed: ${describeError(error)}`);
          if (!response.headersSent) this.sendError(response, 500, "internal", "Request failed");
          else response.end();
        });
      });
      server.on("upgrade", (_request, socket) => {
        // Only the SSE channel is realtime here; anything else is not ours.
        socket.destroy();
      });
      server.on("clientError", (_error, socket) => socket.destroy());
      server.on("error", (error) => {
        this.starting = undefined;
        reject(error);
      });
      server.listen(this.options.port, "127.0.0.1", () => {
        const address = server.address();
        if (address && typeof address === "object") this.port = address.port;
        this.server = server;
        this.heartbeat = setInterval(() => this.beat(), STREAM_HEARTBEAT_MS);
        if (typeof this.heartbeat.unref === "function") this.heartbeat.unref();
        resolve({ port: this.port });
      });
    });
    return this.starting;
  }

  async stop(): Promise<void> {
    this.unsubscribeDevices();
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    for (const client of this.streams.values()) client.response.end();
    this.streams.clear();
    const server = this.server;
    this.server = undefined;
    this.starting = undefined;
    this.buffer = [];
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** True when the stream belonged to the device and was closed. */
  closeDeviceStreams(deviceId: string): boolean {
    let closed = false;
    for (const client of [...this.streams.values()]) {
      if (client.deviceId !== deviceId) continue;
      this.writeFrame(client.response, "revoked", {
        seq: this.sequence,
        revoked: true,
        reason: "device-revoked",
      });
      client.response.end();
      this.streams.delete(client.id);
      closed = true;
    }
    return closed;
  }

  /** Fans one runtime event out to every connected remote device. */
  publish(event: AgentEvent): void {
    this.sequence += 1;
    const frame: RemoteEventFrame = { seq: this.sequence, event };
    this.buffer.push(frame);
    if (this.buffer.length > EVENT_BUFFER_LIMIT) this.buffer = this.buffer.slice(-EVENT_BUFFER_LIMIT);
    for (const client of [...this.streams.values()]) {
      if (!this.writeFrame(client.response, "agent", frame)) {
        this.streams.delete(client.id);
        client.response.destroy();
      }
    }
  }

  private beat(): void {
    for (const client of [...this.streams.values()]) {
      try {
        if (client.response.writableLength > MAX_STREAM_BUFFER_BYTES) {
          this.streams.delete(client.id);
          client.response.destroy();
          continue;
        }
        client.response.write(": ping\n\n");
      } catch {
        this.streams.delete(client.id);
        client.response.destroy();
      }
    }
  }

  private writeFrame(response: ServerResponse, name: string, payload: unknown): boolean {
    try {
      if (response.writableEnded || response.destroyed) return false;
      if (response.writableLength > MAX_STREAM_BUFFER_BYTES) return false;
      const body = JSON.stringify(payload);
      response.write(`id: ${this.sequence}\nevent: ${name}\ndata: ${body}\n\n`);
      return response.writableLength <= MAX_STREAM_BUFFER_BYTES;
    } catch {
      return false;
    }
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    this.applySecurityHeaders(response);
    const method = request.method ?? "GET";
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
    if (!this.hostAllowed(request)) {
      this.sendError(response, 421, "invalid", "Unexpected host");
      return;
    }
    if (!this.originAllowed(request, method)) {
      this.sendError(response, 403, "forbidden", "Unexpected origin");
      return;
    }
    if (!url.pathname.startsWith("/api/")) {
      this.serveStatic(request, response, url.pathname, method);
      return;
    }
    if (method === "OPTIONS") {
      this.sendJson(response, 204, undefined, { Allow: "GET, HEAD, POST" });
      return;
    }
    if (url.pathname === REMOTE_API.pair) {
      await this.handlePair(request, response, method);
      return;
    }
    const access = await this.authorize(request, response);
    if (!access) return;
    if (url.pathname === REMOTE_API.state && (method === "GET" || method === "HEAD")) {
      await this.handleState(response, access);
      return;
    }
    if (url.pathname === REMOTE_API.events && (method === "GET" || method === "HEAD")) {
      this.handleEvents(request, response, url, access);
      return;
    }
    const operationLookup = /^\/api\/operations\/([^/]+)$/u.exec(url.pathname);
    if (operationLookup && method === "GET") {
      this.handleOperationLookup(response, access, decodeURIComponent(operationLookup[1]));
      return;
    }
    const route = matchOperationRoute(url.pathname);
    if (!route) {
      this.sendError(response, 404, "not-found", "Unknown endpoint");
      return;
    }
    if (!permissionAllows(access.permission, route.operation)) {
      this.sendError(response, 403, "forbidden", "This device is view-only");
      return;
    }
    const readOnly = method === "GET" || method === "HEAD";
    if (readOnly !== isReadOperation(route.operation)) {
      this.sendError(response, 405, "invalid", "Method is not supported for this endpoint");
      return;
    }
    if (readOnly) {
      await this.runRead(response, access, route.operation, route.params);
      return;
    }
    await this.runControl(request, response, access, route.operation, route.params);
  }

  private applySecurityHeaders(response: ServerResponse): void {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    response.setHeader("Permissions-Policy", "geolocation=(), camera=(), microphone=()");
  }

  private hostAllowed(request: IncomingMessage): boolean {
    const host = request.headers.host;
    if (typeof host !== "string" || !host) return false;
    const name = hostnameOf(host);
    return this.options.allowedHosts().some((allowed) => allowed.toLowerCase() === name);
  }

  private originAllowed(request: IncomingMessage, method: string): boolean {
    const origin = request.headers.origin;
    if (typeof origin !== "string" || !origin) return method === "GET" || method === "HEAD";
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      return false;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    const normalized = `${parsed.protocol}//${parsed.host}`;
    if (this.options.allowedOrigins().some((allowed) => allowed === normalized)) return true;
    return this.options.allowedHosts().some((allowed) => allowed === parsed.hostname.toLowerCase());
  }

  /**
   * Who is asking, and what they may do.
   *
   * A device token is the ordinary answer. Without one, the request may still be the
   * owner arriving from their own tailnet device: `tailscale serve` reaches this
   * loopback server on the peer's behalf and stamps what it knows about that peer on
   * the request. Everything else is refused.
   */
  private async authorize(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<RemoteAccess | undefined> {
    const header = request.headers.authorization;
    if (typeof header === "string" && header.startsWith("Bearer ")) {
      const token = header.slice("Bearer ".length).trim();
      const result = this.options.devices.authenticate(token, {
        address: reportedAddress(request),
      });
      if ("failure" in result) {
        // One message for every rejection: a wrong token and a revoked one are the
        // same answer, so a caller cannot probe which device IDs exist.
        this.sendError(response, 401, "revoked", "This device is not authorized; pair it again");
        return undefined;
      }
      return {
        id: result.device.id,
        name: result.device.name,
        permission: result.device.permission,
        identity: false,
      };
    }
    const owner = await this.ownerAccess(request);
    if (owner) return owner;
    this.sendError(response, 401, "unauthorized", "A device token is required");
    return undefined;
  }

  /**
   * The owner's own device, or undefined when the request does not prove it.
   *
   * Every condition is Serve's fingerprint rather than the caller's word: the
   * connection comes from the local tailscaled, Funnel is not in play, Serve's own
   * identity header names a login, the one address it replaced X-Forwarded-For with
   * is on the tailnet, and that login is this machine's own. A local process that
   * forges all four is already the owner.
   */
  private async ownerAccess(request: IncomingMessage): Promise<RemoteAccess | undefined> {
    // Cheap checks first: a stranger's request must not spawn `tailscale status`.
    if (!isLoopbackAddress(clientAddress(request))) return undefined;
    if (request.headers["tailscale-funnel-request"] !== undefined) return undefined;
    const login = headerText(request.headers["tailscale-user-login"]);
    if (!login) return undefined;
    const forwarded = singleForwardedAddress(request.headers["x-forwarded-for"]);
    if (!forwarded || !isTailnetAddress(forwarded)) return undefined;
    const identity = await this.options.identity?.().catch(() => undefined);
    if (!identity) return undefined;
    if (login.toLowerCase() !== identity.login.toLowerCase()) return undefined;
    return {
      id: `tailscale:${login.toLowerCase()}`,
      name: `${login} · Tailscale`,
      permission: "control",
      identity: true,
    };
  }

  private async handlePair(
    request: IncomingMessage,
    response: ServerResponse,
    method: string,
  ): Promise<void> {
    if (method !== "POST") {
      this.sendError(response, 405, "invalid", "Pairing uses POST");
      return;
    }
    const body = await this.readJsonBody(request, response);
    if (body === undefined) return;
    const address = reportedAddress(request);
    const code = typeof body === "object" && body !== null ? (body as { code?: unknown }).code : undefined;
    const name = typeof body === "object" && body !== null ? (body as { deviceName?: unknown }).deviceName : undefined;
    const consumed = this.options.devices.consumePairingCode(
      typeof code === "string" ? code : "",
      address,
    );
    if (!consumed.ok) {
      if (consumed.reason === "rate-limited") {
        this.sendError(response, 429, "rate-limited", "Too many pairing attempts; wait a moment");
        return;
      }
      this.sendError(response, 401, "unauthorized", "The pairing code is not valid or has expired");
      return;
    }
    if (typeof name !== "string" || !name.trim()) {
      this.sendError(response, 400, "invalid", "A device name is required");
      return;
    }
    try {
      const created = this.options.devices.add({
        name,
        permission: consumed.permission,
        clientAddress: address,
      });
      this.log(`remote device paired: ${created.device.name} (${created.device.permission})`);
      this.sendJson(response, 200, {
        deviceId: created.device.id,
        token: created.token,
        device: {
          id: created.device.id,
          name: created.device.name,
          permission: created.device.permission,
          via: "device",
        } satisfies RemoteDeviceIdentity,
        server: {
          version: this.options.version,
          workspace: this.options.workspace,
          protocol: REMOTE_PROTOCOL_VERSION,
        },
      });
    } catch (error) {
      this.sendError(response, 400, "invalid", describeError(error));
    }
  }

  private async handleState(response: ServerResponse, access: RemoteAccess): Promise<void> {
    const snapshot = (await runRemoteOperation(this.options.host, "state", {}, undefined)) as {
      connection: unknown;
      sessions: unknown;
    };
    this.sendJson(response, 200, {
      connection: snapshot.connection,
      sessions: snapshot.sessions,
      device: identityOf(access),
      server: {
        version: this.options.version,
        time: new Date(this.now()).toISOString(),
        workspace: this.options.workspace,
        protocol: REMOTE_PROTOCOL_VERSION,
      },
    });
  }

  private handleEvents(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    access: RemoteAccess,
  ): void {
    const since = Number.parseInt(url.searchParams.get("since") ?? "", 10);
    const wantsReplay = Number.isFinite(since) && since >= 0;
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    response.write(`retry: ${STREAM_RETRY_MS}\n\n`);
    const client: StreamClient = {
      id: this.nextStreamId++,
      deviceId: access.id,
      response,
    };
    this.streams.set(client.id, client);
    const cleanup = (): void => {
      this.streams.delete(client.id);
    };
    request.on("close", cleanup);
    response.on("close", cleanup);
    response.on("error", cleanup);
    if (wantsReplay) {
      const oldest = this.buffer[0]?.seq ?? this.sequence + 1;
      // A cursor beyond this process's head can only come from an earlier server
      // instance. Its event log is gone, so replay is impossible -- tell the client
      // to take a fresh snapshot instead of silently sending nothing.
      if (since > this.sequence || since + 1 < oldest) {
        const notice: RemoteResyncFrame = {
          seq: this.sequence,
          resync: true,
          reason: "the event buffer no longer covers the requested position",
        };
        if (!this.writeFrame(response, "resync", notice)) {
          this.streams.delete(client.id);
          response.destroy();
          return;
        }
      } else {
        for (const frame of this.buffer) {
          if (frame.seq <= since) continue;
          if (!this.writeFrame(response, "agent", frame)) {
            this.streams.delete(client.id);
            response.destroy();
            return;
          }
        }
      }
    }
    this.sendHello(response, access);
  }

  private sendHello(response: ServerResponse, access: RemoteAccess): void {
    const body = JSON.stringify({
      seq: this.sequence,
      instance: this.instance,
      device: identityOf(access),
      server: {
        version: this.options.version,
        workspace: this.options.workspace,
        protocol: REMOTE_PROTOCOL_VERSION,
        time: new Date(this.now()).toISOString(),
      },
    });
    response.write(`event: hello\ndata: ${body}\n\n`);
  }

  private handleOperationLookup(
    response: ServerResponse,
    access: RemoteAccess,
    operationId: string,
  ): void {
    if (!isRemoteOperationId(operationId)) {
      this.sendError(response, 400, "invalid", "Operation ID is invalid");
      return;
    }
    const outcome = this.operationLog.get(`${access.id}:${operationId}`);
    if (!outcome) {
      this.sendError(response, 404, "not-found", "No outcome recorded for that operation");
      return;
    }
    this.sendJson(response, 200, outcome);
  }

  private async runRead(
    response: ServerResponse,
    access: RemoteAccess,
    operation: RemoteOperationName,
    params: RemoteOperationParams,
  ): Promise<void> {
    try {
      validateRouteParams(params);
    } catch (error) {
      this.sendError(response, 400, "invalid", describeError(error));
      return;
    }
    try {
      const result = await runRemoteOperation(this.options.host, operation, params, undefined);
      this.sendJson(response, 200, { result });
    } catch (error) {
      // The request was well-formed; the host could not answer. Reporting that as
      // a success with an error field would let a client render stale state as if
      // it were live.
      this.log(`remote read failed (${access.name}): ${describeError(error)}`);
      this.sendError(response, 502, "unavailable", describeError(error));
    }
  }

  private async runControl(
    request: IncomingMessage,
    response: ServerResponse,
    access: RemoteAccess,
    operation: RemoteOperationName,
    params: RemoteOperationParams,
  ): Promise<void> {
    const body = await this.readJsonBody(request, response);
    if (body === undefined) return;
    const operationId =
      typeof body === "object" && body !== null ? (body as { operationId?: unknown }).operationId : undefined;
    if (!isRemoteOperationId(operationId)) {
      this.sendError(response, 400, "invalid", "A control request must carry an operation ID");
      return;
    }
    const key = `${access.id}:${operationId}`;
    const previous = this.operationLog.get(key);
    if (previous) {
      this.sendJson(response, 200, previous);
      return;
    }
    // An operation ID identifies one logical instruction for this device. A
    // concurrent request that reuses it joins the first run whatever its route or
    // payload says; the first request wins and the duplicate only receives its
    // outcome. Executing the second would apply an instruction whose ID the host
    // has already seen, which is the duplicate run this booking exists to prevent.
    const pending = this.inFlightOperations.get(key);
    if (pending) {
      this.sendJson(response, 200, await pending);
      return;
    }
    if (this.inFlightOperations.size >= OPERATION_LOG_LIMIT) {
      this.sendError(response, 503, "unavailable", "Too many control operations are in flight");
      return;
    }
    const running = this.executeControl(key, operationId, operation, params, body);
    this.inFlightOperations.set(key, running);
    try {
      this.sendJson(response, 200, await running);
    } finally {
      if (this.inFlightOperations.get(key) === running)
        this.inFlightOperations.delete(key);
    }
  }

  private async executeControl(
    key: string,
    operationId: string,
    operation: RemoteOperationName,
    params: RemoteOperationParams,
    body: unknown,
  ): Promise<RemoteOperationOutcome> {
    let outcome: RemoteOperationOutcome;
    try {
      const result = await runRemoteOperation(this.options.host, operation, params, body);
      outcome = {
        operationId,
        state: "completed",
        result: result ?? null,
        at: new Date(this.now()).toISOString(),
      };
    } catch (error) {
      outcome = {
        operationId,
        state: "failed",
        message: describeError(error),
        at: new Date(this.now()).toISOString(),
      };
    }
    this.operationLog.set(key, outcome);
    return outcome;
  }

  private async readJsonBody(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<unknown | undefined> {
    const declared = Number.parseInt(String(request.headers["content-length"] ?? ""), 10);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      this.sendError(response, 413, "invalid", "Request body is too large");
      return undefined;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of request) {
        const buffer = chunk as Buffer;
        size += buffer.byteLength;
        if (size > MAX_BODY_BYTES) {
          this.sendError(response, 413, "invalid", "Request body is too large");
          request.destroy();
          return undefined;
        }
        chunks.push(buffer);
      }
    } catch {
      this.sendError(response, 400, "invalid", "Request body could not be read");
      return undefined;
    }
    if (!chunks.length) return {};
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } catch {
      this.sendError(response, 400, "invalid", "Request body must be JSON");
      return undefined;
    }
  }

  private serveStatic(
    request: IncomingMessage,
    response: ServerResponse,
    pathname: string,
    method: string,
  ): void {
    if (method !== "GET" && method !== "HEAD") {
      this.sendError(response, 405, "invalid", "Only GET is supported here");
      return;
    }
    const decoded = safeDecode(pathname);
    if (decoded === undefined) {
      this.sendError(response, 400, "invalid", "Bad path");
      return;
    }
    const root = path.resolve(this.options.webRoot);
    const candidate = path.resolve(root, `.${decoded}`);
    const insideRoot = candidate === root || candidate.startsWith(`${root}${path.sep}`);
    if (!insideRoot) {
      this.sendError(response, 404, "not-found", "Unknown path");
      return;
    }
    if (hasFileExtension(decoded)) {
      // A missing asset must not answer with the HTML shell: the browser would
      // then report the module it asked for as the wrong content type.
      if (!isFile(candidate)) {
        this.sendError(response, 404, "not-found", "Unknown asset");
        return;
      }
      this.sendFile(response, candidate, method);
      return;
    }
    const shell = path.join(root, "index.web.html");
    if (!isFile(shell)) {
      this.sendError(response, 404, "not-found", "The remote client is not built");
      return;
    }
    this.sendFile(response, shell, method);
  }

  private sendFile(response: ServerResponse, filePath: string, method: string): void {
    const extension = path.extname(filePath).toLowerCase();
    const name = path.basename(filePath);
    const immutable =
      path.basename(path.dirname(filePath)) === "assets" ||
      /-[A-Za-z0-9_]{8,}\./u.test(name);
    response.writeHead(200, {
      "Content-Type": CONTENT_TYPES[extension] ?? "application/octet-stream",
      "Content-Length": statSync(filePath).size,
      // Hashed app assets may be cached hard; the shell and the service worker
      // must be revalidated so a stale client cannot pin an old protocol.
      "Cache-Control": name === "index.web.html" ? "no-store" : immutable ? "public, max-age=31536000, immutable" : "no-cache",
    });
    if (method === "HEAD") {
      response.end();
      return;
    }
    const stream = createReadStream(filePath);
    stream.on("error", () => response.end());
    stream.pipe(response);
  }

  private sendJson(
    response: ServerResponse,
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
  ): void {
    if (response.writableEnded) return;
    const payload = body === undefined ? "" : `${JSON.stringify(body)}\n`;
    response.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Length": Buffer.byteLength(payload),
      ...headers,
    });
    response.end(payload);
  }

  private sendError(
    response: ServerResponse,
    status: number,
    code: RemoteErrorCode,
    message: string,
  ): void {
    this.sendJson(response, status, { error: { code, message } });
  }
}

/** One stalled device may not grow its write queue without bound. */
const MAX_STREAM_BUFFER_BYTES = 1024 * 1024;

const READ_OPERATIONS = new Set<RemoteOperationName>([
  "state",
  "history-sessions",
  "transcript",
  "transcript-revision",
  "context",
  "queued",
  "goal",
  "subagents",
  "git-status",
  "diff",
  "artifact",
]);

function isReadOperation(operation: RemoteOperationName): boolean {
  return READ_OPERATIONS.has(operation);
}

interface MatchedRoute {
  operation: RemoteOperationName;
  params: RemoteOperationParams;
}

const SESSION_ROUTES: Record<string, RemoteOperationName> = {
  transcript: "transcript",
  "transcript-revision": "transcript-revision",
  context: "context",
  queued: "queued",
  goal: "goal",
  subagents: "subagents",
  "git-status": "git-status",
  diff: "diff",
  messages: "send-message",
  steer: "steer",
  "follow-ups": "queue-follow-up",
  "follow-ups/flush": "flush-follow-ups",
  cancel: "cancel-run",
  read: "mark-read",
};

function matchOperationRoute(pathname: string): MatchedRoute | undefined {
  if (pathname === REMOTE_API.historySessions) return { operation: "history-sessions", params: {} };
  const artifact = /^\/api\/sessions\/([^/]+)\/artifacts\/([^/]+)$/u.exec(pathname);
  if (artifact)
    return {
      operation: "artifact",
      params: {
        sessionId: decodeURIComponent(artifact[1]),
        artifactId: decodeURIComponent(artifact[2]),
      },
    };
  const session = /^\/api\/sessions\/([^/]+)\/(.+)$/u.exec(pathname);
  if (session) {
    const leaf = session[2];
    const operation = SESSION_ROUTES[leaf];
    if (operation)
      return {
        operation,
        params: { sessionId: decodeURIComponent(session[1]) },
      };
    return undefined;
  }
  const toolCall = /^\/api\/tool-calls\/([^/]+)\/decision$/u.exec(pathname);
  if (toolCall)
    return { operation: "resolve-tool-call", params: { toolId: decodeURIComponent(toolCall[1]) } };
  return undefined;
}

function identityOf(access: RemoteAccess): RemoteDeviceIdentity {
  return {
    id: access.id,
    name: access.name,
    permission: access.permission,
    via: access.identity ? "tailscale" : "device",
  };
}

function validateRouteParams(params: RemoteOperationParams): void {
  if (params.sessionId !== undefined) requiredId(params.sessionId, "Session ID");
  if (params.toolId !== undefined) requiredId(params.toolId, "Tool call ID");
  if (params.artifactId !== undefined) requiredId(params.artifactId, "Artifact ID");
}

function hostnameOf(host: string): string {
  if (host.startsWith("[")) {
    const closing = host.indexOf("]");
    return closing === -1 ? host.toLowerCase() : host.slice(1, closing).toLowerCase();
  }
  const separator = host.lastIndexOf(":");
  return (separator === -1 ? host : host.slice(0, separator)).toLowerCase();
}

function clientAddress(request: IncomingMessage): string {
  const address = request.socket.remoteAddress ?? "unknown";
  return address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
}

/**
 * The address to report for a request.
 *
 * Everything a peer sends arrives from the local tailscaled, so the socket address
 * of a phone is loopback and says nothing. Serve replaces X-Forwarded-For with the
 * single address the peer really came from, which is the one worth recording.
 */
function reportedAddress(request: IncomingMessage): string {
  const forwarded = singleForwardedAddress(request.headers["x-forwarded-for"]);
  return forwarded && isTailnetAddress(forwarded) ? forwarded : clientAddress(request);
}

/** One address, with no proxy chain behind it, as Serve rewrites the header. */
function singleForwardedAddress(value: string | string[] | undefined): string | undefined {
  const text = headerText(value);
  if (!text || text.includes(",")) return undefined;
  return text;
}

function headerText(value: string | string[] | undefined): string | undefined {
  const text = Array.isArray(value) ? value[0] : value;
  if (typeof text !== "string") return undefined;
  const trimmed = text.trim();
  return trimmed ? trimmed : undefined;
}

function isLoopbackAddress(address: string): boolean {
  return address === "::1" || address.startsWith("127.") || address.startsWith("::ffff:127.");
}

/** Tailscale hands out 100.64.0.0/10 and fd7a:115c:a1e0::/48, and nothing else. */
function isTailnetAddress(address: string): boolean {
  const [first, second] = address.split(".");
  if (first !== undefined && second !== undefined) {
    const a = Number(first);
    const b = Number(second);
    if (Number.isInteger(a) && Number.isInteger(b)) return a === 100 && b >= 64 && b <= 127;
  }
  const lowered = address.toLowerCase();
  return lowered === "fd7a:115c:a1e0::" || lowered.startsWith("fd7a:115c:a1e0:");
}

function hasFileExtension(filePath: string): boolean {
  return /\.[A-Za-z0-9]{1,8}$/u.test(path.basename(filePath));
}

function safeDecode(value: string): string | undefined {
  try {
    const decoded = decodeURIComponent(value);
    if (decoded.includes("\0")) return undefined;
    return decoded;
  } catch {
    return undefined;
  }
}

function isFile(filePath: string): boolean {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

export function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim() || "Unknown failure";
}

export type { RemotePermission };
