import QRCode from "qrcode";
import { useCallback, useEffect, useState } from "react";
import {
  Check,
  ChevronDown,
  CircleAlert,
  Copy,
  ExternalLink,
  Plus,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  Trash2,
} from "lucide-react";
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
 *
 * The work is split in two. `RemoteAccessPanel` owns the bridge, the async calls,
 * and the QR image; `RemoteAccessPanelView` renders straight from its props, so the
 * loading, error, disabled, and paired states can be rendered without an Electron
 * bridge.
 */

/**
 * Copies through the browser clipboard, refusing instead of pretending.
 *
 * An unavailable clipboard must reject: a resolved optional call would let the
 * panel report "복사됨" for text that never left the page.
 */
export async function writeClipboard(text: string): Promise<void> {
  const clipboard = navigator.clipboard;
  if (!clipboard?.writeText) {
    throw new Error("클립보드를 사용할 수 없습니다. 값을 직접 선택해 복사해 주세요.");
  }
  try {
    await clipboard.writeText(text);
  } catch {
    throw new Error("복사하지 못했습니다. 값을 직접 선택해 복사해 주세요.");
  }
}

export interface RemoteAccessPanelActions {
  toggle(): void;
  refresh(): void;
  editPort(value: string): void;
  applyPort(): void;
  issueCode(permission: RemotePermission): void;
  clearCode(): void;
  setDevicePermission(deviceId: string, permission: RemotePermission): void;
  revokeDevice(deviceId: string): void;
}

export interface RemoteAccessPanelViewProps {
  state: RemoteAccessState | null;
  busy: string | null;
  error: string;
  /** SVG markup for the pairing QR, or an empty string when there is none. */
  qr: string;
  portDraft: string;
  actions: RemoteAccessPanelActions;
}

