import { readFile } from "node:fs/promises";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentSession,
  SessionStatus,
  TranscriptItem,
} from "../backend/types";
import { ALL_PROJECTS_ID } from "./project-model";
import type { ProjectGroup } from "./project-model";
import App, {
  composerTurnLive,
  escapeCancelsRun,
  isTextEntryTarget,
} from "./shell";

/**
 * The shell is exercised without a DOM: it renders to static markup, and the state
 * a live client keeps lives in the positional store below. Every render pass
 * numbers the `useState` calls in order and a setter writes the slot its own hook
 * owns, so driving the captured props and re-rendering shows the tree an
 * interaction leaves behind -- which is how a test can watch a row leave the
 * sidebar while the backend delete is still in flight.
 */
const actionProbe = vi.hoisted(() => {
  const stateChanges = vi.fn();
  const store = {
    index: 0,
    slots: new Map<number, unknown>(),
    reset(): void {
      this.index = 0;
      this.slots = new Map();
    },
    /** Starts a render pass, so hook slots are numbered from zero again. */
    beginPass(): void {
      this.index = 0;
    },
    hook(initial: unknown): [unknown, (update: unknown) => void] {
      const slot = this.index++;
      if (!this.slots.has(slot))
        this.slots.set(
          slot,
          typeof initial === "function"
            ? (initial as () => unknown)()
            : initial,
        );
      return [
        this.slots.get(slot),
        (update: unknown) => {
          const current = this.slots.get(slot);
          this.slots.set(
            slot,
            typeof update === "function"
              ? (update as (value: unknown) => unknown)(current)
              : update,
          );
          stateChanges(update);
        },
      ];
    },
  };
  return {
    rename: vi.fn(),
    forkSession: vi.fn(),
    deleteSession: vi.fn(),
    stateChanges,
    store,
    onRename: null as null | ((id: string, title: string) => void),
    sidebar: null as null | {
      sessions: AgentSession[];
      selectedId: string | null;
      projects: ProjectGroup[];
      projectId: string;
      onSelect: (sessionId: string) => void;
      onRename: (id: string, title: string) => void;
      onDelete: (session: AgentSession) => void;
      onFork: (session: AgentSession) => void;
      onProjectChange: (projectId: string) => void;
      onOpenRepository: () => void;
      onOpenProjects: () => void;
    },
    repo: null as null | { project: { root: string } },
    projectsView: null as null | { projects: ProjectGroup[] },
    deleteDialog: null as null | {
      session: AgentSession;
      onConfirm: () => void;
    },
    reset(): void {
      store.reset();
      this.rename.mockReset();
      this.forkSession.mockReset();
      this.deleteSession.mockReset();
      stateChanges.mockReset();
      this.onRename = null;
      this.sidebar = null;
      this.repo = null;
      this.projectsView = null;
      this.deleteDialog = null;
    },
  };
});

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) => actionProbe.store.hook(initial),
  };
});

vi.mock("../backend/use-agent-backend", () => ({
  useAgentBackend: () => ({
    renameSession: actionProbe.rename,
    forkSession: actionProbe.forkSession,
    deleteSession: actionProbe.deleteSession,
  }),
}));

// The children are shallow stand-ins so the shell's own props and the store above
// stay the only state in the tree; the sidebar and the delete dialog hold the
// props the delete tests drive.
vi.mock("./sidebar", () => ({
  Sidebar: (props: {
    sessions: AgentSession[];
    selectedId: string | null;
    projects: ProjectGroup[];
    projectId: string;
    onSelect: (sessionId: string) => void;
    onRename: (id: string, title: string) => void;
    onDelete: (session: AgentSession) => void;
    onFork: (session: AgentSession) => void;
    onProjectChange: (projectId: string) => void;
    onOpenRepository: () => void;
    onOpenProjects: () => void;
  }) => {
    actionProbe.sidebar = props;
    actionProbe.onRename = props.onRename;
    return null;
  },
}));

vi.mock("./dialogs", () => ({
  DeleteSessionDialog: (props: {
    session: AgentSession;
    onConfirm: () => void;
  }) => {
    actionProbe.deleteDialog = props;
    return null;
  },
  GlobalSearchDialog: () => null,
  NewSessionDialog: () => null,
  ResumeSessionDialog: () => null,
}));

