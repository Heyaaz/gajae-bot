import type { AgentEvent, AgentSession, BackendConnection } from "./agent-contract.js";

/**
 * Remote access is a two-sided contract.
 *
 * The desktop app hosts a loopback HTTP server that Tailscale Serve publishes to
 * the owner's tailnet. A phone or another personal machine pairs once, keeps a
 * device token, and then reads the same GJC sessions the desktop shows.
 *
 * Everything shared between the host, the phone, and the desktop settings panel
 * lives here so the three cannot drift: endpoint paths, permission rules, stream
 * frame shapes, and the error vocabulary the client renders.
 */

/** What a paired device may do. Only `control` may change anything on the host. */
export type RemotePermission = "view" | "control";

export const REMOTE_PROTOCOL_VERSION = 1;

/**
 * A fixed loopback port keeps the Tailscale Serve mapping stable across launches,
 * which matters because Serve configs are keyed by the proxied target.
 */
export const REMOTE_DEFAULT_PORT = 8791;

export const REMOTE_MIN_PORT = 1024;
export const REMOTE_MAX_PORT = 65535;

export function isRemotePermission(value: unknown): value is RemotePermission {
  return value === "view" || value === "control";
}

export function remotePermissionLabel(permission: RemotePermission): string {
  return permission === "control" ? "조작 가능" : "보기 전용";
}

export function parseRemotePort(value: unknown): number | undefined {
  const port = typeof value === "string" ? Number(value) : value;
  if (typeof port !== "number" || !Number.isInteger(port)) return undefined;
  if (port < REMOTE_MIN_PORT || port > REMOTE_MAX_PORT) return undefined;
  return port;
}

/**
 * What the desktop settings panel shows. `devices` never carries tokens: the
 * host keeps only a salted hash and the phone keeps the secret.
 */
export interface RemoteAccessState {
  enabled: boolean;
  running: boolean;
  port: number;
  /** HTTPS address published through Tailscale Serve, when it is available. */
  baseUrl?: string;
  tailscale: TailscaleSummary;
  devices: RemoteDeviceSummary[];
  pairing: RemotePairingSummary | null;
  error?: string;
}

export interface RemoteDeviceSummary {
  id: string;
  name: string;
  permission: RemotePermission;
  createdAt: string;
  lastSeenAt?: string;
  clientAddress?: string;
}

export interface RemotePairingSummary {
  code: string;
  permission: RemotePermission;
  expiresAt: string;
}

export interface TailscaleSummary {
  installed: boolean;
  connected: boolean;
  backendState?: string;
  /** MagicDNS name of this machine, e.g. `mac-mini.tailnet-abcd.ts.net`. */
  dnsName?: string;
  ipv4?: string;
  version?: string;
  serveEnabled: boolean;
  serveTarget?: string;
  serveOrigin?: string;
  detail?: string;
}

/** The authoritative snapshot a client rebuilds its view from after a gap. */
export interface RemoteSnapshot {
  connection: BackendConnection;
  sessions: AgentSession[];
  device: RemoteDeviceIdentity;
  server: {
    version: string;
    time: string;
    workspace: string;
    protocol: number;
  };
}

export interface RemoteDeviceIdentity {
  id: string;
  name: string;
  permission: RemotePermission;
  /**
   * How the host admits this client: a paired device token, or the owner's own
   * tailnet device, which `tailscale serve` proves by the login it stamps on the
   * request. Identity clients never paired and hold no token.
   */
  via?: "device" | "tailscale";
}

export type RemoteErrorCode =
  | "unauthorized"
  | "forbidden"
  | "revoked"
  | "invalid"
  | "not-found"
  | "rate-limited"
  | "unavailable"
  | "internal";

export interface RemoteErrorBody {
  error: { code: RemoteErrorCode; message: string };
}

export interface RemotePairingBody {
  deviceId: string;
  token: string;
  device: RemoteDeviceIdentity;
  server: { version: string; workspace: string; protocol: number };
}

/** Result of one control operation, replayable for a repeated operation ID. */
export interface RemoteOperationOutcome {
  operationId: string;
  state: "completed" | "failed";
  result?: unknown;
  message?: string;
  at: string;
}

export interface RemoteEventFrame {
  seq: number;
  event: AgentEvent;
}

/**
 * Sent when the server cannot replay from the client's cursor. The client
 * responds by refetching the snapshot instead of guessing at missed state.
 */
export interface RemoteResyncFrame {
  seq: number;
  resync: true;
  reason: string;
}

export type RemoteStreamFrame = RemoteEventFrame | RemoteResyncFrame;

export function isResyncFrame(frame: RemoteStreamFrame): frame is RemoteResyncFrame {
  return (frame as RemoteResyncFrame).resync === true;
}

/**
 * The operations a remote client may ask for, and the permission each needs.
 *
 * Host-destructive work (session deletion, compaction, commits, pushes, goal
 * completion) is deliberately absent: those stay on the desktop, where the
 * native confirmation dialog lives. Read-only inspection and the in-flight
 * conversation controls a phone actually needs are here.
 */
export type RemoteOperationName =
  | "state"
  | "history-sessions"
  | "transcript"
  | "queued"
  | "goal"
  | "subagents"
  | "git-status"
  | "diff"
  | "artifact"
  | "send-message"
  | "steer"
  | "queue-follow-up"
  | "flush-follow-ups"
  | "cancel-run"
  | "resolve-tool-call"
  | "mark-read";

