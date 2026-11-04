import type { RefObject } from "react";
import { Command, Sparkles } from "lucide-react";
import type { AgentCommand } from "../backend/types";
import { t } from "../i18n";

interface CommandListProps {
  paletteRef: RefObject<HTMLDivElement | null>;
  commands: AgentCommand[];
  commandsPending: boolean;
  commandIndex: number;
  onSelect: (command: AgentCommand) => void;
}

export function CommandList({ paletteRef, commands: matchingCommands, commandsPending, commandIndex, onSelect }: CommandListProps) {
  return (
        <div className="command-palette" ref={paletteRef}>
          <header>
            <Sparkles size={14} /> {t("스킬 및 명령어")} <span className="command-palette-count">{matchingCommands.length}</span>
            <span className="command-palette-help">
              {commandsPending
                ? t("스킬 불러오는 중…")
                : t("↑↓ 선택 · Enter 적용")}
            </span>
          </header>
          {matchingCommands.map((command, index) => (
            <button
              key={command.name}
              type="button"
              data-command-index={index}
              className={`command-palette-item${index === commandIndex ? " is-selected" : ""}${command.name.startsWith("skill:") ? " is-skill" : ""}`}
              aria-label={`/${command.name}${command.description ? ` — ${command.description}` : ""}`}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onSelect(command)}
            >
              <span className="command-palette-icon" aria-hidden>
                {command.name.startsWith("skill:") ? <Sparkles size={15} /> : <Command size={15} />}
              </span>
              <span className="command-palette-copy">
                <strong>{command.name.startsWith("skill:") ? command.name.slice(6) : `/${command.name}`}</strong>
                <small title={command.description}>{command.description}</small>
              </span>
              <span className="command-palette-meta">
                {command.name.startsWith("skill:") && <span className="command-skill-badge">{t("스킬")}</span>}
                {command.hint && <code>{command.hint}</code>}
              </span>
            </button>
          ))}
          {matchingCommands.length === 0 && commandsPending && (
            <small className="command-palette-loading">
              {t("스킬 불러오는 중…")}
            </small>
          )}
        </div>
  );
}
