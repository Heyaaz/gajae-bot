import { homedir } from "node:os";
import path from "node:path";
import { execFile as execFileCb } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import type {
  AgentCommand,
  AgentConfigOption,
  ToolActivity,
} from "../shared/agent-contract.js";
import { DEFAULT_MODEL_PRESET } from "../shared/agent-contract.js";
import type { SessionMetadataStore } from "./session-metadata-store.js";


/**
 * Transcript and event shapes.
 *
 * Gajae reads these updates from the session's own file under
 * `~/.gjc/agent/sessions/` and from `gjc sdk session tail` frames, so the shapes
 * are declared here instead of imported from a protocol package. The field names
 * match what GJC persists, which is what both sources carry.
 */
import {
  ATTACH_RETRY_INTERVAL_MS,
  AvailableCommand,
  CLOCK_LABEL,
  ContentBlock,
  EFFORT_LEVELS,
  GJC_ACCENT,
  GjcControllerOptions,
  HISTORY_SUMMARY_HEAD_BYTES,
  LIFECYCLE_RECOVERY_ATTEMPTS,
  LIFECYCLE_RECOVERY_CLOCK_SLACK_MS,
  LIFECYCLE_RECOVERY_INTERVAL_MS,
  LIVE_EVIDENCE_GRACE_MS,
  MAX_TOOL_TEXT,
  PROMPT_SETTLE_ATTEMPTS,
  PROMPT_SETTLE_INTERVAL_MS,
  PendingPermission,
  PlanEntry,
  RUN_STATE_TAIL_BYTES,
  ResolvedMessageInput,
  STARTUP_TIMEOUT_MS,
  SendMessageOptions,
  SessionConfigOption,
  SessionInfo,
  SessionNotification,
  SessionUpdate,
  TAIL_RETRY_BASE_MS,
  TAIL_RETRY_MAX_MS,
  TAIL_WINDOW_MS,
  TRANSCRIPT_RESCAN_WINDOW,
  ToolCallFields,
  ToolCallStatus,
  execFile,
  markUpdated,
  nowLabel,
  parentSessionOf,
  recentLabel,
  timestampMs,
} from "./gjc-sdk-model.js";

export type SdkSlashCommandSpec = AgentCommand & {
  operations: readonly string[];
};

/**
 * Desktop slash commands backed by public GJC SDK operations.
 *
 * This is an adapter from the SDK's semantic operation names to the CLI spelling,
 * not an independent claim about availability. The live `runtime.capabilities`
 * response is authoritative and filters the list before it reaches the renderer.
 * TUI-only commands are intentionally absent: they have no SDK operation to invoke.
 */
/**
 * Components `runtime.reload` accepts. Mirrors the runtime's own adapter
 * validation (`sdk/protocol/adapter-validation.ts`), which rejects anything else
 * with `invalid_reload_component`.
 */
export const SDK_RELOAD_COMPONENTS = [
  "config",
  "models",
  "skills",
  "extensions",
  "tools",
] as const;

/**
 * The `service_tier.set` tier that means "send no service_tier parameter".
 *
 * GJC's own `/fast off` clears the tier (`setServiceTier(undefined)`), and the SDK
 * control cannot carry `undefined` -- the host validates `tier` as one of the
 * settings values. `none` is that settings value ("Omit service_tier parameter"),
 * and `resolveServiceTier`/`shouldSendServiceTier` treat it exactly like
 * `undefined` on the wire, so this is the same request the CLI ends up sending.
 */
export const SDK_SERVICE_TIER_OFF = "none";

/** Tiers GJC counts as fast-mode intent (`isFastModeEnabled`). */
export const SDK_FAST_SERVICE_TIERS = new Set(["priority", "claude-only", "openai-only"]);

/**
 * Fast tiers scoped to one provider family. An explicit `/fast on` for one of
 * these keeps the user's scope instead of widening it to `priority`
 * (`AgentSession.setFastMode` re-arms an already-enabled tier rather than
 * replacing it).
 */
export const SDK_SCOPED_FAST_SERVICE_TIERS = new Set(["claude-only", "openai-only"]);

/**
 * Whether the session's config explicitly turns skills off.
 *
 * Only an explicit false counts: a host that reports nothing about skills leaves
 * its own default (skill commands are enabled) in force. Both shapes a runtime may
 * report are read -- flat `skills.enabled` / `skills.enableSkillCommands` keys, and
 * a nested `skills` group object.
 */
