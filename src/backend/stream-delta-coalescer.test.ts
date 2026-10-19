import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "./types";
import { STREAM_DELTA_FLUSH_MS, StreamDeltaCoalescer } from "./stream-delta-coalescer";

function delta(
  text: string,
  streaming = true,
  messageId = "m",
): Extract<AgentEvent, { type: "message.delta" }> {
  return {
    type: "message.delta",
    sessionId: "s",
    messageId,
    delta: text,
    streaming,
  };
}

describe("StreamDeltaCoalescer", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("publishes one joined delta per frame", () => {
    vi.useFakeTimers();
    const emitted: AgentEvent[] = [];
    const coalescer = new StreamDeltaCoalescer((event) => emitted.push(event));

    coalescer.receive(delta("one "));
    coalescer.receive(delta("two"));

    expect(emitted).toEqual([]);
    vi.advanceTimersByTime(STREAM_DELTA_FLUSH_MS - 1);
    expect(emitted).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(emitted).toEqual([delta("one two")]);

    coalescer.dispose();
  });

  it("flushes the joined text before a non-delta, and immediately when the stream ends", () => {
    vi.useFakeTimers();
    const emitted: AgentEvent[] = [];
    const coalescer = new StreamDeltaCoalescer((event) => emitted.push(event));
    const synced: AgentEvent = {
      type: "transcript.synced",
      sessionId: "s",
      items: [],
    };

    coalescer.receive(delta("kept "));
    coalescer.receive(synced);
    coalescer.receive(delta("tail", false));

    expect(emitted).toEqual([delta("kept "), synced, delta("tail", false)]);
    expect(vi.getTimerCount()).toBe(0);
    coalescer.dispose();
  });

  it("drops buffered text on dispose without publishing it", () => {
    vi.useFakeTimers();
    const emitted: AgentEvent[] = [];
    const coalescer = new StreamDeltaCoalescer((event) => emitted.push(event));
    coalescer.receive(delta("gone"));
    coalescer.dispose();
    vi.advanceTimersByTime(STREAM_DELTA_FLUSH_MS);
    expect(emitted).toEqual([]);
  });
});
