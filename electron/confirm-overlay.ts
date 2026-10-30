import { BrowserWindow, nativeTheme } from "electron";
import { hostText } from "./host-text.js";

/**
 * Host confirmations drawn the way the app draws its own dialogs.
 *
 * The answer must come from the user, not from the window that asked, so the
 * dialog is a separate scriptless window owned by the main process rather than a
 * component in the renderer: a compromised renderer cannot click it or read its
 * answer. JavaScript is off, both buttons submit to a URL that never loads, and
 * the main process reads the answer from the navigation it cancels.
 */

export interface ConfirmContent {
  message: string;
  detail?: string;
  /** The confirm button's label; "계속" when absent. */
  confirmLabel?: string;
  /** Red confirm button, for an action that removes something. */
  danger?: boolean;
}

export type ConfirmTheme = "dark" | "light";

const ANSWER_ORIGIN = "https://gajae-confirm.invalid";
const THEME_TIMEOUT_MS = 300;

const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/gu, (character) => `&#${character.charCodeAt(0)};`);

const WARNING_ICON =
  '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>';
const QUESTION_ICON =
  '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>';

/** The dialog document; every piece of text in it is escaped. */
export function confirmPage(content: ConfirmContent, theme: ConfirmTheme): string {
  const message = escapeHtml(hostText(content.message));
  const detail = content.detail ? escapeHtml(hostText(content.detail)) : "";
  const confirmLabel = escapeHtml(hostText(content.confirmLabel ?? "계속"));
  const cancelLabel = escapeHtml(hostText("취소"));
  const dark = theme === "dark";
  return `<!doctype html>
<html lang="ko" data-theme="${theme}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; form-action ${ANSWER_ORIGIN}">
<title>${message}</title>
<style>
:root {
  --bg-dialog: ${dark ? "#171719" : "#ffffff"};
  --border: ${dark ? "rgba(255, 255, 255, 0.085)" : "rgba(15, 15, 20, 0.09)"};
  --border-strong: ${dark ? "rgba(255, 255, 255, 0.14)" : "rgba(15, 15, 20, 0.16)"};
  --text-primary: ${dark ? "#f1f1f3" : "#18181b"};
  --text-secondary: ${dark ? "#a6a6ad" : "#55555c"};
  --overlay: ${dark ? "#ffffff" : "#000000"};
  --icon: ${content.danger ? (dark ? "#ee7b7b" : "#c2414b") : (dark ? "#ff9238" : "#d9530c")};
  color-scheme: ${theme};
  font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif;
  -webkit-font-smoothing: antialiased;
}
html, body { height: 100%; margin: 0; background: transparent; overflow: hidden; user-select: none; }
.backdrop { position: fixed; inset: 0; border-radius: 12px; background: rgba(0, 0, 0, ${dark ? "0.6" : "0.38"}); }
main { position: fixed; inset: 0; display: grid; place-items: center; padding: 34px; pointer-events: none; }
form {
  pointer-events: auto;
  width: min(390px, calc(100vw - 40px));
  padding: 18px;
  box-sizing: border-box;
  background: var(--bg-dialog);
  border: 1px solid var(--border-strong);
  border-radius: 12px;
  box-shadow: 0 28px 80px rgba(0, 0, 0, ${dark ? "0.55" : "0.22"});
}
header { display: flex; align-items: center; gap: 9px; color: var(--icon); }
svg { flex: none; width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
h1 { margin: 0; color: var(--text-primary); font-size: 15px; font-weight: 650; line-height: 1.4; }
p {
  max-height: 180px;
  margin: 15px 0 0;
  overflow: auto;
  color: var(--text-secondary);
  font-size: 11px;
  line-height: 1.55;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  user-select: text;
}
footer { display: flex; justify-content: flex-end; gap: 7px; margin-top: 20px; }
button {
  height: 28px;
  padding: 0 10px;
  font: inherit;
  font-size: 11px;
  border-radius: 6px;
  cursor: default;
}
button:focus-visible { outline: 2px solid ${dark ? "#ff9238" : "#d9530c"}; outline-offset: 2px; }
.secondary { color: var(--text-secondary); background: color-mix(in srgb, var(--overlay) 5%, transparent); border: 1px solid var(--border); }
.secondary:hover { color: var(--text-primary); background: color-mix(in srgb, var(--overlay) 8%, transparent); }
.primary { color: #17100b; font-weight: 650; background: #ff8a34; border: 0; }
.primary:hover { background: #ffa159; }
.danger { color: #fff; font-weight: 600; background: #a9474f; border: 0; }
.danger:hover { background: #bd535c; }
</style>
</head>
<body>
<a class="backdrop" href="${ANSWER_ORIGIN}/cancel" tabindex="-1" aria-hidden="true"></a>
<main>
<form method="get" action="${ANSWER_ORIGIN}/cancel" role="alertdialog" aria-modal="true" aria-labelledby="message">
<header><svg viewBox="0 0 24 24" aria-hidden="true">${content.danger ? WARNING_ICON : QUESTION_ICON}</svg><h1 id="message">${message}</h1></header>
${detail ? `<p>${detail}</p>` : ""}
<footer>
<button class="secondary" type="submit" formaction="${ANSWER_ORIGIN}/cancel" autofocus>${cancelLabel}</button>
<button class="${content.danger ? "danger" : "primary"}" type="submit" formaction="${ANSWER_ORIGIN}/continue">${confirmLabel}</button>
</footer>
</form>
</main>
</body>
</html>`;
}

