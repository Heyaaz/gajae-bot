import { describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "../../shared/agent-contract";
import { REMOTE_API } from "../../shared/remote-protocol";
import {
  RemoteClient,
  RemoteRequestError,
  SseParser,
  TOKEN_STORAGE_KEY,
  nextReconnectDelay,
  readPairingCodeFromHash,
  type TokenStorage,
} from "./client";

const TOKEN = "t".repeat(43);

function memoryStorage(initial: string | null = null): TokenStorage & { value: string | null } {
  return {
    value: initial,
    read() {
      return this.value;
    },
    write(token: string) {
      this.value = token;
    },
    clear() {
      this.value = null;
    },
  };
}

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** A fetch double that records every request and routes by path. */
function recorder(
  routes: (call: Call) => Response | undefined | Promise<Response | undefined>,
) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>).map(([key, value]) => [
        key.toLowerCase(),
        value,
      ]),
    );
    const call: Call = {
      url,
      method: init?.method ?? "GET",
      headers,
      ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) as unknown } : {}),
    };
    calls.push(call);
    const response = await routes(call);
    if (response) return response;
    throw new Error(`unexpected request: ${call.method} ${call.url}`);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function streamResponse(chunks: string[], options: { keepOpen?: boolean } = {}): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      if (!options.keepOpen) controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

const snapshotBody = {
  connection: { state: "connected", backend: "gjc", label: "GJC", detail: "", workspace: "/tmp/ws" },
  sessions: [],
  device: { id: "d-1", name: "iPhone", permission: "control" },
  server: { version: "0.1.0", time: new Date(0).toISOString(), workspace: "/tmp/ws", protocol: 1 },
};

describe("pairing code fragments", () => {
  it("accepts a scanned code and rejects anything else", () => {
    expect(readPairingCodeFromHash("#pair=abcd2345")).toBe("ABCD2345");
    expect(readPairingCodeFromHash("#pair=ABCD-2345")).toBe("ABCD2345");
    expect(readPairingCodeFromHash("#pair=oops")).toBeNull();
    expect(readPairingCodeFromHash("#other=ABCD2345")).toBeNull();
    expect(readPairingCodeFromHash("")).toBeNull();
  });
});

describe("event stream parsing", () => {
  it("reassembles frames that a chunk boundary split", () => {
    const parser = new SseParser();
    expect(parser.push("event: agent\ndata: {\"seq\":1,")).toHaveLength(0);
    const frames = parser.push('"event":{"type":"session.deleted"}}\n\n');
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      event: "agent",
      data: { seq: 1, event: { type: "session.deleted" } },
    });
  });

  it("reads several frames from one chunk and ignores comments", () => {
    const parser = new SseParser();
    const frames = parser.push(
      ": ping\n\nretry: 3000\n\nevent: hello\ndata: {\"seq\":0}\n\nevent: agent\ndata: {\"seq\":1}\n\n",
    );
    expect(frames.map((frame) => frame.event)).toEqual(["hello", "agent"]);
  });

  it("skips a frame whose data is not JSON", () => {
    const parser = new SseParser();
    expect(parser.push("event: agent\ndata: not-json\n\n")).toEqual([]);
  });
});

describe("reconnect backoff", () => {
  it("grows to a ceiling and stays within jitter bounds", () => {
    const options = { minDelayMs: 1000, maxDelayMs: 8000, jitter: () => 0.5 };
    expect(nextReconnectDelay(1, options)).toBe(1000);
    expect(nextReconnectDelay(2, options)).toBe(2000);
    expect(nextReconnectDelay(3, options)).toBe(4000);
    expect(nextReconnectDelay(4, options)).toBe(8000);
    expect(nextReconnectDelay(20, options)).toBe(8000);
    const low = nextReconnectDelay(4, { ...options, jitter: () => 0 });
    const high = nextReconnectDelay(4, { ...options, jitter: () => 1 });
    expect(low).toBe(6000);
    expect(high).toBe(10_000);
  });
});

