import type { AgentConfigOption, AgentConfigOptionValue, AgentControlPreferences, AgentEvent, AgentSession } from "../shared/agent-contract.js";
import { GjcSdkCli } from "./gjc-sdk-cli.js";
import {
  agentConfigOptions,
  CONTEXT_USAGE_REFRESH_INTERVAL_MS,
  EFFORT_LEVELS,
  profileDefaultModelLabel,
  SessionConfigOption,
  thinkingOptionsForModelCatalog,
} from "./gjc-sdk-foundation.js";

/** The controller members the model, config and context usage reads touch. */
export interface SessionConfigHost {
  readonly modelProfiles: Map<string, AgentConfigOptionValue[]>;
  readonly modelPreset: AgentControlPreferences["modelPreset"];
  readonly modelPresetThinking: string | undefined;
  readonly explicitSessionThinking: Map<string, string>;
  readonly sessionConfig: Map<string, AgentConfigOption[]>;
  readonly emitEvent: (event: AgentEvent) => void;
  readonly sessions: Map<string, AgentSession>;
  requireCli(): Promise<GjcSdkCli>;
  repoFor(sessionId: string): string;
  readonly disposed: boolean;
  readonly contextUsageObservedAt: Map<string, number>;
  readonly contextUsageQueries: Map<string, Promise<void>>;
  querySessionItems(
    sessionId: string,
    query: string,
    input?: Record<string, unknown>,
    options?: { strict?: boolean },
  ): Promise<unknown[]>;
  advanceRunRevision(sessionId: string): number;
  controlSession(
    sessionId: string,
    operation:
      | "turn.prompt"
      | "turn.steer"
      | "turn.follow_up"
      | "turn.abort"
      | "queue.message.remove"
      | "compaction.run"
      | "mode.goal.operate"
      | "mode.plan.set"
      | "thinking.set"
      | "thinking.cycle"
      | "model.profile.set"
      | "permission_mode.set"
      | "config.patch"
      | "service_tier.set"
      | "session.export_html"
      | "context.clear"
      | "session.rename"
      | "session.cwd.move"
      | "retry.last"
      | "bash.background"
      | "runtime.reload"
      | "auth.login"
      | "btw.ask"
      | "workflow.gate_answer",
    input: Record<string, unknown>,
    options?: { confirm?: boolean; idempotencyKey?: string; timeoutMs?: number },
  ): Promise<Record<string, unknown> | undefined>;
  ensureAttached(
    sessionId: string,
    replay: boolean,
  ): Promise<void>;
}

