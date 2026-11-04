import { describe, expect, it, vi } from "vitest";
import { createBackendEventHandler } from "./backend-events";
import type { BackendEventContext } from "./backend-events";

function handlerWith(onTurnCompleted: (sessionId: string) => void) {
  const context = new Proxy(
    { setSessions: vi.fn(), onTurnCompleted },
    { get: (target, key) => (target as Record<string | symbol, unknown>)[key] ?? vi.fn() },
  ) as unknown as BackendEventContext;
  return createBackendEventHandler(context);
}

describe("turn completion", () => {
  it("is announced only for activity that reports a normal finish", () => {
    const completed = vi.fn();
    const handle = handlerWith(completed);
    for (const category of ["failed", "permission", "message", "recovered"] as const)
      handle({ type: "session.activity", sessionId: "s1", title: "t", unread: true, category });
    expect(completed).not.toHaveBeenCalled();
    handle({ type: "session.activity", sessionId: "s1", title: "t", unread: true, category: "completed" });
    expect(completed).toHaveBeenCalledWith("s1");
  });
});
