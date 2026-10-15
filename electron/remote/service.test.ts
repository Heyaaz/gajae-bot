import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  REMOTE_API,
  REMOTE_OPERATION_ACCESS,
  remoteOperationRequiresControl,
  type RemoteOperationName,
} from "../../shared/remote-protocol.js";
import type { RemoteOperationsHost } from "./operations.js";
import { remoteMessageInput, runRemoteOperation } from "./operations.js";
import { RemoteAccessService } from "./service.js";
import { TailscaleClient } from "./tailscale.js";

const directories: string[] = [];
const services: RemoteAccessService[] = [];

afterEach(async () => {
  for (const service of services.splice(0)) await service.dispose();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const OPERATIONS: RemoteOperationName[] = [
  "state",
  "history-sessions",
  "transcript",
  "queued",
  "goal",
  "subagents",
  "git-status",
  "diff",
  "artifact",
  "send-message",
  "steer",
  "queue-follow-up",
  "flush-follow-ups",
  "cancel-run",
  "resolve-tool-call",
  "mark-read",
];

function fakeHost(): RemoteOperationsHost & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async getConnection() {
      return {
        state: "connected" as const,
        backend: "gjc" as const,
        label: "GJC",
        detail: "",
        workspace: "/tmp/ws",
      };
    },
    async listSessions() {
      return [];
    },
    async listHistorySessions() {
      return [];
    },
    async getTranscript(sessionId: string) {
      calls.push(`transcript:${sessionId}`);
      return [];
    },
    async listQueuedMessages() {
      return [];
    },
    async getGoal() {
      return { enabled: false, completed: 0, total: 0 };
    },
    async listSubagents() {
      return [];
    },
    async getGitStatus() {
      return {};
    },
    async getDiff() {
      return {};
    },
    async readArtifact(sessionId: string, artifactId: string) {
      calls.push(`artifact:${sessionId}:${artifactId}`);
      return { artifactId, text: "", complete: true, totalBytes: 0 };
    },
    async sendMessage(sessionId: string) {
      calls.push(`send:${sessionId}`);
      return "prompt" as const;
    },
    async steerSession(sessionId: string) {
      calls.push(`steer:${sessionId}`);
    },
    async queueFollowUp(sessionId: string) {
      calls.push(`queue:${sessionId}`);
    },
    async flushQueuedNow() {
      return true;
    },
    async cancelRun(sessionId: string) {
      calls.push(`cancel:${sessionId}`);
    },
    async resolveToolCall(toolId: string) {
      calls.push(`tool:${toolId}`);
    },
    async markSessionRead(sessionId: string) {
      calls.push(`read:${sessionId}`);
    },
  };
}

describe("remote operation surface", () => {
  it("declares an access level for every operation", () => {
    for (const operation of OPERATIONS) {
      expect(REMOTE_OPERATION_ACCESS[operation]).toMatch(/^(view|control)$/u);
    }
    expect(Object.keys(REMOTE_OPERATION_ACCESS).sort()).toEqual([...OPERATIONS].sort());
  });

  it("keeps host-destructive operations out of the remote surface", () => {
    const destructive = ["delete-session", "compact-session", "commit", "push", "create-session"];
    for (const name of destructive)
      expect(Object.keys(REMOTE_OPERATION_ACCESS)).not.toContain(name);
  });

  it("gates exactly the conversation controls behind control permission", () => {
    const control = OPERATIONS.filter(remoteOperationRequiresControl);
    expect(control.sort()).toEqual(
      [
        "cancel-run",
        "flush-follow-ups",
        "mark-read",
        "queue-follow-up",
        "resolve-tool-call",
        "send-message",
        "steer",
      ].sort(),
    );
  });

  it("accepts inline images but never a native attachment reference", () => {
    const image = { id: "i1", name: "shot.png", mimeType: "image/png", data: "AAAA" };
    expect(remoteMessageInput({ text: "hi", images: [image], files: [] })).toMatchObject({
      text: "hi",
      images: [{ id: "i1", name: "shot.png" }],
      files: [],
    });
    expect(() =>
      remoteMessageInput({
        text: "hi",
        images: [],
        files: [{ id: "f1", name: "note.txt", mimeType: "text/plain", size: 1, token: "t".repeat(43) }],
      }),
    ).toThrow("native files");
    expect(() =>
      remoteMessageInput({
        text: "hi",
        images: [{ ...image, token: "t".repeat(43) }],
        files: [],
      }),
    ).toThrow("prepared attachments");
  });

  it("dispatches to the host with validated identifiers", async () => {
    const host = fakeHost();
    await runRemoteOperation(host, "transcript", { sessionId: "s-1" }, undefined);
    expect(host.calls).toEqual(["transcript:s-1"]);
    await expect(
      runRemoteOperation(host, "transcript", { sessionId: "../../etc/passwd" }, undefined),
    ).rejects.toThrow("Session ID is invalid");
    await expect(runRemoteOperation(host, "send-message", { sessionId: "s-1" }, {})).rejects.toThrow(
      "Message input is required",
    );
  });
});

