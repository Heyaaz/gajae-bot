import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  gitWorkspaceFiles,
  resolveWorkspaceFile,
  scanWorkspaceFiles,
  WorkspaceFileLister,
} from "./workspace-files.js";

function write(root: string, relative: string): void {
  mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
  writeFileSync(path.join(root, relative), relative);
}

function repository(): string {
  const root = mkdtempSync(path.join(tmpdir(), "gajae-mentions-"));
  execFileSync("git", ["init", "-q", root]);
  writeFileSync(path.join(root, ".gitignore"), "dist/\n*.log\n");
  write(root, "src/app/renderer.ts");
  write(root, "README.md");
  execFileSync("git", ["-C", root, "add", "-A"]);
  write(root, "src/new-file.ts");
  write(root, "dist/bundle.js");
  write(root, "debug.log");
  return root;
}

describe("gitWorkspaceFiles", () => {
  it("lists tracked and untracked files and leaves out what .gitignore excludes", async () => {
    const index = await gitWorkspaceFiles(repository());
    expect(index?.source).toBe("git");
    expect(index?.truncated).toBe(false);
    expect([...index!.files].sort()).toEqual([
      ".gitignore",
      "README.md",
      "src/app/renderer.ts",
      "src/new-file.ts",
    ]);
  });

  it("stops at the cap and says so", async () => {
    const index = await gitWorkspaceFiles(repository(), 2);
    expect(index?.files).toHaveLength(2);
    expect(index?.truncated).toBe(true);
  });

  it("answers null outside a repository so the caller can scan", async () => {
    expect(
      await gitWorkspaceFiles(mkdtempSync(path.join(tmpdir(), "gajae-plain-"))),
    ).toBeNull();
  });
});

describe("scanWorkspaceFiles", () => {
  it("walks a plain directory without descending into node_modules", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "gajae-plain-"));
    write(root, "notes.md");
    write(root, "src/index.ts");
    write(root, "node_modules/pkg/index.js");
    const index = await scanWorkspaceFiles(root);
    expect(index).toEqual({
      files: ["notes.md", "src/index.ts"],
      truncated: false,
      source: "scan",
    });
    expect((await scanWorkspaceFiles(root, 1)).truncated).toBe(true);
  });
});

describe("WorkspaceFileLister", () => {
  it("serves a workspace from one read inside the window and reads again after it", async () => {
    const root = repository();
    let now = 1_000;
    const lister = new WorkspaceFileLister({ ttlMs: 10_000, now: () => now });
    const first = await lister.list(root);
    write(root, "src/later.ts");
    expect(await lister.list(root)).toBe(first);
    now += 10_000;
    expect((await lister.list(root)).files).toContain("src/later.ts");
  });

  it("falls back to the scan for a workspace outside Git", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "gajae-plain-"));
    write(root, "a.txt");
    expect(await new WorkspaceFileLister().list(root)).toEqual({
      files: ["a.txt"],
      truncated: false,
      source: "scan",
    });
  });
});

describe("resolveWorkspaceFile", () => {
  it("resolves a listed path and refuses one that leaves the workspace", async () => {
    const root = repository();
    const outside = mkdtempSync(path.join(tmpdir(), "gajae-outside-"));
    write(outside, "secret.txt");
    symlinkSync(path.join(outside, "secret.txt"), path.join(root, "link.txt"));
    await expect(resolveWorkspaceFile(root, "src/app/renderer.ts")).resolves.toMatch(
      /src\/app\/renderer\.ts$/u,
    );
    await expect(resolveWorkspaceFile(root, "../secret.txt")).rejects.toThrow();
    await expect(resolveWorkspaceFile(root, "link.txt")).rejects.toThrow(
      "inside the session workspace",
    );
    await expect(resolveWorkspaceFile(root, "/etc/hosts")).rejects.toThrow();
    await expect(resolveWorkspaceFile(root, "src")).rejects.toThrow("not a file");
  });
});
