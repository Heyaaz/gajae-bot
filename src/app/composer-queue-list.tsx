import { canMoveRequest } from "../composer-utils";
import type { PendingRequest } from "../composer-utils";
import { t } from "../i18n";
import { QueueChip } from "./composer-queue-chip";

interface QueueListProps {
  queue: PendingRequest[];
  readOnly: boolean;
  onMove: (id: string, offset: -1 | 1) => void;
  onPull: (id: string) => void;
  onDiscard: (id: string) => void;
  onSendNow: (id: string) => Promise<void>;
}

export function QueueList({ queue: pendingQueue, readOnly, onMove, onPull, onDiscard, onSendNow }: QueueListProps) {
  return (
        <div className={`composer-queue${pendingQueue[0]?.blocked ? " composer-queue--blocked" : ""}`}>
          <div className="composer-queue-items">
            {pendingQueue.map((entry) => (
              <QueueChip key={entry.id} entry={entry}
                reorderable={pendingQueue.length > 1}
                onMoveUp={canMoveRequest(pendingQueue, entry.id, -1)
                  ? () => onMove(entry.id, -1) : undefined}
                onMoveDown={canMoveRequest(pendingQueue, entry.id, 1)
                  ? () => onMove(entry.id, 1) : undefined}
                onPull={() => onPull(entry.id)}
                onDiscard={() => onDiscard(entry.id)}
                onSendNow={() => { void onSendNow(entry.id); }}
                disabled={readOnly} />
            ))}
          </div>
          {pendingQueue[0]?.blocked && <small role="status">
            {t("이미 처리됐을 수 있습니다. 대화 기록을 확인한 뒤 항목을 꺼내거나 버리세요.")}
          </small>}
        </div>
  );
}
