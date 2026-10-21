import type { AgentSession, GoalSnapshot } from "../../shared/agent-contract.js";

/** Goal state advances at tool-call pace, not at streaming pace. */
export const GOAL_POLL_RUNNING_MS = 4_000;
export const GOAL_POLL_IDLE_MS = 10_000;
/** No goal is active; this poll only discovers one started from a terminal. */
export const GOAL_POLL_DISABLED_MS = 30_000;

export function goalPollDelay(
  goal: GoalSnapshot,
  status: AgentSession["status"] | undefined,
): number {
  if (!goal.enabled) return GOAL_POLL_DISABLED_MS;
  return status === "running" ? GOAL_POLL_RUNNING_MS : GOAL_POLL_IDLE_MS;
}
