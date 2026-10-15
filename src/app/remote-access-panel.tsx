import QRCode from "qrcode";
import { useCallback, useEffect, useState } from "react";
import { Check, Copy, Plus, RefreshCw, ShieldCheck, Trash2, Wifi } from "lucide-react";
import {
  remotePermissionLabel,
  type RemoteAccessState,
  type RemotePermission,
} from "../../shared/remote-protocol";

/**
 * Desktop-side remote access: the host's switchboard.
 *
 * Everything a phone needs comes from here — the HTTPS address, the pairing code,
 * and the per-device permission. The panel keeps the two questions a user actually
 * asks separate: can this machine be reached at all (Tailscale, Serve), and which
 * devices are allowed in (the device list).
 */

export function RemoteAccessPanel() {
  const bridge = window.agentControlDesktop?.remote;
  const [state, setState] = useState<RemoteAccessState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [qr, setQr] = useState<string>("");
  const [portDraft, setPortDraft] = useState("");

  const apply = useCallback((next: RemoteAccessState) => {
    setState(next);
    if (next.port) setPortDraft(String(next.port));
  }, []);

  const refresh = useCallback(async () => {
    if (!bridge) return;
    try {
      apply(await bridge.refresh());
      setError("");
    } catch (failure) {
      setError(message(failure));
    }
  }, [apply, bridge]);

  useEffect(() => {
    if (!bridge) return;
    let active = true;
    void bridge
      .getState()
      .then((next) => {
        if (active) apply(next);
      })
      .catch((failure: unknown) => {
        if (active) setError(message(failure));
      });
    return () => {
      active = false;
    };
  }, [apply, bridge]);

  const pairingUrl = state?.baseUrl
    ? `${state.baseUrl.replace(/\/$/u, "")}/#pair=${state.pairing?.code ?? ""}`
    : "";

  useEffect(() => {
    if (!state?.pairing?.code || !pairingUrl) {
      setQr("");
      return;
    }
    let active = true;
    void QRCode.toString(pairingUrl, { type: "svg", margin: 1, width: 220 })
      .then((svg) => {
        if (active) setQr(svg);
      })
      .catch(() => {
        if (active) setQr("");
      });
    return () => {
      active = false;
    };
  }, [pairingUrl, state?.pairing?.code]);

  if (!bridge) return <p className="settings-note">데스크톱 앱에서만 설정할 수 있습니다.</p>;

  async function run(label: string, action: () => Promise<RemoteAccessState>): Promise<void> {
    setBusy(label);
    setError("");
    try {
      apply(await action());
    } catch (failure) {
      setError(message(failure));
    } finally {
      setBusy(null);
    }
  }

  const tailscale = state?.tailscale;

  return (
    <div className="settings-stack remote-panel">
      <div className="settings-panel">
        <label>
          <span>
            <strong>원격 접속</strong>
            <small>
              Tailscale 네트워크에서 이 컴퓨터의 GJC 세션을 휴대폰·다른 기기에서
              조회합니다. 서버는 loopback에만 열리고 공개 인터넷에는 노출되지
              않습니다.
            </small>
          </span>
          <button
            type="button"
            className={state?.enabled ? "button-primary" : "button-secondary"}
            disabled={busy !== null || !state}
            onClick={() =>
              void run("toggle", () => bridge.setEnabled(!(state?.enabled ?? false)))
            }
          >
            {state?.enabled ? "사용 중" : "꺼짐"}
          </button>
        </label>
        <label>
          <span>
            <strong>포트</strong>
            <small>호스트의 loopback 포트입니다. Tailscale Serve가 이 포트로 연결합니다.</small>
          </span>
          <span className="remote-port">
            <input
              value={portDraft}
              inputMode="numeric"
              onChange={(event) => setPortDraft(event.target.value)}
              placeholder="8791"
            />
            <button
              type="button"
              disabled={busy !== null || portDraft === String(state?.port ?? "")}
              onClick={() => void run("port", () => bridge.setPort(Number(portDraft)))}
            >
              적용
            </button>
          </span>
        </label>
      </div>

      <div className="settings-panel">
        <div className="remote-status">
          <span className={`remote-status__dot ${tailscale?.installed ? (tailscale.connected ? "is-on" : "is-warn") : "is-off"}`} />
          <span>
            <strong>
              {tailscale?.installed
                ? tailscale.connected
                  ? `Tailscale 연결됨${tailscale.version ? ` · ${tailscale.version}` : ""}`
                  : "Tailscale 연결 안 됨"
                : "Tailscale 미설치"}
            </strong>
            <small>
              {state?.baseUrl
                ? state.baseUrl
                : tailscale?.detail ?? "접속 주소를 확인할 수 없습니다."}
            </small>
          </span>
          <button
            className="icon-button"
            type="button"
            title="상태 다시 확인"
            disabled={busy !== null}
            onClick={() => void refresh()}
          >
            <RefreshCw size={15} />
          </button>
        </div>
        {state?.baseUrl && state.running && (
          <p className="settings-note">
            휴대폰에서 {state.baseUrl} 을 열고 연결 코드를 입력하거나, 아래 QR을
            스캔하세요.
          </p>
        )}
        {state && state.enabled && !state.running && (
          <p className="diff-error">원격 서버가 실행되지 않았습니다.</p>
        )}
      </div>

      <div className="settings-panel">
        <div className="remote-pairing">
          <span>
            <strong>기기 연결</strong>
            <small>
              코드는 5분 동안 한 번만 사용할 수 있습니다. 코드를 만든 뒤 휴대폰에서
              입력하거나 QR을 스캔하세요.
            </small>
          </span>
          <span className="remote-pairing__actions">
            <button
              type="button"
              disabled={busy !== null || !state?.enabled}
              onClick={() => void run("pair-view", () => bridge.issuePairingCode("view"))}
            >
              <Plus size={14} /> 보기 전용 코드
            </button>
            <button
              type="button"
              className="button-primary"
              disabled={busy !== null || !state?.enabled}
              onClick={() =>
                void run("pair-control", () => bridge.issuePairingCode("control"))
              }
            >
              <ShieldCheck size={14} /> 조작 가능 코드
            </button>
          </span>
        </div>
        {state?.pairing && (
          <div className="remote-pairing__code">
            <code>{state.pairing.code}</code>
            <span>
              {remotePermissionLabel(state.pairing.permission)} ·{" "}
              {expiryLabel(state.pairing.expiresAt)}
            </span>
            <button
              type="button"
              title="코드 복사"
              onClick={() => void navigator.clipboard?.writeText(state.pairing!.code)}
            >
              <Copy size={14} />
            </button>
            <button
              type="button"
              title="코드 취소"
              onClick={() => void run("clear-pairing", () => bridge.clearPairingCode())}
            >
              <Trash2 size={14} />
            </button>
          </div>
        )}
        {qr && state?.pairing && (
          <div
            className="remote-qr"
            role="img"
            aria-label="기기 연결 QR 코드"
            dangerouslySetInnerHTML={{ __html: qr }}
          />
        )}
      </div>

      <div className="settings-panel">
        <h3 className="remote-devices__title">
          <Wifi size={15} /> 허용된 기기 {state?.devices.length ?? 0}
        </h3>
        {state && state.devices.length === 0 && (
          <p className="settings-note">연결된 기기가 없습니다.</p>
        )}
        <ul className="remote-devices">
          {state?.devices.map((device) => (
            <li key={device.id}>
              <span>
                <strong>{device.name}</strong>
                <small>
                  {device.lastSeenAt
                    ? `마지막 사용 ${new Date(device.lastSeenAt).toLocaleString()}`
                    : "아직 사용되지 않음"}
                  {device.clientAddress ? ` · ${device.clientAddress}` : ""}
                </small>
              </span>
              <span className="remote-devices__actions">
                <select
                  value={device.permission}
                  aria-label={`${device.name} 권한`}
                  disabled={busy !== null}
                  onChange={(event) =>
                    void run("permission", () =>
                      bridge.setDevicePermission(
                        device.id,
                        event.target.value as RemotePermission,
                      ),
                    )
                  }
                >
                  <option value="view">보기 전용</option>
                  <option value="control">조작 가능</option>
                </select>
                <button
                  type="button"
                  className="button-danger"
                  disabled={busy !== null}
                  onClick={() => void run("revoke", () => bridge.revokeDevice(device.id))}
                >
                  접근 해제
                </button>
              </span>
            </li>
          ))}
        </ul>
      </div>

      {error && <p className="diff-error">{error}</p>}
      {state?.error && <p className="diff-error">{state.error}</p>}
      {!state && <p className="settings-note">불러오는 중…</p>}
      {state?.enabled && (
        <p className="settings-note">
          <Check size={13} /> 접근 해제는 즉시 적용됩니다. 해제된 기기는 열려 있던
          실시간 연결도 함께 끊깁니다.
        </p>
      )}
    </div>
  );
}

function expiryLabel(expiresAt: string): string {
  const remaining = new Date(expiresAt).getTime() - Date.now();
  if (!Number.isFinite(remaining) || remaining <= 0) return "만료됨";
  const minutes = Math.floor(remaining / 60_000);
  const seconds = Math.floor((remaining % 60_000) / 1000);
  return minutes > 0 ? `${minutes}분 남음` : `${seconds}초 남음`;
}

function message(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure);
}
