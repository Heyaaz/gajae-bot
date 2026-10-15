import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import type { AgentBackend } from './backend/agent-backend'
import { BackendProvider } from './backend/backend-provider'
import { GjcAgentBackend } from './backend/gjc-agent-backend'
import { MockAgentBackend } from './backend/mock-agent-backend'
import { RemoteAgentBackend } from './backend/remote-agent-backend'
import './index.css'

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
 * A backend that cannot connect is returned anyway. It reports its own failure
 * through `getConnection`, and the shell renders that state with a retry, which
 * is what lets a user recover once the runtime is back.
 */
function selectBackend(): AgentBackend {
  const params = new URLSearchParams(window.location.search)
  const forceMock = params.get('backend') === 'mock'
  const desktop = window.agentControlDesktop?.gjc
  const browserOrigin =
    window.location.protocol === 'http:' || window.location.protocol === 'https:'
  if (forceMock || (!desktop && !browserOrigin)) {
    const mock = new MockAgentBackend()
    // The inspector smoke needs a session long enough that mounting every row would be
    // visible, to prove the transcript is windowed.
    const seed = Number.parseInt(params.get('seedTranscript') ?? '', 10)
    if (Number.isFinite(seed) && seed > 0) mock.seedLargeTranscript(seed)
    return mock
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

const backend = selectBackend()
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
