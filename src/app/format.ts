import type {
  AgentCommand,
  AgentConfigOption,
  AgentSession,
  BackendConnection,
  ToolActivity,
  TranscriptItem,
} from "../backend/types";
import { getLanguage, t } from "../i18n";
import type { ParallelGroup } from "../../shared/parallel-run";


/**
 * Masks credentials that reached an error message.
 *
 * Errors here are surfaced verbatim in the UI, and a failure from a lower layer
 * carries whatever was on the wire: a rejected `Bearer` header, an `sk-` key, a
 * command line with a token in it. The main process already redacts what it writes
 * to artifacts; this is the same guarantee for what the user is shown.
 */
function redactCredentials(value: string): string {
  return value
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]{8,}/giu, `$1${t("[삭제됨]")}`)
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, t("[삭제됨]"))
    // The value runs to the closing quote or delimiter, not to the first space: a
    // header like `"authorization": "Token abcdef"` carries the secret in a second
    // word, and stopping at the space left it on screen.
    .replace(
      /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret)["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,"'}]+)/giu,
      `$1${t("[삭제됨]")}`,
    )
    .replace(
      /\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD))=[^\s]+/gu,
      `$1=${t("[삭제됨]")}`,
    );
}

function translateHostError(message: string): string {
  if (getLanguage() !== "en") return message;
  const patterns: ReadonlyArray<[RegExp, (match: RegExpMatchArray) => string]> = [
    [/^(.+)은\(는\) 지원하는 이미지 형식이 아닙니다$/u, (m) => `${m[1]} is not a supported image format.`],
    [/^(.+)은\(는\) 파일이 아닙니다$/u, (m) => `${m[1]} is not a file.`],
    [/^(.+)은\(는\) 10 MiB 제한을 초과합니다$/u, (m) => `${m[1]} exceeds the 10 MiB limit.`],
    [/^(.+)이\(가\) 읽는 동안 변경되었습니다$/u, (m) => `${m[1]} changed while it was being read.`],
    [/^(.+)의 경로에 지원하지 않는 문자가 있습니다$/u, (m) => `${m[1]} contains unsupported characters in its path.`],
    [/^(.+): 이미지를 준비하지 못했습니다$/u, (m) => `${m[1]}: could not prepare the image.`],
    [/^(.+): 파일을 준비하지 못했습니다$/u, (m) => `${m[1]}: could not prepare the file.`],
    [/^이미지는 메시지당 최대 (\d+)장까지 첨부할 수 있습니다$/u, (m) => `You can attach up to ${m[1]} images per message.`],
    [/^파일은 메시지당 최대 (\d+)개까지 첨부할 수 있습니다$/u, (m) => `You can attach up to ${m[1]} files per message.`],
    [/^(.+) 실행이 실패했습니다\.$/u, (m) => `${m[1]} failed to run.`],
    [/^GitHub 인증이 필요합니다\. (.+)$/u, (m) => `GitHub authentication required. ${m[1]}`],
    [/^gh 응답을 읽지 못했습니다: (.+)$/u, (m) => `Could not read the gh response: ${m[1]}`],
    [/^저장소 정보를 일부만 읽었습니다: (.+)$/u, (m) => `Only part of the repository information was read: ${m[1]}`],
    [/^세션 기록을 찾지 못했습니다: (.+)$/u, (m) => `Session history not found: ${m[1]}`],
    [/^세션 (\d+)$/u, (m) => `Session ${m[1]}`],
    [/^Tailscale이 연결되어 있지 않습니다 \((.+)\)\.$/u, (m) => `Tailscale is not connected (${m[1]}).`],
    [/^(.+): 읽지 못했습니다\.$/u, (m) => `${m[1]}: could not read.`],
  ];
  for (const [pattern, replace] of patterns) {
    const match = message.match(pattern);
    if (match) return replace(match);
  }
  return message;
}

/** The user declined the host's confirmation: their answer, not a failure to report. */
export function isDeclinedConfirmation(error: unknown): boolean {
  return /Operation cancelled/u.test(error instanceof Error ? error.message : String(error));
}

