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

function liveEventStream() {
  const encoder = new TextEncoder();
  let push!: (chunk: string) => void;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        push = (chunk) => controller.enqueue(encoder.encode(chunk));
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );
  return { response, push: (chunk: string) => push(chunk) };
}

interface Call {
  url: string;
  method: string;
  body?: unknown;
}

function snapshotCount(calls: readonly Call[]): number {
  return calls.filter((call) => call.url.endsWith(REMOTE_API.state)).length;
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
  options: { permission?: RemotePermission; sessionIds?: string[] } = {},
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
      const custom = respond(call);
      if (custom) return custom;
      return new Response(
        JSON.stringify({
          connection: {
            state: "connected",
            backend: "gjc",
            label: "GJC",
            detail: "원격",
            workspace: "/tmp/ws",
          },
          sessions: (options.sessionIds ?? ["s-1"]).map((id) => ({
            id,
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
          })),
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

  it("joins streaming deltas into one publish per frame", async () => {
    const frame = (delta: string, seq: number) =>
      `event: agent\ndata: ${JSON.stringify({
        seq,
        event: {
          type: "message.delta",
          sessionId: "s-1",
          messageId: "m-1",
          delta,
          streaming: true,
        },
      })}\n\n`;
    const { instance } = backend((call) =>
      call.url.includes(REMOTE_API.events)
        ? streamResponse([frame("one ", 1), frame("two", 2)])
        : undefined,
    );
    const deltas: string[] = [];
    instance.subscribe((event) => {
      if (event.type === "message.delta") deltas.push(event.delta);
    });
    await vi.waitFor(() => expect(deltas).toEqual(["one two"]));
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(deltas).toEqual(["one two"]);
    instance.dispose();
  });

  it("reads only changed transcript rows through the delta endpoint", async () => {
    const change = { kind: "patch" as const, items: [] };
    const { instance, calls } = backend((call) => {
      if (call.url === REMOTE_API.transcriptChanges("s-1"))
        return new Response(JSON.stringify({ result: change }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      return undefined;
    });
    await expect(instance.getTranscriptChanges("s-1")).resolves.toEqual(change);
    expect(calls.map((call) => call.url)).toContain(
      REMOTE_API.transcriptChanges("s-1"),
    );
    expect(calls.map((call) => call.url)).not.toContain(
      REMOTE_API.transcript("s-1"),
    );
    instance.dispose();
  });

  it("reads a transcript revision without the transcript body", async () => {
    const { instance, calls } = backend((call) => {
      if (call.url.endsWith("/transcript-revision"))
        return new Response(JSON.stringify({ result: "rev-9" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      return undefined;
    });
    await expect(instance.getTranscriptRevision("s-1")).resolves.toBe("rev-9");
    expect(calls.map((call) => call.url)).toContain(REMOTE_API.transcriptRevision("s-1"));
    expect(calls.map((call) => call.url)).not.toContain(REMOTE_API.transcript("s-1"));
    instance.dispose();
  });

  it("invalidates only watched transcripts from the replay-gap snapshot", async () => {
    const gap = `event: resync\ndata: ${JSON.stringify({ seq: 9, resync: true, reason: "gap" })}\n\n`;
    const live = liveEventStream();
    const { instance, calls } = backend(
      (call) => call.url.includes(REMOTE_API.events) ? live.response : undefined,
      { sessionIds: ["s-1", "s-2", "s-3"] },
    );
    await instance.getConnection();
    const snapshotBaseline = snapshotCount(calls);
    instance.watchTranscripts(["s-2"]);
    const received: unknown[] = [];
    instance.subscribe((event) => received.push(event));

    live.push(gap);
    await vi.waitFor(() =>
      expect(received).toEqual([
        { type: "transcript.invalidated", sessionId: "s-2" },
      ]),
    );

    const urls = calls.map((call) => call.url);
    expect(snapshotCount(calls) - snapshotBaseline).toBe(1);
    expect(urls.filter((url) => url.includes("/transcript"))).toEqual([]);
    instance.dispose();
  });

  it("retries a failed replay-gap snapshot before invalidating", async () => {
    const gap = `event: resync\ndata: ${JSON.stringify({ seq: 9, resync: true, reason: "gap" })}\n\n`;
    const live = liveEventStream();
    let replayStarted = false;
    let replaySnapshots = 0;
    const { instance, calls } = backend((call) => {
      if (call.url.includes(REMOTE_API.events)) return live.response;
      if (call.url.endsWith(REMOTE_API.state)) {
        if (replayStarted && ++replaySnapshots === 1)
          return new Response(JSON.stringify({ error: { code: "unavailable" } }), { status: 502 });
      }
      return undefined;
    });
    await instance.getConnection();
    const snapshotBaseline = snapshotCount(calls);
    replayStarted = true;
    instance.watchTranscripts(["s-1"]);
    const invalidated: string[] = [];
    const failures: unknown[] = [];
    instance.subscribe((event) => {
      if (event.type === "transcript.invalidated") invalidated.push(event.sessionId);
      if (event.type === "connection.updated" && event.connection.state === "error")
        failures.push(event);
    });

    live.push(gap);
    await vi.waitFor(() => expect(invalidated).toEqual(["s-1"]), { timeout: 2000 });
    expect(snapshotCount(calls) - snapshotBaseline).toBe(2);
    expect(failures).toEqual([]);
    expect(calls.map((call) => call.url).filter((url) => url.includes("/transcript"))).toEqual([]);
    instance.dispose();
  });

  it("takes another snapshot when a replay gap arrives during repair", async () => {
    const gap = `event: resync\ndata: ${JSON.stringify({ seq: 9, resync: true, reason: "gap" })}\n\n`;
    const live = liveEventStream();
    let releaseSnapshot!: (response: Response) => void;
    const pendingSnapshot = new Promise<Response>((resolve) => {
      releaseSnapshot = resolve;
    });
    let replayStarted = false;
    let replaySnapshots = 0;
    const { instance, calls } = backend((call) => {
      if (call.url.includes(REMOTE_API.events)) return live.response;
      if (call.url.endsWith(REMOTE_API.state)) {
        if (replayStarted && ++replaySnapshots === 1)
          return pendingSnapshot as unknown as Response;
      }
      return undefined;
    });
    await instance.getConnection();
    const snapshotBaseline = snapshotCount(calls);
    replayStarted = true;
    instance.watchTranscripts(["s-1"]);
    const invalidated: string[] = [];
    instance.subscribe((event) => {
      if (event.type === "transcript.invalidated") invalidated.push(event.sessionId);
    });

    live.push(gap);
    await vi.waitFor(() => expect(snapshotCount(calls) - snapshotBaseline).toBe(1));
    live.push(gap);
    releaseSnapshot(
      new Response(
        JSON.stringify({
          connection: {
            state: "connected",
            backend: "gjc",
            label: "GJC",
            detail: "원격",
            workspace: "/tmp/ws",
          },
          sessions: [{ id: "s-1", title: "세션" }],
          device: { id: "d-1", name: "iPhone", permission: "control" },
          server: { version: "0.1.0", time: new Date(0).toISOString(), workspace: "/tmp/ws", protocol: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    await vi.waitFor(() => expect(invalidated).toEqual(["s-1", "s-1"]), { timeout: 2000 });
    expect(snapshotCount(calls) - snapshotBaseline).toBe(2);
    expect(calls.map((call) => call.url).filter((url) => url.includes("/transcript"))).toEqual([]);
    instance.dispose();
  });

  it("reports an incomplete cache after every replay-gap snapshot fails", async () => {
    const gap = `event: resync\ndata: ${JSON.stringify({ seq: 9, resync: true, reason: "gap" })}\n\n`;
    const live = liveEventStream();
    let replayStarted = false;
    const { instance, calls } = backend((call) => {
      if (call.url.includes(REMOTE_API.events)) return live.response;
      if (call.url.endsWith(REMOTE_API.state) && replayStarted)
        return new Response(JSON.stringify({ error: { code: "unavailable" } }), { status: 502 });
      return undefined;
    });
    await instance.getConnection();
    const snapshotBaseline = snapshotCount(calls);
    replayStarted = true;
    instance.watchTranscripts(["s-1"]);
    const invalidated: string[] = [];
    const connections: Array<{ state: string; detail: string }> = [];
    instance.subscribe((event) => {
      if (event.type === "transcript.invalidated") invalidated.push(event.sessionId);
      if (event.type === "connection.updated")
        connections.push({ state: event.connection.state, detail: event.connection.detail });
    });

    live.push(gap);
    await vi.waitFor(() => expect(connections).toHaveLength(1), { timeout: 3000 });
    expect(invalidated).toEqual([]);
    expect(connections[0]).toMatchObject({ state: "error" });
    expect(connections[0]?.detail).toContain("동기화에 실패");
    expect(snapshotCount(calls) - snapshotBaseline).toBe(3);
    expect(calls.map((call) => call.url).filter((url) => url.includes("/transcript"))).toEqual([]);
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
