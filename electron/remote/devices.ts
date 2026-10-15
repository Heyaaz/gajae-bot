import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type {
  RemoteDeviceSummary,
  RemotePairingSummary,
  RemotePermission,
} from "../../shared/remote-protocol.js";

/**
 * Paired devices, their tokens, and the one-time pairing codes that create them.
 *
 * A device token is the only credential a phone holds. The host never stores the
 * token itself: it stores `HMAC(secret, token)` with a per-install secret kept in
 * the same owner-only file, so reading the file does not hand out a working
 * credential and verification stays constant-time.
 *
 * Pairing codes live in memory only. A code that was never used must not survive a
 * restart, and a used one must not be reusable.
 */

export const DEVICE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

const MAX_DEVICES = 24;
const PAIRING_TTL_MS = 5 * 60 * 1000;
const PAIRING_ATTEMPT_WINDOW_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS_PER_ADDRESS = 8;
const MAX_ATTEMPTS_TOTAL = 40;
const LAST_SEEN_PERSIST_INTERVAL_MS = 30_000;
// No 0/O/1/I/L: a code read off a screen and typed on a phone should have no
// ambiguous characters.
const PAIRING_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const PAIRING_LENGTH = 8;

export function createDeviceToken(): string {
  return randomBytes(32).toString("base64url");
}

export function pairingCodeFor(bytes: Uint8Array): string {
  let code = "";
  for (let index = 0; index < PAIRING_LENGTH; index += 1) {
    code += PAIRING_ALPHABET[bytes[index] % PAIRING_ALPHABET.length];
  }
  return code;
}

/** Accepts what a person types: lowercase, spaces, and dashes are all the same code. */
export function normalizePairingCode(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/[\s-]/gu, "").toUpperCase();
}

export interface DeviceRecord {
  id: string;
  name: string;
  permission: RemotePermission;
  createdAt: string;
  lastSeenAt?: string;
  clientAddress?: string;
  tokenHash: string;
}

export interface DeviceChange {
  type: "added" | "permission" | "revoked" | "removed" | "seen";
  deviceId: string;
  permission?: RemotePermission;
}

interface DeviceFile {
  version: 1;
  secret: string;
  devices: DeviceRecord[];
}

export type PairingFailure = "unknown" | "expired" | "rate-limited";

interface PendingPairing {
  code: string;
  permission: RemotePermission;
  expiresAt: number;
  attempts: number;
}

export function validDeviceName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.trim().length <= 60 &&
    !/[\p{Cc}\p{Cf}]/u.test(value)
  );
}

export class DeviceStore {
  private readonly filePath: string;
  private readonly now: () => number;
  private secret = "";
  private devices: DeviceRecord[] = [];
  private pending: PendingPairing | null = null;
  private attempts = new Map<string, number[]>();
  private pendingLastSeen = new Set<string>();
  private listeners = new Set<(change: DeviceChange) => void>();

  constructor(filePath: string, options: { now?: () => number } = {}) {
    this.filePath = filePath;
    this.now = options.now ?? (() => Date.now());
    this.load();
  }

