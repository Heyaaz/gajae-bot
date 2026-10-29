import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { EnvironmentCheckRow } from "../shared/environment-check.js";
import {
  checkEnvironment,
  configuredProfileIds,
  isScript,
  runCommand,
  type CommandResult,
  type EnvironmentProbeContext,
} from "./environment-check.js";
import { DesktopStateStore } from "./desktop-state-store.js";
import { findExecutable, resolveGjcExecutable } from "./runtime-path.js";

/** A machine described as executables, their command answers and files. */
interface Machine {
  executables: Record<string, string>;
  answers: Record<string, CommandResult>;
  /** Executables that are `#!` launchers rather than binaries. */
  scripts?: string[];
  modelPreset?: string;
  modelsFile?: string;
}

function context(machine: Machine): EnvironmentProbeContext {
  return {
    locate: async (name, extra = []) =>
      machine.executables[name] ??
      extra.find((candidate) => Object.values(machine.executables).includes(candidate)),
    locateGjc: async () => machine.executables.gjc,
    isScript: async (executable) => machine.scripts?.includes(executable) ?? false,
    run: async (executable, args) =>
      machine.answers[`${executable} ${args.join(" ")}`] ?? { found: false },
    modelPreset: machine.modelPreset ?? "codex-medium",
    readModelsFile: async () => machine.modelsFile,
  };
}

const ok = (stdout: string, stderr = ""): CommandResult => ({
  found: true,
  exitCode: 0,
  stdout,
  stderr,
});
const failed = (exitCode: number, stderr = ""): CommandResult => ({
  found: true,
  exitCode,
  stdout: "",
  stderr,
});

const INSTALL_GJC =
  "curl -fsSL https://raw.githubusercontent.com/Yeachan-Heo/gajae-code/main/scripts/install.sh | sh";

const ready: Machine = {
  executables: {
    bun: "/Users/me/.bun/bin/bun",
    gjc: "/Users/me/.local/bin/gjc",
    gh: "/opt/homebrew/bin/gh",
    tailscale: "/opt/homebrew/bin/tailscale",
  },
  answers: {
    "/Users/me/.bun/bin/bun --version": ok("1.4.0\n"),
    "/Users/me/.local/bin/gjc --version": ok("gjc/0.19.0\n"),
    "/opt/homebrew/bin/gh auth status --hostname github.com": ok(
      "",
      "github.com\n  ✓ Logged in to github.com account octo (keyring)\n",
    ),
    "/opt/homebrew/bin/tailscale status --json": ok(
      JSON.stringify({ BackendState: "Running" }),
    ),
  },
};

async function rows(machine: Machine): Promise<Record<string, EnvironmentCheckRow>> {
  const report = await checkEnvironment(context(machine), () => 7);
  return Object.fromEntries(report.rows.map((row) => [row.id, row]));
}

