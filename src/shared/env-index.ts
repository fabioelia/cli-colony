/**
 * Environment index — tracks where each environment lives on disk.
 * Stored at ~/.claude-colony/environments.json
 *
 * Format: { "<envId>": "<absolute-path-to-env-dir>", ... }
 */

import * as fs from 'fs'
import { colonyPaths } from './colony-paths'
import { JsonFile } from './json-file'

export type EnvIndex = Record<string, string>

const indexFile = new JsonFile<EnvIndex>(colonyPaths.envIndex, {})

export function readIndex(): EnvIndex {
  return indexFile.read()
}

export function writeIndex(index: EnvIndex): void {
  try {
    indexFile.write(index)
  } catch (err) {
    console.error('[env-index] failed to write:', err)
  }
}

export function addToIndex(envId: string, envDir: string): void {
  const index = readIndex()
  index[envId] = envDir
  writeIndex(index)
}

export function removeFromIndex(envId: string): void {
  const index = readIndex()
  delete index[envId]
  writeIndex(index)
}

/** Get all known environment directories (deduped, existing only) */
export function allEnvDirs(): Array<{ id: string; dir: string }> {
  const index = readIndex()
  const results: Array<{ id: string; dir: string }> = []
  for (const [id, dir] of Object.entries(index)) {
    if (fs.existsSync(dir)) {
      results.push({ id, dir })
    }
  }
  return results
}
