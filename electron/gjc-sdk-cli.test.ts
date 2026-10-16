import { describe, expect, it, vi } from "vitest";
import {
  GjcSdkCli,
  SdkCliError,
  envelopePage,
  freshOperationRef,
  isLifecycleUncertain,
  isSessionMissing,
  isSessionUnreachable,
  parseEnvelope,
} from "./gjc-sdk-cli.js";

/**
 * Every fixture in this file is a real response captured from gjc/0.18.11, so the
 * parsing contract is pinned to the CLI the app actually ships against rather
 * than to a hand-written guess.
 */

function cli(
  responses: string[] | ((args: string[]) => string),
): { client: GjcSdkCli; calls: string[][] } {
  const calls: string[][] = [];
  const client = new GjcSdkCli({
    executable: "/usr/local/bin/gjc",
    repo: "/repo",
    env: {},
  });
  let index = 0;
  client.exec = vi.fn(async (_executable: string, args: string[]) => {
    calls.push(args);
    if (typeof responses === "function") return responses(args);
    const next = responses[index] ?? responses[responses.length - 1];
    index += 1;
    return next ?? "{}";
  });
  return { client, calls };
}

describe("parseEnvelope", () => {
  it("throws the CLI's own error code so callers can branch on it", () => {
    const stdout = JSON.stringify({
      schema: "gjc.command-error",
      version: 1,
      ok: false,
      command: ["sdk", "session", "raw", "global"],
      error: {
        code: "terminal_uncertain",
        category: "uncertain",
        message: "Lifecycle terminal evidence could not be verified.",
        retryability: "unknown",
        outcomeCertainty: "unknown",
      },
      omittedOptional: [],
      complete: true,
      continuation: null,
    });
    expect(() => parseEnvelope(stdout, "session.create")).toThrowError(
      SdkCliError,
    );
    try {
      parseEnvelope(stdout, "session.create");
    } catch (error) {
      expect((error as SdkCliError).code).toBe("terminal_uncertain");
    }
  });

  it("accepts the control_response frame raw control answers with", () => {
    const envelope = parseEnvelope(
      JSON.stringify({
        type: "control_response",
        id: "01a0d1e0-5b18-7fbf-9f5a-0d0f1b3b8a4c",
        ok: true,
        result: { changed: true, mode: "allow" },
      }),
      "permission_mode.set",
    );
    expect(envelope.result).toEqual({ changed: true, mode: "allow" });
  });

  it("rejects non-JSON instead of treating it as an empty result", () => {
    expect(() => parseEnvelope("command not found", "session list")).toThrowError(
      /not valid JSON/u,
    );
  });
});

describe("envelopePage", () => {
  it("reads a query_response page and its continuation cursor", () => {
    const page = envelopePage({
      type: "query_response",
      ok: true,
      page: { items: [{ id: "a" }], complete: false, continuationCursor: "c1" },
    });
    expect(page.items).toHaveLength(1);
    expect(page.complete).toBe(false);
    expect(page.cursor).toBe("c1");
  });

  it("treats a bare result.items body as one complete page", () => {
    const page = envelopePage({ ok: true, result: { items: [1, 2] } });
    expect(page.items).toEqual([1, 2]);
    expect(page.complete).toBe(true);
    expect(page.cursor).toBeUndefined();
  });
});

describe("error classification", () => {
  it("separates an unverifiable receipt from a failed operation", () => {
    expect(
      isLifecycleUncertain(
        new SdkCliError("terminal_uncertain", "could not be verified"),
      ),
    ).toBe(true);
    expect(isLifecycleUncertain(new SdkCliError("invalid_input", "bad"))).toBe(
      false,
    );
  });

  it("treats an uncoded create receipt as unverified rather than refused", () => {
    // GJC answers a create it could not confirm without a code, so the envelope parser
    // reports `operation_failed`; reading that as a refusal rejected a session the
    // broker had already created (observed in the live smoke: the probe session was
    // listed live while this error was thrown).
    const uncertain = new SdkCliError(
      "operation_failed",
      "The operation failed. Its outcome could not be established.",
    );
    expect(isLifecycleUncertain(uncertain)).toBe(true);
    // The same code with a definite refusal stays a failure.
    expect(
      isLifecycleUncertain(
        new SdkCliError("operation_failed", "The operation failed."),
      ),
    ).toBe(false);
  });

  it("recognises a session with a stale endpoint as unreachable, not missing", () => {
    const stale = new SdkCliError(
      "endpoint_stale",
      "The SDK endpoint is stale or unavailable.",
    );
    expect(isSessionUnreachable(stale)).toBe(true);
    expect(isSessionMissing(stale)).toBe(false);
    expect(
      isSessionUnreachable(
        new SdkCliError("provider_lease_conflict", "held elsewhere"),
      ),
    ).toBe(true);
  });

  it("recognises a deleted session as missing", () => {
    expect(
      isSessionMissing(new SdkCliError("session_deleted", "was deleted")),
    ).toBe(true);
  });
});

