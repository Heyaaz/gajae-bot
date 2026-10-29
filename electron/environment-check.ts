import { execFile } from "node:child_process";
import { open, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { BUILT_IN_MODEL_PRESETS } from "../shared/agent-contract.js";
import {
  ENVIRONMENT_MINIMUM_VERSIONS,
  environmentReady,
  type EnvironmentCheckId,
  type EnvironmentCheckRow,
  type EnvironmentProblem,
  type EnvironmentReport,
} from "../shared/environment-check.js";
import { compareGjcVersions } from "../shared/gjc-version.js";
import {
  findExecutable,
  firstExecutable,
  resolveGjcExecutable,
  runtimeEnvironment,
} from "./runtime-path.js";

export type CommandResult =
  | { found: false }
  | { found: true; exitCode: number; stdout: string; stderr: string };

export type CommandRunner = (
  executable: string,
  args: readonly string[],
) => Promise<CommandResult>;

/** Everything a check may look at, injected so tests describe a machine instead of reading this one. */
export interface EnvironmentProbeContext {
  locate(name: string, extraCandidates?: readonly string[]): Promise<string | undefined>;
  locateGjc(): Promise<string | undefined>;
  /** Whether the file starts with `#!`, i.e. needs an interpreter to run. */
  isScript(executable: string): Promise<boolean>;
  run: CommandRunner;
  modelPreset: string;
  /** models.yml text, or undefined when there is none. */
  readModelsFile(): Promise<string | undefined>;
}

interface Finding<P extends EnvironmentProblem> {
  problem?: P;
  detail?: string;
}

/**
 * One row's definition: how to look, and the command that fixes each problem the
 * look can report. Typing `fixes` by the probe's problems means a check cannot
 * report a problem it has no fix for.
 */
interface EnvironmentCheckDefinition<P extends EnvironmentProblem> {
  id: EnvironmentCheckId;
  required: boolean;
  /** When this resolves false the row is left out of the report. */
  applies?(context: EnvironmentProbeContext): Promise<boolean>;
  probe(context: EnvironmentProbeContext): Promise<Finding<P>>;
  fixes: Record<P, string>;
}

export interface EnvironmentCheck {
  id: EnvironmentCheckId;
  check(context: EnvironmentProbeContext): Promise<EnvironmentCheckRow | undefined>;
}

function defineCheck<P extends EnvironmentProblem>(
  definition: EnvironmentCheckDefinition<P>,
): EnvironmentCheck {
  return {
    id: definition.id,
    check: async (context) =>
      definition.applies && !(await definition.applies(context))
        ? undefined
        : row(definition, await definition.probe(context)),
  };
}

function row<P extends EnvironmentProblem>(
  definition: EnvironmentCheckDefinition<P>,
  finding: Finding<P>,
): EnvironmentCheckRow {
  const base = {
    id: definition.id,
    required: definition.required,
    ...(finding.detail ? { detail: finding.detail } : {}),
  };
  if (!finding.problem) return { ...base, status: "ok" };
  return {
    ...base,
    status:
      definition.required && finding.problem === "not-found"
        ? "missing"
        : "warning",
    problem: finding.problem,
    fix: definition.fixes[finding.problem],
  };
}

const VERSION = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/u;
const BUN_INSTALL = "curl -fsSL https://bun.sh/install | bash";
// GJC's own documented install path: a standalone binary in ~/.local/bin. The npm
// package is a source/development channel and is not kept current.
const GJC_INSTALL =
  "curl -fsSL https://raw.githubusercontent.com/Yeachan-Heo/gajae-code/main/scripts/install.sh | sh";
const TAILSCALE_APP_CLI = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";

async function versionFinding(
  context: EnvironmentProbeContext,
  id: EnvironmentCheckId,
  executable: string | undefined,
): Promise<Finding<"not-found" | "too-old" | "unreadable">> {
  if (!executable) return { problem: "not-found" };
  const result = await context.run(executable, ["--version"]);
  if (!result.found) return { problem: "not-found" };
  const version =
    result.exitCode === 0 ? VERSION.exec(result.stdout)?.[0] : undefined;
  if (!version) return { problem: "unreadable", detail: executable };
  const detail = `${version} · ${executable}`;
  const minimum = ENVIRONMENT_MINIMUM_VERSIONS[id];
  if (minimum && compareGjcVersions(version, minimum) < 0)
    return { problem: "too-old", detail };
  return { detail };
}

/** Profile IDs declared under the top-level `profiles:` key of models.yml. */
export function configuredProfileIds(source: string): string[] {
  const ids: string[] = [];
  let inProfiles = false;
  for (const line of source.split("\n")) {
    if (/^\S/u.test(line)) {
      inProfiles = /^profiles:\s*$/u.test(line);
      continue;
    }
    const id = inProfiles ? /^ {2}([^\s#][^:]*):\s*$/u.exec(line)?.[1] : undefined;
    if (id) ids.push(id.trim().replace(/^["']|["']$/gu, ""));
  }
  return ids;
}

export const ENVIRONMENT_CHECKS: readonly EnvironmentCheck[] = [
  defineCheck({
    id: "bun",
    required: true,
    // The release binary embeds its runtime. Only a `#!/usr/bin/env bun` launcher
    // (a Bun global or source install) needs Bun, and a missing GJC is installed
    // as the binary.
    applies: async (context) => {
      const gjc = await context.locateGjc();
      return gjc ? context.isScript(gjc) : false;
    },
    probe: async (context) =>
      versionFinding(context, "bun", await context.locate("bun")),
    fixes: {
      "not-found": BUN_INSTALL,
      "too-old": "bun upgrade",
      unreadable: BUN_INSTALL,
    },
  }),
  defineCheck({
    id: "gjc",
    required: true,
    probe: async (context) =>
      versionFinding(context, "gjc", await context.locateGjc()),
    fixes: {
      "not-found": GJC_INSTALL,
      "too-old": "gjc update",
      unreadable: GJC_INSTALL,
    },
  }),
  defineCheck({
    id: "model-preset",
    // A profile defined somewhere this check cannot see (GJC's signed preset
    // registry) is still valid, so an unrecognized ID is advice, not a blocker.
    required: false,
    probe: async (context): Promise<Finding<"unknown-preset">> => {
      const preset = context.modelPreset;
      const models = await context.readModelsFile();
      if (models && configuredProfileIds(models).includes(preset))
        return { detail: `${preset} · models.yml` };
      if ((BUILT_IN_MODEL_PRESETS as readonly string[]).includes(preset))
        return { detail: preset };
      return { problem: "unknown-preset", detail: preset };
    },
    fixes: { "unknown-preset": "${EDITOR:-nano} ~/.gjc/agent/models.yml" },
  }),
  defineCheck({
    id: "gh",
    required: false,
    probe: async (context): Promise<Finding<"not-found" | "signed-out">> => {
      const gh = await context.locate("gh");
      if (!gh) return { problem: "not-found" };
      const result = await context.run(gh, [
        "auth",
        "status",
        "--hostname",
        "github.com",
      ]);
      if (!result.found) return { problem: "not-found" };
      if (result.exitCode !== 0) return { problem: "signed-out", detail: gh };
      const account = /account (\S+)/u.exec(
        `${result.stdout}\n${result.stderr}`,
      )?.[1];
      return { detail: account ? `github.com · ${account}` : "github.com" };
    },
    fixes: { "not-found": "brew install gh", "signed-out": "gh auth login" },
  }),
  defineCheck({
    id: "tailscale",
    required: false,
    probe: async (context): Promise<Finding<"not-found" | "not-running">> => {
      const tailscale = await context.locate("tailscale", [TAILSCALE_APP_CLI]);
      if (!tailscale) return { problem: "not-found" };
      const result = await context.run(tailscale, ["status", "--json"]);
      if (!result.found) return { problem: "not-found" };
      let state: unknown;
      try {
        state = (JSON.parse(result.stdout) as { BackendState?: unknown })
          .BackendState;
      } catch {
        state = undefined;
      }
      if (state === "Running") return { detail: "Running" };
      return {
        problem: "not-running",
        ...(typeof state === "string" ? { detail: state } : {}),
      };
    },
    fixes: {
      "not-found": "brew install --cask tailscale",
      "not-running": "tailscale up",
    },
  }),
];

/** Looks at the machine and reports each check. It never installs or changes anything. */
export async function checkEnvironment(
  context: EnvironmentProbeContext,
  now: () => number = Date.now,
): Promise<EnvironmentReport> {
  const rows = (
    await Promise.all(
      ENVIRONMENT_CHECKS.map((definition) => definition.check(context)),
    )
  ).filter((row): row is EnvironmentCheckRow => row !== undefined);
  return { rows, ready: environmentReady(rows), checkedAtMs: now() };
}

/**
 * Runs a command with the PATH a Finder launch gets, so the check finds the same
 * binaries the app itself will run.
 */
export const runCommand: CommandRunner = (executable, args) =>
  new Promise((resolve) => {
    const child = execFile(
      executable,
      [...args],
      {
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
        env: runtimeEnvironment(),
      },
      (error, stdout, stderr) => {
        if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") {
          resolve({ found: false });
          return;
        }
        const code = (error as { code?: unknown } | null)?.code;
        resolve({
          found: true,
          exitCode: !error ? 0 : typeof code === "number" ? code : -1,
          stdout: String(stdout),
          stderr: String(stderr),
        });
      },
    );
    // A probe that waits on stdin would hang until the timeout instead of failing.
    child.stdin?.end();
  });

export async function isScript(executable: string): Promise<boolean> {
  const handle = await open(executable, "r").catch(() => undefined);
  if (!handle) return false;
  try {
    const head = Buffer.alloc(2);
    const { bytesRead } = await handle.read(head, 0, 2, 0);
    return bytesRead === 2 && head.toString("latin1") === "#!";
  } finally {
    await handle.close();
  }
}

export function hostEnvironmentContext(settings: {
  gjcExecutable: string | undefined;
  modelPreset: string;
}): EnvironmentProbeContext {
  return {
    locate: async (name, extraCandidates = []) =>
      (await findExecutable(name)) ?? (await firstExecutable(extraCandidates)),
    locateGjc: () => resolveGjcExecutable(settings.gjcExecutable),
    isScript,
    run: runCommand,
    modelPreset: settings.modelPreset,
    readModelsFile: () =>
      readFile(
        path.join(
          path.resolve(
            process.env.GJC_CODING_AGENT_DIR ?? path.join(homedir(), ".gjc/agent"),
          ),
          "models.yml",
        ),
        "utf8",
      ).catch(() => undefined),
  };
}