describe("pairing", () => {
  it("stores the token and reports permission", async () => {
    const storage = memoryStorage();
    const { fetchImpl, calls } = recorder(() =>
      jsonResponse(200, {
        deviceId: "d-1",
        token: TOKEN,
        device: { id: "d-1", name: "iPhone", permission: "control" },
        server: { version: "0.1.0", workspace: "/tmp/ws", protocol: 1 },
      }),
    );
    const client = new RemoteClient({ baseUrl: "https://mac.tailnet.ts.net", storage, fetchImpl });
    await client.pair("abcd-2345");
    expect(storage.value).toBe(TOKEN);
    expect(client.getStatus()).toMatchObject({ state: "connected", permission: "control" });
    expect(calls[0].url).toBe(`https://mac.tailnet.ts.net${REMOTE_API.pair}`);
    expect(calls[0].body).toMatchObject({ code: "ABCD2345" });
    // The code never travels in a URL.
    expect(calls[0].url).not.toContain("ABCD2345");
    client.dispose();
  });

  it("surfaces a rejected code without keeping a token", async () => {
    const storage = memoryStorage();
    const { fetchImpl } = recorder(() =>
      jsonResponse(401, { error: { code: "unauthorized", message: "The pairing code is not valid or has expired" } }),
    );
    const client = new RemoteClient({ baseUrl: "https://host", storage, fetchImpl });
    await expect(client.pair("ABCD2345")).rejects.toThrow(/not valid or has expired/u);
    expect(storage.value).toBeNull();
    client.dispose();
  });

  it("refuses a pairing response that arrives after forget", async () => {
    const storage = memoryStorage();
    let release!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    let signal: AbortSignal | undefined;
    const client = new RemoteClient({
      baseUrl: "https://host",
      storage,
      fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        signal = init?.signal ?? undefined;
        return pending;
      }) as typeof fetch,
    });
    const pairing = client.pair("ABCD2345").then(
      () => "resolved",
      (error: unknown) => error,
    );
    await vi.waitFor(() => expect(signal).toBeDefined());
    client.forget();
    expect(signal?.aborted).toBe(true);
    release(
      jsonResponse(200, {
        token: TOKEN,
        device: { id: "d-1", name: "iPhone", permission: "control" },
      }),
    );
    const failure = await Promise.race([
      pairing,
      new Promise((resolve) => setTimeout(() => resolve("hung"), 500)),
    ]);
    expect(failure).toBeInstanceOf(RemoteRequestError);
    expect((failure as RemoteRequestError).code).toBe("stale-auth");
    expect(storage.value).toBeNull();
    expect(client.getStatus().state).toBe("pairing");
    client.dispose();
  });

  it("keeps the newest pairing when two answers arrive in reverse order", async () => {
    const storage = memoryStorage();
    const pending: Array<(response: Response) => void> = [];
    const signals: AbortSignal[] = [];
    const client = new RemoteClient({
      baseUrl: "https://host",
      storage,
      fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.signal) signals.push(init.signal);
        return new Promise<Response>((resolve) => pending.push(resolve));
      }) as typeof fetch,
    });
    const first = client.pair("ABCD2345").then(
      () => "resolved",
      (error: unknown) => error,
    );
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    const second = client.pair("WXYZ6789");
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    expect(signals[0]?.aborted).toBe(true);

    const newest = "n".repeat(43);
    pending[1]!(
      jsonResponse(200, {
        token: newest,
        device: { id: "d-2", name: "New phone", permission: "control" },
      }),
    );
    await expect(second).resolves.toBeUndefined();
    expect(storage.value).toBe(newest);

    // The first answer lands after the newest credential is established. It has no
    // authority to replace it.
    pending[0]!(
      jsonResponse(200, {
        token: "o".repeat(43),
        device: { id: "d-1", name: "Old phone", permission: "control" },
      }),
    );
    const failure = await first;
    expect(failure).toBeInstanceOf(RemoteRequestError);
    expect((failure as RemoteRequestError).code).toBe("stale-auth");
    expect(storage.value).toBe(newest);
    expect(client.getStatus()).toMatchObject({ state: "connected", deviceName: "New phone" });
    client.dispose();
  });

  it("times out a pairing that stalls before headers or in either body", async () => {
    const never = () => new Promise<never>(() => undefined);
    const scenarios: Array<{ name: string; fetchImpl: typeof fetch }> = [
      {
        name: "headers",
        fetchImpl: (async () => never()) as typeof fetch,
      },
      {
        name: "success body",
        fetchImpl: (async () =>
          ({ status: 200, ok: true, json: never }) as unknown as Response) as typeof fetch,
      },
      {
        name: "error body",
        fetchImpl: (async () =>
          ({ status: 503, ok: false, json: never }) as unknown as Response) as typeof fetch,
      },
    ];
    for (const scenario of scenarios) {
      const storage = memoryStorage();
      const client = new RemoteClient({
        baseUrl: "https://host",
        storage,
        fetchImpl: scenario.fetchImpl,
        requestTimeoutMs: 20,
      });
      const failure = await Promise.race([
        client.pair("ABCD2345").then(
          () => "resolved",
          (error: unknown) => error,
        ),
        new Promise((resolve) => setTimeout(() => resolve("hung"), 500)),
      ]);
      expect(failure, scenario.name).toBeInstanceOf(RemoteRequestError);
      expect((failure as RemoteRequestError).uncertain, scenario.name).toBe(true);
      expect((failure as Error).message, scenario.name).toContain("시간이 초과");
      expect(storage.value, scenario.name).toBeNull();
      client.dispose();
    }
  });
});

