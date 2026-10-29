/**
 * @vitest-environment happy-dom
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EnvironmentReport } from "../../shared/environment-check";
import { setLanguageMode } from "../i18n";
import { EnvironmentCheckPanel } from "./environment-check-panel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let root: Root | undefined;

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
  setLanguageMode("ko");
  vi.unstubAllGlobals();
});

const cleanMac: EnvironmentReport = {
  ready: false,
  checkedAtMs: 1,
  rows: [
    {
      id: "bun",
      required: true,
      status: "missing",
      problem: "not-found",
      fix: "curl -fsSL https://bun.sh/install | bash",
    },
    {
      id: "gjc",
      required: true,
      status: "warning",
      problem: "too-old",
      detail: "0.18.11 · /Users/me/.local/bin/gjc",
      fix: "bun add -g gajae-code@latest",
    },
    { id: "model-preset", required: false, status: "ok", detail: "codex-medium" },
    {
      id: "gh",
      required: false,
      status: "warning",
      problem: "signed-out",
      fix: "gh auth login",
    },
    { id: "tailscale", required: false, status: "ok", detail: "Running" },
  ],
};

async function render(checkEnvironment: () => Promise<EnvironmentReport>) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(createElement(EnvironmentCheckPanel, { bridge: { checkEnvironment } }));
  });
  return container;
}

function rowText(container: HTMLElement, status: string): string[] {
  return [...container.querySelectorAll(`.environment-row--${status}`)].map(
    (row) => row.textContent ?? "",
  );
}

describe("EnvironmentCheckPanel", () => {
  it("shows each row's state, reason and fix command", async () => {
    const container = await render(async () => cleanMac);
    expect(container.textContent).toContain("필수 항목 중 준비되지 않은 것이 있습니다");
    expect(rowText(container, "missing")).toEqual([
      expect.stringContaining("설치되어 있지 않거나 PATH에서 찾지 못했습니다"),
    ]);
    const [gjc, gh] = rowText(container, "warning");
    expect(gjc).toContain("0.18.12 이상이 필요합니다");
    expect(gjc).toContain("0.18.11 · /Users/me/.local/bin/gjc");
    expect(gh).toContain("선택");
    expect([...container.querySelectorAll(".environment-row-fix code")].map((code) => code.textContent)).toEqual([
      "curl -fsSL https://bun.sh/install | bash",
      "bun add -g gajae-code@latest",
      "gh auth login",
    ]);
    expect(container.querySelectorAll(".environment-row--ok .environment-row-fix")).toHaveLength(0);
  });

  it("copies the exact fix command", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const container = await render(async () => cleanMac);
    const copy = container.querySelector<HTMLButtonElement>(
      ".environment-row--missing .environment-row-fix button",
    );
    await act(async () => copy!.click());
    expect(writeText).toHaveBeenCalledWith("curl -fsSL https://bun.sh/install | bash");
  });

  it("checks again on request and reports readiness in English", async () => {
    setLanguageMode("en");
    const check = vi
      .fn<() => Promise<EnvironmentReport>>()
      .mockResolvedValueOnce(cleanMac)
      .mockResolvedValueOnce({
        ready: true,
        checkedAtMs: 2,
        rows: cleanMac.rows.map((row) => ({
          id: row.id,
          required: row.required,
          status: "ok" as const,
        })),
      });
    const container = await render(check);
    expect(container.textContent).toContain("Some required items are not ready");
    const again = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Check again",
    );
    await act(async () => again!.click());
    expect(check).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("Every required item is ready");
    expect(container.textContent).toContain("Default model profile");
  });
});
