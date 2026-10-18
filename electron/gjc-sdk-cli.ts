import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";

/**
 * The `gjc sdk session` CLI client.
 *
 * Gajae is an external controller: it never hosts a session runtime and never
 * keeps a resident agent process. Control/query operations are short-lived
 * `gjc sdk session ...` invocations. A supplemental read-only `sdk serve` relay
 * observes tool snapshots without taking ownership of the session runtime.
 * That keeps the desktop process-isolated from the agent -- a crashed or
 * upgraded runtime cannot take the window down with it.
 */

/** Lifecycle globals the broker requires an idempotency key for. */
const LIFECYCLE_GLOBALS = new Set([
  "session.create",
  "session.fork",
  "session.resume",
  "session.close",
  "session.delete",
]);

/**
 * Runs a GJC CLI command and resolves as soon as its response is complete,
 * without waiting for the process to exit.
 *
 * The CLI writes one JSON object and is done, but older builds then lingered
 * before exiting (0.15.3: response at 728ms, exit at 5735ms), so waiting for exit
 * charged every steer, follow-up, and abort an extra 5 seconds during which the
 * window looked frozen. gjc/0.18.11 no longer lingers (response 425ms, exit
 * 434ms), and resolving on the response keeps the window off that path either way.
 *
 * The child is left to exit on its own once its response has been read.
 */
export async function brokerExec(
  executable: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    signal?: AbortSignal;
    terminateAfterResponse?: boolean;
  },
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new SdkCliError("aborted", "GJC CLI operation was detached."));
      return;
    }
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error?: Error, value?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      child.stdout.removeAllListeners();
      child.stderr.removeAllListeners();
      // The response is in hand, so the process is free to take its time exiting.
      if (error) {
        child.kill("SIGTERM");
        reject(error);
        return;
      }
      if (options.terminateAfterResponse) child.kill("SIGTERM");
      resolve(value ?? "");
    };
    const abort = (): void => {
      // This terminates only the short-lived session CLI reader. It never signals
      // the broker-hosted agent process and is unrelated to the turn-abort contract.
      child.kill("SIGTERM");
      finish(new SdkCliError("aborted", "GJC CLI operation was detached."));
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => {
      const timeout = `GJC control timed out after ${options.timeoutMs}ms`;
      const isSessionSend = args[0] === "sdk" && args[1] === "session" && args[2] === "send";
      finish(
        isSessionSend
          ? new SdkCliError(
              "uncertain_after_send",
              `${timeout}; request outcome is unknown because the send may have been delivered.`,
            )
          : new Error(timeout),
      );
    }, options.timeoutMs);
    const settleIfComplete = (): void => {
      const text = stdout.trim();
      if (!text) return;
      try {
        JSON.parse(text);
      } catch {
        // Still mid-object; wait for the rest.
        return;
      }
      finish(undefined, stdout);
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      settleIfComplete();
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error) => finish(error));
    // A process that exits without a parsable response failed; report what it said.
    child.once("close", (code) => {
      if (settled) return;
      const text = stdout.trim();
      if (text) {
        // A rejected flag makes the CLI print usage to stdout and the actual
        // reason to stderr. Resolving with the usage text turned that into the
        // generic "response was not valid JSON", hiding "Unknown option --scope"
        // -- which is the whole diagnosis when the app resolved an old gjc.
        try {
          JSON.parse(text);
          finish(undefined, stdout);
        } catch {
          const reason = stderr.trim();
          if (reason) {
            finish(new Error(reason));
            return;
          }
          finish(undefined, stdout);
        }
        return;
      }
      finish(
        new Error(
          stderr.trim() || `GJC control exited with code ${code ?? "unknown"}`,
        ),
      );
    });
  });
}

