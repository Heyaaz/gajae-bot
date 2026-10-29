import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_DESKTOP_INTEGRATION } from '../shared/desktop-integration.js'
import {
  DEFAULT_MODEL_PRESET,
  DEFAULT_NOTIFICATION_PREFERENCES,
} from '../shared/agent-contract.js'
import { SettingsStore, parsePreferences, validDirectory } from './settings-store.js'
import { SessionMetadataStore } from './session-metadata-store.js'
import { fileAttachment, fileMimeType, pickerDirectory } from './settings-ipc-handlers.js'
import { AttachmentStore } from './attachment-store.js'

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

  it('returns an opaque capability without exposing the source path', async () => {
    const directory = temporaryDirectory()
    const file = path.join(directory, 'example.ts')
    writeFileSync(file, 'export const value = 1\n')
    const attachments = new AttachmentStore()
    attachments.activateSender(7)

    expect(fileMimeType(file)).toBe('text/typescript')
    const selected = await fileAttachment(file, attachments, 7)
    expect(selected).toMatchObject({
      name: 'example.ts',
      mimeType: 'text/typescript',
      size: 23,
    })
    expect(selected).not.toHaveProperty('path')
    expect(selected.token).toMatch(/^[A-Za-z0-9_-]{40,}$/u)
  })

  it('issues capabilities for supported and arbitrary local file types', async () => {
    const directory = temporaryDirectory()
    const unsupported = path.join(directory, 'archive.zip')
    const binary = path.join(directory, 'binary.txt')
    const oversized = path.join(directory, 'large.md')
    writeFileSync(unsupported, 'not accepted')
    writeFileSync(binary, Buffer.from([0, 1, 2]))
    writeFileSync(oversized, Buffer.alloc(2 * 1024 * 1024 + 1, 97))
    const attachments = new AttachmentStore()
    attachments.activateSender(7)

    await expect(fileAttachment(unsupported, attachments, 7)).resolves.toMatchObject({ mimeType: 'application/octet-stream' })
    await expect(fileAttachment(binary, attachments, 7)).resolves.toMatchObject({ size: 3 })
    await expect(fileAttachment(oversized, attachments, 7)).resolves.toMatchObject({ size: 2 * 1024 * 1024 + 1 })
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
      thoughtsExpanded: false,
      toolViewMode: 'reasoning',
      notificationPreferences: DEFAULT_NOTIFICATION_PREFERENCES,
      desktopIntegration: DEFAULT_DESKTOP_INTEGRATION,
      language: 'ko',
      runningSubmission: 'queue',
    })
  })

  it('accepts a configured custom GJC model profile', () => {
    const workspace = temporaryDirectory()
    expect(parsePreferences({ modelPreset: 'GOAT', workspace }, workspace).modelPreset).toBe('GOAT')
  })

  it('uses an existing directory and the public GJC preset for a fresh store', () => {
    const root = temporaryDirectory()
    const preferences = new SettingsStore(path.join(root, 'user-data'), root).get()

    expect(statSync(preferences.workspace).isDirectory()).toBe(true)
    expect(preferences.workspace).not.toContain('.asar')
    expect(preferences.modelPreset).toBe(DEFAULT_MODEL_PRESET)
  })

  it('rejects an asar path as the default workspace', () => {
    const asarPath = path.join(temporaryDirectory(), 'app.asar')
    // A directory reproduces Electron's fs view of a mounted asar. Existence and
    // isDirectory alone are insufficient even though ordinary Node sees an archive
    // as a file.
    mkdirSync(asarPath)
    const preferences = parsePreferences(undefined, asarPath)

    expect(validDirectory(asarPath)).toBe(false)
    expect(statSync(preferences.workspace).isDirectory()).toBe(true)
    expect(preferences.workspace).not.toBe(path.resolve(asarPath))
  })

  it('persists workspace, preset, permission mode, executable, and the reasoning-card preference', () => {
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
      thoughtsExpanded: true,
    })

    expect(saved).toEqual({ workspace, workspaceLabel: 'Client projects', modelPreset: 'my-custom-profile', permissionHandling: 'auto', gjcExecutable: executable, thoughtsExpanded: true, toolViewMode: 'reasoning', notificationPreferences: DEFAULT_NOTIFICATION_PREFERENCES, desktopIntegration: DEFAULT_DESKTOP_INTEGRATION, language: 'ko', runningSubmission: 'queue' })
    expect(new SettingsStore(userData, root).get()).toEqual(saved)
    expect(store.setWorkspaceLabel('Renamed workspace')).toBe('Renamed workspace')
    expect(new SettingsStore(userData, root).get().workspaceLabel).toBe('Renamed workspace')
  })

  it('persists notification preferences alone without a whole-object save', () => {
    const root = temporaryDirectory()
    const userData = path.join(root, 'user-data')
    const store = new SettingsStore(userData, root)
    const saved = store.setNotificationPreferences({
      completed: { enabled: false, sound: 'Glass' },
    })
    expect(saved.completed).toEqual({ enabled: false, sound: 'Glass' })
    expect(saved.failed).toEqual(DEFAULT_NOTIFICATION_PREFERENCES.failed)
    expect(new SettingsStore(userData, root).get().notificationPreferences).toEqual(saved)
  })

  it('persists desktop integration alone and refuses a non-object', () => {
    const root = temporaryDirectory()
    const userData = path.join(root, 'user-data')
    const store = new SettingsStore(userData, root)
    expect(store.get().desktopIntegration.preventSleep).toBe(true)
    expect(store.setDesktopIntegration({ preventSleep: false, dockBadge: false, checkAppUpdates: false, quickInputShortcut: '' })).toEqual({ preventSleep: false, menuBarStatus: true, dockBadge: false, checkAppUpdates: false, quickInputShortcut: '' })
    expect(new SettingsStore(userData, root).get().desktopIntegration).toEqual({ preventSleep: false, menuBarStatus: true, dockBadge: false, checkAppUpdates: false, quickInputShortcut: '' })
    expect(() => store.setDesktopIntegration('off')).toThrow('Desktop integration settings must be an object')
  })

  it('persists the resolved UI language alone', () => {
    const root = temporaryDirectory()
    const userData = path.join(root, 'user-data')
    const store = new SettingsStore(userData, root)
    expect(store.setLanguage('en')).toBe('en')
    expect(new SettingsStore(userData, root).get().language).toBe('en')
    expect(() => store.setLanguage('fr')).toThrow('UI language must be ko or en')
  })

  it('keeps accepted settings unchanged when persistence fails', () => {
    const root = temporaryDirectory()
    const userData = path.join(root, 'user-data')
    const store = new SettingsStore(userData, root)
    const original = store.save({
      workspace: root,
      workspaceLabel: 'Accepted workspace',
      modelPreset: 'codex-medium',
      permissionHandling: 'prompt',
      gjcExecutable: '',
      thoughtsExpanded: false,
    })
    const temporaryPath = path.join(userData, 'agent-control-settings.json.tmp')
    mkdirSync(temporaryPath)

    expect(() => store.setWorkspaceLabel('Rejected workspace')).toThrow()
    expect(store.get()).toEqual(original)
    expect(new SettingsStore(userData, root).get()).toEqual(original)

    rmSync(temporaryPath, { recursive: true })
    expect(store.setWorkspaceLabel('Persisted workspace')).toBe('Persisted workspace')
    expect(store.get().workspaceLabel).toBe('Persisted workspace')
    expect(new SettingsStore(userData, root).get().workspaceLabel).toBe('Persisted workspace')
  })

  it('toggles the reasoning-card preference alone and reads a missing or junk value as collapsed', () => {
    const root = temporaryDirectory()
    const userData = path.join(root, 'user-data')
    const store = new SettingsStore(userData, root)

    expect(store.get().thoughtsExpanded).toBe(false)
    expect(store.setThoughtsExpanded(true)).toBe(true)
    // The toggle writes one field: the rest of the object survives it untouched.
    expect(new SettingsStore(userData, root).get()).toMatchObject({ thoughtsExpanded: true, workspace: path.resolve(root), modelPreset: DEFAULT_MODEL_PRESET })

    // A file written before this preference existed carries no key at all.
    const file = path.join(userData, 'agent-control-settings.json')
    const stored = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    delete stored.thoughtsExpanded
    writeFileSync(file, JSON.stringify(stored))
    expect(new SettingsStore(userData, root).get().thoughtsExpanded).toBe(false)

    stored.thoughtsExpanded = 'yes'
    writeFileSync(file, JSON.stringify(stored))
    expect(new SettingsStore(userData, root).get().thoughtsExpanded).toBe(false)

    expect(parsePreferences({}, root).thoughtsExpanded).toBe(false)
    expect(parsePreferences({ thoughtsExpanded: 1 }, root).thoughtsExpanded).toBe(false)
    expect(parsePreferences({ thoughtsExpanded: null }, root).thoughtsExpanded).toBe(false)
  })

  it('saves a settings file that never carried the preference and refuses a junk one', () => {
    const root = temporaryDirectory()
    const store = new SettingsStore(path.join(root, 'user-data'), root)
    const base = { workspace: root, workspaceLabel: 'Private workspace', modelPreset: 'codex-medium', permissionHandling: 'prompt', gjcExecutable: '' }

    expect(store.validate(base).thoughtsExpanded).toBe(false)
    expect(store.validate({ ...base, thoughtsExpanded: true }).thoughtsExpanded).toBe(true)
    expect(() => store.validate({ ...base, thoughtsExpanded: 'open' })).toThrow('Thought card expansion must be a boolean')
  })

  it('persists the conversation density alone and reads missing or junk values as reasoning', () => {
    const root = temporaryDirectory()
    const userData = path.join(root, 'user-data')
    const store = new SettingsStore(userData, root)

    expect(store.get().toolViewMode).toBe('reasoning')
    expect(store.setToolViewMode('detailed')).toBe('detailed')
    // The setter writes one field: the rest of the object survives it untouched.
    expect(new SettingsStore(userData, root).get()).toMatchObject({ toolViewMode: 'detailed', workspace: path.resolve(root), modelPreset: DEFAULT_MODEL_PRESET })

    // A file written before this preference existed carries no key at all.
    const file = path.join(userData, 'agent-control-settings.json')
    const stored = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    delete stored.toolViewMode
    writeFileSync(file, JSON.stringify(stored))
    expect(new SettingsStore(userData, root).get().toolViewMode).toBe('reasoning')

    stored.toolViewMode = 'compact'
    writeFileSync(file, JSON.stringify(stored))
    expect(new SettingsStore(userData, root).get().toolViewMode).toBe('reasoning')
    expect(parsePreferences({ toolViewMode: 'detailed' }, root).toolViewMode).toBe('detailed')
    expect(parsePreferences({ toolViewMode: 1 }, root).toolViewMode).toBe('reasoning')
    expect(() => store.setToolViewMode('compact')).toThrow('Tool view mode must be basic, reasoning, or detailed')
  })

  it('validates a density value that is present', () => {
    const root = temporaryDirectory()
    const store = new SettingsStore(path.join(root, 'user-data'), root)
    const base = { workspace: root, workspaceLabel: 'Private workspace', modelPreset: 'codex-medium', permissionHandling: 'prompt', gjcExecutable: '' }

    expect(store.validate(base).toolViewMode).toBe('reasoning')
    expect(store.validate({ ...base, toolViewMode: 'basic' }).toolViewMode).toBe('basic')
    expect(() => store.validate({ ...base, toolViewMode: 'compact' })).toThrow('Tool view mode must be basic, reasoning, or detailed')
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
      thoughtsExpanded: false,
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
