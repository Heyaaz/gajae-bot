import type { AgentEvent } from "../../shared/agent-contract.js";
import {
  REMOTE_API,
  createRemoteOperationId,
  isRemotePermission,
  type RemoteClientStatus,
  type RemoteDeviceIdentity,
  type RemoteEventFrame,
  type RemoteOperationOutcome,
  type RemotePairingBody,
  type RemotePermission,
  type RemoteSnapshot,
  type RemoteStreamFrame,
} from "../../shared/remote-protocol.js";
import { t } from "../i18n";


/**
 * The phone-side connection to the host.
 *
 * Three behaviors matter more than the request plumbing:
 *
 * - The device token lives in storage, never in a URL or a log line. A pairing
 *   code arrives in the URL fragment, is consumed immediately, and is removed
 *   from the address bar before any request is made.
 * - Reconnection resumes the event stream from the last sequence number the
 *   client actually saw, and a gap the host cannot replay turns into a snapshot
 *   refresh instead of a guess.
 * - A control request that fails without an answer is *never* resent. The client
 *   asks the host for the recorded outcome and reports an unknown state if there
 *   is none, because "maybe it ran" is a fact the user must see.
 */

export const TOKEN_STORAGE_KEY = "gajae.remote.token";

export interface TokenStorage {
  read(): string | null;
  write(token: string): void;
  clear(): void;
}

export function browserTokenStorage(): TokenStorage {
  return {
    read: () => {
      try {
        return window.localStorage.getItem(TOKEN_STORAGE_KEY);
      } catch {
        return null;
      }
    },
    write: (token: string) => {
      try {
        window.localStorage.setItem(TOKEN_STORAGE_KEY, token);
      } catch {
        // A browser that refuses storage still works for this session; the user
        // pairs again next launch.
      }
    },
    clear: () => {
      try {
        window.localStorage.removeItem(TOKEN_STORAGE_KEY);
      } catch {
        // Ignore.
      }
    },
  };
}

export interface RemoteRequestErrorDetails {
  /** The host answered with a status; the request is known to have been received. */
  status?: number;
  code?: string;
  /** The request never got an answer, so the outcome is unknown. */
  uncertain?: boolean;
  operationId?: string;
}

export class RemoteRequestError extends Error {
  readonly status?: number;
  readonly code?: string;
  readonly uncertain: boolean;
  readonly operationId?: string;

  constructor(message: string, details: RemoteRequestErrorDetails = {}) {
    super(message);
    this.name = "RemoteRequestError";
    if (details.status !== undefined) this.status = details.status;
    if (details.code !== undefined) this.code = details.code;
    this.uncertain = details.uncertain === true;
    if (details.operationId !== undefined) this.operationId = details.operationId;
  }
}

/** `#pair=ABCD1234` survives a scan without ever reaching a server log. */
export function readPairingCodeFromHash(hash: string): string | null {
  const value = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!value) return null;
  const params = new URLSearchParams(value);
  const code = params.get("pair");
  if (!code) return null;
  const normalized = code.replace(/[\s-]/gu, "").toUpperCase();
  return /^[2-9A-HJKMNP-Z]{8}$/u.test(normalized) ? normalized : null;
}

export interface ReconnectOptions {
  minDelayMs?: number;
  maxDelayMs?: number;
  jitter?: () => number;
}

/** Bounded exponential backoff: a phone waking up should not hammer the host. */
export function nextReconnectDelay(attempt: number, options: ReconnectOptions = {}): number {
  const min = options.minDelayMs ?? 1000;
  const max = options.maxDelayMs ?? 15_000;
  const base = Math.min(max, min * 2 ** Math.max(0, attempt - 1));
  const jitter = options.jitter ?? Math.random;
  return Math.round(base * (0.75 + jitter() * 0.5));
}

export interface SseFrame {
  event: string;
  data: unknown;
  id?: string;
}

/** Incremental `text/event-stream` parser; feed it chunks, read whole frames. */
export class SseParser {
  private buffer = "";

