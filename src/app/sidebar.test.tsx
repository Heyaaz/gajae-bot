import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AgentSession, BackendConnection } from "../backend/types";
import { Sidebar } from "./sidebar";

const connection: BackendConnection = {
  state: "connected",
  backend: "gjc",
  label: "GJC",
  detail: "",
  workspace: "/tmp/project",
};

function session(index: number): AgentSession {
  return {
    id: `session-${index}`,
    title: `Session ${index}`,
    subtitle: "",
    workspace: "/tmp/project",
    runtime: "gjc",
    status: index % 3 === 0 ? "running" : "idle",
    updatedAt: new Date().toISOString(),
    pinned: false,
    unread: false,
    accent: "#ffffff",
    ownership: "gajae",
    attachment: "attached",
  } as AgentSession;
}

const noop = () => undefined;

function props(sessions: AgentSession[]) {
  return {
    sessions,
    connection,
    selectedId: sessions[0]?.id ?? null,
    searchQuery: "",
    onSearchChange: noop,
    onSearchOpen: noop,
    onSelect: noop,
    onCreate: noop,
    onFork: noop,
    onResume: noop,
    onResumePicker: noop,
    onRename: noop,
    onDelete: noop,
    onSettings: noop,
    workspaceLabel: "project",
    onWorkspaceLabelChange: noop,
    updateStatus: undefined,
    updateBusy: false,
    onUpdate: noop,
  } as unknown as Parameters<typeof Sidebar>[0];
}

describe("Sidebar memoization", () => {
  it("is wrapped so a transcript chunk cannot re-render the session list", () => {
    // A streamed reply changes state the shell owns, which re-runs every child.
    // Rendering this list was measured at 1.1-1.7ms across 10 to 80 sessions, so a
    // forty-chunk reply spent 43-66ms redrawing a list that had not changed. React
    // only skips that work for a memo component, so the wrapper itself is the fix
    // and has to be asserted -- exporting the bare function would silently undo it.
    const marker = (Sidebar as unknown as { $$typeof: symbol }).$$typeof;
    expect(String(marker)).toBe("Symbol(react.memo)");
  });

  it("still renders every session it is given", () => {
    // Guards the wrapper against being satisfied by something that renders nothing.
    const sessions = [session(0), session(1), session(2)];
    const markup = renderToStaticMarkup(createElement(Sidebar, props(sessions)));
    for (const item of sessions) expect(markup).toContain(item.title);
  });
});
