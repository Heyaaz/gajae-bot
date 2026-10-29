import type { AgentCommand, AgentEvent, AgentSession } from "../shared/agent-contract.js";
import { sdkSlashCommandsForOperations, skillsDisabledByConfig } from "./gjc-sdk-foundation.js";

/** Command palette refresh after a failed read, doubled until the cap. */
export const COMMAND_REFRESH_RETRY_BASE_MS = 1_000;

export const COMMAND_REFRESH_RETRY_MAX_MS = 30_000;

export function commandPublicationKey(commands: readonly AgentCommand[]): string {
  return commands
    .map(
      (command) =>
        `${command.name}\0${command.description}\0${command.hint ?? ""}`,
    )
    .join("\n");
}

/** The controller members the command palette refresh reads and writes. */
export interface CommandPaletteHost {
  readonly commandRefreshes: Map<string, Promise<void>>;
  readonly sessionAdvertisedCommands: Map<string, AgentCommand[]>;
  readonly sessionDiscoveredCommands: Map<string, AgentCommand[]>;
  readonly sessionCommands: Map<string, AgentCommand[]>;
  readonly disposed: boolean;
  readonly sessions: Map<string, AgentSession>;
  readonly commandRefreshTimers: Map<string, ReturnType<typeof setTimeout>>;
  readonly commandRefreshAttempts: Map<string, number>;
  querySessionItems(
    sessionId: string,
    query: string,
    input?: Record<string, unknown>,
    options?: { strict?: boolean },
  ): Promise<unknown[]>;
  readonly sessionSdkOperations: Map<string, Set<string>>;
  readonly publishedCommandKeys: Map<string, string>;
  readonly emitEvent: (event: AgentEvent) => void;
}

/**
 * Rebuilds one session's command palette.
 *
 * Three sources feed it:
 *  - this window's adapter specs, filtered by the operations the runtime
 *    advertises (`runtime.capabilities`);
 *  - dynamic commands synthesized from runtime state (`discoverDynamicCommands`),
 *    which is what fills a skill palette on create/attach before GJC has published
 *    anything of its own;
 *  - the runtime's advertised commands (`available_commands_update`), which win on
 *    a name collision.
 *
 * The palette is rebuilt from those sources whole, so a command the runtime stops
 * listing leaves with it. An authoritative update is also authority over the
 * synthesized set: once one arrives, even an empty one, the runtime's own list is
 * used alone and the synthesized entries are dropped instead of being merged back
 * in. A failing source contributes nothing rather than clearing the palette.
 */
export function refreshSdkCommands(
  host: CommandPaletteHost,
  sessionId: string,
  advertised?: AgentCommand[],
): Promise<void> {
  // An advertised update carries new authority and must run on its own. Every
  // other caller is asking for the same rebuild, so join the one in flight
  // instead of starting a second pair of capability/skill CLI reads.
  if (advertised) return rebuildSdkCommands(host, sessionId, advertised);
  const inFlight = host.commandRefreshes.get(sessionId);
  if (inFlight) return inFlight;
  const refresh = rebuildSdkCommands(host, sessionId).finally(() => {
    if (host.commandRefreshes.get(sessionId) === refresh)
      host.commandRefreshes.delete(sessionId);
  });
  host.commandRefreshes.set(sessionId, refresh);
  return refresh;
}

async function rebuildSdkCommands(
  host: CommandPaletteHost,
  sessionId: string,
  advertised?: AgentCommand[],
): Promise<void> {
  if (advertised) host.sessionAdvertisedCommands.set(sessionId, advertised);
  // A capability query that answers nothing is not the same as one that answered
  // "no": the cached set is reused when there is one, and the adapter specs stay
  // out of the palette rather than reporting a guess either way. A query that
  // fails is neither: the palette already on screen stays, and the read is
  // retried with backoff instead of being abandoned until the next open.
  let operations: Set<string>;
  try {
    operations = await sdkOperations(host, sessionId, { strict: true });
  } catch {
    scheduleCommandRefreshRetry(host, sessionId);
    return;
  }
  const authoritative = host.sessionAdvertisedCommands.get(sessionId);
  let discovered: AgentCommand[] | undefined;
  if (authoritative === undefined) {
    try {
      discovered = await discoverDynamicCommands(host, sessionId, operations);
    } catch {
      scheduleCommandRefreshRetry(host, sessionId);
      return;
    }
  }
  if (discovered) host.sessionDiscoveredCommands.set(sessionId, discovered);
  else host.sessionDiscoveredCommands.delete(sessionId);
  if (
    operations.size === 0 &&
    authoritative === undefined &&
    discovered === undefined
  ) {
    // Nothing to rebuild from: never publish an empty palette over a good cache.
    // An empty answer is still an answer, so a previous failure stops retrying.
    clearCommandRefreshRetry(host, sessionId);
    return;
  }
  const commands = [
    ...new Map(
      [
        ...sdkSlashCommandsForOperations([...operations]),
        ...(discovered ?? []),
        ...(authoritative ?? []),
      ].map((command) => [command.name, command]),
    ).values(),
  ];
  host.sessionCommands.set(sessionId, commands);
  clearCommandRefreshRetry(host, sessionId);
  publishSessionCommands(host, sessionId, commands);
}