  push(chunk: string): SseFrame[] {
    this.buffer += chunk;
    const frames: SseFrame[] = [];
    for (;;) {
      const separator = this.buffer.indexOf("\n\n");
      if (separator === -1) break;
      const block = this.buffer.slice(0, separator);
      this.buffer = this.buffer.slice(separator + 2);
      const frame = parseBlock(block);
      if (frame) frames.push(frame);
    }
    return frames;
  }
}

function parseBlock(block: string): SseFrame | undefined {
  if (!block || block.startsWith(":")) return undefined;
  let event = "message";
  let data = "";
  let id: string | undefined;
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice("event:".length).trim();
    else if (line.startsWith("data:")) data += line.slice("data:".length).trim();
    else if (line.startsWith("id:")) id = line.slice("id:".length).trim();
  }
  if (!data) return undefined;
  try {
    return { event, data: JSON.parse(data) as unknown, ...(id ? { id } : {}) };
  } catch {
    return undefined;
  }
}

export interface RemoteClientOptions {
  baseUrl?: string;
  storage?: TokenStorage;
  fetchImpl?: typeof fetch;
  deviceName?: () => string;
  onResync?: () => void;
  onEvent?: (event: AgentEvent) => void;
  now?: () => number;
  /** Backoff bounds for the event stream; tests shrink these. */
  reconnect?: ReconnectOptions;
  /** Deadline for an ordinary request, including its response body. */
  requestTimeoutMs?: number;
}

