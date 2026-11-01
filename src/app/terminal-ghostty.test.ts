import { describe, expect, it } from "vitest";
import { terminalKeyAction } from "./terminal-ghostty";

const press = (key: string, modifiers: { meta?: boolean; alt?: boolean; ctrl?: boolean; shift?: boolean } = {}) =>
  terminalKeyAction({
    key,
    metaKey: Boolean(modifiers.meta),
    altKey: Boolean(modifiers.alt),
    ctrlKey: Boolean(modifiers.ctrl),
    shiftKey: Boolean(modifiers.shift),
  });

describe("terminal keys", () => {
  it("moves and deletes the way Ghostty's macOS defaults do", () => {
    expect(press("ArrowLeft", { meta: true })).toEqual({ kind: "send", data: "\x01" });
    expect(press("ArrowRight", { meta: true })).toEqual({ kind: "send", data: "\x05" });
    expect(press("Backspace", { meta: true })).toEqual({ kind: "send", data: "\x15" });
    expect(press("ArrowLeft", { alt: true })).toEqual({ kind: "send", data: "\x1bb" });
    expect(press("ArrowRight", { alt: true })).toEqual({ kind: "send", data: "\x1bf" });
  });

  it("clears and selects on the Command shortcuts", () => {
    expect(press("k", { meta: true })).toEqual({ kind: "clear" });
    expect(press("a", { meta: true })).toEqual({ kind: "selectAll" });
  });

  it("leaves typing, copy, paste, and other combinations to the emulator", () => {
    expect(press("a")).toBeNull();
    expect(press("한")).toBeNull();
    expect(press("c", { meta: true })).toBeNull();
    expect(press("v", { meta: true })).toBeNull();
    expect(press("ArrowLeft")).toBeNull();
    expect(press("ArrowLeft", { meta: true, shift: true })).toBeNull();
    expect(press("a", { ctrl: true })).toBeNull();
  });
});
