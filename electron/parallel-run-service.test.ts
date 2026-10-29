import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import type { AgentSession, CreateSessionInput } from "../shared/agent-contract.js";
import type { ParallelGroup } from "../shared/parallel-run.js";
import { parallelCleanupConfirmation } from "../shared/parallel-run.js";
import { GjcSdkController } from "./gjc-sdk-controller.js";
import { SdkCliError } from "./gjc-sdk-cli.js";
import {
  INTERRUPTED_REASON,
  ParallelRunService,
  type GitRunner,
  type ParallelRunHost,
} from "./parallel-run-service.js";
import { SessionMetadataStore } from "./session-metadata-store.js";

const execFile = promisify(execFileCallback);
const git = async (cwd: string, ...args: string[]) =>
  (await execFile("git", ["-C", cwd, ...args])).stdout.trim();

function memoryStore(seed: ParallelGroup[] = []) {
  const groups = new Map(seed.map((group) => [group.id, group]));
  return {
    groups,
    listParallelGroups: () => [...groups.values()],
    putParallelGroup: (group: ParallelGroup) => void groups.set(group.id, group),
  };
}

function session(id: string, input: CreateSessionInput): AgentSession {
  return {
    id,
    title: input.title ?? id,
    subtitle: id,
    workspace: `/wt/${id}`,
    runtime: "gjc",
    status: "idle",
    updatedAt: "now",
    pinned: false,
    unread: false,
    accent: "#ff8a34",
    ownership: "gajae",
    attachment: "attached",
    worktree: {
      sourceWorkspace: "/repo",
      path: `/wt/${id}`,
      branch: input.worktreeBranch ?? "",
      managed: true,
    },
  };
}

/** Git answers for a repository where no attempt branch exists yet. */
const freshRepository: GitRunner = async (_cwd, args) => {
  if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return "/repo\n";
  if (args[0] === "rev-parse") throw new Error("missing");
  return "";
};

const START = {
  title: "로그인 고치기",
  workspace: "/repo",
  prompt: "로그인 버그를 고쳐 줘",
  presets: ["codex-pro", "codex-medium", "codex-eco"],
};