/**
 * No answer is not an answer.
 *
 * A request deadline is a client-side fact, not the host's: a POST that blew it
 * may still have run. It is reported as uncertain so the control path asks for the
 * recorded outcome instead of sending the instruction a second time.
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

class RemoteRequestTimeout extends Error {}

const DEVICE_NAME_KEY = "gajae.remote.deviceName";

export class RemoteClient {
  private readonly baseUrl: string;
  private readonly storage: TokenStorage;
  private readonly fetchImpl: typeof fetch;
  private readonly listeners = new Set<(status: RemoteClientStatus) => void>();
  private readonly deviceName: () => string;
  private readonly requestTimeoutMs: number;
  private token: string | null;
  /**
   * How the host admitted this client. `tailscale` means Serve proved the request
   * came from the owner's own device, so there is no token to present.
   */
  private via?: RemoteDeviceIdentity["via"];
  private status: RemoteClientStatus;
  /** The last sequence actually observed; undefined until the host reports one. */
  private lastSeq: number | undefined = undefined;
  /** The host process that produced the cursor; a new instance resets the log. */
  private serverInstance: string | undefined = undefined;
  private attempt = 0;
  private stream?: AbortController;
  private streamGeneration = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private closed = false;
  /** Bumped whenever the credential changes, so older snapshots cannot apply. */
  private authGeneration = 0;
  /** Ordinary requests in flight; a credential change aborts all of them. */
  private readonly requestControllers = new Set<AbortController>();
  /** The pairing transport that is allowed to apply its result. */
  private pairingController?: AbortController;

  private readonly options: RemoteClientOptions;

  constructor(options: RemoteClientOptions = {}) {
    this.options = options;
    this.baseUrl = (options.baseUrl ?? defaultBaseUrl()).replace(/\/$/u, "");
    this.storage = options.storage ?? browserTokenStorage();
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.deviceName = options.deviceName ?? defaultDeviceName;
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.token = this.storage.read();
    this.status = this.token
      ? { state: "connecting", detail: t("호스트에 연결하는 중입니다.") }
      : { state: "pairing" };
  }

  get permission(): RemotePermission | undefined {
    return this.status.permission;
  }

  getStatus(): RemoteClientStatus {
    return this.status;
  }

  subscribe(listener: (status: RemoteClientStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private setStatus(status: RemoteClientStatus): void {
    this.status = status;
    for (const listener of this.listeners) listener(status);
  }

  private authorized(): Record<string, string> {
    return this.token ? { Authorization: `Bearer ${this.token}` } : {};
  }

  private url(path: string): string {
    return `${this.baseUrl}${path}`;
  }

  /** Consumes a pairing code and stores the device token. */
  async pair(rawCode: string): Promise<void> {
    const code = rawCode.replace(/[\s-]/gu, "").toUpperCase();
    // A pairing answer is only authority for the auth state it started in. Forget
    // and a newer pairing both replace that state, so this transport is aborted and
    // its late answer is refused rather than restoring a credential the user removed.
    const authGeneration = this.authGeneration;
    this.pairingController?.abort();
    // Pairing has no token to authorize with, but it is still an HTTP request: a
    // host that stalls before headers, or mid-body, must not leave the pairing
    // screen pending forever.
    const controller = new AbortController();
    this.pairingController = controller;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new RemoteRequestTimeout());
      }, this.requestTimeoutMs);
    });
    const withinDeadline = <U>(work: Promise<U>): Promise<U> =>
      Promise.race([work, deadline]);
    const timeoutError = (): RemoteRequestError =>
      new RemoteRequestError(t("호스트 응답 시간이 초과되었습니다."), {
        uncertain: true,
      });
    const superseded = (): boolean =>
      authGeneration !== this.authGeneration ||
      this.pairingController !== controller;
    const stalePairing = (): RemoteRequestError =>
      new RemoteRequestError(t("이전 페어링 요청은 적용하지 않았습니다."), {
        code: "stale-auth",
      });
    const readBody = async <U>(read: () => Promise<U>): Promise<U> => {
      try {
        return await withinDeadline(read());
      } catch (error) {
        if (superseded()) throw stalePairing();
        if (timedOut || error instanceof RemoteRequestTimeout)
          throw timeoutError();
        throw new RemoteRequestError(t("호스트의 응답을 읽을 수 없습니다."), {
          uncertain: true,
        });
      }
    };
    try {
      let response: Response;
      try {
        response = await withinDeadline(
          this.fetchImpl(this.url(REMOTE_API.pair), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ code, deviceName: this.deviceName() }),
            signal: controller.signal,
          }),
        );
      } catch (error) {
        if (superseded()) throw stalePairing();
        if (timedOut || error instanceof RemoteRequestTimeout)
          throw timeoutError();
        throw new RemoteRequestError(t("호스트에 연결할 수 없습니다."), {
          uncertain: true,
        });
      }
      if (response.status !== 200) {
        const body = await readBody(() => readErrorBody(response));
        throw new RemoteRequestError(body.message, {
          status: response.status,
          code: body.code,
        });
      }
      const body = await readBody(
        () => response.json() as Promise<RemotePairingBody>,
      );
      if (superseded()) throw stalePairing();
      if (
        typeof body.token !== "string" ||
        !isRemotePermission(body.device?.permission)
      ) {
        throw new RemoteRequestError(
          t("호스트가 올바른 기기 정보를 보내지 않았습니다."),
        );
      }
      // A new credential starts a new auth channel: drop the old stream, its
      // cursor, and any response whose request predates this pairing.
      this.closeRealtime();
      this.authGeneration += 1;
      this.abortRequests();
      this.lastSeq = undefined;
      this.serverInstance = undefined;
      this.attempt = 0;
      this.token = body.token;
      this.via = body.device.via ?? "device";
      this.storage.write(body.token);
      this.setStatus({
        state: "connected",
        permission: body.device.permission,
        deviceName: body.device.name,
      });
    } finally {
      if (timer) clearTimeout(timer);
      if (this.pairingController === controller)
        this.pairingController = undefined;
    }
  }

  /** Forgets this device's token locally. The host keeps its record until revoked there. */
  forget(): void {
    this.pairingController?.abort();
    this.pairingController = undefined;
    this.token = null;
    this.via = undefined;
    this.storage.clear();
    // The credential is also this client's identity on the live channel and its
    // cursor into the host's log. Keeping either would let an old stream block the
    // next pairing's stream, and let a late snapshot repopulate state that belongs
    // to the credential just removed.
    this.authGeneration += 1;
    this.abortRequests();
    this.closeRealtime();
    this.lastSeq = undefined;
    this.serverInstance = undefined;
    this.attempt = 0;
    this.setStatus({ state: "pairing" });
  }

  private abortRequests(): void {
    for (const controller of [...this.requestControllers]) controller.abort();
    this.requestControllers.clear();
  }

  async snapshot(): Promise<RemoteSnapshot> {
    const generation = this.authGeneration;
    const body = await this.request<RemoteSnapshot>(REMOTE_API.state);
    if (generation !== this.authGeneration) {
      // The credential changed while this read was in flight. Applying its device,
      // sessions, or connection would show the previous account as current.
      throw new RemoteRequestError(
        t("인증 정보가 변경되어 이전 상태를 적용하지 않았습니다."),
        { code: "stale-auth" },
      );
    }
    this.via = body.device?.via;
    if (isRemotePermission(body.device?.permission))
      this.setStatus({
        state: "connected",
        permission: body.device.permission,
        deviceName: body.device.name,
      });
    return body;
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    // Which token this request answers with: a refusal that arrives after a later
    // pairing is about a token this client no longer holds. The auth generation
    // also keeps a late abort/error from moving the status of the new credential.
    const presented = this.token;
    const authGeneration = this.authGeneration;
    // One controller and one timer cover the headers and the body. A fetch that
    // waits forever and a body that stops mid-JSON both have to reject, or a
    // control call never reaches its unknown-outcome lookup and a snapshot stalls
    // reconnection.
    const controller = new AbortController();
    this.requestControllers.add(controller);
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new RemoteRequestTimeout());
      }, this.requestTimeoutMs);
    });
    const withinDeadline = <U>(work: Promise<U>): Promise<U> =>
      Promise.race([work, deadline]);
    const external = init.signal;
    const abortFromExternal = () => controller.abort();
    if (external) {
      if (external.aborted) controller.abort();
      else
        external.addEventListener("abort", abortFromExternal, { once: true });
    }
    const timeoutError = (): RemoteRequestError => {
      if (
        authGeneration === this.authGeneration &&
        this.status.state === "connected"
      )
        this.setStatus({
          ...this.status,
          state: "offline",
          detail: t("호스트가 제한 시간 안에 응답하지 않았습니다."),
        });
      return new RemoteRequestError(t("호스트 응답 시간이 초과되었습니다."), {
        uncertain: true,
      });
    };
    const readBody = async <U>(read: () => Promise<U>): Promise<U> => {
      try {
        return await withinDeadline(read());
      } catch (error) {
        if (timedOut || error instanceof RemoteRequestTimeout)
          throw timeoutError();
        throw new RemoteRequestError(t("호스트의 응답을 읽을 수 없습니다."), {
          uncertain: true,
        });
      }
    };
    try {
      let response: Response;
      try {
        response = await withinDeadline(
          this.fetchImpl(this.url(path), {
            ...init,
            signal: controller.signal,
            headers: { ...(init.headers ?? {}), ...this.authorized() },
          }),
        );
      } catch (error) {
        if (timedOut || error instanceof RemoteRequestTimeout)
          throw timeoutError();
        if (
          authGeneration === this.authGeneration &&
          this.status.state === "connected"
        )
          this.setStatus({ ...this.status, state: "offline", detail: t("호스트에 연결할 수 없습니다.") });
        throw new RemoteRequestError(t("호스트에 연결할 수 없습니다."), { uncertain: true });
      }
      if (response.status === 401) {
        if (this.token !== presented) {
          // A pairing landed while this request was in flight. Dropping the token now
          // would undo it and send the user back to the screen they just cleared.
          throw new RemoteRequestError(t("이 기기는 아직 호스트에 연결되어 있지 않습니다."), {
            status: 401,
            code: "unauthorized",
          });
        }
        // A token the host no longer recognizes is terminal until the owner pairs
        // again, so it is dropped rather than retried. With no token to drop the
        // device was never paired: that is where pairing starts, not a revocation.
        const held = presented !== null;
        this.forget();
        if (held) {
          this.setStatus({
            state: "revoked",
            detail: t("이 기기의 접근이 해제되었습니다. 데스크톱에서 다시 연결해 주세요."),
          });
          throw new RemoteRequestError(t("이 기기의 접근이 해제되었습니다."), { status: 401, code: "revoked" });
        }
        this.setStatus({
          state: "pairing",
          detail: t("데스크톱에서 페어링 코드를 발급해 연결해 주세요."),
        });
        throw new RemoteRequestError(t("이 기기는 아직 호스트에 연결되어 있지 않습니다."), {
          status: 401,
          code: "unauthorized",
        });
      }
      if (!response.ok) {
        const body = await readBody(() => readErrorBody(response));
        throw new RemoteRequestError(body.message, { status: response.status, code: body.code });
      }
      if (response.status === 204) return undefined as T;
        return await readBody(() => response.json() as Promise<T>);
    } finally {
      if (timer) clearTimeout(timer);
      this.requestControllers.delete(controller);
      external?.removeEventListener("abort", abortFromExternal);
    }
  }

  private async readResult<T>(path: string): Promise<T> {
    const body = await this.request<{ result: T }>(path);
    return body.result;
  }

  private unwrapOutcome(outcome: RemoteOperationOutcome): unknown {
    if (outcome.state === "failed")
      throw new RemoteRequestError(outcome.message ?? t("요청이 실패했습니다."), {
        code: "failed",
        operationId: outcome.operationId,
      });
    return outcome.result ?? null;
  }

  /**
   * Runs one control operation. The operation ID makes the host's answer
   * replayable, so a lost connection is resolved by looking the outcome up
   * rather than by sending the instruction twice.
   */
  async control<T>(path: string, payload: Record<string, unknown> = {}): Promise<T> {
    const operationId = createRemoteOperationId();
    try {
      const outcome = await this.request<RemoteOperationOutcome>(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, operationId }),
      });
      return this.unwrapOutcome(outcome) as T;
    } catch (error) {
      if (!(error instanceof RemoteRequestError) || !error.uncertain) throw error;
      const outcome = await this.lookupOperation(operationId);
      if (outcome) return this.unwrapOutcome(outcome) as T;
      throw new RemoteRequestError(
        t("전송 결과를 확인할 수 없습니다. 중복 실행을 막기 위해 다시 보내지 않았습니다. 데스크톱에서 상태를 확인해 주세요."),
        { uncertain: true, operationId, code: "unknown-outcome" },
      );
    }
  }

  async lookupOperation(operationId: string): Promise<RemoteOperationOutcome | undefined> {
    try {
      return await this.request<RemoteOperationOutcome>(REMOTE_API.operation(operationId));
    } catch (error) {
      if (error instanceof RemoteRequestError && error.status === 404) return undefined;
      return undefined;
    }
  }

  listSessions() {
    return this.snapshot().then((value) => value.sessions);
  }

  async connection() {
    const snapshot = await this.snapshot();
    return snapshot.connection;
  }

  transcript(sessionId: string) {
    return this.readResult<unknown[]>(REMOTE_API.transcript(sessionId));
  }

  context(sessionId: string) {
    return this.readResult<unknown>(REMOTE_API.context(sessionId));
  }

  queued(sessionId: string) {
    return this.readResult<unknown[]>(REMOTE_API.queued(sessionId));
  }

  goal(sessionId: string) {
    return this.readResult<unknown>(REMOTE_API.goal(sessionId));
  }

  subagents(sessionId: string) {
    return this.readResult<unknown[]>(REMOTE_API.subagents(sessionId));
  }

  gitStatus(sessionId: string) {
    return this.readResult<unknown>(REMOTE_API.gitStatus(sessionId));
  }

  diff(sessionId: string) {
    return this.readResult<unknown>(REMOTE_API.diff(sessionId));
  }

  artifact(sessionId: string, artifactId: string) {
    return this.readResult<unknown>(REMOTE_API.artifact(sessionId, artifactId));
  }

  historySessions() {
    return this.readResult<unknown[]>(REMOTE_API.historySessions);
  }

  sendMessage(sessionId: string, input: unknown) {
    return this.control<"prompt" | "steer">(REMOTE_API.messages(sessionId), { input });
  }

  steer(sessionId: string, input: unknown) {
    return this.control<void>(REMOTE_API.steer(sessionId), { input });
  }

  queueFollowUp(sessionId: string, input: unknown) {
    return this.control<void>(REMOTE_API.followUps(sessionId), { input });
  }

  flushFollowUps(sessionId: string) {
    return this.control<boolean>(REMOTE_API.flushFollowUps(sessionId));
  }

  cancelRun(sessionId: string) {
    return this.control<void>(REMOTE_API.cancel(sessionId));
  }

  markRead(sessionId: string) {
    return this.control<void>(REMOTE_API.read(sessionId));
  }

  resolveToolCall(toolId: string, optionId: string) {
    return this.control<void>(REMOTE_API.toolCallDecision(toolId), { decision: { optionId } });
  }

  /** Can this client reach the host at all: a device token, or an identity grant. */
  private hasAccess(): boolean {
    return this.token !== null || this.via === "tailscale";
  }

  /** Opens the event stream and keeps it open until `closeRealtime`. */
  startRealtime(): void {
    if (!this.hasAccess() || this.closed || this.stream) return;
    void this.openStream();
  }

  private async openStream(): Promise<void> {
    if (this.closed || !this.hasAccess() || this.stream) return;
    const controller = new AbortController();
    const generation = ++this.streamGeneration;
    this.stream = controller;
    const presented = this.token;
    const since = this.lastSeq;
    try {
      const response = await this.fetchImpl(
        this.url(`${REMOTE_API.events}${since === undefined ? "" : `?since=${since}`}`),
        { headers: { ...this.authorized(), Accept: "text/event-stream" }, signal: controller.signal },
      );
      if (response.status === 401) {
        if (generation === this.streamGeneration && this.token === presented) {
          this.forget();
          this.setStatus({
            state: "revoked",
            detail: t("이 기기의 접근이 해제되었습니다. 데스크톱에서 다시 연결해 주세요."),
          });
        }
        return;
      }
      if (generation !== this.streamGeneration || controller.signal.aborted) return;
      if (!response.ok || !response.body) throw new Error(`stream refused: ${response.status}`);
      this.attempt = 0;
      if (this.status.state !== "connected" || this.status.permission === undefined) {
        const snapshot = await this.snapshot().catch(() => undefined);
        if (!snapshot) throw new Error("snapshot unavailable");
      }
      if (generation !== this.streamGeneration || controller.signal.aborted) return;
      const parser = new SseParser();
      const reader = response.body.getReader();
      // Aborting the fetch signal alone does not wake a read that is waiting on a
      // silent stream. Cancelling the reader ends that wait as well, so a forget or
      // re-pair cannot leave the old body open behind the new credential.
      const cancelReader = () => {
        void reader.cancel().catch(() => undefined);
      };
      controller.signal.addEventListener("abort", cancelReader, { once: true });
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (generation !== this.streamGeneration || controller.signal.aborted) return;
          if (done) break;
          for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
            // A listener can replace the pairing/stream while dispatching a frame.
            // Remaining frames from this chunk no longer own revocation authority.
            if (generation !== this.streamGeneration || this.token !== presented) return;
            this.handleFrame(frame);
          }
        }
      } finally {
        controller.signal.removeEventListener("abort", cancelReader);
      }
      throw new Error("stream ended");
    } catch {
      // A closed stream is normal on sleep, network switch, and host restart.
    } finally {
      if (generation === this.streamGeneration && this.stream === controller) {
        this.stream = undefined;
        this.scheduleReconnect(generation);
      }
    }
  }

  private handleFrame(frame: SseFrame): void {
    if (frame.event === "hello") {
      const hello = frame.data as {
        seq?: number;
        instance?: string;
        device?: { permission?: unknown; name?: string };
      };
      const sequence = typeof hello.seq === "number" ? hello.seq : undefined;
      const restarted =
        (typeof hello.instance === "string" &&
          this.serverInstance !== undefined &&
          hello.instance !== this.serverInstance) ||
        (sequence !== undefined &&
          this.lastSeq !== undefined &&
          sequence < this.lastSeq);
      if (typeof hello.instance === "string") this.serverInstance = hello.instance;
      if (restarted) {
        // A new host instance restarts its sequence at zero. Keeping the old, larger
        // cursor would ask for events the new log cannot have and skip its first
        // window; adopt its sequence and repair state with a snapshot instead.
        if (sequence !== undefined) this.lastSeq = sequence;
        this.requestResync();
      } else if (
        sequence !== undefined &&
        (this.lastSeq === undefined || sequence > this.lastSeq)
      ) {
        // The host is ahead of us: this is a fresh stream, and the snapshot call
        // in openStream already covered anything before it.
        this.lastSeq = sequence;
      }
      if (isRemotePermission(hello.device?.permission))
        this.setStatus({
          state: "connected",
          permission: hello.device.permission,
          deviceName: hello.device.name,
        });
      return;
    }
    if (frame.event === "revoked") {
      this.forget();
      this.setStatus({
        state: "revoked",
        detail: t("이 기기의 접근이 해제되었습니다. 데스크톱에서 다시 연결해 주세요."),
      });
      this.closeRealtime();
      return;
    }
    if (frame.event === "resync") {
      const notice = frame.data as RemoteStreamFrame;
      if (typeof notice.seq === "number") this.lastSeq = notice.seq;
      this.requestResync();
      return;
    }
    if (frame.event === "agent") {
      const payload = frame.data as RemoteEventFrame;
      if (typeof payload?.seq === "number")
        this.lastSeq =
          this.lastSeq === undefined
            ? payload.seq
            : Math.max(this.lastSeq, payload.seq);
      if (payload?.event) this.options.onEvent?.(payload.event);
    }
  }

  private requestResync(): void {
    this.options.onResync?.();
  }

  private scheduleReconnect(generation: number): void {
    if (this.closed || !this.hasAccess() || this.reconnectTimer) return;
    if (this.status.state === "revoked") return;
    this.attempt += 1;
    const delay = nextReconnectDelay(this.attempt, this.options.reconnect);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (generation === this.streamGeneration && !this.stream && !this.closed && this.hasAccess())
        void this.openStream();
    }, delay);
    if (typeof this.reconnectTimer.unref === "function") this.reconnectTimer.unref();
  }

  closeRealtime(): void {
    this.streamGeneration += 1;
    this.stream?.abort();
    this.stream = undefined;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  dispose(): void {
    this.closed = true;
    this.pairingController?.abort();
    this.pairingController = undefined;
    this.closeRealtime();
    this.listeners.clear();
  }

  /** Reconnects immediately: used when the app returns to the foreground. */
  async resume(): Promise<void> {
    if (!this.hasAccess() || this.closed) return;
    this.closeRealtime();
    await this.snapshot().catch(() => undefined);
    this.startRealtime();
  }
}

