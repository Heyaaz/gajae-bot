import { randomBytes } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import path from 'node:path'

export type AttachmentKind = 'image' | 'file'

export interface AttachmentMetadata {
  name: string
  mimeType: string
  size: number
  mtimeMs: number
}

export interface AttachmentRecord extends AttachmentMetadata {
  token: string
  kind: AttachmentKind
}

export interface AttachmentLease extends AttachmentRecord {
  /** Native path is available only to trusted main-process consumers. */
  nativePath: string
}

type Handle = AttachmentLease & { senderId: number; expiresAt: number; acquired: boolean }

const TTL_MS = 24 * 60 * 60 * 1000
const RELEASED_TTL_MS = 5 * 60 * 1000
const MAX_HANDLES = 100
const MAX_BYTES = 100 * 1024 * 1024
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u

export class AttachmentStore {
  private readonly handles = new Map<string, Handle>()
  private readonly senderUsage = new Map<number, { count: number; bytes: number }>()
  private readonly senderEpochs = new Map<number, number>()
  private readonly activeSenders = new Set<number>()

  activateSender(senderId: number): void {
    if (!Number.isSafeInteger(senderId)) throw new Error('Invalid attachment owner')
    this.senderEpochs.set(senderId, (this.senderEpochs.get(senderId) ?? 0) + 1)
    this.activeSenders.add(senderId)
  }

  async issue(senderId: number, kind: AttachmentKind, filePath: string, metadata: AttachmentMetadata): Promise<AttachmentRecord> {
    this.purgeExpired()
    const epoch = this.activeEpoch(senderId)
    if (!Number.isSafeInteger(metadata.size) || metadata.size < 0 || !Number.isFinite(metadata.mtimeMs)) throw new Error('Invalid attachment metadata')
    const nativePath = await realpath(path.resolve(filePath))
    if (!path.isAbsolute(nativePath) || /[\0\r\n]/u.test(nativePath)) throw new Error('Invalid attachment path')
    const info = await stat(nativePath)
    if (!info.isFile() || info.size !== metadata.size || info.mtimeMs !== metadata.mtimeMs) throw new Error('Attachment changed')
    this.assertActiveEpoch(senderId, epoch)
    const usage = this.senderUsage.get(senderId) ?? { count: 0, bytes: 0 }
    if (usage.count >= MAX_HANDLES || usage.bytes + metadata.size > MAX_BYTES) throw new Error('Attachment limit exceeded')
    let token = randomBytes(32).toString('base64url')
    while (this.handles.has(token)) token = randomBytes(32).toString('base64url')
    const handle: Handle = { token, kind, nativePath, ...metadata, senderId, expiresAt: Date.now() + TTL_MS, acquired: false }
    this.handles.set(token, handle)
    this.senderUsage.set(senderId, { count: usage.count + 1, bytes: usage.bytes + metadata.size })
    return this.publicRecord(handle)
  }

  async acquire(senderId: number, tokens: string[]): Promise<AttachmentLease[]> {
    this.purgeExpired()
    const epoch = this.activeEpoch(senderId)
    if (!Array.isArray(tokens) || tokens.length === 0 || tokens.some((token) => typeof token !== 'string' || !TOKEN_PATTERN.test(token)) || new Set(tokens).size !== tokens.length) throw new Error('Invalid attachment tokens')
    const now = Date.now()
    const candidates: Handle[] = []
    for (const token of tokens) {
      const handle = this.handles.get(token)
      if (!handle || handle.senderId !== senderId || handle.acquired || handle.expiresAt <= now) {
        for (const reserved of candidates) reserved.acquired = false
        throw new Error('Attachment is unavailable')
      }
      handle.acquired = true
      candidates.push(handle)
    }
    try {
      // Handles are reserved before the first await, closing concurrent double-acquire.
      for (const handle of candidates) {
      let current
      try {
        const canonical = await realpath(handle.nativePath)
        current = await stat(canonical)
        if (!current.isFile() || canonical !== handle.nativePath || current.size !== handle.size || current.mtimeMs !== handle.mtimeMs) throw new Error('changed')
      } catch {
        throw new Error(`${handle.name} is no longer available`)
      }
      this.assertActiveEpoch(senderId, epoch)
      for (const handle of candidates)
        if (this.handles.get(handle.token) !== handle)
          throw new Error('Attachment is unavailable')
      }
    } catch (error) {
      for (const handle of candidates) handle.acquired = false
      throw error
    }
    return candidates.map((handle) => ({
      token: handle.token, kind: handle.kind, name: handle.name,
      mimeType: handle.mimeType, size: handle.size, mtimeMs: handle.mtimeMs,
      nativePath: handle.nativePath,
    }))
  }

