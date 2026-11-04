import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getDiff, type FilesHost } from "./gjc-sdk-files.js";

const roots: string[] = [];

function folder(): string {
  const root = mkdtempSync(path.join(tmpdir(), "gajae-diff-test-"));
  roots.push(root);
  return root;
}

function repository(dir: string, changed?: string): void {
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(path.join(dir, "src", "a.txt"), "one\n");
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...args]);
  git("init", "-q");
  git("add", ".");
  git("commit", "-qm", "init");
  if (changed) writeFileSync(path.join(dir, "src", "a.txt"), changed);
}

function host(workspace: string, query: FilesHost["querySessionItems"] = vi.fn(async () => [])) {
  return {
    workspace,
    sessionCwds: new Map([["s1", workspace]]),
    ensureAttached: vi.fn(async () => undefined),
    querySessionItems: query,
  } as unknown as FilesHost;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("getDiff", () => {
  it("collects the changes of the repositories inside a workspace that is not one", async () => {
    const workspace = folder();
    repository(path.join(workspace, "admin"), "one\ntwo\n");
    repository(path.join(workspace, "app"));
    mkdirSync(path.join(workspace, "notes"));
    const runtime = host(workspace);
    const diff = await getDiff(runtime, "s1");
    expect(diff.error).toBeUndefined();
    expect(diff.files.map((file) => file.path)).toEqual(["admin/src/a.txt"]);
    expect(diff.files[0]!.patch).toContain("+++ b/admin/src/a.txt");
    expect(diff.files[0]!.patch).toContain("+two");
    expect(runtime.querySessionItems).not.toHaveBeenCalled();
  });

  it("says why there is nothing to show in a folder with no repository at all", async () => {
    const diff = await getDiff(host(folder()), "s1");
    expect(diff.files).toEqual([]);
    expect(diff.error).toContain("Git 저장소가 아니어서");
  });

  it("shows GJC's failure in a repository instead of reporting no changes", async () => {
    const workspace = folder();
    repository(workspace, "one\ntwo\n");
    const diff = await getDiff(host(workspace, vi.fn(async () => { throw new Error("The operation failed."); })), "s1");
    expect(diff.files).toEqual([]);
    expect(diff.error).toBe("The operation failed.");
  });

  it("reads a repository's changes from GJC", async () => {
    const workspace = folder();
    repository(workspace);
    const query = vi.fn(async () => [{ id: "src/a.txt", path: "src/a.txt", body: "diff --git a/src/a.txt b/src/a.txt\n" }]);
    const diff = await getDiff(host(workspace, query), "s1");
    expect(diff.files).toEqual([{ id: "src/a.txt", path: "src/a.txt", patch: "diff --git a/src/a.txt b/src/a.txt\n" }]);
    expect(query).toHaveBeenCalledWith("s1", "diff.list_files", {}, { strict: true });
  });
});