describe("checkEnvironment", () => {
  it("reports a prepared Mac as ready, with what it found", async () => {
    const report = await checkEnvironment(context(ready), () => 7);
    expect(report.ready).toBe(true);
    expect(report.checkedAtMs).toBe(7);
    expect(report.rows.map((row) => [row.id, row.status, row.detail])).toEqual([
      ["gjc", "ok", "0.19.0 · /Users/me/.local/bin/gjc"],
      ["model-preset", "ok", "codex-medium"],
      ["gh", "ok", "github.com · octo"],
      ["tailscale", "ok", "Running"],
    ]);
  });

  it("asks for Bun only when GJC is a launcher script that runs on it", async () => {
    const found = await rows({ ...ready, scripts: ["/Users/me/.local/bin/gjc"] });
    expect(found.bun).toMatchObject({
      status: "ok",
      required: true,
      detail: "1.4.0 · /Users/me/.bun/bin/bun",
    });
  });

  it("names exactly what a clean Mac is missing, with the command for each", async () => {
    const report = await checkEnvironment(
      context({ executables: {}, answers: {} }),
    );
    expect(report.ready).toBe(false);
    expect(
      report.rows.map((row) =>
        row.status === "ok"
          ? [row.id, row.status]
          : [row.id, row.status, row.problem, row.fix],
      ),
    ).toEqual([
      ["gjc", "missing", "not-found", INSTALL_GJC],
      ["model-preset", "ok"],
      ["gh", "warning", "not-found", "brew install gh"],
      ["tailscale", "warning", "not-found", "brew install --cask tailscale"],
    ]);
  });

  it("holds GJC and bun to their minimum versions", async () => {
    const found = await rows({
      ...ready,
      scripts: ["/Users/me/.local/bin/gjc"],
      answers: {
        ...ready.answers,
        "/Users/me/.bun/bin/bun --version": ok("1.3.9\n"),
        "/Users/me/.local/bin/gjc --version": ok("gjc/0.18.11\n"),
      },
    });
    expect(found.bun).toMatchObject({ status: "warning", problem: "too-old", fix: "bun upgrade" });
    expect(found.gjc).toMatchObject({
      status: "warning",
      problem: "too-old",
      detail: "0.18.11 · /Users/me/.local/bin/gjc",
      fix: "gjc update",
    });
  });

  it("says a GJC that cannot run is unreadable, not absent", async () => {
    // The launcher is `#!/usr/bin/env bun`, so without bun it exits 127.
    const found = await rows({
      ...ready,
      scripts: ["/Users/me/.local/bin/gjc"],
      executables: { ...ready.executables, bun: "" },
      answers: {
        ...ready.answers,
        "/Users/me/.local/bin/gjc --version": failed(127, "env: bun: No such file or directory"),
      },
    });
    expect(found.bun).toMatchObject({ status: "missing" });
    expect(found.gjc).toMatchObject({
      status: "warning",
      problem: "unreadable",
      detail: "/Users/me/.local/bin/gjc",
    });
  });

  it("accepts a profile from models.yml and flags an unknown one without blocking", async () => {
    const modelsFile = [
      "providers:",
      "  local-proxy:",
      "    baseUrl: http://127.0.0.1:9091/v1",
      "profiles:",
      "  goat:",
      "    model_mapping:",
      "      default: ocx/gpt:medium",
    ].join("\n");
    const custom = await checkEnvironment(context({ ...ready, modelPreset: "goat", modelsFile }));
    expect(custom.rows.find((row) => row.id === "model-preset")).toMatchObject({
      status: "ok",
      detail: "goat · models.yml",
    });
    const unknown = await checkEnvironment(
      context({ ...ready, modelPreset: "local-proxy", modelsFile }),
    );
    expect(unknown.ready).toBe(true);
    expect(unknown.rows.find((row) => row.id === "model-preset")).toMatchObject({
      status: "warning",
      problem: "unknown-preset",
      detail: "local-proxy",
    });
  });

  it("knows the profile first-run setup picked for a provider", async () => {
    const found = await rows({ ...ready, modelPreset: "claude-opus" });
    expect(found["model-preset"]).toMatchObject({ status: "ok", detail: "claude-opus" });
  });

  it("keeps gh and tailscale optional when they are not ready", async () => {
    const report = await checkEnvironment(
      context({
        executables: {
          ...ready.executables,
          tailscale: "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
        },
        answers: {
          ...ready.answers,
          "/opt/homebrew/bin/gh auth status --hostname github.com": failed(
            1,
            "You are not logged into any GitHub hosts.",
          ),
          "/Applications/Tailscale.app/Contents/MacOS/Tailscale status --json": ok(
            JSON.stringify({ BackendState: "Stopped" }),
          ),
        },
      }),
    );
    expect(report.ready).toBe(true);
    const found = Object.fromEntries(report.rows.map((row) => [row.id, row]));
    expect(found.gh).toMatchObject({ status: "warning", problem: "signed-out", fix: "gh auth login" });
    expect(found.tailscale).toMatchObject({
      status: "warning",
      problem: "not-running",
      detail: "Stopped",
      fix: "tailscale up",
    });
  });
});

describe("configuredProfileIds", () => {
  it("reads only the keys under the top-level profiles section", () => {
    expect(
      configuredProfileIds(
        ["providers:", "  codex-lb:", "profiles:", '  "dusk":', "    display_name: dusk", "  goat:", "other:", "  x:"].join("\n"),
      ),
    ).toEqual(["dusk", "goat"]);
  });
});

describe("host lookups", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "gajae-env-"));
  const tool = path.join(directory, "gajae-env-tool");
  writeFileSync(tool, "#!/bin/sh\necho 1.2.3\n");
  chmodSync(tool, 0o755);

  it("finds an executable on the runtime PATH and prefers a configured GJC", async () => {
    await expect(findExecutable("gajae-env-tool", directory)).resolves.toBe(tool);
    await expect(findExecutable("gajae-env-absent", directory)).resolves.toBeUndefined();
    await expect(resolveGjcExecutable(tool)).resolves.toBe(tool);
  });

  it("tells a launcher script from a binary by its first bytes", async () => {
    const binary = path.join(directory, "gajae-env-binary");
    writeFileSync(binary, Buffer.from([0xcf, 0xfa, 0xed, 0xfe]));
    await expect(isScript(tool)).resolves.toBe(true);
    await expect(isScript(binary)).resolves.toBe(false);
    await expect(isScript(path.join(directory, "absent"))).resolves.toBe(false);
  });

  it("tells an absent command from one that failed, and never waits on stdin", async () => {
    await expect(runCommand(path.join(directory, "absent"), [])).resolves.toEqual({ found: false });
    await expect(runCommand("/bin/sh", ["-c", "echo out; exit 3"])).resolves.toMatchObject({
      found: true,
      exitCode: 3,
      stdout: "out\n",
    });
    await expect(runCommand("/bin/cat", [])).resolves.toMatchObject({ found: true, exitCode: 0 });
  });

  it("remembers a passed check across launches", () => {
    const userData = mkdtempSync(path.join(tmpdir(), "gajae-env-state-"));
    expect(new DesktopStateStore(userData).get().environmentReady).toBeUndefined();
    new DesktopStateStore(userData).update({ environmentReady: true });
    expect(new DesktopStateStore(userData).get()).toEqual({ environmentReady: true });
  });
});
