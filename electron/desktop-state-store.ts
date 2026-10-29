import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/**
 * What the main process remembers on its own behalf, as opposed to what the user
 * chose.
 *
 * Kept out of the preferences file on purpose: the renderer saves its whole
 * desktop-integration object, so a value the host wrote there would be overwritten
 * by the next toggle from a window that read it earlier.
 */
export interface DesktopState {
  /** The newest Gajae version the user has already been told about. */
  announcedAppVersion?: string
  /**
   * Every required environment check has passed once. Until then the check opens
   * at launch; after that it lives only in settings.
   */
  environmentReady?: boolean
}

export class DesktopStateStore {
  private readonly filePath: string
  private state: DesktopState

  constructor(userDataDirectory: string) {
    this.filePath = path.join(userDataDirectory, 'agent-control-desktop-state.json')
    this.state = this.read()
  }

  get(): DesktopState {
    return { ...this.state }
  }

  update(patch: Partial<DesktopState>): void {
    const next = { ...this.state, ...patch }
    mkdirSync(path.dirname(this.filePath), { recursive: true })
    const temporaryPath = `${this.filePath}.tmp`
    writeFileSync(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
    renameSync(temporaryPath, this.filePath)
    this.state = next
  }

  private read(): DesktopState {
    try {
      const value = JSON.parse(readFileSync(this.filePath, 'utf8')) as Record<string, unknown>
      return {
        ...(typeof value.announcedAppVersion === 'string'
          ? { announcedAppVersion: value.announcedAppVersion }
          : {}),
        ...(value.environmentReady === true ? { environmentReady: true } : {}),
      }
    } catch {
      return {}
    }
  }
}
