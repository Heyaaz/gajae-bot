import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  TERMINAL_SESSION_PREFIX,
  type TerminalSessionCreateInput,
  type TerminalSessionRecord,
} from "../shared/terminal-ipc.js";

const TITLE_LIMIT = 200;

/**
 * Terminal sessions the user made in this app, newest first. GJC's broker has
 * no record of them, so this file is the only list there is.
 */
export class TerminalSessionStore {
  private readonly filePath: string;
  private sessions: TerminalSessionRecord[];

  constructor(
    userDataDirectory: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.filePath = path.join(userDataDirectory, "terminal-sessions.json");
    this.sessions = this.read();
  }

  list(): TerminalSessionRecord[] {
    return this.sessions.map((session) => ({ ...session }));
  }

  get(sessionId: string): TerminalSessionRecord | undefined {
    const session = this.sessions.find((candidate) => candidate.id === sessionId);
    return session ? { ...session } : undefined;
  }

  create(input: TerminalSessionCreateInput): TerminalSessionRecord {
    const session: TerminalSessionRecord = {
      id: `${TERMINAL_SESSION_PREFIX}${randomUUID()}`,
      title: sessionTitle(input.title),
      workspace: path.resolve(input.workspace),
      createdAt: this.now().toISOString(),
    };
    this.sessions = [session, ...this.sessions];
    this.write();
    return { ...session };
  }

  rename(sessionId: string, title: string): void {
    const session = this.sessions.find((candidate) => candidate.id === sessionId);
    if (!session) throw new Error("Terminal session not found");
    session.title = sessionTitle(title);
    this.write();
  }

  delete(sessionId: string): void {
    const remaining = this.sessions.filter((session) => session.id !== sessionId);
    if (remaining.length === this.sessions.length) return;
    this.sessions = remaining;
    this.write();
  }

  private read(): TerminalSessionRecord[] {
    try {
      const value = JSON.parse(readFileSync(this.filePath, "utf8")) as { sessions?: unknown };
      return Array.isArray(value?.sessions) ? value.sessions.flatMap(parseRecord) : [];
    } catch {
      return [];
    }
  }

  private write(): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify({ sessions: this.sessions }, null, 2)}\n`, {
      mode: 0o600,
    });
    renameSync(temporaryPath, this.filePath);
  }
}

function sessionTitle(value: string): string {
  const title = value.trim().slice(0, TITLE_LIMIT);
  if (!title) throw new Error("Session title cannot be empty");
  return title;
}

function parseRecord(raw: unknown): TerminalSessionRecord[] {
  if (!raw || typeof raw !== "object") return [];
  const value = raw as Record<string, unknown>;
  if (
    typeof value.id !== "string" ||
    !value.id.startsWith(TERMINAL_SESSION_PREFIX) ||
    typeof value.title !== "string" ||
    !value.title.trim() ||
    typeof value.workspace !== "string" ||
    !path.isAbsolute(value.workspace) ||
    typeof value.createdAt !== "string"
  )
    return [];
  return [
    {
      id: value.id,
      title: value.title,
      workspace: value.workspace,
      createdAt: value.createdAt,
    },
  ];
}
