import { describe, expect, it } from "vitest";
import {
  SERVING_PORT,
  TailscaleClient,
  parseServeStatus,
  parseTailscaleStatus,
  serveTargetFor,
  servingPort,
  type CommandResult,
} from "./tailscale.js";

function runner(responses: Record<string, CommandResult>) {
  const calls: string[] = [];
  const run = async (_file: string, args: string[]): Promise<CommandResult> => {
    const key = args.join(" ");
    calls.push(key);
    return responses[key] ?? { stdout: "", stderr: "unexpected command", code: 1 };
  };
  return { run, calls };
}

const ok = (stdout: string): CommandResult => ({ stdout, stderr: "", code: 0 });
const fail = (stderr: string): CommandResult => ({ stdout: "", stderr, code: 1 });

describe("tailscale status parsing", () => {
  it("reads the fields the panel reports and trims the DNS name", () => {
    expect(
      parseTailscaleStatus({
        BackendState: "Running",
        Version: "1.74.0",
        Self: { DNSName: "mac-mini.tailnet-abcd.ts.net.", TailscaleIPs: ["100.101.102.103", "fd7a::1"] },
      }),
    ).toEqual({
      backendState: "Running",
      dnsName: "mac-mini.tailnet-abcd.ts.net",
      ipv4: "100.101.102.103",
      version: "1.74.0",
    });
  });

  it("survives an unexpected shape", () => {
    expect(parseTailscaleStatus(undefined)).toEqual({});
    expect(parseTailscaleStatus({ Self: { TailscaleIPs: "not-a-list" } })).toEqual({});
  });

  it("finds our loopback mapping among other serve entries", () => {
    const entries = parseServeStatus({
      Web: {
        "mac-mini.tailnet-abcd.ts.net:443": {
          Handlers: {
            "/": { Proxy: "http://127.0.0.1:8791" },
            "/other": { Proxy: "http://127.0.0.1:9999" },
          },
        },
      },
    });
    expect(entries).toHaveLength(2);
    expect(servingPort(entries, 8791)).toMatchObject({ path: "/" });
    expect(servingPort(entries, 8792)).toBeUndefined();
    expect(parseServeStatus({ Web: "nonsense" })).toEqual([]);
  });
});

describe("tailscale summary", () => {
  it("reports a missing binary instead of failing", async () => {
    const { run } = runner({ version: fail("exec: tailscale: not found") });
    const summary = await new TailscaleClient({ runner: run }).summary(8791);
    expect(summary).toMatchObject({ installed: false, connected: false, serveEnabled: false });
    expect(summary.detail).toContain("설치");
  });

  it("reports connection and the published origin", async () => {
    const { run } = runner({
      version: ok("1.74.0\n  go1.22\n"),
      "status --json": ok(
        JSON.stringify({
          BackendState: "Running",
          Self: { DNSName: "mac-mini.tailnet-abcd.ts.net.", TailscaleIPs: ["100.101.102.103"] },
        }),
      ),
      "serve status --json": ok(
        JSON.stringify({
          Web: {
            "mac-mini.tailnet-abcd.ts.net:443": {
              Handlers: { "/": { Proxy: "http://127.0.0.1:8791" } },
            },
          },
        }),
      ),
    });
    const summary = await new TailscaleClient({ runner: run }).summary(8791);
    expect(summary).toMatchObject({
      installed: true,
      connected: true,
      serveEnabled: true,
      serveOrigin: "https://mac-mini.tailnet-abcd.ts.net",
      dnsName: "mac-mini.tailnet-abcd.ts.net",
      version: "1.74.0",
    });
  });

  it("explains that the machine is not connected", async () => {
    const { run } = runner({
      version: ok("1.74.0\n"),
      "status --json": ok(JSON.stringify({ BackendState: "Stopped" })),
      "serve status --json": ok(JSON.stringify({ Web: {} })),
    });
    const summary = await new TailscaleClient({ runner: run }).summary(8791);
    expect(summary.connected).toBe(false);
    expect(summary.detail).toContain("Stopped");
  });
});

describe("tailscale serve wiring", () => {
  it("maps the loopback port for this machine", async () => {
    const { run, calls } = runner({
      "serve --bg --https=443 http://127.0.0.1:8791": ok("Available on the internet:\n"),
    });
    const result = await new TailscaleClient({ runner: run }).enableServe(8791);
    expect(result.code).toBe(0);
    expect(calls).toEqual([`serve --bg --https=${SERVING_PORT} ${serveTargetFor(8791)}`]);
  });

  it("refuses to reset a serve configuration that also serves something else", async () => {
    const { run, calls } = runner({});
    const entries = parseServeStatus({
      Web: {
        "mac-mini.tailnet-abcd.ts.net:443": {
          Handlers: {
            "/": { Proxy: "http://127.0.0.1:8791" },
            "/grafana": { Proxy: "http://127.0.0.1:3000" },
          },
        },
      },
    });
    const result = await new TailscaleClient({ runner: run }).disableServe(8791, entries);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("다른 Serve 설정");
    expect(calls).toEqual([]);
  });

  it("turns our own mapping off and falls back to reset on older builds", async () => {
    const entries = parseServeStatus({
      Web: {
        "mac-mini.tailnet-abcd.ts.net:443": {
          Handlers: { "/": { Proxy: "http://127.0.0.1:8791" } },
        },
      },
    });
    const perPort = runner({ "serve --https=443 off": ok("") });
    expect((await new TailscaleClient({ runner: perPort.run }).disableServe(8791, entries)).code).toBe(0);
    expect(perPort.calls).toEqual(["serve --https=443 off"]);

    const legacy = runner({ "serve reset": ok("") });
    expect((await new TailscaleClient({ runner: legacy.run }).disableServe(8791, entries)).code).toBe(0);
    expect(legacy.calls).toEqual(["serve --https=443 off", "serve reset"]);
  });
});
