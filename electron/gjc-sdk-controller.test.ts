import { describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, stat, writeFile, readFile, rm } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  GjcSdkController,
  COMMAND_REFRESH_RETRY_BASE_MS,
  LIVE_EVIDENCE_GRACE_MS,
  TAIL_WINDOW_MS,
  UNWATCHED_DETACH_GRACE_MS,
  TODO_EVENT_POLL_BASE_MS,
  busyPromptError,
  cancelledOperationError,
  gitBranchFromHeader,
  inferToolName,
  persistedTranscriptRunning,
  readTranscriptTail,
  sharedTranscriptItems,
  toolStatus,
  readableModelLabel,
  historySessionSummary,
  sessionCwdFromLines,
  parentSessionOf,
  todoSnapshotPhases,
} from "./gjc-sdk-controller.js";
import { GjcSdkCli, SdkCliError } from "./gjc-sdk-cli.js";
import { CliDeleteError } from "./gjc-cli-session-delete.js";
import { SessionMetadataStore } from "./session-metadata-store.js";
import { projectTranscriptItemForDelivery } from "./transcript-body-preview.js";
import {
  DEFAULT_MODEL_PRESET,
  TRANSCRIPT_BODY_ARTIFACT_PREFIX,
} from "../shared/agent-contract.js";
import type { ToolActivity, TranscriptItem } from "../shared/agent-contract.js";
const execFile = promisify(execFileCallback);

const session = (id = "s1", workspace = "/repo") => ({
  id, title: "Test", subtitle: "repo", workspace, runtime: "gjc", status: "idle",
  updatedAt: "now", pinned: false, unread: false, accent: "#ff8a34",
  ownership: "gajae", attachment: "attached",
});

function harness(options: Record<string, unknown> = {}) {
  const controller = new GjcSdkController({ workspace: "/repo", emit: vi.fn(), ...options } as never);
  const cli = {
    listSessions: vi.fn(async () => []), inspectSession: vi.fn(async () => ({ live: true, repo: "/repo" })),
    rawGlobal: vi.fn(async () => ({ ok: true })), rawControl: vi.fn(async () => ({ ok: true })),
    rawQuery: vi.fn(async () => ({ items: [] })), queryItems: vi.fn(async () => []),
    send: vi.fn(async () => ({ status: "accepted" })), promptStatus: vi.fn(async () => ({ status: "completed" })),
    tail: vi.fn(async () => ({ source: "offline", terminal: true, items: [] })),
    observeTools: vi.fn(async (_id: string, _emit: unknown, signal: AbortSignal) => {
      if (!signal.aborted) await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    }),
  };
  const internals = controller as any;
  internals.cli = cli; internals.startup = Promise.resolve(); internals.generation = 1;
  return { controller, cli, internals };
}

/**
 * Writes a session transcript into the agent directory the transcript locator and
 * `listHistorySessions` both scan.
 */