describe("authenticated requests", () => {
  it("sends the stored token as a bearer header", async () => {
    const { fetchImpl, calls } = recorder(() => jsonResponse(200, snapshotBody));
    const client = new RemoteClient({
      baseUrl: "https://host",
      storage: memoryStorage(TOKEN),
      fetchImpl,
    });
    const snapshot = await client.snapshot();
    expect(snapshot.device.name).toBe("iPhone");
    expect(calls[0].headers.authorization).toBe(`Bearer ${TOKEN}`);
    // The token is never part of the URL, so it cannot land in an access log.
    expect(calls[0].url).not.toContain(TOKEN);
    client.dispose();
  });

  it("reads only changed transcript rows from the delta endpoint", async () => {
    const change = { kind: "patch" as const, items: [] };
    const { fetchImpl, calls } = recorder((call) =>
      call.url.endsWith(REMOTE_API.transcriptChanges("s-1"))
        ? jsonResponse(200, { result: change })
        : undefined,
    );
    const client = new RemoteClient({
      baseUrl: "https://host",
      storage: memoryStorage(TOKEN),
      fetchImpl,
    });
    await expect(client.transcriptChanges("s-1")).resolves.toEqual(change);
    expect(calls.map((call) => call.url)).toContain(
      `https://host${REMOTE_API.transcriptChanges("s-1")}`,
    );
    expect(calls.map((call) => call.url)).not.toContain(
      `https://host${REMOTE_API.transcript("s-1")}`,
    );
    client.dispose();
  });

  it("URL-encodes before and around transcript page cursors", async () => {
    const page = {
      items: [],
      hasMoreBefore: true,
      hasMoreAfter: false,
      firstId: "first",
      lastId: "last",
      requests: [],
    };
    const { fetchImpl, calls } = recorder((call) =>
      call.url.includes(REMOTE_API.transcriptPage("s/1"))
        ? jsonResponse(200, { result: page })
        : undefined,
    );
    const client = new RemoteClient({
      baseUrl: "https://host",
      storage: memoryStorage(TOKEN),
      fetchImpl,
    });
    const beforeId = "before /?&=한글";
    const aroundId = "around +% #한글";

    await expect(client.transcriptPage("s/1", { beforeId })).resolves.toEqual(page);
    await expect(client.transcriptPage("s/1", { aroundId })).resolves.toEqual(page);

    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call.method)).toEqual(["GET", "GET"]);
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      REMOTE_API.transcriptPage("s/1"),
      REMOTE_API.transcriptPage("s/1"),
    ]);
    expect(calls.map((call) => [...new URL(call.url).searchParams.entries()])).toEqual([
      [["beforeId", beforeId]],
      [["aroundId", aroundId]],
    ]);
    expect(calls[0].url).toContain("%2F");
    expect(calls[0].url).toContain("%26");
    expect(calls[0].url).toContain("%3D");
    expect(calls[0].url).toContain("%ED%95%9C");
    expect(calls[1].url).toContain("%2B%25");
    client.dispose();
  });

  it("treats a 401 as revocation and forgets the token", async () => {
    const storage = memoryStorage(TOKEN);
    const { fetchImpl } = recorder(() => jsonResponse(401, { error: { code: "revoked", message: "no" } }));
    const client = new RemoteClient({ baseUrl: "https://host", storage, fetchImpl });
    const seen: string[] = [];
    client.subscribe((status) => seen.push(status.state));
    await expect(client.snapshot()).rejects.toThrow(/접근이 해제/u);
    expect(client.getStatus().state).toBe("revoked");
    expect(storage.value).toBeNull();
    expect(seen).toContain("revoked");
    client.dispose();
  });
});

