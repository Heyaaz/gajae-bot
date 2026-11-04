/**
 * @vitest-environment happy-dom
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolActivity } from "../backend/types";
import { setLanguageMode } from "../i18n";
import { ToolCard } from "./transcript-tool-card";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
  setLanguageMode("ko");
});

const bash = (overrides: Partial<ToolActivity> = {}): ToolActivity => ({
  id: "call-1",
  sessionId: "session-1",
  kind: "tool",
  name: "bash",
  description: "git status --short",
  command: JSON.stringify({ command: "git status --short" }),
  status: "approval-required",
  createdAt: "now",
  permissionOptions: [
    { optionId: "allow_once", kind: "allow_once", name: "Allow once" },
    { optionId: "reject_once", kind: "reject_once", name: "Reject" },
  ],
  ...overrides,
});

function render(tool: ToolActivity, onResolve = vi.fn()) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root!.render(createElement(ToolCard, { tool, onResolve }));
  });
  return { container, onResolve };
}

function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  act(() => {
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const button = (container: HTMLElement, label: string) =>
  [...container.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent === label)!;
const prefixInput = (container: HTMLElement) =>
  container.querySelector<HTMLInputElement>('input[aria-label="규칙으로 저장할 명령 앞부분"]')!;

describe("approval card command rules", () => {
  it("prefills the first two words of the command", () => {
    const { container } = render(bash());
    expect(prefixInput(container).value).toBe("git status");
  });

  it("allows the call once and remembers the prefix", () => {
    const { container, onResolve } = render(bash());
    act(() => button(container, "앞부분 항상 허용").click());
    expect(onResolve).toHaveBeenCalledWith("call-1", "allow_once", undefined, { prefix: "git status" });
  });

  it("rejects the call once with the note and remembers the prefix", () => {
    const { container, onResolve } = render(bash());
    type(container.querySelector<HTMLInputElement>('input[aria-label="거절할 때 에이전트에게 남길 말"]')!, " no ");
    act(() => button(container, "앞부분 항상 거부").click());
    expect(onResolve).toHaveBeenCalledWith("call-1", "reject_once", "no", { prefix: "git status" });
  });

  it("saves the prefix as edited, normalized", () => {
    const { container, onResolve } = render(bash());
    type(prefixInput(container), "  git   ");
    act(() => button(container, "앞부분 항상 허용").click());
    expect(onResolve).toHaveBeenCalledWith("call-1", "allow_once", undefined, { prefix: "git" });
  });

  it.each(["", "   ", "git status && rm", "git | sh", "echo $(id)"])(
    "disables both rule buttons for the prefix %j",
    (prefix) => {
      const { container, onResolve } = render(bash());
      type(prefixInput(container), prefix);
      expect(button(container, "앞부분 항상 허용").disabled).toBe(true);
      expect(button(container, "앞부분 항상 거부").disabled).toBe(true);
      act(() => button(container, "앞부분 항상 허용").click());
      expect(onResolve).not.toHaveBeenCalled();
    },
  );

  it("keeps the plain option buttons free of a rule", () => {
    const { container, onResolve } = render(bash());
    act(() => button(container, "Allow once").click());
    expect(onResolve).toHaveBeenCalledWith("call-1", "allow_once", undefined);
  });

  it("offers no rule row for another tool, a call with no command, or a decided call", () => {
    for (const tool of [
      bash({ name: "write" }),
      bash({ command: undefined }),
      bash({ status: "running", permissionOptions: undefined }),
    ]) {
      const { container } = render(tool);
      expect(prefixInput(container)).toBeNull();
      act(() => root?.unmount());
      root = undefined;
      container.remove();
    }
  });

  it("offers only the rule button whose once-only option GJC listed", () => {
    const { container } = render(
      bash({ permissionOptions: [{ optionId: "allow_once", kind: "allow_once", name: "Allow once" }] }),
    );
    expect(button(container, "앞부분 항상 허용")).toBeDefined();
    expect(button(container, "앞부분 항상 거부")).toBeUndefined();
  });
});

describe("card footer for a rule decision", () => {
  it("says which project rule allowed the call", () => {
    const { container } = render(
      bash({ status: "approved", permissionOptions: undefined, autoDecision: { decision: "allow", prefix: "git status" } }),
    );
    expect(container.querySelector(".tool-card-auto-decision")?.textContent).toContain(
      '프로젝트 규칙 "git status"로 자동 허용됨',
    );
  });

  it("says which project rule rejected the call", () => {
    const { container } = render(
      bash({ status: "denied", permissionOptions: undefined, autoDecision: { decision: "reject", prefix: "git push" } }),
    );
    expect(container.querySelector(".tool-card-auto-decision")?.textContent).toContain(
      '프로젝트 규칙 "git push"로 자동 거절됨',
    );
  });

  it("shows no footer for a call a person decided", () => {
    const { container } = render(bash({ status: "approved", permissionOptions: undefined }));
    expect(container.querySelector(".tool-card-auto-decision")).toBeNull();
  });
});
