import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  AgentEvent,
  TranscriptItem,
  TranscriptPage,
  TranscriptPageRequest,
} from "../../shared/agent-contract.js";
import { REMOTE_API, REMOTE_PROTOCOL_VERSION } from "../../shared/remote-protocol.js";
import { DeviceStore } from "./devices.js";
import type { RemoteOperationsHost } from "./operations.js";
import { RemoteServer } from "./server.js";

const directories: string[] = [];
const running: RemoteServer[] = [];

afterEach(async () => {
  for (const server of running.splice(0)) await server.stop();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

interface FakeHost extends RemoteOperationsHost {
  calls: string[];
  transcript: TranscriptItem[];
  pageRequests: Array<{ sessionId: string; request?: TranscriptPageRequest }>;
}

function fakeHost(): FakeHost {
  const calls: string[] = [];
  const transcript: TranscriptItem[] = [];
  const pageRequests: Array<{ sessionId: string; request?: TranscriptPageRequest }> = [];
  return {
    calls,
    transcript,
    pageRequests,
    async getConnection() {
      return {
        state: "connected" as const,
        backend: "gjc" as const,
        label: "GJC",
        detail: "connected",
        workspace: "/tmp/ws",
      };
    },
    async listSessions() {
      calls.push("listSessions");
      return [
        {
          id: "s-1",
          title: "세션 하나",
          subtitle: "",
          workspace: "/tmp/ws",
          runtime: "gjc" as const,
          status: "idle" as const,
          updatedAt: new Date(0).toISOString(),
          pinned: false,
          unread: false,
          accent: "#fff",
          ownership: "gajae" as const,
          attachment: "attached" as const,
        },
      ];
    },
    async listHistorySessions() {
      calls.push("listHistorySessions");
      return [];
    },
    async getTranscript(sessionId: string) {
      calls.push(`transcript:${sessionId}`);
      return transcript.slice();
    },
    async getTranscriptPage(sessionId: string, request?: TranscriptPageRequest) {
      calls.push(`transcript-page:${sessionId}`);
      pageRequests.push({
        sessionId,
        ...(request === undefined ? {} : { request: { ...request } }),
      });
      const items = transcript.slice();
      const page: TranscriptPage = {
        items,
        hasMoreBefore: request?.beforeId !== undefined,
        hasMoreAfter: request?.aroundId !== undefined,
        ...(items[0] ? { firstId: items[0].id } : {}),
        ...(items.at(-1) ? { lastId: items.at(-1)!.id } : {}),
        requests: [],
      };
      return page;
    },
    async getTranscriptRevision(sessionId: string) {
      calls.push(`transcript-revision:${sessionId}`);
      return "rev";
    },
    async refreshSessionContext(sessionId: string) {
      calls.push(`context:${sessionId}`);
    },
    async listQueuedMessages(sessionId: string) {
      calls.push(`queued:${sessionId}`);
      return [];
    },
    async getGoal(sessionId: string) {
      calls.push(`goal:${sessionId}`);
      return { enabled: false, completed: 0, total: 0 };
    },
    async listSubagents(sessionId: string) {
      calls.push(`subagents:${sessionId}`);
      return [];
    },
    async getGitStatus(sessionId: string) {
      calls.push(`git:${sessionId}`);
      return { workspace: "/tmp/ws", branch: "main", ahead: 0, behind: 0, files: [] };
    },
    async getDiff(sessionId: string) {
      calls.push(`diff:${sessionId}`);
      return { sessionId, workspace: "/tmp/ws", files: [], refreshedAt: new Date(0).toISOString() };
    },
    async readArtifact(sessionId: string, artifactId: string) {
      calls.push(`artifact:${sessionId}:${artifactId}`);
      return { artifactId, text: "output", complete: true, totalBytes: 6 };
    },
    async sendMessage(sessionId: string) {
      calls.push(`send:${sessionId}`);
      return "prompt" as const;
    },
    async steerSession(sessionId: string) {
      calls.push(`steer:${sessionId}`);
    },
    async queueFollowUp(sessionId: string) {
      calls.push(`queue:${sessionId}`);
    },
    async flushQueuedNow(sessionId: string) {
      calls.push(`flush:${sessionId}`);
      return true;
    },
    async cancelRun(sessionId: string) {
      calls.push(`cancel:${sessionId}`);
    },
    async resolveToolCall(toolId: string) {
      calls.push(`tool:${toolId}`);
    },
    async markSessionRead(sessionId: string) {
      calls.push(`read:${sessionId}`);
    },
  };
}

interface Harness {
  port: number;
  server: RemoteServer;
  devices: DeviceStore;
  host: FakeHost;
  logs: string[];
  pair(permission?: "view" | "control"): Promise<{ token: string; deviceId: string }>;
  url(path: string): string;
  origin: string;
}

async function harness(
  options: {
    identity?: () => Promise<{ login: string } | undefined>;
    stalledStreamMs?: number;
  } = {},
): Promise<Harness> {
  const directory = mkdtempSync(path.join(tmpdir(), "gajae-remote-server-"));
  directories.push(directory);
  const webRoot = path.join(directory, "web");
  mkdirSync(path.join(webRoot, "assets"), { recursive: true });
  writeFileSync(path.join(webRoot, "index.web.html"), "<!doctype html><title>Gajae remote</title>");
  writeFileSync(path.join(webRoot, "assets", "app-abcdef123456.js"), "console.log(1)\n");
  writeFileSync(path.join(webRoot, "sw.js"), "// service worker\n");
  const devices = new DeviceStore(path.join(directory, "remote-devices.json"));
  const host = fakeHost();
  const logs: string[] = [];
  let port = 0;
  const server = new RemoteServer({
    webRoot,
    version: "0.1.0",
    workspace: "/tmp/ws",
    devices,
    host,
    port: 0,
    allowedHosts: () => ["127.0.0.1", "localhost", "mac.tailnet-abcd.ts.net"],
    allowedOrigins: () => [`http://127.0.0.1:${port}`, "https://mac.tailnet-abcd.ts.net"],
    ...(options.identity ? { identity: options.identity } : {}),
    ...(options.stalledStreamMs !== undefined ? { stalledStreamMs: options.stalledStreamMs } : {}),
    log: (message) => logs.push(message),
  });
  await server.start();
  port = server.address.port;
  running.push(server);
  const origin = `http://127.0.0.1:${port}`;
  return {
    port,
    server,
    devices,
    host,
    logs,
    url: (value: string) => `${origin}${value}`,
    origin,
    async pair(permission = "view") {
      const pairing = devices.issuePairingCode(permission);
      const response = await fetch(`${origin}${REMOTE_API.pair}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: origin },
        body: JSON.stringify({ code: pairing.code, deviceName: "iPhone" }),
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { token: string; deviceId: string };
      return body;
    },
  };
}

function bearer(token: string, origin?: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    ...(origin ? { Origin: origin } : {}),
  };
}

async function post(
  base: Harness,
  token: string,
  endpoint: string,
  body: unknown,
): Promise<{ status: number; body: any }> {
  const response = await fetch(base.url(endpoint), {
    method: "POST",
    headers: { ...bearer(token, base.origin), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

function rawRequest(
  base: Harness,
  endpoint: string,
  options: { method?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: string; headers: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port: base.port,
        path: endpoint,
        method: options.method ?? "GET",
        headers: options.headers ?? {},
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            body,
            headers: response.headers as Record<string, string>,
          }),
        );
      },
    );
    request.on("error", reject);
    request.end();
  });
}

interface Frame {
  event: string;
  data: any;
}

class SseReader {
  private reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  private buffer = "";
  private ended = false;
  private pending: Promise<ReadableStreamReadResult<Uint8Array>> | undefined;

  private constructor(private readonly controller: AbortController) {}

  static async open(
    url: string,
    token: string,
    origin: string,
    since?: number,
  ): Promise<SseReader> {
    const controller = new AbortController();
    const response = await fetch(`${url}${since === undefined ? "" : `?since=${since}`}`, {
      headers: bearer(token, origin),
      signal: controller.signal,
    });
    if (response.status !== 200) {
      controller.abort();
      throw new Error(`stream refused: ${response.status}`);
    }
    const reader = new SseReader(controller);
    reader.reader = response.body!.getReader();
    return reader;
  }

  private async read(): Promise<void> {
    if (this.ended || !this.reader) return;
    this.pending ??= this.reader.read();
    const result = await this.pending;
    this.pending = undefined;
    if (result.done) {
      this.ended = true;
      return;
    }
    this.buffer += new TextDecoder().decode(result.value);
  }

  async next(timeoutMs = 4000): Promise<Frame> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const frame = this.take();
      if (frame) return frame;
      if (this.ended) throw new Error("stream ended before a frame arrived");
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("timed out waiting for a frame");
      await Promise.race([
        this.read(),
        new Promise((resolve) => setTimeout(resolve, remaining)),
      ]);
    }
  }

  async closed(timeoutMs = 4000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!this.ended && Date.now() < deadline) {
      await Promise.race([
        this.read(),
        new Promise((resolve) => setTimeout(resolve, deadline - Date.now())),
      ]);
    }
    if (!this.ended) throw new Error("stream stayed open");
  }

  close(): void {
    this.controller.abort();
  }

  private take(): Frame | undefined {
    for (;;) {
      const separator = this.buffer.indexOf("\n\n");
      if (separator === -1) return undefined;
      const block = this.buffer.slice(0, separator);
      this.buffer = this.buffer.slice(separator + 2);
      const event = /(?:^|\n)event: (.+)/u.exec(block)?.[1];
      const data = /(?:^|\n)data: (.+)/u.exec(block)?.[1];
      const comment = block.startsWith(":");
      if (comment || (!event && !data)) continue;
      return { event: event ?? "message", data: data ? JSON.parse(data) : undefined };
    }
  }
}

describe("remote server authentication", () => {
  it("requires a token before anything else", async () => {
    const base = await harness();
    const anonymous = await fetch(base.url(REMOTE_API.state));
    expect(anonymous.status).toBe(401);
    expect((await anonymous.json()).error.code).toBe("unauthorized");
    const wrong = await fetch(base.url(REMOTE_API.state), { headers: bearer("z".repeat(43)) });
    expect(wrong.status).toBe(401);
    expect((await wrong.json()).error.code).toBe("revoked");
  });

  it("pairs once with a code and then serves state", async () => {
    const base = await harness();
    const device = await base.pair("control");
    const response = await fetch(base.url(REMOTE_API.state), { headers: bearer(device.token) });
    expect(response.status).toBe(200);
    const snapshot = await response.json();
    expect(snapshot.server.protocol).toBe(REMOTE_PROTOCOL_VERSION);
    expect(snapshot.device).toMatchObject({ name: "iPhone", permission: "control" });
    expect(snapshot.sessions).toHaveLength(1);
  });

  it("never echoes a device token back or into the log", async () => {
    const base = await harness();
    const device = await base.pair("control");
    const response = await fetch(base.url(REMOTE_API.state), { headers: bearer(device.token) });
    const text = await response.text();
    expect(text).not.toContain(device.token);
    expect(base.logs.join("\n")).not.toContain(device.token);
  });

  it("rejects a second pairing with the same code", async () => {
    const base = await harness();
    const pairing = base.devices.issuePairingCode("view");
    const attempt = () =>
      fetch(base.url(REMOTE_API.pair), {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: base.origin },
        body: JSON.stringify({ code: pairing.code, deviceName: "iPhone" }),
      });
    expect((await attempt()).status).toBe(200);
    expect((await attempt()).status).toBe(401);
  });
});

describe("remote server request boundaries", () => {
  it("rejects a request addressed to an unknown host", async () => {
    const base = await harness();
    const response = await rawRequest(base, REMOTE_API.state, {
      headers: { Host: "attacker.example" },
    });
    expect(response.status).toBe(421);
  });

  it("accepts the tailnet hostname and origin", async () => {
    const base = await harness();
    const device = await base.pair("view");
    const response = await rawRequest(base, REMOTE_API.state, {
      headers: {
        Host: "mac.tailnet-abcd.ts.net",
        Authorization: `Bearer ${device.token}`,
      },
    });
    expect(response.status).toBe(200);
  });

  it("rejects a cross-origin write", async () => {
    const base = await harness();
    const device = await base.pair("control");
    const response = await fetch(base.url(REMOTE_API.messages("s-1")), {
      method: "POST",
      headers: { ...bearer(device.token), Origin: "https://evil.example", "Content-Type": "application/json" },
      body: JSON.stringify({ operationId: "op-12345678", input: { text: "hi", images: [], files: [] } }),
    });
    expect(response.status).toBe(403);
    expect(base.host.calls).toEqual([]);
  });

  it("serves the app shell and hashed assets with different cache rules", async () => {
    const base = await harness();
    const shell = await fetch(base.url("/"));
    expect(shell.status).toBe(200);
    expect(shell.headers.get("cache-control")).toBe("no-store");
    expect(await shell.text()).toContain("Gajae remote");
    const asset = await fetch(base.url("/assets/app-abcdef123456.js"));
    expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    const missing = await fetch(base.url("/assets/gone.js"));
    expect(missing.status).toBe(404);
    const route = await fetch(base.url("/sessions/anything"));
    expect(route.status).toBe(200);
    expect(await route.text()).toContain("Gajae remote");
  });

  it("does not need a token to load the client, but never serves session data", async () => {
    const base = await harness();
    expect((await fetch(base.url("/"))).status).toBe(200);
    expect((await fetch(base.url(REMOTE_API.state))).status).toBe(401);
  });
});

describe("remote server permissions", () => {
  it("lets a view-only device read", async () => {
    const base = await harness();
    const device = await base.pair("view");
    const response = await fetch(base.url(REMOTE_API.transcript("s-1")), {
      headers: bearer(device.token),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ result: [] });
    expect(base.host.calls).toContain("transcript:s-1");
    const revision = await fetch(base.url(REMOTE_API.transcriptRevision("s-1")), {
      headers: bearer(device.token),
    });
    expect(revision.status).toBe(200);
    expect(await revision.json()).toEqual({ result: "rev" });
    expect(base.host.calls).toContain("transcript-revision:s-1");
    const changes = await fetch(base.url(REMOTE_API.transcriptChanges("s-1")), {
      headers: bearer(device.token),
    });
    expect(changes.status).toBe(200);
    expect(await changes.json()).toEqual({
      result: { kind: "full", items: [] },
    });
  });

  it("serves transcript pages to view-only devices with the requested anchors", async () => {
    const base = await harness();
    const device = await base.pair("view");
    const message: TranscriptItem = {
      id: "message-1",
      sessionId: "s-1",
      kind: "message",
      role: "assistant",
      content: "page row",
      createdAt: new Date(0).toISOString(),
    };
    base.host.transcript.push(message);

    const initial = await fetch(base.url(REMOTE_API.transcriptPage("s-1")), {
      headers: bearer(device.token),
    });
    expect(initial.status).toBe(200);
    const expectedPage = {
      items: [message],
      hasMoreBefore: false,
      hasMoreAfter: false,
      firstId: message.id,
      lastId: message.id,
      requests: [],
    };
    expect(await initial.json()).toEqual({ result: expectedPage });

    const beforeId = "before /? #message";
    const before = await fetch(
      base.url(`${REMOTE_API.transcriptPage("s-1")}?beforeId=${encodeURIComponent(beforeId)}`),
      { headers: bearer(device.token) },
    );
    expect(before.status).toBe(200);
    expect(await before.json()).toEqual({
      result: { ...expectedPage, hasMoreBefore: true },
    });

    const aroundId = "around ü message";
    const around = await fetch(
      base.url(`${REMOTE_API.transcriptPage("s-1")}?aroundId=${encodeURIComponent(aroundId)}`),
      { headers: bearer(device.token) },
    );
    expect(around.status).toBe(200);
    expect(await around.json()).toEqual({
      result: { ...expectedPage, hasMoreAfter: true },
    });
    expect(base.host.pageRequests).toEqual([
      { sessionId: "s-1" },
      { sessionId: "s-1", request: { beforeId } },
      { sessionId: "s-1", request: { aroundId } },
    ]);
  });

  it("rejects malformed transcript page cursors before reaching the host", async () => {
    const base = await harness();
    const device = await base.pair("view");
    const endpoint = REMOTE_API.transcriptPage("s-1");
    const malformedQueries = [
      "?beforeId=first&beforeId=second",
      "?aroundId=first&aroundId=second",
      "?unknown=message",
      "?beforeId=",
      `?aroundId=${"x".repeat(513)}`,
      "?beforeId=first&aroundId=second",
    ];

    for (const query of malformedQueries) {
      const response = await fetch(base.url(`${endpoint}${query}`), {
        headers: bearer(device.token),
      });
      expect(response.status, query).toBe(400);
      expect((await response.json()).error.code, query).toBe("invalid");
    }
    expect(base.host.pageRequests).toEqual([]);
    expect(base.host.calls).toEqual([]);
  });

  it("does not change the delta baseline when a device reads a transcript page", async () => {
    const base = await harness();
    const device = await base.pair("view");
    const first: TranscriptItem = {
      id: "m-1",
      sessionId: "s-1",
      kind: "message",
      role: "assistant",
      content: "first",
      createdAt: new Date(0).toISOString(),
    };
    base.host.transcript.push(first);
    const initial = await fetch(base.url(REMOTE_API.transcript("s-1")), {
      headers: bearer(device.token),
    });
    expect(await initial.json()).toEqual({ result: [first] });

    const page = await fetch(base.url(REMOTE_API.transcriptPage("s-1")), {
      headers: bearer(device.token),
    });
    expect(await page.json()).toMatchObject({ result: { items: [first] } });

    const second: TranscriptItem = {
      id: "m-2",
      sessionId: "s-1",
      kind: "message",
      role: "assistant",
      content: "second",
      createdAt: new Date(1000).toISOString(),
    };
    base.host.transcript.push(second);
    const changes = await fetch(base.url(REMOTE_API.transcriptChanges("s-1")), {
      headers: bearer(device.token),
    });
    expect(await changes.json()).toEqual({
      result: { kind: "patch", items: [second] },
    });
  });

  it("sends only transcript rows appended since the device's last read", async () => {
    const base = await harness();
    const device = await base.pair("view");
    const first: TranscriptItem = {
      id: "m-1",
      sessionId: "s-1",
      kind: "message",
      role: "assistant",
      content: "first",
      createdAt: new Date(0).toISOString(),
    };
    base.host.transcript.push(first);
    const initial = await fetch(base.url(REMOTE_API.transcript("s-1")), {
      headers: bearer(device.token),
    });
    expect(await initial.json()).toEqual({ result: [first] });

    const second: TranscriptItem = {
      id: "m-2",
      sessionId: "s-1",
      kind: "message",
      role: "assistant",
      content: "second",
      createdAt: new Date(1000).toISOString(),
    };
    base.host.transcript.push(second);
    const changes = await fetch(base.url(REMOTE_API.transcriptChanges("s-1")), {
      headers: bearer(device.token),
    });
    expect(await changes.json()).toEqual({
      result: { kind: "patch", items: [second] },
    });
  });

  it("refuses every control operation for a view-only device", async () => {
    const base = await harness();
    const device = await base.pair("view");
    const attempts: Array<[string, unknown]> = [
      [REMOTE_API.messages("s-1"), { operationId: "op-11111111", input: { text: "hi", images: [], files: [] } }],
      [REMOTE_API.steer("s-1"), { operationId: "op-22222222", input: { text: "hi", images: [], files: [] } }],
      [REMOTE_API.followUps("s-1"), { operationId: "op-33333333", input: { text: "hi", images: [], files: [] } }],
      [REMOTE_API.flushFollowUps("s-1"), { operationId: "op-44444444" }],
      [REMOTE_API.cancel("s-1"), { operationId: "op-55555555" }],
      [REMOTE_API.read("s-1"), { operationId: "op-66666666" }],
      [REMOTE_API.toolCallDecision("t-1"), { operationId: "op-77777777", decision: { optionId: "allow_once" } }],
    ];
    for (const [endpoint, body] of attempts) {
      const response = await post(base, device.token, endpoint, body);
      expect(response.status, endpoint).toBe(403);
      expect(response.body.error.code).toBe("forbidden");
    }
    expect(base.host.calls).toEqual([]);
  });

  it("refuses control operations that are not exposed to remote devices at all", async () => {
    const base = await harness();
    const device = await base.pair("control");
    const response = await post(base, device.token, "/api/sessions/s-1/delete", {
      operationId: "op-abcdefgh",
    });
    expect(response.status).toBe(404);
  });

  it("applies a permission change to the next request", async () => {
    const base = await harness();
    const device = await base.pair("view");
    const body = {
      operationId: "op-99999999",
      input: { text: "달려", images: [], files: [] },
    };
    expect((await post(base, device.token, REMOTE_API.messages("s-1"), body)).status).toBe(403);
    base.devices.setPermission(device.deviceId, "control");
    const allowed = await post(base, device.token, REMOTE_API.messages("s-1"), body);
    expect(allowed.status).toBe(200);
    expect(allowed.body.state).toBe("completed");
    expect(base.host.calls).toEqual(["send:s-1"]);
  });

  it("refuses malformed message input without reaching the host", async () => {
    const base = await harness();
    const device = await base.pair("control");
    const attempts = [
      { operationId: "op-aaaaaaaa", input: { text: "hi", images: [], files: [{ token: "x" }] } },
      { operationId: "op-bbbbbbbb", input: { text: "", images: [], files: [] } },
      { operationId: "op-cccccccc", input: { text: "hi", images: [{ id: "1", name: "a.png", mimeType: "image/png", token: "y".repeat(43) }], files: [] } },
    ];
    for (const body of attempts) {
      const response = await post(base, device.token, REMOTE_API.messages("s-1"), body);
      expect(response.status).toBe(200);
      expect(response.body.state).toBe("failed");
    }
    expect(base.host.calls).toEqual([]);
  });
});

describe("remote server control idempotency", () => {
  it("runs one instruction once even when the client retries the ID", async () => {
    const base = await harness();
    const device = await base.pair("control");
    const body = {
      operationId: "op-repeat-0001",
      input: { text: "한 번만", images: [], files: [] },
    };
    const first = await post(base, device.token, REMOTE_API.messages("s-1"), body);
    const second = await post(base, device.token, REMOTE_API.messages("s-1"), body);
    expect(first.body).toMatchObject({ state: "completed", result: "prompt" });
    expect(second.body).toMatchObject({ state: "completed", result: "prompt" });
    expect(base.host.calls).toEqual(["send:s-1"]);
  });

  it("makes a concurrent duplicate wait instead of running it twice", async () => {
    const base = await harness();
    const device = await base.pair("control");
    const finishes: Array<() => void> = [];
    base.host.sendMessage = async (sessionId: string) => {
      base.host.calls.push(`send:${sessionId}`);
      await new Promise<void>((resolve) => finishes.push(resolve));
      return "prompt" as const;
    };
    const body = {
      operationId: "op-concurrent-1",
      input: { text: "한 번만", images: [], files: [] },
    };
    const first = post(base, device.token, REMOTE_API.messages("s-1"), body);
    const second = post(base, device.token, REMOTE_API.messages("s-1"), body);
    for (let attempt = 0; attempt < 100 && finishes.length < 1; attempt += 1)
      await new Promise((resolve) => setTimeout(resolve, 5));
    // Give a duplicate a chance to start the host instruction before releasing it.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const started = [...base.host.calls];
    // Release every run that did start so a failing (pre-fix) case cannot leave
    // the two HTTP requests hanging.
    for (const finish of finishes) finish();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(started).toEqual(["send:s-1"]);
    expect(firstResult.body).toMatchObject({ state: "completed", result: "prompt" });
    expect(secondResult.body).toMatchObject({ state: "completed", result: "prompt" });
    expect(base.host.calls).toEqual(["send:s-1"]);
  });

  it("treats a reused ID with a different payload as the same operation", async () => {
    const base = await harness();
    const device = await base.pair("control");
    let finish!: () => void;
    base.host.sendMessage = async (sessionId: string) => {
      base.host.calls.push(`send:${sessionId}`);
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return "prompt" as const;
    };
    const first = post(base, device.token, REMOTE_API.messages("s-1"), {
      operationId: "op-policy-0001",
      input: { text: "보내기", images: [], files: [] },
    });
    for (let attempt = 0; attempt < 100 && base.host.calls.length === 0; attempt += 1)
      await new Promise((resolve) => setTimeout(resolve, 5));
    const second = post(base, device.token, REMOTE_API.cancel("s-1"), {
      operationId: "op-policy-0001",
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    finish();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    // The first request owns the ID; the second receives its outcome and does not
    // execute its own route.
    expect(firstResult.body).toMatchObject({ state: "completed", result: "prompt" });
    expect(secondResult.body).toEqual(firstResult.body);
    expect(base.host.calls).toEqual(["send:s-1"]);
  });

  it("replays a recorded failure instead of running it again", async () => {
    const base = await harness();
    const device = await base.pair("control");
    base.host.sendMessage = async () => {
      base.host.calls.push("send:failed");
      throw new Error("세션을 찾을 수 없습니다");
    };
    const body = {
      operationId: "op-failure-001",
      input: { text: "hi", images: [], files: [] },
    };
    const first = await post(base, device.token, REMOTE_API.messages("s-1"), body);
    const second = await post(base, device.token, REMOTE_API.messages("s-1"), body);
    expect(first.body).toMatchObject({ state: "failed", message: "세션을 찾을 수 없습니다" });
    expect(second.body).toMatchObject({ state: "failed", message: "세션을 찾을 수 없습니다" });
    expect(base.host.calls).toEqual(["send:failed"]);
  });

  it("distinguishes a new operation ID from a retry", async () => {
    const base = await harness();
    const device = await base.pair("control");
    const input = { text: "두 번", images: [], files: [] };
    await post(base, device.token, REMOTE_API.messages("s-1"), { operationId: "op-first-0001", input });
    await post(base, device.token, REMOTE_API.messages("s-1"), { operationId: "op-second-001", input });
    expect(base.host.calls).toEqual(["send:s-1", "send:s-1"]);
  });

  it("reports the outcome of an operation the client can no longer hear about", async () => {
    const base = await harness();
    const device = await base.pair("control");
    const body = {
      operationId: "op-lookup-0001",
      input: { text: "결과 조회", images: [], files: [] },
    };
    await post(base, device.token, REMOTE_API.messages("s-1"), body);
    const response = await fetch(base.url(REMOTE_API.operation("op-lookup-0001")), {
      headers: bearer(device.token),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ state: "completed", result: "prompt" });
    const unknown = await fetch(base.url(REMOTE_API.operation("op-missing-001")), {
      headers: bearer(device.token),
    });
    expect(unknown.status).toBe(404);
  });

  it("rejects a control request without an operation ID", async () => {
    const base = await harness();
    const device = await base.pair("control");
    const response = await post(base, device.token, REMOTE_API.cancel("s-1"), {});
    expect(response.status).toBe(400);
    expect(base.host.calls).toEqual([]);
  });
});

describe("remote server revocation", () => {
  it("closes live streams and refuses every later request", async () => {
    const base = await harness();
    const device = await base.pair("control");
    const stream = await SseReader.open(base.url(REMOTE_API.events), device.token, base.origin);
    const hello = await stream.next();
    expect(hello.event).toBe("hello");
    // The instance lets a client distinguish a gap from a restarted event log.
    expect(typeof hello.data.instance).toBe("string");
    base.devices.revoke(device.deviceId);
    const revoked = await stream.next();
    expect(revoked.event).toBe("revoked");
    await stream.closed();
    const after = await fetch(base.url(REMOTE_API.state), { headers: bearer(device.token) });
    expect(after.status).toBe(401);
    const write = await post(base, device.token, REMOTE_API.cancel("s-1"), {
      operationId: "op-revoked-001",
    });
    expect(write.status).toBe(401);
    expect(base.host.calls).toEqual([]);
  });
});

describe("remote server event stream", () => {
  function updated(title: string): AgentEvent {
    return {
      type: "session.updated",
      session: { id: "s-1", title },
    } as unknown as AgentEvent;
  }

  it("numbers events and replays what a reconnecting client missed", async () => {
    const base = await harness();
    const device = await base.pair("view");
    const stream = await SseReader.open(base.url(REMOTE_API.events), device.token, base.origin);
    expect((await stream.next()).event).toBe("hello");
    base.server.publish(updated("one"));
    const first = await stream.next();
    expect(first.event).toBe("agent");
    expect(first.data.seq).toBe(1);
    base.server.publish(updated("two"));
    const second = await stream.next();
    expect(second.data.seq).toBe(2);
    stream.close();

    const resumed = await SseReader.open(
      base.url(REMOTE_API.events),
      device.token,
      base.origin,
      1,
    );
    const replayed = await resumed.next();
    expect(replayed.data).toMatchObject({ seq: 2, event: { type: "session.updated" } });
    resumed.close();
  });

  it("drops a device that stops reading instead of buffering without bound", async () => {
    const base = await harness({ stalledStreamMs: 50 });
    const device = await base.pair("view");
    const response = await new Promise<import("node:http").IncomingMessage>(
      (resolve, reject) => {
        const request = httpRequest(
          {
            host: "127.0.0.1",
            port: base.port,
            path: REMOTE_API.events,
            headers: { Authorization: `Bearer ${device.token}` },
          },
          resolve,
        );
        request.on("error", reject);
        request.end();
      },
    );
    response.on("error", () => undefined);
    response.pause();
    for (let attempt = 0; attempt < 100 && base.server.streamCount === 0; attempt += 1)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(base.server.streamCount).toBe(1);
    const large = updated("x".repeat(64 * 1024));
    for (let index = 0; index < 100 && base.server.streamCount > 0; index += 1) {
      base.server.publish(large);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(base.server.streamCount).toBe(0);
    response.destroy();
  });

  it("delivers an event larger than the queue cap and keeps the device attached", async () => {
    const base = await harness();
    const device = await base.pair("view");
    // A whole-history sync of a long session is one event over the 1 MiB cap. The
    // device used to be dropped on it, and each reconnect replayed it into the same drop.
    base.server.publish(updated("x".repeat(1536 * 1024)));
    base.server.publish(updated("after-replay"));
    const stream = await SseReader.open(base.url(REMOTE_API.events), device.token, base.origin, 0);
    const replayedLarge = await stream.next(6000);
    expect(replayedLarge.data).toMatchObject({ seq: 1 });
    const replayedNext = await stream.next(6000);
    expect(replayedNext.data).toMatchObject({ seq: 2 });
    // The hello follows the replay, so its position is one the device really reached.
    const hello = await stream.next(6000);
    expect(hello.event).toBe("hello");
    expect(hello.data).toMatchObject({ seq: 2 });
    base.server.publish(updated("x".repeat(1536 * 1024)));
    base.server.publish(updated("live"));
    expect((await stream.next(6000)).data).toMatchObject({ seq: 3 });
    expect((await stream.next(6000)).data).toMatchObject({ seq: 4 });
    expect(base.server.streamCount).toBe(1);
    stream.close();
  });

  it("asks for a resync when the cursor is older than the buffer", async () => {
    const base = await harness();
    const device = await base.pair("view");
    for (let index = 0; index < 1200; index += 1) base.server.publish(updated(`event-${index}`));
    const stream = await SseReader.open(
      base.url(REMOTE_API.events),
      device.token,
      base.origin,
      1,
    );
    const frame = await stream.next(6000);
    expect(frame.event).toBe("resync");
    expect(frame.data.resync).toBe(true);
    stream.close();
  });

  it("asks for a resync when the cursor is ahead of this server instance", async () => {
    const base = await harness();
    const device = await base.pair("view");
    const stream = await SseReader.open(
      base.url(REMOTE_API.events),
      device.token,
      base.origin,
      999,
    );
    const frame = await stream.next();
    expect(frame.event).toBe("resync");
    expect(frame.data).toMatchObject({ resync: true, seq: 0 });
    stream.close();
  });

  it("refuses an unauthenticated stream", async () => {
    const base = await harness();
    await expect(
      SseReader.open(base.url(REMOTE_API.events), "z".repeat(43), base.origin),
    ).rejects.toThrow("401");
  });
});

describe("tailnet identity access", () => {
  const OWNER = "owner@example.com";
  const TAILNET = "100.101.102.103";

  /** The headers Serve puts on a request from the owner's own device. */
  const serveHeaders = (login = OWNER, forwarded: string | null = TAILNET) => ({
    "tailscale-user-login": login,
    ...(forwarded === null ? {} : { "x-forwarded-for": forwarded }),
  });

  it("admits the owner's own device without a token", async () => {
    const base = await harness({ identity: async () => ({ login: OWNER }) });
    const response = await rawRequest(base, REMOTE_API.state, { headers: serveHeaders() });
    expect(response.status).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.device).toMatchObject({
      id: `tailscale:${OWNER}`,
      permission: "control",
      via: "tailscale",
    });
    expect(body.sessions).toHaveLength(1);
  });

  it("admits control from an identity client", async () => {
    const base = await harness({ identity: async () => ({ login: OWNER }) });
    const response = await fetch(base.url(REMOTE_API.cancel("s-1")), {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: base.origin, ...serveHeaders() },
      body: JSON.stringify({ operationId: "op-66666666" }),
    });
    expect(response.status).toBe(200);
  });

  it("refuses a login that is not this machine's owner", async () => {
    const base = await harness({ identity: async () => ({ login: OWNER }) });
    const response = await rawRequest(base, REMOTE_API.state, {
      headers: serveHeaders("guest@example.com"),
    });
    expect(response.status).toBe(401);
  });

  it("refuses an identity claim that Serve did not forward", async () => {
    // Without X-Forwarded-For there is no proof the request came through Serve at
    // all: any local process can send a login header.
    const base = await harness({ identity: async () => ({ login: OWNER }) });
    const missing = await rawRequest(base, REMOTE_API.state, {
      headers: serveHeaders(OWNER, null),
    });
    expect(missing.status).toBe(401);
    const publicAddress = await rawRequest(base, REMOTE_API.state, {
      headers: serveHeaders(OWNER, "203.0.113.9"),
    });
    expect(publicAddress.status).toBe(401);
    const chained = await rawRequest(base, REMOTE_API.state, {
      headers: serveHeaders(OWNER, `${TAILNET}, 203.0.113.9`),
    });
    expect(chained.status).toBe(401);
  });

  it("refuses a request Funnel carried in from the internet", async () => {
    const base = await harness({ identity: async () => ({ login: OWNER }) });
    const response = await rawRequest(base, REMOTE_API.state, {
      headers: { ...serveHeaders(), "tailscale-funnel-request": "?1" },
    });
    expect(response.status).toBe(401);
  });

  it("stays closed when Tailscale cannot name the owner", async () => {
    const base = await harness({ identity: async () => undefined });
    const response = await rawRequest(base, REMOTE_API.state, { headers: serveHeaders() });
    expect(response.status).toBe(401);
  });

  it("does not consult Tailscale for a request that claims nothing", async () => {
    let lookups = 0;
    const base = await harness({
      identity: async () => {
        lookups += 1;
        return { login: OWNER };
      },
    });
    const response = await rawRequest(base, REMOTE_API.state);
    expect(response.status).toBe(401);
    expect(lookups).toBe(0);
  });

  it("records the tailnet address Serve forwarded instead of loopback", async () => {
    // Every peer reaches the server through the local tailscaled, so the socket
    // address is 127.0.0.1; the device list is only useful with the real one.
    const base = await harness();
    const pairing = base.devices.issuePairingCode("view");
    const paired = await fetch(base.url(REMOTE_API.pair), {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: base.origin, ...serveHeaders(OWNER) },
      body: JSON.stringify({ code: pairing.code, deviceName: "iPhone" }),
    });
    expect(paired.status).toBe(200);
    expect(base.devices.list()[0]?.clientAddress).toBe(TAILNET);
  });
});
