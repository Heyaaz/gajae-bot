import { describe, expect, it } from "vitest";
import {
  defaultRulePrefix,
  matchCommandRule,
  normalizeRulePrefix,
  type CommandRule,
} from "./command-rules";

const rule = (prefix: string, decision: CommandRule["decision"]): CommandRule => ({
  tool: "bash",
  prefix,
  decision,
  createdAt: "2026-11-04T00:00:00.000Z",
});

describe("matchCommandRule allow rules", () => {
  const rules = [rule("git status", "allow")];

  it("matches a plain command that starts with the prefix tokens", () => {
    expect(matchCommandRule(rules, "bash", "git status")).toEqual({ decision: "allow", prefix: "git status" });
    expect(matchCommandRule(rules, "bash", "  git   status --short  ")).toEqual({
      decision: "allow",
      prefix: "git status",
    });
  });

  it("matches only at a token boundary", () => {
    expect(matchCommandRule(rules, "bash", "git statusx")).toBeUndefined();
    expect(matchCommandRule(rules, "bash", "xgit status")).toBeUndefined();
    expect(matchCommandRule(rules, "bash", "git")).toBeUndefined();
    expect(matchCommandRule(rules, "bash", "git log")).toBeUndefined();
  });

  it("ignores every tool but bash", () => {
    expect(matchCommandRule(rules, "write", "git status")).toBeUndefined();
    expect(matchCommandRule(rules, "Bash", "git status")).toBeUndefined();
    expect(matchCommandRule([rule("git push", "reject")], "edit", "git push")).toBeUndefined();
  });

  it.each([
    ["semicolon", "git status; rm -rf x"],
    ["and", "git status && rm -rf x"],
    ["background", "git status & rm -rf x"],
    ["or", "git status || rm -rf x"],
    ["pipe", "git status | tee out"],
    ["backtick", "git status `rm -rf x`"],
    ["command substitution", "git status $(rm -rf x)"],
    ["parameter expansion", "git status ${HOME}"],
    ["redirect out", "git status > out"],
    ["redirect in", "git status < in"],
    ["newline", "git status\nrm -rf x"],
    ["carriage return", "git status\rrm -rf x"],
  ])("sends a command with %s to the card", (_name, command) => {
    expect(matchCommandRule(rules, "bash", command)).toBeUndefined();
  });

  it("still allows a plain variable reference", () => {
    expect(matchCommandRule(rules, "bash", "git status $HOME")).toEqual({ decision: "allow", prefix: "git status" });
  });

  it("does not trust a stored prefix that carries a chaining character", () => {
    expect(matchCommandRule([rule("git status; rm", "allow")], "bash", "git status; rm")).toBeUndefined();
  });
});

describe("matchCommandRule reject rules", () => {
  const rules = [rule("git push", "reject")];

  it("matches a plain command", () => {
    expect(matchCommandRule(rules, "bash", "git push origin main")).toEqual({
      decision: "reject",
      prefix: "git push",
    });
  });

  it.each([
    ["and", "cd x && git push"],
    ["or", "false || git push"],
    ["semicolon", "echo hi; git push"],
    ["pipe", "echo hi | git push"],
    ["background", "sleep 1 & git push"],
    ["newline", "echo hi\ngit push"],
    ["carriage return", "echo hi\r git push"],
    ["substitution", "echo $(git push)"],
    ["backtick", "echo `git push`"],
    ["subshell", "(git push)"],
  ])("matches a segment of a chain with %s", (_name, command) => {
    expect(matchCommandRule(rules, "bash", command)).toEqual({ decision: "reject", prefix: "git push" });
  });

  it("keeps the token boundary", () => {
    expect(matchCommandRule(rules, "bash", "cd x && git pushx")).toBeUndefined();
    expect(matchCommandRule(rules, "bash", "echo git push")).toBeUndefined();
  });

  it("wins over an allow rule that also matches", () => {
    const both = [rule("git", "allow"), rule("git push", "reject")];
    expect(matchCommandRule(both, "bash", "git push")).toEqual({ decision: "reject", prefix: "git push" });
    expect(matchCommandRule(both, "bash", "git status")).toEqual({ decision: "allow", prefix: "git" });
  });

  it("wins over an allow rule when the allow rule would have skipped the compound command", () => {
    const both = [rule("cd", "allow"), rule("git push", "reject")];
    expect(matchCommandRule(both, "bash", "cd x && git push")).toEqual({ decision: "reject", prefix: "git push" });
  });
});

describe("normalizeRulePrefix", () => {
  it("trims and collapses whitespace", () => {
    expect(normalizeRulePrefix("  npm \t run   test ")).toBe("npm run test");
  });

  it("refuses an empty prefix", () => {
    expect(normalizeRulePrefix("")).toBeUndefined();
    expect(normalizeRulePrefix("   \t ")).toBeUndefined();
  });

  it("refuses a prefix over 200 characters", () => {
    expect(normalizeRulePrefix("a".repeat(200))).toBe("a".repeat(200));
    expect(normalizeRulePrefix("a".repeat(201))).toBeUndefined();
  });

  it.each([";", "&", "&&", "|", "||", "`", "$(", "${", "<", ">", "\n", "\r"])(
    "refuses a prefix containing %j",
    (character) => {
      expect(normalizeRulePrefix(`git ${character} status`)).toBeUndefined();
    },
  );

  it("refuses other control characters", () => {
    expect(normalizeRulePrefix("git\u0000status")).toBeUndefined();
    expect(normalizeRulePrefix("git\u000bstatus")).toBeUndefined();
  });
});

describe("defaultRulePrefix", () => {
  it("takes the first two tokens", () => {
    expect(defaultRulePrefix("git status --short")).toBe("git status");
    expect(defaultRulePrefix("  npm   run build ")).toBe("npm run");
  });

  it("keeps a lone token", () => {
    expect(defaultRulePrefix("ls")).toBe("ls");
    expect(defaultRulePrefix("")).toBe("");
  });

  it("stays inside the first segment", () => {
    expect(defaultRulePrefix("ls && git push")).toBe("ls");
    expect(defaultRulePrefix("cd x; git push")).toBe("cd x");
    expect(defaultRulePrefix("git log | head")).toBe("git log");
  });

  it("produces a prefix that normalizes to itself", () => {
    const prefix = defaultRulePrefix("git diff --stat && echo done");
    expect(normalizeRulePrefix(prefix)).toBe(prefix);
  });
});
