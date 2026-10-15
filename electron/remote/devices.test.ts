import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEVICE_TOKEN_PATTERN,
  DeviceStore,
  createDeviceToken,
  normalizePairingCode,
  pairingCodeFor,
  validDeviceName,
} from "./devices.js";

const directories: string[] = [];

function temporaryFile(name = "remote-devices.json"): string {
  const directory = mkdtempSync(path.join(tmpdir(), "gajae-remote-"));
  directories.push(directory);
  return path.join(directory, name);
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("device tokens", () => {
  it("mints url-safe tokens with 256 bits of entropy", () => {
    const token = createDeviceToken();
    expect(token).toMatch(DEVICE_TOKEN_PATTERN);
    expect(new Set(Array.from({ length: 64 }, () => createDeviceToken())).size).toBe(64);
  });

  it("stores only a salted hash of the token", () => {
    const file = temporaryFile();
    const store = new DeviceStore(file);
    const created = store.add({ name: "iPhone", permission: "view" });
    const contents = readFileSync(file, "utf8");
    expect(contents).not.toContain(created.token);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("resolves a token and rejects anything else", () => {
    const store = new DeviceStore(temporaryFile());
    const created = store.add({ name: "iPhone", permission: "view" });
    expect(store.authenticate(created.token)).toMatchObject({
      device: { name: "iPhone", permission: "view" },
    });
    expect(store.authenticate("x".repeat(43))).toEqual({ failure: "unknown" });
    expect(store.authenticate("short")).toEqual({ failure: "unknown" });
  });

  it("survives a restart with the same secret", () => {
    const file = temporaryFile();
    const first = new DeviceStore(file);
    const created = first.add({ name: "iPad", permission: "control" });
    const second = new DeviceStore(file);
    expect(second.authenticate(created.token)).toMatchObject({
      device: { name: "iPad", permission: "control" },
    });
    expect(second.list()).toHaveLength(1);
  });

  it("stops resolving a token the moment the device is revoked", () => {
    const store = new DeviceStore(temporaryFile());
    const created = store.add({ name: "iPhone", permission: "control" });
    const revoked: string[] = [];
    store.subscribe((change) => revoked.push(change.type));
    store.revoke(created.device.id);
    expect(store.authenticate(created.token)).toEqual({ failure: "unknown" });
    expect(store.list()).toEqual([]);
    expect(revoked).toEqual(["revoked"]);
  });

  it("ignores a device file whose hash field was tampered with", () => {
    const file = temporaryFile();
    const store = new DeviceStore(file);
    const created = store.add({ name: "iPhone", permission: "view" });
    const parsed = JSON.parse(readFileSync(file, "utf8")) as {
      devices: Array<{ tokenHash: string }>;
    };
    parsed.devices[0].tokenHash = "not-a-hash";
    writeFileSync(file, JSON.stringify(parsed));
    const reloaded = new DeviceStore(file);
    expect(reloaded.list()).toEqual([]);
    expect(reloaded.authenticate(created.token)).toEqual({ failure: "unknown" });
  });
});

describe("device records", () => {
  it("changes permission and notifies", () => {
    const store = new DeviceStore(temporaryFile());
    const changes: string[] = [];
    store.subscribe((change) => changes.push(`${change.type}:${change.permission ?? ""}`));
    const created = store.add({ name: "iPhone", permission: "view" });
    const updated = store.setPermission(created.device.id, "control");
    expect(updated.permission).toBe("control");
    expect(changes).toEqual(["added:view", "permission:control"]);
  });

  it("records the device name and rejects unusable ones", () => {
    const store = new DeviceStore(temporaryFile());
    expect(() => store.add({ name: "   ", permission: "view" })).toThrow("Device name is invalid");
    expect(() => store.add({ name: "bad\u0007name", permission: "view" })).toThrow(
      "Device name is invalid",
    );
    expect(validDeviceName("거실 아이패드")).toBe(true);
    expect(validDeviceName("a".repeat(61))).toBe(false);
  });

  it("caps the number of paired devices", () => {
    const store = new DeviceStore(temporaryFile());
    for (let index = 0; index < 24; index += 1)
      store.add({ name: `device-${index}`, permission: "view" });
    expect(() => store.add({ name: "one too many", permission: "view" })).toThrow(
      "Too many paired devices",
    );
  });
});

describe("pairing codes", () => {
  it("uses an unambiguous alphabet and normalizes typed input", () => {
    const code = pairingCodeFor(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]));
    expect(code).toHaveLength(8);
    expect(code).toMatch(/^[2-9A-HJKMNP-Z]{8}$/u);
    expect(normalizePairingCode(` ${code.slice(0, 4)}-${code.slice(4).toLowerCase()} `)).toBe(code);
  });

  it("consumes a code exactly once", () => {
    const store = new DeviceStore(temporaryFile());
    const pairing = store.issuePairingCode("control");
    expect(store.consumePairingCode(pairing.code.toLowerCase(), "10.0.0.1")).toEqual({
      ok: true,
      permission: "control",
    });
    expect(store.consumePairingCode(pairing.code, "10.0.0.1")).toEqual({
      ok: false,
      reason: "expired",
    });
    expect(store.currentPairing()).toBeNull();
  });

  it("expires a code after its window", () => {
    let now = 1_000;
    const store = new DeviceStore(temporaryFile(), { now: () => now });
    const pairing = store.issuePairingCode("view");
    now += 5 * 60 * 1000 + 1;
    expect(store.consumePairingCode(pairing.code, "10.0.0.1")).toEqual({
      ok: false,
      reason: "expired",
    });
    expect(store.currentPairing()).toBeNull();
  });

  it("rejects a wrong code and never leaks whether a code exists", () => {
    const store = new DeviceStore(temporaryFile());
    expect(store.consumePairingCode("AAAAAAAA", "10.0.0.1")).toEqual({
      ok: false,
      reason: "expired",
    });
    const pairing = store.issuePairingCode("view");
    expect(store.consumePairingCode("AAAAAAAA", "10.0.0.1")).toEqual({
      ok: false,
      reason: "unknown",
    });
    expect(store.consumePairingCode(pairing.code, "10.0.0.1")).toEqual({
      ok: true,
      permission: "view",
    });
  });

  it("rate limits guessing per address and host-wide", () => {
    const store = new DeviceStore(temporaryFile());
    store.issuePairingCode("view");
    for (let attempt = 0; attempt < 8; attempt += 1)
      expect(store.consumePairingCode("AAAAAAAA", "10.0.0.1").ok).toBe(false);
    expect(store.consumePairingCode("AAAAAAAA", "10.0.0.1")).toEqual({
      ok: false,
      reason: "rate-limited",
    });
    // A different address still gets its own budget.
    expect(store.consumePairingCode("AAAAAAAA", "10.0.0.2").ok).toBe(false);
  });

  it("replaces a pending code when a new one is issued", () => {
    const store = new DeviceStore(temporaryFile());
    const first = store.issuePairingCode("view");
    const second = store.issuePairingCode("view");
    expect(store.consumePairingCode(first.code, "10.0.0.1")).toMatchObject({ ok: false });
    expect(store.consumePairingCode(second.code, "10.0.0.1").ok).toBe(true);
  });
});
