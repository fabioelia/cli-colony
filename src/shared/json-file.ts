/**
 * Simple JSON file read/write utility.
 * Provides a consistent pattern for JSON config files with ensured directories and defaults.
 */

import * as fs from 'fs'
import * as path from 'path'

export class JsonFile<T> {
  constructor(
    private filePath: string,
    private defaults: T,
  ) {}

  /** Read the JSON file, returning defaults if it doesn't exist or is corrupt. */
  read(): T {
    try {
      if (fs.existsSync(this.filePath)) {
        return JSON.parse(fs.readFileSync(this.filePath, 'utf-8'))
      }
    } catch { /* corrupt or unreadable */ }
    return this.defaults
  }

  /** Write data to the JSON file, creating parent directories as needed. */
  write(data: T): void {
    const dir = path.dirname(this.filePath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2), 'utf-8')
  }
}
