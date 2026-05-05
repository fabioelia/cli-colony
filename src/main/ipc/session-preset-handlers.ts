import { ipcMain } from 'electron'
import { getSessionPresets, saveSessionPreset, deleteSessionPreset } from '../session-presets'
import type { SessionPreset } from '../../shared/types'

export function registerSessionPresetHandlers(): void {
  ipcMain.handle('session:getPresets', async () => {
    return getSessionPresets()
  })

  ipcMain.handle('session:savePreset', async (_e, preset: SessionPreset) => {
    return saveSessionPreset(preset)
  })

  ipcMain.handle('session:deletePreset', async (_e, name: string) => {
    return deleteSessionPreset(name)
  })
}
