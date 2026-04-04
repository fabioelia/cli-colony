import { ipcMain } from 'electron'
import {
  getPersonaList, getPersonaContent, savePersonaContent,
  createPersona, deletePersona, runPersona, stopPersona,
  togglePersona, getPersonasDir, setPersonaSchedule,
} from '../persona-manager'

export function registerPersonaHandlers(): void {
  ipcMain.handle('persona:list', () => getPersonaList())
  ipcMain.handle('persona:getContent', (_e, fileName: string) => getPersonaContent(fileName))
  ipcMain.handle('persona:saveContent', (_e, fileName: string, content: string) => savePersonaContent(fileName, content))
  ipcMain.handle('persona:create', (_e, name: string) => createPersona(name))
  ipcMain.handle('persona:delete', (_e, fileName: string) => deletePersona(fileName))
  ipcMain.handle('persona:run', (_e, fileName: string) => runPersona(fileName))
  ipcMain.handle('persona:stop', (_e, fileName: string) => stopPersona(fileName))
  ipcMain.handle('persona:toggle', (_e, fileName: string, enabled: boolean) => togglePersona(fileName, enabled))
  ipcMain.handle('persona:getDir', () => getPersonasDir())
  ipcMain.handle('persona:setSchedule', (_e, fileName: string, schedule: string) => setPersonaSchedule(fileName, schedule))
}
