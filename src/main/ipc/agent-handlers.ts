import { ipcMain, dialog, app } from 'electron'
import * as fs from 'fs'
import { basename, join as pathJoin } from 'path'
import { scanAgents, createAgent } from '../agent-scanner'

export function registerAgentHandlers(): void {
  ipcMain.handle('agents:list', () => scanAgents())
  ipcMain.handle('agents:create', (_e, name: string, scope: string, projectPath?: string) =>
    createAgent(name, scope as 'personal' | 'project', projectPath)
  )

  ipcMain.handle('agents:export', async (_e, agentPaths: string[]) => {
    const archiver = require('archiver') as any
    const result = await dialog.showSaveDialog({
      defaultPath: 'agents.zip',
      filters: [{ name: 'ZIP', extensions: ['zip'] }],
    })
    if (result.canceled || !result.filePath) return false
    return new Promise<boolean>((resolve) => {
      const output = fs.createWriteStream(result.filePath!)
      const archive = archiver('zip', { zlib: { level: 9 } })
      archive.pipe(output)
      for (const p of agentPaths) {
        if (fs.existsSync(p)) {
          archive.file(p, { name: basename(p) })
        }
      }
      output.on('close', () => resolve(true))
      archive.on('error', () => resolve(false))
      archive.finalize()
    })
  })

  ipcMain.handle('agents:import', async (_e, targetDir: string) => {
    const unzipper = require('unzipper') as any
    const result = await dialog.showOpenDialog({
      filters: [{ name: 'ZIP', extensions: ['zip'] }],
      properties: ['openFile'],
    })
    if (result.canceled || result.filePaths.length === 0) return 0
    const resolvedDir = targetDir || pathJoin(app.getPath('home'), '.claude', 'agents')
    if (!fs.existsSync(resolvedDir)) fs.mkdirSync(resolvedDir, { recursive: true })
    return new Promise<number>((resolve) => {
      let count = 0
      fs.createReadStream(result.filePaths[0])
        .pipe(unzipper.Parse())
        .on('entry', (entry: any) => {
          const name = basename(entry.path)
          if (name.endsWith('.md') && !name.startsWith('.')) {
            count++
            entry.pipe(fs.createWriteStream(pathJoin(resolvedDir, name)))
          } else {
            entry.autodrain()
          }
        })
        .on('close', () => resolve(count))
        .on('error', () => resolve(count))
    })
  })

  ipcMain.handle('agents:read', (_e, filePath: string) => {
    try {
      return fs.readFileSync(filePath, 'utf-8')
    } catch {
      return null
    }
  })

  ipcMain.handle('agents:write', (_e, filePath: string, content: string) => {
    try {
      fs.writeFileSync(filePath, content, 'utf-8')
      return true
    } catch {
      return false
    }
  })
}
