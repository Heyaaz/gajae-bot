/**
 * Drives the built app against a real GJC runtime and records evidence per journey.
 *
 * Unlike the other smoke scripts nothing here is mocked except two things a script cannot
 * do for a person: the interactive `screencapture` region picker and the native
 * confirmation dialog. Everything else is the app's own path: real window, real preload
 * bridge, real GJC child processes, real git, real Tray and Dock badge.
 *
 *   LIVE_ROOT=<fresh dir> LIVE_AGENT_DIR=<isolated GJC agent dir> LIVE_PRESET=<profile> \
 *   LIVE_PRESET_B=<second profile> LIVE_PHASE=1 node scripts/live-journeys.cjs
 *   ... LIVE_PHASE=2 (relaunch against the same LIVE_ROOT) proves resuming a past session.
 *
 * Under Node it launches `electron .` with this file loaded into the main process through
 * NODE_OPTIONS, then prints one `LIVE_JOURNEYS ` report line. Evidence JSON and screenshots
 * land in $LIVE_ROOT/evidence.
 */
const { spawn, execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')


if (!process.versions.electron) launch()
else setImmediate(drive)

function launch() {
  const appPath = path.resolve(__dirname, '..')
  const root = process.env.LIVE_ROOT
  const agentDir = process.env.LIVE_AGENT_DIR
  if (!root || !path.isAbsolute(root) || !agentDir || !path.isAbsolute(agentDir))
    throw new Error('LIVE_ROOT and LIVE_AGENT_DIR must be absolute paths')
  const userData = path.join(root, 'user-data')
  const workspace = path.join(root, 'workspace')
  fs.mkdirSync(path.join(root, 'evidence'), { recursive: true })
  fs.mkdirSync(userData, { recursive: true })
  if (!fs.existsSync(path.join(workspace, '.git'))) {
    fs.mkdirSync(workspace, { recursive: true })
    const git = (...args) =>
      execFileSync('git', ['-C', workspace, '-c', 'user.email=live@example.invalid', '-c', 'user.name=Live', ...args])
    git('init', '-q', '-b', 'main')
    fs.writeFileSync(path.join(workspace, 'README.md'), '# live journey workspace\n')
    git('add', '-A')
    git('commit', '-qm', 'init')
  }
  fs.writeFileSync(path.join(userData, 'agent-control-desktop-state.json'), JSON.stringify({ environmentReady: true }))
  // The remote service shells out to `tailscale` by name. A stub first on PATH keeps the
  // journey from ever reading or rewriting the owner's real Tailscale Serve mapping.
  const fakeBin = path.join(root, 'fake-bin')
  fs.mkdirSync(fakeBin, { recursive: true })
  fs.writeFileSync(path.join(fakeBin, 'tailscale'), '#!/bin/sh\necho "tailscale is not installed (live-journeys stub)" >&2\nexit 127\n', { mode: 0o755 })
  const electron = require(path.join(appPath, 'node_modules/electron'))
  const child = spawn(electron, ['.'], {
    cwd: appPath,
    stdio: ['ignore', 'ignore', fs.openSync(path.join(root, 'evidence', 'app-stderr.log'), 'a')],
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      NODE_OPTIONS: `--require ${__filename}`,
      GAJAE_USER_DATA_DIR: userData,
      GJC_CODING_AGENT_DIR: agentDir,
      GJC_BIN: process.env.GJC_BIN || path.join(process.env.HOME, '.local/bin/gjc'),
      AGENT_CONTROL_WORKSPACE: workspace,
      AGENT_CONTROL_GJC_PRESET: process.env.LIVE_PRESET,
      LIVE_WORKSPACE: workspace,
    },
  })
  const timer = setTimeout(() => child.kill('SIGTERM'), Number(process.env.LIVE_TIMEOUT_MS || 900_000))
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { child.kill('SIGTERM'); process.exit(1) })
  process.stdout.on('error', () => {})
  child.on('exit', () => {
    clearTimeout(timer)
    const file = path.join(root, 'evidence', `final-phase${process.env.LIVE_PHASE || '1'}.json`)
    const report = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : JSON.stringify({ error: 'no report' })
    process.stdout.write(report + '\n')
    process.exit(fs.existsSync(file) ? 0 : 1)
  })
}

