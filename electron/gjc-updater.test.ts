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

  it('trusts an offered version over a stale up-to-date line', () => {
    // Verified against gjc/0.15.3: `gjc update --check` prints "Current version: X"
    // followed by either an offer or a success line, and it has no --json mode, so this
    // text is the only signal available.
    //
    // The up-to-date phrase used to veto the offer. Any output carrying both -- a
    // progress line kept alongside the result, a cached success notice, a reworded
    // release step -- reported no update while a newer version was named, so the
    // sidebar hid the update the user was being offered.
    expect(
      parseGjcUpdateCheck(
        'Current version: 0.15.3\nNew version available: 0.16.0\n✔ Already up to date',
      ),
    ).toEqual({
      currentVersion: '0.15.3',
      latestVersion: '0.16.0',
      updateAvailable: true,
    })
  })

  it('parses the installed release output verbatim', () => {
    // Captured from gjc/0.15.3 on this machine, checkmark and all.
    expect(parseGjcUpdateCheck('Current version: 0.15.3\n✔ Already up to date\n')).toEqual({
      currentVersion: '0.15.3',
      latestVersion: '0.15.3',
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
