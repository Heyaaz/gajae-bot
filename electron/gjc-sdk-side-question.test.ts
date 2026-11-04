import { describe, expect, it, vi } from "vitest";
import { askSideQuestion } from "./gjc-sdk-slash-commands.js";

function host(operations: string[], reply: unknown) {
  return {
    sdkOperations: vi.fn(async () => new Set(operations)),
    controlSession: vi.fn(async () => ({ reply })),
  };
}

describe("askSideQuestion", () => {
  it("asks btw.ask and returns the trimmed reply", async () => {
    const runtime = host(["btw.ask"], "  The tests passed.  ");
    await expect(askSideQuestion(runtime, "s1", "Did the tests pass?")).resolves.toBe("The tests passed.");
    expect(runtime.controlSession).toHaveBeenCalledWith(
      "s1",
      "btw.ask",
      { question: "Did the tests pass?" },
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
  });

  it("waits past GJC's own 120 s /btw limit instead of the CLI's 8 s default", async () => {
    const runtime = host(["btw.ask"], "ok");
    await askSideQuestion(runtime, "s1", "q");
    const options = (runtime.controlSession.mock.calls[0] as unknown[])[3] as { timeoutMs: number };
    expect(options.timeoutMs).toBeGreaterThan(120_000);
  });

  it("refuses when the runtime does not advertise btw.ask", async () => {
    const runtime = host([], "unused");
    await expect(askSideQuestion(runtime, "s1", "q")).rejects.toThrow("btw.ask is not advertised");
    expect(runtime.controlSession).not.toHaveBeenCalled();
  });

  it("fails on an empty reply instead of showing nothing", async () => {
    await expect(askSideQuestion(host(["btw.ask"], " "), "s1", "q")).rejects.toThrow("no /btw answer");
  });
});
