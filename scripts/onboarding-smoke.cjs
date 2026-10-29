/**
 * Walks first-run setup through the real app on a Mac that has never seen GJC: a
 * throwaway HOME (so no gjc on any lookup path), userData and GJC agent dir.
 *
 * Default: the release download is served from here, as a stand-in `gjc` that
 * speaks GJC's install, `models` and `auth-broker login` contracts. The app's own
 * path does the rest: checksum, install into ~/.local/bin, reconnect, an API-key
 * sign-in answered over stdin, the provider's model profile saved, and the first
 * conversation dialog.
 *
 * `--real-gjc`: downloads the real latest release and starts a real Claude login,
 * stopping at GJC's question and cancelling it. No credential is entered.
 *
 * Both modes stub `shell.openExternal`, so no browser opens. Run after a build:
 * `npm run desktop:onboarding-smoke [-- --real-gjc] [--keep]` (`--keep` leaves the screenshots).
 */
const { spawn } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const REPORT_PREFIX = 'ONBOARDING_SMOKE '

if (!process.versions.electron) launch()
else setImmediate(drive)

function launch() {
  const appPath = path.resolve(__dirname, '..')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gajae-onboarding-smoke-'))
  const home = path.join(root, 'home')
  fs.mkdirSync(home, { recursive: true })
  const electron = require(path.join(appPath, 'node_modules/electron'))
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !/^(GJC_|AGENT_CONTROL_|GAJAE_)/u.test(name)),
  )
  const child = spawn(electron, ['.'], {
    cwd: appPath,
    stdio: ['ignore', 'pipe', 'inherit'],
    env: {
      ...environment,
      HOME: home,
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      NODE_OPTIONS: `--require ${__filename}`,
      GAJAE_USER_DATA_DIR: path.join(root, 'user-data'),
      GJC_CODING_AGENT_DIR: path.join(root, 'gjc-agent'),
      ONBOARDING_SMOKE_ROOT: root,
      ONBOARDING_SMOKE_REAL: process.argv.includes('--real-gjc') ? '1' : '',
    },
  })
  let report
  let output = ''
  child.stdout.on('data', (chunk) => {
    output += chunk
    for (const line of output.split('\n').slice(0, -1))
      if (line.startsWith(REPORT_PREFIX)) report = JSON.parse(line.slice(REPORT_PREFIX.length))
      else if (line.trim()) console.log(line)
    output = output.slice(output.lastIndexOf('\n') + 1)
  })
  const timer = setTimeout(() => child.kill('SIGTERM'), 600_000)
  child.on('exit', (code) => {
    clearTimeout(timer)
    // The installed GJC starts its own broker and SDK helpers, which outlive the
    // app. Every one of them runs from this run's throwaway HOME.
    try {
      require('node:child_process').execFileSync('/usr/bin/pkill', ['-f', root])
    } catch {
      // pkill exits 1 when nothing matched.
    }
    console.log(JSON.stringify(report ?? { error: 'no report' }, null, 2))
    if (report?.passed && !process.argv.includes('--keep')) fs.rmSync(root, { recursive: true, force: true })
    else console.log(`kept ${root}`)
    process.exit(code === 0 && report?.passed ? 0 : 1)
  })
}

// A stand-in for the release binary: GJC's --version, `models` before and after a
// credential exists, and `auth-broker login zai` reading its key over readline.
const FAKE_GJC = `#!/bin/sh
agent="$GJC_CODING_AGENT_DIR"
case "$1" in
  --version) echo "gjc/0.19.2" ;;
  models)
    if [ -f "$agent/credential" ]; then echo "Canonical models"; echo "glm-4.7  zai/glm-4.7"
    else echo "No models available. Set API keys in environment variables."; fi ;;
  auth-broker)
    [ "$3" = "zai" ] || { echo "Error: unexpected provider $3" >&2; exit 2; }
    printf "\\nOpen this URL in your browser:\\nhttps://z.ai/manage-apikey/apikey-list\\nCopy your API key from the dashboard\\n\\n"
    printf "Paste your Z.AI API key (sk-...):: "
    read key
    [ "$key" = "sk-smoke" ] || { echo "Error: Invalid API key" >&2; exit 1; }
    mkdir -p "$agent" && : > "$agent/credential"
    echo "Credentials saved to ~/.gjc/agent/agent.db" ;;
  *) echo "fake gjc: $*" >&2; exit 3 ;;
esac
`