describe("ParallelRunService with a partial failure", () => {
  it("keeps the other attempts running, sends each started attempt the request once, and compares when they finish", async () => {
    const store = memoryStore();
    const created: CreateSessionInput[] = [];
    const host: ParallelRunHost = {
      createSession: vi.fn(async (input: CreateSessionInput) => {
        created.push(input);
        if (input.modelPreset === "codex-medium")
          throw new Error("unknown model profile codex-medium");
        return session(`s-${created.length}`, input);
      }),
      sendMessage: vi.fn(async () => "prompt" as const),
      hideSession: vi.fn(),
    };
    const service = new ParallelRunService({
      store,
      host,
      git: freshRepository,
      newId: () => "abcdef12-0000",
    });

    const started = await service.start(START);
    expect(started.state).toEqual({ kind: "draft" });
    await service.idle();

    const group = service.list()[0]!;
    expect(group.state).toEqual({ kind: "running" });
    expect(group.attempts.map((attempt) => [attempt.branch, attempt.state.kind])).toEqual([
      ["gajae/best-of-abcdef12-1", "started"],
      ["gajae/best-of-abcdef12-2", "failed"],
      ["gajae/best-of-abcdef12-3", "started"],
    ]);
    expect(group.attempts[1]!.state).toEqual({
      kind: "failed",
      reason: "unknown model profile codex-medium",
    });
    expect(created.map((input) => [input.modelPreset, input.isolation, input.worktreeBranch])).toEqual([
      ["codex-pro", "worktree", "gajae/best-of-abcdef12-1"],
      ["codex-medium", "worktree", "gajae/best-of-abcdef12-2"],
      ["codex-eco", "worktree", "gajae/best-of-abcdef12-3"],
    ]);
    expect(host.sendMessage).toHaveBeenCalledTimes(2);
    expect(host.sendMessage).toHaveBeenNthCalledWith(1, "s-1", {
      text: START.prompt,
      images: [],
      files: [],
    });
    expect(host.sendMessage).toHaveBeenNthCalledWith(2, "s-3", {
      text: START.prompt,
      images: [],
      files: [],
    });
    expect(store.groups.get(group.id)).toEqual(group);

    const update = (id: string, status: AgentSession["status"]) =>
      service.observe({
        type: "session.updated",
        session: { ...session(id, { runtime: "gjc", workspace: "/repo", isolation: "worktree" }), status },
      });
    // An idle report before the attempt ever ran is the created session, not a result.
    update("s-1", "idle");
    expect(service.list()[0]!.state).toEqual({ kind: "running" });
    update("s-1", "running");
    update("s-1", "idle");
    update("s-3", "running");
    expect(service.list()[0]!.state).toEqual({ kind: "running" });
    update("s-3", "failed");
    expect(service.list()[0]!.state).toEqual({ kind: "comparing" });
  });

  it("marks an attempt failed when its request did not run, and keeps its session", async () => {
    const host: ParallelRunHost = {
      createSession: vi.fn(async (input: CreateSessionInput) =>
        session(input.modelPreset === "codex-pro" ? "s-1" : "s-2", input),
      ),
      sendMessage: vi.fn(async (sessionId: string) =>
        sessionId === "s-2"
          ? { kind: "not_executed" as const, detail: "GJC rejected the prompt" }
          : ("prompt" as const),
      ),
      hideSession: vi.fn(),
    };
    const service = new ParallelRunService({
      store: memoryStore(),
      host,
      git: freshRepository,
    });
    await service.start({ ...START, presets: ["codex-pro", "codex-eco"] });
    await service.idle();
    const [first, second] = service.list()[0]!.attempts;
    expect(first!.state.kind).toBe("started");
    expect(second!.state).toEqual({
      kind: "failed",
      reason: "GJC rejected the prompt",
      sessionId: "s-2",
      worktreePath: "/wt/s-2",
    });
    expect(host.sendMessage).toHaveBeenCalledTimes(2);
  });

  it("refuses to start on a branch that already exists, before creating anything", async () => {
    const host: ParallelRunHost = {
      createSession: vi.fn(),
      sendMessage: vi.fn(),
      hideSession: vi.fn(),
    };
    const store = memoryStore();
    const service = new ParallelRunService({
      store,
      host,
      git: async (_cwd, args) => {
        if (args[1] === "--show-toplevel") return "/repo\n";
        if (args.at(-1) === "refs/heads/feat/login-2") return "abc\n";
        throw new Error("missing");
      },
    });
    await expect(service.start({ ...START, branch: "feat/login" })).rejects.toThrow(
      "feat/login-2",
    );
    expect(host.createSession).not.toHaveBeenCalled();
    expect(store.groups.size).toBe(0);
  });

  it("fails the attempts a restart left half-made instead of leaving the group in draft", () => {
    const store = memoryStore([
      {
        id: "g",
        title: "t",
        prompt: "p",
        workspace: "/repo",
        createdAt: 1,
        state: { kind: "draft" },
        attempts: [
          { id: "1", preset: "codex-pro", branch: "b-1", state: { kind: "started", sessionId: "s-1", worktreePath: "/wt/1" } },
          { id: "2", preset: "codex-eco", branch: "b-2", state: { kind: "creating" } },
        ],
      },
    ]);
    const service = new ParallelRunService({
      store,
      host: { createSession: vi.fn(), sendMessage: vi.fn(), hideSession: vi.fn() },
      git: freshRepository,
    });
    const group = service.list()[0]!;
    expect(group.state).toEqual({ kind: "running" });
    expect(group.attempts[1]!.state).toEqual({ kind: "failed", reason: INTERRUPTED_REASON });
    expect(store.groups.get("g")).toEqual(group);
  });
});