export function skillsDisabledByConfig(config: readonly unknown[]): boolean {
  const disabled = (value: unknown): boolean =>
    value === false || value === "false";
  const groupDisables = (group: unknown): boolean => {
    if (!group || typeof group !== "object" || Array.isArray(group)) return false;
    const value = group as Record<string, unknown>;
    return (
      disabled(value.enabled) || disabled(value.enableSkillCommands)
    );
  };
  for (const row of config) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const item = row as Record<string, unknown>;
    if (
      disabled(item["skills.enabled"]) ||
      disabled(item["skills.enableSkillCommands"])
    )
      return true;
    const key = String(item.key ?? item.name ?? item.id ?? "");
    const value = item.value ?? item.currentValue;
    if (key === "skills.enabled" || key === "skills.enableSkillCommands") {
      if (disabled(value)) return true;
      continue;
    }
    const group = key === "skills" ? value ?? item.skills : item.skills;
    if (group !== undefined && groupDisables(group)) return true;
  }
  return false;
}

export const SDK_SLASH_COMMAND_SPECS: readonly SdkSlashCommandSpec[] = [
  {
    name: "context",
    description: "Show active context token usage",
    operations: ["context.get"],
  },
  {
    name: "usage",
    description: "Show token usage",
    operations: ["usage.get"],
  },
  {
    name: "tools",
    description: "Show tools available to this session",
    operations: ["tools.list"],
  },
  {
    name: "jobs",
    description: "Show background jobs",
    operations: ["runtime.jobs.list"],
  },
  {
    name: "session",
    description: "Show session information or delete it",
    hint: "info|delete",
    operations: ["session.metadata", "session.stats"],
  },
  {
    name: "transcript",
    description: "Show transcript entries",
    operations: ["transcript.list"],
  },
  {
    name: "dump",
    description: "Return the transcript as text",
    operations: ["transcript.list"],
  },
  {
    name: "extensions",
    description: "Show active extensions",
    operations: ["extensions.list"],
  },
  {
    name: "provider",
    description: "Show active providers or start login",
    hint: "[login <provider>]",
    operations: ["providers.list/active", "auth.providers", "auth.login"],
  },
  {
    name: "credential",
    description: "Show credential provider status",
    operations: ["auth.providers"],
  },
  {
    name: "goal",
    description: "Show or operate goal mode",
    hint: "[set|show|pause|resume|complete|drop] [objective]",
    operations: ["goal.list/get", "mode.goal.operate"],
  },
  {
    name: "model",
    description: "Select the active model profile",
    hint: "[profile]",
    operations: ["model.profile.set", "model.set", "models.profiles.list"],
  },
  {
    name: "effort",
    description: "Show or set model reasoning effort",
    hint: "[inherit|off|minimal|low|medium|high|xhigh|max]",
    operations: ["thinking.set"],
  },
  {
    name: "fast",
    description: "Toggle the priority service tier intent",
    hint: "[toggle|on|off|status]",
    operations: ["service_tier.set"],
  },
  {
    name: "skills",
    description: "List the skills this session can run",
    operations: ["skill.list/state"],
  },
  {
    name: "progress",
    description: "Show the project progress snapshot",
    operations: ["session.progress"],
  },
  {
    name: "reload",
    description: "Reload runtime components",
    hint: "[config|models|skills|extensions|tools]",
    operations: ["runtime.reload"],
  },
  {
    name: "plan",
    description: "Turn plan mode on or off",
    hint: "[on|off]",
    operations: ["mode.plan.set"],
  },
  {
    name: "export",
    description: "Export this session to HTML",
    operations: ["session.export_html"],
  },
  {
    name: "clear",
    description: "Clear context while preserving this session ID",
    operations: ["context.clear"],
  },
  {
    name: "compact",
    description: "Compact context and continue this session",
    operations: ["compaction.run"],
  },
  {
    name: "retry",
    description: "Retry the last interrupted turn",
    operations: ["retry.last"],
  },
  {
    name: "background",
    description: "Move the active managed bash job to the background",
    operations: ["bash.background"],
  },
  {
    name: "rename",
    description: "Rename the current session",
    hint: "<title>",
    operations: ["session.rename"],
  },
  {
    name: "move",
    description: "Move the session working directory",
    hint: "<path>",
    operations: ["session.cwd.move"],
  },
];

