import { describe, expect, it } from "vitest";
import {
  contentSecurityPolicy,
  replaceCspMarker,
} from "../vite.config.js";

describe("renderer Content Security Policy", () => {
  it("reaches only the loopback event stream over the network in production", () => {
    const policy = contentSecurityPolicy(false);
    // The desktop window reads runtime events from a loopback HTTP stream that takes an
    // ephemeral port, so the port cannot be named in the policy.
    expect(policy).toContain("connect-src http://127.0.0.1:*");
    for (const origin of policy.match(/http:\/\/[^;\s]+/gu) ?? [])
      expect(origin).toBe("http://127.0.0.1:*");
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("base-uri 'none'");
    expect(policy).toContain("form-action 'none'");
    expect(policy).not.toContain("https://");
    expect(policy).not.toContain("ws://");
    expect(policy).not.toContain("'unsafe-eval'");
  });

  it("allows only the local Vite endpoint and the event stream during development", () => {
    const policy = contentSecurityPolicy(true);
    expect(policy).toContain("http://127.0.0.1:5173");
    expect(policy).toContain("ws://127.0.0.1:5173");
    expect(policy).toContain("http://127.0.0.1:*");
    expect(policy).not.toContain("https:");
  });

  it("fails the build if the CSP marker is missing or duplicated", () => {
    const marker = '<meta id="gajae-csp" content="default-src none" />';
    expect(replaceCspMarker(`<head>${marker}</head>`, false)).toContain(
      "connect-src http://127.0.0.1:*",
    );
    expect(() => replaceCspMarker("<head></head>", false)).toThrow(
      "found 0",
    );
    expect(() => replaceCspMarker(`${marker}${marker}`, false)).toThrow(
      "found 2",
    );
  });
});
