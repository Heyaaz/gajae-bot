import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { GjcSdkController } from "./gjc-sdk-controller.js";
import { GjcSdkCli } from "./gjc-sdk-cli.js";

function harness() {
  const controller = new GjcSdkController({ workspace: "/repo", emit: vi.fn() });
  const state = controller as any;
  state.refreshSdkCommands = vi.fn(async () => undefined);
  state.readTodoRecords = vi.fn(async () => []);
  return { controller, state };
}

function readableSession(state: any) {
  state.sessions.set("live", {
    id: "live", title: "Live", workspace: "/repo", runtime: "gjc",
    status: "idle", attachment: "attachable", ownership: "external",
  });
  const items = [{ id: "message", sessionId: "live", kind: "message", role: "user", content: "Saved history", timestamp: "now" }];
  state.readSharedTranscript = vi.fn(async () => items);
  return items;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("session read performance", () => {
  it("shares the startup global scan with discovery but never with lifecycle reads", async () => {
    const { controller, state } = harness();
    state.resolveExecutable = vi.fn(async () => "/gjc");
    state.recoverOwnedSessions = vi.fn(async () => undefined);
    state.locateSharedTranscriptFile = vi.fn(async () => undefined);
    state.discoveredRunState = vi.fn(async () => "idle");
    state.sessionParentId = vi.fn(async () => undefined);
    const list = vi.spyOn(GjcSdkCli.prototype, "listSessions").mockResolvedValue([
      { sessionId: "elsewhere", repo: "/other-repo", live: true, deleted: false, endpointGeneration: 1 },
    ]);
    try {
      const [connection, rows] = await Promise.all([controller.getConnection(), controller.listSessions()]);
      expect(connection.state).toBe("connected");
      expect(rows.map(row => row.id)).toEqual(["elsewhere"]);
      expect(list).toHaveBeenCalledExactlyOnceWith({ scope: "all" });
      list.mockResolvedValue([]);
      expect(await state.brokerSessions()).toEqual([]);
      expect(list).toHaveBeenCalledTimes(2);
      expect(await controller.listSessions()).toEqual([]);
      expect(list).toHaveBeenCalledTimes(3);
    } finally { controller.dispose(); list.mockRestore(); }
  });

  it("consumes an empty startup snapshot once and clears it on runtime reconfiguration", async () => {
    const { controller, state } = harness();
    state.resolveExecutable = vi.fn(async () => "/gjc");
    state.recoverOwnedSessions = vi.fn(async () => undefined);
    const list = vi.spyOn(GjcSdkCli.prototype, "listSessions").mockResolvedValue([]);
    try {
      await controller.getConnection();
      expect(await controller.listSessions()).toEqual([]);
      expect(list).toHaveBeenCalledTimes(1);
      await controller.listSessions();
      expect(list).toHaveBeenCalledTimes(2);
      state.startupSessionRows = [{ sessionId: "stale", repo: "/repo", live: true }];
      await controller.reconfigure({ workspace: "/repo", gjcExecutable: "/new-gjc", modelPreset: "new-model", permissionHandling: "deny" } as any);
      expect(await controller.listSessions()).toEqual([]);
      expect(list).toHaveBeenCalledTimes(3);
    } finally { controller.dispose(); list.mockRestore(); }
  });

  it("does not advertise connectivity or cache an incomplete startup scan", async () => {
    const { controller, state } = harness();
    state.resolveExecutable = vi.fn(async () => "/gjc");
    const list = vi.spyOn(GjcSdkCli.prototype, "listSessions").mockRejectedValue(new Error("incomplete scan"));
    try {
      expect((await controller.getConnection()).state).toBe("error");
      expect(state.startupSessionRows).toBeUndefined();
      expect(state.cli).toBeUndefined();
    } finally { controller.dispose(); list.mockRestore(); }
  });

  it("never locates transcripts for historical, deleted or hidden broker rows", async () => {
    const { controller, state } = harness();
    state.brokerSessions = vi.fn(async () => [
      ...Array.from({ length: 1000 }, (_, index) => ({ sessionId: `old-${index}`, repo: "/repo", live: false })),
      { sessionId: "deleted", repo: "/repo", live: true, deleted: true },
      { sessionId: "hidden", repo: "/repo", live: true },
      { sessionId: "live", repo: "/repo", live: true, endpointGeneration: 1 },
    ]);
    state.sessionMetadata = {
      forgetHiddenOutside: vi.fn(), listWorkspaces: () => ["/repo"],
      isHidden: (id: string) => id === "hidden",
      getOwnership: () => undefined, getUnread: () => false,
      getWorktree: () => undefined, getAlias: () => undefined,
    };
    state.locateSharedTranscriptFile = vi.fn(async () => undefined);
    state.discoveredRunState = vi.fn(async () => "idle");
    state.sessionParentId = vi.fn(async () => undefined);
    try {
      expect((await controller.listSessions()).map((row) => row.id)).toEqual(["live"]);
      expect(state.locateSharedTranscriptFile).toHaveBeenCalled();
      expect(state.locateSharedTranscriptFile.mock.calls.every(([id]: [string]) => id === "live")).toBe(true);
      expect(state.discoveredRunState.mock.calls.every(([id]: [string]) => id === "live")).toBe(true);
    } finally { controller.dispose(); }
  });

  it("returns saved history while a single attachment is pending and later refreshes settings", async () => {
    const { controller, state } = harness();
    const items = readableSession(state);
    const attach = deferred();
    state.ensureAttached = vi.fn(() => attach.promise);
    state.refreshSessionSettings = vi.fn(async () => undefined);
    try {
      expect(await controller.getTranscript("live")).toEqual(items);
      expect(await controller.getTranscript("live")).toEqual(items);
      expect(state.ensureAttached).toHaveBeenCalledTimes(1);
      expect(state.refreshSessionSettings).not.toHaveBeenCalled();
      const pending = state.transcriptAttachments.get("live");
      attach.resolve();
      await pending;
      expect(state.refreshSessionSettings).toHaveBeenCalledWith("live");
      expect(state.transcriptAttachments.size).toBe(0);
    } finally { attach.resolve(); controller.dispose(); }
  });

  it("keeps history readable when optional attachment fails", async () => {
    const { controller, state } = harness();
    const items = readableSession(state);
    state.ensureAttached = vi.fn(async () => { throw new Error("broker unavailable"); });
    state.refreshSessionSettings = vi.fn(async () => undefined);
    try {
      expect(await controller.getTranscript("live")).toEqual(items);
      await Promise.all([...state.transcriptAttachments.values()]);
      expect(state.refreshSessionSettings).not.toHaveBeenCalled();
      expect(state.terminalOnlySessions.has("live")).toBe(false);
    } finally { controller.dispose(); }
  });

  it("does not hide required attachment failures when no saved history exists", async () => {
    const { controller, state } = harness();
    readableSession(state);
    state.readSharedTranscript.mockResolvedValue([]);
    state.ensureAttached = vi.fn(async () => { throw new Error("broker unavailable"); });
    try {
      await expect(controller.getTranscript("live")).rejects.toThrow("broker unavailable");
      expect(state.ensureAttached).toHaveBeenCalledWith("live", true);
    } finally { controller.dispose(); }
  });

  it("does not refresh settings after disposal during a background attachment", async () => {
    const { controller, state } = harness();
    readableSession(state);
    const attach = deferred();
    state.ensureAttached = vi.fn(() => attach.promise);
    state.refreshSessionSettings = vi.fn(async () => undefined);
    await controller.getTranscript("live");
    const pending = state.transcriptAttachments.get("live");
    controller.dispose();
    attach.resolve();
    await pending;
    expect(state.refreshSessionSettings).not.toHaveBeenCalled();
  });

  it("does not rehost or attach after disposal interrupts endpoint inspection", async () => {
    const { controller, state } = harness();
    readableSession(state);
    const inspected = deferred();
    const entered = deferred();
    const rawGlobal = vi.fn();
    state.cli = {
      inspectSession: vi.fn(async () => { entered.resolve(); await inspected.promise; return { live: false }; }),
      rawGlobal,
    };
    await controller.getTranscript("live");
    const pending = state.transcriptAttachments.get("live");
    await entered.promise;
    controller.dispose();
    inspected.resolve();
    await pending;
    expect(rawGlobal).not.toHaveBeenCalled();
    expect(state.attachedSessions.size).toBe(0);
    expect(state.transcriptAttachments.size).toBe(0);
  });

  it("skips session list while the broker index revision is unchanged", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "broker-index-"));
    const previous = process.env.GJC_CODING_AGENT_DIR;
    process.env.GJC_CODING_AGENT_DIR = root;
    const index = path.join(root, "sessions", "index.jsonl");
    await mkdir(path.dirname(index), { recursive: true });
    await writeFile(index, "{\"sessionId\":\"s1\"}\n");
    const { controller, state } = harness();
    state.resolveExecutable = vi.fn(async () => "/gjc");
    state.recoverOwnedSessions = vi.fn(async () => undefined);
    state.locateSharedTranscriptFile = vi.fn(async () => undefined);
    state.discoveredRunState = vi.fn(async () => "idle");
    state.sessionParentId = vi.fn(async () => undefined);
    const list = vi.spyOn(GjcSdkCli.prototype, "listSessions").mockResolvedValue([
      { sessionId: "s1", repo: "/repo", live: true, deleted: false, endpointGeneration: 1 },
    ]);
    const version = vi.spyOn(GjcSdkCli.prototype, "version").mockResolvedValue("0.0.0");
    try {
      await controller.getConnection();
      expect(list).toHaveBeenCalledTimes(1);
      await controller.listSessions();
      await controller.listSessions();
      expect(list).toHaveBeenCalledTimes(1);
      await writeFile(index, "{\"sessionId\":\"s1\"}\n{\"sessionId\":\"s2\"}\n");
      await controller.listSessions();
      expect(list).toHaveBeenCalledTimes(2);
      // A delete or fork still has to see the broker, not the discovery cache.
      expect(await state.brokerSessions()).toEqual([
        expect.objectContaining({ sessionId: "s1" }),
      ]);
      expect(list).toHaveBeenCalledTimes(3);
    } finally {
      controller.dispose();
      list.mockRestore();
      version.mockRestore();
      if (previous === undefined) delete process.env.GJC_CODING_AGENT_DIR;
      else process.env.GJC_CODING_AGENT_DIR = previous;
      await rm(root, { recursive: true, force: true });
    }
  });
});
