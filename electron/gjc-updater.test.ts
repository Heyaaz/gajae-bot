import { describe, expect, it, vi } from 'vitest'
import { checkGjcUpdate, installGjcUpdate, parseGjcUpdateCheck } from './gjc-updater.js'

describe('GJC updater', () => {
  it('parses available and current releases', () => {
    expect(parseGjcUpdateCheck('Current version: 0.15.0\nNew version available: 0.15.2')).toEqual({
      currentVersion: '0.15.0',
      latestVersion: '0.15.2',
      updateAvailable: true,
    })
    expect(parseGjcUpdateCheck('Current version: 0.15.2\nAlready up to date')).toEqual({
      currentVersion: '0.15.2',
      latestVersion: '0.15.2',
      updateAvailable: false,
    })
  })

  it('checks without installing', async () => {
    const runner = vi.fn().mockResolvedValue({
      stdout: 'Current version: 0.15.0\nNew version available: 0.15.2',
      stderr: '',
    })

    await expect(checkGjcUpdate('/custom/gjc', runner)).resolves.toMatchObject({ updateAvailable: true })
    expect(runner).toHaveBeenCalledOnce()
    expect(runner).toHaveBeenCalledWith('/custom/gjc', ['update', '--check'])
  })

  it('installs once and verifies the resulting version', async () => {
    const runner = vi.fn()
      .mockResolvedValueOnce({ stdout: 'Updated GJC to 0.15.2', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'Current version: 0.15.2\nAlready up to date', stderr: '' })

    await expect(installGjcUpdate('gjc', runner)).resolves.toEqual({
      currentVersion: '0.15.2',
      latestVersion: '0.15.2',
      updateAvailable: false,
    })
    expect(runner).toHaveBeenNthCalledWith(1, 'gjc', ['update'])
    expect(runner).toHaveBeenNthCalledWith(2, 'gjc', ['update', '--check'])
  })

  it('rejects malformed check output', () => {
    expect(() => parseGjcUpdateCheck('network proxy returned HTML')).toThrow('현재 버전')
  })
})
