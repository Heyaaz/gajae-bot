import { describe, expect, it } from "vitest";
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  announcesSessionActivity,
  notificationDelivery,
  parseNotificationPreferences,
  sessionActivityBody,
} from "../shared/agent-contract.js";

describe("announcesSessionActivity", () => {
  it("announces a finished turn even while the window has focus", () => {
    // A long run usually ends while the user is reading something else on
    // screen, so a focused window must not swallow another session's outcome.
    expect(announcesSessionActivity("completed", true, false)).toBe(true);
    expect(announcesSessionActivity("failed", true, false)).toBe(true);
    expect(announcesSessionActivity("permission", true, false)).toBe(true);
  });

  it("suppresses the outcome of the session the focused window is showing", () => {
    expect(announcesSessionActivity("completed", true, true)).toBe(false);
    expect(announcesSessionActivity("failed", true, true)).toBe(false);
    expect(announcesSessionActivity("permission", true, true)).toBe(false);
  });

  it("suppresses the incidental per-message ping for a focused window", () => {
    expect(announcesSessionActivity("message", true)).toBe(false);
    expect(announcesSessionActivity("message", false)).toBe(true);
  });

  it("announces a recovered connection only when the window is away", () => {
    expect(announcesSessionActivity("recovered", true)).toBe(false);
    expect(announcesSessionActivity("recovered", false)).toBe(true);
  });
});

describe("sessionActivityBody", () => {
  it("names the session that finished", () => {
    // "백그라운드 작업이 완료되었습니다." gave no clue which of several running
    // sessions to open.
    expect(
      sessionActivityBody({ title: "gjc-bot", category: "completed" }),
    ).toBe("gjc-bot 작업이 완료되었습니다.");
  });

  it("names the session for every category", () => {
    const cases = [
      ["failed", "moa 작업이 실패했습니다."],
      ["permission", "moa 승인 또는 질문을 기다립니다."],
      ["recovered", "moa 연결이 복구되었습니다."],
      ["message", "moa 새 응답이 도착했습니다."],
    ] as const;
    for (const [category, expected] of cases)
      expect(sessionActivityBody({ title: "moa", category })).toBe(expected);
  });

  it("falls back when a session has no title yet", () => {
    expect(sessionActivityBody({ title: "   ", category: "completed" })).toBe(
      "세션 작업이 완료되었습니다.",
    );
  });
});

describe("notification preferences", () => {
  it("fills every event from the defaults when a stored value is missing", () => {
    expect(parseNotificationPreferences(undefined)).toEqual(
      DEFAULT_NOTIFICATION_PREFERENCES,
    );
    const parsed = parseNotificationPreferences({
      completed: { enabled: false, sound: "not-a-sound" },
    });
    expect(parsed.completed).toEqual({ enabled: false, sound: "default" });
    expect(parsed.permission).toEqual(
      DEFAULT_NOTIFICATION_PREFERENCES.permission,
    );
  });

  it("maps a sound choice to Electron's silent/sound options", () => {
    expect(notificationDelivery({ enabled: true, sound: "none" })).toEqual({
      silent: true,
    });
    expect(notificationDelivery({ enabled: true, sound: "default" })).toEqual({
      silent: false,
    });
    expect(notificationDelivery({ enabled: true, sound: "Glass" })).toEqual({
      silent: false,
      sound: "Glass",
    });
  });
});
