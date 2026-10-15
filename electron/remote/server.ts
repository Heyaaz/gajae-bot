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
import type { DeviceRecord, DeviceStore } from "./devices.js";
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
  now?: () => number;
  log?: (message: string) => void;
}

export interface RemoteServerAddress {
  port: number;
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
  private server?: Server;
  private port: number;
  private sequence = 0;
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
        client.response.end();
      }
    }
  }

  private beat(): void {
    for (const client of [...this.streams.values()]) {
      try {
        client.response.write(": ping\n\n");
      } catch {
        this.streams.delete(client.id);
        client.response.end();
      }
    }
  }

  private writeFrame(response: ServerResponse, name: string, payload: unknown): boolean {
    try {
      const body = JSON.stringify(payload);
      response.write(`id: ${this.sequence}\nevent: ${name}\ndata: ${body}\n\n`);
      return true;
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
    const device = this.authenticate(request, response);
    if (!device) return;
    if (url.pathname === REMOTE_API.state && (method === "GET" || method === "HEAD")) {
      await this.handleState(response, device);
      return;
    }
    if (url.pathname === REMOTE_API.events && (method === "GET" || method === "HEAD")) {
      this.handleEvents(request, response, url, device);
      return;
    }
    const operationLookup = /^\/api\/operations\/([^/]+)$/u.exec(url.pathname);
    if (operationLookup && method === "GET") {
      this.handleOperationLookup(response, device, decodeURIComponent(operationLookup[1]));
      return;
    }
    const route = matchOperationRoute(url.pathname);
    if (!route) {
      this.sendError(response, 404, "not-found", "Unknown endpoint");
      return;
    }
    if (!permissionAllows(device.permission, route.operation)) {
      this.sendError(response, 403, "forbidden", "This device is view-only");
      return;
    }
    const readOnly = method === "GET" || method === "HEAD";
    if (readOnly !== isReadOperation(route.operation)) {
      this.sendError(response, 405, "invalid", "Method is not supported for this endpoint");
      return;
    }
    if (readOnly) {
      await this.runRead(response, device, route.operation, route.params);
      return;
    }
    await this.runControl(request, response, device, route.operation, route.params);
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

  private authenticate(
    request: IncomingMessage,
    response: ServerResponse,
  ): DeviceRecord | undefined {
    const header = request.headers.authorization;
    if (typeof header !== "string" || !header.startsWith("Bearer ")) {
      this.sendError(response, 401, "unauthorized", "A device token is required");
      return undefined;
    }
    const token = header.slice("Bearer ".length).trim();
    const result = this.options.devices.authenticate(token, {
      address: clientAddress(request),
    });
    if ("failure" in result) {
      // One message for every rejection: a wrong token and a revoked one are the
      // same answer, so a caller cannot probe which device IDs exist.
      this.sendError(response, 401, "revoked", "This device is not authorized; pair it again");
      return undefined;
    }
    return result.device;
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
    const address = clientAddress(request);
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

  private async handleState(response: ServerResponse, device: DeviceRecord): Promise<void> {
    const snapshot = (await runRemoteOperation(this.options.host, "state", {}, undefined)) as {
      connection: unknown;
      sessions: unknown;
    };
    this.sendJson(response, 200, {
      connection: snapshot.connection,
      sessions: snapshot.sessions,
      device: identityOf(device),
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
    device: DeviceRecord,
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
      deviceId: device.id,
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
      if (since + 1 < oldest) {
        const notice: RemoteResyncFrame = {
          seq: this.sequence,
          resync: true,
          reason: "the event buffer no longer covers the requested position",
        };
        this.writeFrame(response, "resync", notice);
      } else {
        for (const frame of this.buffer) {
          if (frame.seq <= since) continue;
          this.writeFrame(response, "agent", frame);
        }
      }
    }
    this.sendHello(response, device);
  }

  private sendHello(response: ServerResponse, device: DeviceRecord): void {
    const body = JSON.stringify({
      seq: this.sequence,
      device: identityOf(device),
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
    device: DeviceRecord,
    operationId: string,
  ): void {
    if (!isRemoteOperationId(operationId)) {
      this.sendError(response, 400, "invalid", "Operation ID is invalid");
      return;
    }
    const outcome = this.operationLog.get(`${device.id}:${operationId}`);
    if (!outcome) {
      this.sendError(response, 404, "not-found", "No outcome recorded for that operation");
      return;
    }
    this.sendJson(response, 200, outcome);
  }

  private async runRead(
    response: ServerResponse,
    device: DeviceRecord,
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
      this.log(`remote read failed (${device.name}): ${describeError(error)}`);
      this.sendError(response, 502, "unavailable", describeError(error));
    }
  }

  private async runControl(
    request: IncomingMessage,
    response: ServerResponse,
    device: DeviceRecord,
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
    const key = `${device.id}:${operationId}`;
    const previous = this.operationLog.get(key);
    if (previous) {
      this.sendJson(response, 200, previous);
      return;
    }
    try {
      const result = await runRemoteOperation(this.options.host, operation, params, body);
      const outcome: RemoteOperationOutcome = {
        operationId,
        state: "completed",
        result: result ?? null,
        at: new Date(this.now()).toISOString(),
      };
      this.operationLog.set(key, outcome);
      this.sendJson(response, 200, outcome);
    } catch (error) {
      const outcome: RemoteOperationOutcome = {
        operationId,
        state: "failed",
        message: describeError(error),
        at: new Date(this.now()).toISOString(),
      };
      this.operationLog.set(key, outcome);
      this.sendJson(response, 200, outcome);
    }
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

const READ_OPERATIONS = new Set<RemoteOperationName>([
  "state",
  "history-sessions",
  "transcript",
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

function identityOf(device: DeviceRecord): RemoteDeviceIdentity {
  return { id: device.id, name: device.name, permission: device.permission };
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
