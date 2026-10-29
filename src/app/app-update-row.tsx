import { useEffect, useState } from "react";
import type { SettingsDesktopBridge } from "../../shared/agent-contract";
import type { AppUpdateStatus } from "../../shared/app-update";
import { t } from "../i18n";

function appUpdateSummary(status: AppUpdateStatus): string {
  switch (status.state) {
    case "unchecked":
      return t`${status.currentVersion} · 아직 확인하지 않았습니다`;
    case "current":
      return t`최신 버전 ${status.currentVersion}`;
    case "available":
      return t`${status.currentVersion} → ${status.latestVersion} 사용 가능`;
    case "unknown":
      return t`${status.currentVersion} · 확인할 수 없음`;
  }
}

/**
 * The Gajae release status in the desktop tab.
 *
 * A failed check is shown as "cannot check" and nothing else: the release may be
 * unpublished or the network down, and neither is something to fix from here.
 */
export function AppUpdateRow({
  bridge,
}: {
  bridge: Pick<SettingsDesktopBridge, "getAppUpdateStatus" | "checkAppUpdate"> | undefined;
}) {
  const [status, setStatus] = useState<AppUpdateStatus | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    if (!bridge) return;
    let active = true;
    void bridge
      .getAppUpdateStatus()
      .then((value) => {
        if (active) setStatus(value);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [bridge]);

  async function checkNow(): Promise<void> {
    if (!bridge) return;
    setChecking(true);
    try {
      setStatus(await bridge.checkAppUpdate());
    } catch {
      // The previous status stays; a refused check is not news.
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="gjc-update-row">
      <span>
        <strong>{t("Gajae 버전")}</strong>
        <small>{status ? appUpdateSummary(status) : t("업데이트 정보를 확인합니다")}</small>
      </span>
      <span className="gjc-update-actions">
        <button
          type="button"
          disabled={!bridge || checking}
          onClick={() => void checkNow()}
        >
          {checking ? t("확인 중…") : t("지금 확인")}
        </button>
        {status?.state === "available" && (
          <button
            type="button"
            className="button-primary"
            onClick={() => window.open(status.releaseUrl, "_blank", "noopener,noreferrer")}
          >
            {t("릴리스 페이지")}
          </button>
        )}
      </span>
    </div>
  );
}
