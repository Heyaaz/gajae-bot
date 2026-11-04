import type { TranscriptItem } from "../backend/types";
import { summarizeToolRun, toolRunCollapsed, type ToolRunManualState } from "../transcript-utils";
import { TerminalSquare } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { t } from "../i18n";
import { TranscriptItemView } from "./transcript-item-view";
import type { TranscriptProps } from "./transcript";

/**
 * A tool-run block, collapsed to a one-line summary in `basic` view mode.
 *
 * A run containing a failure or a pending approval starts expanded so it is not
 * missed. The user can still collapse it after reading the failure; the summary
 * keeps the failure/approval count visible so the choice does not hide it. A new
 * failure reopens the run.
 */
export function ToolRunBlockView({
  items,
  toolViewMode,
  thoughtsExpanded,
  onToggleThoughtsExpanded,
  onResolveTool,
  onReadArtifact,
  autoDenyHint,
  onRevealInspector,
}: {
  items: Extract<TranscriptItem, { kind: "tool" }>[];
  toolViewMode: "basic" | "reasoning" | "detailed";
  thoughtsExpanded: boolean;
  onToggleThoughtsExpanded?: () => void;
  onResolveTool: TranscriptProps["onResolveTool"];
  onReadArtifact: TranscriptProps["onReadArtifact"];
  autoDenyHint?: TranscriptProps["autoDenyHint"];
  onRevealInspector?: TranscriptProps["onRevealInspector"];
}) {
  const summary = useMemo(() => summarizeToolRun(items), [items]);
  const needsAttention = !summary.allCompleted;
  const [manual, setManual] = useState<ToolRunManualState>("auto");
  // A failure that arrives while the run is collapsed must not stay hidden.
  const previousAttention = useRef(needsAttention);
  useEffect(() => {
    if (needsAttention && !previousAttention.current) setManual("auto");
    previousAttention.current = needsAttention;
  }, [needsAttention]);
  const collapsed = toolRunCollapsed(toolViewMode, needsAttention, manual);
  if (!collapsed) {
    return (
      <div className="transcript-entry tool-run">
        {toolViewMode === "basic" && (
          <button
            type="button"
            className="tool-run-collapse"
            onClick={() => setManual("collapsed")}
          >
            {t("접기")} </button>
        )}
        {items.map((tool) => (
          <div
            className="tool-run-entry"
            id={`transcript-${encodeURIComponent(tool.id)}`}
            key={tool.id}
          >
            <TranscriptItemView
              item={tool}
              thoughtsExpanded={thoughtsExpanded}
              onToggleThoughtsExpanded={onToggleThoughtsExpanded}
              onResolveTool={onResolveTool}
              onReadArtifact={onReadArtifact}
              autoDenyHint={autoDenyHint}
              onRevealInspector={onRevealInspector}
            />
          </div>
        ))}
      </div>
    );
  }
  const parts: string[] = [];
  if (summary.commandCount > 0) parts.push(t`명령 ${summary.commandCount}개 실행`);
  if (summary.fileCount > 0)
    parts.push(
      t`파일 ${summary.fileCount}개 수정 (+${summary.added} \u2212${summary.removed})`,
    );
  if (summary.failedCount > 0)
    parts.push(t`실패 ${summary.failedCount}개`);
  if (summary.approvalRequiredCount > 0)
    parts.push(t`승인 대기 ${summary.approvalRequiredCount}개`);
  return (
    <div className="transcript-entry tool-run tool-run--collapsed">
      <button
        type="button"
        className="tool-run-summary"
        onClick={() => setManual("expanded")}
      >
        <TerminalSquare size={14} />
        <span>{parts.join(" \u00b7 ") || t`도구 ${items.length}개 실행`}</span>
      </button>
    </div>
  );
}
