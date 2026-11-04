import type { ToolActivity } from "../backend/types";
import { compactToolCommand, compactToolText, type CompactText } from "../composer-utils";
import { t } from "../i18n";
import { humanRuntimeText } from "./format";

/**
 * What a tool card shows by default: what the tool did, never the JSON it was
 * called with. The raw input and output stay behind 상세 내용 보기.
 */
export interface ToolSummary {
  /** A shell command, shown as code. */
  command?: string;
  /** The file a tool touched, with what was read or written of it. */
  target?: { path?: string; detail?: string };
  /** Path a diff is labelled with when the stream did not report one. */
  diffPath?: string;
  output?: CompactText;
}

interface ToolInput {
  record?: Record<string, unknown>;
  text?: string;
}

type Summarizer = (tool: ToolActivity, input: ToolInput, output: CompactText | undefined) => ToolSummary;

const OUTPUT_DETAILS_SEPARATOR = "\n\ndetails\n";
const TRUNCATED_OUTPUT_STUB = /^\[Output truncated/u;
const PATCH_FILE_HEADER = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/gmu;

function parseInput(command: string | undefined): ToolInput {
  const text = command?.trim();
  if (!text) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      return { record: parsed as Record<string, unknown>, text };
  } catch {
    // A plain-text command is already readable.
  }
  return { text };
}

function isStructuredJson(text: string): boolean {
  const value = text.trim();
  if (!/^[[{]/u.test(value)) return false;
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * The tool's own words. The structured `details` that follows a result's text is
 * data for the raw view, and a payload with no text in it is JSON that says
 * nothing to a person, so neither is shown here.
 */
function readableOutput(raw: string | undefined): CompactText | undefined {
  if (!raw) return undefined;
  const separator = raw.startsWith("details\n") ? 0 : raw.indexOf(OUTPUT_DETAILS_SEPARATOR);
  const body = separator >= 0 ? raw.slice(0, separator) : raw;
  if (!body.trim()) return undefined;
  const compact = compactToolText(humanRuntimeText(body));
  return compact.text && !isStructuredJson(compact.fullText) ? compact : undefined;
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value ? value : undefined;
}

/** `src/a.ts:12-40,60-70` into the path and the line ranges that were asked for. */
function splitPathRange(value: string): { path: string; range?: string } {
  const match = /^(.*?):(\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*)$/u.exec(value);
  return match?.[1] ? { path: match[1], range: match[2] } : { path: value };
}

function lineCount(text: string): number {
  return text.replace(/\n+$/u, "").split("\n").length;
}

function readSummary(tool: ToolActivity, input: ToolInput, output: CompactText | undefined): ToolSummary {
  const requested = stringField(input.record, "path");
  const { path, range } = requested ? splitPathRange(requested) : { path: tool.targetPath };
  const body = tool.output && !TRUNCATED_OUTPUT_STUB.test(tool.output) ? output : undefined;
  const details = [
    range ? t`줄 ${range}` : undefined,
    body && tool.status === "completed" ? t`${lineCount(body.fullText)}줄` : undefined,
  ].filter((part): part is string => Boolean(part));
  return {
    target: { path, detail: details.join(" · ") || undefined },
    output: tool.status === "failed" ? output : undefined,
  };
}

function writeSummary(tool: ToolActivity, input: ToolInput, output: CompactText | undefined): ToolSummary {
  const content = stringField(input.record, "content");
  return {
    target: {
      path: stringField(input.record, "path") ?? tool.targetPath,
      detail: content ? t`${lineCount(content)}줄` : undefined,
    },
    output: tool.status === "failed" ? output : undefined,
  };
}

function editSummary(tool: ToolActivity, input: ToolInput, output: CompactText | undefined): ToolSummary {
  const patch = stringField(input.record, "input");
  const files = patch ? [...patch.matchAll(PATCH_FILE_HEADER)].map((match) => match[1]!.trim()) : [];
  const path = tool.targetPath ?? (files.length === 1 ? files[0] : undefined);
  return {
    target: { path: path ?? (files.length > 1 ? files.join(", ") : undefined) },
    diffPath: path,
    output,
  };
}

function bashSummary(_tool: ToolActivity, input: ToolInput, output: CompactText | undefined): ToolSummary {
  const command = input.record ? stringField(input.record, "command") : input.text;
  return {
    command: command ? compactToolCommand(command).preview : undefined,
    output,
  };
}

/** A tool this window has no summary for shows its input only when it is not JSON. */
function genericSummary(_tool: ToolActivity, input: ToolInput, output: CompactText | undefined): ToolSummary {
  const command = input.record ? undefined : input.text;
  return {
    command: command ? compactToolCommand(command).preview : undefined,
    output,
  };
}

const SUMMARIZERS: Record<string, Summarizer> = {
  bash: bashSummary,
  edit: editSummary,
  read: readSummary,
  write: writeSummary,
};

export function summarizeTool(tool: ToolActivity): ToolSummary {
  const input = parseInput(tool.command);
  const output = readableOutput(tool.output);
  const summary = (SUMMARIZERS[tool.name] ?? genericSummary)(tool, input, output);
  if (tool.diff) return { ...summary, output: undefined };
  // What is being approved has to be readable before it runs, even for a tool whose
  // finished card shows only a path.
  const proposed = stringField(input.record, "input") ?? input.text;
  if (tool.status === "approval-required" && !summary.command && proposed)
    return { ...summary, command: compactToolCommand(proposed).preview };
  return summary;
}
