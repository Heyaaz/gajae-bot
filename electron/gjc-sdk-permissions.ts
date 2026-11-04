import type { PendingPermission, PermissionResponse } from "./gjc-sdk-model.js";
import { openRelay, type Relay, type RelayTransport } from "./gjc-sdk-relay.js";

/**
 * GJC's external approval channel (`permission.channel.set`, gjc/0.19.3).
 *
 * With the channel on, a session in `prompt` mode holds a tool call that needs
 * approval as a request instead of refusing it. GJC never pushes these: the app
 * lists them with `permission.requests.list` while the session runs, shows each
 * on its tool card, and answers with `permission.respond`. A request GJC drops
 * (its 60 s wait ran out, the turn was aborted, the host restarted) leaves the
 * list, and the card stops waiting. One relay per watched session carries the
 * polling, because a CLI call per poll costs a process.
 */

const POLL_MS = 750;

export interface PermissionChannelHost {
  relayTransport(sessionId: string): RelayTransport;
  /** A turn may be asking: the session is starting, running or waiting. */
  sessionActive(sessionId: string): boolean;
  /** Shows the request on its tool card; settles when someone decides. */
  requestPermission(request: PendingPermission["request"]): Promise<PermissionResponse>;
  /** GJC withdrew the request before anyone decided. */
  dropPermission(toolCallId: string): void;
}

interface ListedRequest {
  id: string;
  toolCall: { toolCallId: string; title?: string };
  options: PendingPermission["request"]["options"];
}

interface Watch {
  relay?: Relay;
  timer?: ReturnType<typeof setInterval>;
  polling: boolean;
  /** Request id to the tool call it is shown on, until GJC stops listing it. */
  shown: Map<string, string>;
}

export class PermissionChannels {
  private readonly watches = new Map<string, Watch>();

  constructor(
    private readonly host: PermissionChannelHost,
    private readonly pollMs = POLL_MS,
  ) {}

  /** The session's channel is on: poll it whenever it is active. */
  watch(sessionId: string): void {
    if (!this.watches.has(sessionId)) this.watches.set(sessionId, { polling: false, shown: new Map() });
    this.sync(sessionId);
  }

  /** Starts or stops polling to follow the session's status. */
  sync(sessionId: string): void {
    const watch = this.watches.get(sessionId);
    if (!watch) return;
    if (this.host.sessionActive(sessionId) || watch.shown.size > 0) {
      watch.timer ??= setInterval(() => void this.poll(sessionId, watch), this.pollMs);
      return;
    }
    this.idle(watch);
  }

  forget(sessionId: string): void {
    const watch = this.watches.get(sessionId);
    if (!watch) return;
    this.idle(watch);
    this.watches.delete(sessionId);
  }

  dispose(): void {
    for (const sessionId of [...this.watches.keys()]) this.forget(sessionId);
  }

  private idle(watch: Watch): void {
    if (watch.timer) clearInterval(watch.timer);
    watch.timer = undefined;
    watch.relay?.close();
    watch.relay = undefined;
  }

  private relayFor(sessionId: string, watch: Watch): Relay {
    watch.relay ??= openRelay(this.host.relayTransport(sessionId), sessionId);
    return watch.relay;
  }

  private async poll(sessionId: string, watch: Watch): Promise<void> {
    if (watch.polling) return;
    watch.polling = true;
    try {
      const relay = this.relayFor(sessionId, watch);
      await relay.ready;
      const listed = await relay.query("permission.requests.list");
      // Enablement lives in the host's memory; a restarted host comes back off.
      if (listed.enabled === false) await relay.control("permission.channel.set", { enabled: true });
      const requests = listedRequests(listed.requests);
      const listedIds = new Set(requests.map((request) => request.id));
      for (const request of requests) {
        if (watch.shown.has(request.id)) continue;
        watch.shown.set(request.id, request.toolCall.toolCallId);
        void this.ask(sessionId, watch, request);
      }
      for (const [id, toolCallId] of watch.shown) {
        if (listedIds.has(id)) continue;
        watch.shown.delete(id);
        this.host.dropPermission(toolCallId);
      }
    } catch {
      // The next poll opens a fresh relay; a host that is gone ends the session's
      // activity, which stops the polling.
      watch.relay?.close();
      watch.relay = undefined;
    } finally {
      watch.polling = false;
      if (this.watches.get(sessionId) === watch) this.sync(sessionId);
      else this.idle(watch);
    }
  }

  private async ask(sessionId: string, watch: Watch, request: ListedRequest): Promise<void> {
    const response = await this.host.requestPermission({
      sessionId,
      toolCall: request.toolCall,
      options: request.options,
    });
    const { outcome } = response;
    if (outcome.outcome !== "selected" || !outcome.optionId) return;
    try {
      const relay = this.relayFor(sessionId, watch);
      await relay.ready;
      await relay.control("permission.respond", {
        sessionId,
        id: request.id,
        optionId: outcome.optionId,
        ...(response.comment ? { comment: response.comment } : {}),
      });
    } catch {
      // Expired or already answered: GJC refuses without granting anything, and
      // the tool's own result reports what happened.
    }
  }
}

const OPTION_KINDS = new Set(["allow_once", "allow_always", "reject_once", "reject_always"]);

function listedRequests(value: unknown): ListedRequest[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((row): ListedRequest[] => {
    if (!row || typeof row !== "object") return [];
    const { id, toolCall, options } = row as Record<string, unknown>;
    const call = toolCall as Record<string, unknown> | undefined;
    if (typeof id !== "string" || typeof call?.toolCallId !== "string" || !Array.isArray(options)) return [];
    const offered = options.flatMap((option): ListedRequest["options"] => {
      const { optionId, name, kind } = (option ?? {}) as Record<string, unknown>;
      return typeof optionId === "string" && typeof name === "string" && OPTION_KINDS.has(kind as string)
        ? [{ optionId, name, kind: kind as ListedRequest["options"][number]["kind"] }]
        : [];
    });
    if (offered.length === 0) return [];
    return [{
      id,
      toolCall: { toolCallId: call.toolCallId, ...(typeof call.title === "string" ? { title: call.title } : {}) },
      options: offered,
    }];
  });
}
