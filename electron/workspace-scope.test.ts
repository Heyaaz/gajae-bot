import { describe, expect, it } from 'vitest'
import { broadFolders, isBroadWorkspace } from './workspace-scope.js'

describe('isBroadWorkspace', () => {
  const folders = broadFolders('/Users/kim')

  it.each(['/Users/kim', '/Users/kim/', '/Users/kim/Documents', '/Users/kim/Desktop', '/Users/kim/Downloads/', '/'])(
    'warns for %s',
    (directory) => expect(isBroadWorkspace(directory, folders)).toBe(true),
  )

  it.each(['/Users/kim/Documents/blog', '/Users/kim/pro/app', '/Users/kim2', '/tmp/project', '/Users/kim/Documents2'])(
    'accepts %s as a project',
    (directory) => expect(isBroadWorkspace(directory, folders)).toBe(false),
  )

  it('also warns for folders the platform reports under a different home', () => {
    expect(isBroadWorkspace('/Volumes/data/Documents', [...folders, '/Volumes/data/Documents'])).toBe(true)
  })
})
