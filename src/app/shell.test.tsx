import { readFile } from "node:fs/promises";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import App, { escapeCancelsRun, isTextEntryTarget } from "./shell";

const actionProbe = vi.hoisted(() => ({
  rename: vi.fn(),
  stateChanges: vi.fn(),
  onRename: null as null | ((id: string, title: string) => void),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) => [
      typeof initial === "function" ? initial() : initial,
      actionProbe.stateChanges,
    ],
  };
});

vi.mock("../backend/use-agent-backend", () => ({
  useAgentBackend: () => ({ renameSession: actionProbe.rename }),
}));

vi.mock("./sidebar", () => ({
  Sidebar: (props: { onRename: (id: string, title: string) => void }) => {
    actionProbe.onRename = props.onRename;
    return null;
  },
}));

const root = path.resolve(import.meta.dirname, "../..");

async function source(file: string): Promise<string> {
  return await readFile(path.join(root, file), "utf8");
}

function press(
  overrides: Partial<Parameters<typeof escapeCancelsRun>[0]> = {},
): Parameters<typeof escapeCancelsRun>[0] {
  return {
    key: "Escape",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    defaultPrevented: false,
    textEntry: false,
    surfaceOpen: false,
    ...overrides,
  };
}

describe("Escape routing", () => {
  it("cancels the selected run for a plain Escape", () => {
    expect(escapeCancelsRun(press())).toBe(true);
    expect(escapeCancelsRun(press({ key: "Esc" }))).toBe(true);
  });

  it("leaves the key to whatever the user is typing into", () => {
    // The bug: a captured Escape reached the abort shortcut before the rename field
    // ever saw it, so closing the editor also cancelled the run behind it.
    expect(escapeCancelsRun(press({ textEntry: true }))).toBe(false);
    // The composer cancels the run from its own handler, so the shell must not fire a
    // second cancel on top of that one.
  });

  it("does not abort behind a surface that owns the key", () => {
    // The resume picker was the case that leaked: its Escape binding sits on the
    // search field, so Escape anywhere else in the dialog cancelled the run behind it.
    expect(escapeCancelsRun(press({ surfaceOpen: true }))).toBe(false);
  });

  it("ignores keys, chords and keys something else already took", () => {
    expect(escapeCancelsRun(press({ key: "Enter" }))).toBe(false);
    expect(escapeCancelsRun(press({ metaKey: true }))).toBe(false);
    expect(escapeCancelsRun(press({ ctrlKey: true }))).toBe(false);
    expect(escapeCancelsRun(press({ altKey: true }))).toBe(false);
    expect(escapeCancelsRun(press({ shiftKey: true }))).toBe(false);
    expect(escapeCancelsRun(press({ defaultPrevented: true }))).toBe(false);
  });
});

describe("text entry detection", () => {
  it("recognises the fields that own Escape", () => {
    expect(isTextEntryTarget({ tagName: "INPUT" })).toBe(true);
    expect(isTextEntryTarget({ tagName: "TEXTAREA" })).toBe(true);
    expect(isTextEntryTarget({ tagName: "SELECT" })).toBe(true);
    expect(isTextEntryTarget({ tagName: "DIV", isContentEditable: true })).toBe(
      true,
    );
  });

  it("does not claim a button, the page, or a missing target", () => {
    expect(isTextEntryTarget({ tagName: "BUTTON" })).toBe(false);
    expect(isTextEntryTarget({ tagName: "DIV" })).toBe(false);
    expect(isTextEntryTarget(null)).toBe(false);
  });
});

describe("Escape keyboard routing", () => {
  it("leaves Escape to the renderer instead of the native key forwarder", async () => {
    const main = await source("electron/main.ts");
    const handler = main.slice(main.indexOf('"before-input-event"'));
    const body = handler.slice(0, handler.indexOf('"will-navigate"'));
    // before-input-event runs ahead of every renderer handler and cannot see which
    // element has focus, so an Escape forwarded from there cancels runs the user is
    // still editing. The renderer DOM owns the key now.
    expect(body).toBeTruthy();
    expect(body).not.toContain('input.key === "Escape"');
    expect(body).not.toMatch(/send\(DESKTOP_IPC\.abortRun\)/u);
    // Shift+Tab is still forwarded: it is a shell-wide command with no editor meaning.
    expect(body).toContain("DESKTOP_IPC.cycleEffort");
  });

  it("listens in the bubble phase so a nearer handler gets the key first", async () => {
    const shell = await source("src/app/shell.tsx");
    expect(shell).toContain('window.addEventListener("keydown", abortWithEscape)');
    expect(shell).not.toContain(
      'window.addEventListener("keydown", abortWithEscape, true)',
    );
  });

  it("counts the resume picker among the surfaces that own Escape", async () => {
    const shell = await source("src/app/shell.tsx");
    const gate =
      shell.match(/const dismissibleSurfaceOpen =\n([\s\S]*?);\n/u)?.[1] ?? "";
    expect(gate).toBeTruthy();
    for (const surface of [
      "searchOpen",
      "newSessionOpen",
      "resumeOpen",
      "settingsOpen",
      "deleteCandidate",
    ])
      expect(gate).toContain(surface);
  });
});

describe("sidebar rename failures", () => {
  it("handles a rejected rename and surfaces its error", async () => {
    vi.stubGlobal("window", {});
    actionProbe.stateChanges.mockClear();
    actionProbe.rename.mockRejectedValueOnce(new Error("permission denied"));
    try {
      renderToStaticMarkup(createElement(App));
      expect(actionProbe.onRename).not.toBeNull();
      actionProbe.onRename!("session-id", "New title");
      await vi.waitFor(() => {
        expect(actionProbe.rename).toHaveBeenCalledWith("session-id", "New title");
        expect(actionProbe.stateChanges).toHaveBeenCalledWith("permission denied");
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
