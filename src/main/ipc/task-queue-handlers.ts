import { ipcMain } from 'electron'
import {
  getWorkspacePath, createTaskDir, listRuns, listOutputRuns,
  listQueues, saveQueue, deleteQueue, getQueueMemory, saveQueueMemory,
} from '../task-queue-manager'

export function registerTaskQueueHandlers(): void {
  ipcMain.handle('taskQueue:getWorkspacePath', () => getWorkspacePath())
  ipcMain.handle('taskQueue:createTaskDir', (_e, queueName: string, taskName: string) => createTaskDir(queueName, taskName))
  ipcMain.handle('taskQueue:listRuns', () => listRuns())
  ipcMain.handle('taskQueue:listOutputRuns', (_e, queueOutputDir: string) => listOutputRuns(queueOutputDir))
  ipcMain.handle('taskQueue:list', () => listQueues())
  ipcMain.handle('taskQueue:save', (_e, name: string, content: string) => saveQueue(name, content))
  ipcMain.handle('taskQueue:delete', (_e, name: string) => deleteQueue(name))
  ipcMain.handle('taskQueue:getMemory', (_e, queueName: string) => getQueueMemory(queueName))
  ipcMain.handle('taskQueue:saveMemory', (_e, queueName: string, content: string) => saveQueueMemory(queueName, content))
}