  commit(senderId: number, tokens: string[]): void {
    this.remove(senderId, tokens, true)
  }

  release(senderId: number, tokens: string[]): void {
    for (const token of tokens) {
      const handle = this.handles.get(token)
      if (handle && handle.senderId !== senderId) throw new Error('Attachment is unavailable')
    }
    for (const token of tokens) {
      const handle = this.handles.get(token)
      if (handle?.senderId === senderId) {
        handle.acquired = false
        handle.expiresAt = Math.min(handle.expiresAt, Date.now() + RELEASED_TTL_MS)
      }
    }
  }

  revoke(senderId: number, tokens: string[]): void {
    for (const token of tokens) {
      const handle = this.handles.get(token)
      if (handle && handle.senderId !== senderId) throw new Error('Attachment is unavailable')
      if (handle?.senderId === senderId && handle.acquired)
        throw new Error('Attachment is in use')
    }
    for (const token of tokens) {
      const handle = this.handles.get(token)
      if (handle?.senderId === senderId) this.removeExisting(handle)
    }
  }

  revokeSender(senderId: number): void {
    this.activeSenders.delete(senderId)
    this.senderEpochs.set(senderId, (this.senderEpochs.get(senderId) ?? 0) + 1)
    for (const [token, handle] of this.handles) if (handle.senderId === senderId) this.handles.delete(token)
    this.senderUsage.delete(senderId)
  }

  dispose(): void {
    this.handles.clear()
    this.senderUsage.clear()
    this.activeSenders.clear()
    this.senderEpochs.clear()
  }

  private purgeExpired(): void {
    const now = Date.now()
    for (const [token, handle] of this.handles) {
      if (handle.expiresAt <= now && !handle.acquired) {
        this.handles.delete(token)
        const usage = this.senderUsage.get(handle.senderId)
        if (usage) {
          usage.count -= 1; usage.bytes -= handle.size
          if (usage.count <= 0) this.senderUsage.delete(handle.senderId)
        }
      }
    }
  }

  private remove(senderId: number, tokens: string[], requireAcquired: boolean): void {
    for (const token of tokens) {
      const handle = this.handles.get(token)
      if (!handle || handle.senderId !== senderId || (requireAcquired && !handle.acquired)) throw new Error('Attachment is unavailable')
    }
    for (const token of tokens) {
      const handle = this.handles.get(token)!
      this.removeExisting(handle)
    }
  }

  private activeEpoch(senderId: number): number {
    if (!Number.isSafeInteger(senderId) || !this.activeSenders.has(senderId))
      throw new Error('Attachment owner is unavailable')
    return this.senderEpochs.get(senderId) ?? 0
  }

  private assertActiveEpoch(senderId: number, epoch: number): void {
    if (!this.activeSenders.has(senderId) || this.senderEpochs.get(senderId) !== epoch)
      throw new Error('Attachment owner is unavailable')
  }

  private removeExisting(handle: Handle): void {
    this.handles.delete(handle.token)
    const usage = this.senderUsage.get(handle.senderId)
    if (usage) {
      usage.count -= 1
      usage.bytes -= handle.size
      if (usage.count <= 0) this.senderUsage.delete(handle.senderId)
    }
  }

  private publicRecord(handle: Handle): AttachmentRecord {
    const { token, kind, name, mimeType, size, mtimeMs } = handle
    return Object.freeze({ token, kind, name, mimeType, size, mtimeMs })
  }
}
