import { app, BrowserWindow } from "electron";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

interface WindowView {
  dialog: { prompt: string; workspace: string } | null;
  /** The settings dialog, which a first run opens on the environment check. */
  settings: boolean;
  notice: string | null;
  selected: string | null;
}

const link = (pathAndQuery: string) => `gajae://${pathAndQuery}`;
const query = (values: Record<string, string>) => new URLSearchParams(values).toString();

/**
 * Drives gajae:// links through the main process's real `open-url` and
 * `second-instance` handlers against the mock backend, and checks what the
 * window shows. The first link is sent before the app is ready, the way macOS
 * delivers the link that launched it.
 */
export function startDeepLinkSmoke(): void {
  const workspace = app.getAppPath();
  const timeout = setTimeout(() => {
    console.error("Deep link smoke timed out");
    app.exit(1);
  }, 90_000);
  emitOpenUrl(link(`new?${query({ prompt: "cold launch prompt", path: workspace })}`));
  app.once("browser-window-created", (_event, window) => {
    window.webContents.once("did-finish-load", () => {
      void run(workspace)
        .then(() => {
          clearTimeout(timeout);
          console.log("Deep link smoke passed");
          app.exit(0);
        })
        .catch((error: unknown) => {
          clearTimeout(timeout);
          console.error("FAIL:", error instanceof Error ? error.message : error);
          app.exit(1);
        });
    });
  });
}

function emitOpenUrl(url: string): void {
  app.emit("open-url", { preventDefault: () => undefined }, url);
}

function currentWindow(): BrowserWindow {
  const window = BrowserWindow.getAllWindows()[0];
  if (!window) throw new Error("No window is open");
  return window;
}

async function view(): Promise<WindowView> {
  const window = currentWindow();
  if (window.webContents.isLoading()) return { dialog: null, settings: false, notice: null, selected: null };
  return (await window.webContents.executeJavaScript(`(() => {
    const dialog = document.querySelector(".new-session-dialog");
    return {
      dialog: dialog ? {
        prompt: dialog.querySelector("textarea")?.value ?? "",
        workspace: dialog.querySelector(".project-location-field code")?.textContent ?? "",
      } : null,
      settings: Boolean(document.querySelector(".settings-dialog")),
      notice: document.querySelector(".app-error span")?.textContent ?? null,
      selected: document.querySelector(".session-row.is-selected")?.textContent ?? null,
    };
  })()`)) as WindowView;
}

class StackedDialogs extends Error {
  constructor(state: string) {
    super(`The new-session dialog opened under the settings dialog: ${state}`);
  }
}

async function waitFor(label: string, accept: (state: WindowView) => boolean): Promise<WindowView> {
  const deadline = Date.now() + 15_000;
  let last: WindowView | undefined;
  while (Date.now() < deadline) {
    try {
      last = await view();
      // Two modals at once leave the link's dialog under the other one, with its
      // autofocused field taking the keys typed into the one on top.
      if (last.dialog && last.settings)
        throw new StackedDialogs(JSON.stringify(last));
      if (accept(last)) {
        console.log(`ok: ${label}`, JSON.stringify(last));
        return last;
      }
    } catch (error) {
      if (error instanceof StackedDialogs) throw error;
      // The window may be between documents; the next poll reads it again.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${label}: ${JSON.stringify(last)}`);
}

async function click(selector: string): Promise<void> {
  await currentWindow().webContents.executeJavaScript(
    `document.querySelector(${JSON.stringify(selector)})?.click()`,
  );
}

async function dismissDialog(): Promise<void> {
  await click(".new-session-dialog footer .button-secondary");
  await waitFor("dialog closed", (state) => state.dialog === null);
}

async function dismissNotice(): Promise<void> {
  await click(".app-error button");
  await waitFor("notice cleared", (state) => state.notice === null);
}

async function launchSecondInstance(url: string): Promise<{ code: number | null; output: string }> {
  const child = spawn(process.execPath, [app.getAppPath(), url], {
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
  const code = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Second instance did not exit: ${output}`));
    }, 20_000);
    child.once("exit", (exitCode) => {
      clearTimeout(timer);
      resolve(exitCode);
    });
  });
  return { code, output };
}

async function run(workspace: string): Promise<void> {
  await waitFor(
    "link sent before ready opens the prefilled dialog once the window loads",
    (state) => state.dialog?.prompt === "cold launch prompt" && state.dialog.workspace === workspace,
  );
  await dismissDialog();

  const before = await view();
  if (before.selected?.includes("Codex router cleanup"))
    throw new Error("The target session was already selected");
  emitOpenUrl(link("session/codex-router"));
  await waitFor("session link selects that session", (state) =>
    Boolean(state.selected?.includes("Codex router cleanup")),
  );

  emitOpenUrl(link("session/no-such-session"));
  await waitFor(
    "unknown session id raises a notice and keeps the selection",
    (state) => state.notice !== null && Boolean(state.selected?.includes("Codex router cleanup")),
  );
  await dismissNotice();

  emitOpenUrl(link(`new?${query({ prompt: "x", path: "/definitely/not/a/gajae/folder" })}`));
  await waitFor(
    "missing path raises a notice naming it and opens no dialog",
    (state) => Boolean(state.notice?.includes("/definitely/not/a/gajae/folder")) && state.dialog === null,
  );
  await dismissNotice();

  emitOpenUrl(link(`new?${query({ prompt: "x", path: "relative/folder" })}`));
  await waitFor(
    "relative path raises a notice and opens no dialog",
    (state) => Boolean(state.notice?.includes("relative/folder")) && state.dialog === null,
  );
  await dismissNotice();

  emitOpenUrl(link("settings/open"));
  emitOpenUrl("https://example.com/new?prompt=x");
  await new Promise((resolve) => setTimeout(resolve, 800));
  const ignored = await view();
  if (ignored.dialog !== null || ignored.notice !== null)
    throw new Error(`An unknown link changed the window: ${JSON.stringify(ignored)}`);
  console.log("ok: unknown host and foreign scheme are ignored");

  const second = await launchSecondInstance(
    link(`new?${query({ prompt: "second instance prompt", path: workspace })}`),
  );
  if (second.code !== 0 || !second.output.includes("already running"))
    throw new Error(`Second instance did not hand off: ${JSON.stringify(second)}`);
  console.log("ok: second instance exited 0:", JSON.stringify(second.output.trim()));
  await waitFor(
    "a second launch hands its link to the running instance",
    (state) => state.dialog?.prompt === "second instance prompt",
  );
  await dismissDialog();

  currentWindow().destroy();
  await new Promise((resolve) => setTimeout(resolve, 300));
  if (BrowserWindow.getAllWindows().length !== 0) throw new Error("The window did not close");
  emitOpenUrl(link(`new?${query({ prompt: "no window prompt" })}`));
  await waitFor(
    "a link with every window closed opens a window and its dialog",
    (state) => state.dialog?.prompt === "no window prompt",
  );

  const image = await currentWindow().capturePage();
  const directory = path.join(app.getAppPath(), "artifacts");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "deep-link-smoke.png"), image.toPNG());
}
