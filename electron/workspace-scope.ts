import path from 'node:path'

/** The user's home and the folders under it that hold files from many projects. */
export function broadFolders(home: string): string[] {
  return [home, ...['Documents', 'Desktop', 'Downloads'].map((name) => path.join(home, name))]
}

/**
 * Folders that hold a person's whole life rather than one project. An agent
 * started in one can read and change everything beneath it.
 */
export function isBroadWorkspace(directory: string, folders: readonly string[]): boolean {
  const target = path.resolve(directory)
  return target === path.parse(target).root || folders.some((folder) => path.resolve(folder) === target)
}