describe("control operations", () => {
  const message = { text: "안녕", images: [], files: [] };

  it("sends an operation ID and returns the recorded result", async () => {
    const { fetchImpl, calls } = recorder((call) => {
      if (call.method === "POST")
        return jsonResponse(200, {
          operationId: (call.body as { operationId: string }).operationId,
          state: "completed",
          result: "prompt",
          at: new Date(0).toISOString(),
        });
      return undefined;
    });
    const client = new RemoteClient({ baseUrl: "https://host", storage: memoryStorage(TOKEN), fetchImpl });
    await expect(client.sendMessage("s-1", message)).resolves.toBe("prompt");
    const body = calls[0].body as { operationId: string };
    expect(body.operationId).toMatch(/^op-[A-Za-z0-9._:-]{8,}$/u);
    client.dispose();
  });

  it("reports a recorded failure as the answer, not as a transport problem", async () => {
    const { fetchImpl } = recorder(() =>
      jsonResponse(200, {
        operationId: "op-failed00001",
        state: "failed",
        message: "세션을 찾을 수 없습니다",
        at: new Date(0).toISOString(),
      }),
    );
    const client = new RemoteClient({ baseUrl: "https://host", storage: memoryStorage(TOKEN), fetchImpl });
    await expect(client.sendMessage("s-1", message)).rejects.toThrow("세션을 찾을 수 없습니다");
    client.dispose();
  });

  it("looks the outcome up instead of resending after the connection dropped", async () => {
    // First attempt: the connection dies with no answer. The host *did* run it,
    // so the recorded outcome is what the client must report.
    const storage = memoryStorage(TOKEN);
    let attempts = 0;
    const { fetchImpl, calls } = recorder((call) => {
      if (call.method === "POST") {
        attempts += 1;
        throw new Error("socket hang up");
      }
      if (call.url.includes(REMOTE_API.operations)) {
        return jsonResponse(200, {
          operationId: "op-unknown0001",
          state: "completed",
          result: "prompt",
          at: new Date(0).toISOString(),
        });
      }
      return undefined;
    });
    const client = new RemoteClient({ baseUrl: "https://host", storage, fetchImpl });
    await expect(client.sendMessage("s-1", message)).resolves.toBe("prompt");
    expect(attempts).toBe(1);
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
    expect(calls.some((call) => call.url.includes(REMOTE_API.operations))).toBe(true);
    client.dispose();
  });

  it("never resends an instruction whose outcome is unknown", async () => {
    const { fetchImpl, calls } = recorder((call) => {
      if (call.method === "POST") throw new Error("socket hang up");
      return jsonResponse(404, { error: { code: "not-found", message: "No outcome recorded" } });
    });
    const client = new RemoteClient({ baseUrl: "https://host", storage: memoryStorage(TOKEN), fetchImpl });
    const failure = await client.sendMessage("s-1", message).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RemoteRequestError);
    expect((failure as RemoteRequestError).code).toBe("unknown-outcome");
    expect((failure as RemoteRequestError).uncertain).toBe(true);
    expect((failure as RemoteRequestError).operationId).toMatch(/^op-/u);
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
    client.dispose();
  });

  it("times out a control request and only performs a bounded outcome lookup", async () => {
    const never = new Promise<Response>(() => undefined);
    let posts = 0;
    let lookups = 0;
    const { fetchImpl } = recorder((call) => {
      if (call.method === "POST") {
        posts += 1;
        return never;
      }
      if (call.url.includes(REMOTE_API.operations)) {
        lookups += 1;
        return never;
      }
      return undefined;
    });
    const client = new RemoteClient({
      baseUrl: "https://host",
      storage: memoryStorage(TOKEN),
      fetchImpl,
      requestTimeoutMs: 20,
    });
    const failure = await Promise.race([
      client.sendMessage("s-1", message).then(
        () => "resolved",
        (error: unknown) => error,
      ),
      new Promise((resolve) => setTimeout(() => resolve("hung"), 500)),
    ]);
    expect(failure).toBeInstanceOf(RemoteRequestError);
    expect((failure as RemoteRequestError).code).toBe("unknown-outcome");
    expect((failure as RemoteRequestError).uncertain).toBe(true);
    // The POST is never repeated: only the recorded-outcome lookup follows it,
    // and that lookup is subject to the same deadline.
    expect(posts).toBe(1);
    expect(lookups).toBe(1);
    client.dispose();
  });

  it("applies the deadline while consuming a response body", async () => {
    const stalled = {
      status: 200,
      ok: true,
      json: () => new Promise<never>(() => undefined),
    } as unknown as Response;
    const client = new RemoteClient({
      baseUrl: "https://host",
      storage: memoryStorage(TOKEN),
      fetchImpl: (async () => stalled) as typeof fetch,
      requestTimeoutMs: 20,
    });
    const failure = await Promise.race([
      client.snapshot().then(
        () => "resolved",
        (error: unknown) => error,
      ),
      new Promise((resolve) => setTimeout(() => resolve("hung"), 500)),
    ]);
    expect(failure).toBeInstanceOf(RemoteRequestError);
    expect((failure as RemoteRequestError).uncertain).toBe(true);
    client.dispose();
  });

  it("reconciles a successful control response whose JSON body cannot be read", async () => {
    const operation = {
      operationId: "op-jsonfailure01",
      state: "completed",
      result: "prompt",
      at: new Date(0).toISOString(),
    };
    const { fetchImpl, calls } = recorder((call) => {
      if (call.method === "POST")
        return new Response("not-json", { status: 200, headers: { "Content-Type": "application/json" } });
      if (call.url.includes(REMOTE_API.operations)) return jsonResponse(200, operation);
      return undefined;
    });
    const client = new RemoteClient({ baseUrl: "https://host", storage: memoryStorage(TOKEN), fetchImpl });
    await expect(client.sendMessage("s-1", message)).resolves.toBe("prompt");
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
    const submitted = calls.find((call) => call.method === "POST")?.body as { operationId: string };
    expect(calls.find((call) => call.url.includes(REMOTE_API.operations))?.url).toContain(submitted.operationId);
    client.dispose();
  });
});