async function transcriptFile(
  root: string,
  id: string,
  rows: unknown[],
): Promise<void> {
  const directory = path.join(root, "sessions", "v2-bucket");
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, `2026-01-01T00-00-00-000Z_${id}.jsonl`),
    `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    "utf8",
  );
}

describe("runtime version probe", () => {
  it("reports the installed version on a connected runtime", async () => {
    const list = vi
      .spyOn(GjcSdkCli.prototype, "listSessions")
      .mockResolvedValue([]);
    const version = vi
      .spyOn(GjcSdkCli.prototype, "version")
      .mockResolvedValue("0.18.12");
    const controller = new GjcSdkController({
      workspace: "/repo",
      executable: "/bin/true",
      emit: vi.fn(),
    } as never);
    (controller as any).recoverOwnedSessions = vi.fn(async () => undefined);
    try {
      const connection = await controller.getConnection();
      expect(connection.state).toBe("connected");
      await vi.waitFor(async () => {
        expect((await controller.getConnection()).version).toBe("0.18.12");
      });
    } finally {
      controller.dispose();
      list.mockRestore();
      version.mockRestore();
    }
  });

  it("does not wait for --version before reporting the broker connected", async () => {
    let releaseVersion: (version: string) => void = () => undefined;
    const list = vi
      .spyOn(GjcSdkCli.prototype, "listSessions")
      .mockResolvedValue([]);
    const version = vi
      .spyOn(GjcSdkCli.prototype, "version")
      .mockImplementation(
        () => new Promise((resolve) => {
          releaseVersion = resolve;
        }),
      );
    const controller = new GjcSdkController({
      workspace: "/repo",
      executable: "/bin/true",
      emit: vi.fn(),
    } as never);
    (controller as any).recoverOwnedSessions = vi.fn(async () => undefined);
    try {
      const connection = await controller.getConnection();
      expect(connection.state).toBe("connected");
      expect(connection.version).toBeUndefined();
      expect(version).toHaveBeenCalledOnce();
      releaseVersion("0.18.12");
      await vi.waitFor(async () => {
        expect((await controller.getConnection()).version).toBe("0.18.12");
      });
    } finally {
      releaseVersion("0.18.12");
      controller.dispose();
      list.mockRestore();
      version.mockRestore();
    }
  });

  it("keeps the connection when the runtime cannot answer --version", async () => {
    const list = vi
      .spyOn(GjcSdkCli.prototype, "listSessions")
      .mockResolvedValue([]);
    const version = vi
      .spyOn(GjcSdkCli.prototype, "version")
      .mockRejectedValue(new Error("--version is unsupported"));
    const controller = new GjcSdkController({
      workspace: "/repo",
      executable: "/bin/true",
      emit: vi.fn(),
    } as never);
    (controller as any).recoverOwnedSessions = vi.fn(async () => undefined);
    try {
      const connection = await controller.getConnection();
      expect(connection.state).toBe("connected");
      expect(connection.version).toBeUndefined();
    } finally {
      controller.dispose();
      list.mockRestore();
      version.mockRestore();
    }
  });
});

describe("history opening with an unavailable endpoint", () => {
  it.each([true, false])("opens real saved history without rehosting the CLI when already listed=%s", async (listed) => {
    const root = await mkdtemp(path.join(tmpdir(), "gajae-history-open-"));
    const emit = vi.fn();
    const { controller, cli, internals } = harness({ emit });
    try {
      await transcriptFile(root, "s1", [
        { type: "session", id: "s1", cwd: "/repo", timestamp: "2026-01-01T00:00:00Z" },
        { type: "message", id: "saved", timestamp: "2026-01-01T00:00:01Z", message: { role: "user", content: [{ type: "text", text: "saved history" }] } },
      ]);
      const file = path.join(root, "sessions", "v2-bucket", "2026-01-01T00-00-00-000Z_s1.jsonl");
      await writeFile(file, `${await readFile(file, "utf8")}\n`);
      internals.locateSharedTranscriptFile = vi.fn(async () => file);
      internals.refreshSdkCommands = vi.fn(async () => undefined);
      internals.readTodoRecords = vi.fn(async () => undefined);
      internals.refreshSessionSettings = vi.fn(async () => undefined);
      if (listed) internals.sessions.set("s1", { ...session(), ownership: "external" });
      cli.queryItems.mockRejectedValue(new SdkCliError("endpoint_stale", "The SDK endpoint is stale or unavailable."));
      const opened = await controller.openHistorySession("s1");
      expect(opened).toMatchObject({ id: "s1", attachment: "terminal-only", ownership: "external" });
      expect(internals.attachedSessions.has("s1")).toBe(false);
      expect(cli.rawGlobal).not.toHaveBeenCalled();
      expect(cli.rawControl).not.toHaveBeenCalled();
      const invalidated = emit.mock.calls
        .map(([event]) => event)
        .filter((event) => event.type === "transcript.invalidated");
      expect(invalidated).toContainEqual({ type: "transcript.invalidated", sessionId: "s1" });
      const calls = cli.queryItems.mock.calls.length;
      const page = await controller.getTranscriptPage("s1");
      expect(page.items).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "message", role: "user", content: "saved history" }),
        expect.objectContaining({ kind: "notice", title: "기록 보기 전용 · 실행 연결 없음" }),
      ]));
      expect(cli.queryItems).toHaveBeenCalledTimes(calls);
      const refreshed = await controller.getTranscript("s1");
      expect(refreshed).toEqual(expect.arrayContaining([
        expect.objectContaining({ content: "saved history" }),
        expect.objectContaining({ id: "terminal-only-s1" }),
      ]));
      expect(cli.queryItems).toHaveBeenCalledTimes(calls);

      // Explicit recovery still works and removes the read-only warning.
      cli.queryItems.mockResolvedValue([]);
      internals.startTailFollower = vi.fn();
      const resumed = await controller.resumeSession("s1");
      expect(resumed.attachment).toBe("attached");
      expect((await controller.getTranscript("s1")).some((item) => item.id === "terminal-only-s1")).toBe(false);
    } finally {
      const writes = [...internals.artifactWrites.values()];
      controller.dispose();
      await Promise.allSettled(writes);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("shows a CLI that is still mid-turn as running and follows it to idle", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "gajae-history-running-"));
    const { controller, internals } = harness({ emit: vi.fn() });
    try {
      const user = { type: "message", id: "u1", timestamp: "2026-01-01T00:00:01Z", message: { role: "user", content: [{ type: "text", text: "work" }] } };
      const working = { type: "message", id: "a1", timestamp: "2026-01-01T00:00:02Z", message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "t1", name: "bash", arguments: {} }] } };
      await transcriptFile(root, "s1", [{ type: "session", id: "s1", cwd: "/repo", timestamp: "2026-01-01T00:00:00Z" }, user, working]);
      const file = path.join(root, "sessions", "v2-bucket", "2026-01-01T00-00-00-000Z_s1.jsonl");
      internals.locateSharedTranscriptFile = vi.fn(async () => file);
      internals.refreshSdkCommands = vi.fn(async () => undefined);
      internals.readTodoRecords = vi.fn(async () => undefined);
      internals.resumeSession = vi.fn(async () => { throw new SdkCliError("endpoint_stale", "unavailable"); });
      const opened = await controller.openHistorySession("s1");
      expect(opened).toMatchObject({ attachment: "terminal-only", status: "running" });
      expect(internals.sessions.get("s1").status).toBe("running");

      // The CLI finishes: the transcript gains the turn's end, and the row follows.
      const done = { type: "message", id: "a2", timestamp: "2026-01-01T00:00:03Z", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] } };
      await writeFile(file, [{ type: "session", id: "s1", cwd: "/repo", timestamp: "2026-01-01T00:00:00Z" }, user, working, { type: "message", id: "r1", timestamp: "2026-01-01T00:00:02.5Z", message: { role: "toolResult", toolCallId: "t1", content: [{ type: "text", text: "ok" }] } }, done].map((row) => JSON.stringify(row)).join("\n") + "\n");
      await internals.republishRunState("s1");
      expect(internals.sessions.get("s1").status).toBe("idle");
    } finally {
      const writes = [...internals.artifactWrites.values()];
      controller.dispose();
      await Promise.allSettled(writes);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("lifts a settled row when the transcript starts a turn nothing reported live", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "gajae-idle-lift-"));
    const { controller, internals } = harness({ emit: vi.fn() });
    try {
      const file = path.join(root, "s1.jsonl");
      const header = { type: "session", id: "s1", cwd: "/repo", timestamp: "2026-01-01T00:00:00Z" };
      const user = (id: string, text: string) => ({ type: "message", id, timestamp: "2026-01-01T00:00:01Z", message: { role: "user", content: [{ type: "text", text }] } });
      const toolUse = (id: string) => ({ type: "message", id, timestamp: "2026-01-01T00:00:02Z", message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: `t-${id}`, name: "bash", arguments: {} }] } });
      const toolResult = (id: string) => ({ type: "message", id, timestamp: "2026-01-01T00:00:03Z", message: { role: "toolResult", toolCallId: `t-${id}`, toolName: "bash", content: [{ type: "text", text: "ok" }] } });
      const done = { type: "message", id: "a0", timestamp: "2026-01-01T00:00:01Z", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] } };
      const write = (rows: unknown[]) => writeFile(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
      internals.locateSharedTranscriptFile = vi.fn(async () => file);
      internals.sessions.set("s1", { ...session(), status: "idle" });

      // A turn that died mid-tool without a stop row reads running, but it is the
      // snapshot the idle row already settled: rereading it does not revive the row.
      await write([header, user("u0", "old"), toolUse("a-dead")]);
      await internals.readPersistedTranscript("s1");
      await internals.readPersistedTranscript("s1");
      expect(internals.sessions.get("s1").status).toBe("idle");

      // The terminal starts a turn: new rows after the settle lift the row.
      await write([header, user("u0", "old"), toolUse("a-dead"), done, user("u1", "next"), toolUse("a1")]);
      await internals.readPersistedTranscript("s1");
      expect(internals.sessions.get("s1").status).toBe("running");

      // The same holds while this window's own prompt is still awaiting its record:
      // that prompt owns the status, but not a turn it cannot see.
      internals.updateSessionStatus("s1", "idle");
      internals.activePromptSessions.add("s1");
      await internals.readPersistedTranscript("s1");
      expect(internals.sessions.get("s1").status).toBe("idle");
      await write([header, user("u0", "old"), toolUse("a-dead"), done, user("u1", "next"), toolUse("a1"), toolResult("a1")]);
      await internals.readPersistedTranscript("s1");
      expect(internals.sessions.get("s1").status).toBe("running");
    } finally {
      const writes = [...internals.artifactWrites.values()];
      controller.dispose();
      await Promise.allSettled(writes);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not turn missing persisted history into an empty successful open", async () => {
    const { controller, internals } = harness();
    const failure = new SdkCliError("endpoint_stale", "unavailable");
    internals.sessions.set("s1", session());
    internals.resumeSession = vi.fn(async () => { throw failure; });
    internals.readPersistedTranscript = vi.fn(async () => undefined);
    await expect(controller.openHistorySession("s1")).rejects.toBe(failure);
    expect(internals.terminalOnlySessions.has("s1")).toBe(false);
    controller.dispose();
  });

  it("does not swallow permission errors or fabricate history", async () => {
    const { controller, internals } = harness();
    const failure = new SdkCliError("authorization_denied", "permission denied");
    internals.sessions.set("s1", session());
    internals.resumeSession = vi.fn(async () => { throw failure; });
    internals.readPersistedTranscript = vi.fn();
    await expect(controller.openHistorySession("s1")).rejects.toBe(failure);
    expect(internals.readPersistedTranscript).not.toHaveBeenCalled();
    controller.dispose();
  });

  it("reads a saved session's cwd from the file head", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "gajae-history-cwd-"));
    const { controller, cli, internals } = harness();
    try {
      const file = path.join(root, "s1.jsonl");
      const head = [
        JSON.stringify({ type: "session", id: "s1", cwd: "/head", timestamp: "2026-01-01T00:00:00Z" }),
        JSON.stringify({
          type: "message",
          id: "m",
          timestamp: "2026-01-01T00:00:01Z",
          message: { role: "user", content: [{ type: "text", text: "hello" }] },
        }),
      ].join("\n");
      await writeFile(file, `${head}\n${"x".repeat(128 * 1024)}\n${JSON.stringify({ type: "session", id: "s1", cwd: "/tail" })}\n`);
      internals.locateSharedTranscriptFile = vi.fn(async () => file);
      internals.refreshSdkCommands = vi.fn(async () => undefined);
      internals.readTodoRecords = vi.fn(async () => undefined);
      internals.refreshSessionSettings = vi.fn(async () => undefined);
      cli.queryItems.mockRejectedValue(new SdkCliError("endpoint_stale", "The SDK endpoint is stale or unavailable."));
      const opened = await controller.openHistorySession("s1");
      expect(opened.workspace).toBe("/head");
    } finally {
      const writes = [...internals.artifactWrites.values()];
      controller.dispose();
      await Promise.allSettled(writes);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("changes the transcript revision when memory moves and the file does not", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "gajae-revision-memory-"));
    const { controller, internals } = harness();
    try {
      const file = path.join(root, "s1.jsonl");
      await writeFile(file, `${JSON.stringify({ type: "session", id: "s1", cwd: "/repo" })}\n`);
      internals.locateSharedTranscriptFile = vi.fn(async () => file);
      const first = await controller.getTranscriptRevision("s1");
      internals.appendTranscript({
        id: "todo-1",
        kind: "system",
        sessionId: "s1",
        title: "Todos",
        content: "ship it",
        createdAt: "now",
      });
      const second = await controller.getTranscriptRevision("s1");
      expect(second).not.toBe(first);
      const fileHalf = (revision: string) => revision.split(":").slice(0, -2).join(":");
      expect(fileHalf(String(second))).toBe(fileHalf(String(first)));
    } finally {
      controller.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not resurrect a disposed controller after a delayed history read", async () => {
    const { controller, internals } = harness();
    internals.sessions.set("s1", session());
    internals.resumeSession = vi.fn(async () => { throw new SdkCliError("endpoint_stale", "unavailable"); });
    let release!: (items: unknown[]) => void;
    internals.readPersistedTranscript = vi.fn(() => new Promise((resolve) => { release = resolve; }));
    const opening = controller.openHistorySession("s1");
    await vi.waitFor(() => expect(internals.readPersistedTranscript).toHaveBeenCalled());
    controller.dispose();
    release([]);
    await expect(opening).rejects.toThrow("history opening was cancelled");
    expect(internals.sessions.has("s1")).toBe(false);
  });
});

describe("0.18.12 tool stream", () => {
  it("retains the app's confirmed cancellation notice across durable refresh", () => {
    const { controller, internals } = harness();
    try {
      internals.appendCancelledNotice("s1", false);
      const notice = internals.transcripts.get("s1")[0];
      internals.installTranscript("s1", []);
      expect(internals.transcripts.get("s1")).toEqual([notice]);
      internals.installTranscript("s1", []);
      expect(internals.transcripts.get("s1")).toHaveLength(1);
    } finally { controller.dispose(); }
  });

  it("does not resurrect a confirmed cancelled turn from its toolUse transcript", async () => {
    const { controller, cli, internals } = harness();
    try {
      internals.sessions.set("s1", session());
      internals.locallyAbortedSessions.add("s1");
      internals.locateSharedTranscriptFile = vi.fn(async () => undefined);
      internals.discoveredRunState = vi.fn(async () => "running");
      internals.sessionParentId = vi.fn(async () => undefined);
      cli.listSessions.mockResolvedValue([{ sessionId: "s1", live: true, deleted: false, repo: "/repo", endpointGeneration: 1 }] as never);
      expect((await controller.listSessions()).find((row) => row.id === "s1")?.status).toBe("idle");
    } finally { controller.dispose(); }
  });

  it("discovers new CLI sessions while an app prompt is still running", async () => {
    const { controller, cli, internals } = harness();
    try {
      internals.lastDiscovered = [session("old")];
      internals.activePromptSessions.add("old");
      internals.locateSharedTranscriptFile = vi.fn(async () => undefined);
      internals.discoveredRunState = vi.fn(async () => "idle");
      internals.sessionParentId = vi.fn(async () => undefined);
      cli.listSessions.mockResolvedValue([{ sessionId: "new-cli-session", live: true, deleted: false, repo: "/repo", endpointGeneration: 1 }] as never);
      expect((await controller.listSessions()).map((row) => row.id)).toContain("new-cli-session");
      expect(cli.listSessions).toHaveBeenCalledTimes(1);
    } finally { controller.dispose(); }
  });

  function streamHarness() {
    const result = harness();
    result.internals.persistArtifact = vi.fn(async () => undefined);
    result.internals.sessions.set("s1", session());
    const event = (kind: string, fields: Record<string, unknown> = {}) =>
      result.internals.projectToolStream("s1", kind, {
        event_type: kind,
        event: { type: kind, toolCallId: "t1", toolName: "bash", ...fields },
      });
    const tool = () => result.internals.transcripts.get("s1")?.find((row: any) => row.id === "t1");
    return { ...result, event, tool };
  }

  it("replaces cumulative snapshots, survives durable refresh and finalizes from end", () => {
    const { controller, internals, event, tool } = streamHarness();
    try {
      event("tool_execution_start", { args: { command: "echo line1; echo line2" } });
      event("tool_execution_update", { partialResult: { content: [{ type: "text", text: "line1\n" }] } });
      event("tool_execution_update", { partialResult: { content: [{ type: "text", text: "line1\nline2\n" }] } });
      expect(tool().output.match(/line1/g)).toHaveLength(1);
      expect(tool().output).toContain("앞부분이 생략될 수 있음");
      internals.installTranscript("s1", [{ ...tool(), output: undefined }]);
      expect(tool().output).toContain("line2");
      event("tool_execution_end", { result: { content: [{ type: "text", text: "FINAL" }] }, isError: false });
      expect(tool()).toMatchObject({ status: "completed", output: "FINAL" });
      event("tool_execution_update", { partialResult: { content: [{ type: "text", text: "STALE" }] } });
      expect(tool().output).toBe("FINAL");
      internals.installTranscript("s1", [{ ...tool(), status: "running", output: undefined }]);
      expect(tool()).toMatchObject({ status: "completed", output: "FINAL" });
      internals.installTranscript("s1", [{ ...tool(), status: "completed", output: "DURABLE" }]);
      expect(tool().output).toBe("DURABLE");
      expect(internals.toolSnapshots.get("s1").size).toBe(0);
    } finally { controller.dispose(); }
  });

  it("projects SDK turn_stream snapshots without duplication or terminal regression", () => {
    const { controller, internals } = streamHarness();
    const frame = (text: string, phase = "live", sessionId = "s1") =>
      internals.projectToolStream("s1", "turn_stream", { type: "turn_stream", sessionId, messageRef: "42", phase, text });
    try {
      frame("first");
      frame("first second");
      expect(internals.transcripts.get("s1")).toEqual([
        expect.objectContaining({ kind: "message", content: "first second", streaming: true }),
      ]);
      frame("final", "finalized");
      frame("stale");
      frame("wrong session", "finalized", "other");
      expect(internals.transcripts.get("s1")).toEqual([
        expect.objectContaining({ content: "final", streaming: false }),
      ]);
    } finally { controller.dispose(); }
  });

  it("does not append a finalized snapshot already published by the durable watcher", () => {
    const { controller, internals } = streamHarness();
    internals.transcripts.set("s1", [{ id: "shared-message-final", kind: "message", sessionId: "s1", role: "assistant", content: "one answer", createdAt: "now", streaming: false }]);
    try {
      internals.projectToolStream("s1", "turn_stream", { sessionId: "s1", messageRef: "42", phase: "finalized", text: "one answer" });
      expect(internals.transcripts.get("s1")).toHaveLength(1);
      expect(internals.transcripts.get("s1")[0].id).toBe("shared-message-final");
    } finally { controller.dispose(); }
  });

  it("renders native message_update thinking and text deltas while the turn runs", () => {
    const { controller, internals } = streamHarness();
    const delta = (type: string, text: string) => internals.projectToolStream("s1", "message_update", {
      event: { type: "message_update", message: { role: "assistant", content: [] }, assistantMessageEvent: { type, delta: text, contentIndex: 0 } },
    });
    try {
      delta("thinking_delta", "checking ");
      delta("thinking_delta", "runtime");
      delta("text_delta", "answer ");
      delta("text_delta", "arrived");
      expect(internals.transcripts.get("s1")).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "thought", content: "checking runtime", streaming: false }),
        expect.objectContaining({ kind: "message", role: "assistant", content: "answer arrived", streaming: true }),
      ]));
    } finally { controller.dispose(); }
  });

  it("accepts a late snapshot without start, tail replacement and empty error result", () => {
    const { controller, event, tool } = streamHarness();
    try {
      event("tool_execution_update", { partialResult: { content: [{ type: "text", text: "line1\nline2\n" }] } });
      event("tool_execution_update", { partialResult: { content: [{ type: "text", text: "line2\nline3\n" }] } });
      expect(tool().output).not.toContain("line1");
      event("tool_execution_end", { result: { content: [] }, isError: true });
      expect(tool()).toMatchObject({ status: "failed", output: "" });
    } finally { controller.dispose(); }
  });

  it("reconnects a failed relay and aborts the replacement on detach", async () => {
    vi.useFakeTimers();
    const { controller, cli, internals } = streamHarness();
    try {
      internals.attachedSessions.add("s1");
      cli.observeTools.mockRejectedValueOnce(new Error("relay exited"));
      internals.startToolObserver("s1");
      await vi.advanceTimersByTimeAsync(TAIL_WINDOW_MS);
      expect(cli.observeTools).toHaveBeenCalledTimes(2);
      const signal = cli.observeTools.mock.calls[1]![2];
      internals.stopTailFollower("s1");
      expect(signal.aborted).toBe(true);
      await vi.advanceTimersByTimeAsync(TAIL_WINDOW_MS * 2);
      expect(cli.observeTools).toHaveBeenCalledTimes(2);
    } finally { controller.dispose(); vi.useRealTimers(); }
  });
});

describe("0.18.12 lifecycle refusal", () => {
  it("admits newer external runtime work without reopening stale cancelled evidence", () => {
    const { controller, internals } = harness();
    internals.sessions.set("s1", session());
    internals.locallyAbortedSessions.add("s1");
    internals.cancellationWatermarks.set("s1", 2_000);
    const update = (at: number) => internals.patchSessionInfo("s1", {
      sessionUpdate: "session_info_update", updatedAt: new Date(at).toISOString(),
      _meta: { gjcPhase: "working", gjcRunning: true },
    });
    update(1_000);
    expect(internals.locallyAbortedSessions.has("s1")).toBe(true);
    expect(internals.sessions.get("s1").status).toBe("idle");
    update(3_000);
    expect(internals.locallyAbortedSessions.has("s1")).toBe(false);
    expect(internals.sessions.get("s1").status).toBe("running");
    controller.dispose();
  });

  it.each(["dispose", "generation", "deleted"])("does not resume after a delayed attachment becomes invalid: %s", async (cause) => {
    const { controller, cli, internals } = harness();
    let release!: (value: string) => void;
    const located = new Promise<string>((resolve) => { release = resolve; });
    internals.sessions.set("s1", session());
    cli.inspectSession.mockResolvedValue({ live: false, repo: "/repo" });
    internals.locateSharedTranscriptFile = vi.fn(() => located);
    const attaching = internals.ensureAttached("s1", false);
    await vi.waitFor(() => expect(internals.locateSharedTranscriptFile).toHaveBeenCalled());
    if (cause === "dispose") controller.dispose();
    else if (cause === "generation") internals.generation += 1;
    else internals.sessions.delete("s1");
    release("/repo/s1.jsonl");
    await expect(attaching).rejects.toThrow("attachment was cancelled");
    expect(cli.rawGlobal).not.toHaveBeenCalled();
    controller.dispose();
  });

  const legacyRefusal = () => new SdkCliError("operation_failed", "localized refusal", undefined,
    [{ code: "lifecycle_legacy_history_ambiguous" }], "unknown");

  it("preserves ambiguous legacy history when no transcript is left for the CLI to delete", async () => {
    const { controller, cli, internals } = harness();
    try {
      internals.sessions.set("s1", session());
      internals.locateSharedTranscriptFile = vi.fn(async () => undefined);
      internals.deleteThroughGjcCli = vi.fn();
      cli.listSessions.mockResolvedValue([{ sessionId: "s1", live: false, deleted: false, repo: "/repo" }] as never);
      cli.rawGlobal.mockRejectedValue(legacyRefusal());
      const remove = vi.spyOn(internals, "removeSessionArtifacts");
      await expect(controller.deleteSession("s1")).rejects.toThrow("lifecycle_legacy_history_ambiguous");
      expect(internals.sessions.get("s1").attachment).toBe("recovering");
      expect(remove).not.toHaveBeenCalled();
      expect(internals.deleteThroughGjcCli).not.toHaveBeenCalled();
      expect(cli.rawGlobal).toHaveBeenCalledExactlyOnceWith("session.delete",
        expect.objectContaining({ sessionId: "s1" }), expect.any(Object));
    } finally { controller.dispose(); }
  });

  it("deletes through GJC's /session delete when legacy history fences the broker", async () => {
    const { controller, cli, internals } = harness();
    try {
      internals.sessions.set("s1", session());
      internals.locateSharedTranscriptFile = vi.fn(async () => "/agent/sessions/x/s1.jsonl");
      internals.deleteThroughGjcCli = vi.fn(async () => undefined);
      cli.listSessions.mockResolvedValue([{ sessionId: "s1", live: false, deleted: false, repo: "/repo" }] as never);
      cli.rawGlobal.mockRejectedValue(legacyRefusal());
      await controller.deleteSession("s1");
      expect(internals.deleteThroughGjcCli).toHaveBeenCalledExactlyOnceWith("/repo", "/agent/sessions/x/s1.jsonl");
      expect(internals.sessions.has("s1")).toBe(false);
    } finally { controller.dispose(); }
  });

  it("sends the user to the terminal that holds a fenced session instead of resuming it", async () => {
    const { controller, cli, internals } = harness();
    try {
      internals.sessions.set("s1", session());
      internals.locateSharedTranscriptFile = vi.fn(async () => "/agent/sessions/x/s1.jsonl");
      internals.deleteThroughGjcCli = vi.fn();
      cli.listSessions.mockResolvedValue([{ sessionId: "s1", live: true, deleted: false, repo: "/repo" }] as never);
      cli.rawGlobal.mockRejectedValue(legacyRefusal());
      await expect(controller.deleteSession("s1")).rejects.toThrow(/그 터미널에서 \/session delete/u);
      expect(internals.deleteThroughGjcCli).not.toHaveBeenCalled();
      expect(internals.sessions.has("s1")).toBe(true);
    } finally { controller.dispose(); }
  });

  it("keeps the session recovering when the CLI deletion does not finish", async () => {
    const { controller, cli, internals } = harness();
    try {
      internals.sessions.set("s1", session());
      internals.locateSharedTranscriptFile = vi.fn(async () => "/agent/sessions/x/s1.jsonl");
      internals.deleteThroughGjcCli = vi.fn(async () => {
        throw new CliDeleteError("unexpected-dialog", "dialog");
      });
      cli.listSessions.mockResolvedValue([{ sessionId: "s1", live: false, deleted: false, repo: "/repo" }] as never);
      cli.rawGlobal.mockRejectedValue(legacyRefusal());
      const remove = vi.spyOn(internals, "removeSessionArtifacts");
      await expect(controller.deleteSession("s1")).rejects.toThrow(/예상하지 못한 확인 창/u);
      expect(internals.sessions.get("s1").attachment).toBe("recovering");
      expect(remove).not.toHaveBeenCalled();
    } finally { controller.dispose(); }
  });

  it("falls back to the CLI when an uncertain delete leaves the broker row in place", async () => {
    const { controller, cli, internals } = harness();
    try {
      internals.sessions.set("s1", session());
      internals.locateSharedTranscriptFile = vi.fn(async () => "/agent/sessions/x/s1.jsonl");
      internals.deleteThroughGjcCli = vi.fn(async () => undefined);
      cli.listSessions.mockResolvedValue([{ sessionId: "s1", live: false, deleted: false, repo: "/repo" }] as never);
      cli.rawGlobal.mockRejectedValue(new SdkCliError("terminal_uncertain", "retained artifacts require reconciliation"));
      await controller.deleteSession("s1");
      expect(internals.deleteThroughGjcCli).toHaveBeenCalledOnce();
      expect(internals.sessions.has("s1")).toBe(false);
    } finally { controller.dispose(); }
  });

  it("surfaces actionable input refusal while preserving the session for reconciliation", async () => {
    const { controller, cli, internals } = harness();
    try {
      internals.sessions.set("s1", session());
      internals.locateSharedTranscriptFile = vi.fn(async () => "/repo/s1.jsonl");
      cli.listSessions.mockResolvedValue([{ sessionId: "s1", live: false, deleted: false, repo: "/repo" }] as never);
      cli.rawGlobal.mockRejectedValue(new SdkCliError("operation_failed", "unknown outcome", undefined,
        [{ code: "lifecycle_input_refused" }], "unknown"));
      const remove = vi.spyOn(internals, "removeSessionArtifacts");
      await expect(controller.deleteSession("s1")).rejects.toThrow("lifecycle_input_refused");
      expect(internals.sessions.get("s1").attachment).toBe("recovering");
      expect(remove).not.toHaveBeenCalled();
      expect(cli.rawGlobal).toHaveBeenCalledTimes(1);
      expect(cli.listSessions).toHaveBeenCalledTimes(2);
    } finally { controller.dispose(); }
  });
});

describe("parentSessionOf", () => {
  const envelope = (row: unknown): string => JSON.stringify(row);

  it("reads the source session id a fork recorded in its envelope", () => {
    expect(
      parentSessionOf(
        envelope({
          type: "session",
          id: "child",
          parentSession: "01a13de2-ebf4-70a3-a72a-73e9cb2ce5dd",
        }),
        "child",
      ),
    ).toBe("01a13de2-ebf4-70a3-a72a-73e9cb2ce5dd");
  });

  it("reduces a source recorded as a session file path", () => {
    // GJC has paths that put the *file* here rather than the id, and its own parser
    // calls the field parentSessionPath for that reason.
    expect(
      parentSessionOf(
        envelope({
          type: "session",
          id: "child",
          parentSession:
            "/home/me/.gjc/agent/sessions/v2-scope/2026-10-15T04-47-24-148Z_01a13de2-ebf4-70a3-a72a-73e9cb2ce5dd.jsonl",
        }),
        "child",
      ),
    ).toBe("01a13de2-ebf4-70a3-a72a-73e9cb2ce5dd");
  });

  it("treats a self-reference, a blank value, and other records as no parent", () => {
    expect(
      parentSessionOf(
        envelope({ type: "session", id: "s1", parentSession: "s1" }),
        "s1",
      ),
    ).toBeUndefined();
    expect(
      parentSessionOf(
        envelope({ type: "session", id: "s1", parentSession: "   " }),
        "s1",
      ),
    ).toBeUndefined();
    expect(
      parentSessionOf(envelope({ type: "message", role: "user" }), "s1"),
    ).toBeUndefined();
    expect(parentSessionOf(undefined, "s1")).toBeUndefined();
    expect(parentSessionOf("{ torn line", "s1")).toBeUndefined();
  });
});

describe("listHistorySessions size", () => {
  it("lists every saved session past the old 250-session cap", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "history-many-"));
    const previous = process.env.GJC_CODING_AGENT_DIR;
    process.env.GJC_CODING_AGENT_DIR = root;
    const { controller } = harness();
    try {
      const total = 260;
      for (let index = 0; index < total; index += 1) {
        await transcriptFile(root, `many-${index}`, [
          { type: "session", cwd: "/repo" },
          {
            type: "message",
            message: {
              role: "user",
              content: [{ type: "text", text: `session ${index}` }],
            },
          },
        ]);
      }
      const sessions = await controller.listHistorySessions();
      expect(sessions).toHaveLength(total);
      expect(new Set(sessions.map((session) => session.id)).size).toBe(total);
      expect(sessions.map((session) => session.id)).toEqual(
        expect.arrayContaining(["many-0", `many-${total - 1}`]),
      );
    } finally {
      controller.dispose();
      if (previous === undefined) delete process.env.GJC_CODING_AGENT_DIR;
      else process.env.GJC_CODING_AGENT_DIR = previous;
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("listHistorySessions lineage", () => {
  it("marks a past session that was forked from another", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "history-fork-"));
    const previous = process.env.GJC_CODING_AGENT_DIR;
    process.env.GJC_CODING_AGENT_DIR = root;
    const { controller } = harness();
    try {
      await transcriptFile(root, "fork", [
        { type: "session", cwd: "/repo", parentSession: "source-session" },
        {
          type: "message",
          message: { role: "user", content: [{ type: "text", text: "포크된 세션" }] },
        },
      ]);
      await transcriptFile(root, "root", [
        { type: "session", cwd: "/repo" },
        {
          type: "message",
          message: { role: "user", content: [{ type: "text", text: "그냥 세션" }] },
        },
      ]);

      const sessions = await controller.listHistorySessions();
      expect(
        sessions
          .map((session) => `${session.id}=${session.parentId ?? "none"}`)
          .sort(),
      ).toEqual(["fork=source-session", "root=none"]);
    } finally {
      controller.dispose();
      if (previous === undefined) delete process.env.GJC_CODING_AGENT_DIR;
      else process.env.GJC_CODING_AGENT_DIR = previous;
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("protocol-neutral helpers", () => {
  it("classifies git headers and tools", () => {
    expect(gitBranchFromHeader("No commits yet on main")).toBe("main");
    expect(gitBranchFromHeader("HEAD (no branch)")).toBe("HEAD");
    expect(inferToolName({ sessionUpdate: "tool_call", title: "exec_command", toolCallId: "t" })).toBe("tool");
    expect(toolStatus("pending")).toBe("pending");
  });
  it("recognizes cancellation and busy errors", () => {
    expect(cancelledOperationError(new Error("Operation aborted"))).toBe(true);
    expect(busyPromptError(new Error("turn.prompt is unavailable while the agent is busy"))).toBe(true);
  });
  it("projects model labels and transcript run state", () => {
    expect(readableModelLabel("gpt-5-codex")).toContain("GPT");
    expect(persistedTranscriptRunning([{ type: "message", message: { role: "user" } }])).toBe(true);
    expect(historySessionSummary([JSON.stringify({ type: "message", message: { role: "user", content: "Hello" } })])?.title).toBe("Hello");
    expect(sessionCwdFromLines([
      JSON.stringify({ type: "session", cwd: "/head" }),
      JSON.stringify({ type: "session", cwd: "/tail" }),
    ])).toBe("/head");
  });
});

describe("GjcSdkController CLI seam", () => {
  it("reports the preset new sessions start from on the connection", async () => {
    // The composer and the settings dialog label themselves from this field, so a
    // connection that drops it silently shows the default preset instead.
    const { controller } = harness({ modelPreset: "codex-pro" });
    expect((await controller.getConnection()).modelPreset).toBe("codex-pro");
    const { controller: unconfigured } = harness();
    expect((await unconfigured.getConnection()).modelPreset).toBe(
      DEFAULT_MODEL_PRESET,
    );
  });

  it("creates through session.create and applies always-allow", async () => {
    const { controller, cli } = harness({ permissionHandling: "always-allow" });
    (cli.rawGlobal as any).mockImplementation(async (op: string) => op === "session.create" ? { sessionId: "new" } : { items: [] });
    const created = await controller.createSession({ runtime: "gjc", workspace: "/repo", title: "New" } as any);
    expect(created.id).toBe("new");
    expect(cli.rawGlobal).toHaveBeenCalledWith(
      "session.create",
      expect.objectContaining({ cwd: "/repo" }),
      expect.objectContaining({ repo: "/repo", idempotencyKey: expect.stringMatching(/^gajae-session-create-/) }),
    );
    expect(cli.rawControl).toHaveBeenCalledWith("new", "permission_mode.set", { mode: "always-allow" }, { repo: "/repo" });
  });

  it("fails closed when interactive permission prompts have no reverse channel", async () => {
    const { controller, cli } = harness({ permissionHandling: "prompt" });
    (cli.rawGlobal as any).mockImplementation(async (op: string) =>
      op === "session.create" ? { sessionId: "denied" } : {},
    );
    await controller.createSession({ runtime: "gjc", workspace: "/repo" } as any);
    expect(cli.rawControl).toHaveBeenCalledWith(
      "denied",
      "permission_mode.set",
      { mode: "deny" },
      { repo: "/repo" },
    );
  });

  it("leaves a created session recovering when permission policy cannot be confirmed", async () => {
    const { controller, cli, internals } = harness({ permissionHandling: "prompt" });
    (cli.rawGlobal as any).mockResolvedValue({ sessionId: "unsafe" });
    (cli.rawControl as any).mockRejectedValue(
      new SdkCliError("session_unavailable", "no Router attachment"),
    );
    await expect(
      controller.createSession({ runtime: "gjc", workspace: "/repo" } as any),
    ).rejects.toThrow("no Router attachment");
    expect(internals.sessions.get("unsafe")?.attachment).toBe("recovering");
    expect(internals.attachedSessions.has("unsafe")).toBe(false);
  });

  it("recovers a lifecycle-uncertain create from the broker list", async () => {
    const { controller, cli } = harness();
    cli.rawGlobal.mockImplementationOnce(async () => {
      throw new Error("terminal_uncertain");
    });
    // GJC's public row projection does not carry the caller's idempotency key.
    // The retained session is the new live one whose endpoint is fresher than
    // the request; the pre-existing row is older and must not be adopted.
    cli.listSessions.mockResolvedValueOnce([]).mockImplementation(async () => [
      { sessionId: "unrelated", live: true, deleted: false, endpointGeneration: 1, repo: "/repo", endpointMtimeMs: Date.now() - 60_000 },
      { sessionId: "recovered", live: true, deleted: false, endpointGeneration: 1, repo: "/repo", endpointMtimeMs: Date.now() },
    ] as never);
    const created = await controller.createSession({ runtime: "gjc", workspace: "/repo" } as any);
    expect(created.id).toBe("recovered");
  });

  it("does not adopt a new session whose endpoint predates the create", async () => {
    vi.useFakeTimers();
    const { controller, cli } = harness();
    try {
      cli.listSessions.mockResolvedValueOnce([]).mockResolvedValue([
        { sessionId: "old", live: true, deleted: false, endpointGeneration: 1, repo: "/repo", endpointMtimeMs: Date.now() - 60_000 },
      ] as never);
      cli.rawGlobal.mockRejectedValueOnce(new Error("terminal_uncertain"));
      const creation = expect(
        controller.createSession({ runtime: "gjc", workspace: "/repo" } as any),
      ).rejects.toThrow("reconciliation");
      await vi.runAllTimersAsync();
      await creation;
    } finally {
      controller.dispose();
      vi.useRealTimers();
    }
  });

  it("does not guess between two fresh sessions after an uncertain create", async () => {
    const { controller, cli } = harness();
    cli.listSessions.mockResolvedValueOnce([]).mockResolvedValue([
      { sessionId: "a", live: true, deleted: false, endpointGeneration: 1, repo: "/repo", endpointMtimeMs: Date.now() },
      { sessionId: "b", live: true, deleted: false, endpointGeneration: 1, repo: "/repo", endpointMtimeMs: Date.now() },
    ] as never);
    cli.rawGlobal.mockRejectedValueOnce(new Error("terminal_uncertain"));
    await expect(
      controller.createSession({ runtime: "gjc", workspace: "/repo" } as any),
    ).rejects.toThrow("reconciliation");
  });

  it("never adopts an uncorrelated create or fork from the same workspace", async () => {
    vi.useFakeTimers();
    const { controller, cli, internals } = harness();
    try {
      cli.listSessions.mockResolvedValueOnce([]).mockResolvedValue([{ sessionId: "unrelated", live: true, deleted: false, endpointGeneration: 1, repo: "/repo" }] as never);
      cli.rawGlobal.mockRejectedValueOnce(new Error("terminal_uncertain"));
      const creation = expect(controller.createSession({ runtime: "gjc", workspace: "/repo", isolation: "workspace" })).rejects.toThrow("reconciliation");
      await vi.runAllTimersAsync();
      await creation;
      const fork = internals.recoverForkedSession("/repo", new Set(), Date.now());
      await vi.runAllTimersAsync();
      expect(await fork).toBeUndefined();
      expect(internals.sessions.has("unrelated")).toBe(false);
      expect(cli.rawControl).not.toHaveBeenCalled();
    } finally { controller.dispose(); vi.useRealTimers(); }
  });

  it("sends with semantic send, fresh op ref, and status reconciliation", async () => {
    const { controller, cli, internals } = harness();
    internals.sessions.set("s1", session()); internals.sessionCwds.set("s1", "/repo");
    internals.transcripts.set("s1", []); internals.messageKeys.set("s1", new Map());
    internals.attachedSessions.add("s1");
    internals.awaitPromptSettlement = vi.fn(async () => undefined);
    await controller.sendMessage("s1", { text: "hello", images: [], files: [] });
    expect(cli.send).toHaveBeenCalledWith("s1", "hello", expect.objectContaining({ repo: "/repo", opRef: expect.any(String) }));
  });

  it("keeps an uncertain post-dispatch prompt running without retrying it", async () => {
    const { controller, cli, internals } = harness();
    internals.sessions.set("s1", session()); internals.sessionCwds.set("s1", "/repo");
    internals.transcripts.set("s1", []); internals.messageKeys.set("s1", new Map());
    internals.attachedSessions.add("s1");
    (cli.send as any).mockRejectedValue(
      new SdkCliError("uncertain_after_send", "outcome is uncertain after send"),
    );
    internals.awaitPromptSettlement = vi.fn(async () => "unknown");
    await expect(
      controller.sendMessage("s1", { text: "hello", images: [], files: [] }),
    ).resolves.toBe("prompt");
    expect(cli.send).toHaveBeenCalledTimes(1);
    expect(internals.sessions.get("s1")?.status).toBe("running");
  });

  it("returns a proved preflight rejection for the original prompt without replaying it", async () => {
    const { controller, cli, internals } = harness();
    internals.sessions.set("s1", session()); internals.sessionCwds.set("s1", "/repo");
    internals.transcripts.set("s1", []); internals.messageKeys.set("s1", new Map());
    internals.attachedSessions.add("s1");
    internals.awaitPromptSettlement = vi.fn(async () => ({
      kind: "not_executed",
      detail: "Prompt preflight was cancelled before execution.",
    }));
    internals.discoveredRunState = vi.fn(async () => "running");
    await expect(
      controller.sendMessage("s1", { text: "hello", images: [], files: [] }),
    ).resolves.toEqual({
      kind: "not_executed",
      detail: "Prompt preflight was cancelled before execution.",
    });
    expect(cli.send).toHaveBeenCalledTimes(1);
    expect(cli.rawControl).not.toHaveBeenCalledWith("s1", "turn.follow_up", expect.anything(), expect.anything());
    // The request is echoed once, not once per delivery.
    expect(internals.transcripts.get("s1").filter((item: any) => item.role === "user")).toHaveLength(1);
    expect(internals.discoveredRunState).toHaveBeenCalledWith("s1");
    expect(internals.sessions.get("s1")?.status).toBe("running");
  });

  it("preserves a typed prompt preflight rejection without falling back to a steer", async () => {
    const { controller, cli, internals } = harness();
    internals.sessions.set("s1", session());
    internals.sessionCwds.set("s1", "/repo");
    internals.ensureAttached = vi.fn(async () => undefined);
    internals.discoveredRunState = vi.fn(async () => "running");
    (cli.send as any).mockRejectedValue(
      new SdkCliError(
        "busy",
        "Prompt preflight was cancelled before execution.",
      ),
    );
    await expect(
      controller.sendMessage("s1", { text: "hello", images: [], files: [] }),
    ).resolves.toEqual({
      kind: "not_executed",
      detail: "Prompt preflight was cancelled before execution.",
    });
    expect(cli.send).toHaveBeenCalledTimes(1);
    expect(cli.rawControl).not.toHaveBeenCalled();
    expect(internals.sessions.get("s1")?.status).toBe("running");
  });

  it("does not claim a generic accepted-false steer receipt proves non-execution", async () => {
    const { controller, cli, internals } = harness();
    internals.sessions.set("s1", { ...session(), status: "running" });
    internals.sessionCwds.set("s1", "/repo");
    (cli.rawControl as any).mockResolvedValue({
      accepted: false,
      status: "rejected",
      error: { code: "busy", message: "The steering request was rejected." },
    });
    await expect(
      controller.sendMessage("s1", { text: "hello", images: [], files: [] }),
    ).rejects.toThrow("The steering request was rejected.");
    expect(cli.rawQuery).not.toHaveBeenCalled();
    expect(internals.sessions.get("s1")?.status).toBe("running");
  });

  it("maps an accepted-false steer receipt only with explicit preflight evidence", async () => {
    const { controller, cli, internals } = harness();
    internals.sessions.set("s1", { ...session(), status: "running" });
    internals.sessionCwds.set("s1", "/repo");
    (cli.rawControl as any).mockResolvedValue({
      accepted: false,
      status: "rejected",
      error: {
        code: "busy",
        message: "Prompt preflight was cancelled before execution.",
      },
    });
    await expect(
      controller.sendMessage("s1", { text: "hello", images: [], files: [] }),
    ).resolves.toEqual({
      kind: "not_executed",
      detail: "Prompt preflight was cancelled before execution.",
    });
    expect(internals.sessions.get("s1")?.status).toBe("running");
  });

  it("does not treat a generic rejected steer status as proof of non-execution", async () => {
    const { controller, cli, internals } = harness();
    internals.sessions.set("s1", { ...session(), status: "running" });
    internals.sessionCwds.set("s1", "/repo");
    (cli.rawControl as any).mockResolvedValue({ accepted: true });
    (cli.rawQuery as any).mockResolvedValue({
      result: {
        status: "rejected",
        error: { code: "agent_error", message: "Steer delivery failed." },
      },
    });
    await expect(
      controller.sendMessage("s1", { text: "hello", images: [], files: [] }),
    ).rejects.toThrow("Steer delivery failed.");
    expect(internals.sessions.get("s1")?.status).toBe("running");
  });

  it("maps only the typed preflight-cancelled steer refusal to not-executed", async () => {
    const { controller, cli, internals } = harness();
    internals.sessions.set("s1", { ...session(), status: "running" });
    internals.sessionCwds.set("s1", "/repo");
    (cli.rawControl as any).mockRejectedValue(
      new SdkCliError(
        "busy",
        "Prompt preflight was cancelled before execution.",
      ),
    );
    await expect(
      controller.sendMessage("s1", { text: "same text", images: [], files: [] }),
    ).resolves.toEqual({
      kind: "not_executed",
      detail: "Prompt preflight was cancelled before execution.",
    });
    expect(cli.rawControl).toHaveBeenCalledWith(
      "s1",
      "turn.steer",
      expect.objectContaining({ text: "same text", clientRef: expect.any(String) }),
      expect.anything(),
    );
    expect(cli.rawQuery).not.toHaveBeenCalled();
    expect(internals.sessions.get("s1")?.status).toBe("running");
  });

  it("correlates identical steer text only by each request's clientRef", async () => {
    const { controller, cli, internals } = harness();
    internals.sessions.set("s1", { ...session(), status: "running" });
    internals.sessionCwds.set("s1", "/repo");
    const refs: string[] = [];
    (cli.rawControl as any).mockImplementation(
      async (_sessionId: string, _operation: string, input: { clientRef: string }) => {
        refs.push(input.clientRef);
        return { accepted: true, clientRef: input.clientRef };
      },
    );
    (cli.rawQuery as any).mockImplementation(
      async (_sessionId: string, query: string, input: { clientRef: string }) => ({
        result:
          query === "turn.steer_status" && input.clientRef === refs[0]
            ? {
                status: "rejected",
                error: {
                  code: "busy",
                  message: "Prompt preflight was cancelled before execution.",
                },
              }
            : { status: "accepted" },
      }),
    );
    const input = { text: "duplicate text", images: [], files: [] };
    const outcomes = await Promise.all([
      controller.sendMessage("s1", input),
      controller.sendMessage("s1", input),
    ]);
    expect(refs).toHaveLength(2);
    expect(refs[0]).not.toBe(refs[1]);
    expect(outcomes).toEqual([
      {
        kind: "not_executed",
        detail: "Prompt preflight was cancelled before execution.",
      },
      "steer",
    ]);
    expect(cli.rawQuery).toHaveBeenCalledWith(
      "s1",
      "turn.steer_status",
      { clientRef: refs[0] },
      expect.anything(),
    );
    expect(cli.rawQuery).toHaveBeenCalledWith(
      "s1",
      "turn.steer_status",
      { clientRef: refs[1] },
      expect.anything(),
    );
  });

  it("reconciles an accepted follow-up by its returned command and turn IDs", async () => {
    const { controller, cli, internals } = harness();
    internals.ensureAttached = vi.fn(async () => undefined);
    (cli.rawControl as any).mockResolvedValue({
      accepted: true,
      commandId: "command-1",
      turnId: "turn-1",
    });
    (cli.rawQuery as any).mockResolvedValue({
      result: {
        status: "failed",
        error: { code: "busy", message: "Follow-up failed before execution." },
      },
    });
    await expect(
      controller.queueFollowUp("s1", { text: "follow up", images: [], files: [] }),
    ).resolves.toEqual({
      kind: "not_executed",
      detail: "Follow-up failed before execution.",
    });
    expect(cli.rawQuery).toHaveBeenCalledWith(
      "s1",
      "turn.result",
      { kind: "prompt", commandId: "command-1", turnId: "turn-1" },
      expect.anything(),
    );
    expect(cli.send).not.toHaveBeenCalled();
    controller.dispose();
  });

  it("maps only the typed follow-up preflight rejection without resubmitting", async () => {
    const { controller, cli, internals } = harness();
    internals.sessions.set("s1", { ...session(), status: "running" });
    internals.ensureAttached = vi.fn(async () => undefined);
    (cli.rawControl as any).mockRejectedValue(
      new SdkCliError(
        "busy",
        "Prompt preflight was cancelled before execution.",
      ),
    );
    await expect(
      controller.queueFollowUp("s1", { text: "follow up", images: [], files: [] }),
    ).resolves.toEqual({
      kind: "not_executed",
      detail: "Prompt preflight was cancelled before execution.",
    });
    expect(cli.rawQuery).not.toHaveBeenCalled();
    expect(cli.rawControl).toHaveBeenCalledTimes(1);
    expect(cli.send).not.toHaveBeenCalled();
    expect(internals.sessions.get("s1")?.status).toBe("running");
    controller.dispose();
  });

  it("does not classify a failed follow-up with startedAt as safe to retry", async () => {
    const { controller, cli, internals } = harness();
    internals.ensureAttached = vi.fn(async () => undefined);
    (cli.rawControl as any).mockResolvedValue({
      accepted: true,
      commandId: "command-2",
      turnId: "turn-2",
    });
    (cli.rawQuery as any).mockResolvedValue({
      result: {
        status: "failed",
        startedAt: 123,
        error: { code: "provider_error", message: "Provider failed after start." },
      },
    });
    await expect(
      controller.queueFollowUp("s1", { text: "do not replay", images: [], files: [] }),
    ).rejects.toThrow("Provider failed after start.");
    expect(cli.send).not.toHaveBeenCalled();
    controller.dispose();
  });

  it.each([null, "123", Number.NaN])("does not infer non-execution from malformed startedAt %s", async (startedAt) => {
    const { controller, cli, internals } = harness();
    internals.ensureAttached = vi.fn(async () => undefined);
    (cli.rawControl as any).mockResolvedValue({ accepted: true, commandId: "command-malformed", turnId: "turn-malformed" });
    (cli.rawQuery as any).mockResolvedValue({ result: { status: "failed", startedAt, error: { message: "uncertain" } } });
    await expect(controller.queueFollowUp("s1", { text: "do not replay", images: [], files: [] })).resolves.toBe("prompt");
    expect(cli.rawControl).toHaveBeenCalledTimes(1);
    expect(cli.send).not.toHaveBeenCalled();
    controller.dispose();
  });

  it("leaves an unknown follow-up outcome unknown without retrying", async () => {
    const { controller, cli, internals } = harness();
    internals.ensureAttached = vi.fn(async () => undefined);
    (cli.rawControl as any).mockResolvedValue({
      accepted: true,
      commandId: "command-3",
      turnId: "turn-3",
    });
    (cli.rawQuery as any).mockResolvedValue({ result: { status: "unknown" } });
    await expect(
      controller.queueFollowUp("s1", { text: "unknown outcome", images: [], files: [] }),
    ).resolves.toBe("prompt");
    expect(cli.rawQuery).toHaveBeenCalledTimes(1);
    expect(cli.rawControl).toHaveBeenCalledTimes(1);
    expect(cli.send).not.toHaveBeenCalled();
    controller.dispose();
  });

  it("bounds pending request reconciliation to twenty seconds", async () => {
    vi.useFakeTimers();
    const { controller, cli, internals } = harness();
    (cli.rawQuery as any).mockResolvedValue({
      result: { status: "in_flight", startedAt: 1 },
    });
    try {
      const startedAt = Date.now();
      const pending = internals.awaitPromptSettlement("s1", "op-timeout");
      await vi.advanceTimersByTimeAsync(20_000);
      await expect(pending).resolves.toBe("unknown");
      expect(Date.now() - startedAt).toBeLessThanOrEqual(20_000);
      expect(cli.rawQuery).toHaveBeenCalled();
    } finally {
      controller.dispose();
      vi.useRealTimers();
    }
  });

  it("paces request reconciliation instead of spawning a query every 400ms", async () => {
    vi.useFakeTimers();
    const { controller, cli, internals } = harness();
    (cli.rawQuery as any).mockResolvedValue({
      result: { status: "in_flight", startedAt: 1 },
    });
    try {
      const pending = internals.awaitPromptSettlement("s1", "op-paced");
      await vi.advanceTimersByTimeAsync(5_000);
      expect(cli.rawQuery.mock.calls.length).toBeLessThanOrEqual(6);
      controller.dispose();
      await vi.advanceTimersByTimeAsync(20_000);
      await expect(pending).resolves.toBe("unknown");
    } finally {
      controller.dispose();
      vi.useRealTimers();
    }
  });

  it("classifies prompt records by whether the agent ever ran them", async () => {
    const { cli, internals } = harness();
    const settle = (record: Record<string, unknown>) => {
      (cli.rawQuery as any).mockResolvedValueOnce({ result: record });
      return internals.awaitPromptSettlement("s1", "op1");
    };
    await expect(
      settle({ status: "failed", error: { code: "internal", message: "Prompt submission failed." } }),
    ).resolves.toEqual({
      kind: "not_executed",
      detail: "Prompt submission failed.",
    });
    await expect(
      settle({ status: "failed", startedAt: 1, error: { code: "cancelled", message: "Agent run failed after execution started." } }),
    ).resolves.toBe("terminal");
    const failed = settle({ status: "failed", startedAt: 1, error: { code: "agent_error", message: "provider exploded" } });
    await expect(failed).rejects.toThrow("provider exploded");
    internals.locallyAbortedSessions.add("s1");
    await expect(internals.awaitPromptSettlement("s1", "op1")).resolves.toBe("unknown");
  });

  it("falls back from busy send to turn.steer", async () => {
    const { controller, cli, internals } = harness();
    internals.sessions.set("s1", { ...session(), status: "running" }); internals.sessionCwds.set("s1", "/repo");
    await expect(controller.sendMessage("s1", { text: "hello", images: [], files: [] })).resolves.toBe("steer");
    expect(cli.rawControl).toHaveBeenCalledWith("s1", "turn.steer", expect.objectContaining({ text: "hello" }), expect.anything());
  });

  it("uses exact terminal abort payload with confirm and idempotency key", async () => {
    const { controller, cli, internals } = harness();
    internals.sessions.set("s1", session()); internals.sessionCwds.set("s1", "/repo");
    (cli.rawControl as any).mockResolvedValue({ turn: "stopped" });
    await controller.cancelRun("s1");
    expect(cli.rawControl).toHaveBeenCalledWith("s1", "turn.abort", { mode: "terminal", scope: "owned", operator: true }, expect.objectContaining({ confirm: true, idempotencyKey: expect.stringMatching(/^gajae-abort-/), repo: "/repo" }));
    // A host that serves the operator route is never asked twice.
    expect(cli.rawControl).toHaveBeenCalledTimes(1);
  });

  it("does not publish idle or cancellation from an unconfirmed abort ACK", async () => {
    const { controller, cli, internals } = harness();
    internals.sessions.set("s1", { ...session(), status: "running" });
    internals.sessionCwds.set("s1", "/repo");
    internals.transcripts.set("s1", []);
    (cli.rawControl as any).mockResolvedValue({ turn: "no_active_turn" });
    await expect(controller.cancelRun("s1")).rejects.toThrow(/확정하지 못했습니다/u);
    expect(internals.sessions.get("s1")?.status).toBe("running");
    expect(internals.transcripts.get("s1")).toEqual([]);
  });

  it("does not treat no_active_turn on this connection as session-wide idle", async () => {
    const { controller, cli, internals } = harness();
    internals.sessions.set("s1", { ...session(), status: "running" });
    internals.liveRunningSessions.add("s1");
    (cli.rawControl as any).mockResolvedValue({ turn: "no_active_turn" });
    await expect(controller.cancelRun("s1")).rejects.toThrow(/작업 중지를 확정하지 못했습니다/u);
    expect(internals.sessions.get("s1")?.status).toBe("running");
    expect(internals.liveRunningSessions.has("s1")).toBe(true);
  });

  it("preserves a new run when an older tail settlement returns idle", async () => {
    const { controller, internals } = harness();
    internals.sessions.set("s1", { ...session(), status: "running" });
    let settle!: (value: string) => void;
    internals.discoveredRunState = vi.fn(() => new Promise((resolve) => { settle = resolve; }));
    const reconcile = internals.reconcileTailTerminalState("s1");
    internals.advanceRunRevision("s1");
    settle("idle");
    await reconcile;
    expect(internals.sessions.get("s1")?.status).toBe("running");
    controller.dispose();
  });

  it("keeps the new prompt admission when an aborted send settles late", async () => {
    const { controller, cli, internals } = harness();
    internals.sessions.set("s1", session());
    internals.sessionCwds.set("s1", "/repo");
    internals.ensureAttached = vi.fn(async () => undefined);
    internals.executeSdkSlashCommand = vi.fn(async () => false);
    let finishOld!: (result: { status: string }) => void;
    let finishNew!: (result: { status: string }) => void;
    (cli.send as any)
      .mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { finishNew = resolve; }));
    internals.awaitPromptSettlement = vi.fn(async () => "unknown");
    (cli.rawControl as any).mockResolvedValue({ turn: "stopped" });
    const oldSend = controller.sendMessage("s1", { text: "old", images: [], files: [] });
    while (!finishOld) await Promise.resolve();
    await controller.cancelRun("s1");
    const newSend = controller.sendMessage("s1", { text: "new", images: [], files: [] });
    while (!finishNew) await Promise.resolve();
    const newAdmission = internals.activePromptAdmissions.get("s1");
    expect(typeof newAdmission).toBe("symbol");
    finishOld({ status: "accepted" });
    await oldSend;
    expect(internals.activePromptAdmissions.get("s1")).toBe(newAdmission);
    expect(internals.activePromptSessions.has("s1")).toBe(true);
    expect(cli.send).toHaveBeenCalledTimes(2);
    finishNew({ status: "accepted" });
    await newSend;
    controller.dispose();
  });

  it("ignores a late failure from the send a cancel replaced", async () => {
    const { controller, cli, internals } = harness();
    internals.sessions.set("s1", session());
    internals.sessionCwds.set("s1", "/repo");
    internals.ensureAttached = vi.fn(async () => undefined);
    internals.executeSdkSlashCommand = vi.fn(async () => false);
    let failOld!: (error: unknown) => void;
    let finishNew!: (result: { status: string }) => void;
    (cli.send as any)
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            failOld = reject;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishNew = resolve;
          }),
      );
    internals.awaitPromptSettlement = vi.fn(async () => "unknown");
    (cli.rawControl as any).mockResolvedValue({ turn: "stopped" });
    const oldSend = controller.sendMessage("s1", {
      text: "old",
      images: [],
      files: [],
    });
    while (!failOld) await Promise.resolve();
    await controller.cancelRun("s1");
    const newSend = controller.sendMessage("s1", {
      text: "new",
      images: [],
      files: [],
    });
    while (!finishNew) await Promise.resolve();
    const newAdmission = internals.activePromptAdmissions.get("s1");
    const streaming = {
      id: "assistant-new",
      kind: "message",
      sessionId: "s1",
      role: "assistant",
      content: "working",
      createdAt: "now",
      streaming: true,
    };
    internals.transcripts.set("s1", [streaming]);
    internals.activeAssistantMessages.set("s1", streaming.id);

    failOld(new Error("send failed after the cancel"));

    await expect(oldSend).resolves.toBe("prompt");
    expect(internals.activePromptAdmissions.get("s1")).toBe(newAdmission);
    expect(internals.activePromptSessions.has("s1")).toBe(true);
    expect(internals.sessions.get("s1")?.status).toBe("running");
    // The newer run keeps streaming: its message was not finalized, its active
    // id survived, and no failure notice was appended for the cancelled send.
    expect(streaming.streaming).toBe(true);
    expect(internals.activeAssistantMessages.get("s1")).toBe("assistant-new");
    expect(internals.transcripts.get("s1")).toHaveLength(1);

    finishNew({ status: "accepted" });
    await newSend;
    controller.dispose();
  });

  it("does not publish running when a replaced uncertain send later returns unknown", async () => {
    const { controller, cli, internals } = harness();
    internals.sessions.set("s1", session());
    internals.sessionCwds.set("s1", "/repo");
    internals.ensureAttached = vi.fn(async () => undefined);
    internals.executeSdkSlashCommand = vi.fn(async () => false);
    let failOld!: (error: unknown) => void;
    let finishNew!: (result: { status: string }) => void;
    let settleOld!: (outcome: "unknown") => void;
    (cli.send as any)
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            failOld = reject;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishNew = resolve;
          }),
      );
    internals.awaitPromptSettlement = vi
      .fn()
      .mockImplementationOnce(
        () => new Promise((resolve) => { settleOld = resolve; }),
      )
      .mockResolvedValue(undefined);
    internals.discoveredRunState = vi.fn(async () => "idle");
    (cli.rawControl as any).mockResolvedValue({ turn: "stopped" });

    const oldSend = controller.sendMessage("s1", {
      text: "old",
      images: [],
      files: [],
    });
    while (!failOld) await Promise.resolve();
    failOld(
      new SdkCliError("uncertain_after_send", "outcome is uncertain after send"),
    );
    while (!settleOld) await Promise.resolve();
    await controller.cancelRun("s1");
    const newSend = controller.sendMessage("s1", {
      text: "new",
      images: [],
      files: [],
    });
    while (!finishNew) await Promise.resolve();
    finishNew({ status: "accepted" });
    await newSend;
    expect(internals.sessions.get("s1")?.status).toBe("idle");
    expect(internals.activePromptAdmissions.has("s1")).toBe(false);

    // The cancelled send finally learns that its outcome is unknown. That is not
    // authority to reopen the completed session or its admission.
    settleOld("unknown");
    await expect(oldSend).resolves.toBe("prompt");
    expect(internals.sessions.get("s1")?.status).toBe("idle");
    expect(internals.activePromptAdmissions.has("s1")).toBe(false);
    controller.dispose();
  });

  it("publishes an out-of-window same-id tool completion", () => {
    const emit = vi.fn();
    const { controller, internals } = harness({ emit });
    const toolRow = (index: number, status: string, output?: string) =>
      ({
        id: `call-${index}`,
        kind: "tool",
        sessionId: "s1",
        name: "bash",
        description: "bash",
        status,
        createdAt: "now",
        ...(output ? { output } : {}),
      }) as any;
    const previous = Array.from({ length: 40 }, (_value, index) =>
      toolRow(index, index === 0 ? "running" : "completed"),
    );
    const next = previous.map((row, index) =>
      index === 0 ? toolRow(0, "completed", "late output") : row,
    );
    internals.publishTranscriptSync("s1", previous, next);
    const events = emit.mock.calls.map(([event]) => event);
    expect(events.some((event) => event.type === "transcript.invalidated")).toBe(
      false,
    );
    const appended = events.filter(
      (event) => event.type === "transcript.appended",
    );
    expect(appended).toHaveLength(1);
    expect(appended[0]?.item).toMatchObject({
      id: "call-0",
      status: "completed",
      output: "late output",
    });
    controller.dispose();
  });

  it("publishes a changed row followed by an unchanged parallel call", () => {
    const emit = vi.fn();
    const { controller, internals } = harness({ emit });
    const toolRow = (id: string, status: string, output?: string) =>
      ({
        id,
        kind: "tool",
        sessionId: "s1",
        name: "bash",
        description: "bash",
        status,
        createdAt: "now",
        ...(output ? { output } : {}),
      }) as any;
    const changed = toolRow("call-a", "running");
    const unchanged = toolRow("call-b", "completed", "done");
    internals.publishTranscriptSync(
      "s1",
      [changed, unchanged],
      [{ ...changed, status: "completed", output: "ok" }, unchanged],
    );
    const events = emit.mock.calls.map(([event]) => event);
    const appended = events.filter(
      (event) => event.type === "transcript.appended",
    );
    // The last row still matches, but that says nothing about the parallel row
    // before it: both calls settle independently.
    expect(appended.map((event) => event.item.id)).toEqual(["call-a"]);
    expect(appended[0].item).toMatchObject({
      status: "completed",
      output: "ok",
    });
    expect(events.some((event) => event.type === "transcript.invalidated")).toBe(
      false,
    );
    controller.dispose();
  });

  it("publishes an old app-owned row marked dirty by a live update", () => {
    const emit = vi.fn();
    const { controller, internals } = harness({ emit });
    const row = (content: string) => ({
      id: "row-0",
      kind: "notice",
      sessionId: "s1",
      title: "todo",
      content,
      tone: "neutral",
      createdAt: "now",
    }) as any;
    const previous = [
      row("old"),
      ...Array.from({ length: 39 }, (_value, index) => ({
        id: `row-${index + 1}`,
        kind: "message",
        sessionId: "s1",
        role: "assistant",
        content: `answer ${index}`,
        createdAt: "now",
      })) as any[],
    ];
    const next = [{ ...previous[0], content: "new" }, ...previous.slice(1)];
    internals.markTranscriptRowDirty("s1", "row-0");
    internals.publishTranscriptSync("s1", previous, next);
    const appended = emit.mock.calls
      .map(([event]) => event)
      .filter((event) => event.type === "transcript.appended");
    expect(appended).toHaveLength(1);
    expect(appended[0]?.item).toMatchObject({ id: "row-0", content: "new" });
    controller.dispose();
  });

  it("invalidates history when an out-of-window row changed identity", () => {
    const emit = vi.fn();
    const { controller, internals } = harness({ emit });
    const toolRow = (id: string) =>
      ({
        id,
        kind: "tool",
        sessionId: "s1",
        name: "bash",
        description: "bash",
        status: "completed",
        createdAt: "now",
      }) as any;
    const previous = Array.from({ length: 40 }, (_value, index) =>
      toolRow(`call-${index}`),
    );
    const next = previous.map((row, index) =>
      index === 0 ? toolRow("call-replaced") : row,
    );
    internals.publishTranscriptSync("s1", previous, next);
    // A replacement outside the diff window shifts row identity; appended events
    // cannot describe it, so the renderer must reload a page.
    const transcriptEvents = emit.mock.calls
      .map(([event]) => event)
      .filter(
        (event) =>
          event.type === "transcript.invalidated" ||
          event.type === "transcript.appended",
      );
    expect(transcriptEvents).toEqual([
      { type: "transcript.invalidated", sessionId: "s1" },
    ]);
    controller.dispose();
  });

  it("does not send a follow-up after permission application fails", async () => {
    const { controller, cli, internals } = harness();
    internals.ensureAttached = vi.fn(async () => { throw new Error("permission_mode.set rejected"); });
    await expect(controller.queueFollowUp("s1", { text: "follow up", images: [], files: [] } as never)).rejects.toThrow("세션 제어 상태");
    expect(cli.rawControl).not.toHaveBeenCalledWith("s1", "turn.follow_up", expect.anything(), expect.anything());
    controller.dispose();
  });

  it("does not publish rejected thinking configuration", async () => {
    const { controller, cli, internals } = harness();
    internals.sessions.set("s1", session());
    internals.sessionConfig.set("s1", [{ id: "thinking", category: "thought_level", currentValue: "medium" }]);
    internals.controlSession = vi.fn(async () => { throw new Error("invalid_input"); });
    await expect(controller.setSessionConfig("s1", "thinking", "high")).rejects.toThrow("invalid_input");
    expect(internals.explicitSessionThinking.has("s1")).toBe(false);
    expect(internals.sessionConfig.get("s1")[0].currentValue).toBe("medium");
    expect(cli.rawControl).not.toHaveBeenCalled();
    controller.dispose();
  });

  it.each([true, false])("requests only saved-history deletion when live=%s", async (live) => {
    const { controller, cli, internals } = harness();
    internals.sessions.set("s1", session()); internals.sessionCwds.set("s1", "/repo");
    internals.locateSharedTranscriptFile = vi.fn(async () => "/repo/s1.jsonl");
    cli.listSessions.mockResolvedValue([{ sessionId: "s1", repo: "/repo", live, deleted: false, stateRoot: "/state" }] as never);
    await controller.deleteSession("s1");
    expect(cli.rawGlobal).toHaveBeenCalledExactlyOnceWith("session.delete",
      { sessionId: "s1", cwd: "/repo", stateRoot: "/state", sessionPath: "/repo/s1.jsonl" },
      expect.objectContaining({ repo: "/repo", idempotencyKey: expect.any(String) }));
    expect(cli.rawControl).not.toHaveBeenCalled();
    expect(internals.sessions.has("s1")).toBe(false);
    controller.dispose();
  });

  it("keeps local state when deletion fails with a verified operational error", async () => {
    const { controller, cli, internals } = harness();
    internals.sessions.set("s1", session()); internals.sessionCwds.set("s1", "/repo");
    (cli.listSessions as any).mockResolvedValue([
      { sessionId: "s1", repo: "/repo", live: true, deleted: false },
    ]);
    (cli.rawGlobal as any).mockRejectedValue(new SdkCliError("invalid_input", "delete refused"));
    await expect(controller.deleteSession("s1")).rejects.toThrow("delete refused");
    expect(internals.sessions.has("s1")).toBe(true);
    expect(cli.rawGlobal).toHaveBeenCalledTimes(1);
    expect((cli.rawGlobal as any).mock.calls[0][0]).toBe("session.delete");
  });

  it("preserves a non-live session when delete receipt remains uncertain", async () => {
    const { controller, cli, internals } = harness();
    internals.sessions.set("s1", session()); internals.sessionCwds.set("s1", "/repo");
    internals.attachedSessions.add("s1");
    internals.locateSharedTranscriptFile = vi.fn(async () => undefined);
    (cli.listSessions as any).mockResolvedValue([
      { sessionId: "s1", repo: "/repo", live: false, deleted: false },
    ]);
    (cli.rawGlobal as any).mockImplementation(async (operation: string) => {
      if (operation === "session.delete")
        throw new SdkCliError("terminal_uncertain", "retained artifacts require reconciliation");
      return {};
    });
    await expect(controller.deleteSession("s1")).rejects.toThrow(/세션 삭제를 확정하지 못했습니다/u);
    expect(internals.sessions.get("s1")?.attachment).toBe("recovering");
    expect(internals.sessions.has("s1")).toBe(true);
  });

  it.each([0, 1, undefined])("preserves a CLI's sessions when SDK history deletion is refused at generation %s", async (endpointGeneration) => {
    const { controller, cli, internals } = harness();
    internals.sessions.set("s1", session());
    const successor = { ...session("new"), ownership: "external" };
    internals.sessions.set("new", successor);
    internals.locateSharedTranscriptFile = vi.fn(async () => "/repo/s1.jsonl");
    const remove = vi.spyOn(internals, "removeSessionArtifacts");
    (cli.listSessions as any).mockResolvedValue([
      { sessionId: "s1", repo: "/repo", live: true, deleted: false, endpointGeneration },
    ]);
    cli.rawGlobal.mockRejectedValue(new SdkCliError("live_session", "Refusing to delete a live session; close it first."));
    await expect(controller.deleteSession("s1")).rejects.toThrow(/CLI를 종료/u);
    expect(cli.rawGlobal).toHaveBeenCalledTimes(1);
    expect((cli.rawGlobal as any).mock.calls[0][0]).toBe("session.delete");
    expect(cli.rawControl).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(internals.sessions.has("s1")).toBe(true);
    expect(internals.sessions.get("new")).toBe(successor);
    controller.dispose();
  });

  it("skips the close when the broker row proves the session is absent", async () => {
    const { controller, cli, internals } = harness();
    internals.sessions.set("s1", session()); internals.sessionCwds.set("s1", "/repo");
    internals.locateSharedTranscriptFile = vi.fn(async () => "/repo/transcript.jsonl");
    await controller.deleteSession("s1");
    // A saved transcript with no indexed lifecycle identity has nothing to close.
    expect((cli.rawGlobal as any).mock.calls.map((c: any[]) => c[0])).toEqual(["session.delete"]);
    expect(cli.rawGlobal).toHaveBeenCalledWith(
      "session.delete",
      expect.objectContaining({ sessionId: "s1", cwd: "/repo", sessionPath: "/repo/transcript.jsonl" }),
      expect.anything(),
    );
    expect(internals.sessions.has("s1")).toBe(false);
  });

  it("deletes a tombstoned session from that row's own locator window", async () => {
    const { controller, cli, internals } = harness();
    internals.sessions.set("s1", session()); internals.sessionCwds.set("s1", "/stale");
    internals.locateSharedTranscriptFile = vi.fn(async () => undefined);
    (cli.listSessions as any).mockResolvedValue([
      { sessionId: "s1", repo: "/repo", live: false, deleted: true, stateRoot: "/state" },
    ]);
    await controller.deleteSession("s1");
    expect((cli.rawGlobal as any).mock.calls.map((c: any[]) => c[0])).toEqual(["session.delete"]);
    expect(cli.rawGlobal).toHaveBeenCalledWith(
      "session.delete",
      expect.objectContaining({ sessionId: "s1", cwd: "/repo", stateRoot: "/state" }),
      expect.anything(),
    );
    expect(internals.sessions.has("s1")).toBe(false);
  });

  it("hides a session locally without calling a delete the SDK cannot confirm", async () => {
    // gjc/0.18.12 answers session.delete with an unknown outcome and leaves the row
    // and transcript in place, so hiding must not depend on it: no CLI call, the row
    // leaves the rail, and the id is recorded as hidden so discovery stays quiet.
    const { controller, cli, internals } = harness();
    const hidden: string[] = [];
    internals.sessionMetadata = { hideSession: (id: string) => hidden.push(id) };
    internals.sessions.set("s1", session());
    internals.sessionCwds.set("s1", "/repo");
    controller.hideSession("s1");
    expect(hidden).toEqual(["s1"]);
    expect(internals.sessions.has("s1")).toBe(false);
    expect(cli.rawGlobal).not.toHaveBeenCalled();
  });

  it("keeps the session when the broker index cannot be read", async () => {
    const { controller, cli, internals } = harness();
    internals.sessions.set("s1", session()); internals.sessionCwds.set("s1", "/repo");
    (cli.listSessions as any).mockRejectedValue(new Error("index unavailable"));
    await expect(controller.deleteSession("s1")).rejects.toThrow(/세션 삭제를 확정하지 못했습니다/u);
    // No row is no evidence: without the index nothing may be closed or deleted.
    expect(cli.rawGlobal).not.toHaveBeenCalled();
    expect(internals.sessions.get("s1")?.attachment).toBe("recovering");
  });

  it("resolves the shared transcript alongside the broker index", async () => {
    const { controller, cli, internals } = harness();
    internals.sessions.set("s1", session()); internals.sessionCwds.set("s1", "/repo");
    const locate = vi.fn(async () => "/repo/transcript.jsonl");
    internals.locateSharedTranscriptFile = locate;
    let locatedWhenIndexAnswered = 0;
    (cli.listSessions as any).mockImplementation(async () => {
      locatedWhenIndexAnswered = locate.mock.calls.length;
      return [{ sessionId: "s1", repo: "/repo", live: false, deleted: false }];
    });
    await controller.deleteSession("s1");
    // The directory scan is already in flight when the index answers, so the two
    // never serialize, and the delete still gets the path that scan resolved.
    expect(locatedWhenIndexAnswered).toBe(1);
    expect(cli.rawGlobal).toHaveBeenCalledWith(
      "session.delete",
      expect.objectContaining({ sessionPath: "/repo/transcript.jsonl" }),
      expect.anything(),
    );
  });

  it("resumes with cwd and transcript sessionPath", async () => {
    const { controller, cli, internals } = harness();
    internals.sessions.set("s1", session()); internals.sessionCwds.set("s1", "/repo");
    internals.locateSharedTranscriptFile = vi.fn(async () => "/repo/transcript.jsonl");
    cli.inspectSession.mockResolvedValue({ live: false, repo: "/repo" });
    await (controller as any)["resume" + "Session"]("s1");
    expect(cli.rawGlobal).toHaveBeenCalledWith("session.resume", expect.objectContaining({ sessionId: "s1", cwd: "/repo", sessionPath: "/repo/transcript.jsonl" }), { repo: "/repo" });
  });

  it("preserves managed worktree metadata when forking the same cwd", async () => {
    const { controller, cli, internals } = harness();
    const source = {
      ...session("source", "/repo-wt"),
      worktree: {
        sourceWorkspace: "/repo",
        path: "/repo-wt",
        branch: "gajae/source",
        managed: true,
      },
    };
    internals.sessions.set("source", source);
    internals.sessionCwds.set("source", "/repo-wt");
    internals.attachedSessions.add("source");
    (cli.rawGlobal as any).mockResolvedValue({ sessionId: "forked" });
    const forked = await controller.forkSession({ sourceSessionId: "source" });
    expect(forked.worktree).toEqual(source.worktree);
    expect(cli.rawGlobal).toHaveBeenCalledWith(
      "session.fork",
      expect.objectContaining({ sourceSessionId: "source", cwd: "/repo-wt" }),
      expect.objectContaining({ repo: "/repo-wt", idempotencyKey: expect.stringMatching(/^gajae-session-fork-/) }),
    );
  });

  it("repairs a missed watcher during an app-owned prompt without waiting for reload", async () => {
    const emit = vi.fn();
    const { controller, internals } = harness({ emit });
    const root = await mkdtemp(path.join(tmpdir(), "active-transcript-refresh-"));
    const file = path.join(root, "session.jsonl");
    internals.sessions.set("s1", { ...session(), status: "running" });
    internals.attachedSessions.add("s1");
    internals.activePromptSessions.add("s1");
    internals.locateSharedTranscriptFile = vi.fn(async () => file);
    // Simulate a dropped filesystem notification: only the safety-net read can
    // discover this write while the prompt still owns the session.
    internals.watchSharedTranscript = vi.fn();
    try {
      await writeFile(file, JSON.stringify({ type: "message", id: "u1", message: { role: "user", content: [{ type: "text", text: "question" }] } }) + "\n");
      const initial = await controller.getTranscript("s1");
      expect(initial).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "message", content: "question" }),
      ]));
      await writeFile(file, [
        { type: "message", id: "u1", message: { role: "user", content: [{ type: "text", text: "question" }] } },
        { type: "message", id: "a1", message: { role: "assistant", content: [{ type: "thinking", thinking: "reasoning now" }, { type: "text", text: "answer now" }, { type: "toolCall", id: "t1", name: "bash", arguments: { command: "pwd" } }], stopReason: "toolUse" } },
        { type: "message", id: "r1", message: { role: "toolResult", toolCallId: "t1", toolName: "bash", content: [{ type: "text", text: "/repo" }], isError: false } },
      ].map((row) => JSON.stringify(row)).join("\n") + "\n");
      const change = await controller.getTranscriptChanges("s1");
      expect(change.items).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "thought", content: "reasoning now" }),
        expect.objectContaining({ kind: "message", content: "answer now" }),
        expect.objectContaining({ kind: "tool", name: "bash", output: "/repo", status: "completed" }),
      ]));
      expect(internals.sessions.get("s1").status).toBe("running");
      expect(internals.activePromptSessions.has("s1")).toBe(true);
      expect(emit).not.toHaveBeenCalledWith(expect.objectContaining({ type: "session.updated", session: expect.objectContaining({ status: "idle" }) }));
    } finally {
      controller.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves a just-sent user prompt across a durable read that has not recorded it", () => {
    const { controller, internals } = harness();
    try {
      internals.appendLocalUserMessage("s1", "new prompt", { text: "new prompt", images: [], files: [] });
      const items = internals.installTranscript("s1", []);
      expect(items).toEqual([expect.objectContaining({ role: "user", content: "new prompt" })]);
    } finally { controller.dispose(); }
  });

  it("keeps live memory readable before an active prompt has a transcript file", async () => {
    const { controller, internals } = harness();
    internals.sessions.set("s1", { ...session(), status: "running" });
    internals.attachedSessions.add("s1");
    internals.activePromptSessions.add("s1");
    internals.locateSharedTranscriptFile = vi.fn(async () => undefined);
    internals.projectThoughtChunk("s1", {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "first live thought" },
    });
    try {
      expect(await controller.getTranscript("s1")).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "thought", content: "first live thought", streaming: true }),
      ]));
    } finally {
      controller.dispose();
    }
  });

  it("keeps a newly discovered session running when its transcript says so", async () => {
    const { controller, cli, internals } = harness();
    (cli.listSessions as any).mockResolvedValue([
      {
        sessionId: "s1",
        title: "One",
        repo: "/repo",
        live: true,
        runtime: "gjc",
        activityState: "idle",
      },
    ]);
    internals.liveRouteReachable = vi.fn(async () => true);
    internals.locateSharedTranscriptFile = vi.fn(async () => undefined);
    internals.discoveredRunState = vi.fn(async () => "running");
    internals.sessionParentId = vi.fn(async () => undefined);
    try {
      const rows = await controller.listSessions();
      expect(rows.find((row) => row.id === "s1")?.status).toBe("running");
    } finally {
      controller.dispose();
    }
  });

  it("shows a live external session as running while the broker reports activity", async () => {
    const { controller, cli, internals } = harness();
    (cli.listSessions as any).mockResolvedValue([
      {
        sessionId: "s1",
        title: "One",
        repo: "/repo",
        live: true,
        runtime: "gjc",
        activityState: "active",
      },
    ]);
    internals.liveRouteReachable = vi.fn(async () => true);
    internals.locateSharedTranscriptFile = vi.fn(async () => undefined);
    internals.discoveredRunState = vi.fn(async () => "idle");
    internals.sessionParentId = vi.fn(async () => undefined);
    try {
      const rows = await controller.listSessions();
      expect(rows.find((row) => row.id === "s1")?.status).toBe("running");
    } finally {
      controller.dispose();
    }
  });

  it("lists sessions through the CLI and catches up tail cursors", async () => {
    const { cli, internals } = harness();
    (cli.listSessions as any).mockResolvedValue([{ sessionId: "s1", title: "One", repo: "/repo", live: true, runtime: "gjc", activityState: "idle" }]);
    expect(await internals.brokerSessions()).toEqual(expect.arrayContaining([expect.objectContaining({ sessionId: "s1" })]));
    internals.sessions.set("s1", session()); internals.sessionCwds.set("s1", "/repo");
    internals.attachedSessions.add("s1");
    (cli.tail as any)
      .mockResolvedValueOnce({
        source: "session", terminal: true, items: [{ kind: "transcript", payload: { id: "row-9", role: "assistant" } }], checkpointToken: "checkpoint-1",
      })
      .mockResolvedValueOnce({ source: "offline", terminal: true, items: [] });
    internals.startTailFollower("s1");
    await new Promise((resolve) => setTimeout(resolve, TAIL_WINDOW_MS + 100));
    expect(cli.tail).toHaveBeenCalledTimes(2);
    // gjc/0.18.12 refuses a live --cursor without the row it stopped at.
    expect((cli.tail as any).mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({ cursor: "checkpoint-1", afterTranscriptId: "row-9" }),
    );
  });

  it("does not resume a tail it has no transcript boundary for", async () => {
    const { cli, internals } = harness();
    internals.sessions.set("s1", session()); internals.sessionCwds.set("s1", "/repo");
    internals.attachedSessions.add("s1");
    (cli.tail as any)
      .mockResolvedValueOnce({ source: "session", terminal: true, items: [{ kind: "agent_end", payload: {} }], checkpointToken: "checkpoint-1" })
      .mockResolvedValueOnce({ source: "offline", terminal: true, items: [] });
    internals.startTailFollower("s1");
    await new Promise((resolve) => setTimeout(resolve, TAIL_WINDOW_MS + 100));
    expect(cli.tail).toHaveBeenCalledTimes(2);
    expect((cli.tail as any).mock.calls[1]?.[1]).not.toHaveProperty("cursor");
  });

  it("does not replay a historical start after idle, but accepts a newer sequenced turn", async () => {
    const emit = vi.fn();
    const { controller, internals } = harness({ emit });
    internals.sessions.set("s1", { ...session(), status: "idle" });
    internals.discoveredRunState = vi.fn(async () => "idle");
    const oldHistory = [
      { kind: "turn_start", generation: 7, seq: 40, payload: {} },
      { kind: "agent_start", generation: 7, seq: 41, payload: {} },
      { kind: "turn_end", generation: 7, seq: 42, payload: {} },
    ];
    try {
      // An initial catch-up read and an identical replay must not resurrect a
      // completed run or announce a completion for the historical end frame.
      internals.projectTailItems("s1", oldHistory);
      await Promise.resolve();
      await Promise.resolve();
      expect(internals.sessions.get("s1").status).toBe("idle");
      internals.projectTailItems("s1", oldHistory);
      await Promise.resolve();
      expect(internals.sessions.get("s1").status).toBe("idle");
      expect(emit.mock.calls.map(([event]) => event).filter(
        (event) => event.type === "session.activity" && event.category === "completed",
      )).toHaveLength(0);

      internals.projectTailItems("s1", [
        { kind: "turn_start", generation: 7, seq: 43, payload: {} },
      ]);
      expect(internals.sessions.get("s1").status).toBe("running");
      internals.projectTailItems("s1", [
        { kind: "turn_end", generation: 7, seq: 44, payload: {} },
      ]);
      await vi.waitFor(() => expect(internals.sessions.get("s1").status).toBe("idle"));
      expect(emit.mock.calls.map(([event]) => event).filter(
        (event) => event.type === "session.activity" && event.category === "completed",
      )).toHaveLength(1);
    } finally {
      controller.dispose();
    }
  });

  it("does not let replayed tail session metadata renew working lifecycle evidence", () => {
    const { controller, internals } = harness();
    internals.sessions.set("s1", { ...session(), status: "idle" });
    const now = Date.now();
    internals.projectTailItems("s1", [
      { kind: "turn_start", generation: 1, seq: 9, payload: {} },
      {
        kind: "session_update",
        generation: 1,
        seq: 10,
        payload: {
          sessionUpdate: "session_info_update",
          title: "Historical title",
          updatedAt: new Date(now).toISOString(),
          _meta: { gjcRunning: true, gjcPhase: "working" },
        },
      },
    ]);
    expect(internals.sessions.get("s1").status).toBe("idle");
    expect(internals.sessions.get("s1").title).toBe("Historical title");
    expect(internals.liveEvidenceAt.has("s1")).toBe(false);
    expect(internals.workingPhaseSessions.has("s1")).toBe(false);

    // This historical update carries a newer wall-clock timestamp but its tail
    // position is behind the established watermark; it must not renew liveness.
    internals.projectTailItems("s1", [
      {
        kind: "session_update",
        generation: 1,
        seq: 10,
        payload: {
          sessionUpdate: "session_info_update",
          title: "Replayed title",
          updatedAt: new Date(now + 60_000).toISOString(),
          _meta: { gjcRunning: true, gjcPhase: "working" },
        },
      },
    ]);
    expect(internals.sessions.get("s1").status).toBe("idle");
    expect(internals.sessions.get("s1").title).toBe("Replayed title");
    expect(internals.liveEvidenceAt.has("s1")).toBe(false);

    internals.projectTailItems("s1", [
      {
        kind: "session_info_update",
        generation: 1,
        seq: 11,
        payload: {
          sessionUpdate: "session_info_update",
          updatedAt: new Date(now + 120_000).toISOString(),
          _meta: { gjcRunning: true, gjcPhase: "working" },
        },
      },
    ]);
    expect(internals.sessions.get("s1").status).toBe("running");
    expect(internals.liveEvidenceAt.has("s1")).toBe(true);
    controller.dispose();
  });

  it("drops a checkpoint the reader refuses instead of retrying it forever", async () => {
    const { controller, cli, internals } = harness();
    internals.sessions.set("s1", session()); internals.sessionCwds.set("s1", "/repo");
    internals.attachedSessions.add("s1");
    internals.tailCheckpoints.set("s1", { cursor: "expired", afterTranscriptId: "row-1" });
    internals.refreshTranscriptFromFile = vi.fn(async () => undefined);
    (cli.tail as any)
      .mockRejectedValueOnce(new SdkCliError("usage", "The command arguments are invalid."))
      .mockResolvedValueOnce({ source: "offline", terminal: true, items: [] });
    internals.startTailFollower("s1");
    await internals.tailReads.get("s1");
    expect(cli.tail).toHaveBeenCalledTimes(2);
    expect((cli.tail as any).mock.calls[1]?.[1]).not.toHaveProperty("cursor");
    expect(internals.refreshTranscriptFromFile).toHaveBeenCalledWith("s1");
    controller.dispose();
  });

  it("retains the last tail checkpoint across a timeout and aborts on detach", async () => {
    const { cli, internals } = harness();
    internals.sessions.set("s1", session()); internals.sessionCwds.set("s1", "/repo");
    internals.attachedSessions.add("s1");
    (cli.tail as any)
      .mockResolvedValueOnce({
        source: "session", terminal: true, items: [{ kind: "transcript", payload: { id: "row-9", role: "assistant" } }], checkpointToken: "checkpoint-1",
      })
      .mockRejectedValueOnce(new SdkCliError("tail_timeout", "still running"))
      .mockResolvedValueOnce({ source: "offline", terminal: true, items: [] });
    internals.startTailFollower("s1");
    await new Promise((resolve) =>
      setTimeout(resolve, TAIL_WINDOW_MS * 2 + 100),
    );
    expect((cli.tail as any).mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({ cursor: "checkpoint-1", afterTranscriptId: "row-9" }),
    );
    expect((cli.tail as any).mock.calls[2]?.[1]).toEqual(
      expect.objectContaining({ cursor: "checkpoint-1", afterTranscriptId: "row-9" }),
    );
    internals.removeLocalSession("s1", false);
    expect(internals.tailControllers.has("s1")).toBe(false);
  });

  it("retries a transient tail failure without losing the checkpoint", async () => {
    const { controller, cli, internals } = harness();
    internals.sessions.set("s1", session());
    internals.sessionCwds.set("s1", "/repo");
    internals.attachedSessions.add("s1");
    internals.tailCheckpoints.set("s1", { cursor: "checkpoint-1", afterTranscriptId: "row-9" });
    (cli.tail as any)
      .mockRejectedValueOnce(new Error("broker transport closed"))
      .mockResolvedValueOnce({ source: "offline", terminal: true, items: [] });
    internals.startTailFollower("s1");
    const follower = internals.tailReads.get("s1");
    await follower;
    expect(cli.tail).toHaveBeenCalledTimes(2);
    // The session stays attached and the cursor is unchanged across the retry.
    expect((cli.tail as any).mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({ cursor: "checkpoint-1" }),
    );
    expect(internals.attachedSessions.has("s1")).toBe(true);
    controller.dispose();
  });

  it("restarts a missing follower when an attached session is used again", async () => {
    const { controller, cli, internals } = harness();
    internals.attachedSessions.add("s1");
    let finish!: (value: unknown) => void;
    (cli.tail as any).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await internals.ensureAttached("s1", false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const follower = internals.tailReads.get("s1");
    expect(follower).toBeDefined();
    expect(cli.tail).toHaveBeenCalledTimes(1);
    finish({ source: "offline", terminal: true, items: [] });
    await follower;
    controller.dispose();
  });

  it("resyncs the durable file when tail returns a retention gap", async () => {
    const { controller, cli, internals } = harness();
    internals.sessions.set("s1", session()); internals.sessionCwds.set("s1", "/repo");
    internals.attachedSessions.add("s1");
    internals.refreshTranscriptFromFile = vi.fn(async () => undefined);
    (cli.tail as any)
      .mockResolvedValueOnce({
        source: "session", terminal: false, items: [], gap: { code: "retention_gap" },
      })
      .mockResolvedValueOnce({ source: "offline", terminal: true, items: [] });
    internals.startTailFollower("s1");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(internals.refreshTranscriptFromFile).toHaveBeenCalledWith("s1");
    await new Promise((resolve) => setTimeout(resolve, TAIL_WINDOW_MS + 100));
    expect((cli.tail as any).mock.calls[1]?.[1]).not.toHaveProperty("cursor");
    controller.dispose();
  });

  it("nests a listed session under the row its envelope names", async () => {
    // Lineage is not on the broker row this list reads, so the session's own
    // envelope supplies it -- this is the wiring that proves a fork arrives nested.
    const root = await mkdtemp(path.join(tmpdir(), "session-lineage-"));
    const previous = process.env.GJC_CODING_AGENT_DIR;
    process.env.GJC_CODING_AGENT_DIR = root;
    const { controller, cli } = harness();
    try {
      await transcriptFile(root, "child", [
        { type: "session", cwd: "/repo", parentSession: "parent" },
        {
          type: "message",
          message: { role: "user", content: [{ type: "text", text: "포크된 세션" }] },
        },
      ]);
      await transcriptFile(root, "parent", [
        { type: "session", cwd: "/repo" },
        {
          type: "message",
          message: { role: "user", content: [{ type: "text", text: "그냥 세션" }] },
        },
      ]);
      (cli.listSessions as any).mockResolvedValue([
        { sessionId: "parent", repo: "/repo", live: true, deleted: false, endpointGeneration: 1, runtime: "gjc" },
        { sessionId: "child", repo: "/repo", live: true, deleted: false, endpointGeneration: 1, runtime: "gjc" },
      ]);

      const listed = await controller.listSessions();
      expect(listed.find((row) => row.id === "child")?.parentId).toBe("parent");
      // A session with no recorded source stays a root rather than inventing one.
      expect(listed.find((row) => row.id === "parent")?.parentId).toBeUndefined();
    } finally {
      controller.dispose();
      if (previous === undefined) delete process.env.GJC_CODING_AGENT_DIR;
      else process.env.GJC_CODING_AGENT_DIR = previous;
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    new Error("GJC CLI timed out"),
    new SdkCliError("operation_failed", "unknown outcome", undefined, [], "unknown"),
  ])("preserves the managed worktree when creation has no not-applied proof: %s", async (failure) => {
    const dir = await mkdtemp(path.join(tmpdir(), "gajae-create-uncertain-"));
    let worktreePath: string | undefined;
    const { controller, cli } = harness();
    try {
      await execFile("git", ["init", "-q", dir]);
      await writeFile(path.join(dir, "README"), "seed");
      await execFile("git", ["-C", dir, "add", "README"]);
      await execFile("git", ["-C", dir, "-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-qm", "seed"]);
      cli.rawGlobal.mockImplementation(async (...args: unknown[]) => {
        worktreePath = (args[1] as { cwd: string }).cwd;
        throw failure;
      });
      await expect(controller.createSession({ runtime: "gjc", workspace: dir, isolation: "worktree", worktreeBranch: "gajae/uncertain" })).rejects.toThrow();
      expect(worktreePath).toBeDefined();
      expect((await stat(worktreePath!)).isDirectory()).toBe(true);
      expect((await execFile("git", ["-C", dir, "branch", "--list", "gajae/uncertain"])).stdout).toContain("gajae/uncertain");
    } finally {
      controller.dispose();
      if (worktreePath) await execFile("git", ["-C", dir, "worktree", "remove", "--force", worktreePath]).catch(() => undefined);
      await execFile("git", ["-C", dir, "branch", "-D", "gajae/uncertain"]).catch(() => undefined);
      if (worktreePath) await rm(path.dirname(worktreePath), { recursive: true, force: true });
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("creates a managed worktree and submits its cwd", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "gajae-test-"));
    let worktreePath: string | undefined;
    try {
      await execFile("git", ["init", "-q", dir]);
      await writeFile(path.join(dir, "README"), "seed");
      await execFile("git", ["-C", dir, "add", "README"]);
      await execFile("git", ["-C", dir, "-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-qm", "seed"]);
      const { controller, cli } = harness();
      (cli.rawGlobal as any).mockResolvedValue({ sessionId: "wt" });
      const created = await controller.createSession({ runtime: "gjc", workspace: dir, isolation: "worktree", worktreeBranch: "gajae/test" } as any);
      worktreePath = created.workspace;
      expect(created.worktree?.path).toContain(".gajae-worktrees");
      expect(cli.rawGlobal).toHaveBeenCalledWith("session.create", expect.objectContaining({ cwd: created.workspace }), expect.objectContaining({ repo: created.workspace, idempotencyKey: expect.stringMatching(/^gajae-session-create-/) }));
      controller.dispose();
    } finally {
      if (worktreePath)
        await execFile("git", ["-C", dir, "worktree", "remove", "--force", worktreePath]).catch(() => undefined);
      await execFile("git", ["-C", dir, "branch", "-D", "gajae/test"]).catch(() => undefined);
      if (worktreePath) await rm(path.dirname(worktreePath), { recursive: true, force: true });
      await rm(dir, { recursive: true, force: true });
    }
  });

  async function commit(dir: string, file: string): Promise<string> {
    await writeFile(path.join(dir, file), file);
    await execFile("git", ["-C", dir, "add", file]);
    await execFile("git", ["-C", dir, "-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-qm", file]);
    return (await execFile("git", ["-C", dir, "rev-parse", "HEAD"])).stdout.trim();
  }
  const headOf = async (dir: string) => (await execFile("git", ["-C", dir, "rev-parse", "HEAD"])).stdout.trim();
  const branchExists = (dir: string, branch: string) =>
    execFile("git", ["-C", dir, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).then(() => true, () => false);

  it("checks out an existing branch instead of creating one, records the work link, and never deletes that branch", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "gajae-existing-branch-"));
    const dir = path.join(parent, "repo");
    const metadata = new SessionMetadataStore(path.join(parent, "user-data"));
    const { controller, cli } = harness({ sessionMetadata: metadata });
    try {
      await execFile("git", ["init", "-q", "-b", "main", dir]);
      const branchTip = await commit(dir, "first");
      await execFile("git", ["-C", dir, "branch", "issue-7-fix"]);
      await commit(dir, "second");
      const workLink = { kind: "issue" as const, number: 7, url: "https://github.com/owner/app/issues/7" };
      cli.rawGlobal.mockResolvedValueOnce({ sessionId: "wt" } as never);
      const created = await controller.createSession({ runtime: "gjc", workspace: dir, isolation: "worktree", worktreeBranch: "issue-7-fix", workLink });
      expect(created.worktree?.branch).toBe("issue-7-fix");
      expect(await headOf(created.workspace)).toBe(branchTip);
      expect(created.workLink).toEqual(workLink);
      expect(metadata.getWorkLink("wt")).toEqual(workLink);
      expect(new SessionMetadataStore(path.join(parent, "user-data")).getWorkLink("wt")).toEqual(workLink);

      await execFile("git", ["-C", dir, "worktree", "remove", "--force", created.workspace]);
      cli.rawGlobal.mockRejectedValueOnce(new SdkCliError("operation_failed", "refused", undefined, [], "not-applied"));
      await expect(controller.createSession({ runtime: "gjc", workspace: dir, isolation: "worktree", worktreeBranch: "issue-7-fix" })).rejects.toThrow();
      expect((await execFile("git", ["-C", dir, "worktree", "list", "--porcelain"])).stdout).not.toContain("issue-7-fix");
      expect(await branchExists(dir, "issue-7-fix")).toBe(true);
    } finally {
      controller.dispose();
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("tracks a named branch that exists only on one remote instead of starting it from HEAD", async () => {
    // An issue branch pushed from another machine: `-b` made a new branch from
    // HEAD under the same name, which diverged from the pushed one.
    const parent = await mkdtemp(path.join(tmpdir(), "gajae-remote-issue-branch-"));
    const origin = path.join(parent, "origin");
    const dir = path.join(parent, "clone");
    const { controller, cli } = harness();
    try {
      await execFile("git", ["init", "-q", "-b", "main", origin]);
      await commit(origin, "base");
      await execFile("git", ["-C", origin, "checkout", "-qb", "issue-7-fix"]);
      const pushedTip = await commit(origin, "work-from-another-machine");
      await execFile("git", ["-C", origin, "checkout", "-q", "main"]);
      await execFile("git", ["clone", "-q", origin, dir]);
      expect(await branchExists(dir, "issue-7-fix")).toBe(false);

      cli.rawGlobal.mockResolvedValueOnce({ sessionId: "issue" } as never);
      const created = await controller.createSession({ runtime: "gjc", workspace: dir, isolation: "worktree", worktreeBranch: "issue-7-fix" });
      expect(await headOf(created.workspace)).toBe(pushedTip);
      expect(
        (await execFile("git", ["-C", dir, "rev-parse", "--abbrev-ref", "issue-7-fix@{upstream}"])).stdout.trim(),
      ).toBe("origin/issue-7-fix");

      cli.rawGlobal.mockResolvedValueOnce({ sessionId: "fresh" } as never);
      const fresh = await controller.createSession({ runtime: "gjc", workspace: dir, isolation: "worktree", worktreeBranch: "issue-8-new" });
      expect(await headOf(fresh.workspace)).toBe(await headOf(dir));
    } finally {
      controller.dispose();
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("fetches a fork pull's head into the branch it creates, and removes only that branch on failure", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "gajae-pull-head-"));
    const origin = path.join(parent, "origin");
    const dir = path.join(parent, "clone");
    const { controller, cli } = harness();
    try {
      await execFile("git", ["init", "-q", "-b", "main", origin]);
      await commit(origin, "base");
      await execFile("git", ["clone", "-q", origin, dir]);
      // GitHub keeps a fork pull's head under refs/pull/<n>/head of the base
      // repository; no branch of the base repository points at it.
      await execFile("git", ["-C", origin, "checkout", "-q", "--detach"]);
      const pullTip = await commit(origin, "fork-change");
      await execFile("git", ["-C", origin, "update-ref", "refs/pull/9/head", pullTip]);
      await execFile("git", ["-C", origin, "checkout", "-q", "main"]);

      cli.rawGlobal.mockResolvedValueOnce({ sessionId: "fork" } as never);
      const worktreePull = { remote: "origin", number: 9 };
      const created = await controller.createSession({ runtime: "gjc", workspace: dir, isolation: "worktree", worktreeBranch: "pr-9", worktreePull });
      expect(await headOf(created.workspace)).toBe(pullTip);
      expect(await headOf(dir)).not.toBe(pullTip);

      await execFile("git", ["-C", dir, "worktree", "remove", "--force", created.workspace]);
      await execFile("git", ["-C", dir, "branch", "-D", "pr-9"]);
      cli.rawGlobal.mockRejectedValueOnce(new SdkCliError("operation_failed", "refused", undefined, [], "not-applied"));
      await expect(controller.createSession({ runtime: "gjc", workspace: dir, isolation: "worktree", worktreeBranch: "pr-9", worktreePull })).rejects.toThrow();
      expect(await branchExists(dir, "pr-9")).toBe(false);

      await execFile("git", ["-C", dir, "branch", "pr-9", "main"]);
      cli.rawGlobal.mockRejectedValueOnce(new SdkCliError("operation_failed", "refused", undefined, [], "not-applied"));
      await expect(controller.createSession({ runtime: "gjc", workspace: dir, isolation: "worktree", worktreeBranch: "pr-9", worktreePull })).rejects.toThrow();
      expect(await branchExists(dir, "pr-9")).toBe(true);
    } finally {
      controller.dispose();
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("checks out the remote branch a CI fix names, and refuses to start one from HEAD", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "gajae-remote-branch-"));
    const origin = path.join(parent, "origin");
    const dir = path.join(parent, "clone");
    const { controller, cli } = harness();
    try {
      await execFile("git", ["init", "-q", "-b", "main", origin]);
      await commit(origin, "base");
      await execFile("git", ["-C", origin, "checkout", "-qb", "feat/ci"]);
      const remoteTip = await commit(origin, "ci-change");
      await execFile("git", ["-C", origin, "checkout", "-q", "main"]);
      await execFile("git", ["clone", "-q", origin, dir]);
      expect(await branchExists(dir, "feat/ci")).toBe(false);

      cli.rawGlobal.mockResolvedValueOnce({ sessionId: "ci" } as never);
      const created = await controller.createSession({ runtime: "gjc", workspace: dir, isolation: "worktree", worktreeBranch: "feat/ci", worktreeBranchExisting: true });
      expect(await headOf(created.workspace)).toBe(remoteTip);
      expect(await branchExists(dir, "feat/ci")).toBe(true);

      cli.rawGlobal.mockClear();
      await expect(controller.createSession({ runtime: "gjc", workspace: dir, isolation: "worktree", worktreeBranch: "feat/nowhere", worktreeBranchExisting: true })).rejects.toThrow("feat/nowhere");
      expect(await branchExists(dir, "feat/nowhere")).toBe(false);
      expect(cli.rawGlobal).not.toHaveBeenCalled();
    } finally {
      controller.dispose();
      await rm(parent, { recursive: true, force: true });
    }
  });
});

/**
 * Runtime-backed slash discovery and the SDK control commands.
 *
 * The palette has two lifetimes: before GJC publishes an
 * `available_commands_update` this window synthesizes dynamic entries from the
 * runtime's own session state, and after it the runtime's list is the authority.
 * These tests pin both, plus the rule that a recognized command whose capability
 * is missing is refused instead of being forwarded as prompt text.
 */
describe("SDK slash commands", () => {
  const capabilityRows = (...operations: string[]) => [{ operations }];

  it("keeps transcript reads free of command and todo queries", async () => {
    const { controller, cli, internals } = harness();
    const root = await mkdtemp(path.join(tmpdir(), "gjc-context-"));
    const file = path.join(root, "session.jsonl");
    await writeFile(file, "", "utf8");
    internals.sessions.set("s1", session());
    internals.terminalOnlySessions.add("s1");
    internals.sharedSessionFiles.set("s1", file);
    try {
      await controller.getTranscript("s1");
      expect(cli.queryItems).not.toHaveBeenCalled();

      await controller.refreshSessionContext("s1");
      expect(cli.queryItems).toHaveBeenCalled();
    } finally {
      controller.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not query model profiles while reading an attached transcript", async () => {
    const { controller, cli, internals } = harness();
    internals.sessions.set("s1", session());
    internals.attachedSessions.add("s1");
    internals.activePromptSessions.add("s1");
    internals.transcripts.set("s1", [
      {
        id: "m1",
        kind: "message",
        sessionId: "s1",
        role: "assistant",
        content: "hi",
        createdAt: "t",
      },
    ]);
    try {
      await expect(controller.getTranscript("s1")).resolves.toMatchObject([
        { id: "m1", content: "hi" },
      ]);
      await vi.waitFor(() => {
        expect(
          cli.queryItems.mock.calls.map(
            (call) => (call as readonly unknown[])[1],
          ),
        ).toEqual(["workflow.gates.list"]);
      });
    } finally {
      controller.dispose();
    }
  });

  it("keeps the last delivered safety baseline across transcript and page reads", async () => {
    const { controller, internals } = harness();
    const user = (index: number, content = `request ${index}`) => ({
      id: `user-${index}`,
      kind: "message" as const,
      sessionId: "s1",
      role: "user" as const,
      content,
      createdAt: `t${index}`,
    });
    const assistant = (index: number, content = `response ${index}`) => ({
      id: `response-${index}`,
      kind: "message" as const,
      sessionId: "s1",
      role: "assistant" as const,
      content,
      createdAt: `t${index}`,
    });
    const conversation = (count: number) =>
      Array.from({ length: count }, (_, index) => [user(index), assistant(index)]).flat();
    let rows = conversation(25);
    internals.sessions.set("s1", session());
    internals.readSharedTranscript = vi.fn(async () =>
      rows.map((row) => ({ ...row })),
    );
    try {
      const first = await controller.getTranscriptChanges("s1");
      expect(first.kind).toBe("full");
      if (first.kind !== "full") return;
      expect(first.items).toHaveLength(40);
      expect(first.items[0]?.id).toBe("user-5");
      expect(first.items.at(-1)?.id).toBe("response-24");

      rows = conversation(26);
      rows[11] = assistant(5, "edited response 5");
      // A watcher refresh can install newer rows before the safety-net request is
      // made. That cache update is not an acknowledgement that these rows reached
      // the renderer.
      internals.installTranscript("s1", rows.map((row) => ({ ...row })));

      // Another renderer can request a page without advancing this window's
      // last-delivered safety baseline either.
      const page = await controller.getTranscriptPage("s1");
      expect(page.items).toHaveLength(40);
      expect(page.items.map((item) => item.id)).toEqual(
        Array.from({ length: 20 }, (_, index) => [
          `user-${index + 6}`,
          `response-${index + 6}`,
        ]).flat(),
      );
      expect(page.firstId).toBe("user-6");
      expect(page.lastId).toBe("response-25");
      expect(page.requests.map((request) => request.id)).toEqual(
        Array.from({ length: 26 }, (_, index) => `user-${index}`),
      );

      const updated = await controller.getTranscriptChanges("s1");
      expect(updated).toEqual({
        kind: "patch",
        items: [
          { ...assistant(5, "edited response 5") },
          { ...user(25) },
          { ...assistant(25) },
        ],
      });
    } finally {
      controller.dispose();
    }
  });

  it("resolves a projected tool body from the installed transcript without cloning it", async () => {
    const { controller, internals } = harness();
    const output = `${"output-prefix ".repeat(200)}OUTPUT_SENTINEL`;
    const full = {
      id: "tool-cached",
      kind: "tool" as const,
      sessionId: "s1",
      name: "bash",
      description: "bash",
      status: "completed" as const,
      createdAt: "t1",
      output,
    };
    const projected = projectTranscriptItemForDelivery(full) as ToolActivity;
    internals.transcripts.set("s1", [full]);
    internals.getTranscript = vi.fn(() => {
      throw new Error("must not clone the whole transcript");
    });
    await expect(
      controller.readArtifact("s1", projected.outputArtifactId!),
    ).resolves.toMatchObject({ text: output, complete: true });
    expect(internals.getTranscript).not.toHaveBeenCalled();
  });

  it("projects completed tool bodies only at delivery and resolves their full source", async () => {
    const emit = vi.fn();
    const { controller, internals } = harness({ emit });
    const command = `${"command-prefix ".repeat(100)}COMMAND_SENTINEL`;
    const output = `${"output-prefix ".repeat(200)}OUTPUT_SENTINEL`;
    const toolRow = (body: string) => ({
      id: "tool-1",
      kind: "tool" as const,
      sessionId: "s1",
      name: "bash",
      description: "bash",
      command,
      status: "completed" as const,
      createdAt: "t1",
      output: body,
    });
    let rows = [toolRow(output)];
    internals.sessions.set("s1", session());
    internals.readSharedTranscript = vi.fn(async () =>
      rows.map((row) => ({ ...row })),
    );
    internals.refreshTranscriptAttachment = vi.fn();

    try {
      const full = await controller.getTranscript("s1");
      expect(full[0]).toMatchObject({ command, output });

      const page = await controller.getTranscriptPage("s1");
      const pageTool = page.items[0] as ToolActivity;
      expect(pageTool.command).not.toContain("COMMAND_SENTINEL");
      expect(pageTool.output).not.toContain("OUTPUT_SENTINEL");
      expect(pageTool.command).toContain("[Preview truncated;");
      expect(pageTool.output).toContain("[Preview truncated;");
      expect(pageTool.command!.length).toBeLessThan(400);
      expect(pageTool.output!.length).toBeLessThan(700);
      expect(pageTool.inputArtifactId).toMatch(
        new RegExp(`^${TRANSCRIPT_BODY_ARTIFACT_PREFIX}input-`, "u"),
      );
      expect(pageTool.outputArtifactId).toMatch(
        new RegExp(`^${TRANSCRIPT_BODY_ARTIFACT_PREFIX}output-`, "u"),
      );

      const initial = await controller.getTranscriptChanges("s1");
      expect(initial.kind).toBe("full");
      if (initial.kind !== "full") return;
      const initialTool = initial.items[0] as ToolActivity;
      expect(initialTool.command).toBe(pageTool.command);
      expect(initialTool.output).toBe(pageTool.output);
      expect(initialTool.outputArtifactId).toBe(pageTool.outputArtifactId);
      await expect(
        controller.readArtifact("s1", initialTool.outputArtifactId!),
      ).resolves.toMatchObject({ text: output, complete: true });
      await expect(
        controller.readArtifact("s1", initialTool.inputArtifactId!),
      ).resolves.toMatchObject({ text: command, complete: true });

      const emittedRow = toolRow(output);
      internals.emitEvent({ type: "transcript.appended", item: emittedRow });
      internals.emitEvent({ type: "tool.updated", tool: emittedRow });
      internals.emitEvent({
        type: "transcript.synced",
        sessionId: "s1",
        items: [emittedRow],
      });
      expect(emit.mock.calls[0]?.[0]).toMatchObject({
        type: "transcript.appended",
        item: {
          command: pageTool.command,
          output: pageTool.output,
          inputArtifactId: pageTool.inputArtifactId,
          outputArtifactId: pageTool.outputArtifactId,
        },
      });
      expect(emit.mock.calls[1]?.[0]).toMatchObject({
        type: "tool.updated",
        tool: {
          command: pageTool.command,
          output: pageTool.output,
          outputArtifactId: pageTool.outputArtifactId,
        },
      });
      expect(emit.mock.calls[2]?.[0]).toMatchObject({
        type: "transcript.synced",
        items: [
          {
            command: pageTool.command,
            output: pageTool.output,
            outputArtifactId: pageTool.outputArtifactId,
          },
        ],
      });

      const samePreviewNewOutput = `${"output-prefix ".repeat(200)}SECOND_SENTINEL`;
      rows = [toolRow(samePreviewNewOutput)];
      const changed = await controller.getTranscriptChanges("s1");
      expect(changed.kind).toBe("patch");
      if (changed.kind !== "patch") return;
      const changedTool = changed.items[0] as ToolActivity;
      expect(changedTool.output).toBe(initialTool.output);
      expect(changedTool.outputArtifactId).not.toBe(initialTool.outputArtifactId);
      await expect(
        controller.readArtifact("s1", changedTool.outputArtifactId!),
      ).resolves.toMatchObject({ text: samePreviewNewOutput, complete: true });
      await expect(
        controller.readArtifact("s1", initialTool.outputArtifactId!),
      ).rejects.toThrow(/Stale transcript body artifact reference/u);
      expect(internals.cli.rawQuery).not.toHaveBeenCalled();
    } finally {
      controller.dispose();
    }
  });

  it("keeps live tool source full and redacted while emitting only a preview", async () => {
    const artifactDirectory = await mkdtemp(
      path.join(tmpdir(), "tool-body-source-"),
    );
    const emit = vi.fn();
    const { controller, internals } = harness({ emit, artifactDirectory });
    const inputText = `${"c".repeat(13_000)}COMMAND_SENTINEL`;
    const outputText = `${"o".repeat(13_000)}OUTPUT_SENTINEL`;
    const secret = "sk-live-redaction-token-123456";
    internals.sessions.set("s1", session());

    try {
      internals.upsertTool("s1", {
        sessionUpdate: "tool_call",
        toolCallId: "live-tool",
        title: "bash",
        status: "completed",
        rawInput: { command: inputText, token: secret },
        rawOutput: `${outputText} ${secret}`,
      });

      const row = internals.transcripts
        .get("s1")
        .find((item: TranscriptItem) => item.kind === "tool") as ToolActivity;
      expect(row.command).toContain(inputText);
      expect(row.command).toContain("[REDACTED]");
      expect(row.command).not.toContain(secret);
      expect(row.command!.length).toBeGreaterThan(12_000);
      expect(row.output).toContain(outputText);
      expect(row.output).toContain("[REDACTED]");
      expect(row.output).not.toContain(secret);
      expect(row.output!.length).toBeGreaterThan(12_000);

      const emitted = emit.mock.calls[0]?.[0] as
        | { type: string; item: ToolActivity }
        | undefined;
      expect(emitted?.type).toBe("transcript.appended");
      expect(emitted?.item.command).not.toContain("COMMAND_SENTINEL");
      expect(emitted?.item.output).not.toContain("OUTPUT_SENTINEL");
      expect(emitted?.item.inputArtifactId).toBe(row.inputArtifactId);
      expect(emitted?.item.outputArtifactId).toBe(row.outputArtifactId);
    } finally {
      await Promise.all(internals.artifactWrites.values());
      controller.dispose();
      await rm(artifactDirectory, { recursive: true, force: true });
    }
  });

  it("discovers skills on attach and lets a later pass remove one", async () => {
    const { cli, internals } = harness();
    internals.sessions.set("s1", session());
    internals.sessionCwds.set("s1", "/repo");
    const rows: Record<string, unknown[]> = {
      "runtime.capabilities": capabilityRows("skill.list/state"),
      "skill.list/state": [
        { name: "ci-green", description: "Make CI green" },
        { name: "hidden-skill", description: "not for the palette", hidden: true },
      ],
    };
    (cli.queryItems as any).mockImplementation(
      async (_id: string, query: string) => rows[query] ?? [],
    );

    await internals.refreshSdkCommands("s1");
    const discovered = internals.sessionCommands.get("s1") as Array<{
      name: string;
      hint?: string;
      description: string;
    }>;
    // `/skills` is this window's adapter spec for the same capability; the skill
    // entry is the synthesized one this test is about.
    expect(discovered.map((command) => command.name)).toEqual([
      "skills",
      "skill:ci-green",
    ]);
    expect(discovered[1]).toMatchObject({
      description: "Make CI green",
      hint: "[instructions]",
    });

    // A skill that disappears from runtime state leaves the palette with it.
    rows["skill.list/state"] = [{ name: "other-skill", description: "Other" }];
    await internals.refreshSdkCommands("s1");
    expect(
      (internals.sessionCommands.get("s1") as Array<{ name: string }>).map(
        (command) => command.name,
      ),
    ).toEqual(["skills", "skill:other-skill"]);
  });

  it("drops synthesized skills once the runtime advertises its own list", async () => {
    const { cli, internals } = harness();
    internals.sessions.set("s1", session());
    internals.sessionCwds.set("s1", "/repo");
    (cli.queryItems as any).mockImplementation(
      async (_id: string, query: string) =>
        query === "runtime.capabilities"
          ? capabilityRows("skill.list/state")
          : [{ name: "ci-green", description: "Make CI green" }],
    );
    await internals.refreshSdkCommands("s1");
    expect(
      (internals.sessionCommands.get("s1") as Array<{ name: string }>).map((c) => c.name),
    ).toContain("skill:ci-green");

    // An advertised list that names no skills is authority over the synthesized
    // set: the runtime said this session has none.
    await internals.refreshSdkCommands("s1", []);
    expect(
      (internals.sessionCommands.get("s1") as Array<{ name: string }>).map((c) => c.name),
    ).not.toContain("skill:ci-green");

    // And a new advertised list replaces the previous one whole.
    await internals.refreshSdkCommands("s1", [
      { name: "skill:other", description: "Other" },
    ]);
    await internals.refreshSdkCommands("s1", []);
    expect(
      (internals.sessionCommands.get("s1") as Array<{ name: string }>).map((c) => c.name),
    ).not.toContain("skill:other");
  });

  it("does not emit a command palette that matches the last one", async () => {
    const emit = vi.fn();
    const { controller, cli, internals } = harness({ emit });
    internals.sessions.set("s1", session());
    internals.sessionCwds.set("s1", "/repo");
    (cli.queryItems as any).mockResolvedValue(
      capabilityRows("session.metadata", "session.stats"),
    );
    await controller.refreshSessionContext("s1");
    const first = emit.mock.calls.filter(
      ([event]) => event.type === "session.commands",
    );
    expect(first).toHaveLength(1);
    emit.mockClear();
    await controller.refreshSessionContext("s1");
    expect(
      emit.mock.calls.filter(([event]) => event.type === "session.commands"),
    ).toHaveLength(0);
    expect(
      (internals.sessionCommands.get("s1") as Array<{ name: string }>).map(
        (command) => command.name,
      ),
    ).toContain("session");
  });

  it("shares one in-flight command rebuild between concurrent palette opens", async () => {
    const { controller, cli, internals } = harness();
    internals.sessions.set("s1", session());
    internals.sessionCwds.set("s1", "/repo");
    let release!: (rows: unknown[]) => void;
    const gate = new Promise<unknown[]>((resolve) => {
      release = resolve;
    });
    (cli.queryItems as any).mockImplementation(
      async (_id: string, query: string) =>
        query === "runtime.capabilities"
          ? gate
          : [{ name: "ci-green", description: "Make CI green" }],
    );
    const first = internals.refreshSdkCommands("s1");
    const second = internals.refreshSdkCommands("s1");
    release([{ operations: ["skill.list/state"] }]);
    await Promise.all([first, second]);
    expect(
      (cli.queryItems as any).mock.calls.filter(
        ([, query]: [string, string]) => query === "runtime.capabilities",
      ),
    ).toHaveLength(1);
    expect(
      (internals.sessionCommands.get("s1") as Array<{ name: string }>).map(
        (command) => command.name,
      ),
    ).toContain("skill:ci-green");
    controller.dispose();
  });

  it("reuses a recently loaded context instead of re-reading it on every palette open", async () => {
    const { controller, cli, internals } = harness();
    internals.sessions.set("s1", session());
    internals.sessionCwds.set("s1", "/repo");
    (cli.queryItems as any).mockResolvedValue(
      capabilityRows("session.metadata"),
    );
    await controller.refreshSessionContext("s1");
    const reads = (cli.queryItems as any).mock.calls.length;
    await controller.refreshSessionContext("s1");
    expect((cli.queryItems as any).mock.calls.length).toBe(reads);
    controller.dispose();
  });

  it("opens the model picker with its profiles from one read pass", async () => {
    const emit = vi.fn();
    const { controller, cli, internals } = harness({ emit });
    internals.sessions.set("s1", session());
    internals.sessionCwds.set("s1", "/repo");
    (cli.queryItems as any).mockImplementation(
      async (_id: string, query: string) => {
        if (query === "config.list/get")
          return [{ modelPreset: "profile-two" }];
        if (query === "models.profiles.list")
          return [
            {
              id: "profile-two",
              displayName: "Profile Two",
              source: "configured",
              available: true,
            },
            {
              id: "profile-one",
              displayName: "Profile One",
              source: "builtin",
              available: true,
            },
          ];
        return [];
      },
    );
    await internals.refreshSessionConfigOptions("s1");
    const configEvent = emit.mock.calls
      .map(([event]) => event)
      .find((event) => event.type === "session.config");
    expect(
      configEvent?.options
        .find((option: { id: string }) => option.id === "model")
        ?.options?.map((choice: { value: string }) => choice.value),
    ).toEqual(["profile-two", "profile-one"]);
    controller.dispose();
  });

  it("does not re-list model profiles when selecting one", async () => {
    const { controller, cli, internals } = harness();
    internals.sessions.set("s1", session());
    internals.sessionCwds.set("s1", "/repo");
    internals.sessionConfig.set("s1", [
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "profile-one",
        options: [
          { value: "profile-one", name: "Profile One" },
          { value: "profile-two", name: "Profile Two" },
        ],
      },
    ]);
    (cli.queryItems as any).mockImplementation(
      async (_id: string, query: string) =>
        query === "config.list/get"
          ? [{ modelPreset: "profile-two" }]
          : [],
    );
    await controller.setSessionConfig("s1", "model", "profile-two");
    expect(cli.rawControl).toHaveBeenCalledWith(
      "s1",
      "model.profile.set",
      { id: "profile-two" },
      expect.objectContaining({ repo: "/repo" }),
    );
    expect(
      (cli.queryItems as any).mock.calls.filter(
        ([, query]: [string, string]) => query === "models.profiles.list",
      ),
    ).toHaveLength(0);
    controller.dispose();
  });

  it("retries a failed command refresh and then publishes the new list", async () => {
    vi.useFakeTimers();
    const emit = vi.fn();
    const { controller, cli, internals } = harness({ emit });
    internals.sessions.set("s1", session());
    internals.sessionCwds.set("s1", "/repo");
    internals.sessionCommands.set("s1", [
      { name: "old", description: "stale", hint: "" },
    ]);
    let capabilityAttempts = 0;
    (cli.queryItems as any).mockImplementation(async (_id: string, query: string) => {
      if (query !== "runtime.capabilities") return [];
      capabilityAttempts += 1;
      if (capabilityAttempts === 1) throw new Error("capabilities down");
      return capabilityRows("session.metadata", "session.stats");
    });
    try {
      await internals.refreshSdkCommands("s1");
      expect(
        (internals.sessionCommands.get("s1") as Array<{ name: string }>).map(
          (command) => command.name,
        ),
      ).toEqual(["old"]);
      expect(
        emit.mock.calls.some(([event]) => event.type === "session.commands"),
      ).toBe(false);
      await vi.advanceTimersByTimeAsync(COMMAND_REFRESH_RETRY_BASE_MS);
      expect(capabilityAttempts).toBe(2);
      expect(
        (internals.sessionCommands.get("s1") as Array<{ name: string }>).map(
          (command) => command.name,
        ),
      ).toContain("session");
      expect(
        emit.mock.calls.some(
          ([event]) =>
            event.type === "session.commands" &&
            event.commands.some((command: { name: string }) => command.name === "session"),
        ),
      ).toBe(true);
    } finally {
      controller.dispose();
      vi.useRealTimers();
    }
  });

  it("honors a session config that disables skills", async () => {
    const { cli, internals } = harness();
    internals.sessions.set("s1", session());
    internals.sessionCwds.set("s1", "/repo");
    (cli.queryItems as any).mockImplementation(
      async (_id: string, query: string) => {
        if (query === "runtime.capabilities")
          return capabilityRows("skill.list/state", "config.list/get");
        if (query === "skill.list/state")
          return [{ name: "ci-green", description: "Make CI green" }];
        return [{ key: "skills", value: { enableSkillCommands: false } }];
      },
    );
    await internals.refreshSdkCommands("s1");
    expect(
      (internals.sessionCommands.get("s1") as Array<{ name: string }>).map((c) => c.name),
    ).not.toContain("skill:ci-green");
  });

  it("refuses /session delete unless the caller confirmed it", async () => {
    const { controller, cli, internals } = harness();
    internals.sessions.set("s1", session());
    internals.sessionCwds.set("s1", "/repo");
    (cli.queryItems as any).mockResolvedValue(
      capabilityRows("session.metadata", "session.stats"),
    );
    const remove = vi
      .spyOn(controller, "deleteSession")
      .mockResolvedValue(undefined);

    // This is the path a remote control device reaches: no confirmation option,
    // so the slash form cannot delete behind the desktop's approval boundary.
    await expect(
      controller.sendMessage("s1", {
        text: "/session delete",
        images: [],
        files: [],
      }),
    ).rejects.toThrow(/데스크톱 확인/u);
    expect(remove).not.toHaveBeenCalled();
    expect(cli.rawControl).not.toHaveBeenCalled();

    // The desktop path confirms first and then passes the explicit option.
    await controller.sendMessage(
      "s1",
      { text: "/session delete", images: [], files: [] },
      { allowDestructive: true },
    );
    expect(remove).toHaveBeenCalledExactlyOnceWith("s1");
  });

  it("confirms compact and goal termination slash forms too", async () => {
    const { controller, cli, internals } = harness();
    internals.sessions.set("s1", session());
    internals.sessionCwds.set("s1", "/repo");
    (cli.queryItems as any).mockResolvedValue(
      capabilityRows("compaction.run", "goal.list/get", "mode.goal.operate"),
    );
    const compact = vi.spyOn(controller, "compactSession").mockResolvedValue(undefined);
    for (const text of ["/compact", "/goal complete", "/goal drop"]) {
      await expect(
        controller.sendMessage("s1", { text, images: [], files: [] }),
      ).rejects.toThrow(/데스크톱/u);
    }
    expect(compact).not.toHaveBeenCalled();
    expect(cli.rawControl).not.toHaveBeenCalled();

    // The desktop confirms first and then passes the explicit option.
    await controller.sendMessage(
      "s1",
      { text: "/compact", images: [], files: [] },
      { allowDestructive: true },
    );
    expect(compact).toHaveBeenCalledExactlyOnceWith("s1");

    (cli.rawControl as any).mockResolvedValue({ accepted: true });
    await controller.sendMessage(
      "s1",
      { text: "/goal drop", images: [], files: [] },
      { allowDestructive: true },
    );
    expect(cli.rawControl).toHaveBeenCalledWith(
      "s1",
      "mode.goal.operate",
      { op: "drop" },
      expect.objectContaining({ repo: "/repo" }),
    );
  });

  it("refuses a recognized command the runtime does not advertise", async () => {
    const { controller, cli, internals } = harness();
    internals.sessions.set("s1", session());
    internals.sessionCwds.set("s1", "/repo");
    (cli.queryItems as any).mockResolvedValue(
      capabilityRows("session.rename"),
    );
    await expect(
      controller.sendMessage("s1", { text: "/tools", images: [], files: [] }),
    ).rejects.toThrow(/\/tools is unavailable in this GJC runtime/u);
    expect(cli.send).not.toHaveBeenCalled();
  });

  it("dispatches the added commands as semantic controls", async () => {
    const { controller, cli, internals } = harness();
    internals.sessions.set("s1", session());
    internals.sessionCwds.set("s1", "/repo");
    (cli.queryItems as any).mockImplementation(
      async (_id: string, query: string) => {
        if (query === "runtime.capabilities")
          return capabilityRows(
            "skill.list/state",
            "session.progress",
            "runtime.reload",
            "mode.plan.set",
          );
        if (query === "skill.list/state")
          return [{ name: "ci-green", description: "Make CI green" }];
        if (query === "session.progress")
          return [{ schema: "gjc.project_progress.v1", todos: { total: 2 } }];
        return [];
      },
    );
    (cli.rawControl as any).mockResolvedValue({ reloaded: true });

    await controller.sendMessage("s1", { text: "/skills", images: [], files: [] });
    await controller.sendMessage("s1", { text: "/progress", images: [], files: [] });
    await controller.sendMessage("s1", {
      text: "/reload skills,config",
      images: [],
      files: [],
    });
    expect(cli.rawControl).toHaveBeenCalledWith(
      "s1",
      "runtime.reload",
      { components: ["skills", "config"] },
      expect.objectContaining({ repo: "/repo" }),
    );
    await controller.sendMessage("s1", { text: "/plan off", images: [], files: [] });
    expect(cli.rawControl).toHaveBeenCalledWith(
      "s1",
      "mode.plan.set",
      { on: false },
      expect.objectContaining({ repo: "/repo" }),
    );
    expect(cli.send).not.toHaveBeenCalled();

    // A component the runtime would reject is refused here, before the round trip.
    await expect(
      controller.sendMessage("s1", { text: "/reload everything", images: [], files: [] }),
    ).rejects.toThrow(/Unknown reload component: everything/u);
    expect(cli.rawControl).toHaveBeenCalledTimes(2);
  });

  it("keeps /skill:<name> as agent work instead of an SDK control", async () => {
    const { controller, cli, internals } = harness();
    internals.sessions.set("s1", session());
    internals.sessionCwds.set("s1", "/repo");
    internals.transcripts.set("s1", []);
    internals.messageKeys.set("s1", new Map());
    internals.attachedSessions.add("s1");
    internals.awaitPromptSettlement = vi.fn(async () => undefined);
    await controller.sendMessage("s1", {
      text: "/skill:ci-green fix the build",
      images: [],
      files: [],
    });
    expect(cli.send).toHaveBeenCalledWith(
      "s1",
      "/skill:ci-green fix the build",
      expect.objectContaining({ opRef: expect.any(String) }),
    );
    expect(cli.rawControl).not.toHaveBeenCalled();
  });

  it("clears fast mode with the tier that omits the parameter and keeps a scoped tier", async () => {
    const { controller, cli, internals } = harness();
    internals.sessions.set("s1", { ...session(), serviceTier: "claude-only" });
    internals.sessionCwds.set("s1", "/repo");
    (cli.queryItems as any).mockResolvedValue(
      capabilityRows("service_tier.set"),
    );

    await controller.sendMessage("s1", { text: "/fast on", images: [], files: [] });
    expect(cli.rawControl).toHaveBeenCalledWith(
      "s1",
      "service_tier.set",
      { tier: "claude-only" },
      expect.objectContaining({ repo: "/repo" }),
    );
    expect(internals.sessions.get("s1")?.serviceTier).toBe("claude-only");

    await controller.sendMessage("s1", { text: "/fast off", images: [], files: [] });
    expect(cli.rawControl).toHaveBeenCalledWith(
      "s1",
      "service_tier.set",
      { tier: "none" },
      expect.objectContaining({ repo: "/repo" }),
    );
    expect(internals.sessions.get("s1")?.serviceTier).toBe("none");
    expect(cli.send).not.toHaveBeenCalled();
  });

  it("reports the configured fast tier and refuses a blind toggle", async () => {
    const { controller, cli, internals } = harness();
    internals.sessions.set("s1", session());
    internals.sessionCwds.set("s1", "/repo");
    (cli.queryItems as any).mockImplementation(
      async (_id: string, query: string) =>
        query === "runtime.capabilities"
          ? capabilityRows("service_tier.set")
          : [],
    );

    await expect(
      controller.sendMessage("s1", { text: "/fast", images: [], files: [] }),
    ).rejects.toThrow(/Use \/fast on or \/fast off/u);
    expect(cli.rawControl).not.toHaveBeenCalled();

    internals.sessions.set("s1", { ...session(), serviceTier: "priority" });
    await controller.sendMessage("s1", { text: "/fast status", images: [], files: [] });
    const status = internals.transcripts.get("s1")?.at(-1) as
      | { content?: string }
      | undefined;
    expect(status?.content).toContain("- Configured tier: priority");
    expect(status?.content).toContain("Configured intent only");
    expect(cli.send).not.toHaveBeenCalled();
  });

  it("rejects an unknown fast verb instead of prompting it", async () => {
    const { controller, cli, internals } = harness();
    internals.sessions.set("s1", session());
    internals.sessionCwds.set("s1", "/repo");
    (cli.queryItems as any).mockResolvedValue(
      capabilityRows("service_tier.set"),
    );
    await expect(
      controller.sendMessage("s1", { text: "/fast maybe", images: [], files: [] }),
    ).rejects.toThrow(/Usage: \/fast/u);
    expect(cli.send).not.toHaveBeenCalled();
  });
});

/**
 * Runtime activity visibility.
 *
 * The durable session file is the account a rebuild reads, and it carries less than
 * the runtime does: no plan, no todo store, no reason to keep a custom message the
 * runtime flagged `display: false`. These tests pin that the app keeps the activity
 * it actually observed, that a structured tool result survives the rebuild, and
 * that a todo store which cannot be read never renders as an empty list.
 */
describe("runtime activity visibility", () => {
  const systemRow = (
    internals: any,
    sessionId = "s1",
  ): { id: string; title: string; content: string; sourceType?: string } =>
    (internals.transcripts.get(sessionId) as Array<{ kind: string }>).find(
      (item: any) => item.kind === "system",
    ) as never;

  it("keeps a runtime-hidden custom message as labeled system activity", () => {
    const items = sharedTranscriptItems("s1", [
      {
        type: "custom_message",
        id: "c1",
        timestamp: "2026-01-01T00:00:00.000Z",
        customType: "irc",
        content: "peer-2: the migration is running",
        display: false,
      },
      {
        type: "custom_message",
        id: "c2",
        timestamp: "2026-01-01T00:00:01.000Z",
        customType: "skill-prompt",
        content: "run the release skill",
        display: true,
      },
      {
        type: "custom_message",
        id: "c3",
        timestamp: "2026-01-01T00:00:02.000Z",
        customType: "empty-hidden",
        content: "   ",
        display: false,
      },
    ]);
    // The recorded content is kept, and the recorded customType stays the label:
    // an unrecognized value is not reclassified into a known kind of activity.
    expect(items).toEqual([
      expect.objectContaining({
        kind: "system",
        title: "irc",
        content: "peer-2: the migration is running",
        sourceType: "irc",
        runtimeHidden: true,
      }),
      expect.objectContaining({
        kind: "system",
        title: "스킬",
        content: "run the release skill",
        sourceType: "skill-prompt",
      }),
    ]);
    // Only a row the runtime marked hidden is labeled as hidden.
    expect(items[1]).not.toHaveProperty("runtimeHidden");
    // A hidden row with no content is still nothing to show.
    expect(items).toHaveLength(2);
  });

  it("shows an in-flight call as running even after an earlier turn was aborted", () => {
    const rows = [
      { role: "user", content: [{ type: "text", text: "first" }] },
      { role: "assistant", stopReason: "aborted", content: [{ type: "toolCall", id: "old", name: "bash", arguments: {} }] },
      { role: "user", content: [{ type: "text", text: "second" }] },
      { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "live", name: "bash", arguments: {} }] },
    ];
    const status = (id: string, turnRunning: boolean) =>
      (sharedTranscriptItems("s1", rows, { turnRunning }).find((item) => item.id === id) as { status?: string }).status;
    expect(status("live", true)).toBe("running");
    // The abandoned turn's own call stays cancelled.
    expect(status("old", true)).toBe("cancelled");
    // Once the turn really ended, the unanswered call is not left spinning.
    expect(status("live", false)).toBe("cancelled");
  });

  it("keeps a structured tool result when the recorded body is empty", () => {
    const items = sharedTranscriptItems("s1", [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call-irc",
            name: "irc",
            arguments: { to: "peer-2", text: "migration status?" },
          },
          { type: "toolCall", id: "call-empty", name: "read", arguments: { path: "notes.txt" } },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "call-irc",
        body: "",
        content: [{ type: "text", text: "peer-2: running the migration now" }],
        details: {
          messages: [{ from: "peer-2", text: "running the migration now" }],
          apiKey: "sk-abcdefghijklmnopqrst",
        },
      },
      { role: "toolResult", toolCallId: "call-empty", body: "", content: [] },
    ]);
    const irc = items[0];
    expect(irc).toMatchObject({
      kind: "tool",
      id: "call-irc",
      name: "irc",
      status: "completed",
    });
    const output = (irc as { output?: string }).output ?? "";
    // The empty body no longer ends the search: the recorded text is used, and the
    // structured reply survives as data rather than being interpreted.
    expect(output).toContain("peer-2: running the migration now");
    expect(output).toContain('"messages"');
    // Credentials inside a retained payload are redacted by the existing helper.
    expect(output).not.toContain("sk-abcdefghijklmnopqrst");
    expect(output).toContain("[REDACTED]");
    // A result with nothing recorded stays without output instead of inventing one.
    expect(items[1]).not.toHaveProperty("output");
  });

  it("keeps an observed plan across a durable rebuild and honors an emptied plan", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "activity-plan-"));
    const previous = process.env.GJC_CODING_AGENT_DIR;
    process.env.GJC_CODING_AGENT_DIR = root;
    const { controller, internals } = harness();
    internals.sessions.set("s1", session());
    internals.sessionCwds.set("s1", "/repo");
    internals.transcripts.set("s1", []);
    try {
      await transcriptFile(root, "s1", [
        {
          type: "message",
          message: { role: "user", content: [{ type: "text", text: "start" }] },
        },
      ]);
      internals.handleSessionUpdate({
        sessionId: "s1",
        update: {
          sessionUpdate: "plan",
          entries: [
            { content: "keep the plan visible", status: "in_progress" },
            { content: "cover it with a test", status: "pending" },
          ],
        },
      });
      // The plan is a live-only fact: the durable file records no plan at all.
      await internals.refreshTranscriptFromFile("s1");
      const plan = (internals.transcripts.get("s1") as Array<any>).find(
        (item) => item.kind === "plan",
      );
      expect(plan?.entries.map((entry: any) => entry.content)).toEqual([
        "keep the plan visible",
        "cover it with a test",
      ]);

      // An update that really empties the plan clears the retained entries: the
      // rebuild must not resurrect the previous list.
      internals.handleSessionUpdate({
        sessionId: "s1",
        update: { sessionUpdate: "plan", entries: [] },
      });
      await internals.refreshTranscriptFromFile("s1");
      const emptied = (internals.transcripts.get("s1") as Array<any>).find(
        (item) => item.kind === "plan",
      );
      expect(emptied?.entries).toEqual([]);
    } finally {
      controller.dispose();
      if (previous === undefined) delete process.env.GJC_CODING_AGENT_DIR;
      else process.env.GJC_CODING_AGENT_DIR = previous;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("publishes the todo records the runtime returned without goal mode", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "activity-todo-"));
    const previous = process.env.GJC_CODING_AGENT_DIR;
    process.env.GJC_CODING_AGENT_DIR = root;
    const emit = vi.fn();
    const { controller, cli, internals } = harness({ emit });
    internals.sessions.set("s1", session());
    internals.sessionCwds.set("s1", "/repo");
    internals.transcripts.set("s1", []);
    const records = [{ id: "task-1", title: "Ship it", status: "pending" }];
    (cli.queryItems as any).mockImplementation(
      async (_id: string, query: string) => (query === "todo.list" ? records : []),
    );
    try {
      await transcriptFile(root, "s1", [
        {
          type: "message",
          message: { role: "user", content: [{ type: "text", text: "start" }] },
        },
      ]);
      await internals.readTodoRecords("s1");
      const row = systemRow(internals);
      expect(row).toMatchObject({
        id: "app-todo-s1",
        title: "Todos",
        sourceType: "todo.list",
      });
      expect(row.content).toContain("- records: 1");
      // The record itself is shown, not a task schema this window invented.
      expect(row.content).toContain('"title": "Ship it"');
      expect(
        emit.mock.calls.some(
          ([event]: any[]) =>
            event.type === "transcript.appended" && event.item.id === "app-todo-s1",
        ),
      ).toBe(true);

      // The goal counters share that observation; a disabled goal is not a reason
      // to hide the todo list.
      const goal = await controller.getGoal("s1");
      expect(goal.enabled).toBe(false);
      expect(goal.total).toBe(1);
      const todoListsBefore = (cli.queryItems as any).mock.calls.filter(
        ([, query]: [string, string]) => query === "todo.list",
      ).length;
      internals.attachedSessions.add("s1");
      await controller.getGoal("s1");
      await controller.getGoal("s1");
      const todoListsAfter = (cli.queryItems as any).mock.calls.filter(
        ([, query]: [string, string]) => query === "todo.list",
      ).length;
      expect(todoListsAfter).toBe(todoListsBefore);

      // A durable rebuild does not delete the source-backed snapshot row.
      await internals.refreshTranscriptFromFile("s1");
      expect(
        (internals.transcripts.get("s1") as Array<{ id: string }>).some(
          (item) => item.id === "app-todo-s1",
        ),
      ).toBe(true);
    } finally {
      controller.dispose();
      if (previous === undefined) delete process.env.GJC_CODING_AGENT_DIR;
      else process.env.GJC_CODING_AGENT_DIR = previous;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("backs off todo.list when the session has no live todo channel", async () => {
    vi.useFakeTimers();
    const { controller, cli, internals } = harness();
    internals.sessions.set("s1", session());
    internals.sessionCwds.set("s1", "/repo");
    internals.transcripts.set("s1", []);
    let todoLists = 0;
    (cli.queryItems as any).mockImplementation(async (_id: string, query: string) => {
      if (query === "todo.list") {
        todoLists += 1;
        return [{ id: "task-1", status: "pending" }];
      }
      return [];
    });
    try {
      await controller.getGoal("s1");
      await controller.getGoal("s1");
      await controller.getGoal("s1");
      expect(todoLists).toBe(1);
      await vi.advanceTimersByTimeAsync(TODO_EVENT_POLL_BASE_MS - 1);
      expect(todoLists).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(todoLists).toBe(2);
      internals.attachedSessions.add("s1");
      await controller.getGoal("s1");
      await vi.advanceTimersByTimeAsync(TODO_EVENT_POLL_BASE_MS * 4);
      expect(todoLists).toBe(2);
    } finally {
      controller.dispose();
      vi.useRealTimers();
    }
  });

  it("reports an unreadable todo store as unavailable, then as a stale last success", async () => {
    const { cli, internals } = harness();
    internals.sessions.set("s1", session());
    internals.sessionCwds.set("s1", "/repo");
    internals.transcripts.set("s1", []);
    (cli.queryItems as any).mockRejectedValue(
      new SdkCliError("todo_unavailable", "no Router attachment"),
    );
    await internals.readTodoRecords("s1");
    const unavailable = systemRow(internals);
    expect(unavailable.content).toContain(
      "- read failed: no Router attachment",
    );
    expect(unavailable.content).toContain("not an empty list");
    expect(unavailable.content).not.toContain("- records:");
    // Nothing successful was observed, so nothing is retained to show as stale.
    expect(internals.sessionTodoSnapshots.get("s1")?.rows).toBeUndefined();

    // A successful read that really returns nothing is an empty list, and says so.
    (cli.queryItems as any).mockResolvedValue([]);
    await internals.readTodoRecords("s1");
    const empty = systemRow(internals);
    expect(empty.content).toContain("- records: 0");
    expect(empty.content).not.toContain("read failed");

    (cli.queryItems as any).mockResolvedValue([
      { id: "task-1", title: "Ship it", status: "completed" },
    ]);
    await internals.readTodoRecords("s1");
    expect(systemRow(internals).content).toContain('"title": "Ship it"');

    // The last success is kept and explicitly marked stale -- never shown as the
    // current store, and never replaced by an empty list.
    (cli.queryItems as any).mockRejectedValue(new Error("provider unreachable"));
    await internals.readTodoRecords("s1");
    const stale = systemRow(internals);
    expect(stale.content).toContain("read failed: provider unreachable");
    expect(stale.content).toContain("stale");
    expect(stale.content).toContain('"title": "Ship it"');
    expect(stale.content).not.toContain("빈 목록이 아닙니다");
  });

  it("drops todo state with the session instead of resurrecting it", async () => {
    const { cli, internals } = harness();
    internals.sessions.set("s1", session());
    internals.sessionCwds.set("s1", "/repo");
    internals.transcripts.set("s1", []);
    let release: (rows: unknown[]) => void = () => undefined;
    (cli.queryItems as any).mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const pending = internals.readTodoRecords("s1");
    // Let the read reach the mocked runtime before the session is removed, so the
    // guard is exercised against a read that was genuinely in flight.
    await new Promise((resolve) => setTimeout(resolve, 10));
    internals.removeLocalSession("s1", false);
    release([]);
    await pending;
    expect(internals.sessionTodoSnapshots.has("s1")).toBe(false);
    expect(internals.todoReads.has("s1")).toBe(false);
    expect(internals.transcripts.has("s1")).toBe(false);
  });

  it("shares one todo read between callers that arrive together", async () => {
    const { cli, internals } = harness();
    internals.sessions.set("s1", session());
    internals.sessionCwds.set("s1", "/repo");
    internals.transcripts.set("s1", []);
    let reads = 0;
    (cli.queryItems as any).mockImplementation(async () => {
      reads += 1;
      return [];
    });
    await Promise.all([
      internals.readTodoRecords("s1"),
      internals.readTodoRecords("s1"),
      internals.readTodoRecords("s1"),
    ]);
    expect(reads).toBe(1);
  });
});

/**
 * The durable read is the authoritative account of a session, but it is written after
 * the fact: the live wire shows a streamed reply, reasoning block, or tool card while
 * the file behind it is still catching up. Replacing the transcript with the read
 * dropped those rows, and the shorter-history sync that followed could not re-add
 * them, so reasoning and bash cards appeared only once the turn that produced them
 * finished.
 */
describe("live rows across a durable rebuild", () => {
  /** A controller whose session file lives in a private agent directory. */
  async function rebuildHarness() {
    const root = await mkdtemp(path.join(tmpdir(), "live-rows-"));
    const previous = process.env.GJC_CODING_AGENT_DIR;
    process.env.GJC_CODING_AGENT_DIR = root;
    const app = harness({ artifactDirectory: path.join(root, "artifacts") });
    app.internals.sessions.set("s1", session());
    app.internals.sessionCwds.set("s1", "/repo");
    app.internals.transcripts.set("s1", []);
    return {
      ...app,
      root,
      cleanup: async () => {
        const writes = [...app.internals.artifactWrites.values()];
        app.controller.dispose();
        await Promise.allSettled(writes);
        if (previous === undefined) delete process.env.GJC_CODING_AGENT_DIR;
        else process.env.GJC_CODING_AGENT_DIR = previous;
        await rm(root, { recursive: true, force: true });
      },
    };
  }

  const rows = (internals: any): any[] => internals.transcripts.get("s1") ?? [];
  const ids = (internals: any): string[] =>
    rows(internals).map((item) => item.id);

  /**
   * The session file as the runtime leaves it: newline-terminated records.
   *
   * `transcriptFile` ends the file on the last record, and the reader rightly treats a
   * trailing record without its newline as a write still in progress -- it holds that
   * line back until the terminator arrives. These tests are about the rows the durable
   * read carries, so their file is written the way an append leaves it.
   */
  async function durableFile(
    root: string,
    id: string,
    records: unknown[],
  ): Promise<void> {
    const directory = path.join(root, "sessions", "v2-bucket");
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, `2026-01-01T00-00-00-000Z_${id}.jsonl`),
      `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
      "utf8",
    );
  }
  const userRow = {
    type: "message",
    id: "u1",
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { role: "user", content: [{ type: "text", text: "정리해줘" }] },
  };
  const messageChunk = (messageId: string, text: string) => ({
    sessionId: "s1",
    update: {
      sessionUpdate: "agent_message_chunk",
      messageId,
      content: { type: "text", text },
    },
  });
  const thoughtChunk = (messageId: string, text: string) => ({
    sessionId: "s1",
    update: {
      sessionUpdate: "agent_thought_chunk",
      messageId,
      content: { type: "text", text },
    },
  });
  const toolCall = (toolCallId: string) => ({
    sessionId: "s1",
    update: {
      sessionUpdate: "tool_call",
      toolCallId,
      title: "bash",
      rawInput: { command: "npm test" },
      status: "in_progress",
    },
  });

  it("keeps the reply and reasoning block the live wire is still streaming", async () => {
    const { internals, root, cleanup } = await rebuildHarness();
    try {
      await durableFile(root, "s1", [userRow]);
      internals.handleSessionUpdate(messageChunk("m2", "정리했습니다"));
      internals.handleSessionUpdate(thoughtChunk("m3", "무엇을 고칠지 보는 중"));
      // The file records neither block: the read is the user row and nothing else.
      await internals.refreshTranscriptFromFile("s1");
      expect(ids(internals)).toEqual([
        "shared-message-u1",
        "gjc-message-m2",
        "gjc-thought-m3",
      ]);
      // Both are still live, so the deltas that follow land on them instead of
      // starting the blocks again.
      internals.handleSessionUpdate(thoughtChunk("m3", " (계속)"));
      internals.handleSessionUpdate(messageChunk("m2", " — 확인 완료"));
      expect(
        rows(internals).find((item) => item.id === "gjc-thought-m3")?.content,
      ).toBe("무엇을 고칠지 보는 중 (계속)");
      expect(
        rows(internals).find((item) => item.id === "gjc-message-m2")?.content,
      ).toBe("정리했습니다 — 확인 완료");
      expect(rows(internals).filter((item) => item.kind === "thought")).toHaveLength(1);
      expect(
        rows(internals).filter(
          (item) => item.kind === "message" && item.role === "assistant",
        ),
      ).toHaveLength(1);
    } finally {
      await cleanup();
    }
  });

  it("keeps a tool card until the recorded call arrives, then replaces it in place", async () => {
    const { internals, root, cleanup } = await rebuildHarness();
    try {
      await durableFile(root, "s1", [userRow]);
      internals.handleSessionUpdate(toolCall("call-1"));
      await internals.refreshTranscriptFromFile("s1");
      expect(rows(internals).filter((item) => item.id === "call-1")).toHaveLength(1);
      expect(rows(internals).find((item) => item.id === "call-1")).toMatchObject({
        kind: "tool",
        status: "running",
      });

      // The call and its result reach the file. The card reconciles by the id the
      // runtime gave the call, so the rebuilt row replaces it rather than joining it.
      await durableFile(root, "s1", [
        userRow,
        {
          type: "message",
          id: "a1",
          timestamp: "2026-01-01T00:00:01.000Z",
          message: {
            role: "assistant",
            stopReason: "toolUse",
            content: [
              {
                type: "toolCall",
                id: "call-1",
                name: "bash",
                arguments: { command: "npm test" },
              },
            ],
          },
        },
        {
          type: "message",
          id: "r1",
          timestamp: "2026-01-01T00:00:02.000Z",
          message: {
            role: "toolResult",
            toolCallId: "call-1",
            toolName: "bash",
            body: "42 passing",
            content: [{ type: "text", text: "42 passing" }],
          },
        },
      ]);
      await internals.refreshTranscriptFromFile("s1");
      const rebuilt = rows(internals).filter((item) => item.id === "call-1");
      expect(rebuilt).toHaveLength(1);
      expect(rebuilt[0]).toMatchObject({ kind: "tool", status: "completed" });
      expect(rebuilt[0].output).toContain("42 passing");
    } finally {
      await cleanup();
    }
  });

  it("retires the streamed twin once the file records the turn's reply", async () => {
    const { internals, root, cleanup } = await rebuildHarness();
    try {
      await durableFile(root, "s1", [userRow]);
      internals.handleSessionUpdate(messageChunk("m2", "정리했습니다"));
      await durableFile(root, "s1", [
        userRow,
        {
          type: "message",
          id: "a1",
          timestamp: "2026-01-01T00:00:01.000Z",
          message: {
            role: "assistant",
            stopReason: "stop",
            content: [{ type: "text", text: "정리했습니다" }],
          },
        },
      ]);
      await internals.refreshTranscriptFromFile("s1");
      const replies = rows(internals).filter(
        (item) => item.kind === "message" && item.role === "assistant",
      );
      // Streamed once and recorded once: the terminal row is the block, and the row
      // the wire named is gone rather than standing beside it.
      expect(replies).toHaveLength(1);
      expect(replies[0].id).toBe("shared-message-a1");
      // A delta that arrives after the rebuild follows the block, not the dead id.
      internals.handleSessionUpdate(messageChunk("m2", " 확인 완료"));
      expect(
        rows(internals).find((item) => item.id === "shared-message-a1")?.content,
      ).toBe("정리했습니다 확인 완료");
      expect(
        rows(internals).filter(
          (item) => item.kind === "message" && item.role === "assistant",
        ),
      ).toHaveLength(1);
    } finally {
      await cleanup();
    }
  });

  it("clears retained rows when the turn is cancelled and when the session is deleted", async () => {
    const { controller, cli, internals, root, cleanup } = await rebuildHarness();
    try {
      await durableFile(root, "s1", [userRow]);
      internals.handleSessionUpdate(messageChunk("m2", "진행 중"));
      internals.handleSessionUpdate(thoughtChunk("m3", "정리하는 중"));
      await internals.refreshTranscriptFromFile("s1");
      expect(ids(internals)).toEqual([
        "shared-message-u1",
        "gjc-message-m2",
        "gjc-thought-m3",
      ]);

      // The user stops the run: the reply and the reasoning block stop streaming,
      // so the rebuild that follows no longer carries them.
      (cli.rawControl as any).mockResolvedValue({ turn: "stopped" });
      await controller.cancelRun("s1");
      await internals.refreshTranscriptFromFile("s1");
      const cancelledNotice = rows(internals).find((item) => item.kind === "notice" && item.title === "작업 취소됨");
      expect(cancelledNotice).toBeDefined();
      expect(ids(internals)).toEqual(["shared-message-u1", cancelledNotice.id]);

      // A call this window is still working is live in the same way, and the cancel
      // that cancelled it is what clears the card.
      internals.locallyAbortedSessions.delete("s1");
      internals.handleSessionUpdate(toolCall("call-4"));
      await internals.refreshTranscriptFromFile("s1");
      expect(ids(internals)).toEqual(["shared-message-u1", cancelledNotice.id, "call-4"]);
      await controller.cancelRun("s1");
      expect(
        rows(internals).find((item) => item.id === "call-4")?.status,
      ).toBe("cancelled");
      await internals.refreshTranscriptFromFile("s1");
      expect(ids(internals)).toEqual(["shared-message-u1", cancelledNotice.id]);

      // A deleted session takes the transcript the rows lived in with it.
      internals.removeLocalSession("s1", false);
      expect(internals.transcripts.has("s1")).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it("keeps a run-failure notice across a durable rebuild instead of dropping it like a toast", async () => {
    // A `GJC run failed` notice (id `gjc-error-N`) is appended live the same way
    // the cancelled notice is, so without a matching entry in the resync's
    // app-owned allowlist it would vanish the moment a durable rebuild ran --
    // leaving no more record of the failure than the app-error toast the issue
    // was about.
    const { controller, internals, root, cleanup } = await rebuildHarness();
    try {
      await durableFile(root, "s1", [userRow]);
      internals.appendTranscript({
        id: `gjc-error-${internals.nextLocalId++}`,
        kind: "notice",
        sessionId: "s1",
        title: "GJC run failed",
        content: "network timeout",
        tone: "warning",
        createdAt: "now",
      });
      await internals.refreshTranscriptFromFile("s1");
      const failureNotice = rows(internals).find(
        (item) => item.kind === "notice" && item.title === "GJC run failed",
      );
      expect(failureNotice).toBeDefined();
      expect(ids(internals)).toEqual(["shared-message-u1", failureNotice.id]);
      void controller;
    } finally {
      await cleanup();
    }
  });

  it("paces a tail reader that returns frames instead of spawning per frame", async () => {
    const { controller, cli, internals } = harness();
    internals.sessions.set("s1", session());
    internals.sessionCwds.set("s1", "/repo");
    internals.attachedSessions.add("s1");
    // A live stream returns as soon as it has data. Without a wait after a
    // non-empty answer the follower re-spawns immediately on every frame.
    (cli.tail as any).mockResolvedValue({
      source: "session",
      terminal: false,
      items: [{ kind: "activity", payload: {} }],
    });
    internals.startTailFollower("s1");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(cli.tail).toHaveBeenCalledTimes(1);
    internals.stopTailFollower("s1");
    controller.dispose();
  });

  it("polls the tail reader on the short window without spinning on an empty answer", async () => {
    const { controller, cli, internals } = harness();
    internals.sessions.set("s1", session());
    internals.sessionCwds.set("s1", "/repo");
    internals.attachedSessions.add("s1");
    // A reader that answers at once with nothing: without pacing it is spawned again
    // immediately, and a shorter window only makes that loop tighter.
    (cli.tail as any).mockResolvedValue({
      source: "session",
      terminal: false,
      items: [],
    });
    internals.startTailFollower("s1");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((cli.tail as any).mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ untilIdle: true, timeoutMs: TAIL_WINDOW_MS }),
    );
    expect(cli.tail).toHaveBeenCalledTimes(1);
    // Detaching ends the wait rather than holding the follower open.
    internals.stopTailFollower("s1");
    controller.dispose();
  });
});

