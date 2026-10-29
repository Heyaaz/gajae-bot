import { ipcMain, shell } from "electron";
import { statSync } from "node:fs";
import path from "node:path";
import { REPO_FAILED_RUNS_LIMIT, REPO_IPC } from "../shared/repo-ipc.js";
import type { RepoService } from "./repo-service.js";
import type { IpcSecurity } from "./ipc-security.js";

/** Longest path the renderer may hand over; macOS itself stops well below this. */
const MAX_PATH = 4096;
/** Workspaces one rail refresh may ask about. */
const MAX_PATHS = 500;

/**
 * A path from the renderer is untrusted input even though this process is the one
 * that listed the workspaces: the same channel set is only as safe as its checks.
 * A control character or a NUL would be passed straight to a child process.
 */
export function repoPath(value: unknown, label: string): string {
  // Scanned character by character rather than matched with a control-character
  // class, so the rule stays readable and no regex can swallow a surrogate half.
  const hasControlCharacter =
    typeof value === "string" &&
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    });
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > MAX_PATH ||
    hasControlCharacter
  )
    throw new Error(`${label} must be a bounded path`);
  return value.trim();
}

export function absoluteRepoPath(value: unknown, label: string): string {
  const candidate = repoPath(value, label);
  if (!path.isAbsolute(candidate))
    throw new Error(`${label} must be an absolute path`);
  return path.resolve(candidate);
}

export function repoPaths(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_PATHS)
    throw new Error("Workspace paths must be a bounded array");
  return value.map((entry) => repoPath(entry, "Workspace"));
}

export function repoNumber(value: unknown, label: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > 1_000_000
  )
    throw new Error(`${label} must be a positive issue number`);
  return value;
}

/** Actions run ids are database ids, far past the issue-number bound above. */
export function repoRunIds(value: unknown): number[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > REPO_FAILED_RUNS_LIMIT ||
    !value.every((entry) => typeof entry === "number" && Number.isSafeInteger(entry) && entry > 0)
  )
    throw new Error(`Run ids must be 1 to ${REPO_FAILED_RUNS_LIMIT} positive integers`);
  return [...new Set(value as number[])];
}

/**
 * The only URLs this channel will open in the OS browser.
 *
 * `shell.openExternal` hands the string to the system handler, so an unchecked
 * value can launch any registered scheme. The repository screen only ever opens a
 * link it read from GitHub, which is https, so nothing else is accepted.
 */
export function externalRepoUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > MAX_PATH)
    throw new Error("Link must be a bounded URL");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Link must be an absolute URL");
  }
  if (url.protocol !== "https:" || !url.hostname)
    throw new Error("Only https links can be opened");
  return url.toString();
}

/** A directory that exists right now, which is what "open this folder" needs. */
export function existingDirectory(value: unknown): string {
  const candidate = absoluteRepoPath(value, "Folder");
  let stats;
  try {
    stats = statSync(candidate);
  } catch {
    throw new Error("Folder does not exist");
  }
  if (!stats.isDirectory()) throw new Error("Folder is not a directory");
  return candidate;
}

export function registerRepoIpcHandlers(
  service: RepoService,
  security: IpcSecurity,
): () => void {
  const handle = (channel: string, handler: (...args: any[]) => any): void => {
    ipcMain.handle(
      channel,
      security.guarded((_event: Electron.IpcMainInvokeEvent, ...args: unknown[]) =>
        handler(...args),
      ),
    );
  };

  handle(REPO_IPC.resolveProjects, (paths: unknown) =>
    service.resolveProjects(repoPaths(paths)),
  );
  handle(REPO_IPC.readRepository, (root: unknown) =>
    service.readRepository(absoluteRepoPath(root, "Project root")),
  );
  handle(REPO_IPC.readGithub, (root: unknown) =>
    service.readGithub(absoluteRepoPath(root, "Project root")),
  );
  handle(REPO_IPC.listIssues, (root: unknown) =>
    service.listIssues(absoluteRepoPath(root, "Project root")),
  );
  handle(REPO_IPC.getIssue, (root: unknown, number: unknown) =>
    service.getIssue(
      absoluteRepoPath(root, "Project root"),
      repoNumber(number, "Issue number"),
    ),
  );
  handle(REPO_IPC.listPulls, (root: unknown) =>
    service.listPulls(absoluteRepoPath(root, "Project root")),
  );
  handle(REPO_IPC.getPull, (root: unknown, number: unknown) =>
    service.getPull(
      absoluteRepoPath(root, "Project root"),
      repoNumber(number, "Pull request number"),
    ),
  );
  handle(REPO_IPC.readFailedLog, (root: unknown, runIds: unknown) =>
    service.readFailedLog(absoluteRepoPath(root, "Project root"), repoRunIds(runIds)),
  );
  handle(REPO_IPC.openExternal, async (url: unknown) => {
    await shell.openExternal(externalRepoUrl(url));
  });
  handle(REPO_IPC.revealFolder, async (folder: unknown) => {
    const target = existingDirectory(folder);
    const failure = await shell.openPath(target);
    if (failure) throw new Error(failure);
  });

  return () => {
    for (const channel of Object.values(REPO_IPC)) ipcMain.removeHandler(channel);
  };
}
