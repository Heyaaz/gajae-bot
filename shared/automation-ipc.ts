export const AUTOMATION_IPC = {
  list: 'automation:list',
  create: 'automation:create',
  updateEnabled: 'automation:update-enabled',
  delete: 'automation:delete',
  listRuns: 'automation:list-runs',
  runNow: 'automation:run-now',
} as const

export type AutomationSchedule = {
  kind: 'daily' | 'weekdays' | 'weekly'
  time: `${number}${number}:${number}${number}`
  weekday?: number
}

export type Automation = {
  id: string
  name: string
  prompt: string
  workspace: string
  schedule: AutomationSchedule
  enabled: boolean
  modelProfile?: string
  thinking?: string
  worktree: boolean
  createdAt: string
  updatedAt: string
  nextRunAt: string | null
}

export type AutomationRun = {
  id: string
  automationId: string
  status: 'running' | 'completed' | 'failed' | 'skipped'
  startedAt: string
  finishedAt: string | null
  exitCode: number | null
  output: string
  error: string
}

export type AutomationInput = Omit<Automation, 'id' | 'createdAt' | 'updatedAt' | 'nextRunAt'>

export interface AutomationDesktopBridge {
  list(): Promise<Automation[]>
  create(input: AutomationInput): Promise<Automation>
  updateEnabled(id: string, enabled: boolean): Promise<Automation>
  delete(id: string): Promise<void>
  listRuns(automationId?: string): Promise<AutomationRun[]>
  runNow(id: string): Promise<AutomationRun>
}
