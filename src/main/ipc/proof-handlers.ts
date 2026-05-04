import { ipcMain } from 'electron'
import { promises as fsp } from 'fs'
import { join } from 'path'
import { colonyPaths } from '../../shared/colony-paths'
import type { ProofEntry } from '../../shared/types'

function parseYamlFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\n([\s\S]*?)\n---/)
  if (!match) return {}
  const result: Record<string, string> = {}
  for (const line of match[1].split('\n')) {
    const colonIdx = line.indexOf(':')
    if (colonIdx < 0) continue
    const key = line.slice(0, colonIdx).trim()
    const val = line.slice(colonIdx + 1).trim().replace(/^["']|["']$/g, '')
    if (key) result[key] = val
  }
  return result
}

async function scanDateDir(dateDir: string, date: string): Promise<ProofEntry[]> {
  let entries: string[]
  try {
    entries = await fsp.readdir(dateDir)
  } catch {
    return []
  }
  const results: ProofEntry[] = []
  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue
    const filePath = join(dateDir, entry)
    try {
      const content = await fsp.readFile(filePath, 'utf-8')
      const fm = parseYamlFrontmatter(content)
      results.push({
        path: filePath,
        name: fm.session ?? entry.replace(/\.md$/, ''),
        date,
        exitCode: fm.exit_code !== undefined ? parseInt(fm.exit_code, 10) : 0,
        duration: fm.duration ?? '',
        cost: fm.cost ?? '',
        branch: fm.branch ?? '',
        commits: fm.commits !== undefined ? parseInt(fm.commits, 10) : 0,
        persona: fm.persona ?? '',
      })
    } catch {
      // skip unreadable files
    }
  }
  return results
}

export function registerProofHandlers(): void {
  ipcMain.handle('proofs:list', async (_e, dateFrom: string, dateTo: string): Promise<ProofEntry[]> => {
    const proofsRoot = colonyPaths.proofs
    let dateDirs: string[]
    try {
      dateDirs = await fsp.readdir(proofsRoot)
    } catch {
      return []
    }

    const filtered = dateDirs.filter(d => d >= dateFrom && d <= dateTo)
    const all: ProofEntry[] = []
    for (const d of filtered.sort()) {
      const entries = await scanDateDir(join(proofsRoot, d), d)
      all.push(...entries)
    }
    // Sort newest first
    return all.reverse()
  })

  ipcMain.handle('proofs:read', async (_e, filePath: string): Promise<string> => {
    try {
      return await fsp.readFile(filePath, 'utf-8')
    } catch {
      return ''
    }
  })
}