/** The answer a navigation out of the dialog carries, or undefined for any other URL. */
export function confirmAnswer(url: string): boolean | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.origin !== ANSWER_ORIGIN) return undefined;
    if (parsed.pathname === "/continue") return true;
    if (parsed.pathname === "/cancel") return false;
  } catch {
    // Not a URL the dialog produces.
  }
  return undefined;
}

/**
 * The theme the asking window paints. The renderer owns the setting, and what it
 * reports only colors the dialog, so anything but "light" or "dark" (or no reply)
 * falls back to the OS.
 */
async function windowTheme(window: BrowserWindow): Promise<ConfirmTheme> {
  const fallback: ConfirmTheme = nativeTheme.shouldUseDarkColors ? "dark" : "light";
  const reported = await Promise.race([
    window.webContents
      .executeJavaScript("document.documentElement.dataset.theme", false)
      .catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, THEME_TIMEOUT_MS)),
  ]);
  return reported === "light" || reported === "dark" ? reported : fallback;
}

/** Shows the dialog over `parent` and resolves with the user's answer. */
export async function confirmOverWindow(
  parent: BrowserWindow,
  content: ConfirmContent,
): Promise<boolean> {
  if (parent.isDestroyed()) return false;
  const theme = await windowTheme(parent);
  if (parent.isDestroyed()) return false;
  return new Promise<boolean>((resolve) => {
    const overlay = new BrowserWindow({
      ...parent.getContentBounds(),
      parent,
      show: false,
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      title: hostText(content.message),
      webPreferences: {
        javascript: false,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false,
      },
    });
    let settled = false;
    const fit = (): void => {
      if (!overlay.isDestroyed() && !parent.isDestroyed())
        overlay.setBounds(parent.getContentBounds());
    };
    const settle = (answer: boolean): void => {
      if (settled) return;
      settled = true;
      parent.removeListener("resize", fit);
      parent.removeListener("move", fit);
      parent.removeListener("closed", cancel);
      if (!overlay.isDestroyed()) overlay.destroy();
      if (!parent.isDestroyed()) parent.focus();
      resolve(answer);
    };
    const cancel = (): void => settle(false);
    parent.on("resize", fit);
    parent.on("move", fit);
    parent.once("closed", cancel);
    overlay.once("closed", cancel);
    overlay.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    overlay.webContents.on("will-navigate", (event, url) => {
      event.preventDefault();
      const answer = confirmAnswer(url);
      if (answer !== undefined) settle(answer);
    });
    overlay.webContents.on("before-input-event", (event, input) => {
      if (input.type === "keyDown" && input.key === "Escape") {
        event.preventDefault();
        cancel();
      }
    });
    overlay.once("ready-to-show", () => {
      if (settled) return;
      overlay.show();
      overlay.focus();
    });
    void overlay
      .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(confirmPage(content, theme))}`)
      .catch(cancel);
  });
}
