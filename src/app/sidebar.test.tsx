import { readFile } from "node:fs/promises";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, afterEach } from "vitest";
import type { AgentSession, BackendConnection } from "../backend/types";
import { setLanguageMode } from "../i18n";
import { ALL_PROJECTS_ID } from "./project-model";
import type { ProjectGroup } from "./project-model";
import {
  consumeEscapeKey,
  projectSelectorOptions,
  SessionRow,
  Sidebar,
} from "./sidebar";
import type { SessionRowProps } from "./sidebar";

afterEach(() => setLanguageMode("ko"));

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

function project(
  name: string,
  root: string,
  sessions: AgentSession[] = [],
): ProjectGroup {
  return { id: root, name, root, repository: true, sessions };
}

function props(
  sessions: AgentSession[],
  overrides: Partial<Parameters<typeof Sidebar>[0]> = {},
) {
  return {
    sessions,
    connection,
    selectedId: sessions[0]?.id ?? null,
    projects: [project("project", "/tmp/project", sessions)],
    projectId: ALL_PROJECTS_ID,
    onProjectChange: noop,
    onOpenRepository: noop,
    onOpenProjects: noop,
    onOpenProjectGithub: noop,
    onOpenProjectFolder: noop,
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

  it("keeps the search row to one cell per grid column so nothing wraps", async () => {
    // .sidebar-actions is a grid: search plus fixed 32px buttons. A child the grid
    // has no column for wrapped onto its own line, so the + button ate a full row
    // of the rail while the search field stayed short of the edge.
    const markup = renderToStaticMarkup(
      createElement(Sidebar, props([session(0)])),
    );
    const row = markup.match(
      /<div class="sidebar-actions">([\s\S]*?)<div class="project-bar">/u,
    )?.[1];
    expect(row).toBeTruthy();
    const css = await readFile(
      path.resolve(__dirname, "../App.css"),
      "utf8",
    );
    const columns = css
      .match(/\.sidebar-actions \{[^}]*grid-template-columns:([^;]+);/u)?.[1]
      ?.trim()
      .split(/\s+(?![^(]*\))/u);
    const buttons = row!.match(/<button/gu) ?? [];
    expect(buttons.length + 1).toBe(columns?.length);
    expect(row).toContain('title="새 Gajae 세션"');
    expect(row).toContain('title="Inbox (⌥⌘U)"');
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

describe("Sidebar runtime version warning", () => {
  it("warns about a runtime older than the minimum and stays quiet otherwise", () => {
    const old = renderToStaticMarkup(
      createElement(
        Sidebar,
        props([session(0)], {
          connection: { ...connection, version: "0.18.10" },
        }),
      ),
    );
    expect(old).toContain('class="gjc-version-warning" role="alert"');
    expect(old).toContain("older than the required 0.18.12");
    expect(old).toContain("gjc update");

    const current = renderToStaticMarkup(
      createElement(
        Sidebar,
        props([session(0)], {
          connection: { ...connection, version: "0.18.12" },
        }),
      ),
    );
    expect(current).not.toContain("gjc-version-warning");

    // An unknown version is not evidence of an old runtime.
    const unknown = renderToStaticMarkup(
      createElement(Sidebar, props([session(0)])),
    );
    expect(unknown).not.toContain("gjc-version-warning");
  });
});

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
    expect(headings(markup)).toEqual(["고정됨", "Needs input", "Working", "Done"]);
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
    expect(markup).toContain("Fork 0 hidden");
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
    expect(headings(markup)).toEqual(["Needs input"]);
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
    expect(markup).toContain('aria-label="Needs input"');
    expect(markup).toContain('title="Compacting"');
  });
});

/**
 * The handlers sit on the elements SessionRow builds, and the component is a plain
 * function, so the row can be driven without a DOM: what it returns is the row, and
 * the keys and clicks it reacts to are the props on the elements under it.
 */
interface TestEvent {
  key: string;
  target: unknown;
  currentTarget: unknown;
  defaultPrevented: boolean;
  propagationStopped: boolean;
  preventDefault: () => void;
  stopPropagation: () => void;
}

interface TestElement {
  props: {
    className?: string;
    children?: unknown;
    onClick?: (event: TestEvent) => void;
    onKeyDown?: (event: TestEvent) => void;
  };
}

