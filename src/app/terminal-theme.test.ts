import { describe, expect, it } from "vitest";
import { readTerminalTheme } from "./terminal-view";

describe("terminal theme", () => {
  it("uses a consistent dark palette with readable normal and bright ANSI colors", () => {
    expect(readTerminalTheme()).toEqual({
      background: "#17191d",
      foreground: "#e6e8eb",
      cursor: "#ffad66",
      cursorAccent: "#17191d",
      selectionBackground: "rgba(240, 100, 22, 0.35)",
      black: "#343840",
      red: "#ff7b72",
      green: "#7ee787",
      yellow: "#e3b341",
      blue: "#79c0ff",
      magenta: "#d2a8ff",
      cyan: "#56d4dd",
      white: "#e6e8eb",
      brightBlack: "#8b949e",
      brightRed: "#ffa198",
      brightGreen: "#aff5b4",
      brightYellow: "#f2cc60",
      brightBlue: "#a5d6ff",
      brightMagenta: "#e2c5ff",
      brightCyan: "#a5f3fc",
      brightWhite: "#ffffff",
    });
  });
});
