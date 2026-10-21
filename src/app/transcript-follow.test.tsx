/**
 * @vitest-environment happy-dom
 */
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TranscriptItem } from "../backend/types";
import {
  GESTURE_WINDOW_MS,
  Transcript,
  type TranscriptViewportAnchor,
} from "./transcript";

class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

function message(id: string, content: string): TranscriptItem {
  return {
    id,
    sessionId: "s-1",
    kind: "message",
    role: "assistant",
    content,
    createdAt: "now",
  };
}

function bindScroll(element: HTMLElement) {
  let scrollHeight = 1_000;
  let scrollTop = 600;
  const clientHeight = 400;
  Object.defineProperty(element, "scrollHeight", {
    configurable: true,
    get: () => scrollHeight,
  });
  Object.defineProperty(element, "clientHeight", {
    configurable: true,
    get: () => clientHeight,
  });
  Object.defineProperty(element, "scrollTop", {
    configurable: true,
    get: () => scrollTop,
    set: (value: number) => {
      scrollTop = Number(value);
    },
  });
  return {
    get scrollTop() {
      return scrollTop;
    },
    set scrollTop(value: number) {
      scrollTop = value;
    },
    set scrollHeight(value: number) {
      scrollHeight = value;
    },
    bottom() {
      return scrollHeight - clientHeight;
    },
  };
}

describe("gesture window follow latch", () => {
  let root: Root | undefined;
  let host: HTMLDivElement | undefined;

  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", NoopResizeObserver);
  });

  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    vi.unstubAllGlobals();
  });

  async function render(
    items: TranscriptItem[],
    earlier?: {
      hasMoreBefore?: boolean;
      onLoadEarlier?: (anchor: TranscriptViewportAnchor | null) => void | Promise<void>;
    },
  ): Promise<{
    element: HTMLElement;
    scroll: ReturnType<typeof bindScroll>;
    update: (next: TranscriptItem[]) => Promise<void>;
  }> {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    const paint = (next: TranscriptItem[]) => {
      root!.render(
        createElement(Transcript, {
          sessionId: "s-1",
          items: next,
          ...earlier,
          onResolveTool: () => undefined,
        }) as ReactNode,
      );
    };
    await act(async () => {
      paint(items);
    });
    const element = host.querySelector(".transcript");
    if (!(element instanceof HTMLElement)) throw new Error("transcript did not mount");
    const scroll = bindScroll(element);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    return {
      element,
      scroll,
      update: async (next) => {
        await act(async () => {
          paint(next);
        });
      },
    };
  }

  async function claimNearBottom(
    element: HTMLElement,
    scroll: ReturnType<typeof bindScroll>,
  ): Promise<number> {
    scroll.scrollTop = scroll.bottom() - 2;
    const parked = scroll.scrollTop;
    await act(async () => {
      element.dispatchEvent(new WheelEvent("wheel", { deltaY: -24, bubbles: true, cancelable: true }));
      element.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    return parked;
  }

  it("stands the bottom correction down during the gesture window", async () => {
    const { element, scroll, update } = await render([message("m-1", "hello")]);
    const parked = await claimNearBottom(element, scroll);
    scroll.scrollHeight = scroll.bottom() + 400 + 180;
    await update([message("m-1", "hello"), message("m-2", "next")]);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
    expect(scroll.scrollTop).toBe(parked);
  });

  it("follows a new row once the gesture window ends without another scroll", async () => {
    const { element, scroll, update } = await render([message("m-1", "hello")]);
    await claimNearBottom(element, scroll);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, GESTURE_WINDOW_MS + 40));
    });
    scroll.scrollHeight = 1_400;
    await update([message("m-1", "hello"), message("m-2", "next")]);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    expect(scroll.scrollTop).toBe(scroll.bottom());
  });

  it("loads the earlier page with the visible row and offset as its prepend anchor", async () => {
    const onLoadEarlier = vi.fn();
    const { element, scroll } = await render([message("m-anchor", "visible")], {
      hasMoreBefore: true,
      onLoadEarlier,
    });
    expect(host?.querySelector(".transcript-load-earlier")).toBeNull();
    scroll.scrollTop = 0;
    await act(async () => {
      element.dispatchEvent(new WheelEvent("wheel", { deltaY: -24, bubbles: true, cancelable: true }));
      element.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    // happy-dom does not perform layout for the virtualizer, so provide the mounted
    // row geometry the real scroller reports before a user asks to load its prefix.
    const slot = document.createElement("div");
    slot.className = "transcript-slot";
    slot.dataset.index = "0";
    slot.style.transform = "translateY(0px)";
    element.append(slot);
    Object.defineProperty(slot, "offsetHeight", { configurable: true, value: 100 });
    slot.getBoundingClientRect = () => ({
      top: 0,
      bottom: 100,
      left: 0,
      right: 100,
      width: 100,
      height: 100,
      x: 0,
      y: 0,
      toJSON: () => undefined,
    });
    const loadButton = host?.querySelector<HTMLButtonElement>(
      ".transcript-load-earlier button",
    );
    if (!loadButton) throw new Error("load-earlier button did not mount");
    await act(async () => {
      loadButton.click();
    });
    expect(onLoadEarlier).toHaveBeenCalledWith({ key: "m-anchor", offset: 0 });
    expect(element.className).toContain("transcript");
    scroll.scrollTop = 300;
    await act(async () => {
      element.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    expect(host?.querySelector(".transcript-load-earlier")).toBeNull();
  });
});
