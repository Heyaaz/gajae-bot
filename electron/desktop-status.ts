import path from "node:path";
import { sessionAttentionGroup } from "../shared/desktop-integration.js";
import type {
  DesktopIntegrationState,
  TrackedSession,
} from "./desktop-integration.js";
import { hostText } from "./host-text.js";

export type StatusMenuEntry =
  | { kind: "heading"; label: string }
  | { kind: "session"; label: string; sessionId: string }
  | { kind: "separator" }
  | { kind: "open-app"; label: string };

export interface StatusTray {
  title: string;
  tooltip: string;
  menu: readonly StatusMenuEntry[];
}

/** What the menu bar and the Dock show; a function of the session state alone. */
export interface DesktopStatusModel {
  /** `null` removes the menu bar item: the preference is off. */
  tray: StatusTray | null;
  /** The empty string clears the Dock badge. */
  badge: string;
}

/** The Electron side of the menu bar and Dock, injected so the model stays testable. */
export interface DesktopStatusSurface {
  setTray(tray: StatusTray | null): void;
  setBadge(badge: string): void;
}

/** A menu longer than this stops being a glance; the title still counts every session. */
export const STATUS_MENU_LIMIT = 10;
const LABEL_LIMIT = 48;

// U+FE0E asks for the text glyph; the emoji form would be coloured in the menu bar.
const WORKING_MARK = "\u25B6\uFE0E";
const NEEDS_INPUT_MARK = "\u26A0\uFE0E";

export function desktopStatusModel(
  state: DesktopIntegrationState,
): DesktopStatusModel {
  const { attention, preferences } = state;
  const badgeCount = attention.needsInput + attention.unreadCompleted;
  return {
    tray: preferences.menuBarStatus ? statusTray(state) : null,
    badge: preferences.dockBadge && badgeCount > 0 ? String(badgeCount) : "",
  };
}

function statusTray(state: DesktopIntegrationState): StatusTray {
  const { working, needsInput } = state.attention;
  const title = [
    needsInput > 0 ? `${NEEDS_INPUT_MARK}${needsInput}` : "",
    working > 0 ? `${WORKING_MARK}${working}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  const tooltip = [
    `${hostText("확인 필요")} ${needsInput}`,
    `${hostText("실행 중")} ${working}`,
  ].join(" · ");

  const newestFirst = [...state.sessions].sort(
    (left, right) => (right.updatedAtMs ?? 0) - (left.updatedAtMs ?? 0),
  );
  const listed = [
    ...newestFirst.filter((session) => sessionAttentionGroup(session) === "needs-input"),
    ...newestFirst.filter((session) => sessionAttentionGroup(session) === "working"),
  ].slice(0, STATUS_MENU_LIMIT);

  const menu: StatusMenuEntry[] = [];
  for (const [group, heading] of [
    ["needs-input", "확인 필요"],
    ["working", "실행 중"],
  ] as const) {
    const sessions = listed.filter(
      (session) => sessionAttentionGroup(session) === group,
    );
    if (sessions.length === 0) continue;
    if (menu.length > 0) menu.push({ kind: "separator" });
    menu.push({ kind: "heading", label: hostText(heading) });
    for (const session of sessions)
      menu.push({
        kind: "session",
        label: sessionLabel(session),
        sessionId: session.id,
      });
  }
  if (menu.length === 0)
    menu.push({ kind: "heading", label: hostText("진행 중인 세션 없음") });
  menu.push({ kind: "separator" });
  menu.push({ kind: "open-app", label: hostText("Gajae 열기") });
  return { title, tooltip, menu };
}

function sessionLabel(session: TrackedSession): string {
  const name =
    session.title.trim() || path.basename(session.workspace) || session.id;
  const short =
    name.length > LABEL_LIMIT ? `${name.slice(0, LABEL_LIMIT - 1)}…` : name;
  return session.status === "failed" ? `${short} (${hostText("실패")})` : short;
}

/**
 * Applies the model to the surface, skipping the parts that did not change.
 *
 * Every row update reaches here, and most (streamed activity on a running
 * session, a rename of a finished one) leave the menu bar and the badge as they
 * were.
 */
export function desktopStatusRenderer(
  surface: DesktopStatusSurface,
): (state: DesktopIntegrationState) => void {
  let renderedTray: string | undefined;
  let renderedBadge: string | undefined;
  return (state) => {
    const model = desktopStatusModel(state);
    const tray = JSON.stringify(model.tray);
    if (tray !== renderedTray) {
      renderedTray = tray;
      surface.setTray(model.tray);
    }
    if (model.badge !== renderedBadge) {
      renderedBadge = model.badge;
      surface.setBadge(model.badge);
    }
  };
}

/**
 * A macOS template mask: dark, opaque pixels become solid black, the rest clear.
 *
 * The app icon is a full-colour square, so its alpha alone is a rounded square;
 * the line art is what still reads as Gajae at menu bar size. Run again after
 * downscaling with a lower `opaqueAbove`, it turns the half-transparent thin lines
 * solid, which macOS would otherwise draw faintly. Channel order does not matter
 * (Electron bitmaps are BGRA): only the brightest colour channel and alpha are read.
 */
export function templateMask(
  bitmap: Buffer,
  { darkBelow = 90, opaqueAbove = 128 } = {},
): Buffer {
  const mask = Buffer.alloc(bitmap.length);
  for (let offset = 0; offset + 3 < bitmap.length; offset += 4) {
    const opaque = bitmap[offset + 3] > opaqueAbove;
    const dark =
      Math.max(bitmap[offset], bitmap[offset + 1], bitmap[offset + 2]) <
      darkBelow;
    mask[offset + 3] = opaque && dark ? 255 : 0;
  }
  return mask;
}
