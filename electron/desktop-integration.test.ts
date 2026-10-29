import { describe, expect, it } from "vitest";
import type { AgentSession } from "../shared/agent-contract.js";
import {
  DEFAULT_DESKTOP_INTEGRATION,
  parseDesktopIntegration,
  summarizeSessionAttention,
} from "../shared/desktop-integration.js";
import { DesktopIntegration, type PowerSaveApi } from "./desktop-integration.js";

function fakePower(): PowerSaveApi & { active: Set<number>; starts: number } {
  let next = 1;
  const active = new Set<number>();
  return {
    active,
    starts: 0,
    start() {
      this.starts += 1;
      const id = next++;
      active.add(id);
      return id;
    },
    stop(id) {
      active.delete(id);
    },
    isStarted(id) {
      return active.has(id);
    },
  };
}

function session(id: string, patch: Partial<AgentSession> = {}): AgentSession {
  return {
    id,
    title: id,
    subtitle: "",
    workspace: "/repo",
    runtime: "gjc",
    status: "idle",
    updatedAt: "now",
    pinned: false,
    unread: false,
    accent: "#000",
    ownership: "gajae",
    attachment: "attached",
    ...patch,
  };
}

describe("DesktopIntegration power", () => {
  it("holds the sleep assertion only while a session is working", () => {
    const power = fakePower();
    const integration = new DesktopIntegration({
      power,
      preferences: DEFAULT_DESKTOP_INTEGRATION,
    });
    integration.observe({ type: "session.created", session: session("a") });
    expect(power.active.size).toBe(0);

    integration.observe({
      type: "session.updated",
      session: session("a", { status: "running" }),
    });
    expect(integration.preventingSleep()).toBe(true);

    // A second working session does not take a second assertion.
    integration.observe({
      type: "session.created",
      session: session("b", { status: "starting" }),
    });
    expect(power.starts).toBe(1);

    integration.observe({ type: "session.updated", session: session("a") });
    expect(integration.preventingSleep()).toBe(true);
    integration.observe({ type: "session.deleted", sessionId: "b" });
    expect(integration.preventingSleep()).toBe(false);
    expect(power.active.size).toBe(0);
  });

  it("counts compaction as work even when the row reads idle", () => {
    const power = fakePower();
    const integration = new DesktopIntegration({
      power,
      preferences: DEFAULT_DESKTOP_INTEGRATION,
    });
    integration.seed([session("a", { phase: "compacting" })]);
    expect(integration.preventingSleep()).toBe(true);
  });

  it("releases at once when the preference is turned off and never takes it while off", () => {
    const power = fakePower();
    const integration = new DesktopIntegration({
      power,
      preferences: DEFAULT_DESKTOP_INTEGRATION,
    });
    integration.seed([session("a", { status: "running" })]);
    expect(integration.preventingSleep()).toBe(true);

    integration.setPreferences({
      ...DEFAULT_DESKTOP_INTEGRATION,
      preventSleep: false,
    });
    expect(power.active.size).toBe(0);
    integration.observe({
      type: "session.updated",
      session: session("a", { status: "running", title: "renamed" }),
    });
    expect(power.starts).toBe(1);
  });

  it("re-takes the assertion if the OS dropped it", () => {
    const power = fakePower();
    const integration = new DesktopIntegration({
      power,
      preferences: DEFAULT_DESKTOP_INTEGRATION,
    });
    integration.seed([session("a", { status: "running" })]);
    power.active.clear();
    integration.observe({
      type: "session.updated",
      session: session("a", { status: "running" }),
    });
    expect(integration.preventingSleep()).toBe(true);
    expect(power.starts).toBe(2);
  });

  it("releases on dispose and ignores later events", () => {
    const power = fakePower();
    const integration = new DesktopIntegration({
      power,
      preferences: DEFAULT_DESKTOP_INTEGRATION,
    });
    integration.seed([session("a", { status: "running" })]);
    integration.dispose();
    expect(power.active.size).toBe(0);
    integration.observe({
      type: "session.created",
      session: session("b", { status: "running" }),
    });
    expect(power.active.size).toBe(0);
  });

  it("does not let a stale seed overwrite a row an event already delivered", () => {
    const power = fakePower();
    const integration = new DesktopIntegration({
      power,
      preferences: DEFAULT_DESKTOP_INTEGRATION,
    });
    integration.observe({
      type: "session.updated",
      session: session("a", { status: "idle" }),
    });
    integration.seed([session("a", { status: "running" })]);
    expect(integration.preventingSleep()).toBe(false);
  });
});

describe("desktop integration preferences", () => {
  it("defaults missing and malformed fields", () => {
    expect(parseDesktopIntegration(undefined)).toEqual(DEFAULT_DESKTOP_INTEGRATION);
    expect(parseDesktopIntegration({ preventSleep: "yes" })).toEqual(
      DEFAULT_DESKTOP_INTEGRATION,
    );
    expect(parseDesktopIntegration({ preventSleep: false })).toEqual({
      ...DEFAULT_DESKTOP_INTEGRATION,
      preventSleep: false,
    });
    expect(
      parseDesktopIntegration({ menuBarStatus: false, dockBadge: 0 }),
    ).toEqual({ ...DEFAULT_DESKTOP_INTEGRATION, menuBarStatus: false });
  });
});

describe("summarizeSessionAttention", () => {
  it("splits sessions the way the rail groups them", () => {
    expect(
      summarizeSessionAttention([
        session("a", { status: "running" }),
        session("b", { status: "waiting" }),
        session("c", { status: "failed", unread: true }),
        session("d", { unread: true }),
        session("e"),
      ]),
    ).toEqual({ working: 1, needsInput: 2, unreadCompleted: 1 });
  });
});
