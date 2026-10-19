import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "../shared/agent-contract.js";
import { applySearchInvalidation } from "./search-invalidation.js";

const event = (value: unknown): AgentEvent => value as AgentEvent;

const CONTENT_EVENTS: Array<{ type: AgentEvent["type"]; withId: unknown; withoutId: unknown }> = [
  {
    type: "session.created",
    withId: { type: "session.created", session: { id: "s1" } },
    withoutId: { type: "session.created", session: {} },
  },
  {
    type: "session.updated",
    withId: { type: "session.updated", session: { id: "s1" } },
    withoutId: { type: "session.updated", session: {} },
  },
  {
    type: "session.deleted",
    withId: { type: "session.deleted", sessionId: "s1" },
    withoutId: { type: "session.deleted" },
  },
  {
    type: "transcript.appended",
    withId: { type: "transcript.appended", item: { sessionId: "s1" } },
    withoutId: { type: "transcript.appended", item: {} },
  },
  {
    type: "transcript.synced",
    withId: { type: "transcript.synced", sessionId: "s1", items: [] },
    withoutId: { type: "transcript.synced", items: [] },
  },
  {
    type: "message.delta",
    withId: { type: "message.delta", sessionId: "s1", messageId: "m", delta: "a", streaming: true },
    withoutId: { type: "message.delta", messageId: "m", delta: "a", streaming: true },
  },
  {
    type: "message.updated",
    withId: { type: "message.updated", message: { sessionId: "s1" } },
    withoutId: { type: "message.updated", message: {} },
  },
  {
    type: "thought.delta",
    withId: { type: "thought.delta", sessionId: "s1", thoughtId: "t", delta: "a", streaming: false },
    withoutId: { type: "thought.delta", thoughtId: "t", delta: "a", streaming: false },
  },
  {
    type: "plan.updated",
    withId: { type: "plan.updated", plan: { sessionId: "s1" } },
    withoutId: { type: "plan.updated", plan: {} },
  },
  {
    type: "tool.updated",
    withId: { type: "tool.updated", tool: { sessionId: "s1" } },
    withoutId: { type: "tool.updated", tool: {} },
  },
];

describe("applySearchInvalidation", () => {
  it("replaces one session when a content event names it", () => {
    for (const sample of CONTENT_EVENTS) {
      const invalidate = vi.fn();
      applySearchInvalidation(event(sample.withId), invalidate);
      expect(invalidate, sample.type).toHaveBeenCalledExactlyOnceWith("s1");
    }
  });

  it("rebuilds the whole index when a content event has no session id", () => {
    for (const sample of CONTENT_EVENTS) {
      const invalidate = vi.fn();
      applySearchInvalidation(event(sample.withoutId), invalidate);
      expect(invalidate, sample.type).toHaveBeenCalledExactlyOnceWith();
    }
  });

  it("ignores events that do not change searchable text", () => {
    const invalidate = vi.fn();
    for (const ignored of [
      { type: "connection.updated", connection: { state: "connected" } },
      { type: "session.activity", sessionId: "s1", title: "Done", unread: true, category: "completed" },
      { type: "session.commands", sessionId: "s1", commands: [] },
      { type: "session.config", sessionId: "s1", options: [] },
      { type: "runtime.updated", sessionId: "s1", runtimeState: {} },
    ])
      applySearchInvalidation(event(ignored), invalidate);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("is what broadcastAgentEvent uses to invalidate search", () => {
    const source = readFileSync(path.join(import.meta.dirname, "main.ts"), "utf8");
    expect(source).toContain("applySearchInvalidation(event,");
    expect(source).toContain("productivityService?.invalidateSearch(sessionId)");
    expect(source).not.toContain("skipping targeted invalidation");
  });
});
