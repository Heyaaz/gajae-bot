import type {
  AgentCommand,
  AgentConfigOption,
  AgentSession,
  BackendConnection,
  ToolActivity,
  TranscriptItem,
} from "../backend/types";

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
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]{8,}/giu, "$1[삭제됨]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, "[삭제됨]")
    // The value runs to the closing quote or delimiter, not to the first space: a
    // header like `"authorization": "Token abcdef"` carries the secret in a second
    // word, and stopping at the space left it on screen.
    .replace(
      /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret)["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,"'}]+)/giu,
      "$1[삭제됨]",
    )
    .replace(
      /\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD))=[^\s]+/gu,
      "$1=[삭제됨]",
    );
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
    return "작업이 취소되었습니다.";
  if (
    /uncertain_after_send|SDK request outcome is uncertain after the frame was sent/iu.test(
      message,
    )
  )
    return "작업이 이미 전달됐는지 확인하지 못했습니다. 채팅을 확인하세요.";
  return message;
}

export function humanRuntimeText(value: string): string {
  return /^\s*(?:error:\s*)?(?:operation[ _-]?aborted|operation[ _-]?cancelled|operation[ _-]?canceled)\.?\s*$/iu.test(
    value,
  )
    ? "작업이 취소되었습니다."
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
  return "Idle";
}

export function connectionStateLabel(state: BackendConnection["state"]): string {
  if (state === "connected") return "연결됨";
  if (state === "connecting") return "연결 중";
  if (state === "error") return "오류";
  return "연결 끊김";
}

export function directoryName(value: string): string {
  return value.split("/").filter(Boolean).at(-1) ?? (value || "Workspace");
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
  return tool.description || "서브 에이전트";
}

export function toolStatusLabel(status: ToolActivity["status"]): string {
  // A queued call is not work in progress: GJC leaves a tool pending for seconds
  // before it starts, and saying 작업 중 for that stretch claimed work had begun.
  if (status === "pending") return "대기 중";
  if (status === "running") return "작업 중";
  if (status === "completed" || status === "approved") return "완료";
  if (status === "failed" || status === "denied") return "실패";
  if (status === "cancelled") return "취소됨";
  return "승인 대기";
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
