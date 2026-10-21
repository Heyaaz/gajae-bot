import { app, type BrowserWindow } from "electron";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Opens the mock chat, switches to Terminal, and checks that a real login
 * shell echoed a marker. Saves a screenshot either way.
 */
export function attachTerminalSmoke(window: BrowserWindow): void {
  const timeout = setTimeout(() => {
    console.error("Terminal view smoke timed out");
    app.exit(1);
  }, 45_000);

  window.webContents.once("did-finish-load", () => {
    void (async () => {
      try {
        await new Promise((resolve) => setTimeout(resolve, 600));
        const report = (await window.webContents.executeJavaScript(`
          (async () => {
            const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
            const deadline = Date.now() + 25_000;
            const text = () => document.querySelector(".xterm-rows")?.textContent ?? "";
            while (Date.now() < deadline && !document.querySelector("[data-terminal-toggle]")) {
              document.querySelector(".session-row")?.click();
              await wait(100);
            }
            const toggle = document.querySelector("[data-terminal-toggle]");
            toggle?.click();
            while (Date.now() < deadline && document.querySelector("[data-terminal-state]")?.getAttribute("data-terminal-state") !== "running") {
              await wait(100);
            }
            const bridge = window.agentControlDesktop && window.agentControlDesktop.terminal;
            if (bridge) bridge.write(${JSON.stringify("echo gajae-pty-ok\r")});
            while (Date.now() < deadline && !text().includes("gajae-pty-ok")) await wait(100);
            const sample = text().slice(-500);
            return {
              hasToggle: Boolean(toggle),
              hasXterm: Boolean(document.querySelector(".xterm")),
              state: document.querySelector("[data-terminal-state]")?.getAttribute("data-terminal-state") ?? null,
              chatHidden: document.querySelector(".conversation")?.hasAttribute("hidden") === true,
              echoed: sample.includes("gajae-pty-ok"),
              sample,
            };
          })()
        `)) as {
          hasToggle: boolean;
          hasXterm: boolean;
          state: string | null;
          chatHidden: boolean;
          echoed: boolean;
          sample: string;
        };
        const image = await window.capturePage();
        const directories = [
          path.join(app.getAppPath(), "artifacts"),
          "/opt/cursor/artifacts",
        ];
        for (const directory of directories) {
          try {
            await mkdir(directory, { recursive: true });
            await writeFile(path.join(directory, "terminal-smoke.png"), image.toPNG());
          } catch (error) {
            console.error(`Could not write terminal screenshot to ${directory}`, error);
          }
        }
        console.log(JSON.stringify(report, null, 2));
        clearTimeout(timeout);
        const failures: string[] = [];
        if (!report.hasToggle) failures.push("Chat header did not offer the terminal toggle");
        if (!report.hasXterm) failures.push("xterm did not mount");
        if (report.state !== "running") failures.push(`Terminal state was ${report.state}`);
        if (!report.chatHidden) failures.push("Chat transcript stayed visible in terminal mode");
        if (!report.echoed) failures.push("Login shell did not echo gajae-pty-ok");
        if (failures.length > 0) {
          for (const failure of failures) console.error(`FAIL: ${failure}`);
          app.exit(1);
          return;
        }
        console.log("Terminal view smoke passed");
        app.exit(0);
      } catch (error) {
        clearTimeout(timeout);
        console.error("Terminal view smoke failed to run", error);
        app.exit(1);
      }
    })();
  });
}