describe("unwatched session detach", () => {
  it("releases an idle attached session outside the renderer cache after the grace period", async () => {
    vi.useFakeTimers();
    const { controller, internals } = harness();
    try {
      internals.sessions.set("s1", session());
      internals.attachedSessions.add("s1");
      internals.transcripts.set("s1", []);
      controller.watchTranscripts([]);
      await vi.advanceTimersByTimeAsync(UNWATCHED_DETACH_GRACE_MS);
      expect(internals.attachedSessions.has("s1")).toBe(false);
      expect(internals.transcripts.has("s1")).toBe(false);
    } finally {
      controller.dispose();
      vi.useRealTimers();
    }
  });

  it("keeps a watched session and cancels a pending detach", async () => {
    vi.useFakeTimers();
    const { controller, internals } = harness();
    try {
      internals.sessions.set("s1", session());
      internals.attachedSessions.add("s1");
      controller.watchTranscripts([]);
      await vi.advanceTimersByTimeAsync(UNWATCHED_DETACH_GRACE_MS / 2);
      controller.watchTranscripts(["s1"]);
      await vi.advanceTimersByTimeAsync(UNWATCHED_DETACH_GRACE_MS);
      expect(internals.attachedSessions.has("s1")).toBe(true);
    } finally {
      controller.dispose();
      vi.useRealTimers();
    }
  });

  it("does not detach a session whose turn is still running", async () => {
    vi.useFakeTimers();
    const { controller, internals } = harness();
    try {
      internals.sessions.set("s1", { ...session(), status: "running" });
      internals.attachedSessions.add("s1");
      controller.watchTranscripts([]);
      await vi.advanceTimersByTimeAsync(UNWATCHED_DETACH_GRACE_MS);
      expect(internals.attachedSessions.has("s1")).toBe(true);
    } finally {
      controller.dispose();
      vi.useRealTimers();
    }
  });
});

