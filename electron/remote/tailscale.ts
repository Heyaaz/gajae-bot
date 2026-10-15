import { execFile } from "node:child_process";
import type { TailscaleSummary } from "../../shared/remote-protocol.js";

/**
 * Tailscale detection and Serve wiring.
 *
 * The HTTP server only ever listens on loopback. Reaching it from a phone means
 * Tailscale Serve proxies `https://<machine>.<tailnet>.ts.net/` to that loopback
 * port, so the checks here answer three separate questions the settings panel
 * shows separately: is Tailscale installed, is this machine connected to the
 * tailnet, and does a Serve mapping point at our port.
 *
 * `tailscale serve reset` wipes *every* serve mapping on the machine, including
 * ones the owner set up for other services. Turning our mapping off therefore
 * refuses to touch anything but a configuration we can prove is only ours.
 */

export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

export type CommandRunner = (file: string, args: string[]) => Promise<CommandResult>;

export const SERVING_PORT = 443;

export const defaultCommandRunner: CommandRunner = (file, args) =>
  new Promise<CommandResult>((resolve) => {
    execFile(
      file,
      args,
      { timeout: 10_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as { code?: unknown }).code === "number"
            ? ((error as { code: number }).code as number)
            : error
              ? 1
              : 0;
        resolve({ stdout: stdout ?? "", stderr: stderr ?? "", code });
      },
    );
  });

export interface ServeEntry {
  origin: string;
  path: string;
  proxy: string;
}

/** `tailscale serve status --json` is a tree of hosts, paths, and proxies. */
export function parseServeStatus(value: unknown): ServeEntry[] {
  if (!value || typeof value !== "object") return [];
  const web = (value as { Web?: unknown }).Web;
  if (!web || typeof web !== "object") return [];
  const entries: ServeEntry[] = [];
  for (const [origin, hostConfig] of Object.entries(web as Record<string, unknown>)) {
    const handlers =
      hostConfig && typeof hostConfig === "object"
        ? ((hostConfig as { Handlers?: unknown }).Handlers as Record<string, unknown> | undefined)
        : undefined;
    if (!handlers || typeof handlers !== "object") continue;
    for (const [path, handler] of Object.entries(handlers)) {
      const proxy =
        handler && typeof handler === "object" ? (handler as { Proxy?: unknown }).Proxy : undefined;
      entries.push({
        origin,
        path,
        proxy: typeof proxy === "string" ? proxy : "",
      });
    }
  }
  return entries;
}

export interface TailscaleStatusFields {
  backendState?: string;
  dnsName?: string;
  ipv4?: string;
  version?: string;
}

/** `tailscale status --json`, reduced to the fields the panel reports. */
export function parseTailscaleStatus(value: unknown): TailscaleStatusFields {
  if (!value || typeof value !== "object") return {};
  const root = value as {
    BackendState?: unknown;
    Version?: unknown;
    Self?: { DNSName?: unknown; TailscaleIPs?: unknown };
  };
  const addresses = Array.isArray(root.Self?.TailscaleIPs)
    ? root.Self?.TailscaleIPs.filter((entry): entry is string => typeof entry === "string")
    : [];
  const ipv4 = addresses.find((address) => /^\d+\.\d+\.\d+\.\d+$/u.test(address));
  const dnsName =
    typeof root.Self?.DNSName === "string" ? root.Self.DNSName.replace(/\.$/u, "") : undefined;
  return {
    ...(typeof root.BackendState === "string" ? { backendState: root.BackendState } : {}),
    ...(dnsName ? { dnsName } : {}),
    ...(ipv4 ? { ipv4 } : {}),
    ...(typeof root.Version === "string" ? { version: root.Version } : {}),
  };
}

export function serveTargetFor(port: number): string {
  return `http://127.0.0.1:${port}`;
}

/** True when a Serve mapping already proxies the loopback port we serve on. */
export function servingPort(entries: ServeEntry[], port: number): ServeEntry | undefined {
  const target = serveTargetFor(port);
  return entries.find((entry) => entry.proxy.replace(/\/$/u, "") === target);
}

export class TailscaleClient {
  private readonly runner: CommandRunner;
  private readonly binary: string;

  constructor(options: { runner?: CommandRunner; binary?: string } = {}) {
    this.runner = options.runner ?? defaultCommandRunner;
    this.binary = options.binary ?? "tailscale";
  }

  private async run(args: string[]): Promise<CommandResult> {
    return this.runner(this.binary, args);
  }

  private async runJson(args: string[]): Promise<unknown | undefined> {
    const result = await this.run(args);
    if (result.code !== 0) return undefined;
    try {
      return JSON.parse(result.stdout) as unknown;
    } catch {
      return undefined;
    }
  }

  async summary(port: number): Promise<TailscaleSummary> {
    const version = await this.run(["version"]);
    if (version.code !== 0) {
      const missing = /ENOENT|not found|no such file/iu.test(version.stderr);
      return {
        installed: false,
        connected: false,
        serveEnabled: false,
        detail: missing
          ? "Tailscale이 설치되어 있지 않습니다."
          : version.stderr.trim() || "Tailscale 상태를 확인할 수 없습니다.",
      };
    }
    const versionText = version.stdout.split("\n")[0]?.trim();
    const status = parseTailscaleStatus(await this.runJson(["status", "--json"]));
    const connected = status.backendState === "Running";
    const serve = parseServeStatus(await this.runJson(["serve", "status", "--json"]));
    const mapping = servingPort(serve, port);
    return {
      installed: true,
      connected,
      ...(status.backendState ? { backendState: status.backendState } : {}),
      ...(status.dnsName ? { dnsName: status.dnsName } : {}),
      ...(status.ipv4 ? { ipv4: status.ipv4 } : {}),
      ...(versionText ? { version: versionText } : {}),
      serveEnabled: Boolean(mapping),
      ...(mapping ? { serveTarget: mapping.proxy, serveOrigin: `https://${mapping.origin.split(":")[0]}` } : {}),
      ...(connected
        ? {}
        : {
            detail: status.backendState
              ? `Tailscale이 연결되어 있지 않습니다 (${status.backendState}).`
              : "Tailscale 상태를 읽을 수 없습니다.",
          }),
    };
  }

  async enableServe(port: number): Promise<CommandResult> {
    return this.run([
      "serve",
      "--bg",
      `--https=${SERVING_PORT}`,
      serveTargetFor(port),
    ]);
  }

  async disableServe(port: number, entries: ServeEntry[]): Promise<CommandResult> {
    const ours = serveTargetFor(port);
    const foreign = entries.filter((entry) => entry.proxy.replace(/\/$/u, "") !== ours);
    if (foreign.length) {
      return {
        stdout: "",
        code: 1,
        stderr: "다른 Serve 설정이 함께 있어 자동으로 해제하지 않았습니다.",
      };
    }
    const removed = await this.run(["serve", `--https=${SERVING_PORT}`, "off"]);
    if (removed.code === 0) return removed;
    // Older builds have no per-port switch; reset is safe here because the parse
    // above proved the whole serve config is this one mapping.
    return this.run(["serve", "reset"]);
  }

  async serveEntries(): Promise<ServeEntry[]> {
    return parseServeStatus(await this.runJson(["serve", "status", "--json"]));
  }
}
