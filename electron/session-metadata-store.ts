import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { parseSessionWorkLink, type SessionWorkLink } from '../shared/agent-contract.js'
import { parseParallelGroup, type ParallelGroup } from '../shared/parallel-run.js'

export class SessionMetadataStore {
  private readonly filePath: string
  private aliases: Record<string, string>
  private workspaces: Record<string, string>
  private hidden: Set<string>
  private ownership: Record<string, 'gajae' | 'external' | 'available'>
  private unread: Record<string, boolean>
  private worktrees: Record<string, { sourceWorkspace: string; path: string; branch: string; managed: true }>
  private workLinks: Record<string, SessionWorkLink>
  private parallelGroups: Record<string, ParallelGroup>

  constructor(userDataDirectory: string) {
    this.filePath = path.join(userDataDirectory, 'agent-control-sessions.json')
    const stored = this.read()
    this.aliases = stored.aliases
    this.workspaces = stored.workspaces
    this.hidden = new Set(stored.hidden)
    this.ownership = stored.ownership
    this.unread = stored.unread
    this.worktrees = stored.worktrees
    this.workLinks = stored.workLinks
    this.parallelGroups = stored.parallelGroups
  }

  getAlias(sessionId: string): string | undefined {
    return this.aliases[sessionId]
  }

  setAlias(sessionId: string, title: string): void {
    const value = title.trim()
    if (!value) throw new Error('Session title cannot be empty')
    this.aliases[sessionId] = value
    this.write()
  }

  setWorkspace(sessionId: string, workspace: string): void {
    this.workspaces[sessionId] = path.resolve(workspace)
    this.hidden.delete(sessionId)
    this.write()
  }

  listWorkspaces(): string[] {
    return [...new Set(Object.values(this.workspaces))]
  }

  isHidden(sessionId: string): boolean {
    return this.hidden.has(sessionId)
  }

  getOwnership(sessionId: string): 'gajae' | 'external' | 'available' | undefined { return this.ownership[sessionId] }
  setOwnership(sessionId: string, value: 'gajae' | 'external' | 'available'): void { this.ownership[sessionId] = value; this.write() }
  getUnread(sessionId: string): boolean { return this.unread[sessionId] === true }
  setUnread(sessionId: string, value: boolean): void { this.unread[sessionId] = value; this.write() }
  getWorktree(sessionId: string) { return this.worktrees[sessionId] }
  setWorktree(sessionId: string, value: { sourceWorkspace: string; path: string; branch: string; managed: true }): void { this.worktrees[sessionId] = value; this.write() }
  getWorkLink(sessionId: string): SessionWorkLink | undefined { return this.workLinks[sessionId] }
  setWorkLink(sessionId: string, value: SessionWorkLink): void { this.workLinks[sessionId] = value; this.write() }
  listParallelGroups(): ParallelGroup[] { return Object.values(this.parallelGroups) }
  putParallelGroup(group: ParallelGroup): void { this.parallelGroups[group.id] = group; this.write() }

  hideSession(sessionId: string): void {
    this.hidden.add(sessionId)
    delete this.aliases[sessionId]
    delete this.workspaces[sessionId]
    delete this.ownership[sessionId]
    delete this.unread[sessionId]
    delete this.worktrees[sessionId]
    delete this.workLinks[sessionId]
    this.write()
  }

  /**
   * Forgets hidden ids the agent no longer knows about, returning how many were
   * dropped.
   *
   * `hidden` exists to keep a deleted session out of discovery. Once the agent has
   * forgotten the session there is nothing left to filter, but the id stayed on
   * disk forever -- 629 of them against three aliases in practice -- and every
   * write rewrote the whole file.
   */
  forgetHiddenOutside(knownSessionIds: ReadonlySet<string>): number {
    let dropped = 0
    for (const sessionId of [...this.hidden])
      if (!knownSessionIds.has(sessionId)) { this.hidden.delete(sessionId); dropped += 1 }
    if (dropped > 0) this.write()
    return dropped
  }

  retainOnly(allSessionIds: Iterable<string>, retained: ReadonlySet<string>): void {
    for (const sessionId of allSessionIds) {
      if (retained.has(sessionId)) this.hidden.delete(sessionId)
      else {
        this.hidden.add(sessionId)
        delete this.aliases[sessionId]
        delete this.workspaces[sessionId]
        delete this.ownership[sessionId]
        delete this.unread[sessionId]
        delete this.worktrees[sessionId]
        delete this.workLinks[sessionId]
      }
    }
    this.write()
  }

  deleteAlias(sessionId: string): void {
    if (!(sessionId in this.aliases)
      && !(sessionId in this.workspaces)
      && !(sessionId in this.ownership)
      && !(sessionId in this.unread)
      && !(sessionId in this.worktrees)
      && !(sessionId in this.workLinks)) return
    delete this.aliases[sessionId]
    delete this.workspaces[sessionId]
    delete this.ownership[sessionId]
    delete this.unread[sessionId]
    delete this.worktrees[sessionId]
    delete this.workLinks[sessionId]
    this.write()
  }

