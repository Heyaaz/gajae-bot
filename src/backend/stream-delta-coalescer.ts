import type { AgentEvent } from "./types";

/** Desktop and remote share this. A long reply is one parse per frame, not per chunk. */
export const STREAM_DELTA_FLUSH_MS = 16;

type StreamDelta = Extract<AgentEvent, { type: "message.delta" | "thought.delta" }>;

/**
 * Joins message and thought deltas that arrive inside one frame.
 *
 * A non-delta is published immediately, after any text already waiting, so a
 * transcript sync cannot land in front of the chunks it replaces.
 */
export class StreamDeltaCoalescer {
  private readonly pending = new Map<string, StreamDelta>();
  private timer?: ReturnType<typeof setTimeout>;
  private readonly emit: (event: AgentEvent) => void;

  constructor(emit: (event: AgentEvent) => void) {
    this.emit = emit;
  }

  receive(event: AgentEvent): void {
    if (event.type !== "message.delta" && event.type !== "thought.delta") {
      this.flush();
      this.emit(event);
      return;
    }

    const itemId = event.type === "message.delta" ? event.messageId : event.thoughtId;
    const key = `${event.type}:${event.sessionId}:${itemId}`;
    const pending = this.pending.get(key);
    const combined =
      pending && pending.type === event.type
        ? { ...event, delta: pending.delta + event.delta }
        : event;
    this.pending.set(key, combined);

    if (!event.streaming) {
      this.flush();
      return;
    }
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => this.flush(), STREAM_DELTA_FLUSH_MS);
  }

  flush(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    const events = [...this.pending.values()];
    this.pending.clear();
    for (const event of events) this.emit(event);
  }

  /** Drops text still waiting. Dispose has already detached the listeners. */
  dispose(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending.clear();
  }
}
