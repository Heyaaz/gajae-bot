/**
 * Project command rules for GJC's tool approval channel.
 *
 * A rule decides a `bash` call by the leading words of its command. Allowing is
 * the dangerous direction, so an allow rule only ever matches one plain command:
 * anything that chains, pipes, substitutes or redirects goes to the approval card
 * instead. A reject rule is the opposite and errs toward rejecting, so it also
 * fires when the matching command sits in one segment of a chain.
 */

export type CommandRuleDecision = "allow" | "reject";

export interface CommandRule {
  tool: "bash";
  prefix: string;
  decision: CommandRuleDecision;
  createdAt: string;
}

export interface ProjectCommandRules {
  root: string;
  rules: CommandRule[];
}

export interface CommandRuleMatch {
  decision: CommandRuleDecision;
  prefix: string;
}

const MAX_PREFIX_LENGTH = 200;
const COMPOUND = /[;&|`<>\n\r]|\$[({]/u;
// Besides the shell's separators, a subshell or substitution opens a new command.
const SEGMENT_SEPARATOR = /[;&|\n\r`()]|\$[({]/u;

/** Control characters other than tab and newline; the newline is already a chaining character. */
function hasControlCharacter(text: string): boolean {
  return [...text].some((character) => {
    const code = character.charCodeAt(0);
    return (code < 32 && code !== 9 && code !== 10) || code === 127;
  });
}

function tokens(text: string): string[] {
  return text.split(/[ \t]+/u).filter(Boolean);
}

function startsWithTokens(command: readonly string[], prefix: readonly string[]): boolean {
  return (
    prefix.length > 0 &&
    command.length >= prefix.length &&
    prefix.every((token, index) => command[index] === token)
  );
}

function segments(command: string): string[] {
  return command.split(SEGMENT_SEPARATOR);
}

/** The prefix as it is stored: single spaces, no chaining characters. */
export function normalizeRulePrefix(prefix: string): string | undefined {
  if (COMPOUND.test(prefix) || hasControlCharacter(prefix)) return undefined;
  const normalized = tokens(prefix).join(" ");
  if (!normalized || normalized.length > MAX_PREFIX_LENGTH) return undefined;
  return normalized;
}

/** What the card offers to remember: the first two words of the command. */
export function defaultRulePrefix(command: string): string {
  const first = segments(command.trim())[0] ?? "";
  return tokens(first).slice(0, 2).join(" ");
}

export function matchCommandRule(
  rules: readonly CommandRule[],
  toolName: string,
  command: string,
): CommandRuleMatch | undefined {
  if (toolName !== "bash") return undefined;
  const usable = rules.flatMap((rule) => {
    const prefix = rule.tool === "bash" ? normalizeRulePrefix(rule.prefix) : undefined;
    return prefix ? [{ decision: rule.decision, prefix, words: tokens(prefix) }] : [];
  });

  const parts = segments(command).map(tokens);
  const rejected = usable.find(
    (rule) => rule.decision === "reject" && parts.some((part) => startsWithTokens(part, rule.words)),
  );
  if (rejected) return { decision: "reject", prefix: rejected.prefix };

  if (COMPOUND.test(command)) return undefined;
  const words = tokens(command);
  const allowed = usable.find((rule) => rule.decision === "allow" && startsWithTokens(words, rule.words));
  return allowed ? { decision: "allow", prefix: allowed.prefix } : undefined;
}
