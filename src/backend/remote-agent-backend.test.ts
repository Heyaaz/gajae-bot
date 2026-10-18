import { describe, expect, it, vi } from "vitest";
import { REMOTE_API, type RemotePermission } from "../../shared/remote-protocol";
import { RemoteAgentBackend } from "./remote-agent-backend";
import { TOKEN_STORAGE_KEY } from "../remote/client";

const TOKEN = "t".repeat(43);

function streamResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

interface Call {
  url: string;
  method: string;
  body?: unknown;
}

function storage() {
  return {
    read: () => TOKEN,
    write: () => undefined,
    clear: () => undefined,
  };
}

function backend(
  respond: (call: Call) => Response | undefined,
  options: { permission?: RemotePermission } = {},
) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const call: Call = {
      url,
      method: init?.method ?? "GET",
      ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) as unknown } : {}),
    };
    calls.push(call);
    if (url === "/api/state" || url.endsWith(REMOTE_API.state)) {
      return new Response(
        JSON.stringify({
          connection: {
            state: "connected",
            backend: "gjc",
            label: "GJC",
            detail: "원격",
            workspace: "/tmp/ws",
          },
          sessions: [
            {
              id: "s-1",
              title: "세션",
              subtitle: "",
              workspace: "/tmp/ws",
              runtime: "gjc",
              status: "idle",
              updatedAt: new Date(0).toISOString(),
              pinned: false,
              unread: false,
              accent: "#fff",
              ownership: "gajae",
              attachment: "attached",
            },
          ],
          device: { id: "d-1", name: "iPhone", permission: options.permission ?? "control" },
          server: { version: "0.1.0", time: new Date(0).toISOString(), workspace: "/tmp/ws", protocol: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.includes(REMOTE_API.events)) {
      const custom = respond(call);
      if (custom) return custom;
      return new Response(new ReadableStream<Uint8Array>({ start: (controller) => controller.close() }), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }
    const response = respond(call);
    if (!response) throw new Error(`unexpected request: ${call.method} ${call.url}`);
    return response;
  }) as typeof fetch;
  const instance = new RemoteAgentBackend({
    baseUrl: "",
    storage: storage(),
    fetchImpl,
    reconnect: { minDelayMs: 2, maxDelayMs: 4, jitter: () => 0 },
  });
  return { instance, calls };
}

function completed(body: unknown): Response {
  return new Response(
    JSON.stringify({
      operationId: "op-test000001",
      state: "completed",
      result: body,
      at: new Date(0).toISOString(),
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

describe("remote agent backend", () => {
  it("reads the authoritative snapshot for connection and sessions", async () => {
    const { instance } = backend(() => undefined);
    await expect(instance.getConnection()).resolves.toMatchObject({ state: "connected", label: "GJC" });
    const sessions = await instance.listSessions();
    expect(sessions.map((session) => session.id)).toEqual(["s-1"]);
    instance.dispose();
  });

  it("reports the device permission so the shell can withhold control", async () => {
    const { instance } = backend(() => undefined, { permission: "view" });
    await instance.listSessions();
    await expect(instance.remoteAccess.getStatus()).resolves.toMatchObject({
      state: "connected",
      permission: "view",
    });
    instance.dispose();
  });

  it("sends a message through a control operation", async () => {
    const { instance, calls } = backend(() => completed("prompt"));
    await expect(
      instance.sendMessage("s-1", {
        text: "안녕",
        images: [{ id: "i1", name: "shot.png", mimeType: "image/png", data: "AAAA" }],
        files: [],
      }),
    ).resolves.toBe("prompt");
    const call = calls.find((value) => value.method === "POST");
    expect(call?.url).toBe(REMOTE_API.messages("s-1"));
    expect(call?.body).toMatchObject({ input: { text: "안녕" } });
    instance.dispose();
  });

  it("resolves a tool approval with the chosen option", async () => {
    const { instance, calls } = backend(() => completed(null));
    await instance.resolveToolCall("t-1", { optionId: "allow_once" });
    const call = calls.find((value) => value.method === "POST");
    expect(call?.url).toBe(REMOTE_API.toolCallDecision("t-1"));
    expect(call?.body).toMatchObject({ decision: { optionId: "allow_once" } });
    instance.dispose();
  });

  it("forwards runtime events to subscribers", async () => {
    const frame = `event: agent\ndata: ${JSON.stringify({
      seq: 1,
      event: { type: "session.deleted", sessionId: "s-1" },
    })}\n\n`;
    const { instance } = backend((call) =>
      call.url.includes(REMOTE_API.events) ? streamResponse([frame]) : undefined,
    );
    const received: string[] = [];
    const unsubscribe = instance.subscribe((event) => received.push(event.type));
    await vi.waitFor(() => expect(received).toEqual(["session.deleted"]));
    unsubscribe();
    instance.dispose();
  });

  it("replaces cached transcripts after an SSE replay gap", async () => {
    const gap = `event: resync\ndata: ${JSON.stringify({ seq: 9, resync: true, reason: "gap" })}\n\n`;
    const transcript = [{ id: "m-1", role: "assistant", content: "complete snapshot" }];
    const { instance, calls } = backend((call) => {
      if (call.url.includes(REMOTE_API.events)) return streamResponse([gap]);
      if (call.url.includes(REMOTE_API.transcript("s-1")))
        return new Response(JSON.stringify({ result: transcript }), { status: 200 });
      return undefined;
    });
    const synchronized: unknown[][] = [];
    instance.subscribe((event) => {
      if (event.type === "transcript.synced") synchronized.push(event.items);
    });
    await vi.waitFor(() => expect(synchronized).toEqual([transcript]));
    expect(calls.some((call) => call.url.includes(REMOTE_API.transcript("s-1")))).toBe(true);
    instance.dispose();
  });

  it("discards a replay repair that went stale while its transcript was read", async () => {
    const gap = `event: resync\ndata: ${JSON.stringify({ seq: 9, resync: true, reason: "gap" })}\n\n`;
    const encoder = new TextEncoder();
    let pushLive!: (chunk: string) => void;
    const live = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(gap));
          pushLive = (chunk) => controller.enqueue(encoder.encode(chunk));
        },
      }),
      { status: 200, headers: { "Content-Type": "text/event-stream" } },
    );
    let releaseTranscript!: (response: Response) => void;
    const pendingTranscript = new Promise<Response>((resolve) => {
      releaseTranscript = resolve;
    });
    const { instance, calls } = backend((call) => {
      if (call.url.includes(REMOTE_API.events)) return live;
      if (call.url.includes(REMOTE_API.transcript("s-1")))
        return pendingTranscript as unknown as Response;
      return undefined;
    });
    const received: string[] = [];
    instance.subscribe((event) => received.push(event.type));
    await vi.waitFor(() =>
      expect(
        calls.some((call) => call.url.includes(REMOTE_API.transcript("s-1"))),
      ).toBe(true),
    );
    pushLive(
      `event: agent\ndata: ${JSON.stringify({
        seq: 10,
        event: {
          type: "message.delta",
          sessionId: "s-1",
          messageId: "m-1",
          delta: "live",
          streaming: true,
        },
      })}\n\n`,
    );
    await vi.waitFor(() => expect(received).toContain("message.delta"));
    releaseTranscript(
      new Response(
        JSON.stringify({ result: [{ id: "m-1", role: "assistant", content: "stale" }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    // The live delta is newer than the read that started before it, so the cache
    // must keep the stream's content rather than replace it with the stale snapshot.
    expect(received).not.toContain("transcript.synced");
    instance.dispose();
  });

  it("retries a replay repair before giving up", async () => {
    const gap = `event: resync\ndata: ${JSON.stringify({ seq: 9, resync: true, reason: "gap" })}\n\n`;
    let transcripts = 0;
    const { instance } = backend((call) => {
      if (call.url.includes(REMOTE_API.events)) return streamResponse([gap]);
      if (call.url.includes(REMOTE_API.transcript("s-1"))) {
        transcripts += 1;
        if (transcripts === 1)
          return new Response(JSON.stringify({ error: { code: "unavailable" } }), { status: 502 });
        return new Response(JSON.stringify({ result: [{ id: "m-1", role: "assistant", content: "repaired" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return undefined;
    });
    const synchronized: unknown[][] = [];
    const connections: string[] = [];
    instance.subscribe((event) => {
      if (event.type === "transcript.synced") synchronized.push(event.items);
      if (event.type === "connection.updated") connections.push(event.connection.detail);
    });
    await vi.waitFor(() => expect(synchronized).toHaveLength(1), { timeout: 2000 });
    expect(transcripts).toBe(2);
    expect(connections).toEqual([]);
    instance.dispose();
  });

  it("reports an incomplete cache when the repair keeps failing", async () => {
    const gap = `event: resync\ndata: ${JSON.stringify({ seq: 9, resync: true, reason: "gap" })}\n\n`;
    const { instance } = backend((call) => {
      if (call.url.includes(REMOTE_API.events)) return streamResponse([gap]);
      if (call.url.includes(REMOTE_API.transcript("s-1")))
        return new Response(JSON.stringify({ error: { code: "unavailable" } }), { status: 502 });
      return undefined;
    });
    await instance.getConnection();
    const synchronized: unknown[] = [];
    const connections: Array<{ state: string; detail: string }> = [];
    instance.subscribe((event) => {
      if (event.type === "transcript.synced") synchronized.push(event);
      if (event.type === "connection.updated")
        connections.push({ state: event.connection.state, detail: event.connection.detail });
    });
    await vi.waitFor(
      () => expect(connections).toHaveLength(1),
      { timeout: 3000 },
    );
    expect(synchronized).toEqual([]);
    expect(connections[0]).toMatchObject({ state: "error" });
    expect(connections[0]?.detail).toContain("동기화에 실패");
    instance.dispose();
  });

  it("repairs again when another gap arrives during a repair", async () => {
    const gap = `event: resync\ndata: ${JSON.stringify({ seq: 9, resync: true, reason: "gap" })}\n\n`;
    const encoder = new TextEncoder();
    let pushGap!: () => void;
    const live = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(gap));
          pushGap = () => controller.enqueue(encoder.encode(gap));
        },
      }),
      { status: 200, headers: { "Content-Type": "text/event-stream" } },
    );
    let releaseFirst!: (response: Response) => void;
    const firstTranscript = new Promise<Response>((resolve) => {
      releaseFirst = resolve;
    });
    let transcripts = 0;
    const { instance } = backend((call) => {
      if (call.url.includes(REMOTE_API.events)) return live;
      if (call.url.includes(REMOTE_API.transcript("s-1"))) {
        transcripts += 1;
        if (transcripts === 1) return firstTranscript as unknown as Response;
        return new Response(JSON.stringify({ result: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return undefined;
    });
    const synchronized: unknown[] = [];
    instance.subscribe((event) => {
      if (event.type === "transcript.synced") synchronized.push(event);
    });
    await vi.waitFor(() => expect(transcripts).toBe(1));
    pushGap();
    await new Promise((resolve) => setTimeout(resolve, 20));
    releaseFirst(new Response(JSON.stringify({ result: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    await vi.waitFor(() => expect(transcripts).toBe(2), { timeout: 2000 });
    await vi.waitFor(() => expect(synchronized).toHaveLength(2), { timeout: 2000 });
    instance.dispose();
  });

  it("refuses desktop-only work with a reason instead of an empty success", async () => {
    const { instance, calls } = backend(() => undefined);
    const desktopOnly = [
      () => instance.createSession({ runtime: "gjc", workspace: "/tmp/ws", isolation: "workspace" }),
      () => instance.deleteSession("s-1"),
      () => instance.compactSession("s-1"),
      () => instance.commitChanges("s-1", "message"),
      () => instance.pushChanges("s-1"),
      () => instance.previewFile("s-1", "/tmp/ws/a.png"),
      () => instance.refreshRuntimeState("s-1"),
    ];
    for (const attempt of desktopOnly) await expect(attempt()).rejects.toThrow("데스크톱 앱");
    expect(calls.filter((call) => call.method === "POST")).toEqual([]);
    instance.dispose();
  });

  it("reports an unreachable host as a connection failure, not as fabricated data", async () => {
    const instance = new RemoteAgentBackend({
      baseUrl: "",
      storage: storage(),
      fetchImpl: (async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch,
      reconnect: { minDelayMs: 2, maxDelayMs: 4, jitter: () => 0 },
    });
    await expect(instance.getConnection()).rejects.toThrow("호스트에 연결할 수 없습니다");
    await expect(instance.listSessions()).rejects.toThrow("호스트에 연결할 수 없습니다");
    instance.dispose();
  });

  it("uses the documented storage key for the device token", () => {
    expect(TOKEN_STORAGE_KEY).toBe("gajae.remote.token");
  });
});