vi.mock("./composer", () => ({ Composer: () => null }));
vi.mock("./transcript", () => ({
  RecentRequestStrip: () => null,
  Transcript: () => null,
}));
vi.mock("./inspector", () => ({
  DiffPanel: () => null,
  GoalProgressRow: () => null,
  Inspector: () => null,
}));
vi.mock("./settings", () => ({ SettingsDialog: () => null }));
vi.mock("./repo-view", () => ({
  RepoView: (props: { project: { root: string } }) => {
    actionProbe.repo = props;
    return null;
  },
}));
vi.mock("./project-list", () => ({
  ProjectList: (props: { projects: ProjectGroup[] }) => {
    actionProbe.projectsView = props;
    return null;
  },
}));
vi.mock("./remote", () => ({
  RemoteGate: () => null,
  RemoteStrip: () => null,
  remoteGateNeeded: () => false,
}));

const root = path.resolve(import.meta.dirname, "../..");

async function source(file: string): Promise<string> {
  return await readFile(path.join(root, file), "utf8");
}

function press(
  overrides: Partial<Parameters<typeof escapeCancelsRun>[0]> = {},
): Parameters<typeof escapeCancelsRun>[0] {
  return {
    key: "Escape",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    defaultPrevented: false,
    textEntry: false,
    surfaceOpen: false,
    ...overrides,
  };
}

describe("Escape routing", () => {
  it("cancels the selected run for a plain Escape", () => {
    expect(escapeCancelsRun(press())).toBe(true);
    expect(escapeCancelsRun(press({ key: "Esc" }))).toBe(true);
  });

  it("leaves the key to whatever the user is typing into", () => {
    // The bug: a captured Escape reached the abort shortcut before the rename field
    // ever saw it, so closing the editor also cancelled the run behind it.
    expect(escapeCancelsRun(press({ textEntry: true }))).toBe(false);
    // The composer cancels the run from its own handler, so the shell must not fire a
    // second cancel on top of that one.
  });

  it("does not abort behind a surface that owns the key", () => {
    // The resume picker was the case that leaked: its Escape binding sits on the
    // search field, so Escape anywhere else in the dialog cancelled the run behind it.
    expect(escapeCancelsRun(press({ surfaceOpen: true }))).toBe(false);
  });

  it("ignores keys, chords and keys something else already took", () => {
    expect(escapeCancelsRun(press({ key: "Enter" }))).toBe(false);
    expect(escapeCancelsRun(press({ metaKey: true }))).toBe(false);
    expect(escapeCancelsRun(press({ ctrlKey: true }))).toBe(false);
    expect(escapeCancelsRun(press({ altKey: true }))).toBe(false);
    expect(escapeCancelsRun(press({ shiftKey: true }))).toBe(false);
    expect(escapeCancelsRun(press({ defaultPrevented: true }))).toBe(false);
  });
});

function tool(status: "running" | "approval-required"): TranscriptItem {
  return {
    id: `tool-${status}`,
    kind: "tool",
    sessionId: "session-1",
    name: "bash",
    description: "bun test",
    status,
    createdAt: "10:02",
  };
}

function streamingThought(): TranscriptItem {
  return {
    id: "thought-1",
    kind: "thought",
    sessionId: "session-1",
    content: "reading the controller",
    streaming: true,
    createdAt: "10:03",
  };
}

function streamingMessage(): TranscriptItem {
  return {
    id: "message-1",
    kind: "message",
    sessionId: "session-1",
    role: "assistant",
    content: "the fix is in",
    streaming: true,
    createdAt: "10:04",
  };
}

/**
 * The plan row the composer must not read as work: it stays in_progress after the
 * turn ended.
 */
function planInProgress(): TranscriptItem {
  return {
    id: "plan-1",
    kind: "plan",
    sessionId: "session-1",
    entries: [{ content: "ship the fix", status: "in_progress" }],
    createdAt: "10:05",
  };
}

function sessionState(
  status: SessionStatus | undefined,
  phase?: string,
): { status: SessionStatus | undefined; phase: string | undefined } {
  return { status, phase };
}

