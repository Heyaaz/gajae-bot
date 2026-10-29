import { spawn } from "node:child_process";
import { readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { WorkspaceFileIndex } from "../shared/agent-contract.js";

export const WORKSPACE_FILE_LIMIT = 100_000;
const CACHE_TTL_MS = 10_000;
const SCAN_SKIPPED_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
]);
const SCAN_MAX_DEPTH = 12;

/**
 * Workspace-relative files, read through `git ls-files` so `.gitignore` decides
 * what is offered. `null` means the directory is not a Git work tree (or Git is
 * unavailable), which is the caller's cue to scan instead.
 */
export function gitWorkspaceFiles(
  workspace: string,
  limit = WORKSPACE_FILE_LIMIT,
): Promise<WorkspaceFileIndex | null> {
  return new Promise((resolve) => {
    const child = spawn(
      "git",
      ["-C", workspace, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    const files = new Set<string>();
    let pending = "";
    let truncated = false;
    let settled = false;
    const finish = (value: WorkspaceFileIndex | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (truncated) return;
      const parts = (pending + chunk).split("\0");
      pending = parts.pop() ?? "";
      for (const part of parts) {
        // An unmerged path is listed once per conflict stage.
        if (part) files.add(part);
        if (files.size > limit) {
          truncated = true;
          // Reading past the cap only costs memory; stop git rather than drain it.
          child.kill();
          break;
        }
      }
    });
    child.on("error", () => finish(null));
    child.on("close", (code) => {
      if (truncated)
        return finish({
          files: [...files].slice(0, limit),
          truncated: true,
          source: "git",
        });
      if (code !== 0) return finish(null);
      finish({ files: [...files], truncated: false, source: "git" });
    });
  });
}

/** A bounded breadth-first walk for a workspace Git does not track. */
export async function scanWorkspaceFiles(
  workspace: string,
  limit = WORKSPACE_FILE_LIMIT,
): Promise<WorkspaceFileIndex> {
  const files: string[] = [];
  let level = [""];
  for (let depth = 0; level.length > 0 && depth <= SCAN_MAX_DEPTH; depth += 1) {
    const next: string[] = [];
    for (const relative of level) {
      let entries;
      try {
        entries = await readdir(path.join(workspace, relative), {
          withFileTypes: true,
        });
      } catch {
        continue;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        const child = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (!SCAN_SKIPPED_DIRECTORIES.has(entry.name)) next.push(child);
        } else if (entry.isFile()) {
          if (files.length === limit)
            return { files, truncated: true, source: "scan" };
          files.push(child);
        }
      }
    }
    level = next;
  }
  return { files, truncated: false, source: "scan" };
}

/**
 * One listing per workspace, shared by every request inside the cache window.
 *
 * The window is the invalidation: files the agent writes show up on the first
 * `@` after it, and a burst of popup openings costs one `git ls-files`.
 * Concurrent callers share the read in flight instead of each spawning git.
 */
export class WorkspaceFileLister {
  private readonly entries = new Map<
    string,
    { readAt: number; read: Promise<WorkspaceFileIndex> }
  >();

  constructor(
    private readonly options: {
      ttlMs?: number;
      limit?: number;
      now?: () => number;
    } = {},
  ) {}

  list(workspace: string): Promise<WorkspaceFileIndex> {
    const now = (this.options.now ?? Date.now)();
    const key = path.resolve(workspace);
    const cached = this.entries.get(key);
    if (cached && now - cached.readAt < (this.options.ttlMs ?? CACHE_TTL_MS))
      return cached.read;
    const limit = this.options.limit ?? WORKSPACE_FILE_LIMIT;
    const read = (async () =>
      (await gitWorkspaceFiles(key, limit)) ??
      scanWorkspaceFiles(key, limit))();
    this.entries.set(key, { readAt: now, read });
    // A failed read must not be served from the cache for the rest of the window.
    read.catch(() => {
      if (this.entries.get(key)?.read === read) this.entries.delete(key);
    });
    return read;
  }

  invalidate(workspace?: string): void {
    if (workspace === undefined) this.entries.clear();
    else this.entries.delete(path.resolve(workspace));
  }
}

/**
 * The real file a workspace-relative mention names.
 *
 * The path comes from the renderer, so it is resolved through symlinks and must
 * still land inside the workspace: `../` or a link pointing out of the tree is
 * refused rather than turned into an attachment of an arbitrary file.
 */
export async function resolveWorkspaceFile(
  workspaceDirectory: string,
  relativePath: string,
): Promise<string> {
  if (
    !relativePath ||
    path.isAbsolute(relativePath) ||
    /[\0\r\n]/u.test(relativePath)
  )
    throw new Error("Mentioned file must be a workspace-relative path");
  const workspace = await realpath(workspaceDirectory);
  const resolved = await realpath(path.join(workspace, relativePath));
  if (!resolved.startsWith(`${workspace}${path.sep}`))
    throw new Error("Mentioned file must be inside the session workspace");
  if (!(await stat(resolved)).isFile())
    throw new Error("Mentioned path is not a file");
  return resolved;
}
