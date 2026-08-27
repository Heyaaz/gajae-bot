import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import type { AgentBackend } from './backend/agent-backend'
import { BackendProvider } from './backend/backend-provider'
import { GjcAgentBackend } from './backend/gjc-agent-backend'
import { MockAgentBackend } from './backend/mock-agent-backend'
import './index.css'

async function selectBackend(): Promise<AgentBackend> {
  const forceMock = new URLSearchParams(window.location.search).get('backend') === 'mock'
  if (forceMock || !window.agentControlDesktop?.gjc) return new MockAgentBackend()

  const backend = new GjcAgentBackend(window.agentControlDesktop.gjc)
  const connection = await backend.getConnection()
  if (connection.state === 'connected') return backend

  console.error(`GJC connection unavailable: ${connection.detail}`)
  backend.dispose()
  return new MockAgentBackend()
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
