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

function session(
  index: number,
  overrides: Partial<AgentSession> = {},
): AgentSession {
  return {
    id: `session-${index}`,
    title: `Session ${index}`,
    subtitle: "",
    workspace: "/tmp/project",
    runtime: "gjc",
    status: index % 3 === 0 ? "running" : "idle",
    updatedAt: "now",
    pinned: false,
    unread: false,
    accent: "#ffffff",
    ownership: "gajae",
    attachment: "attached",
    ...overrides,
  } as AgentSession;
}

const noop = () => undefined;

function props(
  sessions: AgentSession[],
  overrides: Partial<Parameters<typeof Sidebar>[0]> = {},
) {
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
    ...overrides,
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

function headings(markup: string): string[] {
  return [...markup.matchAll(/<header><span>([^<]*)<\/span>/gu)].map(
    (match) => match[1],
  );
}

describe("Sidebar session groups", () => {
  it("leads with the rows that are waiting on the user", () => {
    const markup = renderToStaticMarkup(
      createElement(
        Sidebar,
        props([
          session(0, { status: "idle" }),
          session(1, { status: "running" }),
          session(2, { status: "waiting" }),
          session(3, { pinned: true, status: "idle" }),
        ]),
      ),
    );
    // Pin first, then attention order: a status heading list that reads like the
    // list model instead of like the order the backend happened to send.
    expect(headings(markup)).toEqual(["고정됨", "확인 필요", "작업 중", "완료"]);
    expect(markup).not.toContain("최근 세션");
  });

  it("hides the rows past the cap behind a count", () => {
    const sessions = Array.from({ length: 7 }, (_, index) =>
      session(index, { status: "idle", updatedAtMs: 7_000 - index }),
    );
    const markup = renderToStaticMarkup(createElement(Sidebar, props(sessions)));
    expect(markup).toContain("더 보기 (2)");
    expect(markup).toContain("Session 4");
    // Rows past the cap are behind the button, not gone: the model still holds
    // them and still numbers them for ⌘-digits.
    expect(markup).not.toContain("Session 5");
    expect(markup).not.toContain("Session 6");
  });

  it("shows five rows per group before the button appears", () => {
    const sessions = Array.from({ length: 5 }, (_, index) =>
      session(index, { status: "idle" }),
    );
    const markup = renderToStaticMarkup(createElement(Sidebar, props(sessions)));
    expect(markup).not.toContain("더 보기");
    expect(markup).not.toContain("접기");
  });
});

describe("Sidebar families", () => {
  it("nests a fork under the session it came from", () => {
    const markup = renderToStaticMarkup(
      createElement(
        Sidebar,
        props([
          session(0, { id: "parent", updatedAtMs: 2_000 }),
          session(1, {
            id: "child",
            parentId: "parent",
            status: "idle",
            updatedAtMs: 1_000,
          }),
        ]),
      ),
    );
    expect(markup).toContain('data-depth="1"');
    expect(markup).toContain("session-row--nested");
    // The head carries the control, and a fork is open until the user closes it.
    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain("포크 0개 숨김");
  });

  it("places a family where its fork needs an answer", () => {
    const markup = renderToStaticMarkup(
      createElement(
        Sidebar,
        props([
          session(0, { id: "parent", status: "idle", updatedAtMs: 2_000 }),
          session(1, {
            id: "child",
            parentId: "parent",
            status: "waiting",
            updatedAtMs: 1_000,
          }),
        ]),
      ),
    );
    expect(headings(markup)).toEqual(["확인 필요"]);
    expect(markup).toContain("Session 0");
    expect(markup).toContain("Session 1");
  });

  it("gives a leaf row no family control", () => {
    const markup = renderToStaticMarkup(
      createElement(Sidebar, props([session(0, { status: "idle" })])),
    );
    expect(markup).not.toContain("session-family-toggle");
    expect(markup).not.toContain("session-row--nested");
  });
});

describe("Sidebar row state", () => {
  it("does not flag the row the user is already reading", () => {
    const markup = renderToStaticMarkup(
      createElement(
        Sidebar,
        props(
          [
            session(0, { unread: true }),
            session(1, { unread: true, status: "idle" }),
          ],
          { selectedId: "session-0" },
        ),
      ),
    );
    expect(markup.split("새 활동").length - 1).toBe(1);
  });

  it("names the trailing state dot instead of printing the state", () => {
    const markup = renderToStaticMarkup(
      createElement(
        Sidebar,
        props([
          session(0, { status: "waiting" }),
          session(1, { status: "running" }),
          session(2, { status: "idle", phase: "compacting" }),
        ]),
      ),
    );
    expect(markup).toContain('class="session-state-dot session-state-dot--waiting"');
    expect(markup).toContain('class="session-state-dot session-state-dot--running"');
    expect(markup).toContain('class="session-state-dot session-state-dot--compacting"');
    expect(markup).toContain('aria-label="확인 필요"');
    expect(markup).toContain('title="압축 중"');
  });
});