export function humanErrorMessage(error: unknown): string {
  const message = redactCredentials(
    error instanceof Error ? error.message : String(error),
  );
  if (
    /\b(?:operation[ _-]?aborted|operation[ _-]?cancelled|operation[ _-]?canceled|aborterror|request aborted)\b/iu.test(
      message,
    )
  )
    return t("작업이 취소되었습니다.");
  if (
    /uncertain_after_send|SDK request outcome is uncertain after the frame was sent/iu.test(
      message,
    )
  )
    return t("작업이 이미 전달됐는지 확인하지 못했습니다. 채팅을 확인하세요.");
  return t(translateHostError(message));
}

export function humanRuntimeText(value: string): string {
  return /^\s*(?:error:\s*)?(?:operation[ _-]?aborted|operation[ _-]?cancelled|operation[ _-]?canceled)\.?\s*$/iu.test(
    value,
  )
    ? t("작업이 취소되었습니다.")
    : value;
}

export const HTTP_URL_PATTERN = /https?:\/\/[^\s<>"')\]]+/giu;

export function httpUrls(value: string, limit = 3): string[] {
  return [...new Set(value.match(HTTP_URL_PATTERN) ?? [])].slice(0, limit);
}

export function statusLabel(status: AgentSession["status"], phase?: string): string {
  if (phase === "compacting") return "Compacting";
  if (status === "starting") return "Starting";
  if (status === "running") return "Working";
  if (status === "waiting") return "Needs input";
  if (status === "failed") return "Failed";
  if (status === "unknown") return t("상태 확인 불가");
  return "Idle";
}

export function parallelStateLabel(state: ParallelGroup["state"]): string {
  switch (state.kind) {
    case "draft":
      return t("시도 만드는 중");
    case "running":
      return t("병렬 실행 중");
    case "comparing":
      return t("비교 준비됨");
    case "adopted":
      return t("채택함");
    case "discarded":
      return t("모두 버림");
  }
}

export function connectionStateLabel(state: BackendConnection["state"]): string {
  if (state === "connected") return t("연결됨");
  if (state === "connecting") return t("연결 중");
  if (state === "error") return t("오류");
  return t("연결 끊김");
}

export function directoryName(value: string): string {
  return value.split("/").filter(Boolean).at(-1) ?? (value || "Workspace");
}

/** The backend stores the default draft title in Korean; display it in the UI language. */
export function sessionTitleText(title: string): string {
  return title === "새 Gajae 세션" ? t("새 Gajae 세션") : title;
}

export function toolDisplayName(name: string): string {
  const labels: Record<string, string> = {
    bash: "Bash",
    edit: "Edit",
    find: "Find",
    goal: "Goal",
    read: "Read",
    search: "Search",
    search_tool_bm25: "SearchTools",
    subagent: "Subagent",
    task: "Task",
    todo_write: "Todo Write",
    web_search: "Web Search",
    write: "Write",
  };
  return labels[name] ?? name;
}

export function subagentLabel(tool: ToolActivity): string {
  try {
    const input = tool.command
      ? (JSON.parse(tool.command) as Record<string, unknown>)
      : undefined;
    for (const key of ["agent", "role", "name", "description"]) {
      if (typeof input?.[key] === "string" && input[key])
        return String(input[key]);
    }
  } catch {
    // Fall back to the title the stream sent when raw input is partial or truncated.
  }
  return tool.description || t("서브 에이전트");
}

export function toolStatusLabel(status: ToolActivity["status"]): string {
  // A queued call is not work in progress: GJC leaves a tool pending for seconds
  // before it starts, and saying 작업 중 for that stretch claimed work had begun.
  if (status === "pending") return t("대기 중");
  if (status === "running") return t("작업 중");
  if (status === "completed" || status === "approved") return t("완료");
  if (status === "failed" || status === "denied") return t("실패");
  if (status === "cancelled") return t("취소됨");
  return t("승인 대기");
}

export function configOptionGroups(
  options: AgentConfigOption["options"],
): Array<{ name: string; options: NonNullable<AgentConfigOption["options"]> }> {
  const groups = new Map<string, NonNullable<AgentConfigOption["options"]>>();
  for (const option of options ?? []) {
    const name = option.group ?? "Session profiles";
    groups.set(name, [...(groups.get(name) ?? []), option]);
  }
  return [...groups].map(([name, groupedOptions]) => ({
    name,
    options: groupedOptions,
  }));
}

export const BUNDLED_GJC_COMMANDS: AgentCommand[] = [
  {
    name: "steer",
    description: "대기 중인 지시를 지금 실행 (빈 Enter와 같음)",
    hint: "[지시]",
  },
  {
    name: "queue",
    description: "현재 작업 다음에 실행할 후속 작업 예약",
    hint: "[요청]",
  },
  { name: "abort", description: "진행 중인 작업 중단" },
  { name: "compact", description: "현재 세션 context 압축" },
  { name: "new", description: "이 workspace에서 새 세션 시작" },
  { name: "model", description: "세션 모델 프로필 선택" },
  { name: "effort", description: "추론 effort 변경 (단축키: ⇧⇥)" },
];

export const EMPTY_TRANSCRIPT: TranscriptItem[] = [];

export interface DiffLine {
  kind: "added" | "removed" | "context" | "hunk" | "header";
  text: string;
  oldLineNumber?: number;
  newLineNumber?: number;
}

const HUNK_HEADER_PATTERN = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u;

/**
 * Parses one file's unified diff body into typed, line-numbered rows.
 *
 * `+++`/`---` file headers are their own `header` kind rather than `added`/
 * `removed`: counting them as content lines inflated every summary's +/- count
 * by one whenever a diff carried its standard file headers.
 */
export function parseDiffLines(diff: string): DiffLine[] {
  let oldLine = 0;
  let newLine = 0;
  return diff.split("\n").map((line) => {
    const hunk = line.match(HUNK_HEADER_PATTERN);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      return { kind: "hunk" as const, text: line };
    }
    if (line.startsWith("+++") || line.startsWith("---"))
      return { kind: "header" as const, text: line };
    if (line.startsWith("+")) {
      const result = {
        kind: "added" as const,
        text: line.slice(1),
        newLineNumber: newLine,
      };
      newLine += 1;
      return result;
    }
    if (line.startsWith("-")) {
      const result = {
        kind: "removed" as const,
        text: line.slice(1),
        oldLineNumber: oldLine,
      };
      oldLine += 1;
      return result;
    }
    const result = {
      kind: "context" as const,
      text: line.replace(/^ /u, ""),
      oldLineNumber: oldLine,
      newLineNumber: newLine,
    };
    oldLine += 1;
    newLine += 1;
    return result;
  });
}

