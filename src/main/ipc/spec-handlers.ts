import { ipcMain } from 'electron'
import { promises as fsp } from 'fs'
import { join } from 'path'
import { colonyPaths } from '../../shared/colony-paths'

interface SpecSummary {
  name: string
  title: string
  status: string
  updatedAt: string
}

async function pathExists(p: string): Promise<boolean> {
  try { await fsp.access(p); return true } catch { return false }
}

export function registerSpecHandlers(): void {
  ipcMain.handle('colony:listSpecs', async (): Promise<SpecSummary[]> => {
    const specsDir = colonyPaths.specs
    if (!await pathExists(specsDir)) return []

    const allFiles = await fsp.readdir(specsDir)
    const specFiles = allFiles.filter(f => f.endsWith('.md'))
    const results: SpecSummary[] = []

    for (const f of specFiles) {
      const filePath = join(specsDir, f)
      const content = await fsp.readFile(filePath, 'utf-8')
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/)
      if (!fmMatch) continue

      const titleMatch = fmMatch[1].match(/^title:\s*(.+)$/m)
      const statusMatch = fmMatch[1].match(/^status:\s*(.+)$/m)
      const title = titleMatch ? titleMatch[1].trim().replace(/^["']|["']$/g, '') : f.replace(/\.md$/, '')
      const status = statusMatch ? statusMatch[1].trim() : 'active'
      const stat = await fsp.stat(filePath)

      results.push({
        name: f.replace(/\.md$/, ''),
        title,
        status,
        updatedAt: stat.mtime.toISOString(),
      })
    }

    return results
  })

  ipcMain.handle('colony:readSpec', async (_e, name: string): Promise<string | null> => {
    const specPath = join(colonyPaths.specs, `${name}.md`)
    if (!await pathExists(specPath)) return null
    return fsp.readFile(specPath, 'utf-8')
  })

  ipcMain.handle('colony:archiveSpec', async (_e, name: string): Promise<boolean> => {
    const specPath = join(colonyPaths.specs, `${name}.md`)
    if (!await pathExists(specPath)) return false

    let content = await fsp.readFile(specPath, 'utf-8')
    // Replace status in frontmatter
    if (content.match(/^status:\s*.+$/m)) {
      content = content.replace(/^(status:\s*).+$/m, '$1archived')
    } else {
      // Add status after the opening ---
      content = content.replace(/^---\n/, '---\nstatus: archived\n')
    }
    await fsp.writeFile(specPath, content, 'utf-8')
    return true
  })
}
