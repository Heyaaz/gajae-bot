import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { REMOTE_DEFAULT_PORT, parseRemotePort } from "../../shared/remote-protocol.js";

/**
 * Remote access settings live in their own file rather than in the renderer's
 * preferences record: the desktop settings dialog round-trips the whole
 * preferences object, and a host-side security switch should not be something
 * that object can silently drop.
 */

export interface RemoteSettings {
  enabled: boolean;
  port: number;
}

export function parseRemoteSettings(value: unknown): RemoteSettings {
  const candidate = value && typeof value === "object" ? (value as Partial<RemoteSettings>) : {};
  return {
    enabled: candidate.enabled === true,
    port: parseRemotePort(candidate.port) ?? REMOTE_DEFAULT_PORT,
  };
}

export class RemoteSettingsStore {
  private readonly filePath: string;
  private settings: RemoteSettings;

  constructor(directory: string) {
    this.filePath = path.join(directory, "remote-access.json");
    this.settings = this.read();
  }

  get(): RemoteSettings {
    return { ...this.settings };
  }

  save(value: unknown): RemoteSettings {
    this.settings = parseRemoteSettings(value);
    this.persist();
    return this.get();
  }

  private persist(): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(this.settings, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporaryPath, this.filePath);
  }

  private read(): RemoteSettings {
    try {
      return parseRemoteSettings(JSON.parse(readFileSync(this.filePath, "utf8")));
    } catch {
      return parseRemoteSettings(undefined);
    }
  }
}
