import { ipcMain, dialog, shell } from 'electron'
import {
  createInstance,
  writeToInstance,
  resizeInstance,
  killInstance,
  removeInstance,
  renameInstance,
  recolorInstance,
  restartInstance,
  pinInstance,
  unpinInstance,
  getAllInstances,
  getInstance,
  getInstanceBuffer,
} from './instance-manager'
import { scanAgents, createAgent } from './agent-scanner'
import { scanSessions } from './session-scanner'
import { getRestorableSessions, clearRestorable, getRecentSessions } from './recent-sessions'
import { getSettings, setSetting } from './settings'
import { getLogs, clearLogs } from './logger'
import {
  checkGhAuth, fetchPRs, getRepos, addRepo, removeRepo,
  updateRepoPath, getPrompts, savePrompts, resolvePrompt, writePrContext,
  getPrMemory, savePrMemory, getPrMemoryPath, getPrWorkspacePath,
} from './github'
import type { GitHubRepo, QuickPrompt, GitHubPR } from './github'

export function registerIpcHandlers(): void {
  ipcMain.handle('instance:create', (_e, opts) => createInstance(opts || {}))
  ipcMain.handle('instance:write', (_e, id: string, data: string) => writeToInstance(id, data))
  ipcMain.handle('instance:resize', (_e, id: string, cols: number, rows: number) => resizeInstance(id, cols, rows))
  ipcMain.handle('instance:kill', (_e, id: string) => killInstance(id))
  ipcMain.handle('instance:remove', (_e, id: string) => removeInstance(id))
  ipcMain.handle('instance:rename', (_e, id: string, name: string) => renameInstance(id, name))
  ipcMain.handle('instance:recolor', (_e, id: string, color: string) => recolorInstance(id, color))
  ipcMain.handle('instance:restart', (_e, id: string) => restartInstance(id))
  ipcMain.handle('instance:pin', (_e, id: string) => pinInstance(id))
  ipcMain.handle('instance:unpin', (_e, id: string) => unpinInstance(id))
  ipcMain.handle('instance:list', () => getAllInstances())
  ipcMain.handle('instance:get', (_e, id: string) => getInstance(id))
  ipcMain.handle('instance:buffer', (_e, id: string) => getInstanceBuffer(id))

  ipcMain.handle('agents:list', () => scanAgents())
  ipcMain.handle('agents:create', (_e, name: string, scope: string, projectPath?: string) =>
    createAgent(name, scope as 'personal' | 'project', projectPath)
  )
  ipcMain.handle('agents:read', (_e, filePath: string) => {
    const { readFileSync } = require('fs') as typeof import('fs')
    try {
      return readFileSync(filePath, 'utf-8')
    } catch {
      return null
    }
  })
  ipcMain.handle('agents:write', (_e, filePath: string, content: string) => {
    const { writeFileSync } = require('fs') as typeof import('fs')
    try {
      writeFileSync(filePath, content, 'utf-8')
      return true
    } catch {
      return false
    }
  })

  ipcMain.handle('sessions:list', (_e, limit?: number) => scanSessions(limit))
  ipcMain.handle('sessions:restorable', () => getRestorableSessions())
  ipcMain.handle('sessions:clearRestorable', () => { clearRestorable(); return true })
  ipcMain.handle('sessions:recent', () => getRecentSessions())

  ipcMain.handle('settings:getAll', () => getSettings())
  ipcMain.handle('settings:set', (_e, key: string, value: string) => {
    setSetting(key, value)
    return true
  })

  ipcMain.handle('logs:get', () => getLogs())
  ipcMain.handle('logs:clear', () => { clearLogs(); return true })

  ipcMain.handle('shell:openExternal', (_e, url: string) => shell.openExternal(url))

  ipcMain.handle('dialog:openDirectory', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    return result.canceled ? null : result.filePaths[0]
  })

  // GitHub
  ipcMain.handle('github:authStatus', () => checkGhAuth())
  ipcMain.handle('github:fetchPRs', (_e, repo: GitHubRepo) => fetchPRs(repo))
  ipcMain.handle('github:getRepos', () => getRepos())
  ipcMain.handle('github:addRepo', (_e, repo: GitHubRepo) => addRepo(repo))
  ipcMain.handle('github:removeRepo', (_e, owner: string, name: string) => removeRepo(owner, name))
  ipcMain.handle('github:updateRepoPath', (_e, owner: string, name: string, localPath: string) => updateRepoPath(owner, name, localPath))
  ipcMain.handle('github:getPrompts', () => getPrompts())
  ipcMain.handle('github:savePrompts', (_e, prompts: QuickPrompt[]) => savePrompts(prompts))
  ipcMain.handle('github:resolvePrompt', (_e, prompt: QuickPrompt, pr: GitHubPR, repo: GitHubRepo) => resolvePrompt(prompt, pr, repo))
  ipcMain.handle('github:writePrContext', (_e, prsByRepo: Record<string, GitHubPR[]>) => writePrContext(prsByRepo))
  ipcMain.handle('github:getPrMemory', () => getPrMemory())
  ipcMain.handle('github:savePrMemory', (_e, content: string) => savePrMemory(content))
  ipcMain.handle('github:getPrMemoryPath', () => getPrMemoryPath())
  ipcMain.handle('github:getPrWorkspacePath', () => getPrWorkspacePath())
}