export function RemoteAccessPanelView({
  state,
  busy,
  error,
  qr,
  portDraft,
  actions,
}: RemoteAccessPanelViewProps) {
  const [copied, setCopied] = useState<"address" | "code" | null>(null);
  const [copyError, setCopyError] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const enabled = state?.enabled ?? false;
  const pairing = state?.pairing ?? null;
  const tailscale = state?.tailscale;
  /** Serve publishes the address with a trailing slash; the UI never doubles it. */
  const address = state?.baseUrl?.replace(/\/$/u, "") ?? "";
  const pending = busy !== null;

  // The code expires on the host's clock while the panel stays open, so the
  // remaining-time label is kept honest instead of freezing at first render.
  useEffect(() => {
    if (!pairing) return;
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, [pairing]);

  const pairingExpired = pairing !== null && expiryRemaining(pairing.expiresAt, now) <= 0;

  async function copy(kind: "address" | "code", text: string): Promise<void> {
    try {
      await writeClipboard(text);
      setCopyError("");
      setCopied(kind);
      window.setTimeout(() => setCopied(null), 1400);
    } catch (failure) {
      setCopied(null);
      setCopyError(message(failure));
    }
  }

  const statusTone = !tailscale?.installed ? "is-off" : tailscale.connected ? "is-on" : "is-warn";
  const statusTitle = !tailscale
    ? "Tailscale 상태 확인 중"
    : !tailscale.installed
      ? "Tailscale이 설치되어 있지 않습니다"
      : tailscale.connected
        ? `Tailscale 연결됨${tailscale.version ? ` · ${tailscale.version}` : ""}`
        : "Tailscale에 연결되어 있지 않습니다";

  return (
    <div className="remote-panel">
      {error && (
        <p className="remote-alert" role="alert">
          <CircleAlert size={15} />
          <span>{error}</span>
        </p>
      )}
      {state?.error && (
        <p className="remote-alert" role="alert">
          <CircleAlert size={15} />
          <span>{state.error}</span>
        </p>
      )}
      {!state && !error && (
        <p className="remote-alert remote-alert--pending" role="status">
          <span className="mini-spinner" aria-hidden="true" />
          <span>원격 접속 상태를 불러오는 중입니다.</span>
        </p>
      )}
      {copyError && (
        <p className="remote-alert" role="alert">
          <CircleAlert size={15} />
          <span>{copyError}</span>
        </p>
      )}

      <section className="remote-card remote-toggle">
        <div className="remote-toggle__text">
          <h3 id="remote-enabled-heading">원격 접속 사용</h3>
          <p>
            켜면 Tailscale 테일넷의 기기가 이 컴퓨터의 HTTPS 주소에 닿을 수 있습니다.
            서버는 loopback에만 열려 공개 인터넷에는 노출되지 않고, 세션 데이터는
            페어링한 기기와 Tailscale이 이 계정의 소유자로 확인한 기기만 받습니다.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-labelledby="remote-enabled-heading"
          className={`remote-switch${enabled ? " is-on" : ""}`}
          disabled={pending || !state}
          onClick={actions.toggle}
        >
          <span className="remote-switch__track" aria-hidden="true">
            <span className="remote-switch__thumb" />
          </span>
          <span className="remote-switch__state">
            {!state ? "불러오는 중" : enabled ? "켜짐" : "꺼짐"}
          </span>
        </button>
      </section>

      {state && (
        <>
          <section className="remote-card remote-status">
            <div className="remote-card__head">
              <h3 id="remote-status-heading">연결 상태</h3>
              <button
                type="button"
                className="remote-icon-button"
                title="상태 다시 확인"
                aria-label="상태 다시 확인"
                disabled={pending}
                onClick={actions.refresh}
              >
                <RefreshCw size={14} />
              </button>
            </div>
            <div className="remote-status__line">
              <span className={`remote-status__dot ${statusTone}`} aria-hidden="true" />
              <span className="remote-status__text">
                <strong>{statusTitle}</strong>
                <small>{tailscale?.detail ?? "Tailscale 상태를 확인하지 못했습니다."}</small>
              </span>
            </div>
            <div className="remote-address">
              <span className={`remote-address__value${address ? "" : " is-empty"}`}>
                {address || "아직 접속 주소가 없습니다"}
              </span>
              {address && (
                <span className="remote-address__actions">
                  <button
                    type="button"
                    className={`remote-icon-button${copied === "address" ? " is-done" : ""}`}
                    title="주소 복사"
                    aria-label="주소 복사"
                    onClick={() => void copy("address", address)}
                  >
                    {copied === "address" ? <Check size={14} /> : <Copy size={14} />}
                  </button>
                  <a
                    className="remote-icon-button"
                    href={address}
                    target="_blank"
                    rel="noreferrer"
                    title="주소 열기"
                    aria-label="주소 열기"
                  >
                    <ExternalLink size={14} />
                  </a>
                </span>
              )}
            </div>
            <ul className="remote-guidance">
              <li>
                <strong>같은 Tailscale 계정</strong>
                <span>위 주소를 열면 바로 연결됩니다.</span>
              </li>
              <li>
                <strong>다른 계정·기기</strong>
                <span>아래 연결 코드를 입력하거나 QR을 스캔하세요.</span>
              </li>
            </ul>
            {state.enabled && !state.running && (
              <p className="remote-alert remote-alert--warning" role="status">
                <CircleAlert size={15} />
                <span>원격 접속이 켜져 있지만 서버가 실행되지 않았습니다.</span>
              </p>
            )}
          </section>

          <section className="remote-card remote-pairing">
            <div className="remote-pairing__text">
              <h3 id="remote-pairing-heading">기기 연결</h3>
              <p>
                코드는 5분 동안 한 번만 사용할 수 있습니다. 코드를 만든 뒤 휴대폰에서
                입력하거나 QR을 스캔하세요.
              </p>
            </div>
            <div className="remote-pairing__actions">
              <button
                type="button"
                className="button-secondary"
                disabled={pending || !state.enabled}
                onClick={() => actions.issueCode("view")}
              >
                <Plus size={14} /> 보기 전용 코드
              </button>
              <button
                type="button"
                className="button-primary"
                disabled={pending || !state.enabled}
                onClick={() => actions.issueCode("control")}
              >
                <ShieldCheck size={14} /> 조작 가능 코드
              </button>
            </div>
            {pairing && (
              <div className={`remote-code${pairingExpired ? " is-expired" : ""}`}>
                <span className="remote-code__value">
                  <code>{pairing.code}</code>
                  <small>{`${remotePermissionLabel(pairing.permission)} · ${expiryLabel(pairing.expiresAt, now)}`}</small>
                </span>
                <span className="remote-code__actions">
                  <button
                    type="button"
                    className={`remote-icon-button${copied === "code" ? " is-done" : ""}`}
                    title="연결 코드 복사"
                    aria-label="연결 코드 복사"
                    onClick={() => void copy("code", pairing.code)}
                  >
                    {copied === "code" ? <Check size={14} /> : <Copy size={14} />}
                  </button>
                  <button
                    type="button"
                    className="remote-icon-button remote-icon-button--danger"
                    title="연결 코드 취소"
                    aria-label="연결 코드 취소"
                    disabled={pending}
                    onClick={actions.clearCode}
                  >
                    <Trash2 size={14} />
                  </button>
                </span>
              </div>
            )}
            {pairing && pairingExpired && (
              <p className="remote-hint">코드가 만료되었습니다. 위에서 새 코드를 만들어 주세요.</p>
            )}
            {pairing && !pairingExpired && qr && (
              <div
                className="remote-qr"
                role="img"
                aria-label="기기 연결 QR 코드"
                dangerouslySetInnerHTML={{ __html: qr }}
              />
            )}
          </section>

          <section className="remote-card remote-devices-card">
            <div className="remote-card__head">
              <h3 id="remote-devices-heading">허용된 기기</h3>
              <span className="remote-count">{state.devices.length}</span>
            </div>
            {state.devices.length === 0 ? (
              <div className="remote-empty">
                <Smartphone size={16} aria-hidden="true" />
                <strong>연결된 기기가 없습니다</strong>
                <small>위에서 연결 코드를 만들면 휴대폰이 이 목록에 나타납니다.</small>
              </div>
            ) : (
              <ul className="remote-devices">
                {state.devices.map((device) => (
                  <li key={device.id}>
                    <span className="remote-devices__meta">
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
                        disabled={pending}
                        onChange={(event) =>
                          actions.setDevicePermission(
                            device.id,
                            event.target.value as RemotePermission,
                          )
                        }
                      >
                        <option value="view">보기 전용</option>
                        <option value="control">조작 가능</option>
                      </select>
                      <button
                        type="button"
                        className="button-danger"
                        aria-label={`${device.name} 접근 해제`}
                        disabled={pending}
                        onClick={() => actions.revokeDevice(device.id)}
                      >
                        접근 해제
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <details className="remote-card remote-advanced">
            <summary>
              <ChevronDown size={14} className="remote-advanced__chevron" aria-hidden="true" />
              <span className="remote-advanced__title">고급 설정</span>
              <span className="remote-advanced__meta">{`loopback 포트 ${state.port}`}</span>
            </summary>
            <div className="remote-advanced__body">
              <span className="remote-advanced__text">
                <strong>포트</strong>
                <small>호스트의 loopback 포트입니다. Tailscale Serve가 이 포트로 연결합니다.</small>
              </span>
              <span className="remote-port">
                <input
                  value={portDraft}
                  inputMode="numeric"
                  aria-label="원격 접속 포트"
                  placeholder="8791"
                  onChange={(event) => actions.editPort(event.target.value)}
                />
                <button
                  type="button"
                  className="button-secondary"
                  disabled={pending || portDraft === String(state.port)}
                  onClick={actions.applyPort}
                >
                  적용
                </button>
              </span>
            </div>
          </details>
        </>
      )}

      <p className="remote-footnote">
        <Check size={13} aria-hidden="true" />
        <span>
          원격 설정은 저장 버튼 없이 즉시 적용됩니다. 접근을 해제한 기기는 열려 있던
          실시간 연결도 함께 끊깁니다.
        </span>
      </p>
    </div>
  );
}

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

  return (
    <RemoteAccessPanelView
      state={state}
      busy={busy}
      error={error}
      qr={qr}
      portDraft={portDraft}
      actions={{
        toggle: () => void run("toggle", () => bridge.setEnabled(!(state?.enabled ?? false))),
        refresh: () => void refresh(),
        editPort: (value) => setPortDraft(value),
        applyPort: () => void run("port", () => bridge.setPort(Number(portDraft))),
        issueCode: (permission) =>
          void run("pairing", () => bridge.issuePairingCode(permission)),
        clearCode: () => void run("clear-pairing", () => bridge.clearPairingCode()),
        setDevicePermission: (deviceId, permission) =>
          void run("permission", () => bridge.setDevicePermission(deviceId, permission)),
        revokeDevice: (deviceId) =>
          void run("revoke", () => bridge.revokeDevice(deviceId)),
      }}
    />
  );
}

function expiryRemaining(expiresAt: string, now: number): number {
  const remaining = new Date(expiresAt).getTime() - now;
  return Number.isFinite(remaining) ? remaining : 0;
}

function expiryLabel(expiresAt: string, now: number): string {
  const remaining = expiryRemaining(expiresAt, now);
  if (remaining <= 0) return "만료됨";
  const minutes = Math.floor(remaining / 60_000);
  const seconds = Math.floor((remaining % 60_000) / 1000);
  return minutes > 0 ? `${minutes}분 남음` : `${seconds}초 남음`;
}

function message(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure);
}
