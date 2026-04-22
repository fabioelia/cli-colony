import { ipcMain, dialog, shell } from 'electron'
import { promises as fsp } from 'fs'
import * as os from 'os'
import * as path from 'path'
import { join } from 'path'
import { colonyPaths } from '../shared/colony-paths'
import { getSettings, setSetting, detectGitProtocol } from './settings'
import { registerGlobalHotkey } from './global-hotkey'
import { getLogs, clearLogs } from './logger'
import { readCatalog, writeCatalog } from './mcp-catalog'
import { loadApprovalRules, saveApprovalRules } from './approval-rules'
import { updateColonyContext, getColonyContextPath, getColonyContextInstruction } from './colony-context'
import { getRateLimitState, resumeCrons } from './rate-limit-state'
import { runProbe as runRateLimitProbe } from './rate-limit-probe'
import { getUsageSummary } from './persona-run-history'
import { isCronsPaused, setCronsPaused } from './cron-pause'

// Handler modules
import { registerInstanceHandlers } from './ipc/instance-handlers'
import { registerAgentHandlers } from './ipc/agent-handlers'
import { registerSessionHandlers } from './ipc/session-handlers'
import { registerGitHubHandlers } from './ipc/github-handlers'
import { registerPipelineHandlers } from './ipc/pipeline-handlers'
import { registerTaskQueueHandlers } from './ipc/task-queue-handlers'
import { registerEnvHandlers } from './ipc/env-handlers'
import { registerPersonaHandlers } from './ipc/persona-handlers'
import { registerActivityHandlers } from './ipc/activity-handlers'
import { registerMcpCatalogHandlers } from './ipc/mcp-catalog-handlers'
import { registerTasksBoardHandlers } from './ipc/tasks-board-handlers'
import { registerAuditHandlers } from './ipc/audit-handlers'
import { registerMcpAuditHandlers } from './ipc/mcp-audit-handlers'
import { registerCommitAttributorHandlers } from './ipc/commit-attributor-handlers'
import { registerArenaHandlers } from './ipc/arena-handlers'
import { registerForkHandlers } from './ipc/fork-handlers'
import { registerSessionTemplateHandlers } from './ipc/session-template-handlers'
import { registerOutputsHandlers } from './ipc/outputs-handlers'
import { registerApprovalRulesHandlers } from './ipc/approval-rules-handlers'
import { registerBatchHandlers } from './ipc/batch-handlers'
import { registerTeamHandlers } from './ipc/team-handlers'
import { registerAppUpdateHandlers } from './ipc/app-update-handlers'
import { registerOnboardingHandlers } from './ipc/onboarding-handlers'
import { registerWorktreeHandlers } from './ipc/worktree-handlers'
import { registerPersonaMemoryHandlers } from './ipc/persona-memory-handlers'
import { registerSessionArtifactHandlers } from './ipc/session-artifact-handlers'
import { registerNotificationHandlers } from './ipc/notification-handlers'
import { registerGitHandlers } from './ipc/git-handlers'
import { registerFsHandlers } from './ipc/fs-handlers'
import { registerResourceHandlers } from './ipc/resource-handlers'
import { registerSpecHandlers } from './ipc/spec-handlers'
import { registerJiraHandlers } from './ipc/jira-handlers'
import { registerAiHandlers } from './ipc/ai-handlers'

