// Real CLI /new -> broker -> controller -> built React shell, with and without
// the old row selected. All processes, credentials and saved sessions are isolated.
// Run after a build: npx electron scripts/gjc-cli-new-e2e.mjs
import { app, BrowserWindow, ipcMain } from 'electron'
import { execFile as execFileCallback, execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, mkdtemp, realpath, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)
const executable = process.env.GJC_BIN || 'gjc'
const root = await realpath(await mkdtemp(path.join(tmpdir(), 'gajae-cli-new-e2e-')))
const workspace = path.join(root, 'workspace')
const agentDir = path.join(root, 'home', '.gjc', 'agent')
const project = fileURLToPath(new URL('..', import.meta.url))
process.env.HOME = path.join(root, 'home')
process.env.GJC_CODING_AGENT_DIR = agentDir
for (const name of Object.keys(process.env)) if (/^(AGENT_CONTROL_|GAJAE_)/u.test(name)) delete process.env[name]
app.setPath('userData', path.join(root, 'user-data'))
app.on('window-all-closed', () => {})
const { GjcSdkController } = await import('../dist-electron/electron/gjc-sdk-controller.js')
const { spawn: spawnPty } = createRequire(import.meta.url)('node-pty')
const assert = (value, message) => { if (!value) throw new Error(message) }
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const until = async (predicate, message) => {
  const deadline = Date.now() + 40_000
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await wait(200)
  }
  throw new Error(message)
}
const rows = async () => JSON.parse((await execFile(executable,
  ['sdk', 'session', 'list', '--scope', 'all', '--json'], { cwd: workspace, timeout: 15_000 })).stdout).result.sessions
const evidence = row => ({ sessionId: row.sessionId, live: row.live, deleted: row.deleted,
  endpointGeneration: row.endpointGeneration, pid: row.pid })
