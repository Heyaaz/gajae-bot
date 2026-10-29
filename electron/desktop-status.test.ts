import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../shared/agent-contract.js";
import {
  DEFAULT_DESKTOP_INTEGRATION,
  type DesktopIntegrationPreferences,
} from "../shared/desktop-integration.js";
import {
  DesktopIntegration,
  type DesktopIntegrationState,
  type PowerSaveApi,
} from "./desktop-integration.js";
import {
  desktopStatusModel,
  desktopStatusRenderer,
  STATUS_MENU_LIMIT,
  templateMask,
  type StatusTray,
} from "./desktop-status.js";
import { setHostLanguage } from "./host-text.js";

afterEach(() => setHostLanguage("ko"));

const power: PowerSaveApi = {
  start: () => 1,
  stop: () => undefined,
  isStarted: () => false,
};

function session(id: string, patch: Partial<AgentSession> = {}): AgentSession {
  return {
    id,
    title: id,
    subtitle: "",
    workspace: "/repo",
    runtime: "gjc",
    status: "idle",
    updatedAt: "now",
    updatedAtMs: 0,
    pinned: false,
    unread: false,
    accent: "#000",
    ownership: "gajae",
    attachment: "attached",
    ...patch,
  };
}

function stateOf(
  sessions: AgentSession[],
  preferences: Partial<DesktopIntegrationPreferences> = {},
): DesktopIntegrationState {
  const integration = new DesktopIntegration({
    power,
    preferences: { ...DEFAULT_DESKTOP_INTEGRATION, ...preferences },
  });
  integration.seed(sessions);
  return integration.state();
}

function labels(tray: StatusTray | null): string[] {
  return (tray?.menu ?? []).map((entry) =>
    entry.kind === "separator" ? "---" : entry.label,
  );
}

describe("desktopStatusModel", () => {
  it("lists sessions that need the user before working ones, newest first", () => {
    const model = desktopStatusModel(
      stateOf([
        session("old-run", { status: "running", updatedAtMs: 1 }),
        session("new-run", { status: "running", updatedAtMs: 5 }),
        session("approval", { status: "waiting", updatedAtMs: 2 }),
        session("broken", { status: "failed", updatedAtMs: 3 }),
        session("done", { unread: true, updatedAtMs: 9 }),
      ]),
    );
    expect(model.tray?.title).toBe("\u26A0\uFE0E2 \u25B6\uFE0E2");
    expect(model.tray?.tooltip).toBe("확인 필요 2 · 실행 중 2");
    expect(labels(model.tray)).toEqual([
      "확인 필요",
      "broken (실패)",
      "approval",
      "---",
      "실행 중",
      "new-run",
      "old-run",
      "---",
      "Gajae 열기",
    ]);
    expect(model.badge).toBe("3");
  });

  it("opens the session each row names", () => {
    const tray = desktopStatusModel(
      stateOf([session("abc", { status: "waiting", title: "Fix login" })]),
    ).tray;
    expect(tray?.menu).toContainEqual({
      kind: "session",
      label: "Fix login",
      sessionId: "abc",
    });
  });

  it("caps the menu but keeps every session in the title", () => {
    const sessions = Array.from({ length: STATUS_MENU_LIMIT + 3 }, (_, index) =>
      session(`s${index}`, { status: "running", updatedAtMs: index }),
    );
    const tray = desktopStatusModel(stateOf(sessions)).tray;
    const rows = tray?.menu.filter((entry) => entry.kind === "session") ?? [];
    expect(rows).toHaveLength(STATUS_MENU_LIMIT);
    expect(rows[0]).toMatchObject({ sessionId: `s${STATUS_MENU_LIMIT + 2}` });
    expect(tray?.title).toBe(`\u25B6\uFE0E${STATUS_MENU_LIMIT + 3}`);
  });

  it("shows an empty icon title and clears the badge when nothing is going on", () => {
    const model = desktopStatusModel(stateOf([session("a")]));
    expect(model.tray?.title).toBe("");
    expect(labels(model.tray)).toEqual(["진행 중인 세션 없음", "---", "Gajae 열기"]);
    expect(model.badge).toBe("");
  });

  it("falls back to the workspace name and shortens long titles", () => {
    const tray = desktopStatusModel(
      stateOf([
        session("a", { status: "running", title: " ", workspace: "/x/gajae-bot" }),
        session("b", { status: "running", title: "x".repeat(80) }),
      ]),
    ).tray;
    const rows = labels(tray).filter((label) => label === "gajae-bot" || label.startsWith("x"));
    expect(rows).toContain("gajae-bot");
    expect(rows.find((label) => label.startsWith("x"))).toHaveLength(48);
  });

  it("removes each surface on its own preference", () => {
    const sessions = [session("a", { status: "waiting" })];
    expect(desktopStatusModel(stateOf(sessions, { menuBarStatus: false }))).toEqual({
      tray: null,
      badge: "1",
    });
    const noBadge = desktopStatusModel(stateOf(sessions, { dockBadge: false }));
    expect(noBadge.badge).toBe("");
    expect(noBadge.tray?.title).toBe("\u26A0\uFE0E1");
  });

  it("follows the host language", () => {
    setHostLanguage("en");
    const tray = desktopStatusModel(stateOf([session("a", { status: "failed" })])).tray;
    expect(labels(tray)).toEqual(["Needs input", "a (failed)", "---", "Open Gajae"]);
    expect(tray?.tooltip).toBe("Needs input 1 · Working 0");
  });
});