export function registerIpcHandlers(): void {
  // Delegated handler modules
  registerInstanceHandlers()
  registerAgentHandlers()
  registerSessionHandlers()
  registerGitHubHandlers()
  registerPipelineHandlers()
  registerTaskQueueHandlers()
  registerEnvHandlers()
  registerPersonaHandlers()
  registerActivityHandlers()
  registerMcpCatalogHandlers()
  registerTasksBoardHandlers()
  registerAuditHandlers()
  registerMcpAuditHandlers()
  registerCommitAttributorHandlers()
  registerArenaHandlers()
  registerForkHandlers()
  registerSessionTemplateHandlers()
  registerOutputsHandlers()
  registerApprovalRulesHandlers()
  registerBatchHandlers()
  registerTeamHandlers()
  registerAppUpdateHandlers()
  registerOnboardingHandlers()
  registerWorktreeHandlers()
  registerPersonaMemoryHandlers()
  registerSessionArtifactHandlers()
  registerNotificationHandlers()
  registerGitHandlers()
  registerFsHandlers()
  registerResourceHandlers()
  registerSpecHandlers()
  registerJiraHandlers()
  registerAiHandlers()

  // ---- Temp files ----
  ipcMain.handle('fs:writeTempFile', async (_e, prefix: string, content: string) => {
    const safePrefix = (prefix || 'tmp').replace(/[^a-zA-Z0-9_-]/g, '_')
    const dir = path.join(os.tmpdir(), 'claude-colony')
    await fsp.mkdir(dir, { recursive: true })
    const filePath = path.join(dir, `${safePrefix}-${Date.now()}.txt`)
    await fsp.writeFile(filePath, content, 'utf-8')
    return filePath
  })

  // ---- Settings ----
  ipcMain.handle('settings:getAll', () => getSettings())
  ipcMain.handle('settings:getShells', async () => {
    if (process.platform === 'win32') {
      return ['cmd.exe', 'powershell.exe', 'pwsh.exe']
    }
    try {
      const content = await fsp.readFile('/etc/shells', 'utf-8')
      return content.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    } catch {
      return ['/bin/zsh', '/bin/bash', '/bin/sh']
    }
  })
  ipcMain.handle('settings:detectGitProtocol', () => detectGitProtocol())
  ipcMain.handle('settings:set', async (_e, key: string, value: string) => {
    await setSetting(key, value)
    return true
  })
  ipcMain.handle('settings:reregisterHotkey', (_e, hotkey: string) => {
    return registerGlobalHotkey(hotkey)
  })

  ipcMain.handle('settings:export', async () => {
    const result = await dialog.showSaveDialog({
      defaultPath: 'colony-settings.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })
    if (result.canceled || !result.filePath) return false
    const settings = await getSettings()
    const mcpServers = await readCatalog()
    const templates = JSON.parse(await fsp.readFile(colonyPaths.sessionTemplates, 'utf-8').catch(() => '[]'))
    const approvalRules = await loadApprovalRules()
    const bundle = {
      version: 1,
      exportedAt: new Date().toISOString(),
      settings,
      mcpServers,
      sessionTemplates: templates,
      approvalRules,
    }
    await fsp.writeFile(result.filePath, JSON.stringify(bundle, null, 2), 'utf-8')
    return true
  })

  ipcMain.handle('settings:import', async () => {
    const result = await dialog.showOpenDialog({
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile'],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const raw = await fsp.readFile(result.filePaths[0], 'utf-8')
    const bundle = JSON.parse(raw)
    if (!bundle.version || !bundle.settings) return null

    // Restore scalar settings
    for (const [key, value] of Object.entries(bundle.settings)) {
      if (typeof value === 'string') await setSetting(key, value)
    }

    // Merge MCP servers by name
    if (bundle.mcpServers) {
      const existing = await readCatalog()
      const existingNames = new Set(existing.map((s: { name: string }) => s.name))
      for (const server of bundle.mcpServers) {
        if (!existingNames.has(server.name)) {
          existing.push(server)
        }
      }
      await writeCatalog(existing)
    }

    // Merge session templates by name
    if (bundle.sessionTemplates) {
      let existing: any[] = []
      try { existing = JSON.parse(await fsp.readFile(colonyPaths.sessionTemplates, 'utf-8')) } catch { /* empty */ }
      const existingNames = new Set(existing.map((t: { name: string }) => t.name))
      for (const tmpl of bundle.sessionTemplates) {
        if (!existingNames.has(tmpl.name)) {
          existing.push(tmpl)
        }
      }
      await fsp.writeFile(colonyPaths.sessionTemplates, JSON.stringify(existing, null, 2), 'utf-8')
    }

    // Replace approval rules
    if (bundle.approvalRules) {
      await saveApprovalRules(bundle.approvalRules)
    }

    return {
      settingsCount: Object.keys(bundle.settings).length,
      mcpCount: bundle.mcpServers?.length || 0,
      templateCount: bundle.sessionTemplates?.length || 0,
      ruleCount: bundle.approvalRules?.length || 0,
    }
  })

  // ---- Logs ----
  ipcMain.handle('logs:get', async () => {
    const appLogs = getLogs()
    const daemonLogPath = colonyPaths.daemonLog
    let daemonLogs = ''
    try {
      const full = await fsp.readFile(daemonLogPath, 'utf-8')
      const lines = full.split('\n')
      daemonLogs = lines.slice(-200).join('\n')
    } catch { /* */ }
    return daemonLogs ? `${appLogs}\n\n--- Daemon Logs ---\n${daemonLogs}` : appLogs
  })
  ipcMain.handle('logs:getScheduler', async () => {
    try {
      const lines = (await fsp.readFile(colonyPaths.schedulerLog, 'utf-8')).split('\n').filter(Boolean)
      return lines.slice(-20)
    } catch { return [] }
  })
  ipcMain.handle('logs:clear', async () => {
    clearLogs()
    try { await fsp.writeFile(colonyPaths.daemonLog, '', 'utf-8') } catch { /* */ }
    return true
  })

  // ---- Shell / Dialog ----
  ipcMain.handle('shell:openExternal', (_e, url: string) => shell.openExternal(url))
  ipcMain.handle('dialog:openDirectory', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    return result.canceled ? null : result.filePaths[0]
  })

  // ---- Colony Context ----
  ipcMain.handle('colony:updateContext', () => updateColonyContext())
  ipcMain.handle('colony:getContextPath', () => getColonyContextPath())
  ipcMain.handle('colony:getContextInstruction', () => getColonyContextInstruction())
  ipcMain.handle('colony:writePromptFile', async (_e, content: string) => {
    const promptsDir = colonyPaths.pipelinePrompts
    await fsp.mkdir(promptsDir, { recursive: true })
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const filePath = join(promptsDir, `${id}.md`)
    await fsp.writeFile(filePath, content, 'utf-8')
    return filePath
  })

  // ---- Colony Knowledge Base ----
  ipcMain.handle('colony:readKnowledge', async () => {
    const content = await fsp.readFile(colonyPaths.knowledgeBase, 'utf-8').catch(() => '')
    return content.split('\n').filter(l => l.trim().startsWith('- [')).map((l, i) => {
      const match = l.match(/^- \[(\d{4}-\d{2}-\d{2})\s*\|\s*([^\]]+)\]\s*(.+)$/)
      return match ? { id: i, date: match[1], source: match[2].trim(), text: match[3].trim(), raw: l } : null
    }).filter(Boolean)
  })
  ipcMain.handle('colony:appendKnowledge', async (_e, text: string) => {
    const date = new Date().toISOString().slice(0, 10)
    const entry = `- [${date} | User] ${text}\n`
    await fsp.appendFile(colonyPaths.knowledgeBase, entry, 'utf-8')
  })
  ipcMain.handle('colony:deleteKnowledge', async (_e, rawLine: string) => {
    const content = await fsp.readFile(colonyPaths.knowledgeBase, 'utf-8').catch(() => '')
    const updated = content.split('\n').filter(l => l !== rawLine).join('\n')
    await fsp.writeFile(colonyPaths.knowledgeBase, updated, 'utf-8')
  })

  // ---- Usage & Rate Limit ----
  ipcMain.handle('colony:getUsageSummary', () => getUsageSummary())
  ipcMain.handle('colony:rateLimitStatus', () => {
    return getRateLimitState()
  })
  ipcMain.handle('colony:resumeCrons', () => {
    resumeCrons()
  })
  ipcMain.handle('colony:probeRateLimit', () => runRateLimitProbe())
  ipcMain.handle('colony:setCronsPaused', (_e, paused: boolean) => setCronsPaused(paused))
  ipcMain.handle('colony:getCronsPaused', () => isCronsPaused())

  // ---- Window Management ----
  ipcMain.handle('window:toggleFullScreen', (_e) => {
    const { BrowserWindow } = require('electron')
    const win = BrowserWindow.getFocusedWindow()
    if (win) {
      win.setFullScreen(!win.isFullScreen())
    }
    return true
  })
}
