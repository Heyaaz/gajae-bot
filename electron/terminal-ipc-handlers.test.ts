import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron";
import type { AgentSession } from "../shared/agent-contract.js";
import type { IpcSecurity } from "./ipc-security.js";
import { registerTerminalIpcHandlers, terminalStartRequest } from "./terminal-ipc-handlers.js";
import type { LoginShellOptions, LoginShellSession } from "./terminal-session.js";
import { TerminalSessionStore } from "./terminal-session-store.js";
import { TERMINAL_IPC, type TerminalSessionInfo } from "../shared/terminal-ipc.js";

const handled = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());
const listened = vi.hoisted(() => new Map<string, (...args: unknown[]) => void>());

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      handled.set(channel, handler);
    },
    removeHandler: (channel: string) => {
      handled.delete(channel);
    },
    on: (channel: string, handler: (...args: unknown[]) => void) => {
      listened.set(channel, handler);
    },
    removeListener: (channel: string) => {
      listened.delete(channel);
    },
  },
}));

function security(allowed: boolean): IpcSecurity {
  return {
    isAllowed: () => allowed,
    guarded: (handler: (...args: unknown[]) => unknown) => (event: unknown, ...args: unknown[]) => {
      if (!allowed) throw new Error("Unauthorized IPC sender");
      return handler(event, ...args);
    },
  } as unknown as IpcSecurity;
}

describe("terminal IPC", () => {
  it("requires a start token", () => {
    expect(() => terminalStartRequest({})).toThrow(/token/i);
    expect(terminalStartRequest({ token: 4, cwd: "/tmp", cols: 20 })).toMatchObject({
      token: 4,
      cwd: "/tmp",
      cols: 20,
    });
  });

  it("forwards frames to the session and drops them for an unauthorized sender", async () => {
    const handle = vi.fn();
    const dispose = vi.fn();
    const session = { handle, dispose } as unknown as LoginShellSession;
    const registration = registerTerminalIpcHandlers(security(true), {
      open: () => session,
    });
    const sender = { id: 7, isDestroyed: () => false, send: vi.fn() };
    const event = { sender } as unknown as IpcMainInvokeEvent;
    const started = await handled.get(TERMINAL_IPC.start)!(event, {
      token: 3,
      cwd: "/tmp",
      cols: 40,
      rows: 12,
    });
    expect(started).toMatchObject({ id: expect.any(String), cwd: "/tmp" });

    const id = (started as { id: string }).id;
    listened.get(TERMINAL_IPC.input)!(event as unknown as IpcMainEvent, id, "ls\r");
    listened.get(TERMINAL_IPC.resize)!(event as unknown as IpcMainEvent, id, 100, 40);
    listened.get(TERMINAL_IPC.pause)!(event as unknown as IpcMainEvent, id, true);
    listened.get(TERMINAL_IPC.input)!(event as unknown as IpcMainEvent, "another-shell", "rm\r");
    expect(handle).toHaveBeenCalledWith({ t: "i", d: "ls\r" });
    expect(handle).toHaveBeenCalledWith({ t: "r", c: 100, r: 40 });
    expect(handle).toHaveBeenCalledWith({ t: "p", paused: true });
    expect(handle).toHaveBeenCalledTimes(3);

    registration.unregister();
    expect(dispose).toHaveBeenCalled();
  });

  it("ignores input from a sender the window does not own", async () => {
    let allowed = true;
    const handle = vi.fn();
    registerTerminalIpcHandlers(
      {
        isAllowed: () => allowed,
        guarded: (handler: (...args: unknown[]) => unknown) => (event: unknown, ...args: unknown[]) => {
          if (!allowed) throw new Error("Unauthorized IPC sender");
          return handler(event, ...args);
        },
      } as unknown as IpcSecurity,
      { open: () => ({ handle, dispose: vi.fn() }) as unknown as LoginShellSession },
    );
    const sender = { id: 1, isDestroyed: () => false, send: vi.fn() };
    const { id } = (await handled.get(TERMINAL_IPC.start)!({ sender }, { token: 1, cwd: "/tmp" })) as {
      id: string;
    };
    allowed = false;
    listened.get(TERMINAL_IPC.input)!({ sender } as unknown as IpcMainEvent, id, "rm\r");
    expect(handle).not.toHaveBeenCalled();
    expect(() => handled.get(TERMINAL_IPC.start)!({ sender }, { token: 2 })).toThrow(/Unauthorized/);
  });

  it("cancels a start whose dispose already arrived, and kills the shell when the window closes", async () => {
    const opened: Array<{ dispose: ReturnType<typeof vi.fn> }> = [];
    const registration = registerTerminalIpcHandlers(security(true), {
      open: () => {
        const session = { handle: vi.fn(), dispose: vi.fn() };
        opened.push(session);
        return session as unknown as LoginShellSession;
      },
    });
    const sender = { id: 9, isDestroyed: () => false, send: vi.fn() };
    await handled.get(TERMINAL_IPC.dispose)!({ sender }, 11);
    expect(() => handled.get(TERMINAL_IPC.start)!({ sender }, { token: 11, cwd: "/tmp" })).toThrow(
      /cancelled/,
    );
    expect(opened).toHaveLength(0);

    await handled.get(TERMINAL_IPC.start)!({ sender }, { token: 12, cwd: "/tmp" });
    const listeners = new Map<string, () => void>();
    registration.bindWindow({
      webContents: { id: 9, once: (event: string, callback: () => void) => listeners.set(event, callback) },
      on: (event: string, callback: () => void) => listeners.set(event, callback),
    } as never);
    listeners.get("closed")!();
    expect(opened[0]?.dispose).toHaveBeenCalled();
  });
});

