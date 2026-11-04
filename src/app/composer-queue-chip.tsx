import { ChevronDown, ChevronUp, Pencil, X } from "lucide-react";
import type { PendingRequest } from "../composer-utils";
import { t } from "../i18n";

export interface QueueChipProps {
  entry: PendingRequest;
  onPull: () => void;
  onDiscard: () => void;
  onSendNow?: () => void;
  /** Absent when the entry cannot move that way; the button then stays, disabled, so chips line up. */
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  /** Reorder buttons render only when the queue has more than one entry. */
  reorderable?: boolean;
  disabled?: boolean;
}

/**
 * One held request with explicit send, edit, and discard controls.
 *
 * The chip body pulls the request back into the draft, where the exact text can be
 * edited or sent on its own; the × beside it discards that one entry. `type` is
 * explicit on both: the composer is a form, so a bare button here would submit the
 * draft the user is trying to take a request out of.
 */
export function QueueChip({ entry, onPull, onDiscard, onSendNow, onMoveUp, onMoveDown, reorderable = false, disabled = false }: QueueChipProps) {
  return (
    <span className={`composer-queue-item composer-queue-item--${entry.mode}${entry.blocked ? " composer-queue-item--blocked" : ""}`}>
      {reorderable && (
        <span className="composer-queue-reorder">
          <button type="button" disabled={disabled || !onMoveUp} aria-label={t("앞으로 옮기기")}
            onClick={onMoveUp}><ChevronUp size={12} /></button>
          <button type="button" disabled={disabled || !onMoveDown} aria-label={t("뒤로 옮기기")}
            onClick={onMoveDown}><ChevronDown size={12} /></button>
        </span>
      )}
      <button type="button" className="composer-queue-pull" onClick={onPull} disabled={disabled}
        title={entry.blocked ? t("이미 처리됐을 수 있습니다. 대화 기록을 확인한 뒤 입력창으로 꺼내세요.") : undefined}>
        {entry.blocked && <em>{t("확인 필요")}</em>}
        <span className="composer-queue-text">{entry.text}</span>
      </button>
      <button
        type="button"
        className="composer-queue-discard"
        disabled={disabled}
        aria-label={t("대기 항목 버리기")}
        onClick={onDiscard}
      >
        <X size={10} />
      </button>
      {onSendNow && (
        <button type="button" className="composer-queue-send" disabled={disabled || entry.blocked}
          onClick={onSendNow}>{t("지금 보내기")}</button>
      )}
      <button type="button" className="composer-queue-edit" disabled={disabled}
        aria-label={t("대기 메시지 수정")} onClick={onPull}><Pencil size={12} /></button>
    </span>
  );
}

