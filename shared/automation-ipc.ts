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

export type AutomationRunTrigger = 'scheduled' | 'catch-up' | 'manual'

export type AutomationRun = {
  id: string
  automationId: string
  status: 'running' | 'completed' | 'failed' | 'skipped'
  /** How this run was started. Older records lack the field and are manual. */
  trigger?: AutomationRunTrigger
  /** The scheduled occurrence this run covers, for scheduled and catch-up runs. */
  scheduledFor?: string
  /** Human-readable explanation on skipped and catch-up runs. */
  reason?: string
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