export function captureSessionState(
  host: SessionConfigHost,
  sessionId: string,
  options: SessionConfigOption[],
  mode?: string | null,
): void {
  const normalized = agentConfigOptions(options);
  const discoveredProfiles = host.modelProfiles.get(sessionId);
  const modelOption = normalized.find(
    (option) => option.category === "model" || option.id === "model",
  );
  const selectedPreset =
    typeof modelOption?.currentValue === "string"
      ? modelOption.currentValue.replace(/^gajae-code\//u, "")
      : undefined;
  const thinkingOption = normalized.find(
    (option) =>
      option.category === "thought_level" || option.id === "thinking",
  );
  if (
    thinkingOption &&
    selectedPreset === host.modelPreset &&
    host.modelPresetThinking
  ) {
    thinkingOption.currentValue =
      host.explicitSessionThinking.get(sessionId) ?? host.modelPresetThinking;
  }
  if (modelOption && discoveredProfiles?.length)
    modelOption.options = discoveredProfiles;
  host.sessionConfig.set(sessionId, normalized);
  host.emitEvent({ type: "session.config", sessionId, options: normalized });
  const model = normalized.find(
    (option) => option.category === "model" || option.id === "model",
  );
  const thinking = normalized.find(
    (option) =>
      option.category === "thought_level" || option.id === "thinking",
  );
  const modelValue =
    typeof model?.currentValue === "string" ? model.currentValue : undefined;
  const currentSession = host.sessions.get(sessionId);
  const modelChanged =
    modelValue !== undefined && currentSession?.model !== modelValue;
  patchSessionRuntime(host, sessionId, {
    ...(mode ? { mode } : {}),
    ...(modelValue !== undefined ? { model: modelValue } : {}),
    ...(modelChanged ? { modelDisplay: undefined } : {}),
    ...(typeof thinking?.currentValue === "string"
      ? { thinking: thinking.currentValue }
      : {}),
  });
}

/**
 * Builds this session's config options from the session-scoped SDK config.
 *
 * The model/thinking selectors behind `/model` and Shift+Tab read these values.
 * The
 * session's own `config.list/get` is the authoritative source, and it answers the
 * session's real preset rather than a process-wide launch flag.
 */
export async function refreshSessionConfigOptions(host: SessionConfigHost, sessionId: string): Promise<void> {
  // The model picker cannot open until this finishes. Reading the session row
  // and the profile catalog in one round instead of two, and carrying the
  // profiles into the first emitted option, is what removes both the extra CLI
  // process and the empty picker that was on screen while the second read ran.
  const [row, profiles] = await Promise.all([
    sessionConfigRow(host, sessionId),
    loadModelProfiles(host, sessionId),
  ]);
  if (profiles && profiles.length > 0)
    host.modelProfiles.set(sessionId, profiles);
  if (!row) return;
  const availableProfiles =
    profiles ?? host.modelProfiles.get(sessionId) ?? [];
  const preset =
    typeof row.modelPreset === "string" && row.modelPreset
      ? row.modelPreset
      : undefined;
  const thinking =
    typeof row.thinking === "string" && row.thinking ? row.thinking : undefined;
  const mode = typeof row.mode === "string" && row.mode ? row.mode : undefined;
  const options: SessionConfigOption[] = [
    {
      type: "select",
      id: "model",
      name: "Model",
      category: "model",
      currentValue: preset ?? host.modelPreset,
      options: availableProfiles.map((profile) => ({
        type: "item",
        id: profile.value,
        name: profile.name,
        ...(profile.group ? { group: profile.group } : {}),
        ...(profile.description ? { description: profile.description } : {}),
      })),
    },
    {
      type: "select",
      id: "thinking",
      name: "Thinking",
      category: "thought_level",
      currentValue:
        host.explicitSessionThinking.get(sessionId) ??
        thinking ??
        host.modelPresetThinking,
      options: [...EFFORT_LEVELS].map((level) => ({
        type: "item",
        id: level,
        name: level,
      })),
    },
    ...(mode
      ? [
          {
            type: "select" as const,
            id: "mode",
            name: "Mode",
            category: "mode",
            currentValue: mode,
            options: [{ type: "item", id: mode, name: mode }],
          },
        ]
      : []),
  ];
  captureSessionState(host, sessionId, options, mode);
  // The catalog answer (display label and the model's own thinking choices) is
  // advisory: paint the picker now and let those details arrive after it opens.
  void refreshModelCapabilities(host, sessionId);
}

/** The runtime's model profile catalog, or undefined when it cannot answer. */
async function loadModelProfiles(
  host: SessionConfigHost,
  sessionId: string,
): Promise<AgentConfigOptionValue[] | undefined> {
  try {
    const cli = await host.requireCli();
    const items = await cli.queryItems(
      sessionId,
      "models.profiles.list",
      {},
      { repo: host.repoFor(sessionId) },
    );
    return items
      .flatMap((item): AgentConfigOptionValue[] => {
        if (!item || typeof item !== "object") return [];
        const profile = item as {
          id?: unknown;
          displayName?: unknown;
          source?: unknown;
          available?: unknown;
        };
        if (typeof profile.id !== "string" || profile.available === false)
          return [];
        const configured = profile.source === "configured";
        return [
          {
            value: profile.id,
            name:
              typeof profile.displayName === "string" && profile.displayName
                ? profile.displayName
                : profile.id,
            group: configured ? "Custom profiles" : "Built-in profiles",
            description: configured
              ? "From ~/.gjc/agent/models.yml"
              : "Bundled with GJC",
          },
        ];
      })
      .sort((left, right) => {
        if (left.group !== right.group)
          return left.group === "Custom profiles" ? -1 : 1;
        return left.name.localeCompare(right.name);
      });
  } catch {
    return undefined;
  }
}

/** One row of the session's own config, or undefined when it cannot answer. */
export async function sessionConfigRow(
  host: SessionConfigHost,
  sessionId: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    const cli = await host.requireCli();
    const items = await cli.queryItems(
      sessionId,
      "config.list/get",
      {},
      { repo: host.repoFor(sessionId) },
    );
    return items.find(
      (item): item is Record<string, unknown> =>
        Boolean(item) && typeof item === "object" && !Array.isArray(item),
    );
  } catch {
    return undefined;
  }
}

