// Verifies the actual packaged application with an empty user-data directory.
// This catches first-launch failures hidden by the developer machine's persisted
// workspace, model, and runtime settings.
import { spawn, execFileSync } from 'node:child_process'
import { access, mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const appBinary = path.join(root, 'release/Gajae-darwin-arm64/Gajae.app/Contents/MacOS/Gajae')
const packagedAsar = path.join(root, 'release/Gajae-darwin-arm64/Gajae.app/Contents/Resources/app.asar')
const timeoutMs = 60_000

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        reject(new Error('Could not allocate a Chromium debug port'))
        return
      }
      server.close((error) => error ? reject(error) : resolve(address.port))
    })
  })
}

async function waitForTarget(port, deadline) {
  let lastError
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`)
      const targets = await response.json()
      const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl)
      if (page) return page
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(`Packaged renderer did not expose a debug target: ${lastError ?? 'timeout'}`)
}

function evaluate(target, expression, deadline) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(target.webSocketDebuggerUrl)
    const timer = setTimeout(() => {
      socket.close()
      reject(new Error('Packaged renderer evaluation timed out'))
    }, Math.max(1, deadline - Date.now()))
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: { expression, awaitPromise: true, returnByValue: true },
      }))
    })
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data))
      if (message.id !== 1) return
      clearTimeout(timer)
      socket.close()
      if (message.error || message.result?.exceptionDetails) {
        reject(new Error(JSON.stringify(message.error ?? message.result.exceptionDetails)))
        return
      }
      resolve(message.result?.result?.value)
    })
    socket.addEventListener('error', () => {
      clearTimeout(timer)
      reject(new Error('Packaged renderer debug socket failed'))
    })
  })
}

await access(appBinary)
await access(packagedAsar)
const temporary = await mkdtemp(path.join(os.tmpdir(), 'gajae-clean-install-'))
const userData = path.join(temporary, 'user-data')
const agentDirectory = path.join(temporary, 'agent')
await mkdir(userData, { recursive: true })
await mkdir(agentDirectory, { recursive: true })
const port = await freePort()
const gjc = process.env.GJC_BIN || execFileSync('which', ['gjc'], { encoding: 'utf8' }).trim()
const logs = []
const child = spawn(appBinary, [`--remote-debugging-port=${port}`], {
  detached: true,
  env: {
    ...process.env,
    GAJAE_USER_DATA_DIR: userData,
    GJC_CODING_AGENT_DIR: agentDirectory,
    GJC_BIN: gjc,
    // A packaged asar is an existing file but not a legal workspace. The app must
    // reject it and use a real fresh default directory.
    AGENT_CONTROL_WORKSPACE: packagedAsar,
    VITE_DEV_SERVER_URL: 'https://attacker.invalid',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
child.stdout?.on('data', (chunk) => logs.push(String(chunk)))
child.stderr?.on('data', (chunk) => logs.push(String(chunk)))
const deadline = Date.now() + timeoutMs

try {
  const target = await waitForTarget(port, deadline)
  const report = await evaluate(
    target,
    `(async () => ({
      preferences: await window.agentControlDesktop.settings.getPreferences(),
      connection: await window.agentControlDesktop.gjc.getConnection(),
      location: location.href,
      hasPathBridge: typeof window.agentControlDesktop.settings.pathForFile !== 'undefined'
    }))()`,
    deadline,
  )
  const workspace = report?.preferences?.workspace
  if (typeof workspace !== 'string' || !(await stat(workspace)).isDirectory())
    throw new Error(`Fresh workspace is not a directory: ${workspace}`)
  if (workspace === packagedAsar || workspace.endsWith('.asar'))
    throw new Error(`Fresh workspace reused the packaged asar: ${workspace}`)
  if (report.location.includes('attacker.invalid'))
    throw new Error(`Packaged app trusted VITE_DEV_SERVER_URL: ${report.location}`)
  if (report.hasPathBridge)
    throw new Error('Packaged preload still exposes native attachment paths')
  const runtimeDetail = `${report?.connection?.detail ?? ''}\n${logs.join('')}`
  if (runtimeDetail.includes('ENOTDIR'))
    throw new Error(`Packaged runtime received a non-directory cwd:\n${runtimeDetail}`)
  console.log(JSON.stringify(report, null, 2))
  console.log('Packaged clean-install smoke passed')
} finally {
  try { process.kill(-child.pid, 'SIGTERM') } catch {}
  await new Promise((resolve) => setTimeout(resolve, 500))
  try { process.kill(-child.pid, 'SIGKILL') } catch {}
  await rm(temporary, { recursive: true, force: true })
}
