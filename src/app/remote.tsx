import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw, Wifi } from "lucide-react";
import {
  remoteClientStatusLabel,
  type RemoteAccessBridge,
  type RemoteClientStatus,
} from "../../shared/remote-protocol";
import { readPairingCodeFromHash } from "../remote/client";
import gajaeIconUrl from "../assets/gajae-icon-ui.png";
import { t } from "../i18n";


/**
 * The phone-side shell: pairing first, then a status strip.
 *
 * A remote client is only useful once the host trusts it, so an unpaired or
 * revoked device sees the pairing screen instead of an empty session list.
 * A scanned QR arrives as `#pair=<code>` in the fragment, which never reaches the
 * server, and is cleared from the address bar before the code is sent.
 */

export function remoteGateNeeded(status: RemoteClientStatus | null): boolean {
  return status === null || status.state !== "connected";
}

export function RemoteGate({
  bridge,
  status,
}: {
  bridge: RemoteAccessBridge;
  status: RemoteClientStatus | null;
}) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submitted = useRef(false);

  const connect = useCallback(
    async (value: string): Promise<void> => {
      const candidate = value.trim();
      if (!candidate) {
        setError(t("연결 코드를 입력해 주세요."));
        return;
      }
      setBusy(true);
      setError("");
      try {
        await bridge.pair(candidate);
        setCode("");
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : String(failure));
      } finally {
        setBusy(false);
      }
    },
    [bridge],
  );

  useEffect(() => {
    const scanned = readPairingCodeFromHash(window.location.hash);
    if (!scanned || submitted.current) return;
    submitted.current = true;
    // Drop the code from the address bar before using it: browser history,
    // screenshots, and shared links should not carry a pairing secret.
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${window.location.search}`,
    );
    setCode(scanned);
    void connect(scanned);
  }, [bridge, connect]);

  const revoked = status?.state === "revoked";

  return (
    <div className="remote-gate">
      <div className="remote-gate__card">
        <span className="remote-gate__mark">
          <img src={gajaeIconUrl} alt="" />
        </span>
        <h1>{revoked ? t("접근이 해제되었습니다") : t("원격 접속")}</h1>
        <p className="remote-gate__detail">
          {revoked
            ? t("이 기기의 원격 접근을 호스트에서 해제했습니다. 다시 사용하려면 데스크톱에서 연결 코드를 새로 만들고 입력해 주세요.")
            : t("Gajae 데스크톱에서 ‘원격 접속’을 켜고 표시된 연결 코드를 입력하세요. QR을 스캔하면 코드가 자동으로 채워집니다.")}
        </p>
        <p className="remote-gate__origin">{window.location.origin}</p>
        <form
          className="remote-gate__form"
          onSubmit={(event) => {
            event.preventDefault();
            void connect(code);
          }}
        >
          <input
            className="remote-gate__code"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            placeholder={t("연결 코드")}
            inputMode="text"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            maxLength={16}
            aria-label={t("연결 코드")}
          />
          <button className="button-primary" type="submit" disabled={busy}>
            {busy ? <span className="mini-spinner" /> : <Wifi size={16} />}
            {busy ? t("연결 중") : t("연결")}
          </button>
        </form>
        {error && <p className="remote-gate__error">{error}</p>}
        {status?.detail && !error && (
          <p className="remote-gate__hint">{status.detail}</p>
        )}
      </div>
    </div>
  );
}

export function RemoteStrip({
  status,
  onReconnect,
}: {
  status: RemoteClientStatus;
  onReconnect: () => void;
}) {
  const viewOnly = status.permission === "view";
  const offline = status.state === "offline" || status.state === "connecting";
  if (!viewOnly && !offline) return null;
  return (
    <div className={`remote-strip ${offline ? "is-offline" : "is-viewonly"}`}>
      <span className="remote-strip__label">
        {offline ? remoteClientStatusLabel(status) : t("보기 전용 기기")}
      </span>
      <span className="remote-strip__detail">
        {offline
          ? status.detail ?? t("호스트에 다시 연결하는 중입니다.")
          : t("조회만 가능합니다. 메시지 전송과 승인은 데스크톱에서 하거나 기기 권한을 조작 가능으로 올려주세요.")}
      </span>
      {offline && (
        <button className="icon-button" type="button" title={t("다시 연결")} onClick={onReconnect}>
          <RefreshCw size={14} />
        </button>
      )}
    </div>
  );
}
