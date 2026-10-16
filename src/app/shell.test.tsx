import { readFile } from "node:fs/promises";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { SessionStatus, TranscriptItem } from "../backend/types";
import App, {
  composerTurnLive,
  escapeCancelsRun,
  isTextEntryTarget,
} from "./shell";

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

function tool(status: "running" | "approval-required"): TranscriptItem {
  return {
    id: `tool-${status}`,
    kind: "tool",
    sessionId: "session-1",
    name: "bash",
    description: "bun test",
    status,
    createdAt: "10:02",
  };
}

function streamingThought(): TranscriptItem {
  return {
    id: "thought-1",
    kind: "thought",
    sessionId: "session-1",
    content: "reading the controller",
    streaming: true,
    createdAt: "10:03",
  };
}

function streamingMessage(): TranscriptItem {
  return {
    id: "message-1",
    kind: "message",
    sessionId: "session-1",
    role: "assistant",
    content: "the fix is in",
    streaming: true,
    createdAt: "10:04",
  };
}

/**
 * The plan row the composer must not read as work: it stays in_progress after the
 * turn ended.
 */
function planInProgress(): TranscriptItem {
  return {
    id: "plan-1",
    kind: "plan",
    sessionId: "session-1",
    entries: [{ content: "ship the fix", status: "in_progress" }],
    createdAt: "10:05",
  };
}

function sessionState(
  status: SessionStatus | undefined,
  phase?: string,
): { status: SessionStatus | undefined; phase: string | undefined } {
  return { status, phase };
}

describe("composer turn state", () => {
  it("settles an idle row whose transcript still shows an unfinished turn", () => {
    // The reported bug: the row read 완료, but a tool card left `running` (or a
    // message left `streaming`) by the finished turn still outranked it, so the
    // composer held the next message as a steer and only released it after some
    // unrelated interaction.
    expect(composerTurnLive(sessionState("idle"), [tool("running")])).toBe(
      false,
    );
    expect(composerTurnLive(sessionState("idle"), [streamingThought()])).toBe(
      false,
    );
    expect(composerTurnLive(sessionState("idle"), [streamingMessage()])).toBe(
      false,
    );
  });

  it("does not hold messages behind a failed turn either", () => {
    // A failed row has no live turn left to steer into, and the release effect
    // only drains the composer's own queue on a running -> idle transition, so
    // reading this as running swallowed the message for good.
    expect(composerTurnLive(sessionState("failed"), [tool("running")])).toBe(
      false,
    );
  });

  it("keeps the states the composer really does queue behind", () => {
    expect(composerTurnLive(sessionState("running"), [])).toBe(true);
    expect(composerTurnLive(sessionState("waiting"), [])).toBe(true);
    // Compaction outlives the turn that started it and writes no live transcript
    // row of its own, so the row is the only account of it.
    expect(composerTurnLive(sessionState("idle", "compacting"), [])).toBe(true);
    expect(composerTurnLive(sessionState("running"), [tool("running")])).toBe(
      true,
    );
  });

  it("reads live transcript work while the row cannot answer yet", () => {
    // A starting session has not reported a turn, so work already underway there
    // is only visible in the transcript. The same holds before any row arrives.
    expect(composerTurnLive(sessionState("starting"), [tool("running")])).toBe(
      true,
    );
    expect(
      composerTurnLive(sessionState(undefined), [streamingMessage()]),
    ).toBe(true);
    expect(composerTurnLive(sessionState("starting"), [])).toBe(false);
    expect(composerTurnLive(null, [tool("running")])).toBe(false);
  });

  it("does not count the transcript rows that outlive their turn", () => {
    // A tool card awaiting approval and a plan entry left in_progress both stay
    // after the turn ended; counting either queued every later message.
    const afterTurn = [tool("approval-required"), planInProgress()];
    expect(composerTurnLive(sessionState("starting"), afterTurn)).toBe(false);
    expect(composerTurnLive(sessionState("idle"), afterTurn)).toBe(false);
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
