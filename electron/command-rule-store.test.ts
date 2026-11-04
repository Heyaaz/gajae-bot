import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CommandRuleStore } from "./command-rule-store";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "gajae-command-rules-"));
});

afterEach(async () => {
  await chmod(directory, 0o700);
  await rm(directory, { recursive: true, force: true });
});

const identity = async (projectPath: string) => projectPath;
const file = () => path.join(directory, "command-rules.json");

describe("CommandRuleStore", () => {
  it("decides by the rules saved for the project", async () => {
    const store = new CommandRuleStore(directory, identity);
    await store.add("/repo", "git status", "allow");
    await store.add("/repo", "git push", "reject");
    expect(await store.decide("/repo", "bash", "git status -s")).toEqual({ decision: "allow", prefix: "git status" });
    expect(await store.decide("/repo", "bash", "git push")).toEqual({ decision: "reject", prefix: "git push" });
    expect(await store.decide("/repo", "bash", "git log")).toBeUndefined();
    expect(await store.decide("/repo", "write", "git status")).toBeUndefined();
  });

  it("keeps rules across a reload", async () => {
    await new CommandRuleStore(directory, identity).add("/repo", "  npm   test ", "allow");
    const reloaded = new CommandRuleStore(directory, identity);
    expect(await reloaded.decide("/repo", "bash", "npm test --silent")).toEqual({ decision: "allow", prefix: "npm test" });
    expect(reloaded.list()).toEqual([
      { root: "/repo", rules: [{ tool: "bash", prefix: "npm test", decision: "allow", createdAt: expect.any(String) }] },
    ]);
  });

  it("replaces the rule for the same prefix", async () => {
    const store = new CommandRuleStore(directory, identity);
    await store.add("/repo", "git push", "allow");
    await store.add("/repo", "git  push", "reject");
    expect(store.list()[0]!.rules.map(({ prefix, decision }) => ({ prefix, decision }))).toEqual([
      { prefix: "git push", decision: "reject" },
    ]);
    expect(await store.decide("/repo", "bash", "git push")).toMatchObject({ decision: "reject" });
  });

  it("removes a rule and drops a project left with none", async () => {
    const store = new CommandRuleStore(directory, identity);
    await store.add("/repo", "git status", "allow");
    await store.add("/repo", "git push", "reject");
    store.remove("/repo", "git status");
    expect(await store.decide("/repo", "bash", "git status")).toBeUndefined();
    expect(store.list()[0]!.rules).toHaveLength(1);
    store.remove("/repo", "git push");
    expect(store.list()).toEqual([]);
    expect(JSON.parse(await readFile(file(), "utf8"))).toEqual({ projects: {} });
    expect(new CommandRuleStore(directory, identity).list()).toEqual([]);
  });

  it("ignores removing a rule that is not there", async () => {
    const store = new CommandRuleStore(directory, identity);
    store.remove("/repo", "git status");
    await expect(readFile(file(), "utf8")).rejects.toThrow();
  });

  it("scopes rules to the project root the path resolves to", async () => {
    const store = new CommandRuleStore(directory, async (projectPath) =>
      projectPath.startsWith("/repo") ? "/repo" : projectPath,
    );
    await store.add("/repo/.claude/worktrees/a", "git status", "allow");
    expect(await store.decide("/repo", "bash", "git status")).toMatchObject({ decision: "allow" });
    expect(await store.decide("/repo/.claude/worktrees/b", "bash", "git status")).toMatchObject({ decision: "allow" });
    expect(await store.decide("/other", "bash", "git status")).toBeUndefined();
    expect(store.list().map(({ root }) => root)).toEqual(["/repo"]);
  });

  it("refuses a prefix that could chain commands", async () => {
    const store = new CommandRuleStore(directory, identity);
    await expect(store.add("/repo", "git status && rm", "allow")).rejects.toThrow(/invalid/);
    await expect(store.add("/repo", "  ", "allow")).rejects.toThrow(/invalid/);
    expect(store.list()).toEqual([]);
  });

  it("keeps the old rules when the write fails", async () => {
    const store = new CommandRuleStore(directory, identity);
    await store.add("/repo", "git status", "allow");
    await chmod(directory, 0o500);
    await expect(store.add("/repo", "git push", "reject")).rejects.toThrow();
    expect(store.list()[0]!.rules.map((rule) => rule.prefix)).toEqual(["git status"]);
  });

  it("drops malformed entries and keeps the rest", async () => {
    await writeFile(
      file(),
      JSON.stringify({
        projects: {
          "/repo": [
            { tool: "bash", prefix: "git status", decision: "allow", createdAt: "2026-11-04T00:00:00.000Z" },
            { tool: "bash", prefix: "git status; rm", decision: "allow", createdAt: "2026-11-04T00:00:00.000Z" },
            { tool: "write", prefix: "x", decision: "allow", createdAt: "2026-11-04T00:00:00.000Z" },
            { tool: "bash", prefix: "ls", decision: "maybe", createdAt: "2026-11-04T00:00:00.000Z" },
            { tool: "bash", prefix: "ls", decision: "allow" },
            "nope",
            null,
          ],
          "/empty": [{ tool: "bash", prefix: "", decision: "allow", createdAt: "x" }],
          "/bad": "rules",
        },
      }),
    );
    const store = new CommandRuleStore(directory, identity);
    expect(store.list()).toEqual([
      {
        root: "/repo",
        rules: [{ tool: "bash", prefix: "git status", decision: "allow", createdAt: "2026-11-04T00:00:00.000Z" }],
      },
    ]);
  });

  it.each([["not json"], ["[]"], ['{"projects":[]}'], ["null"]])("starts empty from %s", async (content) => {
    await writeFile(file(), content);
    expect(new CommandRuleStore(directory, identity).list()).toEqual([]);
  });
});
