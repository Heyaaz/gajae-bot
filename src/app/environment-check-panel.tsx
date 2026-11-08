import { useEffect, useState } from "react";
import { Check, CircleAlert, CircleX } from "lucide-react";
import type { SettingsDesktopBridge } from "../../shared/agent-contract";
import {
  ENVIRONMENT_MINIMUM_VERSIONS,
  type EnvironmentCheckId,
  type EnvironmentCheckRow,
  type EnvironmentProblem,
  type EnvironmentReport,
} from "../../shared/environment-check";
import { t } from "../i18n";
import { MessageCopyButton } from "./primitives";

const CHECK_LABELS: Record<EnvironmentCheckId, () => string> = {
  bun: () => "Bun",
  gjc: () => "GJC",
  "provider-login": () => t("AI 모델 가용성"),
  "model-preset": () => t("기본 모델 프로필"),
  gh: () => t("GitHub CLI 로그인"),
  tailscale: () => "Tailscale",
};

const PROBLEM_TEXT: Record<
  EnvironmentProblem,
  (row: EnvironmentCheckRow) => string
> = {
  "not-found": () => t("설치되어 있지 않거나 PATH에서 찾지 못했습니다"),
  "too-old": (row) =>
    t`${ENVIRONMENT_MINIMUM_VERSIONS[row.id] ?? ""} 이상이 필요합니다`,
  unreadable: () => t("실행했지만 버전을 읽지 못했습니다"),
  "unknown-preset": () =>
    t("models.yml에 없는 프로필입니다. GJC 내장 프로필이면 그대로 동작합니다"),
  "signed-out": () => t("로그인되어 있지 않습니다"),
  "not-running": () => t("설치되어 있지만 연결되어 있지 않습니다"),
  "no-provider": () =>
    t(
      "사용 가능한 AI 모델이 없습니다. AI에 로그인하거나 프록시 연결을 설정하세요",
    ),
  "provider-unreadable": () =>
    t("AI 모델 목록을 확인하지 못했습니다. 다시 점검하세요"),
};

const STATUS_ICONS = {
  ok: Check,
  missing: CircleX,
  warning: CircleAlert,
} as const;

function EnvironmentRow({
  row,
  onLogin,
}: {
  row: EnvironmentCheckRow;
  onLogin?: () => void;
}) {
  const Icon = STATUS_ICONS[row.status];
  return (
    <div className={`environment-row environment-row--${row.status}`}>
      <Icon className="environment-row-icon" size={15} aria-hidden="true" />
      <span className="environment-row-body">
        <strong>
          {CHECK_LABELS[row.id]()}
          {!row.required && <em>{t("선택")}</em>}
        </strong>
        {row.status !== "ok" && <small>{PROBLEM_TEXT[row.problem](row)}</small>}
        {row.providerAuthentication === "unknown" && (
          <small>{t("로그인 상태 및 자격증명 종류는 확인하지 않음")}</small>
        )}
        {row.detail && (
          <code className="environment-row-detail">{row.detail}</code>
        )}
        {row.status !== "ok" &&
          (row.problem === "no-provider" && onLogin ? (
            <span className="environment-row-fix">
              <button
                type="button"
                className="button-primary"
                onClick={onLogin}
              >
                {t("AI 로그인")}
              </button>
            </span>
          ) : (
            <span className="environment-row-fix">
              <code>{row.fix}</code>
              <MessageCopyButton text={row.fix} />
            </span>
          ))}
      </span>
    </div>
  );
}

/**
 * Whether this Mac has what Gajae runs on, with the command for anything missing.
 *
 * This panel only looks: every fix is a command for the user to run, except
 * signing in, which opens the app's own flow. The one install the app does itself,
 * GJC on a Mac without it, is first-run setup's explicit step with its own progress.
 */
export function EnvironmentCheckPanel({
  bridge,
  onLogin,
}: {
  bridge: Pick<SettingsDesktopBridge, "checkEnvironment"> | undefined;
  /** Opens the sign-in flow; the one fix here that is not a command to copy. */
  onLogin?: () => void;
}) {
  const [report, setReport] = useState<EnvironmentReport | null>(null);
  const [checking, setChecking] = useState(Boolean(bridge));
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!bridge) return;
    let active = true;
    bridge
      .checkEnvironment()
      .then(
        (next) => {
          if (!active) return;
          setReport(next);
          setError("");
        },
        (cause: unknown) => {
          if (active)
            setError(t(cause instanceof Error ? cause.message : String(cause)));
        },
      )
      .finally(() => {
        if (active) setChecking(false);
      });
    return () => {
      active = false;
    };
  }, [bridge, attempt]);

  return (
    <div className="settings-stack">
      <div className="settings-panel environment-check">
        <div className="gjc-update-row">
          <span>
            <strong>{t("환경 점검")}</strong>
            <small>
              {error ||
                (report
                  ? report.ready
                    ? t("필수 항목이 모두 준비됐습니다")
                    : t("필수 항목 중 준비되지 않은 것이 있습니다")
                  : t("점검 중…"))}
            </small>
          </span>
          <span className="gjc-update-actions">
            <button
              type="button"
              disabled={!bridge || checking}
              onClick={() => {
                setChecking(true);
                setAttempt((value) => value + 1);
              }}
            >
              {checking ? t("점검 중…") : t("다시 점검")}
            </button>
          </span>
        </div>
        {report?.rows.map((row) => (
          <EnvironmentRow key={row.id} row={row} onLogin={onLogin} />
        ))}
      </div>
      <p className="settings-note">
        {t("필요한 명령을 복사해 터미널에서 실행한 뒤 다시 점검하세요.")}
      </p>
    </div>
  );
}
