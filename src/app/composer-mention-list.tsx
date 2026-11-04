import type { RefObject } from "react";
import { FileText } from "lucide-react";
import type { MentionCandidates } from "../composer-mentions";
import { t } from "../i18n";

/**
 * The last workspace listing behind the `@` popup, for the session it was read
 * for. No entry for the current session means it is still loading.
 */
export type MentionFiles =
  | { sessionId: string; status: "ready"; candidates: MentionCandidates; truncated: boolean }
  | { sessionId: string; status: "failed"; message: string };

interface MentionListProps {
  paletteRef: RefObject<HTMLDivElement | null>;
  matches: string[];
  mentionIndex: number;
  files: MentionFiles | null;
  onChoose: (relativePath: string) => Promise<void>;
}

export function MentionList({ paletteRef, matches: mentionMatches, mentionIndex, files: sessionMentionFiles, onChoose }: MentionListProps) {
  return (
        <div className="command-palette mention-palette" ref={paletteRef}
          role="listbox" aria-label={t("워크스페이스 파일")}>
          <header>
            <FileText size={14} /> {t("워크스페이스 파일")}
            <span className="command-palette-count">{mentionMatches.length}</span>
            <span className="command-palette-help">{t("↑↓ 선택 · Enter 첨부 · Esc 닫기")}</span>
          </header>
          {mentionMatches.map((relativePath, index) => {
            const slash = relativePath.lastIndexOf("/");
            return (
              <button
                key={relativePath}
                type="button"
                role="option"
                aria-selected={index === mentionIndex}
                data-mention-index={index}
                className={`command-palette-item${index === mentionIndex ? " is-selected" : ""}`}
                title={relativePath}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => void onChoose(relativePath)}
              >
                <span className="command-palette-icon" aria-hidden>
                  <FileText size={15} />
                </span>
                <span className="command-palette-copy">
                  <strong>{relativePath.slice(slash + 1)}</strong>
                  <small>{slash > 0 ? relativePath.slice(0, slash) : "./"}</small>
                </span>
              </button>
            );
          })}
          {sessionMentionFiles?.status !== "ready" ? (
            <small className="command-palette-loading">
              {sessionMentionFiles?.status === "failed"
                ? sessionMentionFiles.message
                : t("파일 목록을 불러오는 중…")}
            </small>
          ) : mentionMatches.length === 0 ? (
            <small className="command-palette-loading">{t("일치하는 파일이 없습니다")}</small>
          ) : sessionMentionFiles.truncated ? (
            <small className="command-palette-loading">
              {t("파일이 많아 일부만 검색합니다")}
            </small>
          ) : null}
        </div>
  );
}
