import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MockAgentBackend } from "./mock-agent-backend";

/**
 * A window that cannot reach GJC has to say so.
 *
 * The app's whole claim is that its screen is the source of truth about the agent, so
 * substituting invented data for a runtime that failed is the worst thing it can do.
 * `selectBackend` used to swap in the mock backend whenever the connection was not
 * `connected`, and that backend reports `state: "connected"` -- so a dead runtime
 * showed a green dot, four fabricated sessions, and transcripts that never happened.
 *
 * The renderer entry cannot be imported here: it mounts React against a DOM and
 * reaches for `window.agentControlDesktop`. The fallback being gone is a property of
 * the selection code itself, so it is asserted against the source.
 */
const entrySource = readFileSync(
  path.join(import.meta.dirname, "../main.tsx"),
  "utf8",
);

function selectBackendBody(text: string): string {
  const start = text.indexOf("function selectBackend");
  expect(start).toBeGreaterThan(-1);
  const open = text.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === "{") depth += 1;
    if (text[index] === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(open, index + 1);
    }
  }
  throw new Error("selectBackend body was not found");
}

function sendMessageBody(text: string): string {
  const start = text.indexOf("async function sendMessage");
  expect(start).toBeGreaterThan(-1);
  const open = text.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === "{") depth += 1;
    if (text[index] === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(open, index + 1);
    }
  }
  throw new Error("sendMessage body was not found");
}

describe("backend selection when GJC is unavailable", () => {
  it("never substitutes the mock backend for a failed connection", () => {
    const body = selectBackendBody(entrySource);
    // The one legitimate reason to build the mock backend is an explicit request for
    // it, so the only `MockAgentBackend` in this function is the one guarded by that
    // request. A second construction is the fallback coming back.
    expect(body.match(/new MockAgentBackend\(\)/gu)).toHaveLength(1);
    // Deciding on the connection state is what made the swap possible.
    expect(body).not.toContain("getConnection");
    expect(body).not.toContain('"connected"');
    expect(body).not.toContain("'connected'");
  });

  it("keeps the explicit mock request working", () => {
    // The `--smoke` run and UI work both depend on `?backend=mock`, so removing the
    // silent fallback must not remove the deliberate one.
    const body = selectBackendBody(entrySource);
    expect(body).toContain("backend");
    expect(body).toContain("mock");
    expect(body).toContain("new MockAgentBackend()");
  });
});

describe("mock runtime identity", () => {
  it("announces that its data is fabricated", async () => {
    // The mock backend answers `connected` because, as a backend, it is. What must not
    // happen is it reading as a real attached runtime: this label and detail are the
    // only thing on screen that tells the user the sessions are invented.
    const backend = new MockAgentBackend();
    const connection = await backend.getConnection();

    expect(connection.backend).toBe("mock");
    expect(connection.label).toMatch(/mock/iu);
    expect(connection.detail).not.toBe("Local preview data");
    expect(connection.detail.length).toBeGreaterThan(10);

    backend.dispose();
  });
});

describe("shell rendering while the runtime is unreachable", () => {
  const shellSource = readFileSync(
    path.join(import.meta.dirname, "../app/shell.tsx"),
    "utf8",
  );

  it("gives the workspace to the failure instead of an empty session view", () => {
    // Without this branch a disconnected window rendered the ordinary "no session
    // selected" screen, which is indistinguishable from a healthy idle app.
    expect(shellSource).toContain("runtimeUnavailable");
    expect(shellSource).toMatch(
      /connection\.state === "disconnected" \|\|\s*connection\.state === "error"/u,
    );
    expect(shellSource).toContain("workspace--offline");
    // The failure text itself has to reach the screen; a generic message would hide
    // which runtime problem occurred.
    expect(shellSource).toContain("{connection.detail}");
  });

  it("offers recovery from that screen", () => {
    // A dead-end failure screen would force a restart to recover.
    expect(shellSource).toContain("void reconnect()");
    expect(shellSource).toContain("backend.reconnect()");
  });

  it("renders the failure branch ahead of the session branch", () => {
    // Order matters: a stale selected session would otherwise win and paint a normal
    // conversation over a runtime that is gone.
    const offline = shellSource.indexOf("runtimeUnavailable ? (");
    const selected = shellSource.indexOf("selectedSession ? (");
    expect(offline).toBeGreaterThan(-1);
    expect(selected).toBeGreaterThan(-1);
    expect(offline).toBeLessThan(selected);
  });

  it("surfaces delivery failures and rejects them for queue retention", () => {
    const body = sendMessageBody(shellSource);
    expect(body).toContain("return await backend.sendMessage(");
    expect(body).toContain("setAppError(humanErrorMessage(error));");
    expect(body).toMatch(
      /setAppError\(humanErrorMessage\(error\)\);[\s\S]*throw error;/u,
    );
    expect(body).not.toContain("return undefined");
  });
});
