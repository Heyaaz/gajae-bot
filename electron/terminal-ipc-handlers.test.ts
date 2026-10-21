import { describe, expect, it, vi } from "vitest";
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron";
import type { IpcSecurity } from "./ipc-security.js";
import { registerTerminalIpcHandlers, terminalStartRequest } from "./terminal-ipc-handlers.js";
import type { LoginShellSession } from "./terminal-session.js";
import { TERMINAL_IPC } from "../shared/terminal-ipc.js";

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

    listened.get(TERMINAL_IPC.input)!(event as unknown as IpcMainEvent, "ls\r");
    listened.get(TERMINAL_IPC.resize)!(event as unknown as IpcMainEvent, 100, 40);
    listened.get(TERMINAL_IPC.pause)!(event as unknown as IpcMainEvent, true);
    expect(handle).toHaveBeenCalledWith({ t: "i", d: "ls\r" });
    expect(handle).toHaveBeenCalledWith({ t: "r", c: 100, r: 40 });
    expect(handle).toHaveBeenCalledWith({ t: "p", paused: true });

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
    await handled.get(TERMINAL_IPC.start)!({ sender }, { token: 1, cwd: "/tmp" });
    allowed = false;
    listened.get(TERMINAL_IPC.input)!({ sender } as unknown as IpcMainEvent, "rm\r");
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