describe("remote access service", () => {
  async function service(options: { port?: number } = {}) {
    const directory = mkdtempSync(path.join(tmpdir(), "gajae-remote-service-"));
    directories.push(directory);
    const webRoot = path.join(directory, "web");
    mkdirSync(webRoot, { recursive: true });
    writeFileSync(path.join(webRoot, "index.web.html"), "<!doctype html><title>remote</title>");
    const logs: string[] = [];
    const instance = new RemoteAccessService({
      userDataDirectory: directory,
      webRoot,
      version: "0.1.0",
      workspace: () => "/tmp/ws",
      host: fakeHost(),
      tailscale: new TailscaleClient({
        runner: async () => ({ stdout: "", stderr: "not found", code: 1 }),
      }),
      log: (message) => logs.push(message),
    });
    services.push(instance);
    return { instance, directory, logs };
  }

  it("stays off until it is enabled and then serves the tailnet", async () => {
    const { instance } = await service();
    const initial = await instance.state();
    expect(initial).toMatchObject({ enabled: false, running: false });
    const enabled = await instance.setEnabled(true);
    expect(enabled).toMatchObject({ enabled: true, running: true, tailscale: { installed: false } });
    const response = await fetch(`http://127.0.0.1:${enabled.port}${REMOTE_API.state}`);
    expect(response.status).toBe(401);
  });

  it("hands a code to a phone and lists the device, then refuses it after revocation", async () => {
    const { instance } = await service();
    await instance.setEnabled(true);
    const withCode = await instance.issuePairingCode("control");
    expect(withCode.pairing?.code).toMatch(/^[2-9A-HJKMNP-Z]{8}$/u);
    const port = withCode.port;
    const paired = await fetch(`http://127.0.0.1:${port}${REMOTE_API.pair}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: `http://127.0.0.1:${port}` },
      body: JSON.stringify({ code: withCode.pairing!.code, deviceName: "Pixel" }),
    });
    expect(paired.status).toBe(200);
    const { token, deviceId } = (await paired.json()) as { token: string; deviceId: string };
    const state = await instance.state();
    expect(state.devices).toHaveLength(1);
    expect(state.devices[0]).toMatchObject({ name: "Pixel", permission: "control" });
    expect(state.pairing).toBeNull();

    await instance.revokeDevice(deviceId);
    const after = await fetch(`http://127.0.0.1:${port}${REMOTE_API.state}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(after.status).toBe(401);
    expect((await instance.state()).devices).toEqual([]);
  });

  it("moves the listener when the port changes and stops when disabled", async () => {
    const { instance } = await service();
    const enabled = await instance.setEnabled(true);
    const firstPort = enabled.port;
    const moved = await instance.setPort(firstPort === 8791 ? 8792 : 8791);
    expect(moved.port).not.toBe(firstPort);
    await expect(fetch(`http://127.0.0.1:${firstPort}${REMOTE_API.state}`)).rejects.toThrow();
    const stopped = await instance.setEnabled(false);
    expect(stopped.running).toBe(false);
    await expect(fetch(`http://127.0.0.1:${moved.port}${REMOTE_API.state}`)).rejects.toThrow();
  });

  it("refuses to pair while remote access is off", async () => {
    const { instance } = await service();
    await expect(instance.issuePairingCode("view")).rejects.toThrow("Turn remote access on first");
  });

  it("refuses a port outside the usable range", async () => {
    const { instance } = await service();
    await expect(instance.setPort(80)).rejects.toThrow("Port must be between");
  });
});
