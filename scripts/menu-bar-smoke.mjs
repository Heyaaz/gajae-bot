import { app, Tray } from 'electron'
import assert from 'node:assert/strict'
import path from 'node:path'
import { DEFAULT_DESKTOP_INTEGRATION } from '../dist-electron/shared/desktop-integration.js'
import { DesktopIntegration } from '../dist-electron/electron/desktop-integration.js'
import { desktopStatusRenderer } from '../dist-electron/electron/desktop-status.js'
import { electronStatusSurface, menuBarIcon } from '../dist-electron/electron/desktop-status-surface.js'

/**
 * Drives the real menu bar item and Dock badge from synthetic session events.
 *
 * The model is unit tested; this proves the Electron adapter applies it: a real
 * Tray with a template image, its title, the menu it actually holds, the click
 * routing, and `app.dock.getBadge()`.
 *
 * Run with `npm run desktop:menu-bar-smoke` after a build. Exits non-zero on any
 * regression.
 */
const appPath = path.resolve(import.meta.dirname, '..')
const iconPath = path.join(appPath, 'src/assets/gajae-icon-ui.png')

app.setName('Gajae Menu Bar Smoke')
app.setPath('userData', path.join(app.getPath('appData'), 'Agent Control Menu Bar Smoke'))

// Tray has no getter for its menu, so the smoke reads the one the adapter set.
let liveTray
let liveMenu
const setContextMenu = Tray.prototype.setContextMenu
Tray.prototype.setContextMenu = function (menu) {
  liveTray = this
  liveMenu = menu
  return setContextMenu.call(this, menu)
}

function session(id, patch = {}) {
  return {
    id,
    title: id,
    subtitle: '',
    workspace: '/repo',
    runtime: 'gjc',
    status: 'idle',
    updatedAt: 'now',
    updatedAtMs: Date.now(),
    pinned: false,
    unread: false,
    accent: '#000',
    ownership: 'gajae',
    attachment: 'attached',
    ...patch,
  }
}

function snapshot(step) {
  const shown = liveTray && !liveTray.isDestroyed()
  const view = {
    step,
    tray: shown ? liveTray.getTitle() : '(hidden)',
    menu: shown ? liveMenu.items.map((item) => (item.type === 'separator' ? '---' : item.label)) : [],
    badge: app.dock.getBadge(),
  }
  console.log(JSON.stringify(view))
  return view
}

app.whenReady().then(() => {
  const timeout = setTimeout(() => {
    console.error('Menu bar smoke timed out')
    app.exit(1)
  }, 20_000)
  try {
    const icon = menuBarIcon(iconPath)
    console.log(JSON.stringify({ icon: { size: icon.getSize(), template: icon.isTemplateImage(), scales: icon.getScaleFactors() } }))
    assert.equal(icon.isTemplateImage(), true, 'menu bar icon is a template image')
    assert.deepEqual(icon.getSize(), { width: 18, height: 18 }, 'menu bar icon is 18pt')

    const opened = []
    const surface = electronStatusSurface({
      iconPath,
      openSession: (sessionId) => opened.push(sessionId),
      openApp: () => opened.push('(app)'),
    })
    let applied = 0
    const counting = {
      setTray: (tray) => {
        applied += 1
        surface.setTray(tray)
      },
      setBadge: (badge) => {
        applied += 1
        surface.setBadge(badge)
      },
    }
    const render = desktopStatusRenderer(counting)
    const integration = new DesktopIntegration({
      power: { start: () => 1, stop: () => undefined, isStarted: () => false },
      preferences: DEFAULT_DESKTOP_INTEGRATION,
      onChange: render,
    })
    render(integration.state())
    snapshot('empty')

    integration.observe({ type: 'session.created', session: session('fix-login', { status: 'running' }) })
    let view = snapshot('working')
    assert.equal(view.tray, '\u25B6\uFE0E1', 'working count in the menu bar')
    assert.equal(view.badge, '', 'working alone does not badge')

    integration.observe({ type: 'session.updated', session: session('fix-login', { status: 'waiting' }) })
    view = snapshot('waiting')
    assert.equal(view.tray, '\u26A0\uFE0E1', 'needs-input count in the menu bar')
    assert.deepEqual(view.menu, ['확인 필요', 'fix-login', '---', 'Gajae 열기'])
    assert.equal(view.badge, '1', 'waiting session badges the Dock')

    liveMenu.items.find((item) => item.label === 'fix-login').click()
    liveMenu.items.find((item) => item.label === 'Gajae 열기').click()
    assert.deepEqual(opened, ['fix-login', '(app)'], 'menu items open their session and the app')

    integration.observe({ type: 'session.updated', session: session('fix-login', { status: 'idle', unread: true }) })
    view = snapshot('idle unread')
    assert.equal(view.tray, '', 'no counts once the turn ended')
    assert.equal(view.badge, '1', 'unread completion still badges')

    integration.observe({ type: 'session.updated', session: session('fix-login', { title: 'renamed' }) })
    view = snapshot('read')
    assert.equal(view.badge, '', 'reading clears the badge')

    integration.observe({ type: 'session.created', session: session('migrate', { status: 'running' }) })
    integration.observe({ type: 'session.created', session: session('flaky-test', { status: 'failed' }) })
    snapshot('running + failed')

    const before = applied
    integration.observe({ type: 'session.updated', session: session('migrate', { status: 'running', title: 'migrate' }) })
    assert.equal(applied, before, 'an update that renders the same touches neither surface')

    integration.setPreferences({ ...DEFAULT_DESKTOP_INTEGRATION, menuBarStatus: false })
    view = snapshot('menuBarStatus off')
    assert.equal(view.tray, '(hidden)', 'menu bar item removed')
    assert.equal(view.badge, '1', 'badge unaffected by the menu bar toggle')

    integration.setPreferences({ ...DEFAULT_DESKTOP_INTEGRATION, dockBadge: false })
    view = snapshot('dockBadge off')
    assert.equal(view.tray, '\u26A0\uFE0E1 \u25B6\uFE0E1', 'menu bar item back')
    assert.equal(view.badge, '', 'badge cleared')

    integration.setPreferences(DEFAULT_DESKTOP_INTEGRATION)
    snapshot('both on')

    const imageless = electronStatusSurface({
      iconPath: path.join(appPath, 'missing-icon.png'),
      openSession: () => undefined,
      openApp: () => undefined,
    })
    imageless.setTray({ title: '', tooltip: '', menu: [{ kind: 'open-app', label: 'Gajae 열기' }] })
    assert.equal(liveTray.getTitle(), 'Gajae', 'an imageless item still has something to click')
    imageless.setTray(null)
    console.log('Menu bar smoke passed')
    clearTimeout(timeout)
    app.exit(0)
  } catch (error) {
    console.error(error)
    app.exit(1)
  }
})