describe("composer turn state", () => {
  it("settles an idle row whose transcript still shows an unfinished turn", () => {
    // The reported bug: the row read 완료, but a tool card left `running` (or a
    // message left `streaming`) by the finished turn still outranked it, so the
    // composer held the next message as a steer and only released it after some
    // unrelated interaction.
    expect(composerTurnLive(sessionState("idle"), [tool("running")])).toBe(
      false,
    );
    expect(composerTurnLive(sessionState("idle"), [streamingThought()])).toBe(
      false,
    );
    expect(composerTurnLive(sessionState("idle"), [streamingMessage()])).toBe(
      false,
    );
  });

  it("does not hold messages behind a failed turn either", () => {
    // A failed row has no live turn left to steer into, and the release effect
    // only drains the composer's own queue on a running -> idle transition, so
    // reading this as running swallowed the message for good.
    expect(composerTurnLive(sessionState("failed"), [tool("running")])).toBe(
      false,
    );
  });

  it("keeps the states the composer really does queue behind", () => {
    expect(composerTurnLive(sessionState("running"), [])).toBe(true);
    expect(composerTurnLive(sessionState("waiting"), [])).toBe(true);
    // Compaction outlives the turn that started it and writes no live transcript
    // row of its own, so the row is the only account of it.
    expect(composerTurnLive(sessionState("idle", "compacting"), [])).toBe(true);
    expect(composerTurnLive(sessionState("running"), [tool("running")])).toBe(
      true,
    );
  });

  it("reads live transcript work while the row cannot answer yet", () => {
    // A starting session has not reported a turn, so work already underway there
    // is only visible in the transcript. The same holds before any row arrives.
    expect(composerTurnLive(sessionState("starting"), [tool("running")])).toBe(
      true,
    );
    expect(
      composerTurnLive(sessionState(undefined), [streamingMessage()]),
    ).toBe(true);
    expect(composerTurnLive(sessionState("starting"), [])).toBe(false);
    expect(composerTurnLive(null, [tool("running")])).toBe(false);
  });

  it("does not count the transcript rows that outlive their turn", () => {
    // A tool card awaiting approval and a plan entry left in_progress both stay
    // after the turn ended; counting either queued every later message.
    const afterTurn = [tool("approval-required"), planInProgress()];
    expect(composerTurnLive(sessionState("starting"), afterTurn)).toBe(false);
    expect(composerTurnLive(sessionState("idle"), afterTurn)).toBe(false);
  });
});

describe("text entry detection", () => {
  it("recognises the fields that own Escape", () => {
    expect(isTextEntryTarget({ tagName: "INPUT" })).toBe(true);
    expect(isTextEntryTarget({ tagName: "TEXTAREA" })).toBe(true);
    expect(isTextEntryTarget({ tagName: "SELECT" })).toBe(true);
    expect(isTextEntryTarget({ tagName: "DIV", isContentEditable: true })).toBe(
      true,
    );
  });

  it("does not claim a button, the page, or a missing target", () => {
    expect(isTextEntryTarget({ tagName: "BUTTON" })).toBe(false);
    expect(isTextEntryTarget({ tagName: "DIV" })).toBe(false);
    expect(isTextEntryTarget(null)).toBe(false);
  });
});

describe("Escape keyboard routing", () => {
  it("leaves Escape to the renderer instead of the native key forwarder", async () => {
    const main = await source("electron/main.ts");
    const handler = main.slice(main.indexOf('"before-input-event"'));
    const body = handler.slice(0, handler.indexOf('"will-navigate"'));
    // before-input-event runs ahead of every renderer handler and cannot see which
    // element has focus, so an Escape forwarded from there cancels runs the user is
    // still editing. The renderer DOM owns the key now.
    expect(body).toBeTruthy();
    expect(body).not.toContain('input.key === "Escape"');
    expect(body).not.toMatch(/send\(DESKTOP_IPC\.abortRun\)/u);
    // Shift+Tab is still forwarded: it is a shell-wide command with no editor meaning.
    expect(body).toContain("DESKTOP_IPC.cycleEffort");
  });

  it("listens in the bubble phase so a nearer handler gets the key first", async () => {
    const shell = await source("src/app/shell.tsx");
    expect(shell).toContain('window.addEventListener("keydown", abortWithEscape)');
    expect(shell).not.toContain(
      'window.addEventListener("keydown", abortWithEscape, true)',
    );
  });

  it("counts the resume picker among the surfaces that own Escape", async () => {
    const shell = await source("src/app/shell.tsx");
    const gate =
      shell.match(/const dismissibleSurfaceOpen =\n([\s\S]*?);\n/u)?.[1] ?? "";
    expect(gate).toBeTruthy();
    for (const surface of [
      "searchOpen",
      "newSessionOpen",
      "resumeOpen",
      "settingsOpen",
      "deleteCandidate",
    ])
      expect(gate).toContain(surface);
  });
});