/** A typed failure carrying the CLI's own error code so callers can branch on it. */
export class SdkCliError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
    readonly diagnostics: readonly { code: string }[] = [],
    readonly outcomeCertainty?: string,
  ) {
    super(message);
    this.name = "SdkCliError";
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Reads the CLI's response envelope.
 *
 * Two shapes exist and both are load-bearing. `raw global` and the semantic verbs
 * answer `{ok, result}` / `{ok:false, error:{code,message}}`. `raw control` and
 * `raw query` answer the host frame directly: `{type:"control_response", ok,
 * result}` or `{type:"query_response", ok, page}`. Verified against gjc/0.18.11.
 */
export function parseEnvelope(stdout: string, label: string): Record<string, unknown> {
  const text = stdout.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SdkCliError(
      "invalid_response",
      `GJC ${label} response was not valid JSON`,
    );
  }
  const record = asRecord(parsed);
  if (!record)
    throw new SdkCliError(
      "invalid_response",
      `GJC ${label} response was not an object`,
    );
  if (record.ok === false) {
    const error = asRecord(record.error);
    const code =
      typeof error?.code === "string" ? error.code : "operation_failed";
    const message =
      typeof error?.message === "string"
        ? error.message
        : `GJC ${label} failed`;
    const diagnostics = Array.isArray(record.diagnostics)
      ? record.diagnostics.flatMap((value) => {
          const diagnostic = asRecord(value);
          return typeof diagnostic?.code === "string" ? [{ code: diagnostic.code }] : [];
        })
      : [];
    throw new SdkCliError(code, message, asRecord(error?.details), diagnostics,
      typeof error?.outcomeCertainty === "string" ? error.outcomeCertainty : undefined);
  }
  return record;
}

/** The `result` body of a settled envelope, when it carries one. */
export function envelopeResult(
  envelope: Record<string, unknown>,
): Record<string, unknown> | undefined {
  return asRecord(envelope.result);
}

/**
 * One page of a query response.
 *
 * `raw query` answers `{page:{items,complete,continuationCursor}}`; a few
 * operations answer a bare `{result:{items}}` instead, which is a single
 * complete page.
 */
export interface QueryPage {
  items: unknown[];
  complete: boolean;
  cursor?: string;
}

export function envelopePage(envelope: Record<string, unknown>): QueryPage {
  const page = asRecord(envelope.page) ?? asRecord(envelopeResult(envelope)?.page);
  if (!page) {
    const result = envelopeResult(envelope);
    const items = Array.isArray(result?.items) ? result.items : [];
    return { items, complete: true };
  }
  const cursor =
    typeof page.continuationCursor === "string" && page.continuationCursor
      ? page.continuationCursor
      : undefined;
  return {
    items: Array.isArray(page.items) ? page.items : [],
    complete: page.complete === true || cursor === undefined,
    ...(cursor ? { cursor } : {}),
  };
}

