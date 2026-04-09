import { ipcMain } from 'electron'
import { promises as fsp } from 'fs'
import * as path from 'path'
import * as os from 'os'
import { colonyPaths } from '../../shared/colony-paths'
import type { OutputEntry } from '../../shared/types'

const MAX_READ_BYTES = 32 * 1024 // 32KB cap

async function safeReadDir(dir: string, depth: number): Promise<{ name: string; path: string; mtime: number }[]> {
  const entries: { name: string; path: string; mtime: number }[] = []
  try {
    const items = await fsp.readdir(dir, { withFileTypes: true })
    for (const item of items) {
      const fullPath = path.join(dir, item.name)
      if (item.isDirectory() && depth < 2) {
        entries.push(...await safeReadDir(fullPath, depth + 1))
      } else if (item.isFile()) {
        try {
          const stat = await fsp.stat(fullPath)
          entries.push({ name: item.name, path: fullPath, mtime: stat.mtimeMs })
        } catch { /* skip */ }
      }
    }
  } catch { /* skip */ }
  return entries
}

function extractAgentId(filePath: string): string {
  const colonyBase = path.join(os.homedir(), '.claude-colony')
  const outputsBase = path.join(colonyBase, 'outputs')
  const personasBase = path.join(colonyBase, 'personas')

  if (filePath.startsWith(outputsBase + path.sep)) {
    const rel = filePath.slice(outputsBase.length + 1)
    const parts = rel.split(path.sep)
    return parts[0] || 'unknown'
  }
  if (filePath.startsWith(personasBase + path.sep)) {
    return 'persona'
  }
  return 'unknown'
}

export function registerOutputsHandlers(): void {
  ipcMain.handle('outputs:list', async (): Promise<OutputEntry[]> => {
    const colonyBase = path.join(os.homedir(), '.claude-colony')
    const outputsDir = path.join(colonyBase, 'outputs')
    const personasDir = path.join(colonyBase, 'personas')

    const results: OutputEntry[] = []

    // Scan outputs/ (depth 2)
    try {
      const files = await safeReadDir(outputsDir, 0)
      for (const f of files) {
        try {
          const stat = await fsp.stat(f.path)
          results.push({
            path: f.path,
            name: path.basename(f.path),
            agentId: extractAgentId(f.path),
            mtime: f.mtime,
            sizeBytes: stat.size,
            type: 'artifact',
          })
        } catch { /* skip */ }
      }
    } catch { /* dir doesn't exist */ }

    // Scan personas/*.brief.md
    try {
      const items = await fsp.readdir(personasDir, { withFileTypes: true })
      for (const item of items) {
        if (item.isFile() && item.name.endsWith('.brief.md')) {
          const fullPath = path.join(personasDir, item.name)
          try {
            const stat = await fsp.stat(fullPath)
            const personaId = item.name.replace('.brief.md', '')
            results.push({
              path: fullPath,
              name: item.name,
              agentId: personaId,
              mtime: stat.mtimeMs,
              sizeBytes: stat.size,
              type: 'brief',
            })
          } catch { /* skip */ }
        }
      }
    } catch { /* dir doesn't exist */ }

    // Sort newest first
    results.sort((a, b) => b.mtime - a.mtime)
    return results
  })

  ipcMain.handle('outputs:read', async (_e, filePath: string): Promise<{ content: string } | { error: string }> => {
    const colonyBase = path.join(os.homedir(), '.claude-colony')
    // Path traversal guard
    const resolved = path.resolve(filePath)
    if (!resolved.startsWith(colonyBase + path.sep)) {
      return { error: 'Access denied: path outside .claude-colony' }
    }
    try {
      const stat = await fsp.stat(resolved)
      const fh = await fsp.open(resolved, 'r')
      const buf = Buffer.alloc(Math.min(MAX_READ_BYTES, stat.size))
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
      await fh.close()
      const content = buf.slice(0, bytesRead).toString('utf-8')
      const truncated = stat.size > MAX_READ_BYTES
      return { content: truncated ? content + '\n\n…(truncated at 32KB)' : content }
    } catch (err: any) {
      return { error: err.message }
    }
  })
}
