import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import ts from "typescript";
import type { AgentEvent } from "../shared/agent-contract.js";
import { GJC_IPC } from "../shared/gjc-ipc.js";

type IpcInvoke = (channel: string, ...args: unknown[]) => Promise<unknown>;

type StreamController = ReadableStreamDefaultController<Uint8Array>;

function createHarness(invoke: IpcInvoke, fetchMock: typeof fetch) {
  const exposed: Record<string, unknown> = {};
  const ipcRenderer = {
    invoke,
    on: vi.fn(),
    removeListener: vi.fn(),
  };
  const modules: Record<string, unknown> = {
    electron: {
      contextBridge: {
        exposeInMainWorld: (name: string, value: unknown) => {
          exposed[name] = value;
        },
      },
      ipcRenderer,
      webUtils: { getPathForFile: () => "" },
    },
    "../shared/gjc-ipc.js": { GJC_IPC },
    "../shared/settings-ipc.js": {
      SETTINGS_IPC: {},
      DESKTOP_IPC: {},
    },
    "../shared/desktop-services-ipc.js": { DESKTOP_SERVICES_IPC: { management: {} } },
    "../shared/productivity-ipc.js": { PRODUCTIVITY_IPC: {} },
    "../shared/automation-ipc.js": { AUTOMATION_IPC: {} },
    "../shared/repo-ipc.js": { REPO_IPC: {} },
    "../shared/remote-ipc.js": { REMOTE_IPC: {} },
  };
  const source = readFileSync(new URL("./preload.ts", import.meta.url), "utf8");
  const javascript = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  runInNewContext(javascript, {
    exports: {},
    AbortController,
    Buffer,
    console,
    fetch: fetchMock,
    process: { platform: "darwin", versions: { chrome: "test", electron: "test" } },
    require: (id: string) => {
      if (!(id in modules)) throw new Error(`Unexpected preload dependency: ${id}`);
      return modules[id];
    },
    setTimeout,
    TextDecoder,
  });
  return exposed.agentControlDesktop as {
    gjc: { onEvent: (listener: (event: AgentEvent) => void) => () => void };
  };
}

function responseStream(): { body: ReadableStream<Uint8Array>; controller: StreamController } {
  let controller!: StreamController;
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
  });
  return { body, controller };
}

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

async function settle(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return;
    await settle();
  }
  throw new Error("Timed out waiting for preload event-stream behavior");
}

describe("preload SSE event handling", () => {
  it("discards a truncated frame when reconnecting", async () => {
    vi.useFakeTimers();
    const first = responseStream();
    const second = responseStream();
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce({ ok: true, status: 200, body: first.body } as Response)
      .mockResolvedValue({ ok: true, status: 200, body: second.body } as Response);
    const invoke = vi.fn(async (channel: string) => {
      if (channel === GJC_IPC.eventStream) return { port: 4321, token: "secret", seq: 0 };
      throw new Error(`Unexpected IPC: ${channel}`);
    });
    const bridge = createHarness(invoke, fetchMock);
    const received: AgentEvent[] = [];
    const unsubscribe = bridge.gjc.onEvent((event) => received.push(event));
    await waitFor(() => fetchMock.mock.calls.length === 1);
    first.controller.enqueue(bytes('id: 8\ndata: {"type":"session.deleted","sessionId":"'));
    first.controller.close();
    await vi.advanceTimersByTimeAsync(1000);
    await waitFor(() => fetchMock.mock.calls.length === 2);

    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("since=0");
    second.controller.enqueue(bytes('x"}\n\n'));
    await settle();
    expect(received).toEqual([]);

    second.controller.enqueue(bytes('id: 1\ndata: {"type":"session.deleted","sessionId":"fresh"}\n\n'));
    await waitFor(() => received.length === 1);
    expect(received).toEqual([{ type: "session.deleted", sessionId: "fresh" }]);
    unsubscribe();
    second.controller.close();
    vi.useRealTimers();
  });

});