/**
 * Reconciles the session's reported model/thinking/mode after a change.
 *
 * The session-scoped SDK config is the only thing that answers what the session
 * itself runs, so a restored session reports its own model instead of the
 * app-wide default.
 */
export async function refreshSessionSettings(host: SessionConfigHost, sessionId: string): Promise<void> {
  try {
    const row = await sessionConfigRow(host, sessionId);
    if (!row) return;
    const preset =
      typeof row.modelPreset === "string" && row.modelPreset
        ? row.modelPreset
        : undefined;
    const thinking =
      typeof row.thinking === "string" && row.thinking
        ? row.thinking
        : undefined;
    const mode =
      typeof row.mode === "string" && row.mode ? row.mode : undefined;
    // A host that reports the session's service tier here is read too: /fast
    // inverts this value, and guessing the direction is how a scoped fast tier
    // gets silently downgraded.
    const serviceTier =
      typeof row.serviceTier === "string" && row.serviceTier
        ? row.serviceTier
        : undefined;
    if (!preset && !thinking && !mode && !serviceTier) return;
    const current = host.sessions.get(sessionId);
    patchSessionRuntime(host, sessionId, {
      ...(preset ? { model: preset } : {}),
      ...(thinking ? { thinking } : {}),
      ...(mode ? { mode } : {}),
      ...(serviceTier ? { serviceTier } : {}),
    });
    const options = host.sessionConfig.get(sessionId);
    if (options && (preset || thinking || mode)) {
      const updated = options.map((option) => {
        if ((option.category === "model" || option.id === "model") && preset)
          return { ...option, currentValue: preset };
        if (
          (option.category === "thought_level" || option.id === "thinking") &&
          thinking
        )
          return { ...option, currentValue: thinking };
        if ((option.category === "mode" || option.id === "mode") && mode)
          return { ...option, currentValue: mode };
        return option;
      });
      host.sessionConfig.set(sessionId, updated);
      host.emitEvent({ type: "session.config", sessionId, options: updated });
    }
    if (preset && (current?.model !== preset || !current.modelDisplay)) {
      const capabilities = await modelCapabilities(host, sessionId, preset);
      patchSessionRuntime(host, sessionId, {
        modelDisplay:
          capabilities.modelDisplay ??
          host.modelProfiles
            .get(sessionId)
            ?.find((profile) => profile.value === preset)?.name ??
          preset,
      });
    }
  } catch {
    // A session that cannot answer a config query keeps the values it already had.
  }
}

/**
 * Adds the selected model's catalog details (display label, thinking choices).
 *
 * The picker is already open and usable from config/profile reads; this is the
 * slower `models.list/current` follow-up and must not delay it. The selected
 * preset is re-read after the query so a switch made meanwhile cannot wear the
 * previous model's label.
 */
