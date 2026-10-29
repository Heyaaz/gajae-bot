import path from "node:path";
import { rename } from "node:fs/promises";
import type { AgentEvent, AgentSession } from "../shared/agent-contract.js";
import type { SessionMetadataStore } from "./session-metadata-store.js";
import {
  destructiveSlashAction,
  destructiveSlashMessage,
  markUpdated,
  MAX_TOOL_TEXT,
  ResolvedMessageInput,
  SDK_FAST_SERVICE_TIERS,
  SDK_RELOAD_COMPONENTS,
  SDK_SCOPED_FAST_SERVICE_TIERS,
  SDK_SERVICE_TIER_OFF,
  SDK_SLASH_COMMAND_SPECS,
  SendMessageOptions,
} from "./gjc-sdk-foundation.js";

type SlashControlOperation =
  | "mode.goal.operate"
  | "model.profile.set"
  | "thinking.set"
  | "service_tier.set"
  | "session.export_html"
  | "context.clear"
  | "compaction.run"
  | "session.rename"
  | "session.cwd.move"
  | "retry.last"
  | "bash.background"
  | "runtime.reload"
  | "mode.plan.set"
  | "auth.login"
  | "btw.ask";

/** The controller members a slash command reads or drives. */
export interface SlashCommandHost {
  readonly workspace: string;
  readonly sessions: ReadonlyMap<string, AgentSession>;
  readonly sessionCwds: Map<string, string>;
  readonly sessionMetadata?: SessionMetadataStore;
  emitEvent(event: AgentEvent): void;
  sdkOperations(sessionId: string): Promise<Set<string>>;
  appendSdkCommandOutput(sessionId: string, content: string): void;
  querySessionItems(
    sessionId: string,
    query: string,
    input?: Record<string, unknown>,
    options?: { strict?: boolean },
  ): Promise<unknown[]>;
  controlSession(
    sessionId: string,
    operation: SlashControlOperation,
    input: Record<string, unknown>,
    options?: { confirm?: boolean },
  ): Promise<Record<string, unknown> | undefined>;
  deleteSession(sessionId: string): Promise<void>;
  sessionConfigRow(sessionId: string): Promise<Record<string, unknown> | undefined>;
  patchSessionRuntime(
    sessionId: string,
    patch: Partial<Pick<AgentSession, "mode" | "serviceTier">>,
  ): void;
  refreshSdkCommands(sessionId: string): Promise<void>;
  refreshSessionConfigOptions(sessionId: string): Promise<void>;
  compactSession(sessionId: string): Promise<void>;
  renameSession(sessionId: string, title: string): Promise<void>;
}

function sdkCommandJson(value: unknown): string {
  const text = JSON.stringify(value, null, 2) ?? String(value);
  const bounded =
    text.length <= MAX_TOOL_TEXT
      ? text
      : `${text.slice(0, MAX_TOOL_TEXT)}\n… output truncated`;
  return `\`\`\`json\n${bounded}\n\`\`\``;
}