export interface DiffFileSection {
  path?: string;
  lines: DiffLine[];
}

const FILE_HEADER_PATTERN = /^diff --git a\/(.+) b\/(.+)$/u;

/**
 * Splits a (possibly multi-file) unified diff into per-file sections so a diff
 * covering several files can collapse one file at a time instead of rendering
 * every hunk as a single undifferentiated block.
 */
export function parseDiffFiles(diff: string): DiffFileSection[] {
  const rawLines = diff.split("\n");
  const sections: { path?: string; raw: string[] }[] = [];
  for (const line of rawLines) {
    const gitHeader = line.match(FILE_HEADER_PATTERN);
    const isNewFileHeader =
      gitHeader ||
      (line.startsWith("--- ") &&
        (sections.length === 0 || sections.at(-1)?.raw.some((l) => l.startsWith("+++ "))));
    if (isNewFileHeader) {
      const path = gitHeader
        ? gitHeader[2]
        : line.replace(/^--- (?:a\/)?/u, "").trim();
      sections.push({ path: path || undefined, raw: [] });
      if (gitHeader) continue;
    }
    if (sections.length === 0) sections.push({ raw: [] });
    sections.at(-1)!.raw.push(line);
  }
  return sections.map((section) => {
    const pathFromHeader = section.raw.find((line) => line.startsWith("+++ "));
    const path =
      section.path ??
      (pathFromHeader
        ? pathFromHeader.replace(/^\+\+\+ (?:b\/)?/u, "").trim()
        : undefined);
    return { path, lines: parseDiffLines(section.raw.join("\n")) };
  });
}

const STORY_STATUS_LABELS: Record<string, () => string> = {
  pending: () => t("시작 전"),
  active: () => t("진행 중"),
  complete: () => t("완료"),
  failed: () => t("실패"),
  blocked: () => t("막힘"),
  review_blocked: () => t("리뷰 막힘"),
  superseded: () => t("대체됨"),
};

/** A status gjc 0.19.0 does not send is shown as the runtime wrote it. */
export function storyStatusLabel(status: string): string {
  return Object.hasOwn(STORY_STATUS_LABELS, status)
    ? STORY_STATUS_LABELS[status]!()
    : status;
}
