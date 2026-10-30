import type { UiLanguage } from "../shared/agent-contract.js";

/**
 * The handful of host-authored strings that reach a host dialog or the menu bar.
 *
 * Renderer copy is translated by the renderer dictionary; these strings are
 * already in the main process before a window can translate them, so the host
 * keeps its own small map.
 */
const ENGLISH: Readonly<Record<string, string>> = {
  "세션을 삭제할까요?": "Delete this session?",
  "터미널 세션을 삭제할까요?": "Delete this terminal session?",
  "이 세션에서 실행 중인 셸과 프로그램을 종료합니다.":
    "Ends the shell and any program running in this session.",
  "이 세션을 목록에서 숨길까요? GJC의 기록은 삭제되지 않습니다.":
    "Hide this session from the list? GJC's history is not deleted.",
  "이 세션을 압축할까요? 대화 기록이 다시 작성됩니다.":
    "Compact this session? The conversation history will be rewritten.",
  "이 목표를 완료로 표시할까요?": "Mark this goal complete?",
  "이 목표를 삭제할까요?": "Delete this goal?",
  "GJC 프로세스를 종료하고 대화 기록까지 삭제합니다. 목록에서만 숨기지 않습니다.":
    "Stops the session's GJC process and deletes the conversation history. It is not merely hidden from the list.",
  "취소": "Cancel",
  "계속": "Continue",
  "삭제": "Delete",
  "숨기기": "Hide",
  "완료": "Complete",
  "압축": "Compact",
  "허용": "Allow",
  "커밋": "Commit",
  "추가": "Add",
  "제거": "Remove",
  "켜기": "Turn on",
  "끄기": "Turn off",
  "설치": "Install",
  "만들기": "Create",
  "실행": "Run",
  "정리": "Clean up",
  "적용": "Apply",
  "업데이트": "Update",
  "이 도구 실행을 허용할까요?": "Allow this tool action?",
  "스테이징된 변경을 커밋할까요?": "Commit the staged changes?",
  "커밋을 push할까요?": "Push the commits?",
  "MCP 서버를 추가할까요?": "Add this MCP server?",
  "MCP 서버를 제거할까요?": "Remove this MCP server?",
  "플러그인을 켤까요?": "Enable this plugin?",
  "플러그인을 끌까요?": "Disable this plugin?",
  "플러그인을 설치할까요? 패키지 코드가 설치되고 실행할 수 있게 됩니다. 신뢰하는 정확한 버전인지 확인하세요.":
    "Install this plugin? Its package code will be installed and able to run. Make sure this is the exact version you trust.",
  "플러그인을 제거할까요? 설치된 코드가 삭제됩니다.": "Remove this plugin? Its installed code will be deleted.",
  "자동화를 만들까요?": "Create this automation?",
  "자동화를 켤까요?": "Enable this automation?",
  "자동화를 끌까요?": "Disable this automation?",
  "자동화를 삭제할까요? 되돌릴 수 없습니다.": "Delete this automation? This cannot be undone.",
  "자동화를 지금 실행할까요?": "Run this automation now?",
  "런타임 설정을 적용할까요? GJC 연결이 다시 시작될 수 있습니다.":
    "Apply runtime settings? The GJC connection may restart.",
  "GJC를 업데이트할까요? 업데이트 후 GJC runtime이 다시 연결됩니다.":
    "Update GJC? The GJC runtime will reconnect after the update.",
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
