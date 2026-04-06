import { ipcMain, app } from 'electron'
import * as fs from 'fs'
import { join } from 'path'
import { colonyPaths } from '../../shared/colony-paths'
import {
  getPipelineList, togglePipeline, triggerPollNow, getPipelinesDir,
  getPipelineContent, savePipelineContent, loadPipelines, setPipelineCron,
  previewPipeline, listApprovals, approveAction, dismissAction, getHistory,
} from '../pipeline-engine'

export function registerPipelineHandlers(): void {
  ipcMain.handle('pipeline:list', () => getPipelineList())
  ipcMain.handle('pipeline:toggle', (_e, name: string, enabled: boolean) => togglePipeline(name, enabled))
  ipcMain.handle('pipeline:triggerNow', (_e, name: string) => triggerPollNow(name))
  ipcMain.handle('pipeline:getDir', () => getPipelinesDir())
  ipcMain.handle('pipeline:getContent', (_e, fileName: string) => getPipelineContent(fileName))
  ipcMain.handle('pipeline:saveContent', (_e, fileName: string, content: string) => savePipelineContent(fileName, content))
  ipcMain.handle('pipeline:reload', () => { loadPipelines(); return getPipelineList() })
  ipcMain.handle('pipeline:setCron', (_e, fileName: string, cron: string | null) => setPipelineCron(fileName, cron))
  ipcMain.handle('pipeline:preview', (_e, fileName: string) => previewPipeline(fileName))
  ipcMain.handle('pipeline:listApprovals', () => listApprovals())
  ipcMain.handle('pipeline:approve', (_e, id: string) => approveAction(id))
  ipcMain.handle('pipeline:dismiss', (_e, id: string) => dismissAction(id))
  ipcMain.handle('pipeline:getHistory', (_e, name: string) => getHistory(name))

  // Pipeline outputs
  ipcMain.handle('pipeline:listOutputs', (_e, outputDir: string) => {
    const resolved = outputDir.replace(/^~/, app.getPath('home'))
    if (!fs.existsSync(resolved)) return []
    try {
      const scanDir = (dir: string, prefix = ''): Array<{ name: string; path: string; size: number; modified: number }> => {
        const results: Array<{ name: string; path: string; size: number; modified: number }> = []
        for (const entry of fs.readdirSync(dir)) {
          const full = join(dir, entry)
          try {
            const stat = fs.statSync(full)
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
    const memPath = join(PIPELINES_DIR_MEM, `${fileName.replace(/\.(yaml|yml)$/, '')}.memory.md`)
    return fs.existsSync(memPath) ? fs.readFileSync(memPath, 'utf-8') : ''
  })
  ipcMain.handle('pipeline:saveMemory', (_e, fileName: string, content: string) => {
    if (!fs.existsSync(PIPELINES_DIR_MEM)) fs.mkdirSync(PIPELINES_DIR_MEM, { recursive: true })
    const memPath = join(PIPELINES_DIR_MEM, `${fileName.replace(/\.(yaml|yml)$/, '')}.memory.md`)
    fs.writeFileSync(memPath, content, 'utf-8')
    return true
  })

  // Create a pipeline from generated YAML (Automation Wizard)
  ipcMain.handle('pipeline:createFromTemplate', (_e, yaml: string, slug: string): boolean => {
    if (!yaml || typeof yaml !== 'string' || yaml.trim().length === 0) return false
    if (!slug || typeof slug !== 'string') return false
    // Reject path traversal
    if (slug.includes('/') || slug.includes('\\') || slug.includes('..')) return false
    const pipelinesDir = colonyPaths.pipelines
    if (!fs.existsSync(pipelinesDir)) fs.mkdirSync(pipelinesDir, { recursive: true })
    // Find non-colliding filename
    let candidate = `${slug}.yaml`
    let suffix = 2
    while (fs.existsSync(join(pipelinesDir, candidate))) {
      candidate = `${slug}-${suffix}.yaml`
      suffix++
    }
    fs.writeFileSync(join(pipelinesDir, candidate), yaml, 'utf-8')
    loadPipelines()
    return true
  })
}