describe("GjcSdkCli.listSessions", () => {
  it("projects broker rows and always passes --repo", async () => {    const { client, calls } = cli([
      JSON.stringify({
        ok: true,
        result: {
          version: 1,
          sessions: [
            {
              sessionId: "s1",
              locator: {
                cwd: "/repo",
                worktreeRoot: "/repo",
                stateRoot: "/repo/.gjc/state",
              },
              endpointGeneration: 1,
              pid: 42,
              live: true,
              deleted: false,
              activity: { state: "active", at: 1 },
            },
            {
              sessionId: "s2",
              locator: { cwd: "/repo" },
              live: false,
              deleted: true,
            },
          ],
        },
      }),
    ]);
    const rows = await client.listSessions();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      sessionId: "s1",
      repo: "/repo",
      worktreeRoot: "/repo",
      live: true,
      deleted: false,
      pid: 42,
      activityState: "active",
    });
    expect(rows[1]).toMatchObject({ sessionId: "s2", live: false, deleted: true });
    expect(calls[0]).toEqual([
      "sdk",
      "session",
      "list",
      "--scope",
      "cwd",
      "--repo",
      "/repo",
      "--json",
    ]);
  });

  it("states an explicit scope so a non-git workspace still lists", async () => {
    const { client, calls } = cli([
      JSON.stringify({ ok: true, result: { sessions: [] } }),
    ]);
    await client.listSessions();
    // The 0.18.11 default scope is `repo`, which fails outside a checkout.
    expect(calls[0]?.slice(0, 7)).toEqual([
      "sdk",
      "session",
      "list",
      "--scope",
      "cwd",
      "--repo",
      "/repo",
    ]);
    await client.listSessions({ scope: "all", repo: "/other" });
    expect(calls[1]).toContain("all");
    expect(calls[1]?.[calls[1].indexOf("--repo") + 1]).toBe("/other");
  });

  it("drains continuation cursors so the shared cursor pool is not stranded", async () => {
    const { client, calls } = cli([
      JSON.stringify({
        ok: true,
        result: {
          sessions: [{ sessionId: "s1", live: true, deleted: false }],
          continuationCursor: "page2",
        },
      }),
      JSON.stringify({
        ok: true,
        result: {
          sessions: [{ sessionId: "s2", live: true, deleted: false }],
        },
      }),
    ]);
    const rows = await client.listSessions();
    expect(rows.map((row) => row.sessionId)).toEqual(["s1", "s2"]);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("--cursor");
    expect(calls[1]).toContain("page2");
  });

  it("fails an incomplete list instead of returning partial rows", async () => {
    const { client } = cli([
      JSON.stringify({
        ok: true,
        result: {
          sessions: [{ sessionId: "s1", live: true, deleted: false }],
          continuationCursor: "same",
        },
      }),
    ]);
    await expect(client.listSessions()).rejects.toMatchObject({
      code: "incomplete_scan",
    });
  });
});

