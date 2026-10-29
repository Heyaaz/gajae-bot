import { useEffect, useState } from "react";
import type { SettingsDesktopBridge } from "../../shared/agent-contract";
import { DEFAULT_QUICK_INPUT_SHORTCUT } from "../../shared/desktop-integration";
import type { QuickInputShortcutStatus } from "../../shared/quick-input";
import { t } from "../i18n";

function statusText(status: QuickInputShortcutStatus | null): string {
  if (!status) return "";
  switch (status.state) {
    case "off":
      return t("꺼져 있습니다.");
    case "registered":
      return t`${status.accelerator} 등록됨. 눌러도 창이 열리지 않으면 다른 앱이 같은 단축키를 쓰고 있을 수 있습니다.`;
    case "failed":
      return status.reason === "invalid"
        ? t`${status.accelerator}은(는) 단축키 형식이 아닙니다. 예: Control+Alt+Space`
        : t`${status.accelerator}을(를) 등록하지 못했습니다. 다른 앱이 쓰고 있을 수 있으니 다른 조합을 입력하세요.`;
  }
}

/**
 * The global shortcut row of the desktop tab.
 *
 * The status is read back from main after every save, because only the system
 * knows whether the keys could be taken.
 */
export function QuickInputShortcutRow({
  bridge,
  value,
  onChange,
}: {
  bridge: Pick<SettingsDesktopBridge, "quickInputShortcutStatus"> | undefined;
  value: string;
  onChange: (accelerator: string) => Promise<void>;
}) {
  const [status, setStatus] = useState<QuickInputShortcutStatus | null>(null);

  useEffect(() => {
    if (!bridge) return;
    let active = true;
    void bridge
      .quickInputShortcutStatus()
      .then((next) => {
        if (active) setStatus(next);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [bridge]);

  async function apply(accelerator: string): Promise<void> {
    await onChange(accelerator);
    if (!bridge) return;
    setStatus(await bridge.quickInputShortcutStatus().catch(() => null));
  }

  const label = t("빠른 입력 단축키");
  const failed = status?.state === "failed";
  return (
    <div className="settings-toggle-row quick-input-shortcut-row">
      <span>
        <strong>{label}</strong>
        <small>
          {t("다른 앱을 쓰는 중에도 작은 입력 창을 열어 프로젝트를 고르고 화면을 캡처해 새 세션으로 넘깁니다.")}
        </small>
        {value && (
          <input
            // Keyed by the saved value so a save or a toggle replaces the draft.
            key={value}
            aria-label={t("단축키")}
            defaultValue={value}
            spellCheck={false}
            disabled={!bridge}
            onBlur={(event) => {
              const next = event.currentTarget.value.trim();
              if (next !== value) void apply(next);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
          />
        )}
        <small className={failed ? "is-error" : undefined} role={failed ? "alert" : undefined}>
          {statusText(status)}
        </small>
      </span>
      <input
        type="checkbox"
        aria-label={label}
        checked={value !== ""}
        disabled={!bridge}
        onChange={(event) =>
          void apply(event.target.checked ? DEFAULT_QUICK_INPUT_SHORTCUT : "")
        }
      />
    </div>
  );
}