function controllerHarness(metadata: SessionMetadataStore) {
  const controller = new GjcSdkController({
    workspace: "/repo",
    emit: vi.fn(),
    sessionMetadata: metadata,
  } as never);
  const cli = {
    listSessions: vi.fn(async () => []),
    inspectSession: vi.fn(async () => ({ live: true, repo: "/repo" })),
    rawGlobal: vi.fn(async (_op?: unknown, _input?: unknown): Promise<unknown> => ({ ok: true })),
    rawControl: vi.fn(async () => ({ ok: true })),
    rawQuery: vi.fn(async () => ({ items: [] })),
    queryItems: vi.fn(async () => []),
    send: vi.fn(async () => ({ status: "accepted" })),
    promptStatus: vi.fn(async () => ({ status: "completed" })),
    tail: vi.fn(async () => ({ source: "offline", terminal: true, items: [] })),
    observeTools: vi.fn(async (_id: string, _emit: unknown, signal: AbortSignal) => {
      if (!signal.aborted)
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
    }),
  };
  const internals = controller as any;
  internals.cli = cli;
  internals.startup = Promise.resolve();
  internals.generation = 1;
  return { controller, cli };
}

async function commitFile(dir: string, file: string): Promise<void> {
  await writeFile(path.join(dir, file), file);
  await git(dir, "add", file);
  await git(dir, "-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-qm", file);
}