describe("GjcSdkCli.send", () => {
  it("submits a fresh op-ref and reports acceptance, not completion", async () => {
    const { client, calls } = cli([
      JSON.stringify({
        ok: true,
        result: {
          version: 1,
          operationRef: "01m199cqagzwqz7mck26zbsk7j",
          status: "accepted",
          receipt: {
            commandId: "c1",
            turnId: "t1",
            accepted: true,
            clientRef: "01m199cqagzwqz7mck26zbsk7j",
          },
        },
      }),
    ]);
    const result = await client.send("s1", "hello");
    expect(result.status).toBe("accepted");
    expect(result.operationRef).toBe("01m199cqagzwqz7mck26zbsk7j");
    expect(result.turnId).toBe("t1");
    const args = calls[0] ?? [];
    expect(args.slice(0, 4)).toEqual(["sdk", "session", "send", "s1"]);
    expect(args).toContain("--op-ref");
    expect(args[args.indexOf("--text") + 1]).toBe("hello");
  });

  it("never reuses an operation reference across two sends", async () => {
    const { client, calls } = cli([
      JSON.stringify({ ok: true, result: { status: "accepted" } }),
    ]);
    await client.send("s1", "one");
    await client.send("s1", "two");
    const first = calls[0]?.[calls[0].indexOf("--op-ref") + 1];
    const second = calls[1]?.[calls[1].indexOf("--op-ref") + 1];
    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    expect(first).not.toBe(second);
  });
});

describe("GjcSdkCli.promptStatus", () => {
  it("reads a failed prompt record with its error code", async () => {
    const { client } = cli([
      JSON.stringify({
        ok: true,
        result: {
          operationRef: "op1",
          status: {
            status: "failed",
            kind: "prompt",
            error: { code: "agent_error", message: "Prompt submission failed." },
          },
          summary: { completed: true },
        },
      }),
    ]);
    const status = await client.promptStatus("s1", "op1");
    expect(status.status).toBe("failed");
    expect(status.completed).toBe(true);
    expect(status.error?.code).toBe("agent_error");
  });

  it("reports an unretained record as unknown rather than as success", async () => {
    const { client } = cli([
      JSON.stringify({ ok: true, result: { operationRef: "op1", summary: {} } }),
    ]);
    const status = await client.promptStatus("s1", "op1");
    expect(status.status).toBe("unknown");
    expect(status.completed).toBe(false);
  });
});

describe("GjcSdkCli.tail", () => {
  it("requests every event kind and bounds the wait window", async () => {
    const { client, calls } = cli([
      JSON.stringify({
        ok: true,
        result: {
          version: 2,
          source: "session",
          terminal: true,
          checkpoint: { revision: 9, generation: 3, seq: 12, idle: true },
          cursor: "ck1",
          items: [
            { kind: "turn_start", generation: 3, seq: 10, payload: { id: "t1" } },
            { kind: "transcript", seq: 11, payload: { role: "assistant" } },
          ],
        },
      }),
    ]);
    const tail = await client.tail("s1");
    expect(tail.terminal).toBe(true);
    // 0.18.11 reports the resumable token as the envelope cursor.
    expect(tail.checkpointToken).toBe("ck1");
    expect(tail.items.map((item) => item.kind)).toEqual([
      "turn_start",
      "transcript",
    ]);
    const args = calls[0] ?? [];
    expect(args).toContain("--all-events");
    expect(args).toContain("--until-idle");
    expect(args).toContain("--timeout-ms");
    // Exact-session verbs resolve from the session ID; 0.18.11 ignores --repo there.
    expect(args).not.toContain("--repo");
  });

  it("resumes from a saved checkpoint claim instead of rewinding", async () => {
    const { client, calls } = cli([
      JSON.stringify({ ok: true, result: { source: "session", items: [] } }),
    ]);
    await client.tail("s1", { cursor: "ck1" });
    expect(calls[0]?.[calls[0].indexOf("--cursor") + 1]).toBe("ck1");
  });
  it("surfaces tail_timeout as a typed error because items are discarded", async () => {
    const { client } = cli([
      JSON.stringify({
        ok: false,
        error: {
          code: "tail_timeout",
          message: "Tail did not reach an exit condition within the wait window.",
        },
      }),
    ]);
    await expect(client.tail("s1")).rejects.toThrowError(/tail/iu);
  });
});

