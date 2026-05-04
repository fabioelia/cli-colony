import { ipcMain } from 'electron'
import { listRecipes, getRecipe, getRecipeTemplate, saveRecipe, deleteRecipe, importRecipe } from '../recipe-manager'

export function registerRecipeHandlers(): void {
  ipcMain.handle('recipes:list', () => listRecipes())

  ipcMain.handle('recipes:get', (_e, filePath: string) => getRecipe(filePath))

  ipcMain.handle('recipes:getTemplate', (_e, filePath: string) => getRecipeTemplate(filePath))

  ipcMain.handle('recipes:save', (_e, filePath: string, content: string) => saveRecipe(filePath, content))

  ipcMain.handle('recipes:delete', (_e, filePath: string) => deleteRecipe(filePath))

  ipcMain.handle('recipes:import', (_e, yamlContent: string) => importRecipe(yamlContent))

  ipcMain.handle('recipes:export', (_e, filePath: string) => getRecipe(filePath))
}
