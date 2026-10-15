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
  sharedTranscriptItems,
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
        title: "할 일 목록",
        sourceType: "todo.list",
      });
      expect(row.content).toContain("- 반환된 작업 기록: 1개");
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
      "- 조회 실패: no Router attachment",
    );
    expect(unavailable.content).toContain("빈 목록이 아닙니다");
    expect(unavailable.content).not.toContain("반환된 작업 기록");
    // Nothing successful was observed, so nothing is retained to show as stale.
    expect(internals.sessionTodoSnapshots.get("s1")?.rows).toBeUndefined();

    // A successful read that really returns nothing is an empty list, and says so.
    (cli.queryItems as any).mockResolvedValue([]);
    await internals.readTodoRecords("s1");
    const empty = systemRow(internals);
    expect(empty.content).toContain("- 반환된 작업 기록: 0개");
    expect(empty.content).not.toContain("조회 실패");

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
    expect(stale.content).toContain("조회 실패: provider unreachable");
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
