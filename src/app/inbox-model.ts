import type {
  Automation,
  AutomationRun,
} from "../../shared/automation-ipc";
import { sessionAttentionGroup } from "../../shared/desktop-integration";
import type { AgentSession, TranscriptItem } from "../backend/types";
import { directoryName } from "./format";
import { projectNameOf, projectPathOf, type ProjectGroup } from "./project-model";

/**
 * The inbox splits the rail's "needs input" group in two for display: an approval
 * is answered in place, a failure has to be read first, and mixing them hid which
 * kind of work was waiting.
 */
export type InboxSectionId = "waiting" | "failed" | "completed" | "working";

export const INBOX_SECTION_ORDER: readonly InboxSectionId[] = [
  "waiting",
  "failed",
  "completed",
  "working",
];

/**
 * Automation runs have no read state of their own, so a finished run stays in the
 * inbox for this long instead of piling up every run the service has kept.
 */
export const AUTOMATION_RUN_WINDOW_MS = 24 * 60 * 60 * 1000;

interface InboxItemBase {
  /** Unique across both kinds: a run id and a session id may collide. */
  key: string;
  section: InboxSectionId;
  title: string;
  project: string;
  /** One line of what the work last said, when it is known without a read. */
  preview?: string;
  /** When the item last changed, for ordering and the elapsed label. */
  at?: number;
}

export type InboxItem =
  | (InboxItemBase & { kind: "session"; session: AgentSession })
  | (InboxItemBase & {
      kind: "automation-run";
      section: "failed" | "completed";
      run: AutomationRun;
      at: number;
    });

export interface InboxSection {
  id: InboxSectionId;
  items: InboxItem[];
}

export interface InboxInput {
  /** Every session the backend reports, across all projects. */
  sessions: readonly AgentSession[];
  projects: readonly ProjectGroup[];
  /** Transcripts this window already holds; the inbox never reads one itself. */
  transcripts?: Readonly<Record<string, readonly TranscriptItem[] | undefined>>;
  automations?: readonly Automation[];
  runs?: readonly AutomationRun[];
  now: number;
}

/** Null when the session has nothing for the inbox: finished and already read. */
export function inboxSectionOf(
  session: Pick<AgentSession, "status" | "phase" | "unread">,
): InboxSectionId | null {
  const group = sessionAttentionGroup(session);
  if (group === "needs-input")
    return session.status === "failed" ? "failed" : "waiting";
  if (group === "working") return "working";
  return session.unread ? "completed" : null;
}

/**
 * The first line of the newest assistant reply, with the Markdown that would read
 * as noise in a one-line preview stripped.
 */
export function lastReplyLine(
  items: readonly TranscriptItem[] | undefined,
): string | undefined {
  if (!items) return undefined;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!;
    if (item.kind !== "message" || item.role !== "assistant") continue;
    const line = firstLine(item.content);
    if (line) return line;
  }
  return undefined;
}

function firstLine(text: string): string | undefined {
  for (const raw of text.split("\n")) {
    const line = raw
      .trim()
      .replace(/^(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+\.\s+)/u, "")
      .trim();
    if (line && !line.startsWith("```")) return line;
  }
  return undefined;
}

function runPreview(run: AutomationRun): string | undefined {
  if (run.status === "failed") return firstLine(run.error) ?? lastLine(run.output);
  return lastLine(run.output);
}

function lastLine(text: string): string | undefined {
  const lines = text.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!.trim();
    if (line) return line;
  }
  return undefined;
}

/** Newest first; an item without a timestamp keeps the order it was handed in. */
function byRecency(left: InboxItem, right: InboxItem): number {
  if (left.at === undefined || right.at === undefined) return 0;
  return right.at - left.at;
}

export function buildInbox(input: InboxInput): InboxSection[] {
  const projectOf = new Map<string, string>();
  for (const project of input.projects)
    for (const session of project.sessions)
      projectOf.set(session.id, project.name);

  const items: InboxItem[] = [];
  for (const session of input.sessions) {
    const section = inboxSectionOf(session);
    if (!section) continue;
    const at = session.updatedAtMs;
    items.push({
      kind: "session",
      key: `session:${session.id}`,
      section,
      session,
      title: session.title,
      project:
        projectOf.get(session.id) ?? projectNameOf(projectPathOf(session)),
      preview: lastReplyLine(input.transcripts?.[session.id]),
      at: typeof at === "number" && Number.isFinite(at) ? at : undefined,
    });
  }

  const automations = new Map(
    (input.automations ?? []).map((automation) => [automation.id, automation]),
  );
  for (const run of input.runs ?? []) {
    if (run.status !== "completed" && run.status !== "failed") continue;
    // A run of a deleted automation has nothing left to act on.
    const automation = automations.get(run.automationId);
    if (!automation) continue;
    const finished = Date.parse(run.finishedAt ?? "");
    if (!Number.isFinite(finished)) continue;
    if (input.now - finished > AUTOMATION_RUN_WINDOW_MS) continue;
    items.push({
      kind: "automation-run",
      key: `automation-run:${run.id}`,
      section: run.status,
      run,
      title: automation.name,
      project: directoryName(automation.workspace),
      preview: runPreview(run),
      at: finished,
    });
  }

  return INBOX_SECTION_ORDER.map((id) => ({
    id,
    items: items.filter((item) => item.section === id).sort(byRecency),
  })).filter((section) => section.items.length > 0);
}

/** "now", "8m", "2h", "3d": the rail's label, measured at render time. */
export function elapsedLabel(at: number, now: number): string {
  const elapsed = Math.max(0, now - at);
  if (elapsed < 60_000) return "now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h`;
  return `${Math.floor(elapsed / 86_400_000)}d`;
}
