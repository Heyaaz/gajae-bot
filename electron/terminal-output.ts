/**
 * What the main process does with a shell's output before it reaches a view.
 *
 * node-pty delivers output in 1 KiB chunks on macOS, so a busy shell produces
 * tens of thousands of chunks a second. Both helpers keep the cost of a chunk
 * independent of how much is already buffered.
 */

/** A cut replay starts at the next line within this many characters, if there is one. */
const REPLAY_LINE_SEARCH = 4096;

/**
 * The tail of a shell's output. Chunks are kept as they came and joined only
 * when a view asks, because flattening the whole tail per chunk was what capped
 * terminal throughput.
 */
export class ReplayBuffer {
  private chunks: string[] = [];
  private length = 0;
  private trimmed = false;

  constructor(private readonly limit: number) {}

  push(chunk: string): void {
    this.chunks.push(chunk);
    this.length += chunk.length;
    while (this.chunks.length > 1 && this.length - this.chunks[0]!.length >= this.limit) {
      this.length -= this.chunks.shift()!.length;
      this.trimmed = true;
    }
  }

  read(): string {
    const text = this.chunks.join("");
    if (!this.trimmed && text.length <= this.limit) return text;
    // The cut can land inside an escape sequence, which would print as junk.
    const kept = text.slice(-this.limit);
    const newline = kept.slice(0, REPLAY_LINE_SEARCH).indexOf("\n");
    return newline < 0 ? kept : kept.slice(newline + 1);
  }
}

export interface OutputBatcher {
  push(data: string): void;
  /** Sends what is waiting now, so an event sent next stays behind the output before it. */
  flush(): void;
  /** Forgets what is waiting. For output a view will get some other way, or nobody will read. */
  discard(): void;
}

/** How long bulk output collects before it crosses to the renderer. */
export const TERMINAL_OUTPUT_BATCH_MS = 5;

/**
 * Coalesces output into one send per window. The first chunk after a quiet
 * moment goes straight out and opens the window, so a keystroke's echo never
 * waits for it.
 */
export function createOutputBatcher(
  send: (data: string) => void,
  windowMs: number = TERMINAL_OUTPUT_BATCH_MS,
): OutputBatcher {
  let pending = "";
  let timer: ReturnType<typeof setTimeout> | undefined;

  const stop = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const open = (): void => {
    timer = setTimeout(closeWindow, windowMs);
    timer.unref?.();
  };
  const take = (): void => {
    if (!pending) return;
    const data = pending;
    pending = "";
    send(data);
  };
  function closeWindow(): void {
    timer = undefined;
    if (!pending) return;
    take();
    open();
  }

  return {
    push(data: string): void {
      if (timer !== undefined) {
        pending += data;
        return;
      }
      send(data);
      open();
    },
    flush(): void {
      stop();
      take();
    },
    discard(): void {
      stop();
      pending = "";
    },
  };
}
