import { ipcMain } from 'electron'
import { getPlaybooks, getPlaybook, getPlaybookMemory, getPlaybookMemoryLineCount, appendPlaybookMemory, clearPlaybookMemory } from '../playbook-manager'
import { colonyPaths } from '../../shared/colony-paths'

export function registerPlaybookHandlers(): void {
  ipcMain.handle('playbooks:list', () => getPlaybooks())
  ipcMain.handle('playbooks:get', (_e, name: string) => getPlaybook(name))
  ipcMain.handle('playbooks:getDir', () => colonyPaths.playbooks)
  ipcMain.handle('playbooks:getMemory', (_e, name: string) => getPlaybookMemory(name))
  ipcMain.handle('playbooks:getMemoryLineCount', (_e, name: string) => getPlaybookMemoryLineCount(name))
  ipcMain.handle('playbooks:appendMemory', (_e, name: string, lines: string[]) => appendPlaybookMemory(name, lines))
  ipcMain.handle('playbooks:clearMemory', (_e, name: string) => clearPlaybookMemory(name))
}