describe("desktopStatusRenderer", () => {
  function recordingSurface() {
    const calls: string[] = [];
    return {
      calls,
      surface: {
        setTray: (tray: StatusTray | null) =>
          calls.push(`tray:${tray ? tray.title : "hidden"}`),
        setBadge: (badge: string) => calls.push(`badge:${badge}`),
      },
    };
  }

  it("updates the menu bar and the badge together as a session moves through a turn", () => {
    const { calls, surface } = recordingSurface();
    const integration = new DesktopIntegration({
      power,
      preferences: DEFAULT_DESKTOP_INTEGRATION,
      onChange: desktopStatusRenderer(surface),
    });
    integration.observe({
      type: "session.created",
      session: session("a", { status: "running" }),
    });
    integration.observe({
      type: "session.updated",
      session: session("a", { status: "waiting" }),
    });
    integration.observe({
      type: "session.updated",
      session: session("a", { status: "idle", unread: true }),
    });
    integration.observe({ type: "session.updated", session: session("a") });
    expect(calls).toEqual([
      "tray:\u25B6\uFE0E1",
      "badge:",
      "tray:\u26A0\uFE0E1",
      "badge:1",
      "tray:",
      "badge:",
    ]);
  });

  it("skips a state that renders the same", () => {
    const { calls, surface } = recordingSurface();
    const render = desktopStatusRenderer(surface);
    const state = stateOf([session("a", { status: "running" })]);
    render(state);
    render({ ...state, sessions: [...state.sessions] });
    expect(calls).toEqual(["tray:\u25B6\uFE0E1", "badge:"]);
  });

  it("redraws an unchanged state once the host language changes", () => {
    const trays: (StatusTray | null)[] = [];
    const render = desktopStatusRenderer({
      setTray: (tray) => trays.push(tray),
      setBadge: () => undefined,
    });
    const state = stateOf([session("a", { status: "running" })]);
    render(state);
    setHostLanguage("en");
    render(state);
    expect(trays.map((tray) => tray?.menu.at(-1))).toEqual([
      { kind: "open-app", label: "Gajae 열기" },
      { kind: "open-app", label: "Open Gajae" },
    ]);
  });

  it("hides and restores the menu bar item when the preference flips", () => {
    const { calls, surface } = recordingSurface();
    const render = desktopStatusRenderer(surface);
    const sessions = [session("a", { status: "running" })];
    render(stateOf(sessions));
    render(stateOf(sessions, { menuBarStatus: false }));
    render(stateOf(sessions));
    expect(calls).toEqual([
      "tray:\u25B6\uFE0E1",
      "badge:",
      "tray:hidden",
      "tray:\u25B6\uFE0E1",
    ]);
  });
});

describe("templateMask", () => {
  it("keeps only dark opaque pixels, as black", () => {
    const bitmap = Buffer.from([
      10, 20, 30, 255, // dark line art
      250, 120, 40, 255, // orange fill
      0, 0, 0, 0, // transparent corner
      20, 20, 20, 60, // dark but mostly transparent edge
    ]);
    expect([...templateMask(bitmap)]).toEqual([
      0, 0, 0, 255,
      0, 0, 0, 0,
      0, 0, 0, 0,
      0, 0, 0, 0,
    ]);
    expect([...templateMask(bitmap, { opaqueAbove: 50 })].slice(12)).toEqual([
      0, 0, 0, 255,
    ]);
  });
});
