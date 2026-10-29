import path from "node:path";
import type { AgentSession, GitStatusSnapshot } from "../shared/agent-contract.js";
import { execFile, gitBranchFromHeader, safeGitPath } from "./gjc-sdk-foundation.js";

/** The controller state a Git panel call reads to find a session's repository. */
export interface GitScope {
  readonly workspace: string;
  readonly sessions: ReadonlyMap<string, AgentSession>;
  readonly sessionCwds: ReadonlyMap<string, string>;
}

export async function remotesWithBranch(root: string, branch: string): Promise<number> {
  const [remotes, refs] = await Promise.all([
    execFile("git", ["-C", root, "remote"]),
    execFile("git", ["-C", root, "for-each-ref", "--format=%(refname)", "refs/remotes/"]),
  ]);
  const present = new Set(refs.stdout.split("\n").map((line) => line.trim()));
  return remotes.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((remote) => remote && present.has(`refs/remotes/${remote}/${branch}`)).length;
}

export async function getGitStatus(
  scope: GitScope,
  sessionId: string,
): Promise<GitStatusSnapshot> {
  const workspace = scope.sessionCwds.get(sessionId) ?? scope.workspace;
  // A session can live in a directory that is not a repository at all. `git status`
  // exits non-zero there, and that rejection reached the IPC handler as an
  // unhandled error every time the panel polled. No repository is a state, not a
  // failure, so it is reported as one.
  let result: { stdout: string };
  try {
    result = await execFile(
      "git",
      ["-C", workspace, "status", "--porcelain=v1", "-z", "--branch"],
      { maxBuffer: 2 * 1024 * 1024 },
    );
  } catch {
    return { workspace, branch: "", ahead: 0, behind: 0, files: [] };
  }
  let branch = "";
  let upstream: string | undefined;
  let ahead = 0;
  let behind = 0;
  const files: GitStatusSnapshot["files"] = [];
  const entries = result.stdout.split("\0").filter(Boolean);
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    if (entry.startsWith("## ")) {
      const header = entry.slice(3);
      const match =
        /^(.*?)\.\.\.([^ ]+)(?: \[ahead (\d+)(?:, behind (\d+))?\]| \[behind (\d+)\])?$/u.exec(
          header,
        );
      if (match) {
        branch = match[1] ?? "";
        upstream = match[2];
        ahead = Number(match[3] ?? 0);
        behind = Number(match[4] ?? match[5] ?? 0);
      } else branch = gitBranchFromHeader(header);
      continue;
    }
    if (entry.length < 4) continue;
    const indexStatus = entry[0] ?? ".";
    const workingTree = entry[1] ?? ".";
    const filePath = entry.slice(3);
    if (safeGitPath(filePath))
      files.push({ path: filePath, index: indexStatus, workingTree });
    if (indexStatus === "R" || indexStatus === "C") index += 1;
  }
  return {
    workspace,
    branch,
    ...(upstream ? { upstream } : {}),
    ahead,
    behind,
    files,
  };
}

async function mutateGit(
  scope: GitScope,
  sessionId: string,
  args: string[],
): Promise<GitStatusSnapshot> {
  const session = scope.sessions.get(sessionId);
  const worktree = session?.worktree;
  if (
    !session ||
    !worktree?.managed ||
    path.resolve(session.workspace) !== path.resolve(worktree.path)
  )
    throw new Error("Git mutation requires a managed Gajae worktree");
  const root = (
    await execFile("git", [
      "-C",
      worktree.path,
      "rev-parse",
      "--show-toplevel",
    ])
  ).stdout.trim();
  if (path.resolve(root) !== path.resolve(worktree.path))
    throw new Error("Managed worktree path verification failed");
  await execFile("git", ["-C", worktree.path, ...args]);
  return getGitStatus(scope, sessionId);
}
export async function stageFiles(
  scope: GitScope,
  sessionId: string,
  paths: string[],
): Promise<GitStatusSnapshot> {
  const status = await getGitStatus(scope, sessionId);
  const allowed = new Set(status.files.map((file) => file.path));
  if (
    paths.some((filePath) => !allowed.has(filePath) || !safeGitPath(filePath))
  )
    throw new Error(
      "Path is not an eligible repository-relative changed file",
    );
  return mutateGit(scope, sessionId, ["add", "--", ...paths]);
}
export async function unstageFiles(
  scope: GitScope,
  sessionId: string,
  paths: string[],
): Promise<GitStatusSnapshot> {
  const status = await getGitStatus(scope, sessionId);
  const allowed = new Set(status.files.map((file) => file.path));
  if (
    paths.some((filePath) => !allowed.has(filePath) || !safeGitPath(filePath))
  )
    throw new Error(
      "Path is not an eligible repository-relative changed file",
    );
  return mutateGit(scope, sessionId, ["restore", "--staged", "--", ...paths]);
}
export async function commitChanges(
  scope: GitScope,
  sessionId: string,
  message: string,
): Promise<GitStatusSnapshot> {
  const text = message.trim();
  if (!text || text.length > 512)
    throw new Error("Commit message is required and bounded");
  return mutateGit(scope, sessionId, ["commit", "-m", text]);
}
export async function pushChanges(
  scope: GitScope,
  sessionId: string,
): Promise<GitStatusSnapshot> {
  return mutateGit(scope, sessionId, ["push"]);
}
