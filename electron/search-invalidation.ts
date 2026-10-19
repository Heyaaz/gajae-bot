import { eventSessionId, type AgentEvent } from "../shared/agent-contract.js";

/**
 * Events whose payload is part of what transcript search indexes.
 *
 * A connection, command palette, or activity ping does not change searchable
 * text, so those stay out of this set.
 */
const SEARCH_CONTENT_EVENTS = new Set<AgentEvent["type"]>([
  "session.created",
  "session.updated",
  "session.deleted",
  "transcript.appended",
  "transcript.synced",
  "message.delta",
  "message.updated",
  "thought.delta",
  "plan.updated",
  "tool.updated",
]);

/**
 * Drops the search index for one event.
 *
 * A content event names the session whose rows to replace. The same event with
 * no session id is global — a targeted skip would keep serving the previous
 * index — so the whole index is marked stale instead.
 */
export function applySearchInvalidation(
  event: AgentEvent,
  invalidate: (sessionId?: string) => void,
): void {
  if (!SEARCH_CONTENT_EVENTS.has(event.type)) return;
  const sessionId = eventSessionId(event);
  if (sessionId) invalidate(sessionId);
  else invalidate();
}