export const REMOTE_OPERATION_ACCESS: Record<RemoteOperationName, RemotePermission> = {
  state: "view",
  "history-sessions": "view",
  transcript: "view",
  queued: "view",
  goal: "view",
  subagents: "view",
  "git-status": "view",
  diff: "view",
  artifact: "view",
  "send-message": "control",
  steer: "control",
  "queue-follow-up": "control",
  "flush-follow-ups": "control",
  "cancel-run": "control",
  "resolve-tool-call": "control",
  "mark-read": "control",
};

export function remoteOperationRequiresControl(operation: RemoteOperationName): boolean {
  return REMOTE_OPERATION_ACCESS[operation] === "control";
}

export function permissionAllows(
  permission: RemotePermission,
  operation: RemoteOperationName,
): boolean {
  return permission === "control" || !remoteOperationRequiresControl(operation);
}

/** Endpoint builders shared by the host router and the remote client. */
export const REMOTE_API = {
  pair: "/api/pair",
  state: "/api/state",
  historySessions: "/api/history-sessions",
  events: "/api/events",
  operations: "/api/operations",
  operation: (operationId: string) =>
    `/api/operations/${encodeURIComponent(operationId)}`,
  sessions: "/api/sessions",
  session: (sessionId: string) => `/api/sessions/${encodeURIComponent(sessionId)}`,
  transcript: (sessionId: string) => `${REMOTE_API.session(sessionId)}/transcript`,
  queued: (sessionId: string) => `${REMOTE_API.session(sessionId)}/queued`,
  goal: (sessionId: string) => `${REMOTE_API.session(sessionId)}/goal`,
  subagents: (sessionId: string) => `${REMOTE_API.session(sessionId)}/subagents`,
  gitStatus: (sessionId: string) => `${REMOTE_API.session(sessionId)}/git-status`,
  diff: (sessionId: string) => `${REMOTE_API.session(sessionId)}/diff`,
  artifact: (sessionId: string, artifactId: string) =>
    `${REMOTE_API.session(sessionId)}/artifacts/${encodeURIComponent(artifactId)}`,
  messages: (sessionId: string) => `${REMOTE_API.session(sessionId)}/messages`,
  steer: (sessionId: string) => `${REMOTE_API.session(sessionId)}/steer`,
  followUps: (sessionId: string) => `${REMOTE_API.session(sessionId)}/follow-ups`,
  flushFollowUps: (sessionId: string) => `${REMOTE_API.session(sessionId)}/follow-ups/flush`,
  cancel: (sessionId: string) => `${REMOTE_API.session(sessionId)}/cancel`,
  read: (sessionId: string) => `${REMOTE_API.session(sessionId)}/read`,
  toolCallDecision: (toolId: string) =>
    `/api/tool-calls/${encodeURIComponent(toolId)}/decision`,
} as const;

const OPERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;

/**
 * A control request carries a client-generated ID so a retry after a dropped
 * connection replays the stored outcome instead of running the instruction
 * twice.
 */
export function isRemoteOperationId(value: unknown): value is string {
  return typeof value === "string" && OPERATION_ID_PATTERN.test(value);
}

export function createRemoteOperationId(random?: () => string): string {
  const uuid = random ? random() : defaultUuid();
  return `op-${uuid.replace(/[^A-Za-z0-9._:-]/gu, "")}`;
}

function defaultUuid(): string {
  const source = globalThis.crypto;
  if (source && typeof source.randomUUID === "function") return source.randomUUID();
  const bytes = new Uint8Array(16);
  if (source && typeof source.getRandomValues === "function") source.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

/**
 * What the remote client reports about itself to the UI. `revoked` is terminal:
 * the host no longer knows this device and no request will be accepted.
 */
export interface RemoteClientStatus {
  state: "pairing" | "connecting" | "connected" | "revoked" | "offline";
  permission?: RemotePermission;
  deviceName?: string;
  detail?: string;
}

export function remoteClientStatusLabel(status: RemoteClientStatus): string {
  switch (status.state) {
    case "pairing":
      return "기기 연결이 필요합니다";
    case "connecting":
      return "연결 중";
    case "connected":
      return status.permission === "control" ? "원격 조작 가능" : "원격 보기 전용";
    case "revoked":
      return "접근이 해제되었습니다";
    default:
      return "원격 연결 끊김";
  }
}

/** Status surface the shell uses to gate control affordances. */
export interface RemoteAccessBridge {
  getStatus(): Promise<RemoteClientStatus>;
  subscribe(listener: (status: RemoteClientStatus) => void): () => void;
  /** Consumes a pairing code and stores this device's token. */
  pair(code: string): Promise<void>;
  /** Drops the local token without touching the host's record. */
  forget(): void;
  /** Refetches the authoritative snapshot and reopens the event stream. */
  refresh(): Promise<void>;
}

export interface RemoteDesktopBridge {
  getState(): Promise<RemoteAccessState>;
  setEnabled(enabled: boolean): Promise<RemoteAccessState>;
  setPort(port: number): Promise<RemoteAccessState>;
  issuePairingCode(permission: RemotePermission): Promise<RemoteAccessState>;
  clearPairingCode(): Promise<RemoteAccessState>;
  setDevicePermission(
    deviceId: string,
    permission: RemotePermission,
  ): Promise<RemoteAccessState>;
  revokeDevice(deviceId: string): Promise<RemoteAccessState>;
  forgetDevice(deviceId: string): Promise<RemoteAccessState>;
  refresh(): Promise<RemoteAccessState>;
}
