import { describe, expect, it, vi } from "vitest";
import {
  IpcSecurity,
  expectedTopLevelUrl,
  quickInputUrl,
  rendererLaunchConfig,
  type DestructiveConfirmation,
} from "./ipc-security.js";

function fakeWindow(id = 1) {
  const listeners = new Map<string, () => void>();
  const webContents = {
    id,
    isDestroyed: () => false,
    mainFrame: { url: "file:///app/dist/index.html" },
    once: (event: string, callback: () => void) => listeners.set(`wc:${event}`, callback),
  } as any;
  const window = {
    webContents,
    isDestroyed: () => false,
    once: (event: string, callback: () => void) => listeners.set(event, callback),
  } as any;
  return { window, webContents, listeners };
}

const eventFor = (webContents: any, frame = webContents.mainFrame) => ({
  sender: webContents,
  senderFrame: frame,
}) as any;

describe("IpcSecurity", () => {
  it("builds exact top-level URLs", () => {
    expect(expectedTopLevelUrl("http://127.0.0.1:5173", "/app")).toBe("http://127.0.0.1:5173/");
    expect(expectedTopLevelUrl(undefined, "/app")).toBe("file:///app/dist/index.html");
    expect(expectedTopLevelUrl(undefined, "/app with space", true)).toBe(
      "file:///app%20with%20space/dist/index.html?backend=mock",
    );
  });

  it("gives the quick input window its own exact URL, which the main window's guard does not accept", () => {
    expect(quickInputUrl("http://127.0.0.1:5173", "/app")).toBe(
      "http://127.0.0.1:5173/?window=quick-input",
    );
    expect(quickInputUrl(undefined, "/app")).toBe(
      "file:///app/dist/index.html?window=quick-input",
    );
    const security = new IpcSecurity();
    const { window, webContents } = fakeWindow();
    security.register(window, expectedTopLevelUrl(undefined, "/app"));
    webContents.mainFrame.url = quickInputUrl(undefined, "/app");
    expect(security.isAllowed(eventFor(webContents))).toBe(false);
  });

  it("ignores development renderer and smoke switches in packaged mode", () => {
    expect(
      rendererLaunchConfig(
        true,
        { VITE_DEV_SERVER_URL: "https://attacker.example" },
        ["Gajae", "--smoke", "--gjc-smoke", "--deep-link-smoke"],
      ),
    ).toEqual({
      developmentUrl: undefined,
      mockSmokeMode: false,
      gjcSmokeMode: false,
      smokeMode: false,
      terminalSmokeMode: false,
      deepLinkSmokeMode: false,
    });
    expect(
      rendererLaunchConfig(
        false,
        { VITE_DEV_SERVER_URL: " http://127.0.0.1:5173 " },
        ["electron", ".", "--smoke"],
      ),
    ).toEqual({
      developmentUrl: "http://127.0.0.1:5173",
      mockSmokeMode: true,
      gjcSmokeMode: false,
      smokeMode: true,
      terminalSmokeMode: false,
      deepLinkSmokeMode: false,
    });
    expect(rendererLaunchConfig(false, {}, ["electron", "--terminal-smoke"])).toMatchObject({
      mockSmokeMode: false,
      smokeMode: false,
      terminalSmokeMode: true,
    });
    expect(rendererLaunchConfig(false, {}, ["electron", ".", "--deep-link-smoke"])).toMatchObject({
      smokeMode: false,
      deepLinkSmokeMode: true,
    });
  });

  it("rejects unowned, wrong URL, child frame, and destroyed senders", () => {
    const security = new IpcSecurity(vi.fn());
    const { window, webContents } = fakeWindow();
    expect(security.isAllowed(eventFor(webContents))).toBe(false);
    security.register(window, webContents.mainFrame.url);
    expect(security.isAllowed(eventFor(webContents))).toBe(true);
    expect(security.isAllowed(eventFor(webContents, { url: webContents.mainFrame.url }))).toBe(false);
    expect(security.isAllowed(eventFor(webContents, { url: "file:///other" }))).toBe(false);
    webContents.isDestroyed = () => true;
    expect(security.isAllowed(eventFor(webContents))).toBe(false);
  });

  it("cleans up idempotently and fails closed after disposal", () => {
    const security = new IpcSecurity(vi.fn());
    const { window, webContents, listeners } = fakeWindow();
    const cleanup = security.register(window, webContents.mainFrame.url);
    cleanup(); cleanup();
    expect(security.isAllowed(eventFor(webContents))).toBe(false);
    security.register(window, webContents.mainFrame.url);
    security.dispose();
    expect(security.isAllowed(eventFor(webContents))).toBe(false);
    listeners.get("closed")?.();
    expect(security.isAllowed(eventFor(webContents))).toBe(false);
  });

  it("supports injectable destructive confirmation", async () => {
    const confirm: DestructiveConfirmation = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const security = new IpcSecurity(confirm);
    const { window, webContents } = fakeWindow();
    security.register(window, webContents.mainFrame.url);
    const event = eventFor(webContents);
    await expect(
      security.authorizeDestructive(event, { message: "delete" }),
    ).rejects.toThrow("Operation cancelled");
    await expect(
      security.authorizeDestructive(event, { message: "delete" }),
    ).resolves.toBeUndefined();
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(confirm).toHaveBeenLastCalledWith({ message: "delete", window });
  });

  it("rejects a destructive operation when its window disappears during confirmation", async () => {
    let resolveConfirmation: (confirmed: boolean) => void = () => undefined;
    const confirmation = new Promise<boolean>((resolve) => {
      resolveConfirmation = resolve;
    });
    const security = new IpcSecurity(() => confirmation);
    const { window, webContents } = fakeWindow();
    security.register(window, webContents.mainFrame.url);

    const authorization = security.authorizeDestructive(eventFor(webContents), {
      message: "delete",
    });
    webContents.isDestroyed = () => true;
    resolveConfirmation(true);

    await expect(authorization).rejects.toThrow("Unauthorized IPC sender");
  });

  it("allows only one destructive confirmation per renderer", async () => {
    let resolveConfirmation: (confirmed: boolean) => void = () => undefined;
    const confirmation = new Promise<boolean>((resolve) => {
      resolveConfirmation = resolve;
    });
    const security = new IpcSecurity(() => confirmation);
    const { window, webContents } = fakeWindow();
    security.register(window, webContents.mainFrame.url);
    const event = eventFor(webContents);

    const first = security.authorizeDestructive(event, { message: "delete A" });
    await expect(
      security.authorizeDestructive(event, { message: "push B" }),
    ).rejects.toThrow("already in progress");
    resolveConfirmation(true);
    await expect(first).resolves.toBeUndefined();
  });
});
