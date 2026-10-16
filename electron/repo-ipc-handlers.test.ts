import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  absoluteRepoPath,
  existingDirectory,
  externalRepoUrl,
  registerRepoIpcHandlers,
  repoNumber,
  repoPath,
  repoPaths,
} from "./repo-ipc-handlers.js";

const handled = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      handled.set(channel, handler);
    },
    removeHandler: (channel: string) => {
      handled.delete(channel);
    },
  },
  shell: {
    openPath: vi.fn(async () => ""),
    openExternal: vi.fn(async () => undefined),
  },
}));

const created: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "gajae-repo-ipc-"));
  created.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of created.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("repository IPC validation", () => {
  it("refuses a path that would escape into a child process", () => {
    expect(() => repoPath("/tmp/project\0", "Project root")).toThrow(
      "bounded path",
    );
    expect(() => repoPath("/tmp/project\u001b[31m", "Project root")).toThrow(
      "bounded path",
    );
    expect(() => repoPath("", "Project root")).toThrow("bounded path");
    expect(() => repoPath("x".repeat(4097), "Project root")).toThrow(
      "bounded path",
    );
  });

  it("requires an absolute project root", () => {
    expect(absoluteRepoPath("/tmp/project", "Project root")).toBe(
      "/tmp/project",
    );
    // A relative root would be resolved against the main process's cwd, so the
    // repository screen would read a directory the renderer never named.
    expect(() => absoluteRepoPath("relative/project", "Project root")).toThrow(
      "absolute path",
    );
    expect(() => absoluteRepoPath("project", "Project root")).toThrow(
      "absolute path",
    );
  });

  it("bounds the workspace list a rail refresh may ask about", () => {
    expect(repoPaths(["/tmp/a", "/tmp/b"])).toEqual(["/tmp/a", "/tmp/b"]);
    expect(() => repoPaths("not-an-array")).toThrow("bounded array");
    expect(() => repoPaths(Array.from({ length: 501 }, () => "/tmp/a"))).toThrow(
      "bounded array",
    );
  });

  it("accepts only a positive, bounded item number", () => {
    expect(repoNumber(7, "Issue number")).toBe(7);
    expect(() => repoNumber(0, "Issue number")).toThrow("positive issue number");
    expect(() => repoNumber(-1, "Issue number")).toThrow(
      "positive issue number",
    );
    expect(() => repoNumber(1.5, "Issue number")).toThrow(
      "positive issue number",
    );
    expect(() => repoNumber("7", "Issue number")).toThrow(
      "positive issue number",
    );
  });

  it("opens https links only", () => {
    expect(externalRepoUrl("https://github.com/Heyaaz/gajae-bot")).toBe(
      "https://github.com/Heyaaz/gajae-bot",
    );
    expect(() => externalRepoUrl("http://github.com/Heyaaz/gajae-bot")).toThrow(
      "https",
    );
    // A shell handler would launch any registered scheme, which is why file: and
    // the app's own custom schemes never reach it.
    expect(() => externalRepoUrl("file:///etc/passwd")).toThrow("https");
    expect(() => externalRepoUrl("javascript:alert(1)")).toThrow("https");
    expect(() => externalRepoUrl("not a url")).toThrow("absolute URL");
  });

  it("reveals only a directory that exists", () => {
    const directory = temporaryDirectory();
    expect(existingDirectory(directory)).toBe(directory);
    expect(() => existingDirectory(path.join(directory, "missing"))).toThrow(
      "does not exist",
    );
    expect(() =>
      existingDirectory(path.join(directory, "note.txt")),
    ).toThrow("does not exist");
  });
});

describe("repository IPC surface", () => {
  it("registers every channel on one path argument and removes them together", async () => {
    const calls: string[] = [];
    const service = {
      resolveProjects: async (paths: readonly string[]) => {
        calls.push(`resolve:${paths.join(",")}`);
        return [];
      },
      readRepository: async (root: string) => {
        calls.push(`repository:${root}`);
        return { root };
      },
      readGithub: async (root: string) => {
        calls.push(`github:${root}`);
        return { state: "no-remote" as const };
      },
      listIssues: async (root: string) => {
        calls.push(`issues:${root}`);
        return { state: "no-remote" as const };
      },
      getIssue: async (root: string, number: number) => {
        calls.push(`issue:${root}:${number}`);
        return { state: "no-remote" as const };
      },
      listPulls: async (root: string) => {
        calls.push(`pulls:${root}`);
        return { state: "no-remote" as const };
      },
      getPull: async (root: string, number: number) => {
        calls.push(`pull:${root}:${number}`);
        return { state: "no-remote" as const };
      },
    };
    const security = {
      guarded: (handler: (...args: unknown[]) => unknown) => handler,
    };
    const dispose = registerRepoIpcHandlers(
      service as unknown as Parameters<typeof registerRepoIpcHandlers>[0],
      security as unknown as Parameters<typeof registerRepoIpcHandlers>[1],
    );

    expect(handled.size).toBe(9);
    // The guarded wrapper is called with the IPC event first, which the handler
    // itself never sees.
    await handled.get("agent-control:repo:resolve-projects")!(null, ["/tmp/a"]);
    await handled.get("agent-control:repo:read-repository")!(null, "/tmp/a");
    await handled.get("agent-control:repo:read-github")!(null, "/tmp/a");
    await handled.get("agent-control:repo:list-issues")!(null, "/tmp/a");
    await handled.get("agent-control:repo:get-issue")!(null, "/tmp/a", 3);
    await handled.get("agent-control:repo:list-pulls")!(null, "/tmp/a");
    await handled.get("agent-control:repo:get-pull")!(null, "/tmp/a", 4);
    expect(calls).toEqual([
      "resolve:/tmp/a",
      "repository:/tmp/a",
      "github:/tmp/a",
      "issues:/tmp/a",
      "issue:/tmp/a:3",
      "pulls:/tmp/a",
      "pull:/tmp/a:4",
    ]);

    dispose();
    expect(handled.size).toBe(0);
  });
});
