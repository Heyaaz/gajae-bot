import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SettingsStore, parsePreferences } from './settings-store.js'
import { SessionMetadataStore } from './session-metadata-store.js'
import { fileAttachment, fileMimeType, pickerDirectory } from './settings-ipc-handlers.js'

const temporaryDirectories: string[] = []

function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'agent-control-settings-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('text file attachments', () => {
  it('uses existing picker directories and falls back from vanished paths', async () => {
    const directory = temporaryDirectory()

    await expect(pickerDirectory(directory)).resolves.toBe(directory)
    await expect(pickerDirectory(path.join(directory, 'vanished'), directory)).resolves.toBe(directory)
  })

  it('references source files by absolute path without reading their contents', async () => {
    const directory = temporaryDirectory()
    const file = path.join(directory, 'example.ts')
    writeFileSync(file, 'export const value = 1\n')

    expect(fileMimeType(file)).toBe('text/typescript')
    await expect(fileAttachment(file)).resolves.toMatchObject({
      name: 'example.ts',
      mimeType: 'text/typescript',
      size: 23,
      path: file,
    })
  })

  it('accepts arbitrary local file types and sizes as path references', async () => {
    const directory = temporaryDirectory()
    const unsupported = path.join(directory, 'archive.zip')
    const binary = path.join(directory, 'binary.txt')
    const oversized = path.join(directory, 'large.md')
    writeFileSync(unsupported, 'not accepted')
    writeFileSync(binary, Buffer.from([0, 1, 2]))
    writeFileSync(oversized, Buffer.alloc(2 * 1024 * 1024 + 1, 97))

    await expect(fileAttachment(unsupported)).resolves.toMatchObject({ path: unsupported, mimeType: 'application/octet-stream' })
    await expect(fileAttachment(binary)).resolves.toMatchObject({ path: binary, size: 3 })
    await expect(fileAttachment(oversized)).resolves.toMatchObject({ path: oversized, size: 2 * 1024 * 1024 + 1 })
  })
})

describe('SettingsStore', () => {
  it('uses safe defaults for missing or invalid persisted values', () => {
    const workspace = temporaryDirectory()
    expect(parsePreferences({ modelPreset: '', permissionHandling: 'unsafe' }, workspace)).toEqual({
      workspace,
      workspaceLabel: 'Private workspace',
      modelPreset: 'codex-medium',
      permissionHandling: 'prompt',
      gjcExecutable: '',
    })
  })

  it('accepts a configured custom GJC model profile', () => {
    const workspace = temporaryDirectory()
    expect(parsePreferences({ modelPreset: 'GOAT', workspace }, workspace).modelPreset).toBe('GOAT')
  })

  it('persists workspace, preset, permission mode, and executable', () => {
    const root = temporaryDirectory()
    const userData = path.join(root, 'user-data')
    const workspace = path.join(root, 'workspace')
    const executable = path.join(root, 'gjc')
    mkdirSync(workspace)
    writeFileSync(executable, '#!/bin/sh\n')
    chmodSync(executable, 0o700)

    const store = new SettingsStore(userData, root)
    const saved = store.save({
      workspace,
      workspaceLabel: 'Client projects',
      modelPreset: 'my-custom-profile',
      permissionHandling: 'auto',
      gjcExecutable: executable,
    })

    expect(saved).toEqual({ workspace, workspaceLabel: 'Client projects', modelPreset: 'my-custom-profile', permissionHandling: 'auto', gjcExecutable: executable })
    expect(new SettingsStore(userData, root).get()).toEqual(saved)
    expect(store.setWorkspaceLabel('Renamed workspace')).toBe('Renamed workspace')
    expect(new SettingsStore(userData, root).get().workspaceLabel).toBe('Renamed workspace')
  })

  it('rejects invalid workspace scope', () => {
    const root = temporaryDirectory()
    const store = new SettingsStore(path.join(root, 'user-data'), root)
    expect(() => store.save({
      workspace: path.join(root, 'missing'),
      workspaceLabel: 'Private workspace',
      modelPreset: 'codex-medium',
      permissionHandling: 'prompt',
      gjcExecutable: '',
    })).toThrow('Workspace must be an existing absolute directory')
  })
})

describe('SessionMetadataStore', () => {
  it('persists rename aliases and project scopes and removes them on deletion', () => {
    const userData = temporaryDirectory()
    const store = new SessionMetadataStore(userData)
    store.setAlias('session-1', 'Renamed session')
    store.setWorkspace('session-1', '/tmp/project-one')
    expect(new SessionMetadataStore(userData).getAlias('session-1')).toBe('Renamed session')
    expect(new SessionMetadataStore(userData).listWorkspaces()).toEqual(['/tmp/project-one'])

    store.deleteAlias('session-1')
    expect(new SessionMetadataStore(userData).getAlias('session-1')).toBeUndefined()
    expect(new SessionMetadataStore(userData).listWorkspaces()).toEqual([])

    store.hideSession('session-2')
    expect(new SessionMetadataStore(userData).isHidden('session-2')).toBe(true)
  })
})
