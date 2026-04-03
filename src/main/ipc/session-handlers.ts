import { ipcMain } from 'electron'
import {
  scanSessions, scanExternalSessions, readSessionMessages,
  searchSessions, takeoverSession,
} from '../session-scanner'
import { getRestorableSessions, clearRestorable, getRecentSessions } from '../recent-sessions'
import { getAllInstances } from '../instance-manager'

export function registerSessionHandlers(): void {
  ipcMain.handle('sessions:list', (_e, limit?: number) => scanSessions(limit))

  ipcMain.handle('sessions:external', () => scanExternalSessions())

  ipcMain.handle('sessions:messages', (_e, sessionId: string, limit: number = 50) =>
    readSessionMessages(sessionId, limit)
  )

  ipcMain.handle('sessions:takeover', (_e, opts: { pid: number; sessionId: string | null; name: string; cwd: string }) =>
    takeoverSession(opts)
  )

  ipcMain.handle('sessions:search', (_e, query: string) => searchSessions(query))

  ipcMain.handle('sessions:restorable', async () => {
    const instances = await getAllInstances()
    const alreadyRunning = new Set<string>()
    for (const inst of instances) {
      const resumeIdx = inst.args?.indexOf('--resume')
      if (resumeIdx !== undefined && resumeIdx >= 0 && inst.args?.[resumeIdx + 1]) {
        alreadyRunning.add(inst.args[resumeIdx + 1])
      }
    }
    return getRestorableSessions(alreadyRunning)
  })
  ipcMain.handle('sessions:clearRestorable', () => { clearRestorable(); return true })
  ipcMain.handle('sessions:recent', () => getRecentSessions())
}
