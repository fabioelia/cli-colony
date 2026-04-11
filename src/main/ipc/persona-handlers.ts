import { ipcMain } from 'electron'
import {
  getPersonaList, getPersonaContent, savePersonaContent,
  createPersona, deletePersona, runPersona, stopPersona,
  togglePersona, getPersonasDir, setPersonaSchedule, addWhisper, deleteNote,
  updatePersonaMeta, getPersonaArtifacts, readPersonaArtifact, askPersonas,
} from '../persona-manager'
import { getRunHistory, getPersonaAnalytics, getColonyCostTrend, getPersonaHealthSummary } from '../persona-run-history'
import { markChecklistItem } from '../onboarding-state'

export function registerPersonaHandlers(): void {
  ipcMain.handle('persona:list', () => getPersonaList())
  ipcMain.handle('persona:getContent', (_e, fileName: string) => getPersonaContent(fileName))
  ipcMain.handle('persona:saveContent', (_e, fileName: string, content: string) => savePersonaContent(fileName, content))
  ipcMain.handle('persona:create', async (_e, name: string) => {
    const result = await createPersona(name)
    if (result) markChecklistItem('createdPersona')
    return result
  })
  ipcMain.handle('persona:delete', (_e, fileName: string) => deletePersona(fileName))
  ipcMain.handle('persona:run', (_e, fileName: string) => runPersona(fileName))
  ipcMain.handle('persona:stop', (_e, fileName: string) => stopPersona(fileName))
  ipcMain.handle('persona:toggle', (_e, fileName: string, enabled: boolean) => togglePersona(fileName, enabled))
  ipcMain.handle('persona:getDir', () => getPersonasDir())
  ipcMain.handle('persona:setSchedule', (_e, fileName: string, schedule: string) => setPersonaSchedule(fileName, schedule))
  ipcMain.handle('persona:whisper', (_e, fileName: string, text: string) => addWhisper(fileName, text))
  ipcMain.handle('persona:deleteNote', (_e, fileName: string, index: number) => deleteNote(fileName, index))
  ipcMain.handle('persona:updateMeta', (_e, fileName: string, updates: Record<string, string | boolean | number>) => updatePersonaMeta(fileName, updates))
  ipcMain.handle('persona:getArtifacts', (_e, personaId: string) => getPersonaArtifacts(personaId))
  ipcMain.handle('persona:readArtifact', (_e, personaId: string, filename: string) => readPersonaArtifact(personaId, filename))
  ipcMain.handle('persona:ask', (_e, query: string) => askPersonas(query))
  ipcMain.handle('persona:getRunHistory', (_e, personaId: string) => getRunHistory(personaId))
  ipcMain.handle('persona:analytics', (_e, personaId: string) => getPersonaAnalytics(personaId))
  ipcMain.handle('persona:analytics:colony', () => getColonyCostTrend())
  ipcMain.handle('persona:healthSummary', () => getPersonaHealthSummary())
}
