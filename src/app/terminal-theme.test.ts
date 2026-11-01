import { describe, expect, it } from "vitest";
import { readTerminalTheme } from "./terminal-view";

describe("terminal theme", () => {
  it("uses Ghostty's default colors", () => {
    expect(readTerminalTheme()).toEqual({
      background: "#282c34",
      foreground: "#ffffff",
      cursor: "#ffffff",
      cursorAccent: "#282c34",
      selectionBackground: "#ffffff",
      selectionForeground: "#282c34",
      black: "#1d1f21",
      red: "#cc6666",
      green: "#b5bd68",
      yellow: "#f0c674",
      blue: "#81a2be",
      magenta: "#b294bb",
      cyan: "#8abeb7",
      white: "#c5c8c6",
      brightBlack: "#666666",
      brightRed: "#d54e53",
      brightGreen: "#b9ca4a",
      brightYellow: "#e7c547",
      brightBlue: "#7aa6da",
      brightMagenta: "#c397d8",
      brightCyan: "#70c0b1",
      brightWhite: "#eaeaea",
      scrollbarSliderBackground: "rgba(255, 255, 255, 0.16)",
      scrollbarSliderHoverBackground: "rgba(255, 255, 255, 0.28)",
      scrollbarSliderActiveBackground: "rgba(255, 255, 255, 0.36)",
    });
  });
});
