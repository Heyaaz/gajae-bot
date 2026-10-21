import { describe, expect, it } from "vitest";
import {
  GOAL_POLL_DISABLED_MS,
  GOAL_POLL_IDLE_MS,
  GOAL_POLL_RUNNING_MS,
  goalPollDelay,
} from "./goal-poll.js";

const goal = (enabled: boolean) => ({ enabled, completed: 0, total: 0 });

describe("goalPollDelay", () => {
  it("backs off when no goal is active", () => {
    expect(goalPollDelay(goal(false), "running")).toBe(GOAL_POLL_DISABLED_MS);
    expect(goalPollDelay(goal(false), "idle")).toBe(GOAL_POLL_DISABLED_MS);
  });

  it("uses the running cadence only while a goal is active in a running turn", () => {
    expect(goalPollDelay(goal(true), "running")).toBe(GOAL_POLL_RUNNING_MS);
    expect(goalPollDelay(goal(true), "idle")).toBe(GOAL_POLL_IDLE_MS);
  });
});
