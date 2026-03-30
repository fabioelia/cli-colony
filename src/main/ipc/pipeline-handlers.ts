import { ipcMain, app } from 'electron'
import { join } from 'path'
import { colonyPaths } from '../../shared/colony-paths'
import {
  getPipelineList, togglePipeline, triggerPollNow, getPipelinesDir,
  getPipelineContent, savePipelineContent, loadPipelines,
} from '../pipeline-engine'

export function registerPipelineHandlers(): void {
  ipcMain.handle('pipeline:list', () => getPipelineList())
  ipcMain.handle('pipeline:toggle', (_e, name: string, enabled: boolean) => togglePipeline(name, enabled))
  ipcMain.handle('pipeline:triggerNow', (_e, name: string) => triggerPollNow(name))
  ipcMain.handle('pipeline:getDir', () => getPipelinesDir())
  ipcMain.handle('pipeline:getContent', (_e, fileName: string) => getPipelineContent(fileName))
  ipcMain.handle('pipeline:saveContent', (_e, fileName: string, content: string) => savePipelineContent(fileName, content))
  ipcMain.handle('pipeline:reload', () => { loadPipelines(); return getPipelineList() })

  // Pipeline outputs
  ipcMain.handle('pipeline:listOutputs', (_e, outputDir: string) => {
    const { readdirSync, statSync, existsSync } = require('fs') as typeof import('fs')
    const resolved = outputDir.replace(/^~/, app.getPath('home'))
    if (!existsSync(resolved)) return []
    try {
      const scanDir = (dir: string, prefix = ''): Array<{ name: string; path: string; size: number; modified: number }> => {
        const results: Array<{ name: string; path: string; size: number; modified: number }> = []
        for (const entry of readdirSync(dir)) {
          const full = join(dir, entry)
          try {
            const stat = statSync(full)
            if (stat.isDirectory()) {
              results.push(...scanDir(full, prefix ? `${prefix}/${entry}` : entry))
            } else {
              results.push({
                name: prefix ? `${prefix}/${entry}` : entry,
                path: full,
                size: stat.size,
                modified: stat.mtimeMs,
              })
            }
          } catch { /* skip */ }
        }
        return results
      }
      return scanDir(resolved).sort((a, b) => b.modified - a.modified)
    } catch { return [] }
  })

  // Pipeline memory
  const PIPELINES_DIR_MEM = colonyPaths.pipelines
  ipcMain.handle('pipeline:getMemory', (_e, fileName: string) => {
    const { readFileSync, existsSync } = require('fs') as typeof import('fs')
    const memPath = join(PIPELINES_DIR_MEM, `${fileName.replace(/\.(yaml|yml)$/, '')}.memory.md`)
    return existsSync(memPath) ? readFileSync(memPath, 'utf-8') : ''
  })
  ipcMain.handle('pipeline:saveMemory', (_e, fileName: string, content: string) => {
    const { writeFileSync, existsSync, mkdirSync } = require('fs') as typeof import('fs')
    if (!existsSync(PIPELINES_DIR_MEM)) mkdirSync(PIPELINES_DIR_MEM, { recursive: true })
    const memPath = join(PIPELINES_DIR_MEM, `${fileName.replace(/\.(yaml|yml)$/, '')}.memory.md`)
    writeFileSync(memPath, content, 'utf-8')
    return true
  })
}
