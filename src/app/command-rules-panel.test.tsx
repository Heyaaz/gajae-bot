/**
 * @vitest-environment happy-dom
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectCommandRules } from "../../shared/command-rules";
import { setLanguageMode } from "../i18n";
import { CommandRulesPanel } from "./command-rules-panel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
  setLanguageMode("ko");
});

const at = "2026-11-04T00:00:00.000Z";
const PROJECTS: ProjectCommandRules[] = [
  {
    root: "/work/zeta",
    rules: [{ tool: "bash", prefix: "npm test", decision: "allow", createdAt: at }],
  },
  {
    root: "/work/alpha",
    rules: [
      { tool: "bash", prefix: "git status", decision: "allow", createdAt: at },
      { tool: "bash", prefix: "git push", decision: "reject", createdAt: at },
    ],
  },
];

async function renderPanel(bridge: Parameters<typeof CommandRulesPanel>[0]["bridge"]) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(createElement(CommandRulesPanel, { bridge }));
  });
  return container;
}

describe("CommandRulesPanel", () => {
  it("lists the rules by project with their decision", async () => {
    const container = await renderPanel({
      listCommandRules: async () => PROJECTS,
      removeCommandRule: vi.fn(),
    });
    expect([...container.querySelectorAll(".command-rules-project h3")].map((heading) => heading.textContent))
      .toEqual(["alpha/work/alpha", "zeta/work/zeta"]);
    const rows = [...container.querySelectorAll(".command-rule-row")].map((row) => row.textContent);
    expect(rows).toEqual(["허용git status", "거절git push", "허용npm test"]);
  });

  it("deletes a rule and shows what remains", async () => {
    const remove = vi.fn(async () => [PROJECTS[0]!]);
    const container = await renderPanel({ listCommandRules: async () => PROJECTS, removeCommandRule: remove });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="git push 규칙 삭제"]')!.click();
    });
    expect(remove).toHaveBeenCalledWith("/work/alpha", "git push");
    expect([...container.querySelectorAll(".command-rule-row")].map((row) => row.textContent))
      .toEqual(["허용npm test"]);
  });

  it("keeps the rules and shows the error when deleting fails", async () => {
    const container = await renderPanel({
      listCommandRules: async () => PROJECTS,
      removeCommandRule: async () => {
        throw new Error("disk full");
      },
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="npm test 규칙 삭제"]')!.click();
    });
    expect(container.querySelector(".diff-error")?.textContent).toBe("disk full");
    expect(container.querySelectorAll(".command-rule-row")).toHaveLength(3);
  });

  it("says so when no rule is saved", async () => {
    const container = await renderPanel({ listCommandRules: async () => [], removeCommandRule: vi.fn() });
    expect(container.querySelector(".settings-note")?.textContent).toContain("저장된 명령 규칙이 없습니다");
    expect(container.querySelector(".command-rule-row")).toBeNull();
  });

  it("shows the error when the rules cannot be read", async () => {
    const container = await renderPanel({
      listCommandRules: async () => {
        throw new Error("unreadable");
      },
      removeCommandRule: vi.fn(),
    });
    expect(container.querySelector(".diff-error")?.textContent).toBe("unreadable");
    expect(container.querySelector(".settings-note")).toBeNull();
  });

  it("renders nothing without the desktop bridge", async () => {
    const container = await renderPanel(undefined);
    expect(container.innerHTML).toBe("");
  });

  it("is translated", async () => {
    setLanguageMode("en");
    const container = await renderPanel({ listCommandRules: async () => PROJECTS, removeCommandRule: vi.fn() });
    expect(container.querySelector(".gjc-update-row strong")?.textContent).toBe("Command rules");
    expect(container.querySelector(".command-rule-decision--reject")?.textContent).toBe("Deny");
  });
});
