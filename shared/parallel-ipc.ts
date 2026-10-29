import type { ParallelGroup } from "./parallel-run.js";

export interface ParallelStartInput {
  title: string;
  workspace: string;
  prompt: string;
  /** Base branch name; each attempt adds its own suffix. */
  branch?: string;
  /** One model preset per attempt, 2-4 of them. */
  presets: string[];
}

export const PARALLEL_IPC = {
  list: "agent-control:parallel:list",
  start: "agent-control:parallel:start",
  adopt: "agent-control:parallel:adopt",
  discard: "agent-control:parallel:discard",
  /** Removes the undecided attempts' worktrees and branches behind a native confirmation. */
  cleanup: "agent-control:parallel:cleanup",
  changed: "agent-control:parallel:changed",
} as const;

export interface ParallelDesktopBridge {
  list(): Promise<ParallelGroup[]>;
  start(input: ParallelStartInput): Promise<ParallelGroup>;
  adopt(groupId: string, attemptId: string): Promise<ParallelGroup>;
  discard(groupId: string): Promise<ParallelGroup>;
  cleanup(groupId: string): Promise<ParallelGroup>;
  onChanged(listener: (groups: ParallelGroup[]) => void): () => void;
}
