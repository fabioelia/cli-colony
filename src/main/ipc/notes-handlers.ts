import { ipcMain } from 'electron'
import { promises as fsp } from 'fs'
import { join } from 'path'
import { colonyPaths } from '../../shared/colony-paths'
import { broadcast } from '../broadcast'
import { getAllInstances, setNoteFlag } from '../instance-manager'

export function registerNotesHandlers(): void {
  ipcMain.handle('session:getNotes', async (_e, sessionId: string): Promise<string> => {
    try {
      return await fsp.readFile(join(colonyPaths.notes, `${sessionId}.md`), 'utf-8')
    } catch {
      return ''
    }
  })

  ipcMain.handle('session:saveNotes', async (_e, sessionId: string, content: string): Promise<void> => {
    await fsp.mkdir(colonyPaths.notes, { recursive: true })
    const filePath = join(colonyPaths.notes, `${sessionId}.md`)
    if (content.trim()) {
      await fsp.writeFile(filePath, content, 'utf-8')
      setNoteFlag(sessionId, true)
    } else {
      await fsp.unlink(filePath).catch(() => {})
      setNoteFlag(sessionId, false)
    }
    const instances = await getAllInstances()
    broadcast('instance:list', instances)
  })
}