function testEvent(
  key: string,
  target: unknown,
  currentTarget: unknown = target,
): TestEvent {
  const event: TestEvent = {
    key,
    target,
    currentTarget,
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault: () => {
      event.defaultPrevented = true;
    },
    stopPropagation: () => {
      event.propagationStopped = true;
    },
  };
  return event;
}

function rowElement(overrides: Partial<SessionRowProps> = {}): TestElement {
  return SessionRow({
    session: session(0, { status: "idle" }),
    selected: false,
    renaming: false,
    renameValue: "",
    onSelect: noop,
    onContextMenu: noop,
    onRenameChange: noop,
    onRenameCommit: noop,
    onRenameCancel: noop,
    ...overrides,
  }) as unknown as TestElement;
}

function findByClass(node: unknown, className: string): TestElement | null {
  if (typeof node !== "object" || node === null) return null;
  const element = node as TestElement;
  if (!("props" in element)) return null;
  if (element.props.className === className) return element;
  const children = Array.isArray(element.props.children)
    ? element.props.children
    : [element.props.children];
  for (const child of children) {
    const found = findByClass(child, className);
    if (found) return found;
  }
  return null;
}

describe("Sidebar row keyboard", () => {
  it("selects once for Enter and Space, and stops what Space would do", () => {
    // The row is a div, so nothing but this handler keeps Space from scrolling the
    // list out from under the row the user just picked, and nothing keeps the key
    // from selecting twice.
    for (const key of ["Enter", " "]) {
      const selects: string[] = [];
      const row = rowElement({ onSelect: () => selects.push("select") });
      const event = testEvent(key, row);
      row.props.onKeyDown!(event);
      expect(selects).toHaveLength(1);
      expect(event.defaultPrevented).toBe(true);
    }

    // A key the row does not own leaves before the default is touched, so it still
    // reaches whatever is listening for it above the row.
    const ignores: string[] = [];
    const row = rowElement({ onSelect: () => ignores.push("select") });
    const other = testEvent("a", row);
    row.props.onKeyDown!(other);
    expect(ignores).toEqual([]);
    expect(other.defaultPrevented).toBe(false);
  });

  it("leaves a nested control's keyboard activation to the control", () => {
    // Enter or Space on the focused family disclosure bubbles to the row. While the
    // row claimed it, the head was selected and the forks it holds stayed shut: the
    // row ate the key, so the button's own activation never ran either.
    const selects: string[] = [];
    const toggles: string[] = [];
    const row = rowElement({
      onToggleFamily: () => toggles.push("toggle"),
      onSelect: () => selects.push("select"),
    });
    const toggle = findByClass(row, "session-family-toggle");
    expect(toggle).toBeTruthy();
    // A key on the button arrives at the row with the button as the target and the
    // row as the current target, which is the pair the row has to tell apart.
    const keydown = testEvent(" ", toggle, row);
    row.props.onKeyDown!(keydown);
    expect(selects).toEqual([]);
    // Left alone, the button keeps the default that makes it toggle.
    expect(keydown.defaultPrevented).toBe(false);

    const click = testEvent("", toggle);
    toggle!.props.onClick!(click);
    expect(toggles).toHaveLength(1);
    expect(click.propagationStopped).toBe(true);
    expect(selects).toEqual([]);
  });

  it("closes the rename field on Escape instead of selecting the row", () => {
    const selects: string[] = [];
    const cancels: string[] = [];
    const row = rowElement({
      renaming: true,
      renameValue: "Session 0",
      onRenameCancel: () => cancels.push("cancel"),
      onSelect: () => selects.push("select"),
    });
    const input = findByClass(row, "session-rename-input");
    expect(input).toBeTruthy();
    const event = testEvent("Escape", input);
    input!.props.onKeyDown!(event);
    expect(cancels).toHaveLength(1);
    expect(event.defaultPrevented).toBe(true);
    expect(event.propagationStopped).toBe(true);
    expect(selects).toEqual([]);
  });

  it("consumes Escape for the workspace field too", () => {
    // The workspace field is the other inline editor, and it sits behind state a
    // render-free test cannot open, so the consumer both fields call is asserted
    // here. Without it the key reached the app-wide handler, which cancels the
    // running session instead of closing the field.
    const escape = testEvent("Escape", null);
    expect(consumeEscapeKey(escape)).toBe(true);
    expect(escape.defaultPrevented).toBe(true);
    expect(escape.propagationStopped).toBe(true);

    const letter = testEvent("a", null);
    expect(consumeEscapeKey(letter)).toBe(false);
    expect(letter.defaultPrevented).toBe(false);
    expect(letter.propagationStopped).toBe(false);
  });
});

