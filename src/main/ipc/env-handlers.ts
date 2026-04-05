import { ipcMain, dialog, BrowserWindow } from 'electron'
import {
  listEnvironments, getEnvironment, createEnvironment, setupEnvironment,
  startEnvironment, stopEnvironment, teardownEnvironment,
  getEnvironmentLogs, restartServiceInEnv, getManifest, saveManifest,
  fixEnvironment, setRestartPolicy, setPurposeTag, type PurposeTag,
  listTemplates, getTemplate, saveTemplate, deleteTemplate,
  refreshRepoConfigs,
} from '../env-manager'
import { getRepoConfig, getAllRepoConfigs } from '../repo-config-loader'

export function registerEnvHandlers(): void {
  ipcMain.handle('env:list', () => listEnvironments())
  ipcMain.handle('env:get', (_e, envId: string) => getEnvironment(envId))
  ipcMain.handle('env:create', async (_e, opts: { name: string; branch?: string; baseBranch?: string; projectType?: string; target?: string; targetDir?: string; templateId?: string }) => {
    const manifest = await createEnvironment(opts)
    setupEnvironment(manifest.id).catch((err) => {
      console.error('[ipc] environment setup failed:', err)
    })
    return manifest
  })
  ipcMain.handle('env:start', (_e, envId: string, services?: string[]) => startEnvironment(envId, services))
  ipcMain.handle('env:stop', (_e, envId: string, services?: string[]) => stopEnvironment(envId, services))
  ipcMain.handle('env:teardown', (_e, envId: string) => {
    // Don't block the IPC response on hook execution — teardown runs in background
    teardownEnvironment(envId).catch((err) => {
      console.error('[ipc] environment teardown failed:', err)
    })
  })
  ipcMain.handle('env:logs', (_e, envId: string, service: string, lines?: number) => getEnvironmentLogs(envId, service, lines))
  ipcMain.handle('env:restartService', (_e, envId: string, service: string) => restartServiceInEnv(envId, service))
  ipcMain.handle('env:manifest', (_e, envId: string) => getManifest(envId))
  ipcMain.handle('env:saveManifest', (_e, envId: string, manifest: any) => saveManifest(envId, manifest))
  ipcMain.handle('env:fix', async (_e, envId: string) => fixEnvironment(envId))
  ipcMain.handle('env:setRestartPolicy', (_e, envId: string, policy: 'manual' | 'on-crash') => setRestartPolicy(envId, policy))
  ipcMain.handle('env:setPurposeTag', (_e, envId: string, tag: PurposeTag | null) => setPurposeTag(envId, tag))
  ipcMain.handle('env:retrySetup', async (_e, envId: string) => {
    setupEnvironment(envId).catch((err) => {
      console.error('[ipc] environment retry setup failed:', err)
    })
  })

  // Templates
  ipcMain.handle('env:listTemplates', () => listTemplates())
  ipcMain.handle('env:getTemplate', (_e, id: string) => getTemplate(id))
  ipcMain.handle('env:saveTemplate', (_e, template: any) => { saveTemplate(template); return true })
  ipcMain.handle('env:deleteTemplate', (_e, id: string) => deleteTemplate(id))
  ipcMain.handle('env:refreshTemplates', () => {
    try { refreshRepoConfigs() } catch (err) { console.warn('[env] refreshRepoConfigs failed:', err) }
    return listTemplates()
  })

  // File picker for prompt hooks — shows hidden files so .env is visible
  ipcMain.handle('env:pick-file', async (_e, opts: { title?: string; defaultPath?: string; message?: string }) => {
    const parentWindow = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
    const dialogOpts: Electron.OpenDialogOptions = {
      title: opts.title || 'Select file',
      message: opts.message,
      defaultPath: opts.defaultPath,
      properties: ['openFile', 'showHiddenFiles'],
    }
    const result = parentWindow
      ? await dialog.showOpenDialog(parentWindow, dialogOpts)
      : await dialog.showOpenDialog(dialogOpts)
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  // Repo .colony/ config
  ipcMain.handle('colony:repoConfig', (_e, repoPath: string) => {
    return getRepoConfig(repoPath)
  })
  ipcMain.handle('colony:allRepoConfigs', () => {
    return getAllRepoConfigs()
  })
}
