import './smoke-isolation.mjs'
import { app, BrowserWindow, ipcMain } from 'electron'
import path from 'node:path'
import { GJC_IPC } from '../dist-electron/shared/gjc-ipc.js'
import { SETTINGS_IPC } from '../dist-electron/shared/settings-ipc.js'

/**
 * Renders the shell against a runtime that cannot be reached and asserts the window
 * says so.
 *
 * This app's claim is that its screen is the source of truth about the agent, so a
 * failed runtime must never look like a healthy idle one. Before this was fixed the
 * renderer swapped in the mock backend whenever the connection was not `connected`,
 * and that backend reports `state: "connected"` -- so a dead GJC produced a green dot,
 * four fabricated session rows, and a working composer over transcripts that never
 * happened. Unit tests can pin the selection code, but only a real render proves what
 * a user actually sees, which is why this runs in Electron.
 *
 * Run through `npm run verify`. Exits non-zero on any regression.
 */
const appPath = path.resolve(import.meta.dirname, '..')
const FAILURE_DETAIL = 'spawn /nonexistent/gjc ENOENT'

app.setName('Gajae Offline Smoke')

const connectionFailure = {
  state: 'error',
  backend: 'gjc',
  label: 'GJC unavailable',
  detail: FAILURE_DETAIL,
  workspace: '/tmp/project',
}

app.whenReady().then(async () => {
  const timeout = setTimeout(() => {
    console.error('Offline shell smoke timed out')
    app.exit(1)
  }, 30_000)

  try {
    // Only what the shell asks for at boot is answered, and the runtime reports itself
    // unreachable. Anything the shell calls beyond this would be reaching for data a
    // disconnected window has no business showing.
    ipcMain.handle(GJC_IPC.getConnection, () => connectionFailure)
    ipcMain.handle(GJC_IPC.reconnect, () => connectionFailure)
    ipcMain.handle(GJC_IPC.listSessions, () => [])
    ipcMain.handle(GJC_IPC.listHistorySessions, () => [])
    ipcMain.handle(SETTINGS_IPC.getPreferences, () => ({
      workspace: '/tmp/project',
      workspaceLabel: 'Offline smoke workspace',
      modelPreset: 'codex-medium',
      permissionHandling: 'prompt',
      gjcExecutable: '',
    }))
    ipcMain.handle(SETTINGS_IPC.checkGjcUpdate, () => {
      // An unreachable runtime cannot answer an update check either.
      throw new Error('GJC is unavailable')
    })

    const window = new BrowserWindow({
      width: 1280,
      height: 860,
      show: false,
      webPreferences: {
        preload: path.join(appPath, 'dist-electron/electron/preload.cjs'),
        contextIsolation: true,
        sandbox: true,
      },
    })

    await window.loadFile(path.join(appPath, 'dist/index.html'))
    await new Promise((resolve) => setTimeout(resolve, 2_500))

    const report = await window.webContents.executeJavaScript(`
      (() => {
        const text = document.body.textContent ?? ''
        return {
          shellMounted: Boolean(document.querySelector('.app-shell')),
          offlineScreenRendered: Boolean(document.querySelector('.workspace--offline')),
          showsFailureHeadline: text.includes('GJC runtime에 연결되지 않았습니다'),
          showsRuntimeDetail: text.includes(${JSON.stringify(FAILURE_DETAIL)}),
          hasReconnectAction: Array.from(document.querySelectorAll('button')).some((button) => button.textContent?.trim() === '재연결'),
          fabricatedSessionRows: document.querySelectorAll('.session-row').length,
          claimsConnected: text.includes('연결됨'),
          rendersComposer: Boolean(document.querySelector('.composer textarea')),
          connectionDotState: document.querySelector('.connection-dot')?.className ?? null,
        }
      })()
    `)

    const failures = []
    const require = (condition, message) => {
      if (!condition) failures.push(message)
    }
    require(report.shellMounted, 'Application shell did not mount')
    require(report.offlineScreenRendered, 'Offline workspace screen did not render')
    require(report.showsFailureHeadline, 'Window did not state that the runtime is unreachable')
    require(report.showsRuntimeDetail, 'Window hid the underlying runtime failure')
    require(report.hasReconnectAction, 'Offline screen offered no way to reconnect')
    // The regression itself: fabricated data standing in for a failed runtime.
    require(report.fabricatedSessionRows === 0, `Fabricated ${report.fabricatedSessionRows} session rows for an unreachable runtime`)
    require(!report.claimsConnected, 'Unreachable runtime was reported as connected')
    require(!report.rendersComposer, 'Composer rendered for a session that cannot receive input')
    require(
      report.connectionDotState?.includes('connection-dot--error'),
      `Connection indicator did not report the failure: ${report.connectionDotState}`,
    )

    console.log(JSON.stringify(report, null, 2))
    clearTimeout(timeout)
    if (failures.length > 0) {
      for (const failure of failures) console.error(`FAIL: ${failure}`)
      app.exit(1)
      return
    }
    console.log('Offline shell smoke passed')
    app.exit(0)
  } catch (error) {
    clearTimeout(timeout)
    console.error('Offline shell smoke failed to run', error)
    app.exit(1)
  }
})