describe("Sidebar project selector", () => {
  it("leads with 전체 프로젝트 and disambiguates duplicate names", () => {
    // Two repositories can share a directory name. A dropdown with two identical
    // labels cannot be used, so a repeated name carries its parent directory.
    const options = projectSelectorOptions([
      project("gajae-bot", "/Users/me/work/gajae-bot"),
      project("gajae-bot", "/Users/me/scratch/gajae-bot"),
      project("hermes", "/Users/me/hermes"),
    ]);
    expect(options[0]).toEqual({
      value: ALL_PROJECTS_ID,
      label: "전체 프로젝트",
    });
    expect(options.map((option) => option.label)).toEqual([
      "전체 프로젝트",
      "gajae-bot (work)",
      "gajae-bot (scratch)",
      "hermes",
    ]);
    expect(options[1]!.value).toBe("/Users/me/work/gajae-bot");
  });

  it("offers the repository entry point only for one project", () => {
    // From 전체 프로젝트 there is no single repository to open, so the rail offers
    // the project list instead of guessing one.
    const all = renderToStaticMarkup(
      createElement(Sidebar, props([session(0)])),
    );
    expect(all).toContain("프로젝트 목록");
    expect(all).not.toContain("레포 보기");

    const one = renderToStaticMarkup(
      createElement(
        Sidebar,
        props([session(0)], { projectId: "/tmp/project" }),
      ),
    );
    expect(one).toContain("<span>레포 보기</span>");
    expect(one).not.toContain("프로젝트 목록");
  });

  it("names the project in the selector and keeps one entry point per action", () => {
    const markup = renderToStaticMarkup(
      createElement(
        Sidebar,
        props([session(0)], {
          projects: [project("gajae-bot", "/Users/me/work/gajae-bot")],
          projectId: "/Users/me/work/gajae-bot",
        }),
      ),
    );
    expect(markup).toContain('aria-label="프로젝트 선택"');
    expect(markup).toContain("gajae-bot");
    // One visible entry point; the title attribute repeats the words on purpose.
    expect(markup.split("<span>레포 보기</span>").length - 1).toBe(1);
  });

  it("renders the empty rail in English when English is selected", () => {
    setLanguageMode("en");
    const markup = renderToStaticMarkup(createElement(Sidebar, props([])));
    expect(markup).toContain("No sessions");
    expect(markup).toContain("View past sessions");
    expect(markup).not.toContain("세션이 없습니다");
  });

  it("tells an empty project apart from an empty rail", () => {
    // A project with no sessions is a filter to widen, not a missing session, so the
    // empty list offers the way back to the whole rail instead of the resume picker.
    const empty = renderToStaticMarkup(
      createElement(Sidebar, props([], { projectId: "/tmp/project" })),
    );
    expect(empty).toContain("이 프로젝트에 세션이 없습니다");
    expect(empty).toContain("전체 프로젝트 보기");
    expect(empty).not.toContain("지난 세션 보기");

    const allEmpty = renderToStaticMarkup(createElement(Sidebar, props([])));
    expect(allEmpty).toContain("세션이 없습니다");
    expect(allEmpty).toContain("지난 세션 보기");
  });

  it("keeps the repository entry point out of the row it belongs to", () => {
    // The entry point is a visible button next to the selector; hiding it behind the
    // row's right-click menu is exactly what the issue rules out.
    const markup = renderToStaticMarkup(
      createElement(
        Sidebar,
        props([session(0)], { projectId: "/tmp/project" }),
      ),
    );
    const bar = markup.match(/<div class="project-bar">([\s\S]*?)<\/div><\/div>/u)?.[1];
    expect(bar).toBeTruthy();
    expect(bar).toContain('class="project-entry"');
    expect(bar).toContain("레포 보기");
  });
});