describe("terminal sessions", () => {
  type Opened = {
    options: LoginShellOptions;
    handle: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  };

  function setup(options: { confirm?: boolean } = {}) {
    const directory = mkdtempSync(path.join(tmpdir(), "terminal-sessions-"));
    const store = new TerminalSessionStore(directory);
    const opened: Opened[] = [];
    const open = (sessionOptions: LoginShellOptions) => {
      const entry: Opened = { options: sessionOptions, handle: vi.fn(), dispose: vi.fn() };
      opened.push(entry);
      return { handle: entry.handle, dispose: entry.dispose } as unknown as LoginShellSession;
    };
    const confirm = vi.fn(async () => options.confirm ?? true);
    const grants = new Set<string>();
    const ipcSecurity = {
      ...security(true),
      preauthorize: vi.fn(async (_event: unknown, grant: string) => {
        if (!(await confirm())) return false;
        grants.add(grant);
        return true;
      }),
      authorizeDestructive: vi.fn(async (_event: unknown, _content: unknown, grant?: string) => {
        if (grant && grants.delete(grant)) return;
        if (!(await confirm())) throw new Error("Operation cancelled");
      }),
    } as unknown as IpcSecurity;
    const registration = registerTerminalIpcHandlers(ipcSecurity, { store, open });
    const sender = { id: 21, isDestroyed: () => false, send: vi.fn() };
    const event = { sender } as unknown as IpcMainInvokeEvent;
    const call = (channel: string, ...args: unknown[]) => handled.get(channel)!(event, ...args);
    return { directory, store, opened, confirm, registration, sender, call };
  }

  it("keeps a session's shell when its view goes away and replays it to the next view", async () => {
    const { directory, opened, call } = setup();
    const session = (await call(TERMINAL_IPC.createSession, {
      title: "빌드",
      workspace: directory,
    })) as AgentSession;
    expect(session).toMatchObject({ runtime: "terminal", workspace: directory });

    const first = (await call(TERMINAL_IPC.start, { token: 1, session: session.id })) as TerminalSessionInfo;
    expect(opened[0]?.options.cwd).toBe(directory);
    opened[0]!.options.onData("hello\r\n");
    await call(TERMINAL_IPC.dispose, 1);
    expect(opened[0]!.dispose).not.toHaveBeenCalled();

    const again = (await call(TERMINAL_IPC.start, { token: 2, session: session.id })) as TerminalSessionInfo;
    expect(again).toMatchObject({ id: first.id, replay: "hello\r\n" });
    expect(opened).toHaveLength(1);

    opened[0]!.options.onExit({ exitCode: 3 });
    const exited = (await call(TERMINAL_IPC.start, { token: 3, session: session.id })) as TerminalSessionInfo;
    expect(exited).toMatchObject({ id: first.id, exitCode: 3 });

    const restarted = (await call(TERMINAL_IPC.start, {
      token: 4,
      session: session.id,
      restart: true,
    })) as TerminalSessionInfo;
    expect(restarted.id).not.toBe(first.id);
    expect(opened[0]!.dispose).toHaveBeenCalled();
    expect(opened).toHaveLength(2);
  });

  it("opens one shell for two views that start the same session at once", async () => {
    const { directory, opened, call } = setup();
    const session = (await call(TERMINAL_IPC.createSession, {
      title: "a",
      workspace: directory,
    })) as AgentSession;
    const [left, right] = (await Promise.all([
      call(TERMINAL_IPC.start, { token: 1, session: session.id }),
      call(TERMINAL_IPC.start, { token: 2, session: session.id }),
    ])) as TerminalSessionInfo[];
    expect(left!.id).toBe(right!.id);
    expect(opened).toHaveLength(1);
  });

  it("closes the session's shell and waits for it to exit before forgetting the session", async () => {
    const { directory, store, opened, confirm, call } = setup();
    const session = (await call(TERMINAL_IPC.createSession, {
      title: "빌드",
      workspace: directory,
    })) as AgentSession;
    await call(TERMINAL_IPC.start, { token: 1, session: session.id });
    expect(opened[0]!.options.cwd).toBe(directory);
    opened[0]!.dispose.mockImplementation(() => opened[0]!.options.onExit({ exitCode: 129 }));

    expect(await call(TERMINAL_IPC.confirmSessionRemoval, session.id)).toBe(true);
    await call(TERMINAL_IPC.deleteSession, session.id);

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(opened[0]!.dispose).toHaveBeenCalled();
    expect(store.get(session.id)).toBeUndefined();
    expect(await call(TERMINAL_IPC.listSessions)).toEqual([]);
  });

  it("keeps the session when the user declines the delete", async () => {
    const { directory, store, opened, call } = setup({ confirm: false });
    const session = (await call(TERMINAL_IPC.createSession, {
      title: "keep",
      workspace: directory,
    })) as AgentSession;
    await call(TERMINAL_IPC.start, { token: 1, session: session.id });
    expect(await call(TERMINAL_IPC.confirmSessionRemoval, session.id)).toBe(false);
    await expect(call(TERMINAL_IPC.deleteSession, session.id)).rejects.toThrow(/cancelled/);
    expect(opened[0]!.dispose).not.toHaveBeenCalled();
    expect(store.get(session.id)).toBeDefined();
  });

  it("rejects a session id that is not a terminal session and a folder that does not exist", () => {
    const { directory, call } = setup();
    expect(() => terminalStartRequest({ token: 1, session: "gjc-session" })).toThrow(/invalid/);
    expect(() =>
      call(TERMINAL_IPC.createSession, {
        title: "x",
        workspace: path.join(directory, "missing"),
      }),
    ).toThrow(/existing folder/);
  });

  it("lists terminal sessions again after a restart", async () => {
    const { directory, call } = setup();
    const session = (await call(TERMINAL_IPC.createSession, {
      title: "다시",
      workspace: directory,
    })) as AgentSession;
    await call(TERMINAL_IPC.renameSession, session.id, "  새 이름  ");
    expect(new TerminalSessionStore(directory).list()).toEqual([
      expect.objectContaining({ id: session.id, title: "새 이름", workspace: directory }),
    ]);
  });
});
