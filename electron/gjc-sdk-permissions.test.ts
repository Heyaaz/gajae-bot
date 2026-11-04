import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandRuleMatch } from "../shared/command-rules.js";
import { CommandRuleStore } from "./command-rule-store.js";
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
    else if (state.refuse && frame.operation === "permission.respond")
      send({ type: "control_response", id: frame.id, ok: false, error: { code: "request_expired", message: "expired" } });
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

// Each poll talks to a spawned relay; a loaded test run needs more than the 1 s default.
const WAIT = { timeout: 10_000 };
const setState = (value: unknown) => writeFile(state, JSON.stringify(value));
const controls = async () =>
  (await readFile(log, "utf8")).split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as { type: string; operation?: string; input?: Record<string, unknown> })
    .filter((frame) => frame.type === "control_request");

function harness(active = true, autoDecide: PermissionChannelHostLike["autoDecide"] = async () => undefined) {
  const asked: Array<{ request: PendingPermission["request"]; decide: (response: PermissionResponse) => void }> = [];
  const dropped: string[] = [];
  const noted: Array<{ toolCallId: string; match: CommandRuleMatch }> = [];
  const host = {
    relayTransport: () => ({ executable: relay, env: { ...process.env, RELAY_LOG: log, STATE: state }, cwd: directory, timeoutMs: 5_000 }),
    sessionActive: vi.fn(() => active),
    requestPermission: (request: PendingPermission["request"]) =>
      new Promise<PermissionResponse>((decide) => asked.push({ request, decide })),
    dropPermission: (toolCallId: string) => dropped.push(toolCallId),
    autoDecide,
    noteAutoDecision: (_sessionId: string, toolCall: { toolCallId: string }, match: CommandRuleMatch) =>
      noted.push({ toolCallId: toolCall.toolCallId, match }),
  };
  channels = new PermissionChannels(host, 20);
  return { channels, host, asked, dropped, noted };
}

type PermissionChannelHostLike = ConstructorParameters<typeof PermissionChannels>[0];

describe("GJC's approval channel", () => {
  it("shows a waiting tool call on its card and sends the decision, rejection comment included", async () => {
    await setState({ enabled: true, requests: [REQUEST] });
    const { channels, asked } = harness();
    channels.watch("s1");
    await vi.waitFor(() => expect(asked).toHaveLength(1), WAIT);
    expect(asked[0]!.request).toEqual({
      sessionId: "s1",
      toolCall: { toolCallId: "call-1", title: "rm -rf build", toolName: "bash", command: "rm -rf build" },
      options: REQUEST.options,
    });

    asked[0]!.decide({ outcome: { outcome: "selected", optionId: "reject_once" }, comment: "Keep the build folder" });
    await vi.waitFor(async () =>
      expect((await controls()).map((frame) => frame.input)).toEqual([
        { sessionId: "s1", id: "req-1", optionId: "reject_once", comment: "Keep the build folder" },
      ]),
    WAIT);
    // Still listed until GJC settles it: asked once, not again.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(asked).toHaveLength(1);
  });

  it("lets go of a request GJC withdrew without answering it", async () => {
    await setState({ enabled: true, requests: [REQUEST] });
    const { channels, asked, dropped } = harness();
    channels.watch("s1");
    await vi.waitFor(() => expect(asked).toHaveLength(1), WAIT);
    await setState({ enabled: true, requests: [] });
    await vi.waitFor(() => expect(dropped).toEqual(["call-1"]), WAIT);
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
    WAIT);
  });

  it("does not poll a session that is not running", async () => {
    await setState({ enabled: true, requests: [REQUEST] });
    const { channels, asked } = harness(false);
    channels.watch("s1");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(asked).toEqual([]);
    expect(await readFile(log, "utf8")).toBe("");
  });

  it("lists a tool call without a bash command as a plain request", async () => {
    await setState({
      enabled: true,
      requests: [{ ...REQUEST, toolCall: { toolCallId: "call-2", toolName: "write", rawInput: { path: "a.txt" } } }],
    });
    const { channels, asked } = harness();
    channels.watch("s1");
    await vi.waitFor(() => expect(asked).toHaveLength(1), WAIT);
    expect(asked[0]!.request.toolCall).toEqual({ toolCallId: "call-2", toolName: "write" });
  });
});

