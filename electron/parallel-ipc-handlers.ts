import { ipcMain } from "electron";
import { statSync } from "node:fs";
import path from "node:path";
import {
  PARALLEL_ATTEMPT_MAX,
  PARALLEL_ATTEMPT_MIN,
  PARALLEL_PROMPT_LIMIT,
  parallelCleanupConfirmation,
  safeBranchName,
  safeModelPreset,
} from "../shared/parallel-run.js";
import { PARALLEL_IPC, type ParallelStartInput } from "../shared/parallel-ipc.js";
import { requiredId } from "./gjc-input-validation.js";
import type { IpcSecurity } from "./ipc-security.js";
import type { ParallelRunService } from "./parallel-run-service.js";

export function parallelStartInput(value: unknown): ParallelStartInput {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Parallel run input is required");
  const candidate = value as Record<string, unknown>;
  const title =
    typeof candidate.title === "string" && candidate.title.trim()
      ? candidate.title.trim()
      : undefined;
  if (!title || title.length > 256) throw new Error("Parallel run title is invalid");
  const workspace = candidate.workspace;
  if (typeof workspace !== "string" || !path.isAbsolute(workspace))
    throw new Error("Parallel run workspace must be an absolute directory");
  try {
    if (!statSync(workspace).isDirectory()) throw new Error();
  } catch {
    throw new Error("Parallel run workspace must be an existing directory");
  }
  const prompt =
    typeof candidate.prompt === "string" ? candidate.prompt.trim() : "";
  if (!prompt || prompt.length > PARALLEL_PROMPT_LIMIT)
    throw new Error("Parallel run needs a request to send");
  if (candidate.branch !== undefined && !safeBranchName(candidate.branch))
    throw new Error("Parallel run branch is invalid");
  const presets = candidate.presets;
  if (
    !Array.isArray(presets) ||
    presets.length < PARALLEL_ATTEMPT_MIN ||
    presets.length > PARALLEL_ATTEMPT_MAX ||
    !presets.every(safeModelPreset)
  )
    throw new Error(
      `Parallel run needs ${PARALLEL_ATTEMPT_MIN}-${PARALLEL_ATTEMPT_MAX} model presets`,
    );
  return {
    title,
    workspace: path.resolve(workspace),
    prompt,
    ...(typeof candidate.branch === "string" ? { branch: candidate.branch } : {}),
    presets: presets.map((preset) => preset.trim()),
  };
}

export function registerParallelIpcHandlers(
  service: ParallelRunService,
  security: IpcSecurity,
): () => void {
  const handle = (channel: string, handler: (...args: any[]) => any): void => {
    ipcMain.handle(channel, security.guarded(handler));
  };
  handle(PARALLEL_IPC.list, () => service.list());
  handle(PARALLEL_IPC.start, (_event, input: unknown) =>
    service.start(parallelStartInput(input)),
  );
  handle(PARALLEL_IPC.adopt, (_event, groupId: unknown, attemptId: unknown) =>
    service.adopt(
      requiredId(groupId, "Parallel group ID"),
      requiredId(attemptId, "Attempt ID"),
    ),
  );
  handle(PARALLEL_IPC.discard, (_event, groupId: unknown) =>
    service.discard(requiredId(groupId, "Parallel group ID")),
  );
  handle(PARALLEL_IPC.cleanup, async (event, groupId: unknown) => {
    const id = requiredId(groupId, "Parallel group ID");
    const plan = await service.cleanupPlan(id);
    await security.authorizeDestructive(event, {
      ...parallelCleanupConfirmation(plan),
      confirmLabel: "정리",
      danger: true,
    });
    return service.cleanup(id, plan);
  });
  return () => {
    for (const channel of Object.values(PARALLEL_IPC))
      if (channel !== PARALLEL_IPC.changed) ipcMain.removeHandler(channel);
  };
}