describe("owned session recovery", () => {
  it("recovers watched and running sessions with bounded concurrency", async () => {
    const { internals } = harness();
    internals.sessions.set("watched", { ...session("watched"), status: "idle" });
    internals.sessions.set("running", { ...session("running"), status: "running" });
    internals.sessions.set("unwatched", { ...session("unwatched"), status: "idle" });
    for (const id of ["watched", "running", "unwatched"])
      internals.sessionCwds.set(id, "/repo");
    internals.watchedTranscripts = new Set(["watched"]);
    let active = 0;
    let peak = 0;
    const attached: string[] = [];
    internals.ensureAttached = vi.fn(async (id: string) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      attached.push(id);
      active -= 1;
    });
    internals.discoveredRunState = vi.fn(async () => "idle");
    await internals.recoverOwnedSessions();
    expect(attached.sort()).toEqual(["running", "watched"]);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it("shares one recovery pass between startup and reconnect callers", async () => {
    const { internals } = harness();
    internals.sessions.set("s1", session());
    internals.sessionCwds.set("s1", "/repo");
    internals.watchedTranscripts = new Set(["s1"]);
    internals.ensureAttached = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    internals.discoveredRunState = vi.fn(async () => "idle");
    const first = internals.recoverOwnedSessions();
    const second = internals.recoverOwnedSessions();
    expect(second).toBe(first);
    await first;
    expect(internals.ensureAttached).toHaveBeenCalledTimes(1);
  });
});

describe("tool row index", () => {
  it("updates an early tool row without duplicating it", () => {
    const { internals } = harness();
    const tool = (id: string, status: string) => ({
      id,
      kind: "tool" as const,
      sessionId: "s1",
      name: "bash",
      description: "bash",
      status: status as "running" | "completed",
      createdAt: "now",
    });
    const items = [
      tool("early", "running"),
      ...Array.from({ length: 50 }, (_value, index) => ({
        id: `message-${index}`,
        kind: "message" as const,
        sessionId: "s1",
        role: "assistant" as const,
        content: `answer ${index}`,
        createdAt: "now",
      })),
      tool("late", "running"),
    ];
    internals.transcripts.set("s1", items);
    internals.reindexToolRows("s1", items);
    internals.upsertTool("s1", {
      sessionUpdate: "tool_call_update",
      toolCallId: "early",
      title: "bash",
      status: "completed",
    });
    const updated = internals.transcripts.get("s1");
    expect(updated).toHaveLength(items.length);
    expect(updated[0]).toMatchObject({ id: "early", status: "completed" });
    expect(internals.toolRowIndices.get("s1")?.get("early")).toBe(0);
  });
});

describe("context usage pacing", () => {
  it("runs at most one watcher repair per interval and still forces after settlement", async () => {
    const { cli, internals } = harness();
    internals.sessions.set("s1", session());
    (cli.queryItems as any).mockResolvedValue([{ usage: { percent: 12 } }]);
    await internals.refreshContextUsage("s1");
    await internals.refreshContextUsage("s1");
    expect(cli.queryItems).toHaveBeenCalledTimes(1);
    await internals.refreshContextUsage("s1", { force: true });
    expect(cli.queryItems).toHaveBeenCalledTimes(2);
  });

  it("trusts a live usage event instead of repairing it from the watcher", async () => {
    const { cli, internals } = harness();
    internals.sessions.set("s1", session());
    internals.handleSessionUpdate({
      sessionId: "s1",
      update: { sessionUpdate: "usage_update", used: 10, size: 100 },
    });
    await internals.refreshContextUsage("s1");
    expect(cli.queryItems).not.toHaveBeenCalled();
  });
});

describe("shared terminal session control", () => {
  it("clears a stale route failure after positive broker evidence and a successful probe", async () => {
    const { controller, internals } = harness();
    internals.sessions.set("s1", { ...session(), attachment: "terminal-only", ownership: "external" });
    internals.terminalOnlySessions.add("s1");
    internals.brokerSessions = vi.fn(async () => [{ sessionId: "s1", live: true, endpointGeneration: 1, repo: "/repo" }]);
    await internals.discoverSessions();
    expect(internals.terminalOnlySessions.has("s1")).toBe(false);
    controller.dispose();
  });

  it("does not list a broker-live row whose endpoint is proven stale, but keeps unproven ones", async () => {
    const { controller, cli, internals } = harness();
    internals.sessionMetadata = undefined;
    const rows = [
      { sessionId: "stale", live: true, deleted: false, endpointGeneration: 0, repo: "/repo" },
      { sessionId: "slow", live: true, deleted: false, endpointGeneration: 0, repo: "/repo" },
      { sessionId: "ok", live: true, deleted: false, endpointGeneration: 0, repo: "/repo" },
      { sessionId: "driven", live: true, deleted: false, endpointGeneration: 0, repo: "/repo" },
    ];
    internals.brokerSessions = vi.fn(async () => rows);
    internals.attachedSessions.add("driven");
    (cli.queryItems as any).mockImplementation(async (id: string) => {
      if (id === "stale") throw new SdkCliError("endpoint_stale", "The SDK endpoint is stale or unavailable.");
      if (id === "slow") throw new SdkCliError("timeout", "timed out");
      return [];
    });
    cli.listSessions.mockResolvedValue(rows.map((row) => ({ ...row, repo: "/repo" })) as never);
    const listed = (await internals.discoverSessions()).map((row: { id: string }) => row.id).sort();
    expect(listed).toEqual(["driven", "ok", "slow"]);
    expect(cli.queryItems).not.toHaveBeenCalledWith("driven", "session.metadata", expect.anything(), expect.anything());
    // A scan inside the retry interval reuses the proof instead of probing again.
    const probes = (cli.queryItems.mock.calls as unknown as string[][]).filter(([id]) => id === "stale").length;
    await internals.discoverSessions();
    expect((cli.queryItems.mock.calls as unknown as string[][]).filter(([id]) => id === "stale").length).toBe(probes);
    expect(cli.rawGlobal).not.toHaveBeenCalled();
    expect(cli.rawControl).not.toHaveBeenCalled();
    controller.dispose();
  });

  it("attaches to a reachable live generation-zero host without resuming or changing permissions", async () => {
    const { controller, cli, internals } = harness();
    internals.sessions.set("s1", { ...session(), ownership: "external" });
    internals.terminalOnlySessions.add("s1");
    cli.inspectSession.mockResolvedValue({ live: true, endpointGeneration: 0, repo: "/repo" } as never);
    internals.startTailFollower = vi.fn();
    internals.locateSharedTranscriptFile = vi.fn(async () => undefined);
    await internals.ensureAttached("s1", false);
    expect(cli.queryItems).toHaveBeenCalledWith("s1", "session.metadata", {}, { repo: "/repo" });
    expect(internals.terminalOnlySessions.has("s1")).toBe(false);
    expect(internals.sessions.get("s1").attachment).toBe("attached");
    expect(internals.sessions.get("s1").ownership).toBe("external");
    expect(cli.rawGlobal).not.toHaveBeenCalled();
    expect(cli.rawControl).not.toHaveBeenCalled();
    controller.dispose();
  });

  it("releases held work when the host only refuses the operator Stop", async () => {
    const { controller, cli, internals } = harness();
    internals.sessions.set("s1", { ...session(), ownership: "external", status: "running" });
    internals.attachedSessions.add("s1");
    // A directly launched TUI host has no indexed lifecycle identity for the broker
    // route the operator abort needs, while its public metadata route answers.
    cli.rawControl.mockRejectedValue(new SdkCliError("session_unavailable", "no lifecycle authority"));
    // Resolving true is the assertion that the owned-stop refusal never surfaced: the
    // renderer releases its held work as a steer instead of reading a blocking error.
    await expect(controller.flushQueuedNow("s1")).resolves.toBe(true);
    expect(cli.queryItems).toHaveBeenCalledWith("s1", "session.metadata", {}, { repo: "/repo" });
    expect(cli.rawControl).toHaveBeenCalledTimes(1);
    // The refusal is not mistaken for a lost session: the row keeps its controls.
    expect(internals.terminalOnlySessions.has("s1")).toBe(false);
    expect(internals.attachedSessions.has("s1")).toBe(true);
    controller.dispose();
  });

  it("leaves a finished row settled when the release cannot confirm a stop", async () => {
    const { controller, cli, internals } = harness();
    internals.sessions.set("s1", { ...session(), ownership: "external", status: "idle" });
    internals.attachedSessions.add("s1");
    internals.transcripts.set("s1", []);
    cli.rawControl.mockRejectedValue(new SdkCliError("session_unavailable", "no lifecycle authority"));
    // The transcript is the account of a turn nobody here drove: with nothing in
    // flight it answers idle, and the row must stay settled. Publishing running
    // instead made the renderer hand its next message over as a steer, so the text
    // sat in the queue behind a turn that had already ended.
    internals.discoveredRunState = vi.fn(async () => "idle" as const);
    await expect(controller.flushQueuedNow("s1")).resolves.toBe(true);
    expect(internals.sessions.get("s1")?.status).toBe("idle");
    controller.dispose();
  });

  it("keeps a running row running when the release cannot confirm a stop", async () => {
    const { controller, cli, internals } = harness();
    internals.sessions.set("s1", { ...session(), ownership: "external", status: "running" });
    internals.attachedSessions.add("s1");
    internals.transcripts.set("s1", []);
    cli.rawControl.mockRejectedValue(new SdkCliError("session_unavailable", "no lifecycle authority"));
    // A turn this window could not stop is still open, so the released work has to
    // arrive as a steer that its boundary consumes.
    internals.discoveredRunState = vi.fn(async () => "running" as const);
    await expect(controller.flushQueuedNow("s1")).resolves.toBe(true);
    expect(internals.sessions.get("s1")?.status).toBe("running");
    controller.dispose();
  });

  it("still fails the release when the metadata probe cannot reach the session", async () => {
    const { controller, cli, internals } = harness();
    internals.sessions.set("s1", session());
    cli.rawControl.mockRejectedValue(new SdkCliError("session_unavailable", "no route"));
    cli.queryItems.mockRejectedValue(new SdkCliError("session_unavailable", "no route"));
    await expect(controller.flushQueuedNow("s1")).rejects.toThrow("공유 제어 경로");
    expect(internals.terminalOnlySessions.has("s1")).toBe(true);
    controller.dispose();
  });

  it("falls back to the ordinary abort for a Stop the operator route refuses", async () => {
    const { controller, cli, internals } = harness();
    internals.sessions.set("s1", { ...session(), ownership: "external", status: "running" });
    internals.attachedSessions.add("s1");
    internals.transcripts.set("s1", []);
    (cli.rawControl as any).mockImplementation((_id: string, _op: string, input: Record<string, unknown>) =>
      input.operator
        ? Promise.reject(new SdkCliError("session_unavailable", "no lifecycle authority"))
        : Promise.resolve({ aborted: true }),
    );
    await expect(controller.cancelRun("s1")).resolves.toBeUndefined();
    // The fallback is the shape a CLI cancel uses: no mode, scope, or operator key,
    // and no confirm/idempotency flag either.
    expect(cli.rawControl).toHaveBeenNthCalledWith(2, "s1", "turn.abort", {}, { repo: "/repo" });
    expect(internals.sessions.get("s1").status).toBe("idle");
    expect(internals.terminalOnlySessions.has("s1")).toBe(false);
    expect(internals.attachedSessions.has("s1")).toBe(true);
    controller.dispose();
  });

  it("names the owned-work limit when a plain abort confirms the cancel", async () => {
    const { controller, cli, internals } = harness();
    internals.sessions.set("s1", { ...session(), ownership: "external", status: "running" });
    internals.attachedSessions.add("s1");
    internals.transcripts.set("s1", []);
    internals.liveRunningSessions.add("s1");
    (cli.rawControl as any).mockImplementation((_id: string, _op: string, input: Record<string, unknown>) =>
      input.operator
        ? Promise.reject(new SdkCliError("session_unavailable", "no lifecycle authority"))
        : Promise.resolve({ turn: "stopped" }),
    );
    await expect(controller.cancelRun("s1")).resolves.toBeUndefined();
    expect(internals.sessions.get("s1").status).toBe("idle");
    expect(internals.liveRunningSessions.has("s1")).toBe(false);
    const notice = (internals.transcripts.get("s1") ?? []).find(
      (item: { kind: string }) => item.kind === "notice",
    );
    expect(notice?.title).toBe("작업 취소됨");
    // One short sentence for the limit, not the blocking paragraph the operator
    // refusal used to be reported with.
    expect(notice?.content).toBe(
      "진행 중인 작업이 취소되어 종료됐습니다. 다만 이 호스트의 백그라운드 작업은 중지 여부가 확인되지 않았습니다.",
    );
    controller.dispose();
  });

  it("states the owned-work limit even when an earlier cancel is already noted", async () => {
    const notices = (transcripts: any[]) =>
      transcripts.filter((item: { kind: string }) => item.kind === "notice");
    const rebuilt = {
      id: "shared-cancelled-1",
      kind: "notice",
      sessionId: "s1",
      title: "작업 취소됨",
      content: "진행 중인 작업이 취소되어 종료됐습니다.",
      tone: "neutral",
      createdAt: "now",
    };
    // The rebuilt row already carries the plain sentence, so an operator-route cancel
    // of the same run adds nothing.
    const settled = harness();
    settled.internals.sessions.set("s1", { ...session(), status: "running" });
    settled.internals.transcripts.set("s1", [{ ...rebuilt }]);
    (settled.cli.rawControl as any).mockResolvedValue({ turn: "stopped" });
    await settled.controller.cancelRun("s1");
    expect(notices(settled.internals.transcripts.get("s1"))).toHaveLength(1);
    settled.controller.dispose();
    // A cancel that could not cover owned work states the limit instead of reusing
    // the earlier sentence that does not mention it.
    const fallback = harness();
    fallback.internals.sessions.set("s1", { ...session(), status: "running" });
    fallback.internals.transcripts.set("s1", [{ ...rebuilt }]);
    (fallback.cli.rawControl as any).mockImplementation((_id: string, _op: string, input: Record<string, unknown>) =>
      input.operator
        ? Promise.reject(new SdkCliError("session_unavailable", "no lifecycle authority"))
        : Promise.resolve({ aborted: true }),
    );
    await fallback.controller.cancelRun("s1");
    const appended = notices(fallback.internals.transcripts.get("s1"));
    expect(appended).toHaveLength(2);
    expect(appended[1].content).toContain("중지 여부가 확인되지 않았습니다");
    fallback.controller.dispose();
  });

  it("clears the row quietly when the plain abort finds no active turn", async () => {
    const { controller, cli, internals } = harness();
    internals.sessions.set("s1", { ...session(), ownership: "external", status: "running" });
    internals.attachedSessions.add("s1");
    internals.transcripts.set("s1", []);
    internals.liveRunningSessions.add("s1");
    internals.workingPhaseSessions.add("s1");
    (cli.rawControl as any).mockImplementation((_id: string, _op: string, input: Record<string, unknown>) =>
      input.operator
        ? Promise.reject(new SdkCliError("session_unavailable", "no lifecycle authority"))
        : Promise.resolve({ aborted: false, turn: "no_active_turn" }),
    );
    await expect(controller.cancelRun("s1")).rejects.toThrow(/중지 여부는 확인되지 않았습니다/u);
    expect(internals.sessions.get("s1").status).toBe("running");
    expect(internals.liveRunningSessions.has("s1")).toBe(true);
    expect(internals.workingPhaseSessions.has("s1")).toBe(true);
    // Nothing was stopped, so nothing announces a cancellation and the window does
    // not fence the session: live evidence of work elsewhere can still show.
    expect(internals.transcripts.get("s1")).toEqual([]);
    expect(internals.locallyAbortedSessions.has("s1")).toBe(false);
    controller.dispose();
  });

  it("keeps a genuinely unreachable host read-only without rehosting it", async () => {
    const { controller, cli, internals } = harness();
    internals.sessions.set("s1", session());
    internals.attachedSessions.add("s1");
    cli.rawControl.mockRejectedValue(new SdkCliError("session_unavailable", "no route"));
    cli.queryItems.mockRejectedValue(new SdkCliError("session_unavailable", "no route"));
    await expect(controller.cancelRun("s1")).rejects.toThrow("공유 제어 경로");
    expect(internals.terminalOnlySessions.has("s1")).toBe(true);
    expect(internals.attachedSessions.has("s1")).toBe(false);
    expect(cli.rawGlobal).not.toHaveBeenCalled();
    controller.dispose();
  });
});

/**
 * A session whose last word is a terminal assistant row reads running for as long as
 * a detached `task` launch marker is still in the transcript, because the job that
 * marker names may still be alive. A job the user pauses or cancels, or one taken
 * down with its process, writes no release row -- `custom_message/async-result` -- so
 * nothing in the file can ever settle it. `runtime.jobs.list` can, and these tests
 * cover that reconciliation, its throttle, and the release rows that must keep
 * working exactly as before.
 */
describe("detached task launch markers", () => {
  const taskLaunch = (jobId: string) => ({
    type: "message",
    id: `launch-${jobId}`,
    timestamp: "2026-01-01T00:00:01.000Z",
    message: {
      role: "toolResult",
      toolCallId: `call-${jobId}`,
      toolName: "task",
      content: [{ type: "text", text: "started in the background" }],
      details: { async: { state: "running", jobId, type: "task" } },
    },
  });
  const asyncResult = (jobId: string) => ({
    type: "custom_message",
    id: `async-${jobId}`,
    timestamp: "2026-01-01T00:00:01.500Z",
    customType: "async-result",
    content: "background task finished",
    details: { jobs: [{ jobId, status: "completed" }] },
  });
  const subagentAwait = (jobId: string) => ({
    type: "message",
    id: `await-${jobId}`,
    timestamp: "2026-01-01T00:00:01.500Z",
    message: {
      role: "toolResult",
      toolCallId: `call-await-${jobId}`,
      toolName: "subagent",
      content: [{ type: "text", text: "awaited" }],
      details: { awaitOutcome: "completed", terminalIds: [jobId] },
    },
  });
  const jobInspector = (jobId: string) => ({
    type: "message",
    id: `jobs-${jobId}`,
    timestamp: "2026-01-01T00:00:01.500Z",
    message: {
      role: "toolResult",
      toolCallId: `call-jobs-${jobId}`,
      toolName: "job",
      content: [{ type: "text", text: "job snapshot" }],
      details: { jobs: [{ id: jobId, type: "task", status: "completed" }] },
    },
  });
  const subagentInspector = (...subagents: unknown[]) => ({
    type: "message",
    id: "inspect-subagents",
    timestamp: "2026-01-01T00:00:01.500Z",
    message: {
      role: "toolResult",
      toolCallId: "call-inspect-subagents",
      toolName: "subagent",
      content: [{ type: "text", text: "subagent snapshot" }],
      details: { subagents },
    },
  });
  const terminalStop = () => ({
    type: "message",
    id: "assistant-final",
    timestamp: "2026-01-01T00:00:02.000Z",
    message: {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: "the task keeps running" }],
    },
  });
  const userRequest = () => ({
    type: "message",
    id: "user-next",
    timestamp: "2026-01-01T00:00:03.000Z",
    message: { role: "user", content: [{ type: "text", text: "status?" }] },
  });
  /** `runtime.jobs.list` answers one wrapper row, the way gjc/0.18.11 does. */
  const jobList = (...running: unknown[]) => [
    { running, recent: [], delivery: { queued: 0, delivering: false } },
  ];
  const runningJob = (id: string, status = "running") => ({
    id,
    type: "task",
    status,
    label: id,
  });

  /**
   * Ordinary tool activity that pushes a launch marker out of the run-state window.
   *
   * `readTranscriptTail` starts at the last 256KB, so a launch row buried under later
   * rows is invisible to every run-state read while the full-history read that installs
   * the session still sees it -- the discrepancy the reported session showed.
   */
  const paddingRows = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      type: "message",
      id: `pad-${index}`,
      timestamp: "2026-01-01T00:00:00.500Z",
      message: {
        role: "toolResult",
        toolCallId: `call-pad-${index}`,
        toolName: "read",
        content: [{ type: "text", text: `padding row ${index}` }],
      },
    }));

  /** One session whose transcript lives in a private agent directory. */
  async function markerHarness(rows: unknown[]) {
    const root = await mkdtemp(path.join(tmpdir(), "async-marker-"));
    const previous = process.env.GJC_CODING_AGENT_DIR;
    process.env.GJC_CODING_AGENT_DIR = root;
    const emit = vi.fn();
    const { controller, cli, internals } = harness({ emit });
    internals.sessions.set("s1", session());
    internals.sessionCwds.set("s1", "/repo");
    internals.transcripts.set("s1", []);
    await transcriptFile(root, "s1", rows);
    return {
      cli,
      emit,
      internals,
      /** Answers `runtime.jobs.list` and nothing else, like the real runtime. */
      jobs: (...running: unknown[]) => {
        (cli.queryItems as any).mockImplementation(
          async (_id: string, query: string) =>
            query === "runtime.jobs.list" ? jobList(...running) : [],
        );
      },
      cleanup: async () => {
        controller.dispose();
        if (previous === undefined) delete process.env.GJC_CODING_AGENT_DIR;
        else process.env.GJC_CODING_AGENT_DIR = previous;
        await rm(root, { recursive: true, force: true });
      },
    };
  }

  it("settles a session whose only running reason is a marker the runtime no longer runs", async () => {
    const { cli, emit, internals, jobs, cleanup } = await markerHarness([
      taskLaunch("job-1"),
      terminalStop(),
    ]);
    jobs();
    try {
      // The transcript on its own still reads running: the task was launched and its
      // release row never came.
      expect(
        persistedTranscriptRunning([taskLaunch("job-1"), terminalStop()]),
      ).toBe(true);
      expect(await internals.discoveredRunState("s1")).toBe("idle");
      expect(cli.queryItems).toHaveBeenCalledWith("s1", "runtime.jobs.list", {}, {
        repo: "/repo",
      });
      // The retired marker is remembered: an unchanged transcript is answered
      // without asking the runtime again.
      expect(await internals.discoveredRunState("s1")).toBe("idle");
      expect(cli.queryItems).toHaveBeenCalledTimes(1);
      // A durable rebuild meets the same rows and must not re-arm the latch.
      internals.pendingAsyncWorkSessions.set("s1", ["job-1"]);
      await internals.refreshTranscriptFromFile("s1");
      expect(internals.pendingAsyncWorkSessions.has("s1")).toBe(false);
      expect(await internals.discoveredRunState("s1")).toBe("idle");
      expect(cli.queryItems).toHaveBeenCalledTimes(1);
      // The row that was stuck at 작업 중 leaves it through the path the transcript
      // watcher uses.
      internals.sessions.get("s1").status = "running";
      await internals.republishRunState("s1");
      expect(internals.sessions.get("s1").status).toBe("idle");
      expect(
        emit.mock.calls.some(
          ([event]: any[]) =>
            event.type === "session.updated" && event.session.status === "idle",
        ),
      ).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("keeps a session running while the runtime still reports its task", async () => {
    const { cli, internals, jobs, cleanup } = await markerHarness([
      taskLaunch("job-1"),
      terminalStop(),
    ]);
    jobs(runningJob("job-1"));
    try {
      expect(await internals.discoveredRunState("s1")).toBe("running");
      expect(cli.queryItems).toHaveBeenCalledTimes(1);
      // Polling the same transcript answers from the recorded live set instead of
      // issuing the query again.
      expect(await internals.discoveredRunState("s1")).toBe("running");
      expect(cli.queryItems).toHaveBeenCalledTimes(1);
    } finally {
      await cleanup();
    }
  });

  it("releases markers the runtime no longer runs, whatever it settles with", async () => {
    // An entry the runtime still carries but does not call running is not live work.
    const statuses = ["completed", "failed", "cancelled", "paused"];
    for (const status of statuses) {
      const { internals, jobs, cleanup } = await markerHarness([
        taskLaunch("job-1"),
        terminalStop(),
      ]);
      jobs(runningJob("job-1", status));
      try {
        expect(await internals.discoveredRunState("s1")).toBe("idle");
      } finally {
        await cleanup();
      }
    }
    // A job that left the live list entirely (finished and reaped, or a process that
    // is gone) is not work in progress either.
    const { internals, jobs, cleanup } = await markerHarness([
      taskLaunch("job-1"),
      taskLaunch("job-2"),
      terminalStop(),
    ]);
    jobs(runningJob("job-2"));
    try {
      expect(await internals.discoveredRunState("s1")).toBe("running");
      expect(internals.asyncJobReconciliations.get("s1")?.deadJobIds.has("job-1")).toBe(
        true,
      );
      expect(internals.asyncJobReconciliations.get("s1")?.deadJobIds.has("job-2")).toBe(
        false,
      );
    } finally {
      await cleanup();
    }
    // An entry the runtime does not label at all is not evidence that the work ended.
    const unlabelled = await markerHarness([taskLaunch("job-1"), terminalStop()]);
    unlabelled.jobs({ id: "job-1", type: "task" });
    try {
      expect(await unlabelled.internals.discoveredRunState("s1")).toBe("running");
    } finally {
      await unlabelled.cleanup();
    }
  });

  it("does not present an unanswered job lookup as running or completed", async () => {
    const { cli, internals, cleanup } = await markerHarness([
      taskLaunch("job-1"),
      terminalStop(),
    ]);
    (cli.queryItems as any).mockRejectedValue(
      new SdkCliError("endpoint_stale", "The SDK endpoint is stale or unavailable."),
    );
    try {
      // An unanswered query is not evidence the work ended or is still running.
      expect(await internals.discoveredRunState("s1")).toBe("unknown");
      expect(await internals.discoveredRunState("s1")).toBe("unknown");
      // A failed attempt is throttled too, so a broken runtime is not re-queried on
      // every read.
      expect(cli.queryItems).toHaveBeenCalledTimes(1);
    } finally {
      await cleanup();
    }
  });

  it("re-checks a live task past the throttle instead of trusting it forever", async () => {
    const { cli, internals, jobs, cleanup } = await markerHarness([
      taskLaunch("job-1"),
      terminalStop(),
    ]);
    jobs(runningJob("job-1"));
    try {
      expect(await internals.discoveredRunState("s1")).toBe("running");
      // The user cancels the job from outside. The transcript never changes, so the
      // next check on the runtime is the only thing that can settle the row.
      jobs();
      const record = internals.asyncJobReconciliations.get("s1");
      internals.asyncJobReconciliations.set("s1", {
        ...record,
        checkedAt: record.checkedAt - 60_000,
      });
      expect(await internals.discoveredRunState("s1")).toBe("idle");
      expect(cli.queryItems).toHaveBeenCalledTimes(2);
      expect(internals.pendingAsyncWorkSessions.has("s1")).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it("reconciles persisted task markers on a latched live session during discovery", async () => {
    const { cli, internals, jobs, cleanup } = await markerHarness([
      taskLaunch("job-1"),
      terminalStop(),
    ]);
    jobs(runningJob("job-1"));
    internals.sessions.set("s1", { ...session(), status: "running" });
    internals.liveRunningSessions.add("s1");
    (cli.listSessions as any).mockResolvedValue([
      {
        sessionId: "s1",
        repo: "/repo",
        live: true,
        deleted: false,
        endpointGeneration: 1,
        runtime: "gjc",
      },
    ]);
    try {
      await internals.refreshTranscriptFromFile("s1");
      const transcriptPath = await internals.locateSharedTranscriptFile("s1");
      const transcriptSize = (await stat(transcriptPath)).size;
      expect(internals.pendingAsyncWorkSessions.get("s1")).toEqual(["job-1"]);
      expect(await internals.discoveredRunState("s1")).toBe("running");
      // The live report has gone quiet; the marker is now the sole unresolved
      // authority, while a fresh live report must continue to keep the row busy.
      internals.liveEvidenceAt.set("s1", Date.now() - LIVE_EVIDENCE_GRACE_MS - 1);

      // Keep session identity, transcript bytes, and the live latch fixed. Only the
      // runtime's authoritative job list changes after its normal throttle expires.
      const record = internals.asyncJobReconciliations.get("s1");
      internals.asyncJobReconciliations.set("s1", {
        ...record,
        checkedAt: record.checkedAt - 60_000,
      });
      jobs(runningJob("job-1", "paused"));
      const listed = await internals.listSessions();
      expect(cli.queryItems).toHaveBeenCalledTimes(2);
      expect((await stat(transcriptPath)).size).toBe(transcriptSize);
      expect(internals.pendingAsyncWorkSessions.has("s1")).toBe(false);
      expect(listed.find((row: any) => row.id === "s1")?.status).toBe("idle");
      expect(internals.sessions.get("s1").status).toBe("idle");

      // A failed/unknown runtime answer cannot retire the marker or settle the row.
      internals.sessions.get("s1").status = "running";
      internals.pendingAsyncWorkSessions.set("s1", ["job-1"]);
      internals.liveRunningSessions.add("s1");
      internals.liveEvidenceAt.set("s1", Date.now() - LIVE_EVIDENCE_GRACE_MS - 1);
      internals.asyncJobReconciliations.delete("s1");
      (cli.queryItems as any).mockRejectedValue(new Error("runtime unavailable"));
      const stillListed = await internals.listSessions();
      expect(internals.pendingAsyncWorkSessions.get("s1")).toEqual(["job-1"]);
      expect(stillListed.find((row: any) => row.id === "s1")?.status).toBe("unknown");
    } finally {
      await cleanup();
    }
  });

  it("does not ask the runtime while another reason keeps the session running", async () => {
    // The user asked a question the transcript has not answered yet: the newest
    // terminal assistant row is not the newest row, so the markers are not the only
    // reason this reads running.
    const { cli, internals, jobs, cleanup } = await markerHarness([
      taskLaunch("job-1"),
      terminalStop(),
      userRequest(),
    ]);
    jobs();
    try {
      expect(await internals.discoveredRunState("s1")).toBe("running");
      expect(cli.queryItems).not.toHaveBeenCalled();
    } finally {
      await cleanup();
    }
  });

  it("settles a session whose launch markers sit behind every window a run-state read parses", async () => {
    // The reported session's shape: the detached launches sit under a long run of
    // later rows, far outside the 256KB tail a run-state read parses. The full-history
    // read that installs a session latched both markers, every bounded run-state read
    // after that saw neither and computed idle, and the latch turned that idle back
    // into running -- so the row never left 작업 중 with no job running.
    const rows = [
      taskLaunch("job-1"),
      taskLaunch("job-2"),
      ...paddingRows(2000),
      terminalStop(),
    ];
    const { cli, internals, jobs, cleanup } = await markerHarness(rows);
    jobs();
    try {
      // The transcript on its own reads running: neither launch has a release row.
      expect(persistedTranscriptRunning(rows)).toBe(true);
      const filePath = await internals.locateSharedTranscriptFile("s1");
      const info = await stat(filePath);
      const tail = await readTranscriptTail(filePath, info.size, false);
      if (!tail) throw new Error("the bounded run-state window parsed no rows");
      // The window the bounded read parses on its own cannot see either marker, so
      // nothing in it can retire one.
      expect(
        tail.some((row: any) => row?.message?.toolName === "task"),
      ).toBe(false);
      expect(persistedTranscriptRunning(tail)).toBe(false);
      // The install path reads the whole file: this is where those markers are
      // known, and where the runtime has to be asked about them.
      await internals.refreshTranscriptFromFile("s1");
      expect(cli.queryItems).toHaveBeenCalledWith("s1", "runtime.jobs.list", {}, {
        repo: "/repo",
      });
      // Neither job runs any more, so the row leaves 작업 중 rather than holding
      // markers no read of the current window can even name.
      expect(await internals.discoveredRunState("s1")).toBe("idle");
      expect(internals.pendingAsyncWorkSessions.has("s1")).toBe(false);
      expect(cli.queryItems).toHaveBeenCalledTimes(1);
    } finally {
      await cleanup();
    }
  });

  it("keeps the row running when the job behind an out-of-window launch is still alive", async () => {
    // The complement of the test above: the window cannot see the launch marker, but
    // the job it names is still running. A window without that row is not evidence
    // the work ended, and a real detached task outlives the turn that launched it.
    const rows = [
      taskLaunch("job-1"),
      taskLaunch("job-2"),
      ...paddingRows(2000),
      terminalStop(),
    ];
    const { cli, internals, jobs, cleanup } = await markerHarness(rows);
    jobs(runningJob("job-1"));
    try {
      await internals.refreshTranscriptFromFile("s1");
      expect(await internals.discoveredRunState("s1")).toBe("running");
      expect(cli.queryItems).toHaveBeenCalledWith("s1", "runtime.jobs.list", {}, {
        repo: "/repo",
      });
      // Only the job the runtime still reports survives, and it is what the latch and
      // every later read rest on.
      expect(internals.pendingAsyncWorkSessions.get("s1")).toEqual(["job-1"]);
      expect(
        internals.asyncJobReconciliations.get("s1")?.deadJobIds.has("job-2"),
      ).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("classifies terminal foreground plus an unreachable job list as unknown", async () => {
    const rows = [taskLaunch("job-1"), ...paddingRows(2000), terminalStop()];
    const { cli, internals, cleanup } = await markerHarness(rows);
    (cli.queryItems as any).mockImplementation(
      async (_id: string, query: string) => {
        if (query === "runtime.jobs.list")
          throw new SdkCliError(
            "endpoint_stale",
            "The SDK endpoint is stale or unavailable.",
          );
        return [];
      },
    );
    try {
      await internals.refreshTranscriptFromFile("s1");
      // An unanswered query is not evidence the job ended or is still running. Keep
      // its ID, but do not present it as active work.
      expect(internals.pendingAsyncWorkSessions.get("s1")).toEqual(["job-1"]);
      expect(await internals.discoveredRunState("s1")).toBe("unknown");
      expect(await internals.discoveredRunState("s1")).toBe("unknown");
      expect(cli.queryItems).toHaveBeenCalledTimes(1);
    } finally {
      await cleanup();
    }
  });

  it("returns to running or idle when a later jobs query answers", async () => {
    const { cli, internals, cleanup } = await markerHarness([
      taskLaunch("job-1"),
      terminalStop(),
    ]);
    (cli.queryItems as any).mockRejectedValueOnce(
      new SdkCliError("endpoint_stale", "unavailable"),
    );
    try {
      expect(await internals.discoveredRunState("s1")).toBe("unknown");
      const failed = internals.asyncJobReconciliations.get("s1");
      internals.asyncJobReconciliations.set("s1", {
        ...failed,
        checkedAt: failed.checkedAt - 60_000,
      });
      (cli.queryItems as any).mockResolvedValue(jobList(runningJob("job-1")));
      expect(await internals.discoveredRunState("s1")).toBe("running");

      const running = internals.asyncJobReconciliations.get("s1");
      internals.asyncJobReconciliations.set("s1", {
        ...running,
        checkedAt: running.checkedAt - 60_000,
      });
      (cli.queryItems as any).mockResolvedValue(jobList());
      expect(await internals.discoveredRunState("s1")).toBe("idle");
      expect(internals.pendingAsyncWorkSessions.has("s1")).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it("keeps independently active foreground evidence running when jobs lookup fails", async () => {
    const { cli, internals, cleanup } = await markerHarness([
      taskLaunch("job-1"),
      terminalStop(),
      userRequest(),
    ]);
    (cli.queryItems as any).mockRejectedValue(
      new SdkCliError("endpoint_stale", "unavailable"),
    );
    try {
      expect(await internals.discoveredRunState("s1")).toBe("running");
      expect(cli.queryItems).not.toHaveBeenCalled();
    } finally {
      await cleanup();
    }
  });

  it("reconciles a latch no read of the cached file size could see", async () => {
    const { cli, internals, jobs, cleanup } = await markerHarness([
      taskLaunch("job-1"),
      terminalStop(),
    ]);
    jobs();
    try {
      // The marker is retired and the verdict cached against this file size.
      expect(await internals.discoveredRunState("s1")).toBe("idle");
      // A full-history read from before that job ended left a marker behind that this
      // file size cannot show. It must not be trusted on its own, and it must not
      // inherit the cached verdict's age either: the runtime was never asked about it.
      internals.pendingAsyncWorkSessions.set("s1", ["job-old"]);
      expect(await internals.discoveredRunState("s1")).toBe("idle");
      expect(internals.pendingAsyncWorkSessions.has("s1")).toBe(false);
      expect(cli.queryItems).toHaveBeenCalledTimes(2);
    } finally {
      await cleanup();
    }
  });

  it("settles an ordinary turn without asking the runtime anything", async () => {
    const { cli, internals, cleanup } = await markerHarness([
      userRequest(),
      terminalStop(),
    ]);
    try {
      // No launch marker and no latch: nothing here needs the runtime, so a finished
      // turn settles as soon as its terminal row is on disk.
      expect(await internals.discoveredRunState("s1")).toBe("idle");
      expect(cli.queryItems).not.toHaveBeenCalled();
    } finally {
      await cleanup();
    }
  });

  it("keeps the release rows the transcript writes for itself", () => {
    // A completed detached task, an awaited subagent, and a polled job inspector all
    // release the launch marker without any query: this is the state machine the
    // reconciliation must leave alone.
    for (const release of [
      asyncResult("job-1"),
      subagentAwait("job-1"),
      jobInspector("job-1"),
    ]) {
      expect(
        persistedTranscriptRunning([
          taskLaunch("job-1"),
          release,
          terminalStop(),
        ]),
      ).toBe(false);
    }
    // An unreleased marker still holds the session open, and a trailing user request
    // reopens it whatever the markers say.
    expect(
      persistedTranscriptRunning([taskLaunch("job-1"), terminalStop()]),
    ).toBe(true);
    expect(
      persistedTranscriptRunning([
        taskLaunch("job-1"),
        terminalStop(),
        userRequest(),
      ]),
    ).toBe(true);
  });

  it("releases only structured terminal subagent IDs from inspect results", () => {
    for (const status of ["completed", "failed", "cancelled"]) {
      expect(
        persistedTranscriptRunning([
          taskLaunch("job-1"),
          subagentInspector({ id: "agent-1", jobId: "job-1", status }),
          terminalStop(),
        ]),
      ).toBe(false);
    }

    for (const status of ["running", "paused", "unknown", "not_found"]) {
      expect(
        persistedTranscriptRunning([
          taskLaunch("job-1"),
          subagentInspector({ id: "agent-1", jobId: "job-1", status }),
          terminalStop(),
        ]),
      ).toBe(true);
    }

    expect(
      persistedTranscriptRunning([
        taskLaunch("job-1"),
        taskLaunch("job-2"),
        subagentInspector(
          { id: "agent-1", jobId: "job-1", status: "completed" },
          { id: "agent-2", jobId: "job-2", status: "running" },
        ),
        terminalStop(),
      ]),
    ).toBe(true);
    expect(
      persistedTranscriptRunning([
        taskLaunch("job-1"),
        subagentInspector({ id: "job-1", status: "completed" }),
        terminalStop(),
      ]),
    ).toBe(false);
  });

  it("re-adds a relaunched job after an earlier terminal subagent result", () => {
    expect(
      persistedTranscriptRunning([
        taskLaunch("job-1"),
        subagentInspector({ id: "agent-1", jobId: "job-1", status: "completed" }),
        taskLaunch("job-1"),
        terminalStop(),
      ]),
    ).toBe(true);
  });

  it("lets the last explicit subagent status win inside one result", () => {
    expect(
      persistedTranscriptRunning([
        taskLaunch("job-1"),
        subagentInspector(
          { id: "agent-1", jobId: "job-1", status: "completed" },
          { id: "agent-1", jobId: "job-1", status: "running" },
        ),
        terminalStop(),
      ]),
    ).toBe(true);
    expect(
      persistedTranscriptRunning([
        taskLaunch("job-1"),
        subagentInspector(
          { id: "agent-1", jobId: "job-1", status: "running" },
          { id: "agent-1", jobId: "job-1", status: "completed" },
        ),
        terminalStop(),
      ]),
    ).toBe(false);
    expect(
      persistedTranscriptRunning([
        taskLaunch("job-1"),
        subagentInspector({ id: "agent-1", jobId: "job-1", status: "already_completed" }),
        terminalStop(),
      ]),
    ).toBe(false);
    expect(
      persistedTranscriptRunning([
        taskLaunch("job-1"),
        subagentInspector({ status: "completed" }, { jobId: "job-1" }),
        terminalStop(),
      ]),
    ).toBe(true);
    expect(
      persistedTranscriptRunning([
        taskLaunch("job-1"),
        {
          type: "message",
          id: "conflict",
          timestamp: "2026-01-01T00:00:01.500Z",
          message: {
            role: "toolResult",
            toolCallId: "call-conflict",
            toolName: "subagent",
            content: [{ type: "text", text: "conflict" }],
            details: {
              subagents: [{ id: "agent-1", jobId: "job-1", status: "running" }],
              terminalIds: ["job-1"],
            },
          },
        },
        terminalStop(),
      ]),
    ).toBe(true);
  });

  it("follows transcript order when a later row carries an earlier timestamp", () => {
    expect(
      persistedTranscriptRunning([
        taskLaunch("job-1"),
        {
          ...subagentInspector({ id: "agent-1", jobId: "job-1", status: "completed" }),
          timestamp: "2026-01-01T00:00:09.000Z",
        },
        {
          ...taskLaunch("job-1"),
          id: "relaunch-older-clock",
          timestamp: "2026-01-01T00:00:00.100Z",
        },
        terminalStop(),
      ]),
    ).toBe(true);
  });

  it("marks an open session unknown without a completion notice, then announces once", async () => {
    const { cli, emit, internals, cleanup } = await markerHarness([
      taskLaunch("job-1"),
      terminalStop(),
    ]);
    internals.sessions.get("s1").status = "running";
    (cli.queryItems as any).mockRejectedValue(
      new SdkCliError("endpoint_stale", "unavailable"),
    );
    const completions = () =>
      emit.mock.calls.filter(
        ([event]: any[]) =>
          event.type === "session.activity" && event.category === "completed",
      );
    try {
      await internals.refreshTranscriptFromFile("s1");
      expect(internals.sessions.get("s1").status).toBe("unknown");
      expect(completions()).toHaveLength(0);

      const failed = internals.asyncJobReconciliations.get("s1");
      internals.asyncJobReconciliations.set("s1", {
        ...failed,
        checkedAt: failed.checkedAt - 60_000,
      });
      (cli.queryItems as any).mockResolvedValue(jobList());
      await internals.refreshTranscriptFromFile("s1");
      expect(internals.sessions.get("s1").status).toBe("idle");
      expect(completions()).toHaveLength(1);

      await internals.refreshTranscriptFromFile("s1");
      expect(completions()).toHaveLength(1);
    } finally {
      await cleanup();
    }
  });

  it("keeps foreground running when a latched job lookup later fails", async () => {
    const { cli, internals, cleanup } = await markerHarness([
      taskLaunch("job-1"),
      terminalStop(),
      userRequest(),
    ]);
    internals.sessions.get("s1").status = "running";
    (cli.queryItems as any).mockRejectedValue(
      new SdkCliError("endpoint_stale", "unavailable"),
    );
    try {
      expect(await internals.discoveredRunState("s1")).toBe("running");
      await internals.refreshTranscriptFromFile("s1");
      expect(internals.sessions.get("s1").status).toBe("running");
      expect(internals.pendingAsyncWorkSessions.get("s1")).toEqual(["job-1"]);
      expect(await internals.discoveredRunState("s1")).toBe("running");
    } finally {
      await cleanup();
    }
  });

  it("settles compaction after the runtime retires a stale launch marker", async () => {
    const { emit, internals, jobs, cleanup } = await markerHarness([
      taskLaunch("job-1"),
      terminalStop(),
      {
        type: "compaction",
        id: "compact-1",
        timestamp: "2026-01-01T00:00:04.000Z",
        summary: "compacted",
      },
    ]);
    jobs();
    internals.compactingSessions.add("s1");
    internals.compactionRecordBaseline.set("s1", 0);
    internals.workingPhaseSessions.add("s1");
    internals.sessions.get("s1").status = "running";
    internals.sessions.get("s1").phase = "compacting";
    try {
      await internals.refreshTranscriptFromFile("s1");
      expect(internals.compactingSessions.has("s1")).toBe(false);
      expect(internals.sessions.get("s1").status).toBe("idle");
      expect(internals.sessions.get("s1").phase).toBeUndefined();
      expect(
        emit.mock.calls.filter(
          ([event]: any[]) =>
            event.type === "session.activity" && event.category === "completed",
        ),
      ).toHaveLength(1);
    } finally {
      await cleanup();
    }
  });

  it("keeps compaction running for a stale record or an unreachable job list", async () => {
    const stale = await markerHarness([
      taskLaunch("job-1"),
      terminalStop(),
      {
        type: "compaction",
        timestamp: "2026-01-01T00:00:04.000Z",
        summary: "old",
      },
    ]);
    stale.jobs();
    stale.internals.compactingSessions.add("s1");
    stale.internals.compactionRecordBaseline.set("s1", 0);
    stale.internals.compactionStartedAt.set(
      "s1",
      Date.parse("2026-01-01T00:00:05.000Z"),
    );
    stale.internals.workingPhaseSessions.add("s1");
    stale.internals.sessions.get("s1").status = "running";
    stale.internals.sessions.get("s1").phase = "compacting";
    try {
      await stale.internals.refreshTranscriptFromFile("s1");
      expect(stale.internals.compactingSessions.has("s1")).toBe(true);
      expect(stale.internals.sessions.get("s1").status).toBe("running");
      expect(stale.internals.sessions.get("s1").phase).toBe("compacting");
    } finally {
      await stale.cleanup();
    }

    const unreachable = await markerHarness([
      taskLaunch("job-1"),
      terminalStop(),
      {
        type: "compaction",
        timestamp: "2026-01-01T00:00:04.000Z",
        summary: "compacted",
      },
    ]);
    (unreachable.cli.queryItems as any).mockRejectedValue(
      new SdkCliError("endpoint_stale", "unavailable"),
    );
    unreachable.internals.compactingSessions.add("s1");
    unreachable.internals.compactionRecordBaseline.set("s1", 0);
    unreachable.internals.workingPhaseSessions.add("s1");
    unreachable.internals.sessions.get("s1").status = "running";
    unreachable.internals.sessions.get("s1").phase = "compacting";
    try {
      await unreachable.internals.refreshTranscriptFromFile("s1");
      expect(unreachable.internals.compactingSessions.has("s1")).toBe(true);
      expect(unreachable.internals.sessions.get("s1").status).toBe("running");
      expect(unreachable.internals.sessions.get("s1").phase).toBe("compacting");
    } finally {
      await unreachable.cleanup();
    }
  });
});

describe("todo snapshot phases", () => {
  const systemRow = (internals: any): any =>
    (internals.transcripts.get("s1") as Array<{ kind: string }>).find(
      (item: any) => item.kind === "system",
    );

  it("maps the runtime's rows without inventing fields or statuses", () => {
    expect(
      todoSnapshotPhases([
        {
          name: "정리",
          tasks: [
            { content: "끝난 일", status: "completed" },
            { content: "하는 일", status: "in_progress", notes: ["메모", 7] },
            { title: "제목만 있는 행" },
          ],
        },
        { content: "phase 없이 돌아온 행", status: "pending" },
        { nonsense: true },
        "junk",
      ]),
    ).toEqual([
      {
        name: "정리",
        tasks: [
          { content: "끝난 일", status: "completed" },
          { content: "하는 일", status: "in_progress", notes: ["메모"] },
          { content: "제목만 있는 행" },
        ],
      },
      { tasks: [{ content: "phase 없이 돌아온 행", status: "pending" }] },
    ]);
  });

  it("attaches phases only to a snapshot the store actually answered", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "activity-todo-phases-"));
    const previous = process.env.GJC_CODING_AGENT_DIR;
    process.env.GJC_CODING_AGENT_DIR = root;
    const { cli, internals } = harness();
    internals.sessions.set("s1", session());
    internals.sessionCwds.set("s1", "/repo");
    internals.transcripts.set("s1", []);
    const records = [
      { name: "남은 일", tasks: [{ content: "카드 그리기", status: "in_progress" }] },
    ];
    (cli.queryItems as any).mockImplementation(
      async (_id: string, query: string) => (query === "todo.list" ? records : []),
    );
    try {
      await internals.readTodoRecords("s1");
      const answered = systemRow(internals);
      expect(answered.todoPhases).toEqual([
        { name: "남은 일", tasks: [{ content: "카드 그리기", status: "in_progress" }] },
      ]);
      expect(typeof answered.observedAt).toBe("string");

      // A read that fails keeps the last success in `content` but must not leave a
      // checklist behind: rendered as current it would claim stale rows are live.
      (cli.queryItems as any).mockRejectedValue(new SdkCliError("todo_unavailable", "no route"));
      await internals.readTodoRecords("s1");
      const stale = systemRow(internals);
      expect(stale.todoPhases).toBeUndefined();
      expect(stale.content).toContain("stale");
      expect(stale.content).toContain("카드 그리기");
    } finally {
      if (previous === undefined) delete process.env.GJC_CODING_AGENT_DIR;
      else process.env.GJC_CODING_AGENT_DIR = previous;
      await rm(root, { recursive: true, force: true });
    }
  });
});

/**
 * A live report arms an in-memory latch, and only another report releases it.
 *
 * Discovery also reuses a latched row's status instead of asking the transcript again,
 * so a session whose reports stopped kept the running status its last report set for
 * the life of the process: the sidebar held a finished row in its working group for 16
 * hours while a fresh controller process reading the same transcript reported idle.
 * These tests cover the aging that releases it and the guards that must survive it.
 */
describe("quiet live evidence", () => {
  const assistantFinal = () => ({
    type: "message",
    id: "assistant-final",
    timestamp: "2026-01-01T00:00:02.000Z",
    message: {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: "최신화 끝났습니다" }],
    },
  });
  const userRequest = () => ({
    type: "message",
    id: "user-1",
    timestamp: "2026-01-01T00:00:01.000Z",
    message: { role: "user", content: [{ type: "text", text: "최신화 해줘" }] },
  });
  /** Evidence older than the grace, and evidence still inside it. */
  const STALE = LIVE_EVIDENCE_GRACE_MS + 1_000;
  const FRESH = LIVE_EVIDENCE_GRACE_MS - 1_000;

  /**
   * One row left running by a live signal, with its transcript already recording the
   * end of the turn and the broker listing the session as live.
   */
  async function quietHarness(
    options: {
      latch?: (target: any) => void;
      evidenceAgeMs?: number;
      activePrompt?: boolean;
      transcript?: boolean;
    } = {},
  ) {
    const root = await mkdtemp(path.join(tmpdir(), "quiet-live-"));
    const previous = process.env.GJC_CODING_AGENT_DIR;
    process.env.GJC_CODING_AGENT_DIR = root;
    const emit = vi.fn();
    const { controller, cli, internals } = harness({ emit });
    internals.sessions.set("s1", { ...session(), status: "running" });
    internals.sessionCwds.set("s1", "/repo");
    internals.transcripts.set("s1", []);
    if (options.transcript !== false)
      await transcriptFile(root, "s1", [userRequest(), assistantFinal()]);
    (cli.listSessions as any).mockResolvedValue([
      {
        sessionId: "s1",
        repo: "/repo",
        live: true,
        deleted: false,
        endpointGeneration: 1,
        runtime: "gjc",
      },
    ]);
    (options.latch ?? ((target: any) => target.liveRunningSessions.add("s1")))(
      internals,
    );
    if (options.evidenceAgeMs !== undefined)
      internals.liveEvidenceAt.set("s1", Date.now() - options.evidenceAgeMs);
    if (options.activePrompt) internals.activePromptSessions.add("s1");
    return {
      emit,
      internals,
      list: () => controller.listSessions(),
      cleanup: async () => {
        controller.dispose();
        if (previous === undefined) delete process.env.GJC_CODING_AGENT_DIR;
        else process.env.GJC_CODING_AGENT_DIR = previous;
        await rm(root, { recursive: true, force: true });
      },
    };
  }

  it("settles a latched row once the transcript ends the turn and the reports stopped", async () => {
    const { emit, internals, list, cleanup } = await quietHarness({
      evidenceAgeMs: STALE,
    });
    try {
      // The transcript is the newer account: a fresh controller process reads the same
      // session as idle, which is what the report against the live app showed.
      expect(await internals.discoveredRunState("s1")).toBe("idle");
      const listed = await list();
      expect(listed.find((row) => row.id === "s1")?.status).toBe("idle");
      expect(internals.sessions.get("s1").status).toBe("idle");
      for (const latch of [
        internals.liveRunningSessions,
        internals.liveRunningDigests,
        internals.transcriptRunningSessions,
        internals.workingPhaseSessions,
        internals.runtimeIdleSessions,
        internals.compactingSessions,
        internals.discoveredRunStates,
        internals.liveEvidenceAt,
        internals.compactionRecordBaseline,
        internals.compactionStartedAt,
      ])
        expect(latch.has("s1")).toBe(false);
      // The renderer keeps its own status while it holds the higher revision, so the
      // settle has to publish a revision that outranks the running row.
      expect(internals.currentRunRevision("s1")).toBeGreaterThan(0);
      expect(emit).toHaveBeenCalledWith({
        type: "session.updated",
        session: expect.objectContaining({ id: "s1", status: "idle" }),
      });
    } finally {
      await cleanup();
    }
  });

  it("keeps a row running inside the grace, so a turn that just started does not flicker", async () => {
    const { internals, list, cleanup } = await quietHarness({ evidenceAgeMs: FRESH });
    try {
      // The transcript still describes the previous turn for the gap between a turn
      // starting and its first row reaching disk: the case the grace exists for.
      expect(await internals.discoveredRunState("s1")).toBe("idle");
      expect((await list()).find((row) => row.id === "s1")?.status).toBe("running");
      expect(internals.sessions.get("s1").status).toBe("running");
      expect(internals.liveRunningSessions.has("s1")).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("leaves a session this window is driving alone", async () => {
    const { internals, list, cleanup } = await quietHarness({
      evidenceAgeMs: STALE,
      activePrompt: true,
    });
    try {
      // The prompt's own round trip owns the status until it settles, whatever the
      // transcript says meanwhile.
      const revision = internals.currentRunRevision("s1");
      expect((await list()).find((row) => row.id === "s1")?.status).toBe("running");
      expect(internals.sessions.get("s1").status).toBe("running");
      expect(internals.currentRunRevision("s1")).toBe(revision);
      expect(internals.liveRunningSessions.has("s1")).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("ages a 'working' phase report that no later report followed", async () => {
    const { internals, list, cleanup } = await quietHarness({
      latch: (target: any) => target.workingPhaseSessions.add("s1"),
      evidenceAgeMs: STALE,
    });
    try {
      expect((await list()).find((row) => row.id === "s1")?.status).toBe("idle");
      expect(internals.workingPhaseSessions.has("s1")).toBe(false);
      expect(internals.sessions.get("s1").status).toBe("idle");
    } finally {
      await cleanup();
    }
  });

  it("keeps the working phase while its report is still inside the grace", async () => {
    const { internals, list, cleanup } = await quietHarness({
      latch: (target: any) => target.workingPhaseSessions.add("s1"),
      evidenceAgeMs: FRESH,
    });
    try {
      expect(await internals.discoveredRunState("s1")).toBe("running");
      expect((await list()).find((row) => row.id === "s1")?.status).toBe("running");
      expect(internals.workingPhaseSessions.has("s1")).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("never settles a session whose reports keep arriving", async () => {
    const { internals, list, cleanup } = await quietHarness({ evidenceAgeMs: STALE });
    try {
      // A live turn reports again inside the window. The report itself restarts the
      // aging clock, so the transcript never gets to overrule the row.
      internals.patchSessionInfo("s1", {
        sessionUpdate: "session_info_update",
        updatedAt: new Date().toISOString(),
        _meta: { gjcPhase: "working", gjcRunning: true },
      });
      expect(internals.liveEvidenceAt.get("s1")).toBeGreaterThan(
        Date.now() - LIVE_EVIDENCE_GRACE_MS,
      );
      expect((await list()).find((row) => row.id === "s1")?.status).toBe("running");
      expect(internals.sessions.get("s1").status).toBe("running");
      expect(internals.liveRunningSessions.has("s1")).toBe(true);
      expect(internals.workingPhaseSessions.has("s1")).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("re-derives a row on the refresh after its evidence went quiet", async () => {
    const { internals, list, cleanup } = await quietHarness({ evidenceAgeMs: FRESH });
    try {
      // The first scan lists the running row and records the scan fingerprint it was
      // listed at. Nothing else then moves -- no report, no transcript write -- so the
      // fingerprint itself has to notice that the evidence stopped.
      expect((await list()).find((row) => row.id === "s1")?.status).toBe("running");
      internals.liveEvidenceAt.set("s1", Date.now() - STALE);
      expect((await list()).find((row) => row.id === "s1")?.status).toBe("idle");
      expect(internals.liveRunningSessions.has("s1")).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it("settles a row whose revision bump no transcript read ever consumed", async () => {
    const { internals, list, cleanup } = await quietHarness({ evidenceAgeMs: STALE });
    try {
      // A report advanced the revision, and the transcript read that would have
      // consumed it was discarded as stale. Preserving a status across that bump is
      // what pinned the row in the report, so the settle cannot depend on it.
      internals.runRevisions.set("s1", 9);
      internals.sessions.get("s1").runRevision = 9;
      expect((await list()).find((row) => row.id === "s1")?.status).toBe("idle");
      expect(internals.currentRunRevision("s1")).toBeGreaterThan(9);
      expect(internals.liveRunningSessions.has("s1")).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it("settles when a report lands while the transcript is being read", async () => {
    const { internals, list, cleanup } = await quietHarness({ evidenceAgeMs: STALE });
    try {
      const readRunState = internals.discoveredRunState.bind(internals);
      internals.discoveredRunState = vi.fn(async (sessionId: string) => {
        const status = await readRunState(sessionId);
        // The revision moved after the verdict was taken, the way a live report
        // arriving mid-read moves it.
        internals.advanceRunRevision(sessionId);
        return status;
      });
      expect((await list()).find((row) => row.id === "s1")?.status).toBe("idle");
      expect(internals.liveRunningSessions.has("s1")).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it("leaves a latched row alone when no transcript verdict exists", async () => {
    const { internals, list, cleanup } = await quietHarness({
      evidenceAgeMs: STALE,
      transcript: false,
    });
    try {
      // An unreadable or missing transcript is not a verdict that the turn ended.
      expect(await internals.discoveredRunState("s1")).toBeUndefined();
      expect((await list()).find((row) => row.id === "s1")?.status).toBe("running");
      expect(internals.liveRunningSessions.has("s1")).toBe(true);
    } finally {
      await cleanup();
    }
  });
});

describe("manual compaction", () => {
  it("uses the long compaction deadline and keeps the phase after a sent-but-uncertain outcome", async () => {
    const { controller, cli, internals } = harness();
    internals.sessions.set("s1", session());
    cli.rawControl.mockRejectedValueOnce(
      new SdkCliError(
        "uncertain_after_send",
        "The request was sent but its outcome is uncertain. Reconcile before any replay.",
      ),
    );

    await expect(controller.compactSession("s1")).resolves.toBeUndefined();

    expect(cli.rawControl).toHaveBeenCalledWith(
      "s1",
      "compaction.run",
      {},
      expect.objectContaining({ timeoutMs: 300_000 }),
    );
    // The durable compaction record is still the completion receipt; clearing
    // these markers here made the later record invisible and left the row running.
    expect(internals.compactingSessions.has("s1")).toBe(true);
    expect(internals.sessions.get("s1").phase).toBe("compacting");
    expect(internals.sessions.get("s1").status).toBe("running");
  });

  it("restores the previous row when GJC refuses the compaction", async () => {
    const { controller, cli, internals } = harness();
    internals.sessions.set("s1", session());
    cli.rawControl.mockRejectedValueOnce(
      new SdkCliError(
        "operation_failed",
        "The operation failed. Its outcome could not be established.",
      ),
    );

    await expect(controller.compactSession("s1")).rejects.toThrow(
      "The operation failed",
    );
    expect(internals.compactingSessions.has("s1")).toBe(false);
    expect(internals.sessions.get("s1").phase).toBeUndefined();
    expect(internals.sessions.get("s1").status).toBe("idle");
  });
});
