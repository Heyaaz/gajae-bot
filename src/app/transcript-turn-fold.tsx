import { ChevronRight } from "lucide-react";
import { memo } from "react";
import { t, useLanguage } from "../i18n";
import type { TurnFold } from "../transcript-utils";

export const NO_OPEN_FOLDS: ReadonlySet<string> = new Set();

function turnFoldLabel(minutes: number | null): string {
  if (minutes === null) return t("작업 내역");
  if (minutes < 1) return t("1분 안에 작업함");
  if (minutes < 60) return t`${minutes}분 동안 작업함`;
  return t`${Math.floor(minutes / 60)}시간 ${minutes % 60}분 동안 작업함`;
}

/** A finished turn's work between its prompt and final answer, as one line that opens it. */
export const TurnFoldRow = memo(function TurnFoldRow({
  fold,
  open,
  onToggle,
}: {
  fold: TurnFold;
  open: boolean;
  onToggle: (id: string, open: boolean) => void;
}) {
  useLanguage();
  return (
    <div className={`transcript-entry turn-fold${open ? " is-open" : ""}`}>
      <button type="button" aria-expanded={open} onClick={() => onToggle(fold.id, !open)}>
        <ChevronRight size={13} aria-hidden="true" />
        <span>{turnFoldLabel(fold.minutes)}</span>
        {fold.failedCount > 0 && (
          <span className="turn-fold-failed">{t`실패 ${fold.failedCount}개`}</span>
        )}
      </button>
    </div>
  );
});
