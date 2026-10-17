import { describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, stat, writeFile, rm } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  GjcSdkController,
  LIVE_EVIDENCE_GRACE_MS,
  TAIL_WINDOW_MS,
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
  parentSessionOf,
  todoSnapshotPhases,
} from "./gjc-sdk-controller.js";
import { SdkCliError } from "./gjc-sdk-cli.js";
import { DEFAULT_MODEL_PRESET } from "../shared/agent-contract.js";
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
    rows.map((row) => JSON.stringify(row)).join("\n"),
    "utf8",
  );
}

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
  });
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
    let requestId: string | undefined;
    cli.rawGlobal.mockImplementationOnce(async (...args: unknown[]) => {
      requestId = (args[2] as { idempotencyKey: string }).idempotencyKey;
      throw new Error("terminal_uncertain");
    });
    cli.listSessions.mockResolvedValueOnce([]).mockImplementation(async () => [
      { sessionId: "unrelated", live: true, deleted: false, endpointGeneration: 1, repo: "/repo" },
      { sessionId: "recovered", live: true, deleted: false, endpointGeneration: 1, repo: "/repo", lifecycleRequestId: requestId },
    ] as never);
    const created = await controller.createSession({ runtime: "gjc", workspace: "/repo" } as any);
    expect(created.id).toBe("recovered");
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
      const fork = internals.recoverForkedSession("/repo", new Set(), "expected-request");
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

  it("keeps the new prompt admission when an aborted send settles late", async () => {
    const { controller, cli, internals } = harness();
    internals.sessions.set("s1", session());
    internals.sessionCwds.set("s1", "/repo");
    internals.ensureAttached = vi.fn(async () => undefined);
    internals.executeSdkSlashCommand = vi.fn(async () => false);
    let finishOld!: (result: { status: string }) => void;
    (cli.send as any)
      .mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }))
      .mockResolvedValue({ status: "accepted" });
    internals.awaitPromptSettlement = vi.fn(async () => "unknown");
    (cli.rawControl as any).mockResolvedValue({ turn: "stopped" });
    const oldSend = controller.sendMessage("s1", { text: "old", images: [], files: [] });
    while (!finishOld) await Promise.resolve();
    await controller.cancelRun("s1");
    await controller.sendMessage("s1", { text: "new", images: [], files: [] });
    const newAdmission = internals.activePromptAdmissions.get("s1");
    finishOld({ status: "accepted" });
    await oldSend;
    expect(internals.activePromptAdmissions.get("s1")).toBe(newAdmission);
    controller.dispose();
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

  it.each([true, false])("preserves ambiguous legacy history when the broker row live=%s", async (live) => {
    const { controller, cli, internals } = harness();
    try {
      internals.sessions.set("s1", session());
      internals.locateSharedTranscriptFile = vi.fn(async () => "/repo/s1.jsonl");
      cli.listSessions.mockResolvedValue([{ sessionId: "s1", live, deleted: false, repo: "/repo" }] as never);
      cli.rawGlobal.mockRejectedValue(new SdkCliError("operation_failed", "localized refusal", undefined,
        [{ code: "lifecycle_legacy_history_ambiguous" }], "unknown"));
      const remove = vi.spyOn(internals, "removeSessionArtifacts");
      await expect(controller.deleteSession("s1")).rejects.toThrow("lifecycle_legacy_history_ambiguous");
      expect(internals.sessions.get("s1").attachment).toBe("recovering");
      expect(remove).not.toHaveBeenCalled();
      expect(cli.rawGlobal).toHaveBeenCalledTimes(1);
      expect(cli.rawGlobal).toHaveBeenCalledWith(live ? "session.close" : "session.delete",
        expect.objectContaining({ sessionId: "s1" }), expect.any(Object));
    } finally { controller.dispose(); }
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


  it("does not send a follow-up after permission application fails", async () => {
    const { controller, cli, internals } = harness();
    internals.ensureAttached = vi.fn(async () => { throw new Error("permission_mode.set rejected"); });
    await expect(controller.queueFollowUp("s1", { text: "follow up", images: [], files: [] } as never)).rejects.toThrow("세션 제어 상태");
    expect(cli.rawControl).not.toHaveBeenCalledWith("s1", "turn.follow_up", expect.anything(), expect.anything());
    controller.dispose();
  });


  it("does not close or delete a live generation-zero CLI session", async () => {
    const { controller, cli, internals } = harness();
    internals.sessions.set("s1", session());
    (cli.listSessions as any).mockResolvedValue([
      { sessionId: "s1", repo: "/repo", live: true, deleted: false, endpointGeneration: 0 },
    ]);
    await expect(controller.deleteSession("s1")).rejects.toThrow(/upstream lifecycle 지원/u);
    expect(cli.rawGlobal).not.toHaveBeenCalled();
    expect(internals.sessions.has("s1")).toBe(true);
    controller.dispose();
  });


  it("closes then deletes through lifecycle globals", async () => {
    const { controller, cli, internals } = harness();
    internals.sessions.set("s1", session()); internals.sessionCwds.set("s1", "/repo");
    internals.locateSharedTranscriptFile = vi.fn(async () => undefined);
    (cli.listSessions as any)
      .mockResolvedValueOnce([{ sessionId: "s1", repo: "/repo", live: true, deleted: false }])
      .mockResolvedValue([{ sessionId: "s1", repo: "/repo", live: false, deleted: false }]);
    await controller.deleteSession("s1");
    const calls = (cli.rawGlobal as any).mock.calls.map((c: any[]) => c[0]);
    expect(calls.indexOf("session.close")).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf("session.delete")).toBeGreaterThan(calls.indexOf("session.close"));
    expect(internals.sessions.has("s1")).toBe(false);
  });

  it("keeps local state when close fails with a verified operational error", async () => {
    const { controller, cli, internals } = harness();
    internals.sessions.set("s1", session()); internals.sessionCwds.set("s1", "/repo");
    (cli.listSessions as any).mockResolvedValue([
      { sessionId: "s1", repo: "/repo", live: true, deleted: false },
    ]);
    (cli.rawGlobal as any).mockRejectedValue(new SdkCliError("invalid_input", "bad close"));
    await expect(controller.deleteSession("s1")).rejects.toThrow("bad close");
    expect(internals.sessions.has("s1")).toBe(true);
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
    await expect(controller.deleteSession("s1")).rejects.toThrow(/삭제 결과가 확인되지/u);
    expect(internals.sessions.get("s1")?.attachment).toBe("recovering");
    expect(internals.sessions.has("s1")).toBe(true);
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

  it("keeps the session when the broker index cannot be read", async () => {
    const { controller, cli, internals } = harness();
    internals.sessions.set("s1", session()); internals.sessionCwds.set("s1", "/repo");
    (cli.listSessions as any).mockRejectedValue(new Error("index unavailable"));
    await expect(controller.deleteSession("s1")).rejects.toThrow(/삭제 결과가 확인되지/u);
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

  it("lists sessions through the CLI and catches up tail cursors", async () => {
    const { cli, internals } = harness();
    (cli.listSessions as any).mockResolvedValue([{ sessionId: "s1", title: "One", repo: "/repo", live: true, runtime: "gjc", activityState: "idle" }]);
    expect(await internals.brokerSessions()).toEqual(expect.arrayContaining([expect.objectContaining({ sessionId: "s1" })]));
    internals.sessions.set("s1", session()); internals.sessionCwds.set("s1", "/repo");
    internals.attachedSessions.add("s1");
    (cli.tail as any)
      .mockResolvedValueOnce({
        source: "session", terminal: true, items: [], checkpointToken: "checkpoint-1",
      })
      .mockResolvedValueOnce({ source: "offline", terminal: true, items: [] });
    internals.startTailFollower("s1");
    // An answer with no frames is paced by one window before the next read, so the
    // cursor this test is about is handed over on the second poll.
    await new Promise((resolve) => setTimeout(resolve, TAIL_WINDOW_MS + 250));
    expect(cli.tail).toHaveBeenCalledTimes(2);
    expect((cli.tail as any).mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({ cursor: "checkpoint-1" }),
    );
  });

  it("retains the last tail checkpoint across a timeout and aborts on detach", async () => {
    const { cli, internals } = harness();
    internals.sessions.set("s1", session()); internals.sessionCwds.set("s1", "/repo");
    internals.attachedSessions.add("s1");
    (cli.tail as any)
      .mockResolvedValueOnce({
        source: "session", terminal: true, items: [], checkpointToken: "checkpoint-1",
      })
      .mockRejectedValueOnce(new SdkCliError("tail_timeout", "still running"))
      .mockResolvedValueOnce({ source: "offline", terminal: true, items: [] });
    internals.startTailFollower("s1");
    // The first answer carries no frames, so the follower waits one window before
    // the timeout that follows it.
    await new Promise((resolve) => setTimeout(resolve, TAIL_WINDOW_MS + 250));
    expect((cli.tail as any).mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({ cursor: "checkpoint-1" }),
    );
    expect((cli.tail as any).mock.calls[2]?.[1]).toEqual(
      expect.objectContaining({ cursor: "checkpoint-1" }),
    );
    internals.removeLocalSession("s1", false);
    expect(internals.tailControllers.has("s1")).toBe(false);
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
        app.controller.dispose();
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
      expect(ids(internals)).toEqual(["shared-message-u1"]);

      // A call this window is still working is live in the same way, and the cancel
      // that cancelled it is what clears the card.
      internals.locallyAbortedSessions.delete("s1");
      internals.handleSessionUpdate(toolCall("call-4"));
      await internals.refreshTranscriptFromFile("s1");
      expect(ids(internals)).toEqual(["shared-message-u1", "call-4"]);
      await controller.cancelRun("s1");
      expect(
        rows(internals).find((item) => item.id === "call-4")?.status,
      ).toBe("cancelled");
      await internals.refreshTranscriptFromFile("s1");
      expect(ids(internals)).toEqual(["shared-message-u1"]);

      // A deleted session takes the transcript the rows lived in with it.
      internals.removeLocalSession("s1", false);
      expect(internals.transcripts.has("s1")).toBe(false);
    } finally {
      await cleanup();
    }
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

  it("keeps today's answer when the runtime cannot be asked", async () => {
    const { cli, internals, cleanup } = await markerHarness([
      taskLaunch("job-1"),
      terminalStop(),
    ]);
    (cli.queryItems as any).mockRejectedValue(
      new SdkCliError("endpoint_stale", "The SDK endpoint is stale or unavailable."),
    );
    try {
      // An unanswered query is not evidence the work ended.
      expect(await internals.discoveredRunState("s1")).toBe("running");
      expect(await internals.discoveredRunState("s1")).toBe("running");
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

  it("holds an out-of-window latch while the runtime cannot be asked about it", async () => {
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
      // An unanswered query is not evidence the work ended, so the latch stands -- and
      // a runtime that cannot answer is not re-asked on every read either.
      expect(internals.pendingAsyncWorkSessions.get("s1")).toEqual(["job-1"]);
      expect(await internals.discoveredRunState("s1")).toBe("running");
      expect(await internals.discoveredRunState("s1")).toBe("running");
      expect(cli.queryItems).toHaveBeenCalledTimes(1);
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
