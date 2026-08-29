import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import type { AgentBackend } from './backend/agent-backend'
import { BackendProvider } from './backend/backend-provider'
import { GjcAgentBackend } from './backend/gjc-agent-backend'
import { MockAgentBackend } from './backend/mock-agent-backend'
import './index.css'

/**
 * Chooses the backend this window will run on.
 *
 * The mock backend exists for UI work and for the `--smoke` run, so it is reachable
 * only by asking for it explicitly. It must never stand in for a real runtime that
 * failed: it answers `state: "connected"` with invented sessions and transcripts, so
 * substituting it showed a green dot and a working-looking window while nothing was
 * attached. The whole point of this app is that its screen is the source of truth
 * about the agent, which makes a silent swap to fiction the worst thing it can do.
 *
 * A GJC backend that cannot connect is returned anyway. It reports its own failure
 * through `getConnection`, and the shell renders that state with a retry, which is
 * what lets a user recover once the runtime is back.
 */
function selectBackend(): AgentBackend {
  const params = new URLSearchParams(window.location.search)
  const forceMock = params.get('backend') === 'mock'
  if (forceMock || !window.agentControlDesktop?.gjc) {
    const mock = new MockAgentBackend()
    // The inspector smoke needs a session long enough that mounting every row would be
    // visible, to prove the transcript is windowed.
    const seed = Number.parseInt(params.get('seedTranscript') ?? '', 10)
    if (Number.isFinite(seed) && seed > 0) mock.seedLargeTranscript(seed)
    return mock
  }
  return new GjcAgentBackend(window.agentControlDesktop.gjc)
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