  private read(): { aliases: Record<string, string>; workspaces: Record<string, string>; hidden: string[]; ownership: Record<string, 'gajae' | 'external' | 'available'>; unread: Record<string, boolean>; worktrees: Record<string, { sourceWorkspace: string; path: string; branch: string; managed: true }>; workLinks: Record<string, SessionWorkLink>; parallelGroups: Record<string, ParallelGroup> } {
    try {
      const value = JSON.parse(readFileSync(this.filePath, 'utf8')) as unknown
      if (!value || typeof value !== 'object' || Array.isArray(value)) return { aliases: {}, workspaces: {}, hidden: [], ownership: {}, unread: {}, worktrees: {}, workLinks: {}, parallelGroups: {} }
      const candidate = value as { aliases?: unknown; workspaces?: unknown; hidden?: unknown; ownership?: unknown; unread?: unknown; worktrees?: unknown; workLinks?: unknown; parallelGroups?: unknown }
      const rawAliases = candidate.aliases && typeof candidate.aliases === 'object' && !Array.isArray(candidate.aliases)
        ? candidate.aliases as Record<string, unknown>
        : value as Record<string, unknown>
      const rawWorkspaces = candidate.workspaces && typeof candidate.workspaces === 'object' && !Array.isArray(candidate.workspaces)
        ? candidate.workspaces as Record<string, unknown>
        : {}
      const aliases = Object.fromEntries(
        Object.entries(rawAliases)
          .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && Boolean(entry[1].trim()))
          .map(([sessionId, title]) => [sessionId, title.trim()]),
      )
      const workspaces = Object.fromEntries(
        Object.entries(rawWorkspaces)
          .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && path.isAbsolute(entry[1]))
          .map(([sessionId, workspace]) => [sessionId, path.resolve(workspace)]),
      )
      const hidden = Array.isArray(candidate.hidden)
        ? candidate.hidden.filter((sessionId): sessionId is string => typeof sessionId === 'string' && Boolean(sessionId))
        : []
      const ownership = candidate.ownership && typeof candidate.ownership === 'object' ? Object.fromEntries(Object.entries(candidate.ownership).filter(([,v]) => v === 'gajae' || v === 'external' || v === 'available')) as typeof this.ownership : {}
      const unread = candidate.unread && typeof candidate.unread === 'object' ? Object.fromEntries(Object.entries(candidate.unread).filter(([,v]) => typeof v === 'boolean')) as Record<string, boolean> : {}
      const worktrees = candidate.worktrees && typeof candidate.worktrees === 'object' && !Array.isArray(candidate.worktrees)
        ? Object.fromEntries(Object.entries(candidate.worktrees as Record<string, unknown>).filter((entry): entry is [string, { sourceWorkspace: string; path: string; branch: string; managed: true }] => {
            const record = entry[1]
            if (!record || typeof record !== 'object' || Array.isArray(record)) return false
            const value = record as Record<string, unknown>
            return value.managed === true
              && typeof value.sourceWorkspace === 'string'
              && path.isAbsolute(value.sourceWorkspace)
              && typeof value.path === 'string'
              && path.isAbsolute(value.path)
              && typeof value.branch === 'string'
              && Boolean(value.branch)
          }))
        : {}
      const workLinks = candidate.workLinks && typeof candidate.workLinks === 'object' && !Array.isArray(candidate.workLinks)
        ? Object.fromEntries(Object.entries(candidate.workLinks as Record<string, unknown>).flatMap(([sessionId, raw]) => {
            const link = parseSessionWorkLink(raw)
            return link ? [[sessionId, link]] : []
          }))
        : {}
      const parallelGroups = candidate.parallelGroups && typeof candidate.parallelGroups === 'object' && !Array.isArray(candidate.parallelGroups)
        ? Object.fromEntries(Object.values(candidate.parallelGroups as Record<string, unknown>).flatMap((raw) => {
            const group = parseParallelGroup(raw)
            return group ? [[group.id, group]] : []
          }))
        : {}
      return { aliases, workspaces, hidden, ownership, unread, worktrees, workLinks, parallelGroups }
    } catch {
      return { aliases: {}, workspaces: {}, hidden: [], ownership: {}, unread: {}, worktrees: {}, workLinks: {}, parallelGroups: {} }
    }
  }

  private write(): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true })
    const temporaryPath = `${this.filePath}.tmp`
    writeFileSync(temporaryPath, `${JSON.stringify({ aliases: this.aliases, workspaces: this.workspaces, hidden: [...this.hidden], ownership: this.ownership, unread: this.unread, worktrees: this.worktrees, workLinks: this.workLinks, parallelGroups: this.parallelGroups }, null, 2)}\n`, { mode: 0o600 })
    renameSync(temporaryPath, this.filePath)
  }
}
