import { app, BrowserWindow, ipcMain } from 'electron'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createServer } from 'node:net'
import { GJC_IPC } from '../dist-electron/shared/gjc-ipc.js'
import { SETTINGS_IPC } from '../dist-electron/shared/settings-ipc.js'
import { DeviceStore } from '../dist-electron/electron/remote/devices.js'
import { RemoteAccessService } from '../dist-electron/electron/remote/service.js'
import { TailscaleClient } from '../dist-electron/electron/remote/tailscale.js'
import { registerRemoteIpcHandlers } from '../dist-electron/electron/remote-ipc-handlers.js'

/**
 * Proves the remote access path end to end, inside a real app window.
 *
 * Unit tests cover the server's rules and the client's reconnection logic, but the
 * feature is only real if the desktop can turn it on, mint a code, list the paired
 * device, and revoke it — with the HTTP server actually listening. This script
 * drives the real `RemoteAccessService`, the real IPC handlers, the real preload
 * bridge, and the built web client.
 *
 * It runs against an isolated user data directory and a Tailscale binary that does
 * not exist, so it can never reconfigure the owner's Tailscale Serve.
 *
 * Exits non-zero on any regression.
 */
const appPath = path.resolve(import.meta.dirname, '..')
const userData = mkdtempSync(path.join(tmpdir(), 'gajae-remote-smoke-'))

app.setName('Gajae Remote Smoke')
app.setPath('userData', userData)

const connection = {
  state: 'connected',
  backend: 'gjc',
  label: 'GJC (smoke)',
  detail: 'gjc 0.0.0-smoke',
  workspace: '/tmp/gajae-remote-smoke',
}

const session = {
  id: 'smoke-session-1',
  title: '원격 스모크 세션',
  subtitle: 'smoke',
  workspace: '/tmp/gajae-remote-smoke',
  runtime: 'gjc',
  status: 'idle',
  updatedAt: new Date(0).toISOString(),
  pinned: false,
  unread: false,
  accent: '#f06416',
  ownership: 'gajae',
  attachment: 'attached',
}

const failures = []
function require_(condition, message) {
  if (!condition) failures.push(message)
}

async function request(url, init = {}) {
  const response = await fetch(url, init)
  const text = await response.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  return { status: response.status, body, headers: response.headers }
}

