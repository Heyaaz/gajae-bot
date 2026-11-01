/**
 * Terminal defaults taken from Ghostty, as `ghostty +show-config --default` and
 * `ghostty +list-keybinds --default` report them on macOS.
 */

export const TERMINAL_OPTIONS = {
  cursorBlink: true,
  cursorStyle: "block",
  fontFamily: '"Gajae Terminal Mono", Menlo, "Gajae Terminal Symbols", monospace',
  fontSize: 13,
  lineHeight: 1,
  drawBoldTextInBrightColors: false,
  scrollback: 10_000,
  macOptionClickForcesSelection: true,
} as const;

/** The fonts a terminal has to measure its cells with. */
export const TERMINAL_FONTS: ReadonlyArray<readonly [font: string, sample?: string]> = [
  ['13px "Gajae Terminal Mono"'],
  ['bold 13px "Gajae Terminal Mono"'],
  ['13px "Gajae Terminal Symbols"', "󰆍"],
];

export type TerminalKeyAction =
  | { kind: "send"; data: string }
  | { kind: "clear" }
  | { kind: "selectAll" };

/** What a key press means beyond what the emulator does with it, or null for nothing extra. */
export function terminalKeyAction(
  event: Pick<KeyboardEvent, "key" | "metaKey" | "altKey" | "ctrlKey" | "shiftKey">,
): TerminalKeyAction | null {
  if (event.ctrlKey || event.shiftKey) return null;
  if (event.metaKey && !event.altKey) {
    switch (event.key) {
      case "ArrowLeft":
        return { kind: "send", data: "\x01" };
      case "ArrowRight":
        return { kind: "send", data: "\x05" };
      case "Backspace":
        return { kind: "send", data: "\x15" };
      case "k":
        return { kind: "clear" };
      case "a":
        return { kind: "selectAll" };
      default:
        return null;
    }
  }
  if (event.altKey && !event.metaKey) {
    if (event.key === "ArrowLeft") return { kind: "send", data: "\x1bb" };
    if (event.key === "ArrowRight") return { kind: "send", data: "\x1bf" };
  }
  return null;
}
