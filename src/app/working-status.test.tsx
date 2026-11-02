/**
 * @vitest-environment happy-dom
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TranscriptItem } from "../backend/types";
import { setLanguageMode } from "../i18n";
import { elapsedTurnMs, resolveTurnProgress } from "../transcript-utils";
import { formatDuration } from "./format";
import { GajaeProgressRow } from "./gajae-progress";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const user = (id: string, content = `ask ${id}`): TranscriptItem => ({
  id, sessionId: "s", kind: "message", role: "user", content, createdAt: "10:00",
});
const thought = (content: string, streaming = true): TranscriptItem => ({
  id: "r1", sessionId: "s", kind: "thought", content, createdAt: "10:00", streaming,
});
const running = { status: "running" as const };

describe("resolveTurnProgress activity", () => {
  it("moves the last activity only when the tail changes, streamed text included", () => {
    const first = resolveTurnProgress([user("u1"), thought("a")], running, "s", undefined, 1_000);
    const same = resolveTurnProgress([user("u1"), thought("a")], running, "s", first.stored, 9_000);
    expect(same.progress?.activityAt).toBe(1_000);
    const streamed = resolveTurnProgress([user("u1"), thought("ab")], running, "s", same.stored, 12_000);
    expect(streamed.progress?.activityAt).toBe(12_000);
  });

  it("keeps the clock for a message sent into the running turn and marks it unread until work follows", () => {
    const started = resolveTurnProgress([user("u1"), thought("a")], running, "s", undefined, 1_000);
    const steered = resolveTurnProgress(
      [user("u1"), thought("a"), user("u2")], running, "s", started.stored, 20_000,
    );
    expect(steered.progress?.queuedMessage).toBe(true);
    expect(steered.progress && elapsedTurnMs(steered.progress.clock, 20_000)).toBe(19_000);

    const confirmed = resolveTurnProgress(
      [user("u1"), thought("a"), user("shared-u2", "ask u2")], running, "s", steered.stored, 21_000,
    );
    expect(confirmed.progress?.queuedMessage).toBe(true);

    const answered = resolveTurnProgress(
      [user("u1"), thought("a"), user("shared-u2", "ask u2"), { ...thought("b"), id: "r2" }],
      running, "s", confirmed.stored, 25_000,
    );
    expect(answered.progress?.queuedMessage).toBe(false);
    expect(answered.progress && elapsedTurnMs(answered.progress.clock, 25_000)).toBe(24_000);
  });

  it("does not mistake a prompt's confirmed row for a steer", () => {
    const echoed = resolveTurnProgress([user("local-prompt-1")], running, "s", undefined, 1_000);
    const confirmed = resolveTurnProgress([user("u1")], running, "s", echoed.stored, 2_000);
    expect(confirmed.progress?.queuedMessage).toBe(false);
    expect(confirmed.progress && elapsedTurnMs(confirmed.progress.clock, 2_000)).toBe(1_000);
  });

  it("starts a new clock for a prompt sent after the turn finished", () => {
    const started = resolveTurnProgress([user("u1"), thought("a")], running, "s", undefined, 1_000);
    const done = resolveTurnProgress(
      [user("u1"), thought("a", false)], { status: "idle" }, "s", started.stored, 5_000,
    );
    const next = resolveTurnProgress(
      [user("u1"), thought("a", false), user("u2")], running, "s", done.stored, 60_000,
    );
    expect(next.progress?.queuedMessage).toBe(false);
    expect(next.progress && elapsedTurnMs(next.progress.clock, 60_000)).toBe(0);
  });
});

describe("retry work label", () => {
  it("names the retry while the session runs, and not after", () => {
    const items = [user("u1"), thought("a", false)];
    const retrying = resolveTurnProgress(items, { ...running, retrying: true }, "s", undefined, 1_000);
    expect(retrying.progress?.work).toEqual({ kind: "thinking", label: "모델 오류" });
    const idle = resolveTurnProgress(items, { status: "idle", retrying: true }, "s", retrying.stored, 2_000);
    expect(idle.progress?.work.kind).toBe("done");
  });
});

describe("formatDuration", () => {
  afterEach(() => setLanguageMode("ko"));

  it("shows seconds, then minutes and seconds, then hours and minutes", () => {
    expect(formatDuration(45_400)).toBe("45초");
    expect(formatDuration(130_000)).toBe("2분 10초");
    expect(formatDuration(3_900_000)).toBe("1시간 5분");
    setLanguageMode("en");
    expect(formatDuration(130_000)).toBe("2m 10s");
  });
});

describe("GajaeProgressRow working meta", () => {
  let root: Root | undefined;

  afterEach(() => {
    act(() => root?.unmount());
    root = undefined;
    document.body.innerHTML = "";
    vi.useRealTimers();
  });

  function render(props: Parameters<typeof GajaeProgressRow>[0]) {
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => root!.render(createElement(GajaeProgressRow, props)));
    return host;
  }

  it("ticks the elapsed time and names the last activity only after a quiet spell", () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const clock = { zeroAt: 90_000, pausedMs: 0, ran: true };
    const host = render({ kind: "thinking", clock, activityAt: 95_000 });
    const meta = () => host.querySelector(".gajae-progress-meta")?.textContent;
    expect(meta()).toBe("10초");
    act(() => vi.advanceTimersByTime(20_000));
    expect(meta()).toBe("30초");
    act(() => vi.advanceTimersByTime(5_000));
    expect(meta()).toBe("35초 · 마지막 활동 30초 전");
  });

  it("says a message sent into the turn waits for the current step", () => {
    const clock = { zeroAt: Date.now(), pausedMs: 0, ran: true };
    const host = render({ kind: "tool", clock, activityAt: Date.now(), queuedMessage: true });
    expect(host.querySelector(".gajae-progress-meta")?.textContent).toContain(
      "보낸 메시지는 지금 단계가 끝나면 읽힙니다",
    );
  });

  it("counts down a model call retry and ends the wait from its buttons once", () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const onControlRetry = vi.fn();
    const clock = { zeroAt: 90_000, pausedMs: 0, ran: true };
    const host = render({
      kind: "thinking", clock, activityAt: 95_000, onControlRetry,
      retry: { attempt: 2, maxAttempts: 5, retryAt: 108_000, error: "429 rate limit\nretry-after: 8" },
    });
    const meta = () => host.querySelector(".gajae-progress-meta")?.textContent;
    expect(meta()).toBe("재시도 2/5 · 8초 후 · 429 rate limit");
    act(() => vi.advanceTimersByTime(8_000));
    expect(meta()).toBe("재시도 2/5 · 곧 다시 보냄 · 429 rate limit");
    const [abort, now] = host.querySelectorAll<HTMLButtonElement>(".gajae-progress-actions button");
    act(() => now!.click());
    expect(onControlRetry).toHaveBeenCalledWith("now");
    expect(abort!.disabled && now!.disabled).toBe(true);
  });

  it("shows nothing once the turn is done", () => {
    const clock = { zeroAt: 0, pausedMs: 0, heldAt: 5_000, ran: true };
    const host = render({ kind: "done", clock, activityAt: 0 });
    expect(host.querySelector(".gajae-progress-meta")).toBeNull();
  });
});
