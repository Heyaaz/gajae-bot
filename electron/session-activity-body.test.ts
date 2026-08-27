import { describe, expect, it } from "vitest";
import { sessionActivityBody } from "../shared/agent-contract.js";

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
      ["permission", "moa 승인이 필요합니다."],
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