async function main() {
  // Never collide with the user's running desktop listener on the default port.
  const portProbe = createServer()
  await new Promise((resolve, reject) => {
    portProbe.once('error', reject)
    portProbe.listen(0, '127.0.0.1', resolve)
  })
  const smokePort = portProbe.address().port
  await new Promise((resolve, reject) => portProbe.close((error) => error ? reject(error) : resolve()))
  const host = {
    getConnection: async () => connection,
    listSessions: async () => [session],
    listHistorySessions: async () => [],
    getTranscript: async () => [],
    getTranscriptPage: async () => ({ items: [], requests: [], hasMoreBefore: false, hasMoreAfter: false }),
    getTranscriptRevision: async () => undefined,
    listQueuedMessages: async () => [],
    getGoal: async () => ({ enabled: false, completed: 0, total: 0 }),
    listSubagents: async () => [],
    getGitStatus: async () => ({ workspace: session.workspace, branch: 'main', ahead: 0, behind: 0, files: [] }),
    getDiff: async () => ({ sessionId: session.id, workspace: session.workspace, files: [], refreshedAt: new Date(0).toISOString() }),
    readArtifact: async (_sessionId, artifactId) => ({ artifactId, text: '', complete: true, totalBytes: 0 }),
    sendMessage: async () => 'prompt',
    steerSession: async () => {},
    queueFollowUp: async () => {},
    flushQueuedNow: async () => true,
    cancelRun: async () => {},
    resolveToolCall: async () => {},
    listPendingQuestions: async () => [],
    answerQuestion: async () => {},
    markSessionRead: async () => {},
  }

  const service = new RemoteAccessService({
    userDataDirectory: userData,
    webRoot: path.join(appPath, 'dist/web'),
    version: '0.1.0-smoke',
    workspace: () => connection.workspace,
    host,
    devices: new DeviceStore(path.join(userData, 'remote-devices.json')),
    // Never the real Tailscale: this smoke must not touch the owner's Serve config.
    tailscale: new TailscaleClient({ binary: path.join(appPath, 'smoke-missing-tailscale') }),
    log: () => {},
  })
  const unregisterRemote = registerRemoteIpcHandlers(service, {
    guarded: (handler) => handler,
  })
  await service.setPort(smokePort)

  // Anything the window asks for that this smoke does not model answers empty, so a
  // missing handler cannot be mistaken for a runtime failure.
  const modeled = new Set([
    GJC_IPC.getConnection,
    GJC_IPC.reconnect,
    GJC_IPC.listSessions,
    GJC_IPC.listHistorySessions,
    GJC_IPC.getTranscript,
    GJC_IPC.getTranscriptPage,
    GJC_IPC.getTranscriptChanges,
    GJC_IPC.getTranscriptRevision,
    GJC_IPC.listQueuedMessages,
    GJC_IPC.getGoal,
    GJC_IPC.listSubagents,
    GJC_IPC.getGitStatus,
  ])
  for (const channel of Object.values(GJC_IPC)) {
    if (channel === GJC_IPC.event || modeled.has(channel)) continue
    ipcMain.handle(channel, () => null)
  }

  ipcMain.handle(GJC_IPC.getConnection, () => connection)
  ipcMain.handle(GJC_IPC.reconnect, () => connection)
  ipcMain.handle(GJC_IPC.listSessions, () => [session])
  ipcMain.handle(GJC_IPC.listHistorySessions, () => [])
  ipcMain.handle(GJC_IPC.getTranscript, () => [])
  ipcMain.handle(GJC_IPC.getTranscriptPage, () => ({
    items: [],
    requests: [],
    hasMoreBefore: false,
    hasMoreAfter: false,
  }))
  ipcMain.handle(GJC_IPC.getTranscriptChanges, () => ({ kind: 'patch', items: [] }))
  ipcMain.handle(GJC_IPC.getTranscriptRevision, () => undefined)
  ipcMain.handle(GJC_IPC.listQueuedMessages, () => [])
  ipcMain.handle(GJC_IPC.getGoal, () => ({ enabled: false, completed: 0, total: 0 }))
  ipcMain.handle(GJC_IPC.listSubagents, () => [])
  ipcMain.handle(GJC_IPC.getGitStatus, () => ({
    workspace: session.workspace,
    branch: 'main',
    ahead: 0,
    behind: 0,
    files: [],
  }))
  ipcMain.handle(SETTINGS_IPC.getPreferences, () => ({
    workspace: session.workspace,
    workspaceLabel: 'Remote smoke',
    modelPreset: 'codex-medium',
    permissionHandling: 'prompt',
    gjcExecutable: '',
  }))
  ipcMain.handle(SETTINGS_IPC.checkGjcUpdate, () => ({
    currentVersion: '0.1.0-smoke',
    latestVersion: '0.1.0-smoke',
    updateAvailable: false,
  }))
  ipcMain.handle(SETTINGS_IPC.savePreferences, (_event, preferences) => ({
    preferences,
    runtimeReconnected: false,
  }))

  const window = new BrowserWindow({
    width: 1280,
    height: 900,
    show: false,
    webPreferences: {
      preload: path.join(appPath, 'dist-electron/electron/preload.cjs'),
      contextIsolation: true,
      sandbox: true,
    },
  })
  await window.loadFile(path.join(appPath, 'dist/index.html'))
  await new Promise((resolve) => setTimeout(resolve, 2_000))

  // The desktop drives the real bridge, exactly as the settings panel does.
  const enabled = await window.webContents.executeJavaScript(
    'window.agentControlDesktop.remote.setEnabled(true)',
  )
  require_(enabled.enabled === true, 'Remote access did not turn on')
  require_(enabled.running === true, `Remote server is not listening: ${JSON.stringify(enabled.error ?? '')}`)
  require_(enabled.tailscale?.installed === false, 'Smoke expected Tailscale to be reported as missing')

  const origin = `http://127.0.0.1:${enabled.port}`
  const shell = await request(`${origin}/`)
  require_(shell.status === 200, `Web client was not served (${shell.status})`)
  require_(
    String(shell.body).includes('gajae'),
    'Served web client is not the Gajae remote client',
  )
  const unauthenticated = await request(`${origin}/api/state`)
  require_(unauthenticated.status === 401, 'Session data was served without a device token')

  const pairing = await window.webContents.executeJavaScript(
    'window.agentControlDesktop.remote.issuePairingCode("control")',
  )
  const code = pairing.pairing?.code
  require_(typeof code === 'string' && code.length === 8, 'No pairing code was issued')
  const pairingUrl = `${origin}/#pair=${code}`
  require_(!pairingUrl.includes('token'), 'Pairing URL carried a token')

  const paired = await request(`${origin}/api/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ code, deviceName: 'Smoke iPhone' }),
  })
  require_(paired.status === 200, `Pairing failed (${paired.status})`)
  const token = paired.body?.token
  require_(typeof token === 'string', 'Pairing returned no device token')

  const authorized = await request(`${origin}/api/state`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  require_(authorized.status === 200, `Paired device could not read state (${authorized.status})`)
  require_(authorized.body?.sessions?.[0]?.id === session.id, 'Paired device saw the wrong sessions')
  require_(
    String(JSON.stringify(authorized.body)).includes(token) === false,
    'The server echoed the device token back',
  )

  // Render the served web client, not the desktop shell. Chromium cannot emulate
  // Safari's focus zoom, so pin its 16px prevention threshold as well as geometry.
  const mobileWindow = new BrowserWindow({
    width: 390,
    height: 844,
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true },
  })
  await mobileWindow.loadURL(origin)
  await mobileWindow.webContents.executeJavaScript(`(async () => {
    for (let i = 0; i < 100; i++) {
      if (document.body.innerText.includes('데스크톱에서 페어링 코드를 발급해 연결해 주세요.')) return;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    throw Error('Initial remote admission did not settle');
  })()`)
  await mobileWindow.webContents.executeJavaScript(
    `localStorage.setItem('gajae.remote.token', ${JSON.stringify(token)})`,
  )
  await mobileWindow.loadURL(origin)
  const mobileLayouts = []
  for (const [width, height] of [[320, 568], [390, 844], [390, 360], [430, 420]]) {
    mobileWindow.setContentSize(width, height)
    const layout = await mobileWindow.webContents.executeJavaScript(`(async () => {
      for (let i = 0; i < 100; i++) {
        if (document.querySelector('.composer textarea')) break;
        document.querySelector('.session-row')?.click();
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      const input = document.querySelector('.composer textarea');
      if (!input) throw Error('Mobile remote composer did not render: ' + document.body.innerText);
      input.focus();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const button = document.querySelector('.composer-submit-actions button');
      const bounds = button?.getBoundingClientRect();
      return {
        width: innerWidth,
        height: innerHeight,
        fontSize: parseFloat(getComputedStyle(input).fontSize),
        focused: document.activeElement === input,
        buttonVisible: Boolean(bounds && bounds.width > 0 && bounds.left >= 0 &&
          bounds.right <= innerWidth && bounds.top >= 0 && bounds.bottom <= innerHeight),
        noPageOverflow: document.documentElement.scrollWidth <= innerWidth,
      };
    })()`)
    mobileLayouts.push(layout)
    require_(layout.fontSize >= 16, `Mobile input triggers Safari focus zoom at ${width}x${height}`)
    require_(layout.focused, `Mobile composer did not focus at ${width}x${height}`)
    require_(layout.buttonVisible, `Mobile submit button is clipped at ${width}x${height}`)
    require_(layout.noPageOverflow, `Mobile page overflows horizontally at ${width}x${height}`)
  }
  mobileWindow.destroy()

  const crossOrigin = await request(`${origin}/api/sessions/${session.id}/cancel`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Origin: 'https://evil.example',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ operationId: 'op-smoke-crossorigin' }),
  })
  require_(crossOrigin.status === 403, 'A cross-origin write was not refused')

  const upgraded = await window.webContents.executeJavaScript(
    `window.agentControlDesktop.remote.setDevicePermission(${JSON.stringify(paired.body.deviceId)}, "view")`,
  )
  const viewOnly = upgraded.devices.find((device) => device.id === paired.body.deviceId)
  require_(viewOnly?.permission === 'view', 'Permission change was not recorded')

  const refused = await request(`${origin}/api/sessions/${session.id}/cancel`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Origin: origin,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ operationId: 'op-smoke-viewonly' }),
  })
  require_(refused.status === 403, `A view-only device could still control the host (${refused.status})`)

  const pairingPanel = await window.webContents.executeJavaScript(`(async () => {
    const until = async predicate => {
      for (let i = 0; i < 100; i++) {
        const value = predicate();
        if (value) return value;
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      throw Error('Remote settings condition timed out');
    };
    const settingsButton = Array.from(document.querySelectorAll('.sidebar-footer button')).find(
      (button) => /설정|Settings/.test(button.textContent ?? ''),
    )
    settingsButton?.click()
    const tab = await until(() => Array.from(document.querySelectorAll('.settings-dialog nav button')).find(
      (button) => /원격 접속|Remote access/i.test(button.textContent ?? ''),
    ))
    tab?.click()
    await until(() => document.querySelector('.remote-panel')?.textContent?.includes('Smoke iPhone'))
    const body = document.querySelector('.settings-content')?.textContent ?? ''
    const panel = document.querySelector('.remote-panel')
    const toggle = panel?.querySelector('[role="switch"]')
    return {
      dialogOpen: Boolean(document.querySelector('.settings-dialog')),
      tabFound: Boolean(tab),
      panelMounted: Boolean(document.querySelector('.remote-panel')),
      mentionsTailscale: body.includes('Tailscale'),
      listsDevice: body.includes('Smoke iPhone'),
      showsPermission: /보기 전용|View only|View-only/i.test(body),
      noHorizontalOverflow: Boolean(panel && panel.scrollWidth <= panel.clientWidth + 1),
      switchLabelFits: Boolean(toggle && toggle.scrollWidth <= toggle.clientWidth + 1),
      hasAccessibleSwitch: Boolean(toggle?.getAttribute('aria-labelledby')),
      noUnrelatedSaveFooter: !document.querySelector('.settings-footer'),
    }
  })()`)
  require_(pairingPanel.dialogOpen, 'Settings dialog did not open')
  require_(pairingPanel.tabFound, 'Remote access tab is missing from settings')
  require_(pairingPanel.panelMounted, 'Remote access panel did not render')
  require_(pairingPanel.mentionsTailscale, 'Panel did not report Tailscale state')
  require_(pairingPanel.listsDevice, 'Panel did not list the paired device')
  require_(pairingPanel.showsPermission, 'Panel did not show the device permission')
  require_(pairingPanel.noHorizontalOverflow, 'Remote panel overflows horizontally')
  require_(pairingPanel.switchLabelFits, 'Remote switch label is clipped')
  require_(pairingPanel.hasAccessibleSwitch, 'Remote enabled switch is not labelled')
  require_(pairingPanel.noUnrelatedSaveFooter, 'Remote settings shows an unrelated Save footer')

  const revoked = await window.webContents.executeJavaScript(
    `window.agentControlDesktop.remote.revokeDevice(${JSON.stringify(paired.body.deviceId)})`,
  )
  require_(revoked.devices.length === 0, 'Revoked device is still listed')
  const afterRevoke = await request(`${origin}/api/state`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  require_(afterRevoke.status === 401, 'A revoked device could still read session data')

  const disabled = await window.webContents.executeJavaScript(
    'window.agentControlDesktop.remote.setEnabled(false)',
  )
  require_(disabled.running === false, 'Disabling remote access left the server running')
  let reachesAfterDisable = true
  try {
    await fetch(`${origin}/api/state`)
  } catch {
    reachesAfterDisable = false
  }
  require_(!reachesAfterDisable, 'Remote server still answers after being turned off')

  unregisterRemote()
  await service.dispose()

  const report = {
    enabled: enabled.enabled,
    port: enabled.port,
    tailscaleInstalled: enabled.tailscale?.installed ?? null,
    servedWebClient: shell.status === 200,
    unauthenticatedStatus: unauthenticated.status,
    pairingCodeIssued: typeof code === 'string',
    authenticatedStatus: authorized.status,
    mobileLayouts,
    crossOriginStatus: crossOrigin.status,
    viewOnlyStatus: refused.status,
    panel: pairingPanel,
    revokedStatus: afterRevoke.status,
    disabledRunning: disabled.running,
    reachesAfterDisable,
  }
  console.log(JSON.stringify(report, null, 2))
  if (failures.length > 0) {
    for (const failure of failures) console.error(`FAIL: ${failure}`)
    return 1
  }
  console.log('Remote access smoke passed')
  return 0
}

app.whenReady().then(async () => {
  const timeout = setTimeout(() => {
    console.error('Remote access smoke timed out')
    app.exit(1)
  }, 60_000)
  try {
    const code = await main()
    clearTimeout(timeout)
    rmSync(userData, { recursive: true, force: true })
    app.exit(code)
  } catch (error) {
    clearTimeout(timeout)
    console.error('Remote access smoke failed to run', error)
    app.exit(1)
  }
})
