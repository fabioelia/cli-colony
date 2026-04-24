import { ipcMain } from 'electron'
import { getPlaybooks, getPlaybook } from '../playbook-manager'
import { colonyPaths } from '../../shared/colony-paths'

export function registerPlaybookHandlers(): void {
  ipcMain.handle('playbooks:list', () => getPlaybooks())
  ipcMain.handle('playbooks:get', (_e, name: string) => getPlaybook(name))
  ipcMain.handle('playbooks:getDir', () => colonyPaths.playbooks)
}
