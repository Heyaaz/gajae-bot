import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AgentSession } from "../backend/types";
import { ALL_PROJECTS_ID } from "./project-model";
import type { ProjectGroup } from "./project-model";
import { ProjectList } from "./project-list";

function session(id: string, workspace: string): AgentSession {
  return {
    id,
    title: id,
    subtitle: "",
    workspace,
    runtime: "gjc",
    status: "idle",
    updatedAt: "now",
    pinned: false,
    unread: false,
    accent: "#ffffff",
    ownership: "gajae",
    attachment: "attached",
  } as AgentSession;
}

function project(
  name: string,
  root: string,
  repository: boolean,
  sessions: AgentSession[],
): ProjectGroup {
  return { id: root, name, root, repository, sessions };
}

const noop = () => undefined;

function markup(projects: ProjectGroup[], activeId = ALL_PROJECTS_ID): string {
  return renderToStaticMarkup(
    createElement(ProjectList, {
      projects,
      activeId,
      onSelect: noop,
      onOpenRepository: noop,
      onClose: noop,
    }),
  );
}

describe("ProjectList", () => {
  it("lists every project with its root and session count", () => {
    const listed = markup([
      project("gajae-bot", "/Users/me/work/gajae-bot", true, [
        session("a", "/Users/me/work/gajae-bot"),
        session("b", "/Users/me/work/gajae-bot"),
      ]),
      project("scratch", "/Users/me/scratch", false, [
        session("c", "/Users/me/scratch"),
      ]),
    ]);
    expect(listed).toContain("gajae-bot");
    expect(listed).toContain("/Users/me/work/gajae-bot");
    expect(listed).toContain("세션 2개");
    expect(listed).toContain("scratch");
    expect(listed).toContain("세션 1개");
    expect(listed).toContain("2개 프로젝트");
  });

  it("marks the active project and withholds the repository screen from a non-repository", () => {
    // A plain directory still holds sessions, so it is listed -- but it has no
    // branches, worktrees or remote to show, and offering 레포 보기 would open a
    // screen that could only apologise.
    const listed = markup(
      [
        project("gajae-bot", "/Users/me/work/gajae-bot", true, []),
        project("scratch", "/Users/me/scratch", false, []),
      ],
      "/Users/me/work/gajae-bot",
    );
    expect(listed).toContain("project-row is-active");
    expect(listed.split("레포 보기").length - 1).toBe(1);
    expect(listed).toContain("Git 레포가 아니라 레포 화면이 없습니다");
    expect(listed).toContain("Git 레포 아님");
  });

  it("explains an empty project list instead of drawing a blank screen", () => {
    const listed = markup([]);
    expect(listed).toContain("프로젝트가 없습니다");
    expect(listed).not.toContain("project-row");
  });
});
