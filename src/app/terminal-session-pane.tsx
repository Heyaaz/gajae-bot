import { SquareTerminal } from "lucide-react";
import type { AgentSession } from "../backend/types";
import { t } from "../i18n";
import { TerminalView } from "./terminal-view";

/** A terminal session in place of a conversation: its title, folder, and terminal. */
export function TerminalSessionPane({ session }: { session: AgentSession }) {
  return (
    <main className="workspace" data-surface="terminal">
      <header className="chat-header">
        <div className="chat-identity">
          <span className="header-avatar header-avatar--terminal">
            <SquareTerminal size={18} aria-hidden="true" />
          </span>
          <span>
            <strong>{session.title}</strong>
            <small>
              {t("CLI")}
              <span className="chat-branch" title={session.workspace}>
                {session.subtitle}
              </span>
            </small>
          </span>
        </div>
      </header>
      <div className="workspace-body">
        <TerminalView
          key={session.id}
          session={session.id}
          cwd={session.workspace}
          active
          hidden={false}
        />
      </div>
    </main>
  );
}
