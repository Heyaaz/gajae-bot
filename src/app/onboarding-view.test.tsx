/**
 * @vitest-environment happy-dom
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OnboardingDesktopBridge, OnboardingEvent, OnboardingStep } from "../../shared/onboarding";
import { OnboardingView } from "./onboarding-view";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function fakeBridge() {
  let listener: ((event: OnboardingEvent) => void) | undefined;
  const install = deferred<{ version: string }>();
  let signIn = deferred<void>();
  const bridge = {
    pendingStep: vi.fn(async () => null),
    installGjc: vi.fn(() => install.promise),
    signIn: vi.fn(() => {
      signIn = deferred<void>();
      return signIn.promise;
    }),
    answer: vi.fn(async () => undefined),
    cancelSignIn: vi.fn(async () => undefined),
    dismiss: vi.fn(async () => undefined),
    onEvent: (next: (event: OnboardingEvent) => void) => {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
  } satisfies OnboardingDesktopBridge;
  return {
    bridge,
    install,
    signIn: () => signIn,
    emit: (event: OnboardingEvent) => act(() => listener?.(event)),
  };
}

async function render(bridge: OnboardingDesktopBridge, step: OnboardingStep) {
  const container = document.createElement("div");
  document.body.append(container);
  const onClose = vi.fn();
  const onStartConversation = vi.fn();
  root = createRoot(container);
  await act(async () => {
    root!.render(createElement(OnboardingView, { bridge, step, onClose, onStartConversation }));
  });
  return { container, onClose, onStartConversation };
}

function click(container: HTMLElement, text: string): Promise<void> {
  const target = [...container.querySelectorAll("button")].find((element) =>
    element.textContent?.includes(text),
  );
  if (!target) throw new Error(`No button with "${text}" in: ${container.textContent}`);
  return act(async () => target.click());
}

async function type(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("OnboardingView", () => {
  it("takes a Mac without GJC from install through an API-key sign-in to the first conversation", async () => {
    const fake = fakeBridge();
    const { container, onClose, onStartConversation } = await render(fake.bridge, "install");
    expect(container.textContent).toContain("가재를 쓰려면 GJC가 필요합니다");

    await click(container, "GJC 설치");
    fake.emit({ type: "install-progress", receivedBytes: 70_000_000, totalBytes: 140_000_000 });
    expect(container.textContent).toContain("받는 중 70MB / 140MB");
    await act(async () => fake.install.resolve({ version: "0.19.2" }));
    expect(container.textContent).toContain("어떤 AI를 쓰시나요?");

    await click(container, "Z.AI GLM Coding Plan");
    expect(fake.bridge.signIn).toHaveBeenCalledWith("zai");
    fake.emit({ type: "open-url", url: "https://z.ai/manage-apikey/apikey-list" });
    fake.emit({ type: "prompt", message: "Paste your Z.AI API key (sk-...)" });
    const input = container.querySelector<HTMLInputElement>(".onboarding-answer input")!;
    expect(input.type).toBe("password");
    expect(container.querySelector<HTMLAnchorElement>(".onboarding-link")?.href).toBe(
      "https://z.ai/manage-apikey/apikey-list",
    );
    await type(input, "  sk-test  ");
    await click(container, "확인");
    expect(fake.bridge.answer).toHaveBeenCalledWith("sk-test");
    expect(input.value).toBe("");

    await act(async () => fake.signIn().resolve());
    expect(container.textContent).toContain("준비됐습니다");
    expect(container.textContent).toContain("glm-medium");
    await click(container, "첫 대화 시작");
    expect(onClose).toHaveBeenCalled();
    expect(onStartConversation).toHaveBeenCalled();
  });

  it("says why a sign-in failed and lets the user retry or pick another AI", async () => {
    const fake = fakeBridge();
    const { container } = await render(fake.bridge, "sign-in");
    await click(container, "Claude Pro/Max");
    expect(container.textContent).toContain("로그인을 준비하는 중");
    await act(async () =>
      fake.signIn().reject(new Error("Error invoking remote method 'x': Error: Invalid API key")),
    );
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "로그인하지 못했습니다. Invalid API key",
    );
    await click(container, "다시 시도");
    expect(fake.bridge.signIn).toHaveBeenCalledTimes(2);
    await click(container, "다른 AI 고르기");
    expect(fake.bridge.cancelSignIn).toHaveBeenCalled();
    expect(container.textContent).toContain("어떤 AI를 쓰시나요?");
  });

  it("lets someone who sets GJC up from the terminal leave for good", async () => {
    const fake = fakeBridge();
    const { container, onClose } = await render(fake.bridge, "sign-in");
    await click(container, "나중에 직접 설정할게요");
    expect(fake.bridge.dismiss).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });
});