describe("event stream", () => {
  it("delivers events, tracks sequence, and asks for a resync when told to", async () => {
    const events: AgentEvent[] = [];
    let resyncs = 0;
    const hello = `event: hello\ndata: ${JSON.stringify({ seq: 5, device: { id: "d-1", name: "iPhone", permission: "view" } })}\n\n`;
    const event = `event: agent\ndata: ${JSON.stringify({
      seq: 6,
      event: { type: "session.deleted", sessionId: "s-1" },
    })}\n\n`;
    const resync = `event: resync\ndata: ${JSON.stringify({ seq: 9, resync: true, reason: "gap" })}\n\n`;
    const { fetchImpl, calls } = recorder((call) => {
      if (call.url.includes(REMOTE_API.events))
        return streamResponse([hello, event, resync], { keepOpen: true });
      if (call.url.includes(REMOTE_API.state)) return jsonResponse(200, snapshotBody);
      return undefined;
    });
    const client = new RemoteClient({
      baseUrl: "https://host",
      storage: memoryStorage(TOKEN),
      fetchImpl,
      onEvent: (payload) => events.push(payload),
      onResync: () => {
        resyncs += 1;
      },
    });
    client.startRealtime();
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]).toMatchObject({ type: "session.deleted" });
    expect(client.getStatus()).toMatchObject({ state: "connected", permission: "view" });
    await vi.waitFor(() => expect(resyncs).toBe(1));
    const streamCall = calls.find((call) => call.url.includes(REMOTE_API.events));
    expect(streamCall?.url).not.toContain("?since=");
    client.dispose();
  });

  it("resumes from the last sequence it actually saw", async () => {
    const urls: string[] = [];
    const { fetchImpl } = recorder((call) => {
      if (call.url.includes(REMOTE_API.events)) {
        urls.push(call.url);
        const frame = `event: agent\ndata: ${JSON.stringify({ seq: 4, event: { type: "session.deleted", sessionId: "s-1" } })}\n\n`;
        // The host closes the first stream (laptop slept, network switched); the
        // client must come back asking for what it missed.
        return urls.length === 1
          ? streamResponse([frame])
          : streamResponse([frame], { keepOpen: true });
      }
      if (call.url.includes(REMOTE_API.state)) return jsonResponse(200, snapshotBody);
      return undefined;
    });
    const client = new RemoteClient({
      baseUrl: "https://host",
      storage: memoryStorage(TOKEN),
      fetchImpl,
      reconnect: { minDelayMs: 1, maxDelayMs: 2, jitter: () => 0 },
    });
    client.startRealtime();
    await vi.waitFor(() => expect(urls).toHaveLength(1));
    // The first stream ends, the client reconnects with the sequence it reached.
    await vi.waitFor(() => expect(urls).toHaveLength(2), { timeout: 2000 });
    expect(urls[1]).toContain("since=4");
    client.dispose();
  });

  it("resumes from sequence zero instead of dropping the first events", async () => {
    const urls: string[] = [];
    const { fetchImpl } = recorder((call) => {
      if (call.url.includes(REMOTE_API.events)) {
        urls.push(call.url);
        const frame = `event: agent\ndata: ${JSON.stringify({
          seq: 0,
          event: { type: "session.deleted", sessionId: "s-0" },
        })}\n\n`;
        return urls.length === 1
          ? streamResponse([frame])
          : streamResponse([frame], { keepOpen: true });
      }
      if (call.url.includes(REMOTE_API.state)) return jsonResponse(200, snapshotBody);
      return undefined;
    });
    const client = new RemoteClient({
      baseUrl: "https://host",
      storage: memoryStorage(TOKEN),
      fetchImpl,
      reconnect: { minDelayMs: 1, maxDelayMs: 2, jitter: () => 0 },
    });
    client.startRealtime();
    await vi.waitFor(() => expect(urls).toHaveLength(2), { timeout: 2000 });
    expect(urls[0]).not.toContain("?since=");
    expect(urls[1]).toContain("since=0");
    client.dispose();
  });

  it("adopts a restarted host's sequence instead of keeping the old cursor", async () => {
    const urls: string[] = [];
    let resyncs = 0;
    const { fetchImpl } = recorder((call) => {
      if (call.url.includes(REMOTE_API.events)) {
        urls.push(call.url);
        if (urls.length === 1)
          return streamResponse([
            `event: hello\ndata: ${JSON.stringify({ seq: 5, instance: "old-host" })}\n\n`,
            `event: agent\ndata: ${JSON.stringify({
              seq: 6,
              event: { type: "session.deleted", sessionId: "s-1" },
            })}\n\n`,
          ]);
        if (urls.length === 2)
          return streamResponse(
            [`event: hello\ndata: ${JSON.stringify({ seq: 0, instance: "new-host" })}\n\n`],
            { keepOpen: true },
          );
        return streamResponse([], { keepOpen: true });
      }
      if (call.url.includes(REMOTE_API.state)) return jsonResponse(200, snapshotBody);
      return undefined;
    });
    const client = new RemoteClient({
      baseUrl: "https://host",
      storage: memoryStorage(TOKEN),
      fetchImpl,
      onResync: () => {
        resyncs += 1;
      },
      reconnect: { minDelayMs: 1, maxDelayMs: 2, jitter: () => 0 },
    });
    client.startRealtime();
    await vi.waitFor(() => expect(urls).toHaveLength(2), { timeout: 2000 });
    expect(urls[1]).toContain("since=6");
    await vi.waitFor(() => expect(resyncs).toBe(1));
    // The old cursor (6) is gone: a reconnect now resumes from the new host's 0.
    await client.resume();
    await vi.waitFor(() => expect(urls).toHaveLength(3), { timeout: 2000 });
    expect(urls[2]).toContain("since=0");
    client.dispose();
  });

  it("stops reconnecting after the host says the device was revoked", async () => {
    let streamCalls = 0;
    const { fetchImpl } = recorder((call) => {
      if (call.url.includes(REMOTE_API.events)) {
        streamCalls += 1;
        return streamResponse(
          [`event: revoked\ndata: ${JSON.stringify({ seq: 2, revoked: true })}\n\n`],
          { keepOpen: true },
        );
      }
      if (call.url.includes(REMOTE_API.state)) return jsonResponse(200, snapshotBody);
      return undefined;
    });
    const storage = memoryStorage(TOKEN);
    const client = new RemoteClient({
      baseUrl: "https://host",
      storage,
      fetchImpl,
      reconnect: { minDelayMs: 1, maxDelayMs: 2, jitter: () => 0 },
    });
    client.startRealtime();
    await vi.waitFor(() => expect(client.getStatus().state).toBe("revoked"));
    expect(storage.value).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(streamCalls).toBe(1);
    client.dispose();
  });

  it("does not open a second stream when the old stream ends after resume", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    let streams = 0;
    const { fetchImpl } = recorder(async (call) => {
      if (call.url.includes(REMOTE_API.events)) {
        streams += 1;
        if (streams === 1) {
          await blocked;
          return streamResponse([]);
        }
        return streamResponse([], { keepOpen: true });
      }
      if (call.url.includes(REMOTE_API.state)) return jsonResponse(200, snapshotBody);
      return undefined;
    });
    const client = new RemoteClient({
      baseUrl: "https://host", storage: memoryStorage(TOKEN), fetchImpl,
      reconnect: { minDelayMs: 1, maxDelayMs: 2, jitter: () => 0 },
    });
    client.startRealtime();
    await vi.waitFor(() => expect(streams).toBe(1));
    await client.resume();
    await vi.waitFor(() => expect(streams).toBe(2));
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(streams).toBe(2);
    client.dispose();
  });

  it("closes the previous stream and reconnects after forget and pair", async () => {
    let oldCancelled = false;
    const newToken = "n".repeat(43);
    let streams = 0;
    const { fetchImpl, calls } = recorder((call) => {
      if (call.url.includes(REMOTE_API.events)) {
        streams += 1;
        const hello = `event: hello\ndata: ${JSON.stringify({
          seq: 1,
          device: { id: "d-1", name: "iPhone", permission: "control" },
        })}\n\n`;
        if (streams > 1) return streamResponse([hello], { keepOpen: true });
        const encoder = new TextEncoder();
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(hello));
          },
          cancel() {
            oldCancelled = true;
          },
        });
        return new Response(body, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      if (call.url.endsWith(REMOTE_API.pair))
        return jsonResponse(200, {
          token: newToken,
          device: { id: "d-2", name: "New phone", permission: "control" },
        });
      if (call.url.endsWith(REMOTE_API.state)) return jsonResponse(200, snapshotBody);
      return undefined;
    });
    const client = new RemoteClient({
      baseUrl: "https://host",
      storage: memoryStorage(TOKEN),
      fetchImpl,
    });
    client.startRealtime();
    await vi.waitFor(() => expect(client.getStatus().state).toBe("connected"));
    client.forget();
    await client.pair("ABCD2345");
    client.startRealtime();
    await vi.waitFor(() =>
      expect(calls.filter((call) => call.url.includes(REMOTE_API.events))).toHaveLength(2),
    );
    const streamCalls = calls.filter((call) => call.url.includes(REMOTE_API.events));
    expect(oldCancelled).toBe(true);
    expect(streamCalls[1]?.headers.authorization).toBe(`Bearer ${newToken}`);
    expect(client.getStatus()).toMatchObject({ state: "connected", deviceName: "New phone" });
    client.dispose();
  });

  it("discards a snapshot that started under the previous credential", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { fetchImpl } = recorder(async (call) => {
      if (call.url.endsWith(REMOTE_API.state)) {
        await gate;
        return jsonResponse(200, snapshotBody);
      }
      return undefined;
    });
    const client = new RemoteClient({
      baseUrl: "https://host",
      storage: memoryStorage(TOKEN),
      fetchImpl,
    });
    const pending = client.snapshot().then(
      () => "applied",
      (error: unknown) => error,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    client.forget();
    release();
    const failure = await pending;
    expect(failure).toBeInstanceOf(RemoteRequestError);
    expect((failure as RemoteRequestError).code).toBe("stale-auth");
    // The late response did not overwrite the pairing state.
    expect(client.getStatus().state).toBe("pairing");
    client.dispose();
  });

  it("does not forget a newly paired token when an old stream is refused", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    const storage = memoryStorage(TOKEN);
    const replacement = "n".repeat(43);
    const { fetchImpl } = recorder(async (call) => {
      if (call.url.includes(REMOTE_API.events)) {
        await blocked;
        return jsonResponse(401, { error: { code: "unauthorized", message: "expired" } });
      }
      if (call.url.endsWith(REMOTE_API.pair))
        return jsonResponse(200, {
          token: replacement,
          device: { id: "d-2", name: "New phone", permission: "control" },
        });
      return undefined;
    });
    const client = new RemoteClient({ baseUrl: "https://host", storage, fetchImpl });
    client.startRealtime();
    await vi.waitFor(() => expect(storage.value).toBe(TOKEN));
    await client.pair("ABCD2345");
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(storage.value).toBe(replacement);
    expect(client.getStatus().state).toBe("connected");
    client.dispose();
  });
});

