import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PendingPermission, PermissionResponse } from "./gjc-sdk-model.js";
import { PermissionChannels } from "./gjc-sdk-permissions.js";

// A stand-in for `gjc sdk serve --stdio`: lists whatever STATE holds, and records
// every request frame.
const RELAY = `#!/usr/bin/env node
const fs = require("node:fs");
const send = (frame) => process.stdout.write(JSON.stringify(frame) + "\\n");
send({ type: "hello", protocolVersion: 3 });
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf("\\n")) >= 0) {
    const frame = JSON.parse(buffer.slice(0, i));
    buffer = buffer.slice(i + 1);
    if (frame.type === "hello") continue;
    fs.appendFileSync(process.env.RELAY_LOG, JSON.stringify(frame) + "\\n");
    const state = JSON.parse(fs.readFileSync(process.env.STATE, "utf8"));
    if (frame.type === "query_request")
      send({ type: "query_response", id: frame.id, ok: true, result: { sessionId: "s1", enabled: state.enabled, requests: state.requests } });
    else send({ type: "control_response", id: frame.id, ok: true, result: { accepted: true } });
  }
});
`;

const REQUEST = {
  id: "req-1",
  sessionId: "s1",
  toolCall: { toolCallId: "call-1", toolName: "bash", title: "rm -rf build", rawInput: { command: "rm -rf build" } },
  options: [
    { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
    { optionId: "reject_once", name: "Reject", kind: "reject_once" },
  ],
  expiresAt: "2026-11-04T00:00:00.000Z",
};

let directory: string;
let relay: string;
let log: string;
let state: string;
let channels: PermissionChannels | undefined;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "gajae-permission-relay-"));
  relay = path.join(directory, "gjc");
  log = path.join(directory, "frames.jsonl");
  state = path.join(directory, "state.json");
  await writeFile(relay, RELAY);
  await chmod(relay, 0o755);
  await writeFile(log, "");
  await setState({ enabled: true, requests: [] });
});

afterEach(async () => {
  channels?.dispose();
  channels = undefined;
  await rm(directory, { recursive: true, force: true });
});

const setState = (value: unknown) => writeFile(state, JSON.stringify(value));
const controls = async () =>
  (await readFile(log, "utf8")).split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as { type: string; operation?: string; input?: Record<string, unknown> })
    .filter((frame) => frame.type === "control_request");

function harness(active = true) {
  const asked: Array<{ request: PendingPermission["request"]; decide: (response: PermissionResponse) => void }> = [];
  const dropped: string[] = [];
  const host = {
    relayTransport: () => ({ executable: relay, env: { ...process.env, RELAY_LOG: log, STATE: state }, cwd: directory, timeoutMs: 5_000 }),
    sessionActive: vi.fn(() => active),
    requestPermission: (request: PendingPermission["request"]) =>
      new Promise<PermissionResponse>((decide) => asked.push({ request, decide })),
    dropPermission: (toolCallId: string) => dropped.push(toolCallId),
  };
  channels = new PermissionChannels(host, 20);
  return { channels, host, asked, dropped };
}

describe("GJC's approval channel", () => {
  it("shows a waiting tool call on its card and sends the decision, rejection comment included", async () => {
    await setState({ enabled: true, requests: [REQUEST] });
    const { channels, asked } = harness();
    channels.watch("s1");
    await vi.waitFor(() => expect(asked).toHaveLength(1));
    expect(asked[0]!.request).toEqual({
      sessionId: "s1",
      toolCall: { toolCallId: "call-1", title: "rm -rf build" },
      options: REQUEST.options,
    });

    asked[0]!.decide({ outcome: { outcome: "selected", optionId: "reject_once" }, comment: "Keep the build folder" });
    await vi.waitFor(async () =>
      expect((await controls()).map((frame) => frame.input)).toEqual([
        { sessionId: "s1", id: "req-1", optionId: "reject_once", comment: "Keep the build folder" },
      ]),
    );
    // Still listed until GJC settles it: asked once, not again.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(asked).toHaveLength(1);
  });

  it("lets go of a request GJC withdrew without answering it", async () => {
    await setState({ enabled: true, requests: [REQUEST] });
    const { channels, asked, dropped } = harness();
    channels.watch("s1");
    await vi.waitFor(() => expect(asked).toHaveLength(1));
    await setState({ enabled: true, requests: [] });
    await vi.waitFor(() => expect(dropped).toEqual(["call-1"]));
    asked[0]!.decide({ outcome: { outcome: "cancelled" } });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(await controls()).toEqual([]);
  });

  it("turns the channel back on for a host that restarted with it off", async () => {
    await setState({ enabled: false, requests: [] });
    const { channels } = harness();
    channels.watch("s1");
    await vi.waitFor(async () =>
      expect((await controls())[0]).toMatchObject({ operation: "permission.channel.set", input: { enabled: true } }),
    );
  });

  it("does not poll a session that is not running", async () => {
    await setState({ enabled: true, requests: [REQUEST] });
    const { channels, asked } = harness(false);
    channels.watch("s1");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(asked).toEqual([]);
    expect(await readFile(log, "utf8")).toBe("");
  });
});
