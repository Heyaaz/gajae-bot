import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type {
  AgentControlPreferences,
  AgentEvent,
  BackendConnection,
} from "../shared/agent-contract.js";
import { GjcSdkCli, type SdkSessionRow } from "./gjc-sdk-cli.js";
import { brokerIndexRevision } from "./gjc-sdk-discovery.js";
import {
  STARTUP_TIMEOUT_MS,
  canonicalWorkspace,
  configuredProfileDefaultThinking,
} from "./gjc-sdk-foundation.js";
import {
  resetForReconnect,
  resetForRuntimeChange,
  type TeardownHost,
} from "./gjc-sdk-teardown.js";
import { runtimeEnvironment } from "./runtime-path.js";

/** The controller members the connection state and the CLI client's startup touch. */
export interface ConnectionHost extends TeardownHost {
  workspace: string;
  configuredExecutable: string | undefined;
  modelPreset: AgentControlPreferences["modelPreset"];
  modelPresetThinking: string | undefined;
  permissionHandling: AgentControlPreferences["permissionHandling"];
  connectionState: BackendConnection;
  generation: number;
  readonly disposed: boolean;
  readonly emitEvent: (event: AgentEvent) => void;
  resolveExecutable(): Promise<string>;
  recoverOwnedSessions(): Promise<void>;
  noteBrokerIndex(
    rows: readonly SdkSessionRow[],
    before: string | undefined,
    after: string | undefined,
  ): void;
}

export async function getConnection(host: ConnectionHost): Promise<BackendConnection> {
  try {
    await ensureStarted(host);
  } catch (error) {
    setConnection(host, {
      state: "error",
      backend: "gjc",
      label: "GJC unavailable",
      detail: error instanceof Error ? error.message : String(error),
      workspace: host.workspace,
      modelPreset: host.modelPreset,
    });
  }
  return { ...host.connectionState };
}

export async function reconfigure(
  host: ConnectionHost,
  preferences: AgentControlPreferences,
): Promise<boolean> {
  const workspace = canonicalWorkspace(preferences.workspace);
  const executable = preferences.gjcExecutable || undefined;
  const runtimeChanged =
    host.configuredExecutable !== executable ||
    host.modelPreset !== preferences.modelPreset ||
    host.permissionHandling !== preferences.permissionHandling;
  host.workspace = workspace;
  host.configuredExecutable = executable;
  host.modelPreset = preferences.modelPreset;
  host.permissionHandling = preferences.permissionHandling;
  if (!runtimeChanged) {
    setConnection(host, { ...host.connectionState, workspace });
    return false;
  }

  resetForRuntimeChange(host);
  await ensureStarted(host);
  return true;
}

export async function reconnect(host: ConnectionHost): Promise<BackendConnection> {
  if (host.disposed) throw new Error("GJC controller is disposed");
  resetForReconnect(host);
  host.generation += 1;
  await ensureStarted(host);
  await host.recoverOwnedSessions();
  return { ...host.connectionState };
}

async function ensureStarted(host: ConnectionHost): Promise<void> {
  if (host.cli) return;
  if (host.startup) return host.startup;
  if (host.disposed) throw new Error("GJC controller is disposed");

  host.startup = start(host).finally(() => {
    host.startup = undefined;
  });
  return host.startup;
}

/**
 * The CLI client, starting it if this is the first use.
 *
 * Replaces the old `requireConnection`: there is no liveness to check because no
 * process is held between calls.
 */
export async function requireCli(host: ConnectionHost): Promise<GjcSdkCli> {
  await ensureStarted(host);
  if (!host.cli) throw new Error("GJC SDK session CLI is unavailable");
  return host.cli;
}

/**
 * Prepares the CLI client.
 *
 * There is nothing to connect to: the broker is started on demand by the CLI
 * itself, and every operation is its own process. "Ready" therefore means the
 * executable resolves and the broker answers a session list -- proof the app can
 * actually reach the runtime, without holding anything open. A runtime crash or
 * upgrade can no longer take the window's connection down with it, because there
 * is no connection to lose.
 */
async function start(host: ConnectionHost): Promise<void> {
  const generation = ++host.generation;
  host.startupSessionRows = undefined;
  host.invalidateBrokerIndexCache();
  setConnection(host, {
    state: "connecting",
    backend: "gjc",
    label: "GJC",
    detail: "Reaching the GJC broker",
    workspace: host.workspace,
    modelPreset: host.modelPreset,
  });
  const executable = await host.resolveExecutable();
  let profileThinking: string | undefined;
  try {
    const modelsFile = path.join(
      path.resolve(
        process.env.GJC_CODING_AGENT_DIR ??
          path.join(homedir(), ".gjc/agent"),
      ),
      "models.yml",
    );
    profileThinking = configuredProfileDefaultThinking(
      await readFile(modelsFile, "utf8"),
      host.modelPreset,
    );
  } catch {
    /* built-in profiles resolve their own defaults */
  }
  host.modelPresetThinking = profileThinking;
  const cli = new GjcSdkCli({
    executable,
    repo: host.workspace,
    env: runtimeEnvironment(),
    timeoutMs: STARTUP_TIMEOUT_MS,
  });
  // The broker index doubles as the reachability check: it fails closed with a
  // typed operational error when the broker cannot be started at all.
  const beforeIndex = await brokerIndexRevision();
  const rows = await cli.listSessions({ scope: "all" });
  const afterIndex = await brokerIndexRevision();
  if (generation !== host.generation || host.disposed) return;
  host.noteBrokerIndex(rows, beforeIndex, afterIndex);
  host.startupSessionRows = rows;
  host.cli = cli;
  host.permissionModeApplied.clear();
  setConnection(host, {
    state: "connected",
    backend: "gjc",
    label: "GJC",
    detail: `SDK session CLI · ${host.modelPreset}`,
    workspace: host.workspace,
    modelPreset: host.modelPreset,
    generation,
  });
  queueMicrotask(() => {
    void host.recoverOwnedSessions();
  });
  // Version is informational. Waiting for it held the first paint behind a
  // second process after the broker had already answered.
  void publishRuntimeVersion(host, cli, generation);
}

async function publishRuntimeVersion(
  host: ConnectionHost,
  cli: GjcSdkCli,
  generation: number,
): Promise<void> {
  const version = await cli.version().catch(() => undefined);
  if (!version || generation !== host.generation || host.disposed) return;
  if (host.connectionState.state !== "connected") return;
  setConnection(host, { ...host.connectionState, version });
}

function setConnection(host: ConnectionHost, connection: BackendConnection): void {
  host.connectionState = connection;
  host.emitEvent({
    type: "connection.updated",
    connection: { ...connection },
  });
}
