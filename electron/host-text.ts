import type { UiLanguage } from "../shared/agent-contract.js";

/**
 * The handful of host-authored confirmations that reach a native dialog.
 *
 * Renderer copy is translated by the renderer dictionary; these strings are
 * already in the main process before a window can translate them, so the host
 * keeps its own small map.
 */
const ENGLISH: Readonly<Record<string, string>> = {
  "세션을 삭제할까요?": "Delete this session?",
  "이 세션을 목록에서 숨길까요? GJC의 기록은 삭제되지 않습니다.":
    "Hide this session from the list? GJC's history is not deleted.",
  "이 세션을 압축할까요? 대화 기록이 다시 작성됩니다.":
    "Compact this session? The conversation history will be rewritten.",
  "이 목표를 완료로 표시할까요?": "Mark this goal complete?",
  "이 목표를 삭제할까요?": "Delete this goal?",
};

let language: UiLanguage = "ko";

export function setHostLanguage(next: UiLanguage): void {
  language = next;
}

export function hostText(value: string): string {
  return language === "en" ? ENGLISH[value] ?? value : value;
}
