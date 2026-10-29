import type { UiLanguage } from "../shared/agent-contract.js";

/**
 * The handful of host-authored strings that reach a native dialog or the menu bar.
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
  "확인 필요": "Needs input",
  "실행 중": "Working",
  "실패": "failed",
  "진행 중인 세션 없음": "No active sessions",
  "Gajae 열기": "Open Gajae",
  "새 버전이 나왔습니다. 눌러서 릴리스 페이지를 엽니다.":
    "A new version is out. Click to open the release page.",
  "채택하지 않은 시도를 정리할까요?": "Clean up the attempts that were not adopted?",
  "병렬 실행 시도를 모두 정리할까요?": "Clean up every attempt of this parallel run?",
};

let language: UiLanguage = "ko";

export function setHostLanguage(next: UiLanguage): void {
  language = next;
}

export function hostText(value: string): string {
  return language === "en" ? ENGLISH[value] ?? value : value;
}
