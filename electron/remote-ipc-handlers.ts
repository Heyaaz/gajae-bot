import { ipcMain } from "electron";
import { isRemotePermission, parseRemotePort } from "../shared/remote-protocol.js";
import { REMOTE_IPC } from "../shared/remote-ipc.js";
import type { IpcSecurity } from "./ipc-security.js";
import type { RemoteAccessService } from "./remote/service.js";

/**
 * Desktop-side controls for remote access.
 *
 * These run through the same guarded IPC channel as every other renderer
 * request: only the app's own window may enable remote access, mint a pairing
 * code, or revoke a device.
 */

function deviceId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/u.test(value))
    throw new Error("Device ID is invalid");
  return value;
}

function permission(value: unknown) {
  if (!isRemotePermission(value)) throw new Error("Permission must be view or control");
  return value;
}

export function registerRemoteIpcHandlers(
  service: RemoteAccessService,
  security: IpcSecurity,
): () => void {
  const handle = (channel: string, handler: (...args: unknown[]) => unknown): void => {
    ipcMain.handle(channel, security.guarded((_event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => handler(...args)));
  };
  handle(REMOTE_IPC.getState, () => service.state());
  handle(REMOTE_IPC.refresh, () => service.state());
  handle(REMOTE_IPC.setEnabled, (enabled) => {
    if (typeof enabled !== "boolean") throw new Error("Enabled must be a boolean");
    return service.setEnabled(enabled);
  });
  handle(REMOTE_IPC.setPort, (port) => {
    const parsed = parseRemotePort(port);
    if (parsed === undefined) throw new Error("Port must be between 1024 and 65535");
    return service.setPort(parsed);
  });
  handle(REMOTE_IPC.issuePairingCode, (value) => service.issuePairingCode(permission(value)));
  handle(REMOTE_IPC.clearPairingCode, () => service.clearPairingCode());
  handle(REMOTE_IPC.setDevicePermission, (id, value) =>
    service.setDevicePermission(deviceId(id), permission(value)),
  );
  handle(REMOTE_IPC.revokeDevice, (id) => service.revokeDevice(deviceId(id)));
  handle(REMOTE_IPC.forgetDevice, (id) => service.forgetDevice(deviceId(id)));
  return () => {
    for (const channel of Object.values(REMOTE_IPC)) ipcMain.removeHandler(channel);
  };
}
