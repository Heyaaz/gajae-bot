import { createContext } from 'react'
import type { AgentBackend } from './agent-backend'

export const BackendContext = createContext<AgentBackend | null>(null)
