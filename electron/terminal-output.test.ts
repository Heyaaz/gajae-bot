import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReplayBuffer, createOutputBatcher } from "./terminal-output.js";

describe("ReplayBuffer", () => {
  it("returns everything while it fits", () => {
    const buffer = new ReplayBuffer(16);
    buffer.push("hello ");
    buffer.push("world");
    expect(buffer.read()).toBe("hello world");
  });

  it("keeps only the tail, starting at a whole line", () => {
    const buffer = new ReplayBuffer(10);
    buffer.push("\x1b[32mdropped\x1b[0m\r\n");
    buffer.push("abc\r\n");
    buffer.push("kept\r\n");
    expect(buffer.read()).toBe("kept\r\n");
  });

  it("keeps a cut tail that has no line break to start from", () => {
    const buffer = new ReplayBuffer(4);
    buffer.push("abcdefgh");
    expect(buffer.read()).toBe("efgh");
  });

  it("stays within its limit however much arrives", () => {
    const buffer = new ReplayBuffer(1024);
    for (let index = 0; index < 10_000; index += 1) buffer.push(`line ${index}\r\n`);
    const text = buffer.read();
    expect(text.length).toBeLessThanOrEqual(1024);
    expect(text.endsWith("line 9999\r\n")).toBe(true);
    expect(text.startsWith("line ")).toBe(true);
  });
});

describe("createOutputBatcher", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("sends the first chunk at once, so an echo does not wait", () => {
    const send = vi.fn();
    createOutputBatcher(send, 5).push("a");
    expect(send.mock.calls).toEqual([["a"]]);
  });

  it("coalesces a burst into one send per window", () => {
    const send = vi.fn();
    const batcher = createOutputBatcher(send, 5);
    for (const chunk of ["a", "b", "c"]) batcher.push(chunk);
    expect(send.mock.calls).toEqual([["a"]]);
    vi.advanceTimersByTime(5);
    expect(send.mock.calls).toEqual([["a"], ["bc"]]);

    // Still inside the burst: the window reopened after that send.
    batcher.push("d");
    expect(send).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(5);
    expect(send).toHaveBeenLastCalledWith("d");
  });

  it("goes back to sending at once after a quiet window", () => {
    const send = vi.fn();
    const batcher = createOutputBatcher(send, 5);
    batcher.push("a");
    vi.advanceTimersByTime(5);
    batcher.push("b");
    expect(send.mock.calls).toEqual([["a"], ["b"]]);
  });

  it("flushes what is waiting on request and drops it on discard", () => {
    const send = vi.fn();
    const batcher = createOutputBatcher(send, 5);
    batcher.push("a");
    batcher.push("b");
    batcher.flush();
    expect(send).toHaveBeenLastCalledWith("b");

    batcher.push("c");
    batcher.push("d");
    batcher.discard();
    vi.advanceTimersByTime(50);
    expect(send).toHaveBeenCalledTimes(3);
    expect(send).toHaveBeenLastCalledWith("c");
  });
});