describe("token storage", () => {
  it("keeps the token out of any request URL", async () => {
    const { fetchImpl, calls } = recorder(() => jsonResponse(200, snapshotBody));
    const storage = memoryStorage(TOKEN);
    const client = new RemoteClient({ baseUrl: "https://host", storage, fetchImpl });
    await client.snapshot();
    for (const call of calls) expect(call.url).not.toContain(TOKEN);
    expect(TOKEN_STORAGE_KEY).toBe("gajae.remote.token");
    client.dispose();
  });
});

describe("tailnet identity access", () => {
  const snapshotBody = (via: "device" | "tailscale") => ({
    connection: { state: "connected", backend: "gjc", label: "GJC", workspace: "/tmp/ws" },
    sessions: [],
    device: {
      id: via === "tailscale" ? "tailscale:owner@example.com" : "d-1",
      name: via === "tailscale" ? "owner@example.com · Tailscale" : "iPhone",
      permission: "control",
      via,
    },
    server: { version: "0.1.0", time: new Date(0).toISOString(), workspace: "/tmp/ws", protocol: 1 },
  });

  it("connects with no token when Serve vouches for this device", async () => {
    const storage = memoryStorage(null);
    const { fetchImpl, calls } = recorder((call) => {
      if (call.url.includes(REMOTE_API.events))
        return new Response("event: hello\ndata: {}\n\n", {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      if (call.url.endsWith(REMOTE_API.state)) return jsonResponse(200, snapshotBody("tailscale"));
      return undefined;
    });
    const client = new RemoteClient({ baseUrl: "https://host", storage, fetchImpl });
    await client.snapshot();
    expect(client.getStatus()).toMatchObject({
      state: "connected",
      permission: "control",
      deviceName: "owner@example.com · Tailscale",
    });
    client.startRealtime();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const stream = calls.find((call) => call.url.includes(REMOTE_API.events));
    expect(stream).toBeDefined();
    expect(stream?.headers.authorization).toBeUndefined();
    expect(storage.value).toBeNull();
    client.dispose();
  });

  it("asks for pairing when a tokenless device is refused", async () => {
    const storage = memoryStorage(null);
    const { fetchImpl } = recorder(() =>
      jsonResponse(401, { error: { code: "unauthorized", message: "A device token is required" } }),
    );
    const client = new RemoteClient({ baseUrl: "https://host", storage, fetchImpl });
    await expect(client.snapshot()).rejects.toThrow(/연결되어 있지 않/u);
    expect(client.getStatus()).toMatchObject({ state: "pairing" });
    client.dispose();
  });
});

describe("pairing while a request is in flight", () => {
  it("keeps the token a late refusal would have dropped", async () => {
    // The app boots by asking for a snapshot with no token. A refusal that arrives
    // after the user's code landed is about the token the client no longer holds;
    // acting on it would undo the pairing and show the pairing screen again.
    const storage = memoryStorage(null);
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { fetchImpl } = recorder(async (call) => {
      if (call.url.endsWith(REMOTE_API.pair))
        return jsonResponse(200, {
          deviceId: "d-1",
          token: TOKEN,
          device: { id: "d-1", name: "iPhone", permission: "control", via: "device" },
          server: { version: "0.1.0", workspace: "/tmp/ws", protocol: 1 },
        });
      if (call.url.endsWith(REMOTE_API.state)) {
        await gate;
        return jsonResponse(401, {
          error: { code: "unauthorized", message: "A device token is required" },
        });
      }
      return undefined;
    });
    const client = new RemoteClient({ baseUrl: "https://host", storage, fetchImpl });
    const boot = client.snapshot().catch(() => undefined);
    await client.pair("ABCD2345");
    release();
    await boot;
    expect(client.getStatus()).toMatchObject({ state: "connected", permission: "control" });
    expect(storage.value).toBe(TOKEN);
    client.dispose();
  });
});