function scheduleCommandRefreshRetry(host: CommandPaletteHost, sessionId: string): void {
  if (
    host.disposed ||
    !host.sessions.has(sessionId) ||
    host.commandRefreshTimers.has(sessionId)
  )
    return;
  const attempt = host.commandRefreshAttempts.get(sessionId) ?? 0;
  const delay = Math.min(
    COMMAND_REFRESH_RETRY_MAX_MS,
    COMMAND_REFRESH_RETRY_BASE_MS * 2 ** attempt,
  );
  host.commandRefreshAttempts.set(sessionId, attempt + 1);
  const timer = setTimeout(() => {
    host.commandRefreshTimers.delete(sessionId);
    if (host.disposed || !host.sessions.has(sessionId)) return;
    void refreshSdkCommands(host, sessionId);
  }, delay);
  host.commandRefreshTimers.set(sessionId, timer);
}

export function clearCommandRefreshRetry(host: CommandPaletteHost, sessionId: string): void {
  const timer = host.commandRefreshTimers.get(sessionId);
  if (timer) clearTimeout(timer);
  host.commandRefreshTimers.delete(sessionId);
  host.commandRefreshAttempts.delete(sessionId);
}

/**
 * Dynamic commands synthesized from runtime state, used only until the runtime
 * publishes its own list.
 *
 * `skill.list/state` is the only dynamic command source gjc/0.18.11 exposes through
 * the SDK query surface: there is no query for the slash-command snapshot the
 * runtime builds for its own UI (`getSessionSlashCommands`, which filters
 * `skillsSettings.enableSkillCommands` and `skill.hide`), and this window does not
 * pretend to reproduce that registry. Rows that carry a visibility flag are honored
 * and a config that explicitly disables skills removes the whole set, but a hidden
 * skill in a row that carries no flag cannot be told apart from a visible one, so
 * these entries are advertised as selectable agent work only: `/skill:<name>` is
 * still delivered to the runtime as a prompt, and the runtime decides whether the
 * skill runs. They are also dropped as soon as an `available_commands_update`
 * arrives, since the runtime's own list is the authority on its own commands.
 */
async function discoverDynamicCommands(
  host: CommandPaletteHost,
  sessionId: string,
  operations: ReadonlySet<string>,
): Promise<AgentCommand[] | undefined> {
  if (!operations.has("skill.list/state")) return undefined;
  const [skills, config] = await Promise.all([
    host.querySessionItems(sessionId, "skill.list/state", {}, { strict: true }),
    operations.has("config.list/get")
      ? host.querySessionItems(
          sessionId,
          "config.list/get",
          {},
          { strict: true },
        )
      : Promise.resolve([]),
  ]);
  if (skillsDisabledByConfig(config)) return [];
  const commands = new Map<string, AgentCommand>();
  for (const row of skills) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const skill = row as Record<string, unknown>;
    const name = typeof skill.name === "string" ? skill.name.trim() : "";
    if (!name) continue;
    if (
      skill.hide === true ||
      skill.hidden === true ||
      skill.enabled === false ||
      skill.visible === false
    )
      continue;
    const commandName = `skill:${name}`;
    if (commands.has(commandName)) continue;
    const description =
      typeof skill.description === "string" ? skill.description : "";
    commands.set(commandName, {
      name: commandName,
      description: description || `Run the ${name} skill`,
      hint: "[instructions]",
    });
  }
  return [...commands.values()];
}

export async function sdkOperations(
  host: CommandPaletteHost,
  sessionId: string,
  options?: { strict?: boolean },
): Promise<Set<string>> {
  const cached = host.sessionSdkOperations.get(sessionId);
  if (cached) return cached;
  const rows = await host.querySessionItems(
    sessionId,
    "runtime.capabilities",
    {},
    options?.strict ? { strict: true } : undefined,
  );
  const operations = new Set(
    rows.flatMap((row) => {
      if (!row || typeof row !== "object" || Array.isArray(row)) return [];
      const value = row as Record<string, unknown>;
      return Array.isArray(value.operations)
        ? value.operations.filter(
            (operation): operation is string => typeof operation === "string",
          )
        : [];
    }),
  );
  if (operations.size > 0) host.sessionSdkOperations.set(sessionId, operations);
  return operations;
}

/**
 * Hands the renderer a command palette once per distinct content.
 *
 * Reopening a session used to emit the cached palette on every visit, and the
 * shell replaced its state with a new array of the same commands.
 */
export function publishSessionCommands(
  host: CommandPaletteHost,
  sessionId: string,
  commands: readonly AgentCommand[],
): void {
  const key = commandPublicationKey(commands);
  if (host.publishedCommandKeys.get(sessionId) === key) return;
  host.publishedCommandKeys.set(sessionId, key);
  host.emitEvent({
    type: "session.commands",
    sessionId,
    commands: commands.map((command) => ({ ...command })),
  });
}