export function sdkSlashCommandsForOperations(
  operations: readonly string[],
): AgentCommand[] {
  const available = new Set(operations);
  return SDK_SLASH_COMMAND_SPECS.flatMap((spec) =>
    spec.operations.some((operation) => available.has(operation))
      ? [
          {
            name: spec.name,
            description:
              spec.name === "provider" && !available.has("auth.login")
                ? "Show active provider status"
                : spec.description,
            ...(spec.hint &&
            !(spec.name === "provider" && !available.has("auth.login"))
              ? { hint: spec.hint }
              : {}),
          },
        ]
      : [],
  );
}

export function configOptionValues(
  option: Extract<SessionConfigOption, { type: "select" }>,
): AgentConfigOption["options"] {
  // A select carries either flat items or groups of items; both shapes reach here.
  return option.options
    .flatMap((item) =>
      "group" in item && Array.isArray(item.options)
        ? (item.options as Array<Record<string, unknown>>)
        : [item],
    )
    .flatMap((item) => {
      const value = item.id ?? item.value;
      if (typeof value !== "string") return [];
      const name = typeof item.name === "string" ? item.name : value;
      const description =
        typeof item.description === "string" ? item.description : undefined;
      const group = typeof item.group === "string" ? item.group : undefined;
      return [
        {
          value,
          name,
          ...(description ? { description } : {}),
          ...(group ? { group } : {}),
        },
      ];
    });
}

export function agentConfigOptions(
  options: SessionConfigOption[],
): AgentConfigOption[] {
  return options.map((option) =>
    option.type === "select"
      ? {
          id: option.id,
          name: option.name,
          category: option.category ?? undefined,
          type: "select",
          currentValue: option.currentValue ?? "",
          options: configOptionValues(option),
        }
      : {
          id: option.id,
          name: option.name,
          category: option.category ?? undefined,
          type: "boolean",
          currentValue: option.currentValue ?? false,
        },
  );
}

export function boundedJson(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  try {
    const text = redactSensitiveText(
      typeof value === "string" ? value : JSON.stringify(value, null, 2),
    );
    return text.length > MAX_TOOL_TEXT
      ? `${text.slice(0, MAX_TOOL_TEXT)}…`
      : text;
  } catch {
    return String(value);
  }
}

export function redactSensitiveText(value: string): string {
  return value
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]{12,}/giu, "$1[REDACTED]")
    .replace(/\b(sk-[A-Za-z0-9_-]{12,})\b/gu, "[REDACTED]")
    .replace(
      /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret)["']?\s*[:=]\s*["']?)[^\s,"'}]+/giu,
      "$1[REDACTED]",
    )
    .replace(
      /\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD))=([^\s]+)/gu,
      "$1=[REDACTED]",
    );
}

export function artifactReferences(value: unknown): string[] {
  let text: string | undefined;
  try {
    text =
      typeof value === "string"
        ? value
        : value == null
          ? undefined
          : JSON.stringify(value);
  } catch {
    text = undefined;
  }
  if (!text) return [];
  return [
    ...new Set(
      [...text.matchAll(/artifact:\/\/([A-Za-z0-9._-]+)/gu)].map(
        (match) => match[1]!,
      ),
    ),
  ];
}

/**
 * `## No commits yet on main` is the header of an unborn branch. Splitting it on
 * whitespace reports the branch as "No", which is what the header indicator showed
 * for a repository whose first commit does not exist yet.
 */
export function gitBranchFromHeader(header: string): string {
  const unborn = /^No commits yet on (.+)$/u.exec(header);
  if (unborn) return unborn[1]!.trim();
  if (header.startsWith("HEAD (no branch)")) return "HEAD";
  return header.split(" ")[0] ?? "";
}

export function safeGitPath(value: string): boolean {
  return (
    Boolean(value) &&
    !path.isAbsolute(value) &&
    !value.includes("\0") &&
    value !== ".." &&
    !value.startsWith("../")
  );
}

/**
 * GJC tool state as this app displays it.
 *
 * `pending` and `in_progress` are separate states and GJC sends both: a call
 * arrives pending and can sit there for seconds before it starts. Mapping both to
 * running spun a spinner and said 작업 중 for work that had not begun.
 *
 * An update carrying no status says nothing about the call, so the caller's existing
 * state stands and running is the safe assumption for a brand new one.
 */
export function toolStatus(
  status: ToolCallStatus | null | undefined,
): ToolActivity["status"] {
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "pending") return "pending";
  return "running";
}
