import { afterEach, describe, expect, it, vi } from "vitest";

const windows: Array<Record<string, ReturnType<typeof vi.fn>>> = [];

vi.mock("electron", () => {
  class BrowserWindow {
    webContents = {
      isLoading: () => false,
      setWindowOpenHandler: vi.fn(),
      on: vi.fn(),
      send: vi.fn(),
    };
    setVisibleOnAllWorkspaces = vi.fn();
    setAlwaysOnTop = vi.fn();
    getSize = () => [640, 236];
    setPosition = vi.fn();
    show = vi.fn();
    focus = vi.fn();
    on = vi.fn();
    loadURL = vi.fn(async () => undefined);
    isDestroyed = () => false;
    constructor() {
      windows.push(this as never);
    }
  }
  return {
    BrowserWindow,
    ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
    screen: {
      getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1000, height: 800 } }),
      getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    },
    shell: { openExternal: vi.fn() },
  };
});

const { QuickInputWindow } = await import("./quick-input-window.js");

afterEach(() => {
  windows.length = 0;
});

function create() {
  return new QuickInputWindow({
    url: "file:///quick.html",
    preload: "/preload.js",
    security: { guarded: (fn: never) => fn, register: vi.fn(), dispose: vi.fn() } as never,
    captureDirectory: "/tmp/captures",
    screenAccess: () => "granted",
    projects: () => [],
    onSubmit: async () => undefined,
  });
}

describe("QuickInputWindow", () => {
  it.runIf(process.platform === "darwin")(
    "opens on the current Space and over full-screen apps",
    () => {
      create().show();
      expect(windows).toHaveLength(1);
      expect(windows[0]!.setVisibleOnAllWorkspaces).toHaveBeenCalledWith(true, {
        visibleOnFullScreen: true,
      });
      expect(windows[0]!.show).toHaveBeenCalled();
    },
  );
});
