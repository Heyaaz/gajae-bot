import type { MessageDelivery } from "../../shared/agent-contract";
import type { MessageInput } from "../backend/types";
import { t } from "../i18n";

export const FAST_SERVICE_TIERS = new Set([
  "priority",
  "openai-only",
  "claude-only",
]);

/**
 * Apply a Fast tier change through the runtime's own service-tier control.
 *
 * The command is sent with no attachments on purpose: the runtime only treats a
 * slash command as a control when the message carries none, and only a control
 * applies to the session immediately -- with an attachment the same text would be
 * delivered as prompt work into the open turn.
 *
 * Nothing here predicts the outcome. The composer's indicator follows the
 * serviceTier the session reports back, so a refused request leaves the buttons on
 * the tier that is actually in force instead of a state this call invented. That
 * refusal is reported and consumed rather than re-thrown: the send came from a
 * button with no awaiting caller, so an escaping rejection would land in the
 * renderer's unhandled queue.
 */
export async function requestFastTier(options: {
  fast: boolean;
  send: (input: MessageInput) => Promise<MessageDelivery | undefined>;
  report: (message: string) => void;
}): Promise<void> {
  try {
    await options.send({
      text: options.fast ? "/fast on" : "/fast off",
      images: [],
      files: [],
    });
  } catch (error) {
    options.report(error instanceof Error ? error.message : String(error));
  }
}

/** A Fast request in flight, owned by the session that asked for it. */
export interface FastTierRequest {
  sessionId: string;
}

/**
 * Whether this session has a Fast request of its own on the wire.
 *
 * Ownership is compared instead of holding one boolean, because the composer is a
 * single mounted component for every session: a request sent from one row can
 * still be in flight long after the user moved on, and a plain flag left the next
 * row's buttons disabled behind work that no longer concerned it.
 */
export function fastTierBusy(
  request: FastTierRequest | null,
  sessionId: string,
): boolean {
  return request?.sessionId === sessionId;
}

/** Whether this session's runtime advertises the Fast service-tier control. */
export function advertisesFast(
  commands: readonly { name: string }[],
): boolean {
  return commands.some((command) => command.name === "fast");
}

export interface FastTierControlsProps {
  commands: readonly { name: string }[];
  /** Whether the session reports a priority tier right now, never a local guess. */
  fastMode: boolean;
  /** A Fast request for this session is still awaiting the runtime. */
  busy: boolean;
  readOnly: boolean;
  onSelect: (fast: boolean) => void;
}

/**
 * The Fast pair in the model popover header.
 *
 * Two named buttons rather than one toggle: the tier belongs to the runtime, so
 * each press says which state is being asked for and `aria-pressed` marks the one
 * in force. The runtime only offers the control when it advertises `/fast`, so a
 * backend without a service tier shows no buttons at all. Pressing one leaves the
 * menu open -- the model list is the same menu, and closing it would hide the
 * profiles the user came for.
 */
export function FastTierControls({
  commands,
  fastMode,
  busy,
  readOnly,
  onSelect,
}: FastTierControlsProps) {
  if (!advertisesFast(commands)) return null;
  const disabled = readOnly || busy;
  return (
    <span
      className="config-option-menu-fast"
      role="group"
      aria-label={t("Fast 모드")}
    >
      <button
        type="button"
        aria-pressed={fastMode}
        disabled={disabled}
        title={t("Fast 모드 켜기 (/fast on)")}
        onClick={() => onSelect(true)}
      >
        Fast on
      </button>
      <button
        type="button"
        aria-pressed={!fastMode}
        disabled={disabled}
        title={t("Fast 모드 끄기 (/fast off)")}
        onClick={() => onSelect(false)}
      >
        Fast off
      </button>
    </span>
  );
}

