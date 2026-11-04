import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  matchCommandRule,
  normalizeRulePrefix,
  type CommandRule,
  type CommandRuleDecision,
  type CommandRuleMatch,
  type ProjectCommandRules,
} from "../shared/command-rules.js";

/**
 * Project command rules, kept in the app's user data. A rule belongs to a
 * project's main working tree, so every worktree and session of that project
 * shares it; `resolveRoot` maps a session's path to that root.
 */
export class CommandRuleStore {
  private readonly filePath: string;
  private projects: Map<string, CommandRule[]>;

  constructor(
    userDataDirectory: string,
    private readonly resolveRoot: (path: string) => Promise<string>,
  ) {
    this.filePath = path.join(userDataDirectory, "command-rules.json");
    this.projects = this.read();
  }

  async decide(projectPath: string, toolName: string, command: string): Promise<CommandRuleMatch | undefined> {
    const root = await this.resolveRoot(projectPath);
    return matchCommandRule(this.projects.get(root) ?? [], toolName, command);
  }

  async add(projectPath: string, prefix: string, decision: CommandRuleDecision): Promise<void> {
    const normalized = normalizeRulePrefix(prefix);
    if (!normalized) throw new Error("Command rule prefix is invalid");
    const root = await this.resolveRoot(projectPath);
    const rule: CommandRule = { tool: "bash", prefix: normalized, decision, createdAt: new Date().toISOString() };
    const rules = [...(this.projects.get(root) ?? []).filter((existing) => existing.prefix !== normalized), rule];
    this.commit(new Map(this.projects).set(root, rules));
  }

  list(): ProjectCommandRules[] {
    return [...this.projects].map(([root, rules]) => ({ root, rules: rules.map((rule) => ({ ...rule })) }));
  }

  remove(root: string, prefix: string): void {
    const rules = this.projects.get(root);
    if (!rules?.some((rule) => rule.prefix === prefix)) return;
    const remaining = rules.filter((rule) => rule.prefix !== prefix);
    const next = new Map(this.projects);
    if (remaining.length > 0) next.set(root, remaining);
    else next.delete(root);
    this.commit(next);
  }

  /** Memory follows disk: a failed write leaves the rules as they were. */
  private commit(next: Map<string, CommandRule[]>): void {
    this.write(next);
    this.projects = next;
  }

  private read(): Map<string, CommandRule[]> {
    const projects = new Map<string, CommandRule[]>();
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(this.filePath, "utf8"));
    } catch {
      return projects;
    }
    const stored = (value as { projects?: unknown } | null)?.projects;
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return projects;
    for (const [root, raw] of Object.entries(stored)) {
      if (!root || !Array.isArray(raw)) continue;
      const byPrefix = new Map<string, CommandRule>();
      for (const entry of raw) {
        const rule = parseRule(entry);
        if (rule) byPrefix.set(rule.prefix, rule);
      }
      if (byPrefix.size > 0) projects.set(root, [...byPrefix.values()]);
    }
    return projects;
  }

  private write(projects: Map<string, CommandRule[]>): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify({ projects: Object.fromEntries(projects) }, null, 2)}\n`, {
      mode: 0o600,
    });
    renameSync(temporaryPath, this.filePath);
  }
}

function parseRule(value: unknown): CommandRule | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { tool, prefix, decision, createdAt } = value as Record<string, unknown>;
  if (tool !== "bash" || (decision !== "allow" && decision !== "reject")) return undefined;
  const normalized = typeof prefix === "string" ? normalizeRulePrefix(prefix) : undefined;
  if (!normalized || typeof createdAt !== "string") return undefined;
  return { tool, prefix: normalized, decision, createdAt };
}
