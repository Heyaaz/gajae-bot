import type { ReactNode } from 'react'
import type { AgentBackend } from './agent-backend'
import { BackendContext } from './backend-context'

interface BackendProviderProps {
  backend: AgentBackend
  children: ReactNode
}

export function BackendProvider({ backend, children }: BackendProviderProps) {
  return <BackendContext.Provider value={backend}>{children}</BackendContext.Provider>
}
