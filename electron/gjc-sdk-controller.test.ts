import { describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  GjcSdkController,
  busyPromptError,
  cancelledOperationError,
  gitBranchFromHeader,
  inferToolName,
  persistedTranscriptRunning,
  toolStatus,
  readableModelLabel,
  historySessionSummary,
  parentSessionOf,
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
    (cli.rawGlobal as any).mockRejectedValueOnce(new Error("terminal_uncertain"));
    (cli.listSessions as any).mockResolvedValueOnce([]).mockResolvedValue([{ sessionId: "recovered", live: true, deleted: false, endpointGeneration: 1, repo: "/repo", runtime: "gjc" }]);
    const created = await controller.createSession({ runtime: "gjc", workspace: "/repo" } as any);
    expect(created.id).toBe("recovered");
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

  it("closes then deletes through lifecycle globals", async () => {
    const { controller, cli, internals } = harness();
    internals.sessions.set("s1", session()); internals.sessionCwds.set("s1", "/repo");
    internals.locateSharedTranscriptFile = vi.fn(async () => undefined);
    await controller.deleteSession("s1");
    const calls = (cli.rawGlobal as any).mock.calls.map((c: any[]) => c[0]);
    expect(calls.indexOf("session.close")).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf("session.delete")).toBeGreaterThan(calls.indexOf("session.close"));
    expect(internals.sessions.has("s1")).toBe(false);
  });

  it("keeps local state when close fails with a verified operational error", async () => {
    const { controller, cli, internals } = harness();
    internals.sessions.set("s1", session()); internals.sessionCwds.set("s1", "/repo");
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
    await controller.deleteSession("s1");
    expect(internals.sessions.get("s1")?.attachment).toBe("recovering");
    expect(internals.sessions.has("s1")).toBe(true);
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
    await new Promise((resolve) => setTimeout(resolve, 10));
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
    await new Promise((resolve) => setTimeout(resolve, 10));
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