export async function refreshModelCapabilities(host: SessionConfigHost, sessionId: string): Promise<void> {
  const existing = host.sessionConfig.get(sessionId);
  if (!existing || existing.length === 0) return;
  const selectedModel = existing.find(
    (option) => option.category === "model" || option.id === "model",
  )?.currentValue;
  if (typeof selectedModel !== "string") return;
  const capabilities = await modelCapabilities(host, sessionId, selectedModel);
  if (host.disposed || !host.sessions.has(sessionId)) return;
  const current = host.sessionConfig.get(sessionId);
  const stillSelected = current?.find(
    (option) => option.category === "model" || option.id === "model",
  )?.currentValue;
  if (!current || stillSelected !== selectedModel) return;
  const modelDisplay =
    capabilities.modelDisplay ??
    host.modelProfiles
      .get(sessionId)
      ?.find((profile) => profile.value === selectedModel)?.name;
  if (modelDisplay) patchSessionRuntime(host, sessionId, { modelDisplay });
  if (!capabilities.thinkingOptions) return;
  const updated = current.map((option) =>
    option.category === "thought_level" || option.id === "thinking"
      ? { ...option, options: capabilities.thinkingOptions! }
      : option,
  );
  host.sessionConfig.set(sessionId, updated);
  host.emitEvent({ type: "session.config", sessionId, options: updated });
}

async function modelCapabilities(
  host: SessionConfigHost,
  sessionId: string,
  selectedModel: string,
): Promise<{
  thinkingOptions?: AgentConfigOptionValue[];
  modelDisplay?: string;
}> {
  try {
    const cli = await host.requireCli();
    const items = await cli.queryItems(
      sessionId,
      "models.list/current",
      {},
      { repo: host.repoFor(sessionId) },
    );
    return {
      thinkingOptions: thinkingOptionsForModelCatalog(items, selectedModel),
      modelDisplay: profileDefaultModelLabel(items, selectedModel),
    };
  } catch {
    return {};
  }
}

/**
 * Context usage for a session, at most one query in flight per session.
 *
 * Every transcript write asks for this. Several subagents writing at once can
 * otherwise spawn a burst of redundant usage lookups, so a request that arrives
 * while one is running joins it instead of adding another.
 */
export function refreshContextUsage(
  host: SessionConfigHost,
  sessionId: string,
  options?: { force?: boolean },
): Promise<void> {
  const now = Date.now();
  const observedAt = host.contextUsageObservedAt.get(sessionId) ?? 0;
  if (
    !options?.force &&
    now - observedAt < CONTEXT_USAGE_REFRESH_INTERVAL_MS
  )
    return Promise.resolve();
  const inFlight = host.contextUsageQueries.get(sessionId);
  if (inFlight) return inFlight;
  host.contextUsageObservedAt.set(sessionId, now);
  const query = queryContextUsage(host, sessionId).finally(() => {
    host.contextUsageQueries.delete(sessionId);
  });
  host.contextUsageQueries.set(sessionId, query);
  return query;
}

async function queryContextUsage(host: SessionConfigHost, sessionId: string): Promise<void> {
  try {
    const items = await host.querySessionItems(sessionId, "context.get");
    const first = items[0];
    const usage =
      first && typeof first === "object" && !Array.isArray(first)
        ? (first as { usage?: unknown }).usage
        : undefined;
    if (!usage || typeof usage !== "object" || Array.isArray(usage)) return;
    const snapshot = usage as {
      percent?: unknown;
      tokens?: unknown;
      contextWindow?: unknown;
    };
    const percent =
      typeof snapshot.percent === "number"
        ? snapshot.percent
        : typeof snapshot.tokens === "number" &&
            typeof snapshot.contextWindow === "number" &&
            snapshot.contextWindow > 0
          ? (snapshot.tokens / snapshot.contextWindow) * 100
          : undefined;
    if (percent !== undefined) {
      patchSessionRuntime(host, sessionId, {
        usagePercent: Math.min(100, Math.max(0, percent)),
        usagePending: false,
      });
    } else if (snapshot.percent === null || snapshot.tokens === null) {
      patchSessionRuntime(host, sessionId, {
        usagePercent: undefined,
        usagePending: true,
      });
    }
  } catch {
    // Usage is advisory and must not block session attachment or prompting.
  }
}

