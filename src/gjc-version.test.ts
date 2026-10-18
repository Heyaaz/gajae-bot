import { describe, expect, it } from "vitest";
import {
  GJC_MINIMUM_VERSION,
  compareGjcVersions,
  gjcVersionSupported,
  gjcVersionWarning,
} from "../shared/gjc-version";

describe("GJC minimum version", () => {
  it("orders releases numerically and treats a release above its prereleases", () => {
    expect(compareGjcVersions("0.18.12", "0.18.11")).toBeGreaterThan(0);
    expect(compareGjcVersions("0.18.9", "0.18.11")).toBeLessThan(0);
    expect(compareGjcVersions("0.9.99", "0.10.0")).toBeLessThan(0);
    expect(compareGjcVersions("1.0.0", "0.99.99")).toBeGreaterThan(0);
    expect(compareGjcVersions("0.18.11", "0.18.11")).toBe(0);
    expect(compareGjcVersions("0.18.11-beta.2", "0.18.11")).toBeLessThan(0);
    expect(compareGjcVersions("0.18.11-beta.2", "0.18.11-beta.10")).toBeLessThan(0);
    expect(compareGjcVersions("v0.18.12", "0.18.12")).toBe(0);
  });

  it("supports the minimum and newer, and does not guess at unknown versions", () => {
    expect(GJC_MINIMUM_VERSION).toBe("0.18.11");
    expect(gjcVersionSupported("0.18.11")).toBe(true);
    expect(gjcVersionSupported("0.19.0")).toBe(true);
    expect(gjcVersionSupported("0.18.11-beta.1")).toBe(false);
    expect(gjcVersionSupported("0.18.10")).toBe(false);
    expect(gjcVersionSupported(undefined)).toBe(true);
    expect(gjcVersionSupported("unknown")).toBe(true);
  });

  it("produces update guidance only for an old runtime", () => {
    expect(gjcVersionWarning("0.18.12")).toBeUndefined();
    expect(gjcVersionWarning(undefined)).toBeUndefined();
    expect(gjcVersionWarning("0.18.10")).toContain("older than the required 0.18.11");
    expect(gjcVersionWarning("0.18.10")).toContain("bun add -g gajae-code@latest");
  });
});
