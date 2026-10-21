import { describe, expect, it, vi } from "vitest";
import { createOutputGate } from "./terminal-flow";

describe("terminal output gate", () => {
  it("pauses at the high water mark and resumes at the low water mark", () => {
    const setPaused = vi.fn();
    const gate = createOutputGate({ highWater: 10, lowWater: 4, setPaused });
    gate.push(9);
    expect(setPaused).not.toHaveBeenCalled();
    gate.push(1);
    expect(setPaused).toHaveBeenCalledWith(true);
    gate.ack(5);
    expect(setPaused).toHaveBeenCalledTimes(1);
    gate.ack(2);
    expect(setPaused).toHaveBeenLastCalledWith(false);
    gate.reset();
    expect(setPaused).toHaveBeenCalledTimes(2);
  });

  it("resumes on reset while paused", () => {
    const setPaused = vi.fn();
    const gate = createOutputGate({ highWater: 2, lowWater: 0, setPaused });
    gate.push(4);
    gate.reset();
    expect(setPaused.mock.calls).toEqual([[true], [false]]);
  });
});
