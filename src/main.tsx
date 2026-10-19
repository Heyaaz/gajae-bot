import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import type { AgentBackend } from './backend/agent-backend'
import { BackendProvider } from './backend/backend-provider'
import { GjcAgentBackend } from './backend/gjc-agent-backend'
import { RemoteAgentBackend } from './backend/remote-agent-backend'
import { initializeTheme } from './theme'
import { ensureEnglishDictionary, initializeLanguage, getLanguage } from './i18n'
import './index.css'

initializeLanguage()
// English copy is a separate chunk. Wait for it before the first paint so a
// session that is already set to English does not flash the Korean source.
if (getLanguage() === 'en') await ensureEnglishDictionary()
const settingsBridge = window.agentControlDesktop?.settings
if (settingsBridge) void settingsBridge.setLanguage(getLanguage()).catch(() => undefined)
initializeTheme()

/**
 * Chooses the backend this window will run on.
 *
 * Inside the desktop app the window talks to the host process over IPC. A plain
 * browser is the remote client instead: it reaches the same runtime through the
 * host's remote access server, which is the only way a phone or another personal
 * machine can see real sessions.
 *
 * The mock backend exists for UI work and for the `--smoke` run, so it is
 * reachable only by asking for it explicitly. It must never stand in for a real
 * runtime that failed: it answers `state: "connected"` with invented sessions and
 * transcripts, so substituting it showed a green dot and a working-looking window
 * while nothing was attached. The whole point of this app is that its screen is
 * the source of truth about the agent, which makes a silent swap to fiction the
 * worst thing it can do.
 *
 * The implementation is a separate chunk, loaded only on that explicit path.
 * Desktop builds keep the chunk so `--smoke` can open `dist/index.html?backend=mock`.
 * The web production build omits it.
 *
 * A backend that cannot connect is returned anyway. It reports its own failure
 * through `getConnection`, and the shell renders that state with a retry, which
 * is what lets a user recover once the runtime is back.
 */
async function selectBackend(): Promise<AgentBackend> {
  const params = new URLSearchParams(window.location.search)
  const forceMock = params.get('backend') === 'mock'
  const desktop = window.agentControlDesktop?.gjc
  const browserOrigin =
    window.location.protocol === 'http:' || window.location.protocol === 'https:'
  if (forceMock || (!desktop && !browserOrigin)) {
    if (import.meta.env.DEV || __GAJAE_INCLUDE_MOCK__) {
      const { MockAgentBackend } = await import('./backend/mock-agent-backend')
      const mock = new MockAgentBackend()
      // The inspector smoke needs a session long enough that mounting every row would be
      // visible, to prove the transcript is windowed.
      const seed = Number.parseInt(params.get('seedTranscript') ?? '', 10)
      if (Number.isFinite(seed) && seed > 0) mock.seedLargeTranscript(seed)
      return mock
    }
    throw new Error('Mock backend is not included in this build')
  }
  if (desktop) return new GjcAgentBackend(desktop)
  const remote = new RemoteAgentBackend()
  registerRemoteServiceWorker()
  return remote
}

/**
 * Installs the remote client as a PWA.
 *
 * Only the static app shell is cached by the worker; session data and the device
 * token are always fetched live. Registration failures are silent: a browser
 * without service worker support still gets the working app.
 */
function registerRemoteServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return
  if (window.location.protocol !== 'https:' && window.location.hostname !== '127.0.0.1' && window.location.hostname !== 'localhost')
    return
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch(() => undefined)
  })
}

const backend = await selectBackend()
const mount = document.getElementById('root')

if (!mount) {
  throw new Error('Application mount is missing')
}

createRoot(mount).render(
  <StrictMode>
    <BackendProvider backend={backend}>
      <App />
    </BackendProvider>
  </StrictMode>,
)
