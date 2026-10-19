import { describe, expect, it } from "vitest";
import { eventSessionId, type AgentEvent } from "../../shared/agent-contract";

const event = (value: unknown): AgentEvent => value as AgentEvent;

describe("eventSessionId", () => {
  it("reads ids nested in transcript, plan, tool, and message events", () => {
    expect(
      eventSessionId(
        event({ type: "tool.updated", tool: { sessionId: "tool-session" } }),
      ),
    ).toBe("tool-session");
    expect(
      eventSessionId(
        event({ type: "plan.updated", plan: { sessionId: "plan-session" } }),
      ),
    ).toBe("plan-session");
    expect(
      eventSessionId(
        event({
          type: "transcript.appended",
          item: { sessionId: "appended-session" },
        }),
      ),
    ).toBe("appended-session");
    expect(
      eventSessionId(
        event({
          type: "message.updated",
          message: { sessionId: "message-session" },
        }),
      ),
    ).toBe("message-session");
  });

  it("keeps envelope ids and ignores connection events", () => {
    expect(
      eventSessionId(
        event({ type: "session.created", session: { id: "created-session" } }),
      ),
    ).toBe("created-session");
    expect(
      eventSessionId(
        event({
          type: "transcript.synced",
          sessionId: "synced-session",
          items: [],
        }),
      ),
    ).toBe("synced-session");
    expect(
      eventSessionId(
        event({ type: "connection.updated", connection: { state: "connected" } }),
      ),
    ).toBeUndefined();
  });
});
