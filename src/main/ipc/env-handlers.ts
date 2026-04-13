import { ipcMain, dialog, BrowserWindow } from 'electron'
import {
  listEnvironments, getEnvironment, createEnvironment, setupEnvironment,
  startEnvironment, stopEnvironment, teardownEnvironment,
  getEnvironmentLogs, restartServiceInEnv, toggleDebug, getManifest, saveManifest,
  fixEnvironment, cloneEnvironment, setRestartPolicy, setPurposeTag, type PurposeTag,
  listTemplates, getTemplate, saveTemplate, deleteTemplate,
  refreshRepoConfigs,
} from '../env-manager'
// getRepoConfig/getAllRepoConfigs removed — colony:repoConfig handlers were unreachable
import {
  registerPendingLaunch,
  cancelPendingLaunch,
  getPendingLaunches,
  handleEnvStatusUpdate,
  type PendingLaunchSpawnOpts,
} from '../pending-session-launches'

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
    return teardownEnvironment(envId)
  })
  ipcMain.handle('env:logs', (_e, envId: string, service: string, lines?: number) => getEnvironmentLogs(envId, service, lines))
  ipcMain.handle('env:restartService', (_e, envId: string, service: string) => restartServiceInEnv(envId, service))
  ipcMain.handle('env:manifest', (_e, envId: string) => getManifest(envId))
  ipcMain.handle('env:saveManifest', async (_e, envId: string, manifest: any) => { await saveManifest(envId, manifest) })
  ipcMain.handle('env:fix', async (_e, envId: string) => fixEnvironment(envId))
  ipcMain.handle('env:clone', async (_e, envId: string, newName: string) => {
    const manifest = await cloneEnvironment(envId, newName)
    setupEnvironment(manifest.id).catch(err => console.error('[ipc] env clone setup failed:', err))
    return manifest
  })
  ipcMain.handle('env:toggleDebug', (_e, envId: string, enabled: boolean, service?: string) => toggleDebug(envId, enabled, service))
  ipcMain.handle('env:setRestartPolicy', (_e, envId: string, policy: 'manual' | 'on-crash') => setRestartPolicy(envId, policy))
  ipcMain.handle('env:launchSessionWhenReady', async (
    _e,
    opts: { envId: string; envName: string; spawnOpts: PendingLaunchSpawnOpts; initialPrompt?: string },
  ) => {
    const pendingId = registerPendingLaunch(opts)
    // Prime with current state so callers get an immediate status update even
    // if the env is already ready (fast builds) or already broken.
    try {
      const envs = await listEnvironments()
      handleEnvStatusUpdate(envs)
    } catch { /* non-fatal */ }
    return { pendingId }
  })
  ipcMain.handle('env:cancelPendingLaunch', (_e, pendingId: string) => cancelPendingLaunch(pendingId))
  ipcMain.handle('env:getPendingLaunches', (_e, envId?: string) => getPendingLaunches(envId))
  ipcMain.handle('env:setPurposeTag', (_e, envId: string, tag: PurposeTag | null) => setPurposeTag(envId, tag))
  ipcMain.handle('env:retrySetup', (_e, envId: string) => {
    return setupEnvironment(envId)
  })

  // Templates
  ipcMain.handle('env:listTemplates', () => listTemplates())
  ipcMain.handle('env:getTemplate', (_e, id: string) => getTemplate(id))
  ipcMain.handle('env:saveTemplate', async (_e, template: any) => { await saveTemplate(template); return true })
  ipcMain.handle('env:deleteTemplate', (_e, id: string) => deleteTemplate(id))
  ipcMain.handle('env:refreshTemplates', async () => {
    await refreshRepoConfigs().catch(err => console.warn('[env] refreshRepoConfigs failed:', err))
    return await listTemplates()
  })

  // File picker for prompt hooks — shows hidden files so .env is visible
  ipcMain.handle('env:pickFile', async (_e, opts: { title?: string; defaultPath?: string; message?: string }) => {
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

  // Note: colony:repoConfig and colony:allRepoConfigs removed — they were registered
  // but unreachable from the renderer (no preload entry). If needed, wire through
  // the colony namespace in preload/index.ts and src/main/ipc/ipc-handlers.ts.
}