export interface SdkCliOptions {
  /** Absolute path to the resolved `gjc` executable. */
  executable: string;
  /**
   * Workspace the CLI runs in, and the `--repo` value for the one verb that takes
   * it. gjc/0.18.11 resolves every exact-session command from the session ID and
   * warns that `--repo` is ignored on them, so only `session list` states it.
   */
  repo: string;
  env: NodeJS.ProcessEnv;
  /** Wall-clock budget for the whole invocation. */
  timeoutMs?: number;
  /** Value handed to the CLI's own `--timeout-ms` request budget. */
  requestTimeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 8_000;

/** Session row projected by `gjc sdk session list`. */
export interface SdkSessionRow {
  sessionId: string;
  /**
   * The session's workspace directory.
   *
   * gjc/0.18.11 locators carry `{cwd, worktreeRoot, stateRoot}` and no `repo`; the
   * 0.15.x `repo` key is still read first so a row from either grammar projects to
   * the same workspace, and `cwd` is what every live row now supplies.
   */
  repo?: string;
  worktreeRoot?: string;
  stateRoot?: string;
  endpointGeneration?: number;
  pid?: number;
  live: boolean;
  deleted: boolean;
  indexSeq?: number;
  /** When the session's endpoint file appeared; a create's retained session is newer. */
  endpointMtimeMs?: number;
  /** The host's last activity report, the fallback freshness signal. */
  activityAt?: number;
  activityState?: "active" | "idle";
  terminalUncertain?: boolean;
  ambiguous?: boolean;
}

function rowFromIndex(value: unknown): SdkSessionRow | undefined {
  const record = asRecord(value);
  if (!record || typeof record.sessionId !== "string") return undefined;
  const locator = asRecord(record.locator);
  const activity = asRecord(record.activity);
  const repo =
    typeof locator?.repo === "string"
      ? locator.repo
      : typeof locator?.cwd === "string"
        ? locator.cwd
        : undefined;
  return {
    sessionId: record.sessionId,
    ...(repo ? { repo } : {}),
    ...(typeof locator?.worktreeRoot === "string"
      ? { worktreeRoot: locator.worktreeRoot }
      : {}),
    ...(typeof locator?.stateRoot === "string"
      ? { stateRoot: locator.stateRoot }
      : {}),
    ...(typeof record.endpointGeneration === "number"
      ? { endpointGeneration: record.endpointGeneration }
      : {}),
    ...(typeof record.pid === "number" ? { pid: record.pid } : {}),
    live: record.live === true,
    deleted: record.deleted === true,
    ...(typeof record.indexSeq === "number"
      ? { indexSeq: record.indexSeq }
      : {}),
    ...(typeof record.endpointMtimeMs === "number"
      ? { endpointMtimeMs: record.endpointMtimeMs }
      : {}),
    ...(typeof activity?.at === "number" ? { activityAt: activity.at } : {}),
    ...(activity?.state === "active" || activity?.state === "idle"
      ? { activityState: activity.state }
      : {}),
    ...(record.terminalUncertain === true ? { terminalUncertain: true } : {}),
    ...(record.ambiguous === true ? { ambiguous: true } : {}),
  };
}

/**
 * Whether a lifecycle receipt could not be verified rather than having failed.
 *
 * `terminal_uncertain` is the only code gjc/0.18.11 emits for this; the earlier
 * `lifecycle_uncertain`/`endpoint_uncertain` aliases are gone. A receipt that answers
 * without any code arrives as `operation_failed`, so the message is what separates an
 * unverified outcome from a refusal there.
 */
export function isLifecycleUncertain(error: unknown): boolean {
  if (error instanceof SdkCliError) {
    // `terminal_uncertain` is the coded form. `operation_failed` is what the envelope
    // parser falls back to when the answer carries no code at all, and GJC uses it for
    // a create whose receipt it could not confirm ("The operation failed. Its outcome
    // could not be established."). Treating that as a plain failure rejected sessions
    // the broker had already created, which is exactly what the index check below is for.
    if (error.code === "terminal_uncertain") return true;
    if (error.code !== "operation_failed") return false;
  }
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /terminal_uncertain|could not be verified|could not be established|requires reconciliation/iu.test(
    message,
  );
}

/**
 * Whether the session has no reachable SDK endpoint (TUI-held, stopped, or closed).
 *
 * `endpoint_stale` is gjc/0.18.11's code for a session whose endpoint is gone --
 * a closed session answers it for every control, query, and send.
 */
export function isSessionUnreachable(error: unknown): boolean {
  if (error instanceof SdkCliError)
    return (
      error.code === "endpoint_stale" ||
      error.code === "session_unavailable" ||
      error.code === "provider_lease_conflict" ||
      error.code === "endpoint_unavailable"
    );
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /endpoint_stale|stale or unavailable|provider_lease_conflict|no attachment|not attached|unavailable through the session Router|session_unavailable/iu.test(
    message,
  );
}

/** Whether the session is gone from the broker index entirely. */
export function isSessionMissing(error: unknown): boolean {
  if (error instanceof SdkCliError)
    return (
      error.code === "session_deleted" || error.code === "session_not_found"
    );
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /session_deleted|was deleted|not indexed by the broker/iu.test(message);
}

/**
 * The `gjc sdk session` command family.
 *
 * Every method is one process. The class holds no connection and no state, so it
 * is safe to call concurrently and there is nothing to reconnect after a runtime
 * restart.
 */
export class GjcSdkCli {
  /** Seam over the module-level runner so tests can drive it without a real CLI. */
  exec = brokerExec;

  constructor(private readonly options: SdkCliOptions) {}

