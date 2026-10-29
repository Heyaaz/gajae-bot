/**
 * Drives the global quick input through the real app: the real globalShortcut, the
 * real quick input window and its sender guard, the hand-off to the main window,
 * and the shortcut's registration states as the settings channel reports them.
 *
 * Run with `npm run desktop:quick-input-smoke` after a build. Under Node it launches
 * the built app (`electron .`) against an unreachable runtime and a throwaway user
 * data directory, with this same file loaded into the app's main process through
 * NODE_OPTIONS. There it watches what main does and steers it. Exits non-zero on
 * any regression.
 *
 * `screencapture -i` waits for a person to pick a region, so the capture tool is
 * replaced by one that writes a PNG made here. Everything after the file exists is
 * the app's own path.
 */
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const REPORT_PREFIX = 'QUICK_INPUT_SMOKE '

if (!process.versions.electron) launch()
else setImmediate(drive)

function launch() {
  const appPath = path.resolve(__dirname, '..')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gajae-quick-input-smoke-'))
  const userData = path.join(root, 'user-data')
  const project = path.join(root, 'project')
  fs.mkdirSync(userData, { recursive: true })
  fs.mkdirSync(project, { recursive: true })
  fs.writeFileSync(
    path.join(userData, 'agent-control-settings.json'),
    JSON.stringify({ workspace: project }),
  )
  // Past the first-run environment check, which would otherwise open over the shell.
  fs.writeFileSync(
    path.join(userData, 'agent-control-desktop-state.json'),
    JSON.stringify({ environmentReady: true }),
  )
  const electron = require(path.join(appPath, 'node_modules/electron'))
  const child = spawn(electron, ['.'], {
    cwd: appPath,
    stdio: ['ignore', 'pipe', 'inherit'],
    env: {
      ...process.env,
      NODE_OPTIONS: `--require ${__filename}`,
      GAJAE_USER_DATA_DIR: userData,
      GJC_BIN: '/nonexistent/gjc',
      // The session index is read from disk without the binary; this machine's real
      // sessions are not this smoke's to list.
      GJC_CODING_AGENT_DIR: path.join(root, 'gjc-agent'),
      QUICK_INPUT_SMOKE_ROOT: root,
      QUICK_INPUT_SMOKE_PROJECT: project,
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
  const timer = setTimeout(() => child.kill('SIGTERM'), 90_000)
  child.on('exit', (code) => {
    clearTimeout(timer)
    console.log(JSON.stringify(report ?? { error: 'no report' }, null, 2))
    process.exit(code === 0 && report?.passed ? 0 : 1)
  })
}

function drive() {
  const childProcess = require('node:child_process')
  const { syncBuiltinESMExports } = require('node:module')
  const { app, BrowserWindow, globalShortcut, nativeImage } = require('electron')
  const root = process.env.QUICK_INPUT_SMOKE_ROOT
  const project = process.env.QUICK_INPUT_SMOKE_PROJECT
  const accelerator = 'Control+Alt+Space'
  const steps = []
  const step = (name, value) => {
    steps.push({ name, value })
    return value
  }
  const assert = (condition, message) => {
    if (!condition) throw new Error(message)
  }
  const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
  async function until(condition, message, timeout = 8_000) {
    const deadline = Date.now() + timeout
    for (;;) {
      const value = await condition()
      if (value) return value
      if (Date.now() > deadline) throw new Error(`Timed out: ${message}`)
      await wait(100)
    }
  }

  const fixture = path.join(root, 'fixture.png')
  const pixels = Buffer.alloc(96 * 60 * 4)
  for (let offset = 0; offset < pixels.length; offset += 4) pixels.set([0x16, 0x64, 0xf0, 0xff], offset)
  fs.writeFileSync(fixture, nativeImage.createFromBitmap(pixels, { width: 96, height: 60 }).toPNG())

  const screencaptureCalls = []
  const execFile = childProcess.execFile
  childProcess.execFile = function (file, args, ...rest) {
    if (file !== '/usr/sbin/screencapture') return execFile.call(this, file, args, ...rest)
    screencaptureCalls.push(args)
    fs.copyFileSync(fixture, args.at(-1))
    const callback = rest.find((value) => typeof value === 'function')
    setTimeout(() => callback?.(null, '', ''), 50)
    return { stdin: { end() {} } }
  }
  syncBuiltinESMExports()

  const handlers = new Map()
  const register = globalShortcut.register.bind(globalShortcut)
  globalShortcut.register = (keys, callback) => {
    handlers.set(keys, callback)
    return register(keys, callback)
  }

  const sent = []
  app.on('web-contents-created', (_event, contents) => {
    const send = contents.send.bind(contents)
    contents.send = (channel, ...args) => {
      sent.push({ to: contents.id, channel, args })
      return send(channel, ...args)
    }
  })

  const quickWindow = () =>
    BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().includes('window=quick-input'))
  const mainWindow = () =>
    BrowserWindow.getAllWindows().find((window) => !window.webContents.getURL().includes('window=quick-input'))
  const settingsCall = (expression) =>
    mainWindow().webContents.executeJavaScript(`window.agentControlDesktop.settings.${expression}`)

  app.whenReady().then(async () => {
    const timeout = setTimeout(() => finish(new Error('Quick input smoke timed out')), 75_000)
    try {
      const main = await until(() => {
        const window = mainWindow()
        return window && !window.webContents.isLoading() && window.webContents.getURL() ? window : undefined
      }, 'main window loaded')
      await until(
        () => main.webContents.executeJavaScript('Boolean(document.querySelector(".app-shell"))'),
        'shell mounted',
        15_000,
      )

      const atLaunch = step('status at launch', await settingsCall('quickInputShortcutStatus()'))
      assert(atLaunch.state === 'registered' && globalShortcut.isRegistered(accelerator), 'the default shortcut is registered at launch')

      const preferences = await settingsCall('getPreferences()')
      const save = (quickInputShortcut) =>
        settingsCall(`setDesktopIntegration(${JSON.stringify({ ...preferences.desktopIntegration, quickInputShortcut })})`)
      await save('')
      assert(!globalShortcut.isRegistered(accelerator), 'turning it off releases the keys')
      // macOS lets two apps hold the same keys, so the refusal main can see is a
      // registration it does not own; this process holds them the way one would.
      step('another holder takes the keys', register(accelerator, () => undefined))
      await save(accelerator)
      const taken = step('status while another holder has the keys', await settingsCall('quickInputShortcutStatus()'))
      assert(taken.state === 'failed' && taken.reason === 'unavailable', 'a refused registration is reported, not thrown')

      await main.webContents.executeJavaScript(`document.querySelector('button[title="설정"]')?.click()`)
      const settingsAlert = step(
        'settings tab alert',
        await until(
          () =>
            main.webContents.executeJavaScript(`
              (() => {
                const tab = [...document.querySelectorAll('.settings-dialog nav button')].find((item) => item.textContent?.trim() === '데스크톱')
                if (tab && !tab.classList.contains('is-active')) tab.click()
                return document.querySelector('.quick-input-shortcut-row [role="alert"]')?.textContent ?? null
              })()
            `),
          'desktop tab shows the shortcut status',
        ),
      )
      assert(settingsAlert?.includes('등록하지 못했습니다'), 'the desktop tab shows the failure')
      await main.webContents.executeJavaScript(
        `document.querySelector('.modal-backdrop')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`,
      )

      globalShortcut.unregister(accelerator)
      await save(accelerator)
      const registered = step('status after the holder let go and settings saved again', await settingsCall('quickInputShortcutStatus()'))
      assert(registered.state === 'registered', 'saving retries a refused accelerator')
      assert(step('globalShortcut.isRegistered', globalShortcut.isRegistered(accelerator)), 'the real shortcut is live')

      await save('Nope+Foo')
      const invalid = step('status for an unparsable accelerator', await settingsCall('quickInputShortcutStatus()'))
      assert(invalid.state === 'failed' && invalid.reason === 'invalid', 'an unparsable accelerator is reported')
      assert(!globalShortcut.isRegistered(accelerator), 'the previous accelerator was released')
      await save(accelerator)
      assert(globalShortcut.isRegistered(accelerator), 'the default accelerator is live again')

      const run = (file, args) =>
        new Promise((resolve) =>
          execFile(file, args, (error, stdout) =>
            resolve(error ? `error: ${String(error.message).split('\n')[0]}` : String(stdout).trim()),
          ),
        )
      const osascript = (script) => run('/usr/bin/osascript', ['-e', script])
      const frontApp = async () => {
        const asn = await run('/usr/bin/lsappinfo', ['front'])
        const info = await run('/usr/bin/lsappinfo', ['info', '-only', 'name', asn])
        return info.replace(/^.*=\s*"?|"$/g, '')
      }
      await osascript('tell application "Finder" to activate')
      await wait(800)
      const frontBefore = await frontApp()
      const keystroke = await osascript('tell application "System Events" to key code 49 using {control down, option down}')
      await wait(1_000)
      const deliveredByOs = Boolean(quickWindow()?.isVisible())
      let typedByOs = null
      if (deliveredByOs) {
        await osascript('tell application "System Events" to keystroke "abc"')
        await wait(500)
        typedByOs = await quickWindow().webContents.executeJavaScript(`document.querySelector('textarea').value`)
      }
      step('OS keystroke with another app in front', {
        frontBefore,
        keystroke,
        openedTheWindow: deliveredByOs,
        frontAfter: await frontApp(),
        typedIntoQuickInput: typedByOs,
      })
      if (!deliveredByOs) handlers.get(accelerator)()

      const quick = await until(() => {
        const window = quickWindow()
        return window?.isVisible() && !window.webContents.isLoading() ? window : undefined
      }, 'quick input window shown')
      step('quick window', {
        url: quick.webContents.getURL(),
        visible: quick.isVisible(),
        alwaysOnTop: quick.isAlwaysOnTop(),
        focused: quick.isFocused(),
        bounds: quick.getBounds(),
      })
      const options = await until(
        () => quick.webContents.executeJavaScript(`[...document.querySelectorAll('select option')].map((option) => option.value)`).then((values) => (values.length ? values : undefined)),
        'project list',
      )
      step('projects offered', options)
      assert(options.length === 1 && options[0] === project, 'the configured workspace is offered')

      const guard = step(
        'quick window calling a main-window channel',
        await quick.webContents.executeJavaScript(
          `window.agentControlDesktop.settings.getPreferences().then(() => 'allowed', (error) => String(error.message))`,
        ),
      )
      assert(guard.includes('Unauthorized IPC sender'), 'the quick window cannot reach the main window channels')

      await quick.webContents.executeJavaScript(`
        (async () => {
          const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
          document.querySelector('button[aria-label="화면 캡처 첨부"]').click()
          for (let i = 0; i < 50 && !document.querySelector('.quick-input-captures img'); i += 1) await wait(100)
          const box = document.querySelector('textarea')
          Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(box, '빠른 입력 스모크: 이 화면 확인해 줘')
          box.dispatchEvent(new Event('input', { bubbles: true }))
          await wait(100)
        })()
      `)
      step('screencapture calls', screencaptureCalls)
      assert(screencaptureCalls.length === 1 && screencaptureCalls[0].includes('-i'), 'capture ran screencapture -i once')
      await wait(300)
      const quickShot = await quick.webContents.capturePage()
      fs.writeFileSync(path.join(root, 'quick-input.png'), quickShot.toPNG())
      await quick.webContents.executeJavaScript(
        `document.querySelector('textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))`,
      )

      const handoff = await until(
        () => sent.find((entry) => entry.to === main.webContents.id && entry.channel === 'gajae:shortcut:session'),
        'main window received the shortcut',
      )
      const shortcut = handoff.args[0]
      const image = shortcut.prefill?.images?.[0]
      step('main window received', {
        type: shortcut.type,
        workspace: shortcut.prefill?.workspace,
        prompt: shortcut.prefill?.prompt,
        images: shortcut.prefill?.images?.map((item) => ({
          name: item.name,
          mimeType: item.mimeType,
          tokenLength: item.token?.length,
          matchesFixture: item.data === fs.readFileSync(fixture).toString('base64'),
        })),
      })
      assert(shortcut.type === 'new', 'a new-session shortcut')
      assert(shortcut.prefill.workspace === project, 'prefilled with the chosen project')
      assert(shortcut.prefill.prompt === '빠른 입력 스모크: 이 화면 확인해 줘', 'prefilled with the typed text')
      assert(image && /^[A-Za-z0-9_-]{43}$/.test(image.token), 'the capture arrives as an issued image attachment')
      assert(image.data === fs.readFileSync(fixture).toString('base64'), 'the attachment is the captured file')
      await until(() => !quick.isVisible(), 'quick window hides after the hand-off')

      const dialog = await until(
        () =>
          main.webContents.executeJavaScript(`
            (() => {
              const form = document.querySelector('.new-session-dialog')
              if (!form) return null
              return {
                prompt: form.querySelector('textarea')?.value,
                workspace: form.querySelector('code')?.textContent,
                image: form.querySelector('.new-session-images img')?.getAttribute('alt'),
              }
            })()
          `),
        'new-session dialog opened in the main window',
      )
      step('new-session dialog', dialog)
      assert(dialog.prompt === shortcut.prefill.prompt && dialog.workspace === project && dialog.image === image.name, 'the dialog shows what the quick input collected')
      assert(step('main window visible', main.isVisible()), 'the main window came forward')
      const dialogShot = await main.webContents.capturePage()
      fs.writeFileSync(path.join(root, 'new-session-dialog.png'), dialogShot.toPNG())

      handlers.get(accelerator)()
      await until(() => quickWindow()?.isVisible(), 'quick window opens again')
      await quickWindow().webContents.executeJavaScript(
        `document.querySelector('textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`,
      )
      await until(() => !quickWindow().isVisible(), 'Escape hides the quick window')
      step('Escape dismissed', true)

      await save('')
      const off = step('status after turning it off', await settingsCall('quickInputShortcutStatus()'))
      assert(off.state === 'off' && !globalShortcut.isRegistered(accelerator), 'turning it off releases the keys')
      finish()
    } catch (error) {
      finish(error)
    } finally {
      clearTimeout(timeout)
    }
  })

  function finish(error) {
    process.stdout.write(
      `${REPORT_PREFIX}${JSON.stringify({ passed: !error, error: error ? String(error.stack ?? error) : undefined, artifacts: root, steps })}\n`,
      () => app.exit(error ? 1 : 0),
    )
  }
}
