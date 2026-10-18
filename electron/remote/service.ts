import { existsSync } from "node:fs";
import path from "node:path";
import type { AgentEvent } from "../../shared/agent-contract.js";
import {
  parseRemotePort,
  type RemoteAccessState,
  type RemotePermission,
  type TailscaleSummary,
} from "../../shared/remote-protocol.js";
import { DeviceStore } from "./devices.js";
import type { RemoteOperationsHost } from "./operations.js";
import { RemoteServer } from "./server.js";
import { RemoteSettingsStore } from "./settings.js";
import { TailscaleClient } from "./tailscale.js";

/**
 * Owns the lifetime of the remote access server: settings, the device registry,
 * Tailscale Serve, and the event fan-out.
 *
 * The desktop app calls into this from its own process; nothing here imports
 * Electron, so the whole host side can run and be tested under plain Node.
 */

export interface RemoteAccessServiceOptions {
  userDataDirectory: string;
  webRoot: string;
  version: string;
  workspace: () => string;
  host: RemoteOperationsHost;
  settings?: RemoteSettingsStore;
  devices?: DeviceStore;
  tailscale?: TailscaleClient;
  log?: (message: string) => void;
}

const UNKNOWN_TAILSCALE: TailscaleSummary = {
  installed: false,
  connected: false,
  serveEnabled: false,
};

/** How long a read owner login stays good enough to admit a request. */
const IDENTITY_TTL_MS = 30_000;

export class RemoteAccessService {
  private applying: Promise<void> = Promise.resolve();
  private disposed = false;
  private readonly settings: RemoteSettingsStore;
  private readonly devices: DeviceStore;
  private readonly tailscale: TailscaleClient;
  private readonly log: (message: string) => void;
  private readonly webRoot: string;
  private server?: RemoteServer;
  private serveManagedByApp = false;
  private lastError = "";
  private lastTailscale = UNKNOWN_TAILSCALE;
  private identityCache?: { at: number; login?: string };
  private starting?: Promise<void>;

  constructor(private readonly options: RemoteAccessServiceOptions) {
    this.settings = options.settings ?? new RemoteSettingsStore(options.userDataDirectory);
    this.devices =
      options.devices ?? new DeviceStore(path.join(options.userDataDirectory, "remote-devices.json"));
    this.tailscale = options.tailscale ?? new TailscaleClient();
    this.log = options.log ?? (() => undefined);
    this.webRoot = options.webRoot;
    this.devices.subscribe((change) => {
      if (change.type === "revoked") this.server?.closeDeviceStreams(change.deviceId);
      if (change.type === "revoked" || change.type === "removed")
        this.log(`remote device access removed: ${change.deviceId}`);
    });
  }

  get deviceStore(): DeviceStore {
    return this.devices;
  }

  /** Applies persisted settings. Called once the app is ready. */
  start(): Promise<void> {
    this.starting ??= this.apply().catch((error: unknown) => {
      this.lastError = describe(error);
      this.log(`remote access failed to start: ${this.lastError}`);
    });
    return this.starting;
  }

  async state(): Promise<RemoteAccessState> {
    await this.start();
    this.lastTailscale = await this.tailscale.summary(this.settings.get().port).catch(() => ({
      ...UNKNOWN_TAILSCALE,
      detail: "Tailscale 상태를 확인하지 못했습니다.",
    }));
    const settings = this.settings.get();
    const missingClient =
      settings.enabled && !existsSync(path.join(this.webRoot, "index.web.html"))
        ? "원격 웹 클라이언트가 아직 빌드되지 않았습니다 (npm run build:web)."
        : "";
    const error = missingClient || this.lastError;
    const baseUrl = this.baseUrl();
    return {
      enabled: settings.enabled,
      running: this.server?.running ?? false,
      port: this.server?.address.port ?? settings.port,
      ...(baseUrl ? { baseUrl } : {}),
      tailscale: this.lastTailscale,
      devices: this.devices.list(),
      pairing: this.devices.currentPairing(),
      ...(error ? { error } : {}),
    };
  }

  private baseUrl(): string | undefined {
    if (this.lastTailscale.serveOrigin && this.lastTailscale.serveEnabled)
      return `${this.lastTailscale.serveOrigin}/`;
    if (this.lastTailscale.dnsName) return `https://${this.lastTailscale.dnsName}/`;
    return undefined;
  }

  async setEnabled(enabled: boolean): Promise<RemoteAccessState> {
    const previous = this.settings.get();
    if (previous.enabled === enabled) return this.state();
    this.settings.save({ ...previous, enabled });
    await this.apply();
    return this.state();
  }

  async setPort(port: number): Promise<RemoteAccessState> {
    const parsed = parseRemotePort(port);
    if (parsed === undefined) throw new Error("Port must be between 1024 and 65535");
    const previous = this.settings.get();
    if (previous.port === parsed) return this.state();
    this.settings.save({ ...previous, port: parsed });
    await this.apply();
    return this.state();
  }

  async issuePairingCode(permission: RemotePermission): Promise<RemoteAccessState> {
    const settings = this.settings.get();
    if (!settings.enabled) throw new Error("Turn remote access on first");
    this.devices.issuePairingCode(permission);
    return this.state();
  }

  async clearPairingCode(): Promise<RemoteAccessState> {
    this.devices.clearPairingCode();
    return this.state();
  }

  async setDevicePermission(
    deviceId: string,
    permission: RemotePermission,
  ): Promise<RemoteAccessState> {
    this.devices.setPermission(deviceId, permission);
    return this.state();
  }

