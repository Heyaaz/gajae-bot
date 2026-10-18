import { readFile, stat } from 'node:fs/promises'
import { AutomationService } from './automation-service.js'
import type { Automation } from '../shared/automation-ipc.js'

export type AutomationWorkerConfig = { automation: Automation; directory: string; gjcExecutable: string }

export async function runAutomationWorker(configPath: string): Promise<void> {
  if (typeof configPath !== 'string' || !configPath.startsWith('/')) throw new Error('config path must be absolute')
  if ((await stat(configPath)).size > 128 * 1024) throw new Error('worker config is too large')
  const config = JSON.parse(await readFile(configPath, 'utf8')) as AutomationWorkerConfig
  if (!config || !config.automation || !config.directory || !config.gjcExecutable) throw new Error('invalid worker config')
  const service = new AutomationService({ directory: config.directory, gjcExecutable: config.gjcExecutable, platform: 'none' })
  // launchd supplies the wake, not the occurrence. The service derives the most
  // recent scheduled occurrence and applies the catch-up policy from it.
  await service.runScheduled(config.automation.id)
}

if (process.argv[1]?.endsWith('automation-worker.js')) {
  const configPath = process.argv[2]
  if (!configPath) { console.error('missing automation config path'); process.exitCode = 1 }
  else runAutomationWorker(configPath).catch((error) => { console.error(error); process.exitCode = 1 })
}
