import { app } from 'electron'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// Imported before anything else in a smoke so the run never touches a persistent profile.
// An explicit GJC_CODING_AGENT_DIR is kept: a smoke that needs a real GJC profile sets it.
if (!process.env.GJC_CODING_AGENT_DIR?.trim()) {
  process.env.GJC_CODING_AGENT_DIR = mkdtempSync(path.join(tmpdir(), 'gajae-smoke-gjc-'))
}
app.setPath('userData', mkdtempSync(path.join(tmpdir(), 'gajae-smoke-')))