  async revokeDevice(deviceId: string): Promise<RemoteAccessState> {
    this.devices.revoke(deviceId);
    return this.state();
  }

  async forgetDevice(deviceId: string): Promise<RemoteAccessState> {
    this.devices.remove(deviceId);
    return this.state();
  }

  publish(event: AgentEvent): void {
    this.server?.publish(event);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.applying.catch(() => undefined);
    await this.server?.stop();
    this.server = undefined;
  }

  /**
   * Serializes settings transitions.
   *
   * Starting a listener and disabling remote access are both asynchronous, and
   * running them side by side let a slow start assign its server after the stop
   * had already found nothing to stop. Each apply reads the settings when it runs,
   * so a queued disable always sees the latest desired state.
   */
  private apply(): Promise<void> {
    const run = (): Promise<void> => this.applyNow();
    const next = this.applying.then(run, run);
    this.applying = next.catch(() => undefined);
    return next;
  }

  private async applyNow(): Promise<void> {
    const settings = this.settings.get();
    if (this.disposed || !settings.enabled) {
      await this.server?.stop();
      this.server = undefined;
      if (this.serveManagedByApp) {
        const entries = await this.tailscale.serveEntries().catch(() => []);
        await this.tailscale
          .disableServe(settings.port, entries)
          .then((result) => {
            if (result.code === 0) {
              this.serveManagedByApp = false;
              this.log("tailscale serve mapping removed");
            } else this.log(`tailscale serve was left in place: ${result.stderr.trim()}`);
          })
          .catch(() => undefined);
      }
      this.lastError = "";
      return;
    }
    await this.ensureServer(settings.port);
    if (!this.lastError) await this.ensureServe(settings.port);
  }

  /**
   * The owner login Serve stamps on a request from one of the owner's devices.
   *
   * Re-read at most every 30s: `tailscale status` spawns a process, and a phone
   * reconnecting must not pay for one per request. An answer that cannot be read
   * closes identity access rather than leaving the last one open.
   */
  private async ownerIdentity(): Promise<{ login: string } | undefined> {
    const now = Date.now();
    if (this.identityCache && now - this.identityCache.at < IDENTITY_TTL_MS) {
      return this.identityCache.login ? { login: this.identityCache.login } : undefined;
    }
    const identity = await this.tailscale.identity().catch(() => undefined);
    this.identityCache = { at: now, ...(identity ? { login: identity.login } : {}) };
    return identity;
  }

  private async ensureServer(port: number): Promise<void> {
    const desired = this.settings.get();
    if (this.disposed || !desired.enabled || desired.port !== port) return;
    if (this.server?.running && this.server.address.port === port) return;
    await this.server?.stop();
    const server = new RemoteServer({
      webRoot: this.webRoot,
      version: this.options.version,
      workspace: this.options.workspace(),
      devices: this.devices,
      host: this.options.host,
      port,
      allowedHosts: () => this.allowedHosts(),
      allowedOrigins: () => this.allowedOrigins(port),
      identity: () => this.ownerIdentity(),
      log: this.log,
    });
    try {
      await server.start();
      // The user may have disabled remote access (or moved the port) while the
      // listener was starting. Publishing it then would leave the listener alive
      // under a disabled setting, so a stale start stops itself.
      const latest = this.settings.get();
      if (this.disposed || !latest.enabled || latest.port !== port) {
        await server.stop().catch(() => undefined);
        return;
      }
      this.server = server;
      this.lastError = "";
      this.log(`remote access server listening on 127.0.0.1:${server.address.port}`);
    } catch (error) {
      this.server = undefined;
      this.lastError = describe(error);
      this.log(`remote access server failed to start: ${this.lastError}`);
    }
  }

  private async ensureServe(port: number): Promise<void> {
    const summary = await this.tailscale.summary(port).catch(() => undefined);
    if (summary) this.lastTailscale = summary;
    if (!summary?.installed || !summary.connected) return;
    if (summary.serveEnabled) return;
    const beforeEnable = this.settings.get();
    if (this.disposed || !beforeEnable.enabled || beforeEnable.port !== port) return;
    const result = await this.tailscale.enableServe(port).catch(() => undefined);
    if (!result) return;
    if (result.code === 0) {
      this.serveManagedByApp = true;
      const latest = this.settings.get();
      if (this.disposed || !latest.enabled || latest.port !== port) {
        const entries = await this.tailscale.serveEntries().catch(() => []);
        await this.tailscale.disableServe(port, entries).catch(() => undefined);
        this.serveManagedByApp = false;
        return;
      }
      this.log(`tailscale serve mapped https://${summary.dnsName ?? "this machine"}/ to 127.0.0.1:${port}`);
      this.lastTailscale = await this.tailscale.summary(port).catch(() => summary);
    } else {
      this.lastError = result.stderr.trim() || "Tailscale Serve 설정에 실패했습니다.";
    }
  }

  private allowedHosts(): string[] {
    const hosts = ["127.0.0.1", "localhost", "::1"];
    if (this.lastTailscale.dnsName) hosts.push(this.lastTailscale.dnsName.toLowerCase());
    return hosts;
  }

  private allowedOrigins(port: number): string[] {
    const origins = [
      `http://127.0.0.1:${port}`,
      `http://localhost:${port}`,
      `http://[::1]:${port}`,
    ];
    if (this.lastTailscale.dnsName) origins.push(`https://${this.lastTailscale.dnsName}`);
    return origins;
  }
}

function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim() || "Unknown failure";
}
