import { app, type BrowserWindow } from "electron";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ipcMain } from "electron";
import { TERMINAL_IPC } from "../shared/terminal-ipc.js";

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
            const shellId = document.querySelector("[data-terminal-id]")?.getAttribute("data-terminal-id");
            if (bridge && shellId) bridge.write(shellId, ${JSON.stringify("echo gajae-pty-ok\r")});
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
        const terminalWrites: string[] = [];
        const observeWrite = (event: Electron.IpcMainEvent, _id: unknown, data: unknown): void => {
          if (event.sender.id === window.webContents.id && typeof data === "string") terminalWrites.push(data);
        };
        ipcMain.on(TERMINAL_IPC.input, observeWrite);
        const effortBefore = await window.webContents.executeJavaScript(`(() => {
          document.querySelector('.terminal-pane .xterm-helper-textarea')?.focus();
          return document.querySelector('.composer-model button > span')?.textContent ?? '';
        })()`);
        window.webContents.focus();
        window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Tab", modifiers: ["shift"] });
        window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Tab", modifiers: ["shift"] });
        await new Promise(resolve => setTimeout(resolve, 150));
        const keyReport = await window.webContents.executeJavaScript(`({
          effort: document.querySelector('.composer-model button > span')?.textContent ?? '',
          terminalFocused: Boolean(document.activeElement?.closest('.terminal-pane')),
          background: getComputedStyle(document.querySelector('.xterm-viewport')).backgroundColor,
        })`);
        ipcMain.removeListener(TERMINAL_IPC.input, observeWrite);
        if (keyReport.effort !== effortBefore) throw new Error("Terminal Shift+Tab changed Chat reasoning effort");
        if (!keyReport.terminalFocused || !terminalWrites.includes('\x1b[Z'))
          throw new Error("Native Shift+Tab did not reach the focused PTY: " + JSON.stringify(keyReport));
        console.log("Native terminal Shift+Tab isolation passed", JSON.stringify(keyReport));
        const sessionReport = await window.webContents.executeJavaScript(`(async () => {
          const bridge = window.agentControlDesktop.terminal;
          const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
          const output = new Map();
          const offOutput = bridge.onOutput((event) => output.set(event.id, (output.get(event.id) ?? "") + event.data));
          const created = await bridge.createSession({ title: "smoke shell", workspace: ${JSON.stringify(tmpdir())}, launch: "shell" });
          const first = await bridge.start({ token: 900001, session: created.id, cols: 80, rows: 24 });
          bridge.write(first.id, "echo gajae-session-ok $$\\r");
          const deadline = Date.now() + 10_000;
          const pid = () => /gajae-session-ok (\\d+)/.exec(output.get(first.id) ?? "")?.[1];
          while (Date.now() < deadline && !pid()) await wait(100);
          const again = await bridge.start({ token: 900002, session: created.id, cols: 80, rows: 24 });
          const listed = (await bridge.listSessions()).find((session) => session.id === created.id);
          await bridge.deleteSession(created.id);
          const remaining = (await bridge.listSessions()).some((session) => session.id === created.id);
          offOutput();
          return {
            runtime: listed?.runtime ?? null,
            sameShell: again.id === first.id,
            replayed: (again.replay ?? "").includes("gajae-session-ok"),
            pid: Number(pid()),
            remaining,
          };
        })()`);
        const shellAlive = (): boolean => {
          try {
            process.kill(sessionReport.pid, 0);
            return true;
          } catch {
            return false;
          }
        };
        for (let attempt = 0; attempt < 30 && shellAlive(); attempt += 1)
          await new Promise((resolve) => setTimeout(resolve, 100));
        sessionReport.exitedOnDelete = !shellAlive();
        if (
          !(sessionReport.pid > 1) ||
          sessionReport.runtime !== "terminal" ||
          !sessionReport.sameShell ||
          !sessionReport.replayed ||
          !sessionReport.exitedOnDelete ||
          sessionReport.remaining
        )
          throw new Error("Terminal session lifecycle failed: " + JSON.stringify(sessionReport));
        console.log("Terminal session lifecycle passed", JSON.stringify(sessionReport));
        const overflow = await window.webContents.executeJavaScript(`(async () => {
          await document.fonts.load('14px "Gajae Terminal Symbols"', '');
          const panel = document.createElement('aside');
          panel.style.cssText = 'position:fixed;width:260px;top:0;left:0;z-index:10000';
          const section = document.createElement('section'); section.className = 'inspector-section';
          const card = document.createElement('details'); card.className = 'subagent-card'; card.open = true;
          const summary = document.createElement('summary'); summary.innerHTML = '<span></span><strong>bash</strong><em>Complete</em>';
          const id = document.createElement('small'); id.textContent = 'call_' + 'x'.repeat(500);
          const command = document.createElement('p'); command.textContent = 'command_' + 'x'.repeat(5000);
          const output = document.createElement('pre'); output.className = 'inspector-work-output'; output.textContent = ('output_' + 'x'.repeat(1000) + '\\n').repeat(40);
          card.append(summary,id,command,output); section.append(card); panel.append(section); document.body.append(panel);
          const result = { panelWidth: panel.clientWidth, panelScrollWidth: panel.scrollWidth,
            cardWidth: card.getBoundingClientRect().width, outputHeight: output.clientHeight,
            outputScrollHeight: output.scrollHeight, commandHeight: command.clientHeight,
            commandScrollHeight: command.scrollHeight,
            glyphFontLoaded: document.fonts.check('14px "Gajae Terminal Symbols"', '') };
          panel.remove(); return result;
        })()`);
        if (overflow.panelScrollWidth > overflow.panelWidth + 1 || overflow.outputHeight > 320 ||
          overflow.commandHeight > 160 || overflow.outputScrollHeight <= overflow.outputHeight ||
          overflow.commandScrollHeight <= overflow.commandHeight || !overflow.glyphFontLoaded)
          throw new Error("Prompt font or shell-card containment failed: " + JSON.stringify(overflow));
        console.log("Shell card containment passed", JSON.stringify(overflow));
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