  subscribe(listener: (change: DeviceChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(change: DeviceChange): void {
    for (const listener of this.listeners) listener(change);
  }

  list(): RemoteDeviceSummary[] {
    return this.devices.map((device) => ({
      id: device.id,
      name: device.name,
      permission: device.permission,
      createdAt: device.createdAt,
      ...(device.lastSeenAt ? { lastSeenAt: device.lastSeenAt } : {}),
      ...(device.clientAddress ? { clientAddress: device.clientAddress } : {}),
    }));
  }

  get(deviceId: string): DeviceRecord | undefined {
    return this.devices.find((device) => device.id === deviceId);
  }

  add(input: {
    name: string;
    permission: RemotePermission;
    clientAddress?: string;
  }): { device: RemoteDeviceSummary; token: string } {
    if (!validDeviceName(input.name)) throw new Error("Device name is invalid");
    if (this.devices.length >= MAX_DEVICES)
      throw new Error("Too many paired devices; remove one first");
    const token = createDeviceToken();
    const record: DeviceRecord = {
      id: randomUUID(),
      name: input.name.trim(),
      permission: input.permission,
      createdAt: new Date(this.now()).toISOString(),
      ...(input.clientAddress ? { clientAddress: input.clientAddress } : {}),
      tokenHash: this.hash(token),
    };
    this.devices.push(record);
    this.persist();
    this.notify({ type: "added", deviceId: record.id, permission: record.permission });
    return { device: this.list().find((device) => device.id === record.id)!, token };
  }

  /** Resolves a bearer token. Revocation removes the record, so a stale token can never match. */
  authenticate(
    token: string,
    client: { address?: string } = {},
  ): { device: DeviceRecord } | { failure: "unknown" } {
    if (!DEVICE_TOKEN_PATTERN.test(token)) return { failure: "unknown" };
    const hash = Buffer.from(this.hash(token), "hex");
    for (const device of this.devices) {
      const stored = Buffer.from(device.tokenHash, "hex");
      if (stored.length !== hash.length) continue;
      if (!timingSafeEqual(stored, hash)) continue;
      this.markSeen(device, client.address);
      return { device };
    }
    return { failure: "unknown" };
  }

  setPermission(deviceId: string, permission: RemotePermission): RemoteDeviceSummary {
    const device = this.devices.find((value) => value.id === deviceId);
    if (!device) throw new Error("Unknown device");
    device.permission = permission;
    this.persist();
    this.notify({ type: "permission", deviceId, permission });
    return this.list().find((value) => value.id === deviceId)!;
  }

  revoke(deviceId: string): RemoteDeviceSummary[] {
    const before = this.devices.length;
    this.devices = this.devices.filter((device) => device.id !== deviceId);
    if (this.devices.length !== before) {
      this.persist();
      this.notify({ type: "revoked", deviceId });
    }
    return this.list();
  }

  remove(deviceId: string): RemoteDeviceSummary[] {
    const before = this.devices.length;
    this.devices = this.devices.filter((device) => device.id !== deviceId);
    if (this.devices.length !== before) {
      this.persist();
      this.notify({ type: "removed", deviceId });
    }
    return this.list();
  }

  issuePairingCode(permission: RemotePermission): RemotePairingSummary {
    const code = pairingCodeFor(randomBytes(PAIRING_LENGTH));
    const expiresAt = this.now() + PAIRING_TTL_MS;
    this.pending = { code, permission, expiresAt, attempts: 0 };
    return { code, permission, expiresAt: new Date(expiresAt).toISOString() };
  }

  currentPairing(): RemotePairingSummary | null {
    const pending = this.pending;
    if (!pending) return null;
    if (pending.expiresAt <= this.now()) {
      this.pending = null;
      return null;
    }
    return {
      code: pending.code,
      permission: pending.permission,
      expiresAt: new Date(pending.expiresAt).toISOString(),
    };
  }

  clearPairingCode(): void {
    this.pending = null;
  }

  /**
   * Consumes the pending code. A wrong code counts against both the address and
   * the host-wide budget, so an unauthenticated caller cannot sit and guess.
   */
  consumePairingCode(
    code: string,
    clientAddress: string,
  ): { ok: true; permission: RemotePermission } | { ok: false; reason: PairingFailure } {
    const normalized = normalizePairingCode(code);
    const pending = this.pending;
    if (!this.acceptAttempt(clientAddress)) return { ok: false, reason: "rate-limited" };
    if (!pending) return { ok: false, reason: "expired" };
    if (pending.expiresAt <= this.now()) {
      this.pending = null;
      return { ok: false, reason: "expired" };
    }
    pending.attempts += 1;
    if (normalized.length !== PAIRING_LENGTH || normalized !== pending.code)
      return { ok: false, reason: "unknown" };
    this.pending = null;
    return { ok: true, permission: pending.permission };
  }

  private acceptAttempt(address: string): boolean {
    const at = this.now();
    for (const [key, times] of this.attempts) {
      const kept = times.filter((value) => at - value < PAIRING_ATTEMPT_WINDOW_MS);
      if (kept.length) this.attempts.set(key, kept);
      else this.attempts.delete(key);
    }
    const forAddress = this.attempts.get(address) ?? [];
    const total = [...this.attempts.values()].reduce((sum, times) => sum + times.length, 0);
    if (forAddress.length >= MAX_ATTEMPTS_PER_ADDRESS) return false;
    if (total >= MAX_ATTEMPTS_TOTAL) return false;
    forAddress.push(at);
    this.attempts.set(address, forAddress);
    return true;
  }

  private markSeen(device: DeviceRecord, address?: string): void {
    const at = new Date(this.now()).toISOString();
    const changedAddress = address !== undefined && address !== device.clientAddress;
    device.lastSeenAt = at;
    if (address !== undefined) device.clientAddress = address;
    if (changedAddress) {
      this.persist();
      this.notify({ type: "seen", deviceId: device.id });
      return;
    }
    // An open stream refreshes last-seen constantly. Persisting each one would
    // rewrite the file for every event, so writes coalesce.
    this.pendingLastSeen.add(device.id);
    if (this.seenTimer) return;
    this.seenTimer = setTimeout(() => {
      this.seenTimer = undefined;
      if (this.pendingLastSeen.size) {
        this.pendingLastSeen.clear();
        this.persist();
      }
    }, LAST_SEEN_PERSIST_INTERVAL_MS);
    if (typeof this.seenTimer.unref === "function") this.seenTimer.unref();
  }

  private seenTimer?: ReturnType<typeof setTimeout>;

  private hash(token: string): string {
    return createHmac("sha256", this.secret).update(token, "utf8").digest("hex");
  }

  private load(): void {
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as Partial<DeviceFile>;
      if (typeof parsed.secret === "string" && /^[0-9a-f]{64}$/u.test(parsed.secret))
        this.secret = parsed.secret;
      if (Array.isArray(parsed.devices)) {
        this.devices = parsed.devices.filter(
          (device): device is DeviceRecord =>
            Boolean(device) &&
            typeof device.id === "string" &&
            typeof device.name === "string" &&
            (device.permission === "view" || device.permission === "control") &&
            typeof device.createdAt === "string" &&
            typeof device.tokenHash === "string" &&
            /^[0-9a-f]{64}$/u.test(device.tokenHash),
        );
      }
    } catch {
      // A missing or unreadable file is a fresh host, not a failure to start.
    }
    if (!this.secret) this.secret = randomBytes(32).toString("hex");
  }

  private persist(): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    const payload: DeviceFile = {
      version: 1,
      secret: this.secret,
      devices: this.devices,
    };
    const temporaryPath = `${this.filePath}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporaryPath, this.filePath);
  }
}