describe("sidebar rename failures", () => {
  it("handles a rejected rename and surfaces its error", async () => {
    vi.stubGlobal("window", {});
    actionProbe.stateChanges.mockClear();
    actionProbe.rename.mockRejectedValueOnce(new Error("permission denied"));
    try {
      renderApp();
      expect(actionProbe.onRename).not.toBeNull();
      actionProbe.onRename!("session-id", "New title");
      await vi.waitFor(() => {
        expect(actionProbe.rename).toHaveBeenCalledWith("session-id", "New title");
        expect(actionProbe.stateChanges).toHaveBeenCalledWith("permission denied");
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("transcript loading failures", () => {
  it("does not cache a failed fetch as an empty transcript", async () => {
    const shell = await source("src/app/shell.tsx");
    const failure = shell.match(/\.catch\(\(error\) => \{\n        if \(!active\) return;([\s\S]*?)\n      \}\);/u)?.[1];
    expect(failure).toContain("setAppError(humanErrorMessage(error))");
    expect(failure).not.toContain("cacheTranscript");
  });
});

describe("session-scoped goal updates", () => {
  it("ignores a late goal operation result after selection changes", async () => {
    const shell = await source("src/app/shell.tsx");
    expect(shell).toContain(
      "if (selectedIdRef.current === sessionId) setGoal(snapshot);",
    );
    expect(shell).toContain("goalBusySessionId === selectedSession.id");
  });
});

describe("asynchronous session navigation", () => {
  it("does not let a late history or fork result replace a newer selection", async () => {
    const shell = await source("src/app/shell.tsx");
    expect(shell).toContain("navigationGenerationRef.current += 1");
    expect(shell).toContain(
      "if (navigationGenerationRef.current === navigationGeneration)\n        setSelectedId(opened.id);",
    );
    expect(shell).toContain(
      "if (navigationGenerationRef.current === navigationGeneration)\n        setSelectedId(fork.id);",
    );
  });
});

/** The next state the shell would render, from the store's current slot values. */
function renderApp(): string {
  actionProbe.sidebar = null;
  actionProbe.deleteDialog = null;
  // These two record what the center area held in this pass, so they start empty
  // for every pass instead of reporting the last view that happened to render.
  actionProbe.repo = null;
  actionProbe.projectsView = null;
  actionProbe.store.beginPass();
  return renderToStaticMarkup(createElement(App));
}

/** Lets the handlers started by a captured prop run past their next await. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function session(
  id: string,
  overrides: Partial<AgentSession> = {},
): AgentSession {
  return {
    id,
    title: `세션 ${id}`,
    subtitle: "gajae-bot",
    workspace: "/tmp/gajae-bot",
    runtime: "gjc",
    status: "idle",
    updatedAt: "10:00",
    updatedAtMs: 1,
    pinned: false,
    unread: false,
    accent: "#ff8a34",
    ownership: "gajae",
    attachment: "attached",
    ...overrides,
  };
}

describe("session delete optimism", () => {
  beforeEach(() => {
    vi.stubGlobal("window", {});
    actionProbe.reset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Puts one live row in the shell through its own fork path, as listed rows are. */
  async function seedRow(row: AgentSession): Promise<void> {
    actionProbe.forkSession.mockResolvedValueOnce(row);
    renderApp();
    actionProbe.sidebar!.onFork(session("source-1"));
    await settle();
    renderApp();
    expect(actionProbe.sidebar!.sessions.map((item) => item.id)).toEqual([
      row.id,
    ]);
  }

  /** Opens the delete dialog for the row and confirms it. */
  function confirmDelete(row: AgentSession): void {
    actionProbe.sidebar!.onDelete(row);
    renderApp();
    expect(actionProbe.deleteDialog!.session.id).toBe(row.id);
    actionProbe.deleteDialog!.onConfirm();
  }

  it("drops the row before the backend delete settles, and keeps it gone", async () => {
    // The reported lag: the row stayed in the sidebar until close, broker lookup and
    // delete had each walked the CLI, because only the runtime's own event removed
    // it. The confirm now removes it first and the event that follows is a no-op.
    const row = session("session-1");
    const removal = deferred<void>();
    actionProbe.deleteSession.mockReturnValueOnce(removal.promise);

    await seedRow(row);
    confirmDelete(row);

    // The render right after the click already shows the sidebar without the row,
    // and the backend has not even been asked yet -- the delete is still behind
    // resolveSessionId. The detail pane left with the selection.
    const markup = renderApp();
    expect(actionProbe.sidebar!.sessions).toEqual([]);
    expect(actionProbe.sidebar!.selectedId).toBeNull();
    expect(actionProbe.deleteDialog).toBeNull();
    expect(markup).toContain("선택된 Gajae 세션이 없습니다");
    expect(actionProbe.deleteSession).not.toHaveBeenCalled();

    await settle();
    expect(actionProbe.deleteSession).toHaveBeenCalledWith(row.id);

    removal.resolve();
    await settle();
    const settled = renderApp();
    expect(actionProbe.sidebar!.sessions).toEqual([]);
    expect(settled).not.toContain("app-error");
  });

  it("puts the row and the selection back when the backend delete fails", async () => {
    const row = session("session-1");
    const removal = deferred<void>();
    actionProbe.deleteSession.mockReturnValueOnce(removal.promise);

    await seedRow(row);
    confirmDelete(row);
    renderApp();
    expect(actionProbe.sidebar!.sessions).toEqual([]);

    removal.reject(new Error("세션을 지우지 못했습니다"));
    await settle();
    expect(actionProbe.deleteSession).toHaveBeenCalledWith(row.id);
    const markup = renderApp();

    expect(actionProbe.sidebar!.sessions.map((item) => item.id)).toEqual([
      row.id,
    ]);
    expect(actionProbe.sidebar!.selectedId).toBe(row.id);
    expect(actionProbe.stateChanges).toHaveBeenCalledWith(
      "세션을 지우지 못했습니다",
    );
    // The error is what the app-error bar renders, and the detail pane is back.
    expect(markup).toContain("세션을 지우지 못했습니다");
    expect(markup).toContain(row.title);
  });
});

describe("project scope", () => {
  beforeEach(() => {
    vi.stubGlobal("window", {});
    actionProbe.reset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Puts one row in the shell through the fork path, as the listing does. */
  async function seed(row: AgentSession): Promise<void> {
    actionProbe.forkSession.mockResolvedValueOnce(row);
    renderApp();
    actionProbe.sidebar!.onFork(session("source-1"));
    await settle();
    renderApp();
  }

  it("groups a managed worktree under its source project instead of a second one", async () => {
    // The worktree is a checkout of the same repository, so its session belongs to
    // the same project. Without that rule the rail offered two projects for one
    // repository as soon as the user asked for a worktree session.
    await seed(session("plain"));
    actionProbe.forkSession.mockResolvedValueOnce(
      session("worktree", {
        workspace: "/tmp/gajae-bot/.gajae-worktrees/feature",
        worktree: {
          sourceWorkspace: "/tmp/gajae-bot",
          path: "/tmp/gajae-bot/.gajae-worktrees/feature",
          branch: "feature",
          managed: true,
        },
      }),
    );
    actionProbe.sidebar!.onFork(session("source-2"));
    await settle();
    renderApp();

    expect(actionProbe.sidebar!.projects).toHaveLength(1);
    expect(actionProbe.sidebar!.projects[0]!.id).toBe("/tmp/gajae-bot");
    expect(actionProbe.sidebar!.projects[0]!.sessions).toHaveLength(2);
  });

  it("filters the rail to one project while keeping the project context", async () => {
    await seed(session("first"));
    actionProbe.forkSession.mockResolvedValueOnce(
      session("second", { workspace: "/tmp/other-repo" }),
    );
    actionProbe.sidebar!.onFork(session("source-2"));
    await settle();
    renderApp();
    expect(actionProbe.sidebar!.sessions).toHaveLength(2);

    const selected = actionProbe.sidebar!.projects.find(
      (group) => group.id === "/tmp/other-repo",
    )!;
    actionProbe.sidebar!.onProjectChange(selected.id);
    const filtered = renderApp();
    expect(actionProbe.sidebar!.projectId).toBe("/tmp/other-repo");
    expect(actionProbe.sidebar!.sessions.map((item) => item.id)).toEqual([
      "second",
    ]);
    // Filtering the rail is not a session pick, so the center stays where it was.
    expect(filtered).toContain("세션 second");
  });

  it("opens the repository screen for the chosen project and comes back on a session pick", async () => {
    await seed(session("first"));
    expect(actionProbe.repo).toBeNull();

    actionProbe.sidebar!.onProjectChange("/tmp/gajae-bot");
    renderApp();
    actionProbe.sidebar!.onOpenRepository();
    renderApp();
    expect(actionProbe.repo!.project.root).toBe("/tmp/gajae-bot");

    // A session pick returns to the conversation with the project still selected:
    // the context the user chose outlives the session they were reading.
    actionProbe.sidebar!.onSelect("first");
    renderApp();
    expect(actionProbe.repo).toBeNull();
    expect(actionProbe.sidebar!.projectId).toBe("/tmp/gajae-bot");
    expect(actionProbe.sidebar!.selectedId).toBe("first");
  });

  it("never opens one repository straight from 전체 프로젝트", async () => {
    await seed(session("first"));
    // 전체 프로젝트 offers the project list, and the repository screen is only
    // reachable after a project has been named.
    expect(actionProbe.sidebar!.projectId).toBe(ALL_PROJECTS_ID);
    actionProbe.sidebar!.onOpenProjects();
    renderApp();
    expect(actionProbe.projectsView).not.toBeNull();
    expect(actionProbe.repo).toBeNull();
    expect(actionProbe.projectsView!.projects).toHaveLength(1);

    // Choosing one from the list is what opens its repository screen.
    actionProbe.projectsView = null;
    actionProbe.sidebar!.onProjectChange("/tmp/gajae-bot");
    renderApp();
    actionProbe.sidebar!.onOpenRepository();
    renderApp();
    expect(actionProbe.repo!.project.root).toBe("/tmp/gajae-bot");
  });

  it("leaves the repository screen when the rail goes back to 전체 프로젝트", async () => {
    await seed(session("first"));
    actionProbe.sidebar!.onProjectChange("/tmp/gajae-bot");
    renderApp();
    actionProbe.sidebar!.onOpenRepository();
    renderApp();
    expect(actionProbe.repo).not.toBeNull();

    // 전체 프로젝트 is not one repository, so there is nothing for that screen to
    // show: leaving it open would have to pick a project the user never chose.
    actionProbe.sidebar!.onProjectChange(ALL_PROJECTS_ID);
    renderApp();
    expect(actionProbe.repo).toBeNull();
    expect(actionProbe.projectsView).toBeNull();
    expect(actionProbe.sidebar!.sessions).toHaveLength(1);
  });
});

describe("rail order under project grouping", () => {
  beforeEach(() => {
    vi.stubGlobal("window", {});
    actionProbe.reset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps the backend's session order instead of re-sorting by project", async () => {
    // The regression the desktop smoke caught: filtering for 전체 프로젝트 read the
    // sessions back group by group, and because group order is alphabetical by
    // project name, a pinned row from /tmp/aaa jumped ahead of the pinned row the
    // backend listed first. The rail ranks its own rows; filtering may only remove.
    const order = ["/tmp/zzz-last", "/tmp/aaa-first"];
    for (const [index, workspace] of order.entries()) {
      actionProbe.forkSession.mockResolvedValueOnce(
        session(`row-${index}`, { workspace, title: `세션 ${index}` }),
      );
      renderApp();
      actionProbe.sidebar!.onFork(session(`source-${index}`));
      await settle();
      renderApp();
    }

    expect(
      actionProbe.sidebar!.projects.map((group) => group.name),
    ).toEqual(["aaa-first", "zzz-last"]);
    // The shell holds the newest fork first, which is the exact reverse of the
    // alphabetical project order: a filter that rebuilt the list from groups would
    // hand back [row-0, row-1] here.
    expect(actionProbe.sidebar!.sessions.map((row) => row.id)).toEqual([
      "row-1",
      "row-0",
    ]);
  });
});