function drive() {
  const { app, BrowserWindow, shell } = require('electron')
  const root = process.env.ONBOARDING_SMOKE_ROOT
  const real = process.env.ONBOARDING_SMOKE_REAL === '1'
  const home = process.env.HOME
  const steps = []
  const step = (name, value) => {
    steps.push({ name, ...(value === undefined ? {} : { value }) })
    return value
  }
  const assert = (condition, message) => {
    if (!condition) throw new Error(message)
  }
  const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
  async function until(condition, message, timeout = 15_000) {
    const deadline = Date.now() + timeout
    for (;;) {
      const value = await condition()
      if (value) return value
      if (Date.now() > deadline) throw new Error(`Timed out: ${message}`)
      await wait(100)
    }
  }

  const opened = []
  shell.openExternal = async (url) => {
    opened.push(url)
  }

  const requested = []
  if (!real) {
    const binary = Buffer.from(FAKE_GJC)
    const digest = crypto.createHash('sha256').update(binary).digest('hex')
    const realFetch = globalThis.fetch
    globalThis.fetch = async (input, init) => {
      const url = String(input)
      if (!url.includes('Yeachan-Heo/gajae-code')) return realFetch(input, init)
      requested.push(url)
      if (url.endsWith('/releases/latest')) return Response.json({ tag_name: 'v0.19.2' })
      if (url.endsWith('/gajae-release-binaries.sha256'))
        return new Response(`${digest}  gjc-darwin-arm64\n${digest}  gjc-darwin-x64\n`)
      if (/\/gjc-darwin-(arm64|x64)$/u.test(url))
        return new Response(binary, { headers: { 'content-length': String(binary.byteLength) } })
      return new Response('not found', { status: 404 })
    }
  }

  const window = () => BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed())
  const run = (script) => window().webContents.executeJavaScript(script)
  const text = () => run('document.querySelector(".onboarding")?.textContent ?? ""')
  const click = (label) =>
    run(`(() => {
      const button = [...document.querySelectorAll(".onboarding button")].find((b) => b.textContent.includes(${JSON.stringify(label)}));
      if (!button) return false;
      button.click();
      return true;
    })()`)
  const shot = async (name) => {
    // capturePage returns the last composited frame, which can predate the DOM change.
    await wait(500)
    const image = await window().webContents.capturePage()
    fs.writeFileSync(path.join(root, `${name}.png`), image.toPNG())
  }
  const installed = path.join(home, '.local/bin/gjc')

  app.whenReady().then(async () => {
    try {
      await until(() => window() && run('Boolean(document.querySelector(".app-shell"))'), 'shell rendered', 30_000)
      await until(async () => (await text()).includes('GJC'), 'first-run setup opened on the install step')
      step('install step shown', await text())
      await shot('1-install')
      assert(!fs.existsSync(installed), 'no gjc before install')

      assert(await click('GJC 설치'), 'install button')
      await until(async () => (await text()).includes('어떤 AI를 쓰시나요?'), 'provider list after install', real ? 480_000 : 15_000)
      assert(fs.statSync(installed).mode & 0o100, 'installed gjc is executable')
      step('installed', { path: installed.replace(home, '~'), bytes: fs.statSync(installed).size })
      if (!real) step('release requests', requested.map((url) => url.replace(/^https:\/\/[^/]+/u, '')))
      await shot('2-providers')

      if (real) {
        assert(await click('Claude Pro/Max'), 'Claude provider')
        await until(() => run('Boolean(document.querySelector(".onboarding-answer input"))'), 'GJC asked for the code', 60_000)
        step('real login reached its question', (await text()).includes('받은 코드를 붙여 넣으세요'))
        assert(opened.length === 1 && new URL(opened[0]).host === 'claude.ai', 'login page handed to the browser')
        step('browser asked to open', new URL(opened[0]).host)
        await shot('3-real-sign-in')
        assert(await click('다른 AI 고르기'), 'cancel the real login')
        await until(async () => (await text()).includes('어떤 AI를 쓰시나요?'), 'back to providers after cancel')
        step('real login cancelled')
      } else {
        assert(await click('Z.AI GLM Coding Plan'), 'Z.AI provider')
        await until(() => run('Boolean(document.querySelector(".onboarding-answer input"))'), 'API key field')
        assert(opened[0] === 'https://z.ai/manage-apikey/apikey-list', 'API key page handed to the browser')
        step('key field type', await run('document.querySelector(".onboarding-answer input").type'))
        await shot('3-api-key')
        await run(`(() => {
          const input = document.querySelector(".onboarding-answer input");
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "sk-smoke");
          input.dispatchEvent(new Event("input", { bubbles: true }));
        })()`)
        assert(await click('확인'), 'submit key')
        await until(async () => (await text()).includes('준비됐습니다'), 'ready after sign-in')
        await shot('4-ready')
        const settings = JSON.parse(
          fs.readFileSync(path.join(process.env.GAJAE_USER_DATA_DIR, 'agent-control-settings.json'), 'utf8'),
        )
        assert(settings.modelPreset === 'glm-medium', `provider profile saved, got ${settings.modelPreset}`)
        step('model profile saved', settings.modelPreset)
        const state = JSON.parse(
          fs.readFileSync(path.join(process.env.GAJAE_USER_DATA_DIR, 'agent-control-desktop-state.json'), 'utf8'),
        )
        assert(state.onboarded === true, 'setup remembered as done')
        assert(await click('첫 대화 시작'), 'start conversation')
        await until(() => run('!document.querySelector(".onboarding") && Boolean(document.querySelector(".modal-backdrop"))'), 'new conversation dialog')
        step('new conversation dialog opened')
        await shot('5-new-conversation')
        const again = await run('window.agentControlDesktop.onboarding.pendingStep()')
        assert(again === null, 'setup does not open again')
        step('pending step afterwards', again)
      }
      process.stdout.write(`${REPORT_PREFIX}${JSON.stringify({ passed: true, real, steps, screenshots: root })}\n`)
      app.exit(0)
    } catch (error) {
      await shot('failure').catch(() => undefined)
      process.stdout.write(
        `${REPORT_PREFIX}${JSON.stringify({ passed: false, error: String(error?.stack ?? error), steps, screenshots: root })}\n`,
      )
      app.exit(1)
    }
  })
}