export function patchSessionRuntime(
  host: SessionConfigHost,
  sessionId: string,
  patch: Partial<
    Pick<
      AgentSession,
      | "phase"
      | "status"
      | "mode"
      | "model"
      | "modelDisplay"
      | "thinking"
      | "serviceTier"
      | "usagePercent"
      | "usagePending"
    >
  >,
): void {
  const session = host.sessions.get(sessionId);
  if (!session) return;
  // A turn re-asserts the same runtime state repeatedly (status already running,
  // unchanged usage percent). Every emit is an IPC broadcast that re-renders the
  // renderer's whole session subtree, so a patch that changes nothing is dropped.
  const changed = Object.entries(patch).some(
    ([key, value]) => session[key as keyof AgentSession] !== value,
  );
  if (!changed) return;
  if (
    Object.hasOwn(patch, "status") &&
    patch.status !== undefined &&
    session.status !== patch.status
  )
    host.advanceRunRevision(sessionId);
  Object.assign(session, patch);
  host.emitEvent({ type: "session.updated", session: { ...session } });
}

export async function setSessionConfig(
  host: SessionConfigHost,
  sessionId: string,
  configId: string,
  value: string,
): Promise<void> {
  if (configId === "thinking") {
    await host.controlSession(sessionId, "thinking.set", { level: value });
    host.explicitSessionThinking.set(sessionId, value);
    patchSessionRuntime(host, sessionId, { thinking: value });
    const existing = host.sessionConfig.get(sessionId);
    if (existing) {
      const updated = existing.map((option) =>
        option.category === "thought_level" || option.id === "thinking"
          ? { ...option, currentValue: value }
          : option,
      );
      host.sessionConfig.set(sessionId, updated);
      host.emitEvent({ type: "session.config", sessionId, options: updated });
    }
    return;
  }
  if (configId === "model") {
    await host.controlSession(sessionId, "model.profile.set", { id: value });
    host.explicitSessionThinking.delete(sessionId);
    const existing = host.sessionConfig.get(sessionId);
    const selected = existing?.find(
      (option) => option.category === "model" || option.id === "model",
    );
    const display =
      selected?.options?.find((option) => option.value === value)?.name ??
      value;
    patchSessionRuntime(host, sessionId, {
      model: value,
      modelDisplay: display,
    });
    if (existing) {
      const updated = existing.map((option) =>
        option.category === "model" || option.id === "model"
          ? { ...option, currentValue: value }
          : option,
      );
      host.sessionConfig.set(sessionId, updated);
      host.emitEvent({ type: "session.config", sessionId, options: updated });
    }
    await refreshSessionSettings(host, sessionId);
    // The profile catalog does not change when one profile is selected; only the
    // selected model's catalog details do. Read those after the receipt instead
    // of making the switch wait on a second profile list.
    void refreshModelCapabilities(host, sessionId);
    return;
  }
  // Any other selector is a session config value; `config.patch` is the control
  // operation that sets one, and the session's own config is re-read after.
  await host.ensureAttached(sessionId, false);
  await host.controlSession(sessionId, "config.patch", {
    patch: { [configId]: value },
  });
  await refreshSessionConfigOptions(host, sessionId);
}

export async function cycleThinking(host: SessionConfigHost, sessionId: string): Promise<string | undefined> {
  const result = await host.controlSession(sessionId, "thinking.cycle", {});
  const level =
    result && typeof result.level === "string" ? result.level : undefined;
  if (!level) return undefined;
  host.explicitSessionThinking.set(sessionId, level);
  patchSessionRuntime(host, sessionId, { thinking: level });
  const existing = host.sessionConfig.get(sessionId);
  if (existing) {
    const updated = existing.map((option) =>
      option.category === "thought_level" || option.id === "thinking"
        ? { ...option, currentValue: level }
        : option,
    );
    host.sessionConfig.set(sessionId, updated);
    host.emitEvent({ type: "session.config", sessionId, options: updated });
  }
  return level;
}