async function readErrorBody(response: Response): Promise<{ code?: string; message: string }> {
  try {
    const body = (await response.json()) as { error?: { code?: string; message?: string } };
    return {
      ...(body.error?.code ? { code: body.error.code } : {}),
      message: body.error?.message ?? t`요청이 실패했습니다 (${response.status})`,
    };
  } catch {
    return { message: t`요청이 실패했습니다 (${response.status})` };
  }
}

function defaultBaseUrl(): string {
  if (typeof window !== "undefined" && window.location?.origin) return window.location.origin;
  return "http://127.0.0.1";
}

function defaultDeviceName(): string {
  const fallback = t("원격 기기");
  if (typeof navigator === "undefined") return fallback;
  const stored = (() => {
    try {
      return window.localStorage.getItem(DEVICE_NAME_KEY);
    } catch {
      return null;
    }
  })();
  if (stored) return stored;
  const guess = [navigator.userAgent.match(/iPhone|iPad|Android|Macintosh|Windows/u)?.[0]]
    .filter((value): value is string => Boolean(value))
    .join(" ");
  const name = guess ? `${guess} (${fallback})` : fallback;
  try {
    window.localStorage.setItem(DEVICE_NAME_KEY, name);
  } catch {
    // Non-fatal.
  }
  return name;
}

