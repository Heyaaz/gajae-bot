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

  it("keeps the search row to two cells so nothing wraps", () => {
    // .sidebar-actions is a two-column grid: search plus one 32px button. A third
    // child wrapped onto its own line, so the + button ate a full row of the rail
    // while the search field stayed short of the edge.
    const markup = renderToStaticMarkup(
      createElement(Sidebar, props([session(0)])),
    );
    const row = markup.match(
      /<div class="sidebar-actions">([\s\S]*?)<div class="sidebar-scroll">/u,
    )?.[1];
    expect(row).toBeTruthy();
    expect(row!.match(/<button/gu) ?? []).toHaveLength(1);
    expect(row).toContain('title="새 Gajae 세션"');
    // Resume moved to the footer, where a label fits.
    expect(row).not.toContain("지난 세션");
    expect(markup).toContain("지난 세션 이어서 진행");
  });

  it("offers exactly one way to start a session", () => {
    // The footer used to repeat the header's + button. Two controls firing the same
    // onCreate read as two different actions, so the second one is noise in a rail
    // that is otherwise one-control-per-action.
    const markup = renderToStaticMarkup(
      createElement(Sidebar, props([session(0)])),
    );
    const occurrences = markup.split("새 Gajae 세션").length - 1;
    expect(occurrences).toBe(1);
    // And the survivor is the header button the whole app targets by title.
    expect(markup).toContain('title="새 Gajae 세션"');
  });

  it("still renders every session it is given", () => {
    // Guards the wrapper against being satisfied by something that renders nothing.
    const sessions = [session(0), session(1), session(2)];
    const markup = renderToStaticMarkup(createElement(Sidebar, props(sessions)));
    for (const item of sessions) expect(markup).toContain(item.title);
  });
});
