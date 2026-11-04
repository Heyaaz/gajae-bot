/**
 * @vitest-environment happy-dom
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OnboardingDesktopBridge, OnboardingEvent, OnboardingStep, SignInResult } from "../../shared/onboarding";
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
  let signIn = deferred<SignInResult>();
  const bridge = {
    pendingStep: vi.fn(async () => null),
    needsSignIn: vi.fn(async () => false),
    installGjc: vi.fn(() => install.promise),
    signIn: vi.fn(() => {
      signIn = deferred<SignInResult>();
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

async function render(bridge: OnboardingDesktopBridge, step: OnboardingStep, reentry = false) {
  const container = document.createElement("div");
  document.body.append(container);
  const onClose = vi.fn();
  const onStartConversation = vi.fn();
  root = createRoot(container);
  await act(async () => {
    root!.render(createElement(OnboardingView, { bridge, step, reentry, onClose, onStartConversation }));
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

    await act(async () => fake.signIn().resolve({ switchedModel: true }));
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

  it("reopens later as a plain sign-in that closes without ending first-run setup", async () => {
    const fake = fakeBridge();
    const { container, onClose, onStartConversation } = await render(fake.bridge, "sign-in", true);
    expect(container.textContent).toContain("어떤 AI를 쓰시나요?");
    await click(container, "닫기");
    expect(fake.bridge.cancelSignIn).toHaveBeenCalled();
    expect(fake.bridge.dismiss).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
    expect(onStartConversation).not.toHaveBeenCalled();
  });

  it("tells a later sign-in that kept the user's model, and just closes", async () => {
    const fake = fakeBridge();
    const { container, onClose, onStartConversation } = await render(fake.bridge, "sign-in", true);
    await click(container, "Claude Pro/Max");
    await act(async () => fake.signIn().resolve({ switchedModel: false }));
    expect(container.textContent).toContain("Claude Pro/Max에 로그인했습니다");
    expect(container.textContent).not.toContain("claude-opus");
    await click(container, "확인");
    expect(onClose).toHaveBeenCalled();
    expect(onStartConversation).not.toHaveBeenCalled();
  });

  it("tells someone with no subscription what to get, with a sign-up link, and returns to the list", async () => {
    const fake = fakeBridge();
    const { container } = await render(fake.bridge, "sign-in");
    await click(container, "잘 모르겠어요 / 구독이 없어요");
    expect(container.textContent).toContain("어떤 AI를 가입하면 되나요?");
    expect(container.textContent).toContain("ChatGPT Plus/Pro를 추천합니다");
    const signup = container.querySelector<HTMLAnchorElement>(".onboarding-signup");
    expect(signup?.href).toBe("https://chatgpt.com/");
    expect(signup?.target).toBe("_blank");
    expect(fake.bridge.signIn).not.toHaveBeenCalled();
    await click(container, "가입했어요, 로그인할게요");
    expect(container.textContent).toContain("어떤 AI를 쓰시나요?");
  });

  it("only waits while a browser sign-in is running, with the paste-code field folded away", async () => {
    const fake = fakeBridge();
    const { container } = await render(fake.bridge, "sign-in");
    await click(container, "Claude Pro/Max");
    fake.emit({ type: "open-url", url: "https://claude.ai/oauth/authorize" });
    expect(container.querySelector(".onboarding-waiting")?.textContent).toContain("브라우저에서 로그인 중…");
    expect(container.textContent).not.toContain("자동으로 다음 단계");
    fake.emit({ type: "prompt", message: "Paste the authorization code" });
    const fold = container.querySelector<HTMLDetailsElement>(".onboarding-details")!;
    expect(fold.querySelector("summary")?.textContent).toBe("브라우저가 돌아오지 않나요?");
    expect(fold.open).toBe(false);
    expect(fold.querySelector(".onboarding-answer input")).not.toBeNull();
    expect(container.querySelectorAll(".onboarding-answer")).toHaveLength(1);
  });

  it("points an API-key sign-in without an account at the provider's sign-up page", async () => {
    const fake = fakeBridge();
    const { container } = await render(fake.bridge, "sign-in");
    await click(container, "Z.AI GLM Coding Plan");
    fake.emit({ type: "open-url", url: "https://z.ai/manage-apikey/apikey-list" });
    const links = [...container.querySelectorAll<HTMLAnchorElement>(".onboarding-link")];
    expect(links.map((link) => [link.textContent, link.href])).toEqual([
      ["API 키 페이지 다시 열기", "https://z.ai/manage-apikey/apikey-list"],
      ["계정이 없나요? Z.AI GLM Coding Plan 가입하기", "https://z.ai/subscribe"],
    ]);
  });
});