function drive() {
  const childProcess = require('node:child_process')
  const { syncBuiltinESMExports } = require('node:module')
  const { app, BrowserWindow, Tray, dialog, globalShortcut, nativeImage } = require('electron')
  const root = process.env.LIVE_ROOT
  const evidence = path.join(root, 'evidence')
  const workspace = process.env.LIVE_WORKSPACE
  const phase = process.env.LIVE_PHASE || '1'
  const presetA = process.env.LIVE_PRESET
  const presetB = process.env.LIVE_PRESET_B
  const only = process.env.LIVE_ONLY ? process.env.LIVE_ONLY.split(',') : undefined
  process.stdout.on('error', () => {})
  process.stderr.on('error', () => {})
  const log = (...parts) => { try { fs.appendFileSync(path.join(evidence, 'driver.log'), parts.join(' ') + '\n') } catch {} }
  process.on('uncaughtException', (error) => { log('uncaught', String(error?.stack ?? error)); results.driver = { verdict: 'failed', error: String(error) }; try { fs.writeFileSync(path.join(evidence, `final-phase${phase}.json`), JSON.stringify({ phase, results })) } catch {}; app.exit(1) })
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const save = (name, value) => fs.writeFileSync(path.join(evidence, name), JSON.stringify(value, null, 2))
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()

  let liveTray
  let liveMenu
  const setContextMenu = Tray.prototype.setContextMenu
  Tray.prototype.setContextMenu = function (menu) {
    liveTray = this
    liveMenu = menu
    return setContextMenu.call(this, menu)
  }

  const execFile = childProcess.execFile
  let screencaptureFixture
  const screencaptureCalls = []
  childProcess.execFile = function (file, args, ...rest) {
    if (file !== '/usr/sbin/screencapture' || !screencaptureFixture) return execFile.call(this, file, args, ...rest)
    screencaptureCalls.push(args)
    fs.copyFileSync(screencaptureFixture, args.at(-1))
    const callback = rest.find((value) => typeof value === 'function')
    setTimeout(() => callback?.(null, '', ''), 50)
    return { stdin: { end() {} } }
  }
  syncBuiltinESMExports()

  const confirmations = []
  let confirmAnswer = 0 // 0 is Cancel, 1 is Continue in the native dialog
  const showMessageBox = dialog.showMessageBox.bind(dialog)
  dialog.showMessageBox = async (...args) => {
    const options = args.at(-1)
    confirmations.push({ message: options.message, detail: options.detail, buttons: options.buttons })
    return { response: confirmAnswer, checkboxChecked: false }
  }
  void showMessageBox

  const handlers = new Map()
  const registerShortcut = globalShortcut.register.bind(globalShortcut)
  globalShortcut.register = (keys, callback) => {
    handlers.set(keys, callback)
    return registerShortcut(keys, callback)
  }
  const sent = []
  app.on('web-contents-created', (_event, contents) => {
    const send = contents.send.bind(contents)
    contents.send = (channel, ...args) => {
      sent.push({ to: contents.id, channel, args })
      return send(channel, ...args)
    }
  })

  const isQuick = (window) => window.webContents.getURL().includes('window=quick-input')
  const quickWindow = () => BrowserWindow.getAllWindows().find(isQuick)
  const mainWindow = () => BrowserWindow.getAllWindows().find((window) => !isQuick(window))
  const rc = (expression) => mainWindow().webContents.executeJavaScript(expression)
  const gjc = (expression) => rc(`window.agentControlDesktop.gjc.${expression}`)
  const sessions = () => gjc('listSessions()')
  const sessionOf = async (id) => (await sessions()).find((session) => session.id === id)

  async function until(condition, message, timeout = 30_000, interval = 250) {
    const deadline = Date.now() + timeout
    for (;;) {
      const value = await condition()
      if (value) return value
      if (Date.now() > deadline) throw new Error(`Timed out: ${message}`)
      await wait(interval)
    }
  }

  const statusSurface = () => {
    const shown = liveTray && !liveTray.isDestroyed()
    return {
      badge: app.dock.getBadge(),
      tray: shown ? liveTray.getTitle() : '(hidden)',
      menu: shown ? liveMenu.items.map((item) => (item.type === 'separator' ? '---' : item.label)) : [],
    }
  }
  const surfaceTimeline = []
  let lastSurface = ''
  const sampleSurface = () => {
    const surface = statusSurface()
    const key = JSON.stringify(surface)
    if (key !== lastSurface) {
      lastSurface = key
      surfaceTimeline.push({ at: new Date().toISOString(), ...surface })
    }
  }

  const textMessage = (text) => ({ text, images: [], files: [] })
  const assistantTexts = (items) =>
    items.filter((item) => item.kind === 'message' && item.role === 'assistant').map((item) => item.content)
  const transcript = (id) => gjc(`getTranscript(${JSON.stringify(id)})`)

  async function createSession(title, extra = {}) {
    return gjc(
      `createSession(${JSON.stringify({ runtime: 'gjc', workspace, isolation: 'workspace', title, ...extra })})`,
    )
  }
  const send = (id, text) => gjc(`sendMessage(${JSON.stringify(id)}, ${JSON.stringify(textMessage(text))})`)
  async function settle(id, message, timeout = 150_000) {
    await until(async () => (await sessionOf(id))?.status === 'running', `${message}: running`, 60_000, 150).catch(() => {})
    return until(async () => {
      const session = await sessionOf(id)
      return session && session.status !== 'running' && session.status !== 'starting' ? session : undefined
    }, `${message}: finished`, timeout, 500)
  }

  const results = {}
  async function journey(id, run) {
    if (only && !only.includes(id)) return
    const started = Date.now()
    const partial = {}
    try {
      await run(partial)
      results[id] = { verdict: 'verified', ms: Date.now() - started, evidence: partial }
    } catch (error) {
      results[id] = { verdict: 'failed', ms: Date.now() - started, evidence: partial, error: String(error?.stack ?? error).split('\n').slice(0, 4).join(' | ') }
    }
    save(`${id}.json`, results[id])
    log(`journey ${id}: ${results[id].verdict}${results[id].error ? ` ${results[id].error}` : ''}`)
  }
  const assert = (condition, message) => {
    if (!condition) throw new Error(message)
  }
  const shot = async (name) => {
    const image = await mainWindow().webContents.capturePage()
    fs.writeFileSync(path.join(evidence, name), image.toPNG())
  }

  app.whenReady().then(async () => {
    const hardStop = setTimeout(() => finish(), Number(process.env.LIVE_TIMEOUT_MS || 900_000) - 30_000)
    let finished = false
    const finish = () => {
      if (finished) return
      finished = true
      clearTimeout(hardStop)
      clearInterval(sampler)
      save(`report-phase${phase}.json`, { results, surfaceTimeline })
      fs.writeFileSync(path.join(evidence, `final-phase${phase}.json`), JSON.stringify({ phase, results: Object.fromEntries(Object.entries(results).map(([key, value]) => [key, value.verdict])) }))
      setTimeout(() => app.exit(0), 500)
    }
    const sampler = setInterval(sampleSurface, 250)
    try {
      const main = await until(() => {
        const window = mainWindow()
        return window && !window.webContents.isLoading() && window.webContents.getURL() ? window : undefined
      }, 'main window loaded', 30_000)
      await until(() => main.webContents.executeJavaScript('Boolean(document.querySelector(".app-shell"))'), 'shell mounted', 30_000)
      const connection = await gjc('getConnection()')
      save('connection.json', connection)
      log('connection', JSON.stringify(connection))
      const prior = phase === '1' ? {} : JSON.parse(fs.readFileSync(path.join(evidence, 'j1.json'), 'utf8'))

      if (phase === '1') {
        await journey('j1', async (ev) => {
          const created = await createSession('live-179-j1')
          ev.created = { id: created.id, workspace: created.workspace, status: created.status, model: created.model ?? created.modelDisplay }
          const files = () => execFileSync('grep', ['-RlF', created.id, path.join(process.env.GJC_CODING_AGENT_DIR, 'sessions')]).toString().trim().split('\n').filter(Boolean)
          ev.sessionFileUnderIsolatedAgent = files()
          await send(created.id, 'Reply with exactly: OK')
          const done = await settle(created.id, 'first turn')
          const items = await transcript(created.id)
          ev.afterFirstTurn = { status: done.status, assistant: assistantTexts(items) }
          assert(assistantTexts(items).some((text) => /OK/.test(text)), 'no assistant OK reply in the transcript')
          await shot('j1-after-send.png')

          await send(created.id, 'Write the integers from 1 to 4000, one per line, with no other text.')
          await until(async () => (await sessionOf(created.id))?.status === 'running', 'long turn running', 60_000, 150)
          await until(async () => assistantTexts(await transcript(created.id)).some((text) => text.length > 40), 'streamed output before abort', 90_000, 300)
          ev.beforeAbort = { status: (await sessionOf(created.id)).status }
          await gjc(`cancelRun(${JSON.stringify(created.id)})`)
          const aborted = await settle(created.id, 'abort', 60_000)
          const afterAbort = await transcript(created.id)
          const lastAssistant = assistantTexts(afterAbort).at(-1) ?? ''
          ev.afterAbort = { status: aborted.status, lastAssistantLength: lastAssistant.length, lastAssistantTail: lastAssistant.slice(-30), notFinished: !/4000\s*$/.test(lastAssistant.trim()) }
          assert(aborted.status === 'idle', `status after abort was ${aborted.status}`)
          assert(ev.afterAbort.notFinished, 'the run completed instead of aborting')
          await send(created.id, 'Reply with exactly: AFTER')
          const again = await settle(created.id, 'turn after abort')
          const finalItems = await transcript(created.id)
          ev.afterAbortReuse = { status: again.status, assistantTail: assistantTexts(finalItems).at(-1)?.slice(0, 60) }
          assert(/AFTER/.test(assistantTexts(finalItems).at(-1) ?? ''), 'the session did not answer after an abort')
          await shot('j1-after-abort.png')
        })

        await journey('j3', async (ev) => {
          const branch = 'live-179/worktree-journey'
          const created = await createSession('live-179-j3', { isolation: 'worktree', worktreeBranch: branch })
          ev.created = { id: created.id, workspace: created.workspace, status: created.status }
          assert(created.workspace !== workspace, 'the session workspace is the original checkout, not a worktree')
          ev.gitWorktreeList = git(workspace, 'worktree', 'list', '--porcelain')
          ev.branchHead = git(created.workspace, 'rev-parse', '--abbrev-ref', 'HEAD')
          assert(ev.branchHead === branch, `worktree HEAD is ${ev.branchHead}`)
          assert(ev.gitWorktreeList.includes(created.workspace), 'git does not list the worktree')
          await send(created.id, 'Reply with exactly: WT')
          const done = await settle(created.id, 'worktree turn')
          ev.afterTurn = { status: done.status, assistant: assistantTexts(await transcript(created.id)).at(-1)?.slice(0, 60) }
          assert(/WT/.test(ev.afterTurn.assistant ?? ''), 'no reply from the worktree session')
          ev.mainCheckoutBranch = git(workspace, 'rev-parse', '--abbrev-ref', 'HEAD')
        })

        await journey('j5', async (ev) => {
          const other = await createSession('live-179-j5-viewed')
          await rc(`window.agentControlDesktop.settings.setViewedSession(${JSON.stringify(other.id)})`)
          const created = await createSession('live-179-j5')
          ev.sessionId = created.id
          sampleSurface()
          ev.beforeRun = statusSurface()
          await send(created.id, 'Write the integers from 1 to 600, one per line, with no other text.')
          await until(async () => (await sessionOf(created.id))?.status === 'running', 'running', 60_000, 100)
          await wait(600)
          sampleSurface()
          ev.whileRunning = { ...statusSurface(), session: (await sessionOf(created.id)).status }
          const done = await settle(created.id, 'badge turn')
          await wait(1500)
          sampleSurface()
          ev.afterFinish = { ...statusSurface(), status: done.status, unread: (await sessionOf(created.id)).unread, viewedElsewhere: other.id }
          ev.timeline = surfaceTimeline.slice()
          await shot('j5-after-finish.png')
          await gjc(`markSessionRead(${JSON.stringify(created.id)})`)
          await rc(`window.agentControlDesktop.settings.setViewedSession(${JSON.stringify(created.id)})`)
          await wait(1500)
          sampleSurface()
          ev.afterRead = statusSurface()
          assert(ev.whileRunning.tray !== ev.beforeRun.tray || ev.whileRunning.badge !== ev.beforeRun.badge || ev.whileRunning.menu.join() !== ev.beforeRun.menu.join(), 'the status surface did not change while a real session ran')
          assert(ev.afterFinish.unread === true, 'the finished session was not unread')
          assert(ev.afterFinish.badge !== '' && ev.afterFinish.badge !== ev.beforeRun.badge, `no badge after an unread finish: ${JSON.stringify(ev.afterFinish.badge)}`)
          assert(ev.afterRead.badge === '' || ev.afterRead.badge === ev.beforeRun.badge, `badge not cleared after read: ${JSON.stringify(ev.afterRead.badge)}`)
        })

        await journey('j4', async (ev) => {
          await rc('window.agentControlDesktop.remote.setPort(48791)')
          const enabled = await rc('window.agentControlDesktop.remote.setEnabled(true)')
          ev.enabled = { enabled: enabled.enabled, running: enabled.running, port: enabled.port, error: enabled.error, tailscale: enabled.tailscale }
          assert(enabled.tailscale?.installed === false, 'the Tailscale stub is not in effect; refusing to touch the real Serve mapping')
          assert(enabled.running === true, `remote server not listening: ${JSON.stringify(enabled.error)}`)
          const origin = `http://127.0.0.1:${enabled.port}`
          const call = async (url, init = {}) => {
            const response = await fetch(origin + url, { ...init, headers: { 'Content-Type': 'application/json', Origin: origin, ...(init.headers ?? {}) } })
            const text = await response.text()
            let body
            try { body = JSON.parse(text) } catch { body = text }
            return { status: response.status, body }
          }
          ev.shellServed = (await call('/')).status
          ev.unauthenticated = (await call('/api/state')).status
          const pair = async (permission, name) => {
            const state = await rc(`window.agentControlDesktop.remote.issuePairingCode(${JSON.stringify(permission)})`)
            const code = state.pairing?.code
            assert(typeof code === 'string' && code.length === 8, 'no pairing code')
            const paired = await call('/api/pair', { method: 'POST', body: JSON.stringify({ code, deviceName: name }) })
            assert(paired.status === 200 && paired.body.token, `pairing failed ${paired.status}`)
            return paired.body.token
          }
          const viewToken = await pair('view', 'live view device')
          const authed = (token) => ({ headers: { Authorization: `Bearer ${token}` } })
          const state = await call('/api/state', authed(viewToken))
          const hostSessions = await sessions()
          ev.viewState = { status: state.status, sessionIds: (state.body.sessions ?? []).map((s) => s.id).sort(), hostIds: hostSessions.map((s) => s.id).sort() }
          assert(state.status === 200 && ev.viewState.sessionIds.join() === ev.viewState.hostIds.join(), 'a paired device did not see the host sessions')
          const target = hostSessions.find((s) => s.title === 'live-179-j1')
          const page = await call(`/api/sessions/${target.id}/transcript`, authed(viewToken))
          ev.viewTranscript = { status: page.status, items: Array.isArray(page.body.result ?? page.body) ? (page.body.result ?? page.body).length : 'n/a' }
          const denied = await call(`/api/sessions/${target.id}/messages`, { method: 'POST', ...authed(viewToken), body: JSON.stringify({ operationId: 'op-view-denied-0001', input: { text: 'Reply with exactly: NOPE', images: [], files: [] } }) })
          ev.viewSendDenied = { status: denied.status, body: denied.body }
          assert(denied.status === 403, `a view device was not refused (${denied.status})`)
          const controlToken = await pair('control', 'live control device')
          const sentRemote = await call(`/api/sessions/${target.id}/messages`, { method: 'POST', ...authed(controlToken), body: JSON.stringify({ operationId: 'op-control-send-0001', input: { text: 'Reply with exactly: REMOTE', images: [], files: [] } }) })
          ev.controlSend = { status: sentRemote.status, state: sentRemote.body?.state }
          assert(sentRemote.status === 200 && sentRemote.body.state === 'completed', `control send failed ${JSON.stringify(sentRemote.body)}`)
          await settle(target.id, 'remote turn')
          ev.remoteReply = assistantTexts(await transcript(target.id)).at(-1)?.slice(0, 40)
          assert(/REMOTE/.test(ev.remoteReply ?? ''), 'the host session did not answer the remote message')
          const devices = (await rc('window.agentControlDesktop.remote.getState()')).devices
          ev.devices = devices.map((d) => ({ id: d.id, name: d.name, permission: d.permission }))
          const control = devices.findLast((d) => d.name === 'live control device')
          await rc(`window.agentControlDesktop.remote.revokeDevice(${JSON.stringify(control.id)})`)
          ev.afterRevoke = (await call('/api/state', authed(controlToken))).status
          assert(ev.afterRevoke === 401, `a revoked device still read state (${ev.afterRevoke})`)
          await rc('window.agentControlDesktop.remote.setEnabled(false)')
        })

        await journey('j6', async (ev) => {
          const tag = String(Date.now())
          const repo = path.join(root, `bon-repo-${tag}`)
          if (!fs.existsSync(path.join(repo, '.git'))) {
            fs.mkdirSync(repo, { recursive: true })
            const bon = (...args) => git(repo, '-c', 'user.email=live@example.invalid', '-c', 'user.name=Live', ...args)
            bon('init', '-q', '-b', 'main')
            fs.writeFileSync(path.join(repo, 'README.md'), '# best of n\n')
            bon('add', '-A')
            bon('commit', '-qm', 'init')
          }
          const start = await rc(`window.agentControlDesktop.parallel.start(${JSON.stringify({ title: 'live-179-bon', workspace: repo, prompt: 'Reply with exactly: DONE', branch: `bon-${tag}`, presets: [presetA, presetB] })})`)
          ev.started = { id: start.id, state: start.state.kind, attempts: start.attempts.map((a) => ({ id: a.id, preset: a.preset, branch: a.branch, state: a.state.kind })) }
          let group = await until(async () => {
            const list = await rc('window.agentControlDesktop.parallel.list()')
            const found = list.find((g) => g.id === start.id)
            return found && found.state.kind === 'comparing' ? found : undefined
          }, 'group comparing', 240_000, 1000)
          ev.compared = group.attempts.map((a) => ({ id: a.id, preset: a.preset, branch: a.branch, state: a.state.kind, worktreePath: a.state.worktreePath, sessionId: a.state.sessionId }))
          assert(group.attempts.every((a) => a.state.kind === 'started'), 'not every attempt started')
          assert(new Set(group.attempts.map((a) => a.state.worktreePath)).size === group.attempts.length, 'attempts share a worktree')
          assert(new Set(group.attempts.map((a) => a.branch)).size === group.attempts.length, 'attempts share a branch')
          ev.gitWorktreeList = git(repo, 'worktree', 'list', '--porcelain')
          ev.branches = git(repo, 'branch', '--list').split('\n').map((line) => line.trim())
          ev.perAttemptHead = group.attempts.map((a) => git(a.state.worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD'))
          assert(group.attempts.every((a, i) => ev.perAttemptHead[i] === a.branch), 'an attempt worktree is on the wrong branch')
          const all = await sessions()
          ev.sessionModels = group.attempts.map((a) => {
            const session = all.find((s) => s.id === a.state.sessionId)
            return { preset: a.preset, model: session?.model, modelDisplay: session?.modelDisplay, thinking: session?.thinking, workspace: session?.workspace }
          })
          const presetProfile = (name) => name
          ev.presetLookup = group.attempts.map((a) => presetProfile(a.preset))
          ev.replies = []
          for (const a of group.attempts) ev.replies.push(assistantTexts(await transcript(a.state.sessionId)).at(-1)?.slice(0, 40))
          const keep = group.attempts[0]
          const drop = group.attempts[1]
          confirmations.length = 0
          confirmAnswer = 0
          const cancelledAdopt = await rc(`window.agentControlDesktop.parallel.adopt(${JSON.stringify(group.id)}, ${JSON.stringify(keep.id)})`)
          ev.adopted = { state: cancelledAdopt.state.kind, attemptId: cancelledAdopt.state.attemptId, wanted: keep.id }
          assert(cancelledAdopt.state.kind === 'adopted' && cancelledAdopt.state.attemptId === keep.id, 'adopt did not record the choice')
          assert(fs.existsSync(drop.state.worktreePath), 'adopt alone removed another attempt worktree')
          ev.afterAdoptOthersStillThere = { worktreeExists: fs.existsSync(drop.state.worktreePath), branchExists: git(repo, 'branch', '--list', drop.branch) !== '' }
          const refused = await rc(`window.agentControlDesktop.parallel.cleanup(${JSON.stringify(group.id)}).then(() => 'removed', (error) => String(error.message))`)
          ev.cleanupCancelled = { result: refused, confirmations: confirmations.slice(), worktreeStillThere: fs.existsSync(drop.state.worktreePath) }
          assert(refused !== 'removed' && fs.existsSync(drop.state.worktreePath), 'cleanup removed things after the user cancelled the confirmation')
          confirmAnswer = 1
          confirmations.length = 0
          const cleaned = await rc(`window.agentControlDesktop.parallel.cleanup(${JSON.stringify(group.id)})`)
          ev.cleanupConfirmed = { confirmations: confirmations.slice(), attempts: cleaned.attempts.map((a) => ({ id: a.id, state: a.state.kind })), droppedWorktreeExists: fs.existsSync(drop.state.worktreePath), keptWorktreeExists: fs.existsSync(keep.state.worktreePath), droppedBranchExists: git(repo, 'branch', '--list', drop.branch) !== '', keptBranchExists: git(repo, 'branch', '--list', keep.branch) !== '' }
          assert(!ev.cleanupConfirmed.droppedWorktreeExists && !ev.cleanupConfirmed.droppedBranchExists, 'the undecided attempt was not removed')
          assert(ev.cleanupConfirmed.keptWorktreeExists && ev.cleanupConfirmed.keptBranchExists, 'the adopted attempt was removed')
          assert(confirmations.length === 1, 'cleanup did not ask for confirmation once')
        })

        await journey('j7', async (ev) => {
          const png = path.join(root, 'retina.png')
          const width = 5120
          const height = 2880
          const pixels = Buffer.alloc(width * height * 4)
          let seed = 12345
          for (let offset = 0; offset < pixels.length; offset += 4) {
            seed = (seed * 1664525 + 1013904223) >>> 0
            pixels[offset] = seed & 255
            pixels[offset + 1] = (seed >>> 8) & 255
            pixels[offset + 2] = (seed >>> 16) & 255
            pixels[offset + 3] = 255
          }
          fs.writeFileSync(png, nativeImage.createFromBitmap(pixels, { width, height }).toPNG())
          screencaptureFixture = png
          ev.fixture = { width, height, bytes: fs.statSync(png).size, overLimit: fs.statSync(png).size > 10 * 1024 * 1024 }
          assert(ev.fixture.overLimit, 'fixture is not over 10MiB')
          const accelerator = 'Control+Alt+Space'
          const status = await rc('window.agentControlDesktop.settings.quickInputShortcutStatus()')
          ev.shortcutStatus = status
          handlers.get(accelerator)()
          const quick = await until(() => {
            const window = quickWindow()
            return window?.isVisible() && !window.webContents.isLoading() ? window : undefined
          }, 'quick window shown', 15_000)
          ev.quickWindow = { visible: quick.isVisible(), alwaysOnTop: quick.isAlwaysOnTop(), visibleOnAllWorkspaces: quick.isVisibleOnAllWorkspaces() }
          const result = await quick.webContents.executeJavaScript(`
            (async () => {
              const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
              document.querySelector('button[aria-label="화면 캡처 첨부"]').click()
              for (let i = 0; i < 300 && !document.querySelector('.quick-input-captures img') && !document.querySelector('[role="alert"]'); i += 1) await wait(100)
              const img = document.querySelector('.quick-input-captures img')
              return { image: Boolean(img), naturalWidth: img?.naturalWidth, naturalHeight: img?.naturalHeight, alert: document.querySelector('[role="alert"]')?.textContent ?? null }
            })()`)
          ev.afterCapture = result
          assert(result.image, `no capture attached: ${result.alert}`)
          const box = await quick.webContents.executeJavaScript(`(() => { const box = document.querySelector('textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(box, 'live capture'); box.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
          void box
          await wait(200)
          await quick.webContents.executeJavaScript(`document.querySelector('textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))`)
          const handoff = await until(() => sent.find((entry) => entry.to === mainWindow().webContents.id && entry.channel === 'gajae:shortcut:session'), 'hand-off to the main window', 20_000)
          const attached = handoff.args[0].prefill?.images?.[0]
          const attachedBytes = attached ? Buffer.from(attached.data, 'base64') : Buffer.alloc(0)
          const decoded = nativeImage.createFromBuffer(attachedBytes)
          ev.attachment = { name: attached?.name, mimeType: attached?.mimeType, bytes: attachedBytes.length, underLimit: attachedBytes.length > 0 && attachedBytes.length <= 10 * 1024 * 1024, decodedSize: decoded.getSize(), screencaptureArgs: screencaptureCalls.at(-1) }
          assert(ev.attachment.underLimit, `attachment is ${ev.attachment.bytes} bytes`)
          assert(ev.attachment.decodedSize.width < width, 'the capture was not downscaled')
          ev.spaceOverlay = 'not observable by this driver: no second Space or fullscreen app was driven'
        })
      } else {
        await journey('j2', async (ev) => {
          const history = await gjc('listHistorySessions()')
          const target = history.find((item) => item.id === prior.evidence?.created?.id) ?? history.find((item) => item.title === 'live-179-j1')
          assert(target, 'the session from the first launch is not in the history list')
          ev.history = { total: history.length, target: { id: target.id, title: target.title, messageCount: target.messageCount, live: target.live } }
          const live = (await sessions()).find((s) => s.id === target.id)
          ev.listedLiveBeforeOpen = Boolean(live)
          const opened = await gjc(`openHistorySession(${JSON.stringify(target.id)})`)
          ev.opened = { id: opened.id, status: opened.status, attachment: opened.attachment, ownership: opened.ownership }
          const before = await transcript(target.id)
          ev.transcriptBeforeSend = { items: before.length, lastAssistant: assistantTexts(before).at(-1)?.slice(0, 40) }
          assert(before.length > 0, 'the resumed session shows no history')
          await send(target.id, 'What was the exact text I asked you to reply with in my previous message? Answer with that text only.')
          const done = await settle(target.id, 'resumed turn')
          const after = await transcript(target.id)
          ev.afterSend = { status: done.status, attachment: done.attachment, lastAssistant: assistantTexts(after).at(-1)?.slice(0, 80), items: after.length }
          assert(after.length > before.length, 'the resumed session did not take the new turn')
          await shot('j2-resumed.png')
        })
      }
    } catch (error) {
      results.driver = { verdict: 'failed', error: String(error?.stack ?? error) }
    }
    finish()
  })
}
