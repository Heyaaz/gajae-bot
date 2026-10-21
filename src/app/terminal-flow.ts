/**
 * Batched pause/resume for terminal output.
 *
 * herdr pauses the PTY reader until the browser has parsed the bytes it was
 * sent (`pty-data` write callback in `src/components/PaneTerminal.tsx`, and the
 * output acknowledgement in `src/lib/ws.ts`). The same idea here: once the
 * emulator is holding more than `highWater` characters, the main process
 * pauses the native reader; it resumes once the parsed backlog falls to
 * `lowWater`.
 *
 * Copyright (c) 2026 devswha for the acknowledgement approach, MIT License.
 * See THIRD_PARTY_NOTICES.md.
 */

export interface OutputGate {
  push(bytes: number): void;
  ack(bytes: number): void;
  /** Drops the backlog and resumes the reader. Used when the view goes away. */
  reset(): void;
}

export function createOutputGate(options: {
  highWater: number;
  lowWater: number;
  setPaused: (paused: boolean) => void;
}): OutputGate {
  let pending = 0;
  let paused = false;

  const sync = (): void => {
    if (!paused && pending >= options.highWater) {
      paused = true;
      options.setPaused(true);
      return;
    }
    if (paused && pending <= options.lowWater) {
      paused = false;
      options.setPaused(false);
    }
  };

  return {
    push(bytes: number): void {
      if (bytes > 0) pending += bytes;
      sync();
    },
    ack(bytes: number): void {
      pending = Math.max(0, pending - Math.max(0, bytes));
      sync();
    },
    reset(): void {
      pending = 0;
      if (!paused) return;
      paused = false;
      options.setPaused(false);
    },
  };
}

/** Pause the reader once a quarter megabyte is waiting on the emulator. */
export const TERMINAL_OUTPUT_HIGH_WATER = 256 * 1024;
/** Resume once the backlog has drained to this. */
export const TERMINAL_OUTPUT_LOW_WATER = 64 * 1024;