describe("project command rules on the approval channel", () => {
  const withRules = async (...rules: Array<[string, "allow" | "reject"]>) => {
    const store = new CommandRuleStore(directory, async (projectPath) => projectPath);
    for (const [prefix, decision] of rules) await store.add("/repo", prefix, decision);
    return (_sessionId: string, toolCall: PendingPermission["request"]["toolCall"]) =>
      store.decide("/repo", toolCall.toolName ?? "", toolCall.command ?? "");
  };
  const requestFor = (command: string) => ({
    ...REQUEST,
    toolCall: { toolCallId: "call-1", toolName: "bash", title: command, rawInput: { command } },
  });

  it("allows a matching plain command once, without a card", async () => {
    await setState({ enabled: true, requests: [requestFor("git status --short")] });
    const { channels, asked, noted } = harness(true, await withRules(["git status", "allow"]));
    channels.watch("s1");
    await vi.waitFor(async () =>
      expect((await controls()).map((frame) => frame.input)).toEqual([
        { sessionId: "s1", id: "req-1", optionId: "allow_once" },
      ]),
    WAIT);
    expect(asked).toEqual([]);
    expect(noted).toEqual([{ toolCallId: "call-1", match: { decision: "allow", prefix: "git status" } }]);
  });

  it("shows the card for a chained command an allow rule would have matched", async () => {
    await setState({ enabled: true, requests: [requestFor("git status && rm -rf build")] });
    const { channels, asked, noted } = harness(true, await withRules(["git status", "allow"]));
    channels.watch("s1");
    await vi.waitFor(() => expect(asked).toHaveLength(1), WAIT);
    expect(await controls()).toEqual([]);
    expect(noted).toEqual([]);
  });

  it("rejects a matching command once with the rule in the comment", async () => {
    await setState({ enabled: true, requests: [requestFor("cd app && git push origin main")] });
    const { channels, asked, noted } = harness(true, await withRules(["git push", "reject"]));
    channels.watch("s1");
    await vi.waitFor(async () =>
      expect((await controls()).map((frame) => frame.input)).toEqual([
        { sessionId: "s1", id: "req-1", optionId: "reject_once", comment: '프로젝트 규칙 "git push"에 따라 거절했습니다' },
      ]),
    WAIT);
    expect(asked).toEqual([]);
    expect(noted).toEqual([{ toolCallId: "call-1", match: { decision: "reject", prefix: "git push" } }]);
  });

  it("shows the card when the rule lookup fails", async () => {
    await setState({ enabled: true, requests: [requestFor("git status")] });
    const { channels, asked, noted } = harness(true, async () => {
      throw new Error("no project");
    });
    channels.watch("s1");
    await vi.waitFor(() => expect(asked).toHaveLength(1), WAIT);
    expect(await controls()).toEqual([]);
    expect(noted).toEqual([]);
  });

  it("shows the card when GJC offers no once-only option for the decision", async () => {
    await setState({
      enabled: true,
      requests: [{ ...requestFor("git status"), options: [{ optionId: "allow_always", name: "Always", kind: "allow_always" }] }],
    });
    const { channels, asked } = harness(true, await withRules(["git status", "allow"]));
    channels.watch("s1");
    await vi.waitFor(() => expect(asked).toHaveLength(1), WAIT);
    expect(await controls()).toEqual([]);
  });

  it("shows the card when GJC refuses the automatic answer", async () => {
    await setState({ enabled: true, requests: [requestFor("git status")], refuse: true });
    const { channels, asked, noted } = harness(true, await withRules(["git status", "allow"]));
    channels.watch("s1");
    await vi.waitFor(() => expect(asked).toHaveLength(1), WAIT);
    expect(noted).toEqual([]);
  });
});