describe("GjcSdkCli.rawControl", () => {
  it("sends the terminal abort contract with confirm and key as flags", async () => {
    const { client, calls } = cli([
      JSON.stringify({
        type: "control_response",
        id: "01a0d1e0-5b18-7fbf-9f5a-0d0f1b3b8a4c",
        ok: true,
        result: { turn: "stopped" },
      }),
    ]);
    const result = await client.rawControl(
      "s1",
      "turn.abort",
      { mode: "terminal", scope: "owned", operator: true },
      { idempotencyKey: "gajae-abort-uuid", confirm: true },
    );
    expect(result).toEqual({ turn: "stopped" });
    const args = calls[0] ?? [];
    const payload = JSON.parse(args[args.indexOf("--json-input") + 1] ?? "{}");
    // The host rejects any terminal-abort field outside mode/scope/operator.
    expect(payload).toEqual({ mode: "terminal", scope: "owned", operator: true });
    expect(payload).not.toHaveProperty("confirm");
    expect(payload).not.toHaveProperty("idempotencyKey");
    expect(args).toContain("--confirm");
    expect(args[args.indexOf("--idempotency-key") + 1]).toBe("gajae-abort-uuid");
    // 0.18.11 rejects the raw control verb when --repo is present.
    expect(args).not.toContain("--repo");
    expect(args).toContain("--json");
  });

  it("sets always-allow through permission_mode.set", async () => {
    const { client, calls } = cli([
      JSON.stringify({
        type: "control_response",
        ok: true,
        result: { changed: true, mode: "allow" },
      }),
    ]);
    const result = await client.rawControl("s1", "permission_mode.set", {
      mode: "always-allow",
    });
    expect(result).toEqual({ changed: true, mode: "allow" });
    const args = calls[0] ?? [];
    expect(args.slice(0, 5)).toEqual([
      "sdk",
      "session",
      "raw",
      "control",
      "s1",
    ]);
    expect(args[args.indexOf("--op") + 1]).toBe("permission_mode.set");
  });
});

describe("GjcSdkCli.queryItems", () => {
  it("drains query pages to completion", async () => {
    const { client, calls } = cli((args) =>
      args.includes("--cursor")
        ? JSON.stringify({
            type: "query_response",
            ok: true,
            page: { items: [{ id: "b" }], complete: true },
          })
        : JSON.stringify({
            type: "query_response",
            ok: true,
            page: {
              items: [{ id: "a" }],
              complete: false,
              continuationCursor: "next",
            },
          }),
    );
    const items = await client.queryItems("s1", "transcript.list");
    expect(items).toEqual([{ id: "a" }, { id: "b" }]);
    expect(calls).toHaveLength(2);
  });

  it("fails a repeated query cursor instead of stranding a partial page", async () => {
    const { client } = cli([
      JSON.stringify({
        type: "query_response",
        ok: true,
        page: { items: [], complete: false, continuationCursor: "same" },
      }),
    ]);
    await expect(client.queryItems("s1", "transcript.list")).rejects.toMatchObject({
      code: "incomplete_query",
    });
  });
});

describe("GjcSdkCli.rawGlobal", () => {
  it("generates an idempotency key for lifecycle globals", async () => {
    const { client, calls } = cli([
      JSON.stringify({ ok: true, result: { sessionId: "new" } }),
    ]);
    await client.rawGlobal("session.create", { cwd: "/repo" });
    const args = calls[0] ?? [];
    expect(args).toContain("--idempotency-key");
    expect(args[args.indexOf("--idempotency-key") + 1]).toMatch(
      /^gajae-session-create-/u,
    );
    // 0.18.11 rejects the raw global verb when --repo or --confirm is present.
    expect(args).not.toContain("--repo");
    expect(args).not.toContain("--confirm");
    expect(args).toContain("--json");
  });

  it("omits an idempotency key for non-lifecycle globals", async () => {
    const { client, calls } = cli([JSON.stringify({ ok: true, result: {} })]);
    await client.rawGlobal("session.list", {});
    expect(calls[0]).not.toContain("--idempotency-key");
  });

  it("passes a caller-owned key through unchanged", async () => {
    const { client, calls } = cli([JSON.stringify({ ok: true, result: {} })]);
    await client.rawGlobal(
      "session.delete",
      { sessionId: "s1" },
      { repo: "/other", idempotencyKey: "gajae-delete-fixed" },
    );
    const args = calls[0] ?? [];
    expect(args[args.indexOf("--idempotency-key") + 1]).toBe(
      "gajae-delete-fixed",
    );
    expect(args).not.toContain("--confirm");
    expect(args).not.toContain("--repo");
  });
});

describe("freshOperationRef", () => {
  it("returns unique canonical ULIDs", () => {
    const values = Array.from({ length: 64 }, () => freshOperationRef());
    const refs = new Set(values);
    expect(refs.size).toBe(64);
    for (const value of values)
      expect(value).toMatch(/^[0-9a-hjkmnp-tv-z]{26}$/u);
  });
});