  /** A credential-free, read-only observer of non-replayable tool snapshots. */
  async observeTools(
    sessionId: string,
    onEvent: (kind: string, payload: Record<string, unknown>) => void,
    signal: AbortSignal,
    repo = this.options.repo,
  ): Promise<void> {
    if (signal.aborted) return;
    await new Promise<void>((resolve, reject) => {
      const child = spawn(this.options.executable,
        ["sdk", "serve", "--stdio", "--session", sessionId],
        { cwd: repo, env: this.options.env, stdio: ["pipe", "pipe", "pipe"] });
      let buffer = "";
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(handshake);
        signal.removeEventListener("abort", abort);
        // Only the relay is ours; never signal the broker's session host.
        child.kill("SIGTERM");
        if (error) reject(error); else resolve();
      };
      const abort = (): void => finish();
      const handshake = setTimeout(() => finish(new Error("GJC tool observer handshake timed out")), 12_000);
      signal.addEventListener("abort", abort, { once: true });
      child.stdin.on("error", (error) => finish(error));
      child.stderr.resume();
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        if (settled) return;
        buffer += chunk;
        // GJC tool results can be large, but a broken relay must not grow forever.
        if (Buffer.byteLength(buffer) > 16 * 1024 * 1024) {
          finish(new Error("GJC tool observer frame exceeded 16 MiB"));
          return;
        }
        let boundary: number;
        while ((boundary = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, boundary).trim();
          buffer = buffer.slice(boundary + 1);
          if (!line) continue;
          try {
            const frame = asRecord(JSON.parse(line));
            if (frame?.type === "hello") {
              child.stdin.write(`${JSON.stringify({ type: "event_replay", id: "gajae-tool-observer", capabilities: ["turn_stream", "session_host_observer_v1"] })}\n`);
            } else if (frame?.type === "event_replay_result" && frame.id === "gajae-tool-observer") {
              if (frame.ok !== true) throw new Error("GJC refused tool observer capabilities");
              clearTimeout(handshake);
            } else if (frame?.type === "event" && typeof frame.kind === "string") {
              const payload = asRecord(frame.payload);
              if (payload && ["tool_execution_start", "tool_execution_update", "tool_execution_end"].includes(frame.kind))
                onEvent(frame.kind, payload);
            }
          } catch (error) {
            finish(error instanceof Error ? error : new Error(String(error)));
            return;
          }
        }
      });
      child.once("error", (error) => finish(error));
      child.once("close", () => finish());
      if (signal.aborted) finish();
    });
  }

  /** Seam over the resolved workspace so every `--repo` value is explicit. */
  private repoFor(repo?: string): string {
    return repo ?? this.options.repo;
  }

  private get timeoutMs(): number {
    return this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private get requestTimeoutMs(): number {
    return this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  private async run(
    args: string[],
    label: string,
    overrides?: {
      repo?: string;
      timeoutMs?: number;
      signal?: AbortSignal;
      terminateAfterResponse?: boolean;
    },
  ): Promise<Record<string, unknown>> {
    const repo = overrides?.repo ?? this.options.repo;
    const stdout = await this.exec(
      this.options.executable,
      [...args, "--json"],
      {
        cwd: repo,
        env: this.options.env,
        timeoutMs: overrides?.timeoutMs ?? this.timeoutMs,
        ...(overrides?.signal ? { signal: overrides.signal } : {}),
        ...(overrides?.terminateAfterResponse
          ? { terminateAfterResponse: true }
          : {}),
      },
    );
    return parseEnvelope(stdout, label);
  }

  /**
   * The installed runtime's version, from `gjc --version`.
   *
   * This is the app's compatibility probe, so it is a raw invocation rather than a
   * session command: it must work before any session or broker row exists.
   */
  async version(): Promise<string> {
    const stdout = await this.exec(this.options.executable, ["--version"], {
      cwd: this.options.repo,
      env: this.options.env,
      timeoutMs: 4_000,
    });
    const match = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/u.exec(stdout);
    if (!match)
      throw new SdkCliError(
        "invalid_response",
        "GJC did not report a version",
      );
    return match[1];
  }

  /**
   * `gjc sdk session list`.
   *
   * The scope is always stated. gjc/0.18.11 defaults it to `repo`, which fails
   * outright outside a git checkout ("the selected session-list scope requires a
   * Git repository"), so a desktop pointed at a plain directory would report GJC
   * unavailable rather than an empty list.
   *
   * Continuation cursors are drained to completion: the broker's cursor pool is
   * shared, so abandoning a cursor strands it for every other caller.
   */
  async listSessions(options?: {
    repo?: string;
    scope?: "repo" | "cwd" | "worktree" | "all";
  }): Promise<SdkSessionRow[]> {
    const rows: SdkSessionRow[] = [];
    const seen = new Set<string>();
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 4096; page += 1) {
      const envelope = await this.run(
        [
          "sdk",
          "session",
          "list",
          "--scope",
          options?.scope ?? "cwd",
          "--repo",
          this.repoFor(options?.repo),
          ...(cursor ? ["--cursor", cursor] : []),
        ],
        "session list",
        options?.repo ? { repo: options.repo } : undefined,
      );
      const result = envelopeResult(envelope);
      for (const entry of Array.isArray(result?.sessions) ? result.sessions : []) {
        const row = rowFromIndex(entry);
        if (!row || seen.has(row.sessionId)) continue;
        seen.add(row.sessionId);
        rows.push(row);
      }
      const next =
        typeof result?.continuationCursor === "string" &&
        result.continuationCursor
          ? result.continuationCursor
          : undefined;
      if (!next) break;
      if (seenCursors.has(next))
        throw new SdkCliError(
          "incomplete_scan",
          "GJC session list repeated a continuation cursor.",
        );
      seenCursors.add(next);
      cursor = next;
      if (page === 4095)
        throw new SdkCliError(
          "incomplete_scan",
          "GJC session list exceeded the continuation safety bound.",
        );
    }
    return rows;
  }

  /** `gjc sdk session inspect <id>`: one indexed row, or undefined when unindexed. */
  async inspectSession(
    sessionId: string,
    options?: { repo?: string },
  ): Promise<SdkSessionRow | undefined> {
    try {
      const envelope = await this.run(
        ["sdk", "session", "inspect", sessionId],
        "session inspect",
        options?.repo ? { repo: options.repo } : undefined,
      );
      const result = envelopeResult(envelope);
      return rowFromIndex(result?.session ?? result);
    } catch (error) {
      if (isSessionMissing(error)) return undefined;
      throw error;
    }
  }

  /**
   * `gjc sdk session send <id> --text ... --op-ref <fresh>`.
   *
   * An operation reference is never reused: a reused ref is rejected as
   * `client_ref_conflict` while its record is retained, and after eviction it may
   * be admitted a second time with the first outcome unknown. Returning here means
   * the prompt was *accepted*, not that the agent is idle -- reconcile with
   * `promptStatus` and the transcript.
   */
  async send(
    sessionId: string,
    text: string,
    options?: { repo?: string; opRef?: string; timeoutMs?: number },
  ): Promise<{ operationRef: string; status: string; turnId?: string }> {
    const opRef = options?.opRef ?? freshOperationRef();
    const envelope = await this.run(
      [
        "sdk",
        "session",
        "send",
        sessionId,
        "--text",
        text,
        "--op-ref",
        opRef,
        "--timeout-ms",
        String(this.requestTimeoutMs),
      ],
      "session send",
      {
        ...(options?.repo ? { repo: options.repo } : {}),
        ...(options?.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
      },
    );
    const result = envelopeResult(envelope);
    const receipt = asRecord(result?.receipt);
    return {
      operationRef:
        typeof result?.operationRef === "string" ? result.operationRef : opRef,
      status: typeof result?.status === "string" ? result.status : "accepted",
      ...(typeof receipt?.turnId === "string" ? { turnId: receipt.turnId } : {}),
    };
  }

  /**
   * `gjc sdk session status <id> <opRef>`: lossless prompt reconciliation.
   *
   * `unknown` means uncertainty, never proof that the prompt did not run.
   */
  async promptStatus(
    sessionId: string,
    operationRef: string,
    options?: { repo?: string },
  ): Promise<{
    status: string;
    completed: boolean;
    error?: { code?: string; message?: string };
  }> {
    const envelope = await this.run(
      ["sdk", "session", "status", sessionId, operationRef],
      "session status",
      options?.repo ? { repo: options.repo } : undefined,
    );
    const result = envelopeResult(envelope);
    const status = asRecord(result?.status);
    const summary = asRecord(result?.summary);
    const error = asRecord(status?.error);
    return {
      status: typeof status?.status === "string" ? status.status : "unknown",
      completed: summary?.completed === true,
      ...(error
        ? {
            error: {
              ...(typeof error.code === "string" ? { code: error.code } : {}),
              ...(typeof error.message === "string"
                ? { message: error.message }
                : {}),
            },
          }
        : {}),
    };
  }

  /**
   * `gjc sdk session tail <id> --all-events`.
   *
   * Not a stream. The CLI accumulates frames in-process and answers one envelope
   * when it reaches an exit condition. Verified against gjc/0.18.11: an elapsed wait
   * window answers `terminal:false` with the frames collected so far, and only a
   * retention gap or an unreachable endpoint fails. So tail is a bounded catch-up
   * read, not the live wire -- `--until-idle` bounds it to a turn that actually
   * ends, and the session file watch remains the durable live account.
   */
  async tail(
    sessionId: string,
    options?: {
      repo?: string;
      cursor?: string;
      untilIdle?: boolean;
      timeoutMs?: number;
      signal?: AbortSignal;
    },
  ): Promise<{
    source: string;
    terminal: boolean;
    items: Array<{ kind: string; payload: unknown; generation?: number; seq?: number }>;
    checkpointToken?: string;
    gap?: Record<string, unknown>;
  }> {
    const windowMs = options?.timeoutMs ?? 8_000;
    const envelope = await this.run(
      [
        "sdk",
        "session",
        "tail",
        sessionId,
        "--all-events",
        ...(options?.untilIdle === false ? [] : ["--until-idle"]),
        ...(options?.cursor ? ["--cursor", options.cursor] : []),
        "--timeout-ms",
        String(windowMs),
      ],
      "session tail",
      {
        ...(options?.repo ? { repo: options.repo } : {}),
        // The CLI owns the wait window; the outer budget only has to outlast it.
        timeoutMs: windowMs + 6_000,
        ...(options?.signal ? { signal: options.signal } : {}),
        terminateAfterResponse: true,
      },
    );
    const result = envelopeResult(envelope) ?? {};
    const checkpoint = asRecord(result.checkpoint);
    /**
     * The continuation token is the envelope's own `cursor`. gjc/0.18.11 answers
     * `checkpoint:{revision,generation,seq,idle}` and reports the resumable token as
     * `result.cursor`; handing `--cursor` that value is what a resumed tail expects.
     */
    const checkpointToken =
      typeof result.cursor === "string" && result.cursor
        ? result.cursor
        : typeof checkpoint?.checkpointToken === "string"
          ? checkpoint.checkpointToken
          : undefined;
    const items: Array<{
      kind: string;
      payload: unknown;
      generation?: number;
      seq?: number;
    }> = [];
    for (const entry of Array.isArray(result.items) ? result.items : []) {
      const record = asRecord(entry);
      if (!record || typeof record.kind !== "string") continue;
      items.push({
        kind: record.kind,
        payload: record.payload,
        ...(typeof record.generation === "number"
          ? { generation: record.generation }
          : {}),
        ...(typeof record.seq === "number" ? { seq: record.seq } : {}),
      });
    }
    return {
      source: typeof result.source === "string" ? result.source : "session",
      terminal: result.terminal === true,
      items,
      ...(typeof checkpointToken === "string"
        ? { checkpointToken }
        : {}),
      ...(asRecord(result.gap) ? { gap: asRecord(result.gap) } : {}),
    };
  }

  /**
   * `gjc sdk session raw control <id> --op <operation>`.
   *
   * `confirm` and `idempotencyKey` are CLI flags, not payload fields: the host
   * validates `turn.abort` terminal input strictly and rejects any key outside
   * `mode`/`scope`/`operator` with `invalid_input` (verified against gjc/0.18.11).
   * The command takes no `--repo`: passing one is rejected as a usage error before
   * the operation is even dispatched.
   */
  async rawControl(
    sessionId: string,
    operation: string,
    input: Record<string, unknown> = {},
    options?: {
      repo?: string;
      idempotencyKey?: string;
      confirm?: boolean;
      timeoutMs?: number;
    },
  ): Promise<Record<string, unknown> | undefined> {
    const envelope = await this.run(
      [
        "sdk",
        "session",
        "raw",
        "control",
        sessionId,
        "--op",
        operation,
        "--json-input",
        JSON.stringify(input),
        ...(options?.idempotencyKey
          ? ["--idempotency-key", options.idempotencyKey]
          : []),
        ...(options?.confirm ? ["--confirm"] : []),
        "--timeout-ms",
        String(this.requestTimeoutMs),
      ],
      operation,
      {
        repo: this.repoFor(options?.repo),
        ...(options?.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
      },
    );
    return envelopeResult(envelope);
  }

  /**
   * `gjc sdk session raw query <id> --query <name>`: one page.
   *
   * Like every exact-session verb, this resolves its target from the session ID;
   * `--repo` is accepted only for compatibility and reports a warning when passed.
   */
  async rawQuery(
    sessionId: string,
    query: string,
    input: Record<string, unknown> = {},
    options?: { repo?: string; cursor?: string; timeoutMs?: number },
  ): Promise<Record<string, unknown>> {
    return await this.run(
      [
        "sdk",
        "session",
        "raw",
        "query",
        sessionId,
        "--query",
        query,
        "--json-input",
        JSON.stringify(input),
        ...(options?.cursor ? ["--cursor", options.cursor] : []),
        "--timeout-ms",
        String(this.requestTimeoutMs),
      ],
      query,
      {
        ...(options?.repo ? { repo: options.repo } : {}),
        ...(options?.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
      },
    );
  }

  /**
   * Every page of a query, with continuation cursors drained.
   *
   * The broker's cursor pool is shared across callers, so a cursor that is opened
   * and abandoned stays stranded. Paging stops on `complete` or an absent cursor.
   */
  async queryItems(
    sessionId: string,
    query: string,
    input: Record<string, unknown> = {},
    options?: { repo?: string },
  ): Promise<unknown[]> {
    const items: unknown[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 4096; page += 1) {
      const envelope = await this.rawQuery(sessionId, query, input, {
        ...(options?.repo ? { repo: options.repo } : {}),
        ...(cursor ? { cursor } : {}),
      });
      const { items: pageItems, complete, cursor: next } = envelopePage(envelope);
      items.push(...pageItems);
      if (complete || !next) break;
      if (seenCursors.has(next))
        throw new SdkCliError(
          "incomplete_query",
          `GJC ${query} repeated a continuation cursor.`,
        );
      seenCursors.add(next);
      cursor = next;
      if (page === 4095)
        throw new SdkCliError(
          "incomplete_query",
          `GJC ${query} exceeded the continuation safety bound.`,
        );
    }
    return items;
  }

  /**
   * `gjc sdk session raw global --op <operation>`.
   *
   * Lifecycle globals require an idempotency key; one is generated when the caller
   * does not supply its own so a retry cannot double-apply.
   *
   * The raw global verb takes no `--repo` and no `--confirm` (verified against
   * gjc/0.18.11): either flag is rejected as a usage error before the operation is
   * dispatched, which would have made every lifecycle call -- create, fork,
   * resume, close, delete -- fail against the broker.
   */
  async rawGlobal(
    operation: string,
    input: Record<string, unknown> = {},
    options?: {
      repo?: string;
      idempotencyKey?: string;
      timeoutMs?: number;
    },
  ): Promise<Record<string, unknown> | undefined> {
    const idempotencyKey =
      options?.idempotencyKey ??
      (LIFECYCLE_GLOBALS.has(operation)
        ? `gajae-${operation.replace(/[^a-z0-9]+/giu, "-")}-${randomUUID()}`
        : undefined);
    const envelope = await this.run(
      [
        "sdk",
        "session",
        "raw",
        "global",
        "--op",
        operation,
        "--json-input",
        JSON.stringify(input),
        ...(idempotencyKey ? ["--idempotency-key", idempotencyKey] : []),
      ],
      operation,
      {
        repo: this.repoFor(options?.repo),
        ...(options?.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
      },
    );
    return envelopeResult(envelope);
  }
}

/**
 * A fresh operation reference.
 *
 * The CLI defaults to a ULID; Gajae supplies its own so the reference is known
 * before the process starts and a lost response can still be reconciled with
 * `status`. The value uses the canonical 26-character Crockford alphabet and an
 * 80-bit random suffix, matching the CLI's ULID validation.
 */
export function freshOperationRef(): string {
  const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
  const encode = (value: bigint, length: number): string => {
    let encoded = "";
    for (let index = 0; index < length; index += 1) {
      encoded = alphabet[Number(value & 31n)] + encoded;
      value >>= 5n;
    }
    return encoded;
  };
  let entropy = 0n;
  for (const byte of randomBytes(10)) entropy = (entropy << 8n) | BigInt(byte);
  return `${encode(BigInt(Date.now()), 10)}${encode(entropy, 16)}`;
}