const terminals = []
const runningTerminals = new Set()
let controller
let win
let finishing = false
const errors = []
const events = []
const timeout = setTimeout(() => { console.error('CLI /new E2E timed out'); void finish(1) }, 150_000)
async function finish(code) {
  if (finishing) return
  finishing = true
  clearTimeout(timeout)
  controller?.dispose()
  win?.destroy()
  for (const terminal of terminals) terminal.kill()
  for (let attempt = 0; attempt < 50 && runningTerminals.size; attempt++) await wait(100)
  // Match this throwaway broker only, not Electron helpers or the user's broker.
  for (let attempt = 0; attempt < 50; attempt++) {
    try { execFileSync('/usr/bin/pkill', ['-f', `broker-internal --agent-dir ${agentDir}`]) } catch { break }
    await wait(100)
  }
  try {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  } catch (error) {
    console.error('Could not clean up isolated CLI fixture', error)
    code = 1
  } finally {
    app.exit(code)
  }
}
async function startTerminal() {
  const lifecycle = async (operation, input) => {
    const response = JSON.parse((await execFile(executable,
      ['sdk', 'session', 'raw', 'global', '--op', operation, '--json-input', JSON.stringify(input),
        '--idempotency-key', randomUUID(), '--json'], { cwd: workspace, timeout: 30_000 })).stdout)
    assert(response.ok === true, JSON.stringify(response))
    return response.result
  }
  const { sessionId } = await lifecycle('session.create', { cwd: workspace })
  await lifecycle('session.close', { sessionId, cwd: workspace })
  const transcript = await transcriptPath(sessionId)
  // A nonempty saved conversation matters: GJC may discard an empty session on
  // /new. Seed one user row while closed; no model request or credentials needed.
  const timestamp = new Date().toISOString()
  await appendFile(transcript, JSON.stringify({ type: 'message', id: 'fixture-user', parentId: null,
    timestamp, message: { role: 'user', content: [{ type: 'text', text: 'Preserve this saved conversation' }],
      timestamp: Date.now() } }) + '\n')
  const terminal = spawnPty(executable, ['--resume', transcript, '--no-mcp', '--no-lsp'], {
    name: 'xterm-256color', cols: 120, rows: 40, cwd: workspace,
    env: { ...process.env, TERM: 'xterm-256color', GJC_AUTOMATION: '1' },
  })
  terminals.push(terminal)
  runningTerminals.add(terminal)
  let screen = ''
  let exit
  terminal.onData(data => { screen = (screen + data).slice(-32_000) })
  terminal.onExit(event => { exit = event; runningTerminals.delete(terminal) })
  try {
    const row = await until(async () => (await rows()).find(row => row.live && row.pid === terminal.pid
      && row.sessionId === sessionId && row.endpointGeneration > 0), 'CLI live route not ready')
    return { terminal, row }
  } catch (error) {
    throw new Error(JSON.stringify({ exit, screen: screen.replace(/\x1b\[[0-9;?]*[A-Za-z]/gu, '').slice(-2000) }), { cause: error })
  }
}
async function switchTerminal(terminal, old) {
  terminal.write('/new')
  await wait(200)
  terminal.write('\r')
  return until(async () => {
    const listed = await rows()
    const previous = listed.find(row => row.sessionId === old.sessionId)
    const next = listed.find(row => row.live && row.pid === terminal.pid && row.sessionId !== old.sessionId)
    return previous?.live === false && next ? { old: evidence(previous), next: evidence(next) } : undefined
  }, 'CLI /new did not retire old row and publish a replacement')
}
const render = source => win.webContents.executeJavaScript(source)
const snapshot = () => render(`({ rows: [...document.querySelectorAll('.session-row strong')].map(row => row.textContent), selected: document.querySelector('.session-row.is-selected strong')?.textContent ?? null })`)
async function select(id) {
  await render(`(() => {
    const row = [...document.querySelectorAll('.session-row')].find(row => row.querySelector('strong')?.textContent === ${JSON.stringify(id)});
    if (!row) throw Error('session row not found');
    row.click();
  })()`)
  await until(async () => (await snapshot()).selected === id, 'selection did not change')
}
async function refresh() {
  const before = await render('window.__discoveryReads')
  await render("window.dispatchEvent(new Event('focus'))")
  await until(async () => (await render('window.__discoveryReads')) > before, 'app discovery did not finish')
}
async function transcriptPath(id) {
  const directory = path.join(agentDir, 'sessions')
  for (const bucket of await readdir(directory, { withFileTypes: true })) {
    if (!bucket.isDirectory()) continue
    for (const file of await readdir(path.join(directory, bucket.name)))
      if (file.endsWith(`${id}.jsonl`)) return path.join(directory, bucket.name, file)
  }
  throw Error('saved transcript missing for ' + id)
}
const savedTranscript = async id => readFile(await transcriptPath(id), 'utf8')

async function run() {
try {
  await app.whenReady()
  await mkdir(workspace, { recursive: true })
  await execFile('git', ['init', '-q', workspace])
  const version = (await execFile(executable, ['--version'])).stdout.trim()
  const first = await startTerminal()
  const standby = await startTerminal()
  controller = new GjcSdkController({ workspace, executable, emit: event => {
    events.push(event)
    if (win && !win.isDestroyed()) win.webContents.send('cli-new:event', event)
  } })
  ipcMain.handle('cli-new:call', (_event, method, args) => {
    assert(typeof controller[method] === 'function', 'unknown controller method: ' + method)
    return controller[method](...args)
  })
  const preload = path.join(root, 'preload.cjs')
  await writeFile(preload, `
const { ipcRenderer } = require('electron');
window.__discoveryReads = 0;
window.__omitNextDiscovery = false;
window.agentControlDesktop = {
  onSessionShortcut: () => () => {}, onAbortRun: () => () => {}, onCycleEffort: () => () => {},
  gjc: new Proxy({}, { get: (_target, method) => {
    if (method === 'onEvent') return listener => {
      const receive = (_event, event) => listener(event.session ? { ...event, session: { ...event.session, title: event.session.id } } : event);
      ipcRenderer.on('cli-new:event', receive);
      return () => ipcRenderer.removeListener('cli-new:event', receive);
    };
    if (method === 'dispose') return () => {};
    if (method === 'listSessions') return async () => {
      const omit = window.__omitNextDiscovery;
      window.__omitNextDiscovery = false;
      const sessions = omit ? [] : await ipcRenderer.invoke('cli-new:call', method, []);
      window.__discoveryReads++;
      return sessions.map(session => ({ ...session, title: session.id }));
    };
    return (...args) => ipcRenderer.invoke('cli-new:call', method, args);
  } }),
};
`)
  win = new BrowserWindow({ show: false, webPreferences: { preload, contextIsolation: false, sandbox: false, backgroundThrottling: false } })
  win.webContents.on('console-message', details => { if (details.level === 'error') errors.push(details.message) })
  win.webContents.on('preload-error', (_event, _path, error) => errors.push(String(error)))
  win.webContents.on('render-process-gone', (_event, details) => errors.push(JSON.stringify(details)))
  await win.loadFile(path.join(project, 'dist/index.html'))
  await render("Object.defineProperty(document, 'hidden', { configurable: true, value: false }); void 0")
  await until(async () => (await snapshot()).rows.includes(first.row.sessionId), 'initial CLI row missing from app')
  await select(first.row.sessionId)
  const before = await snapshot()

  // A deliberately incomplete discovery result is not broker termination proof.
  await render('window.__omitNextDiscovery = true')
  await refresh()
  assert((await snapshot()).selected === first.row.sessionId, 'temporary omission lost the selected conversation')
  await refresh()
  await until(async () => (await snapshot()).rows.includes(standby.row.sessionId), 'standby row did not return')

  const firstTransition = await switchTerminal(first.terminal, first.row)
  const firstSaved = await savedTranscript(first.row.sessionId)
  await refresh()
  await until(async () => {
    const state = await snapshot()
    return !state.rows.includes(first.row.sessionId) && state.rows.includes(firstTransition.next.sessionId)
      && state.selected !== first.row.sessionId
  }, 'selected old CLI session stayed in the app after /new: ' + JSON.stringify(await snapshot()))
  const selectedAfter = await snapshot()
  assert(await savedTranscript(first.row.sessionId) === firstSaved, 'app discovery changed old saved history')

  await select(standby.row.sessionId)
  const unselected = await startTerminal()
  await refresh()
  await until(async () => (await snapshot()).rows.includes(unselected.row.sessionId), 'unselected CLI row not listed')
  const secondTransition = await switchTerminal(unselected.terminal, unselected.row)
  const secondSaved = await savedTranscript(secondTransition.old.sessionId)
  await refresh()
  await until(async () => {
    const state = await snapshot()
    return !state.rows.includes(secondTransition.old.sessionId) && state.rows.includes(secondTransition.next.sessionId)
  }, 'unselected old CLI session stayed in the app after /new')
  const unselectedAfter = await snapshot()
  assert(unselectedAfter.selected === standby.row.sessionId, 'unrelated selection moved after CLI /new')
  assert(await savedTranscript(secondTransition.old.sessionId) === secondSaved, 'unselected saved history changed')
  assert(errors.length === 0, 'renderer errors: ' + errors.join('; '))
  console.log(JSON.stringify({ passed: true, version, temporaryOmissionPreservedSelection: true,
    selected: { before, broker: firstTransition, after: selectedAfter },
    unselected: { broker: secondTransition, after: unselectedAfter }, historyPreserved: true,
    removalEvents: events.filter(event => event.type === 'session.deleted'),
  }, null, 2))
  await finish(0)
} catch (error) {
  console.error(error)
  console.error(JSON.stringify({ brokerRows: (await rows()).map(evidence), app: win && !win.isDestroyed() ? await snapshot() : null }))
  console.error(JSON.stringify({ errors, events: events.filter(event => event.type === 'session.deleted') }))
  await finish(1)
}
}
void run()
