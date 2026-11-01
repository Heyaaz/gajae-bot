/**
 * @vitest-environment happy-dom
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentConfigOption } from "../../shared/agent-contract";
import { ModelPicker } from "./composer-model-picker";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let root: Root | undefined;

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
  localStorage.clear();
});

const PROFILES = [
  { value: "opga-high", name: "OPGA High", group: "Built-in profiles" },
  { value: "codex-medium", name: "Codex Medium", group: "Built-in profiles" },
  { value: "mine", name: "Mine", group: "Custom profiles" },
];
const MODELS = Array.from({ length: 70 }, (_, index) => ({
  value: `bedrock/gpt-${index}`,
  name: `GPT ${index}`,
  group: "bedrock",
  kind: "model" as const,
}));

function option(currentValue: string, withModels = true): AgentConfigOption {
  return {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue,
    options: [...PROFILES, ...(withModels ? MODELS : [])],
  };
}

function render(props: { option: AgentConfigOption; onSelect?: (value: string) => void }) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root!.render(createElement(ModelPicker, { onSelect: vi.fn(), ...props }));
  });
  return container;
}

const names = (container: HTMLElement) =>
  [...container.querySelectorAll(".model-choice > button:first-child strong")].map(
    (strong) => strong.textContent,
  );
const groups = (container: HTMLElement) =>
  [...container.querySelectorAll(".config-option-group > strong")].map(
    (strong) => strong.textContent,
  );

function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("ModelPicker", () => {
  it("shows only the presets when the catalog has no concrete models", () => {
    const container = render({ option: option("codex-medium", false) });
    expect(container.querySelector(".model-picker-tabs")).toBeNull();
    expect(names(container)).toEqual(["Codex Medium", "OPGA High", "Mine"]);
    expect(groups(container)[0]).toBe("사용 중·즐겨찾기");
  });

  it("opens on the models tab when a concrete model is in use", () => {
    const container = render({ option: option("bedrock/gpt-3") });
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain("모델");
    expect(names(container)).toEqual(["GPT 3"]);
  });

  it("caps search results and selects a match", () => {
    const onSelect = vi.fn();
    const container = render({ option: option("opga-high"), onSelect });
    act(() => {
      container.querySelectorAll<HTMLButtonElement>('[role="tab"]')[1]!.click();
    });
    act(() => type(container.querySelector<HTMLInputElement>('input[type="search"]')!, "gpt"));
    expect(groups(container)).toEqual(["검색 결과 70개 중 60개"]);
    act(() => type(container.querySelector<HTMLInputElement>('input[type="search"]')!, "gpt 42"));
    expect(names(container)).toEqual(["GPT 42"]);
    act(() => {
      container.querySelector<HTMLButtonElement>(".model-choice > button:first-child")!.click();
    });
    expect(onSelect).toHaveBeenCalledWith("bedrock/gpt-42");
  });

  it("pins starred choices after the one in use and remembers them", () => {
    const container = render({ option: option("codex-medium", false) });
    const star = [...container.querySelectorAll<HTMLButtonElement>(".model-favorite")]
      .find((button) => button.getAttribute("aria-label") === "Mine 즐겨찾기")!;
    act(() => star.click());
    expect(names(container).slice(0, 2)).toEqual(["Codex Medium", "Mine"]);
    expect(JSON.parse(localStorage.getItem("gajae:model-favorites")!)).toEqual(["mine"]);
  });
});