describe("ParallelRunService against a real repository", () => {
  it("creates isolated worktrees, keeps the adopted branch, and removes the others only as confirmed", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "gajae-parallel-"));
    const origin = path.join(parent, "origin.git");
    const repo = path.join(parent, "repo");
    const metadata = new SessionMetadataStore(path.join(parent, "user-data"));
    const { controller, cli } = controllerHarness(metadata);
    const sent: string[] = [];
    try {
      await execFile("git", ["init", "-q", "--bare", "-b", "main", origin]);
      await execFile("git", ["clone", "-q", origin, repo]);
      await commitFile(repo, "base");
      await git(repo, "push", "-q", "origin", "HEAD:main");

      let creates = 0;
      cli.rawGlobal.mockImplementation(async () => {
        creates += 1;
        // A failure GJC reports after the worktree exists: the controller keeps the
        // worktree for recovery, and only Git still knows about it.
        if (creates === 2) throw new Error("broker refused the session");
        return { sessionId: `attempt-${creates}` };
      });
      const service = new ParallelRunService({
        store: metadata,
        host: {
          createSession: (input) => controller.createSession(input),
          sendMessage: async (sessionId, input) => {
            sent.push(`${sessionId}:${input.text}`);
            return "prompt";
          },
          hideSession: (sessionId) => controller.hideSession(sessionId),
        },
      });

      const draftGroup = await service.start({
        title: "로그인 고치기",
        workspace: repo,
        prompt: "로그인 버그를 고쳐 줘",
        branch: "feat/login",
        presets: ["codex-pro", "codex-medium", "codex-eco"],
      });
      await service.idle();
      const group = service.list()[0]!;
      expect(group.id).toBe(draftGroup.id);
      expect(group.attempts.map((attempt) => attempt.state.kind)).toEqual([
        "started",
        "failed",
        "started",
      ]);
      expect(sent).toEqual(["attempt-1:로그인 버그를 고쳐 줘", "attempt-3:로그인 버그를 고쳐 줘"]);
      expect(cli.rawGlobal.mock.calls.map((call: unknown[]) => (call[1] as { modelPreset: string }).modelPreset)).toEqual([
        "codex-pro",
        "codex-medium",
        "codex-eco",
      ]);

      const worktreesBefore = await git(repo, "worktree", "list", "--porcelain");
      for (const branch of ["feat/login-1", "feat/login-2", "feat/login-3"])
        expect(worktreesBefore).toContain(`branch refs/heads/${branch}`);
      const [first, , third] = group.attempts;
      const firstPath = (first!.state as { worktreePath: string }).worktreePath;
      const thirdPath = (third!.state as { worktreePath: string }).worktreePath;
      expect(new Set([repo, firstPath, thirdPath]).size).toBe(3);

      await commitFile(firstPath, "adopted-work");
      const adoptedHead = await git(firstPath, "rev-parse", "HEAD");
      await commitFile(thirdPath, "unpushed-work");
      await writeFile(path.join(thirdPath, "scratch.txt"), "not committed");

      expect(() => service.adopt(group.id, "2")).toThrow();
      service.adopt(group.id, "1");
      const plan = await service.cleanupPlan(group.id);
      expect(plan.keptBranch).toBe("feat/login-1");
      expect(plan.items.map((item) => [item.attemptId, item.branchExists, item.uncommittedFiles, item.unpushedCommits, Boolean(item.worktreePath)])).toEqual([
        ["2", true, 0, 0, true],
        ["3", true, 1, 1, true],
      ]);
      expect(parallelCleanupConfirmation(plan).detail).toContain(
        "feat/login-3 (push하지 않은 커밋 1개가 사라집니다)",
      );

      const attempt3 = session("attempt-3", { runtime: "gjc", workspace: repo, isolation: "worktree" });
      service.observe({ type: "session.updated", session: { ...attempt3, status: "running" } });
      await expect(service.cleanupPlan(group.id)).rejects.toThrow("#3");
      service.observe({ type: "session.updated", session: { ...attempt3, status: "idle" } });

      await commitFile(thirdPath, "after-confirmation");
      await expect(service.cleanup(group.id, plan)).rejects.toThrow("바뀌었습니다");
      expect(await git(repo, "worktree", "list", "--porcelain")).toContain("feat/login-3");

      const confirmed = await service.cleanupPlan(group.id);
      const resolved = await service.cleanup(group.id, confirmed);

      const worktreesAfter = await git(repo, "worktree", "list", "--porcelain");
      expect(worktreesAfter).toContain("branch refs/heads/feat/login-1");
      expect(worktreesAfter).not.toContain("feat/login-2");
      expect(worktreesAfter).not.toContain("feat/login-3");
      const branches = await git(repo, "branch", "--format=%(refname:short)");
      expect(branches.split("\n").sort()).toEqual(["feat/login-1", "main"]);
      expect(await git(firstPath, "rev-parse", "HEAD")).toBe(adoptedHead);
      expect(resolved.state).toEqual({ kind: "adopted", attemptId: "1" });
      expect(resolved.attempts.map((attempt) => attempt.state.kind)).toEqual([
        "started",
        "removed",
        "removed",
      ]);
      expect(metadata.isHidden("attempt-3")).toBe(true);
      expect(metadata.isHidden("attempt-1")).toBe(false);
      expect(new SessionMetadataStore(path.join(parent, "user-data")).listParallelGroups()).toEqual([resolved]);
      expect((await service.cleanupPlan(group.id)).items).toEqual([]);
    } finally {
      controller.dispose();
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("discards a group whose refused attempt the controller already cleaned up", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "gajae-parallel-notapplied-"));
    const repo = path.join(parent, "repo");
    const metadata = new SessionMetadataStore(path.join(parent, "user-data"));
    const { controller, cli } = controllerHarness(metadata);
    try {
      await execFile("git", ["init", "-q", "-b", "main", repo]);
      await commitFile(repo, "base");
      cli.rawGlobal.mockImplementation(async (_op: unknown, input: unknown) => {
        if ((input as { modelPreset: string }).modelPreset === "codex-eco")
          throw new SdkCliError("operation_failed", "refused", undefined, [], "not-applied");
        return { sessionId: "only" };
      });
      const service = new ParallelRunService({
        store: metadata,
        host: {
          createSession: (input) => controller.createSession(input),
          sendMessage: async () => "prompt",
          hideSession: (sessionId) => controller.hideSession(sessionId),
        },
      });
      await service.start({
        title: "t",
        workspace: repo,
        prompt: "p",
        presets: ["codex-pro", "codex-eco"],
      });
      await service.idle();
      const group = service.list()[0]!;
      // A creation GJC refused before it applied leaves nothing: the controller
      // removed the clean worktree and the branch it had just made.
      expect(await git(repo, "branch", "--format=%(refname:short)")).not.toContain(
        group.attempts[1]!.branch,
      );
      service.discard(group.id);
      const plan = await service.cleanupPlan(group.id);
      expect(plan.keptBranch).toBeUndefined();
      expect(plan.items.map((item) => [item.attemptId, item.branchExists, Boolean(item.worktreePath)])).toEqual([
        ["1", true, true],
        ["2", false, false],
      ]);
      await service.cleanup(group.id, plan);
      expect(await git(repo, "branch", "--format=%(refname:short)")).toBe("main");
      expect((await git(repo, "worktree", "list")).split("\n")).toHaveLength(1);
    } finally {
      controller.dispose();
      await rm(parent, { recursive: true, force: true });
    }
  });
});
