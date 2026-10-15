import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import type { AgentControlPreferences, GjcPermissionHandling } from '../shared/agent-contract.js'
import { DEFAULT_MODEL_PRESET } from '../shared/agent-contract.js'

const PERMISSION_MODES = new Set<GjcPermissionHandling>(['prompt', 'auto', 'always-allow'])

function validModelPreset(value: unknown): value is string {
  return typeof value === 'string'
    && value.trim().length > 0
    && value.trim().length <= 128
    && !/[\p{Cc}\p{Cf}]/u.test(value)
}

export function validDirectory(value: unknown): value is string {
  if (typeof value !== 'string' || !path.isAbsolute(value) || !existsSync(value)) return false
  // Electron patches fs so an app.asar archive reports itself as a virtual
  // directory. It is still not a legal process cwd: Node spawn rejects it with
  // ENOTDIR. Reject the archive and every virtual path inside it explicitly.
  if (value.split(path.sep).some((segment) => segment.toLowerCase().endsWith('.asar'))) return false
  try {
    return statSync(value).isDirectory()
  } catch {
    return false
  }
}

function validExecutable(value: unknown): value is string {
  if (value === '') return true
  if (typeof value !== 'string' || !path.isAbsolute(value)) return false
  try {
    accessSync(value, constants.X_OK)
    return true
  } catch {
    return false
  }
}

export function parsePreferences(value: unknown, defaultWorkspace: string): AgentControlPreferences {
  const candidate = value && typeof value === 'object'
    ? value as Partial<AgentControlPreferences>
    : {}
  return {
    workspace: validDirectory(candidate.workspace)
      ? path.resolve(candidate.workspace)
      : validDirectory(defaultWorkspace)
        ? path.resolve(defaultWorkspace)
        : homedir(),
    workspaceLabel: typeof candidate.workspaceLabel === 'string' && candidate.workspaceLabel.trim()
      ? candidate.workspaceLabel.trim().slice(0, 60)
      : 'Private workspace',
    modelPreset: validModelPreset(candidate.modelPreset)
      ? candidate.modelPreset.trim()
      : DEFAULT_MODEL_PRESET,
    permissionHandling: PERMISSION_MODES.has(candidate.permissionHandling as GjcPermissionHandling)
      ? candidate.permissionHandling as GjcPermissionHandling
      : 'prompt',
    gjcExecutable: validExecutable(candidate.gjcExecutable) ? candidate.gjcExecutable : '',
  }
}

export class SettingsStore {
  private readonly filePath: string
  private readonly defaultWorkspace: string
  private preferences: AgentControlPreferences

  constructor(userDataDirectory: string, defaultWorkspace: string) {
    this.filePath = path.join(userDataDirectory, 'agent-control-settings.json')
    this.defaultWorkspace = validDirectory(defaultWorkspace) ? path.resolve(defaultWorkspace) : homedir()
    this.preferences = this.read()
  }

  get(): AgentControlPreferences {
    return { ...this.preferences }
  }

  validate(value: unknown): AgentControlPreferences {
    const preferences = parsePreferences(value, this.defaultWorkspace)
    if (!validDirectory((value as Partial<AgentControlPreferences> | null)?.workspace)) {
      throw new Error('Workspace must be an existing absolute directory')
    }
    if (!validModelPreset((value as Partial<AgentControlPreferences> | null)?.modelPreset)) {
      throw new Error('GJC model profile must be a non-empty profile ID of at most 128 characters')
    }
    if (!PERMISSION_MODES.has((value as Partial<AgentControlPreferences> | null)?.permissionHandling as GjcPermissionHandling)) {
      throw new Error('Unsupported GJC permission mode')
    }
    if (!validExecutable((value as Partial<AgentControlPreferences> | null)?.gjcExecutable)) {
      throw new Error('GJC executable must be blank or an executable absolute path')
    }

    return preferences
  }

  save(value: unknown): AgentControlPreferences {
    const preferences = this.validate(value)
    this.preferences = preferences
    this.persist()
    return this.get()
  }

  setWorkspaceLabel(value: unknown): string {
    if (typeof value !== 'string' || !value.trim()) throw new Error('Workspace name cannot be empty')
    this.preferences = { ...this.preferences, workspaceLabel: value.trim().slice(0, 60) }
    this.persist()
    return this.preferences.workspaceLabel
  }

  private persist(): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true })
    const temporaryPath = `${this.filePath}.tmp`
    writeFileSync(temporaryPath, `${JSON.stringify(this.preferences, null, 2)}\n`, { mode: 0o600 })
    renameSync(temporaryPath, this.filePath)
  }

  private read(): AgentControlPreferences {
    try {
      return parsePreferences(JSON.parse(readFileSync(this.filePath, 'utf8')), this.defaultWorkspace)
    } catch {
      return parsePreferences(undefined, this.defaultWorkspace)
    }
  }
}