export async function executeSdkSlashCommand(
  host: SlashCommandHost,
  sessionId: string,
  input: ResolvedMessageInput,
  options?: SendMessageOptions,
): Promise<boolean> {
  if (input.images?.length || input.files?.length) return false;
  const match = /^\/([a-z][a-z0-9-]*)(?:\s+([\s\S]*))?$/iu.exec(
    input.text.trim(),
  );
  if (!match?.[1]) return false;
  const name = match[1].toLowerCase();
  const args = match[2]?.trim() ?? "";
  const destructive = destructiveSlashAction(input);
  if (destructive && !options?.allowDestructive)
    throw new Error(`${destructiveSlashMessage(destructive)} 데스크톱 확인이 필요한 작업입니다. 이 경로에서는 실행하지 않았습니다.`);
  const spec = SDK_SLASH_COMMAND_SPECS.find(
    (candidate) => candidate.name === name,
  );
  if (!spec) return false;
  const operations = await host.sdkOperations(sessionId);
  // A recognized command whose capability this runtime does not advertise is
  // refused rather than forwarded as prompt text: the same characters would reach
  // the model as a user request for work GJC just said it cannot dispatch.
  if (!spec.operations.some((operation) => operations.has(operation)))
    throw new Error(
      `/${name} is unavailable in this GJC runtime (${spec.operations.join(" and ")} not advertised)`,
    );

  const requireOperation = (operation: string): void => {
    if (!operations.has(operation))
      throw new Error(
        `/${name} is unavailable in this GJC runtime (${operation} is not advertised)`,
      );
  };
  const output = (content: string): true => {
    host.appendSdkCommandOutput(sessionId, content);
    return true;
  };
  const query = async (
    operation: string,
    queryInput: Record<string, unknown> = {},
  ): Promise<unknown[]> => {
    requireOperation(operation);
    return await host.querySessionItems(sessionId, operation, queryInput, {
      strict: true,
    });
  };
  const control = async (
    operation:
      | "mode.goal.operate"
      | "model.profile.set"
      | "thinking.set"
      | "service_tier.set"
      | "session.export_html"
      | "context.clear"
      | "compaction.run"
      | "session.rename"
      | "session.cwd.move"
      | "retry.last"
      | "bash.background"
      | "runtime.reload"
      | "mode.plan.set"
      | "auth.login"
      | "btw.ask",
    controlInput: Record<string, unknown> = {},
    options?: { confirm?: boolean },
  ): Promise<Record<string, unknown> | undefined> => {
    requireOperation(operation);
    return await host.controlSession(
      sessionId,
      operation,
      controlInput,
      options,
    );
  };

  switch (name) {
    case "btw": {
      if (!args) throw new Error("Usage: /btw <question>");
      const result = await control("btw.ask", { question: args });
      const reply =
        typeof result?.reply === "string" ? result.reply.trim() : "";
      if (!reply) throw new Error("GJC returned no /btw answer");
      // The runtime answers from this session's own context and keeps nothing:
      // the reply is an app-owned row like every other SDK command output, so
      // the GJC transcript this window mirrors never gains the side question.
      const question = args
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
      return output(["## Side question", question, "", reply].join("\n"));
    }
    case "context": {
      if (args) throw new Error("Usage: /context");
      const rows = await query("context.get");
      const row = rows[0] as Record<string, unknown> | undefined;
      const usage =
        row?.usage &&
        typeof row.usage === "object" &&
        !Array.isArray(row.usage)
          ? (row.usage as Record<string, unknown>)
          : undefined;
      return output(
        [
          "## Context",
          `- Window: ${typeof usage?.contextWindow === "number" ? usage.contextWindow.toLocaleString() : "unknown"} tokens`,
          `- Used: ${typeof usage?.percent === "number" ? `${usage.percent.toFixed(1)}%` : "unknown"}`,
          `- Source: ${typeof usage?.source === "string" ? usage.source : "unknown"}`,
          `- Streaming: ${row?.isStreaming === true ? "yes" : "no"}`,
          `- Steers queued: ${typeof row?.steeringQueueDepth === "number" ? row.steeringQueueDepth : 0}`,
          `- Follow-ups queued: ${typeof row?.followupQueueDepth === "number" ? row.followupQueueDepth : 0}`,
        ].join("\n"),
      );
    }
    case "usage":
      if (args) throw new Error("Usage: /usage");
      return output(sdkCommandJson(await query("usage.get")));
    case "tools":
      if (args) throw new Error("Usage: /tools");
      return output(
        `## Tools\n${(await query("tools.list")).map((tool) => `- ${String(tool)}`).join("\n")}`,
      );
    case "jobs":
      if (args) throw new Error("Usage: /jobs");
      return output(sdkCommandJson(await query("runtime.jobs.list")));
    case "session": {
      const subcommand = args || "info";
      if (subcommand === "delete") {
        await host.deleteSession(sessionId);
        return true;
      }
      if (subcommand !== "info")
        throw new Error("Usage: /session [info|delete]");
      const [metadata, stats] = await Promise.all([
        query("session.metadata"),
        query("session.stats"),
      ]);
      return output(sdkCommandJson({ metadata: metadata[0], stats: stats[0] }));
    }
    case "transcript":
    case "dump":
      if (args) throw new Error(`Usage: /${name}`);
      return output(sdkCommandJson(await query("transcript.list")));
    case "extensions":
      if (args) throw new Error("Usage: /extensions");
      return output(sdkCommandJson(await query("extensions.list")));
    case "provider": {
      const login = /^login\s+(.+)$/iu.exec(args);
      if (login?.[1]) {
        const result = await control("auth.login", {
          provider: login[1].trim(),
        });
        return output(sdkCommandJson(result ?? { accepted: true }));
      }
      if (args) throw new Error("Usage: /provider [login <provider>]");
      const [active, auth] = await Promise.all([
        operations.has("providers.list/active")
          ? query("providers.list/active")
          : Promise.resolve([]),
        operations.has("auth.providers")
          ? query("auth.providers")
          : Promise.resolve([]),
      ]);
      return output(sdkCommandJson({ active, authentication: auth }));
    }
    case "credential":
      if (args) throw new Error("Credential switching is not exposed by this SDK runtime");
      return output(sdkCommandJson(await query("auth.providers")));
    case "goal": {
      const [verb = "show", ...rest] = args.split(/\s+/u).filter(Boolean);
      if (verb === "show" || verb === "get")
        return output(sdkCommandJson(await query("goal.list/get")));
      const op = verb === "set" ? "create" : verb;
      if (!new Set(["create", "pause", "resume", "complete", "drop"]).has(op))
        throw new Error(
          "Usage: /goal [set|show|pause|resume|complete|drop] [objective]",
        );
      const objective = rest.join(" ");
      if (op === "create" && !objective)
        throw new Error("Usage: /goal set <objective>");
      const result = await control("mode.goal.operate", {
        op,
        ...(objective ? { objective } : {}),
      });
      return output(sdkCommandJson(result ?? { accepted: true }));
    }
    case "model": {
      if (!args)
        return output(
          sdkCommandJson(await query("models.profiles.list")),
        );
      const result = await control("model.profile.set", { id: args });
      return output(sdkCommandJson(result ?? { profile: args }));
    }
    case "effort": {
      if (!args)
        return output(
          `Current effort: ${host.sessions.get(sessionId)?.thinking ?? "inherit"}`,
        );
      const result = await control("thinking.set", { level: args });
      return output(sdkCommandJson(result ?? { level: args }));
    }
    case "fast": {
      const verb = (args || "toggle").toLowerCase();
      if (!["toggle", "on", "off", "status"].includes(verb))
        throw new Error("Usage: /fast [toggle|on|off|status]");
      // The window only knows the tier the session reported (its transcript's
      // last `service_tier_change` or a tier this window set itself), and GJC
      // resolves that intent per provider. Every branch below therefore reports
      // the configured tier, never a claim that the provider honored it.
      const current = host.sessions.get(sessionId)?.serviceTier;
      const enabled =
        current !== undefined && SDK_FAST_SERVICE_TIERS.has(current);
      if (verb === "status")
        return output(
          [
            "## Fast mode",
            // A session that never recorded a tier reports none, and none means
            // no fast intent. The line says which of the two it is instead of
            // presenting an unread tier as a state the runtime confirmed.
            `- Intent: ${enabled ? "on" : current ? "off" : "off (no tier reported)"}`,
            `- Configured tier: ${current ?? "none reported"}`,
            "- Configured intent only: GJC decides per provider and model whether a",
            "  request actually carries the fast/priority tier.",
          ].join("\n"),
        );
      const enable = verb === "on" ? true : verb === "off" ? false : !enabled;
      // A toggle has to know the tier it is inverting: the runtime's own tier can
      // come from the user's global serviceTier setting, so guessing "off" would
      // silently downgrade a scoped tier. Ask the session's config once, and
      // refuse rather than flip a state this window cannot read.
      const tierSource =
        verb === "toggle" && current === undefined
          ? ((await host.sessionConfigRow(sessionId))?.serviceTier as
              | string
              | undefined)
          : current;
      if (verb === "toggle" && tierSource === undefined)
        throw new Error(
          "This session does not report its current service tier, so /fast cannot toggle it. Use /fast on or /fast off.",
        );
      const tier =
        enable
          ? tierSource && SDK_SCOPED_FAST_SERVICE_TIERS.has(tierSource)
            ? tierSource
            : "priority"
          : SDK_SERVICE_TIER_OFF;
      const result = await control("service_tier.set", { tier });
      // Mirror what the runtime recorded, including the "none" that stands for a
      // cleared tier, so the next status reads off instead of unknown.
      host.patchSessionRuntime(sessionId, { serviceTier: tier });
      return output(
        `Fast mode ${enable ? "enabled" : "disabled"} (configured tier: ${tier}).\n${sdkCommandJson(result ?? { tier })}`,
      );
    }
    case "skills": {
      if (args) throw new Error("Usage: /skills");
      const skills = (await query("skill.list/state")).flatMap((row) => {
        if (!row || typeof row !== "object" || Array.isArray(row)) return [];
        const value = row as Record<string, unknown>;
        if (typeof value.name !== "string" || !value.name) return [];
        const description =
          typeof value.description === "string" ? value.description : "";
        return [`- ${value.name}${description ? ` — ${description}` : ""}`];
      });
      return output(
        [
          "## Skills",
          ...(skills.length > 0
            ? skills
            : ["- This session reports no skills."]),
          "Run one as agent work with `/skill:<name> <request>`.",
        ].join("\n"),
      );
    }
    case "progress":
      if (args) throw new Error("Usage: /progress");
      return output(sdkCommandJson(await query("session.progress")));
    case "reload": {
      const requested = args.split(/[\s,]+/u).filter(Boolean);
      const unknown = requested.filter(
        (component) =>
          !(SDK_RELOAD_COMPONENTS as readonly string[]).includes(component),
      );
      if (unknown.length > 0)
        throw new Error(
          `Unknown reload component: ${unknown.join(", ")}. Use one or more of ${SDK_RELOAD_COMPONENTS.join(", ")}.`,
        );
      const components =
        requested.length > 0
          ? [...new Set(requested)]
          : [...SDK_RELOAD_COMPONENTS];
      // gjc/0.18.11 validates this list and then reloads the whole session
      // (`AgentSession.reload`); the per-component split is the runtime's to
      // apply, so the reply reports what was requested and what it answered.
      const result = await control("runtime.reload", { components });
      // A reload re-reads skills, extensions, and config from disk, so the
      // palette this window derived from the old ones is stale the moment it
      // succeeds. Rebuild both sides of the session's reported surface.
      await Promise.all([
        host.refreshSdkCommands(sessionId),
        // This reads the session config and the model profile list together.
        host.refreshSessionConfigOptions(sessionId).catch(() => undefined),
      ]);
      return output(
        `Reload requested for ${components.join(", ")}.\n${sdkCommandJson(result ?? { reloaded: true })}`,
      );
    }
    case "plan": {
      if (args !== "on" && args !== "off")
        throw new Error("Usage: /plan [on|off]");
      const on = args === "on";
      const result = await control("mode.plan.set", { on });
      if (typeof result?.enabled === "boolean")
        host.patchSessionRuntime(sessionId, {
          mode: result.enabled ? "plan" : "default",
        });
      return output(sdkCommandJson(result ?? { enabled: on }));
    }
    case "export": {
      if (args) throw new Error("This SDK exports to its managed HTML path; use /export without a path");
      const result = await control("session.export_html");
      return output(sdkCommandJson(result ?? { exported: true }));
    }
    case "clear":
      if (args) throw new Error("Usage: /clear");
      await control("context.clear", {}, { confirm: true });
      return output("Context cleared. The session ID and durable transcript were preserved.");
    case "compact":
      if (args) throw new Error("Use the compact action without inline instructions in this client");
      await host.compactSession(sessionId);
      return true;
    case "retry":
      if (args) throw new Error("Usage: /retry");
      return output(
        sdkCommandJson((await control("retry.last")) ?? { accepted: true }),
      );
    case "background":
      if (args) throw new Error("Usage: /background");
      return output(
        sdkCommandJson(
          (await control("bash.background")) ?? { accepted: true },
        ),
      );
    case "rename":
      if (!args) throw new Error("Usage: /rename <title>");
      await host.renameSession(sessionId, args);
      return output(`Session renamed to **${args}**.`);
    case "move":
      if (!args) throw new Error("Usage: /move <path>");
      {
        const result = await control("session.cwd.move", { path: args });
        const cwd =
          typeof result?.cwd === "string"
            ? result.cwd
            : path.resolve(host.sessionCwds.get(sessionId) ?? host.workspace, args);
        const session = host.sessions.get(sessionId);
        if (session) {
          host.sessionCwds.set(sessionId, cwd);
          host.sessionMetadata?.setWorkspace(sessionId, cwd);
          session.workspace = cwd;
          session.subtitle = path.basename(cwd) || cwd;
          markUpdated(session);
          host.emitEvent({ type: "session.updated", session: { ...session } });
        }
        return output(sdkCommandJson(result ?? { moved: true, cwd }));
      }
    default:
      return false;
  }
}
