import { ipcMain } from 'electron'
import {
  getPersonaList, getPersonaContent, savePersonaContent,
  createPersona, deletePersona, duplicatePersona, runPersona, stopPersona,
  togglePersona, drainPersona, getPersonasDir, setPersonaSchedule, addWhisper, deleteNote, updateNote,
  updatePersonaMeta, getPersonaArtifacts, readPersonaArtifact, getPersonaBriefDiff, askPersonas,
  getPersonaConfigPair, PersonaRunOverrides, previewPersonaPrompt, testPersonaPrompt,
  getPersonaBriefHistory, getPersonaBriefAt,
} from '../persona-manager'
import { getRunHistory, getPersonaAnalytics, getColonyCostTrend, getPersonaHealthSummary } from '../persona-run-history'
import { searchPersonaLearnings } from '../persona-memory'
import { markChecklistItem } from '../onboarding-state'
import { getAllPendingAttention, resolveAttention, dismissAttention } from '../persona-attention'
import { getAllTemplates, createPersonaFromTemplate } from '../persona-templates'

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
  ipcMain.handle('persona:duplicate', (_e, personaId: string) => duplicatePersona(personaId))
  ipcMain.handle('persona:run', (_e, fileName: string) => runPersona(fileName))
  ipcMain.handle('persona:runWithOptions', (_e, fileName: string, overrides: PersonaRunOverrides) => runPersona(fileName, { type: 'manual' }, undefined, undefined, overrides))
  ipcMain.handle('persona:stop', (_e, fileName: string) => stopPersona(fileName))
  ipcMain.handle('persona:toggle', (_e, fileName: string, enabled: boolean) => togglePersona(fileName, enabled))
  ipcMain.handle('persona:drain', (_e, fileName: string) => drainPersona(fileName))
  ipcMain.handle('persona:getDir', () => getPersonasDir())
  ipcMain.handle('persona:setSchedule', (_e, fileName: string, schedule: string) => setPersonaSchedule(fileName, schedule))
  ipcMain.handle('persona:whisper', (_e, fileName: string, text: string) => addWhisper(fileName, text))
  ipcMain.handle('persona:deleteNote', (_e, fileName: string, index: number) => deleteNote(fileName, index))
  ipcMain.handle('persona:updateNote', (_e, fileName: string, index: number, newText: string) => updateNote(fileName, index, newText))
  ipcMain.handle('persona:updateMeta', (_e, fileName: string, updates: Record<string, string | boolean | number>) => updatePersonaMeta(fileName, updates))
  ipcMain.handle('persona:getArtifacts', (_e, personaId: string) => getPersonaArtifacts(personaId))
  ipcMain.handle('persona:readArtifact', (_e, personaId: string, filename: string) => readPersonaArtifact(personaId, filename))
  ipcMain.handle('persona:briefDiff', (_e, personaId: string) => getPersonaBriefDiff(personaId))
  ipcMain.handle('persona:briefHistory', (_e, id: string) => getPersonaBriefHistory(id))
  ipcMain.handle('persona:briefAt', (_e, id: string, index: number) => getPersonaBriefAt(id, index))
  ipcMain.handle('persona:ask', (_e, query: string) => askPersonas(query))
  ipcMain.handle('persona:getRunHistory', (_e, personaId: string) => getRunHistory(personaId))
  ipcMain.handle('persona:analytics', (_e, personaId: string) => getPersonaAnalytics(personaId))
  ipcMain.handle('persona:analytics:colony', () => getColonyCostTrend())
  ipcMain.handle('persona:healthSummary', () => getPersonaHealthSummary())
  ipcMain.handle('persona:getAllAttention', () => getAllPendingAttention())
  ipcMain.handle('persona:resolveAttention', (_e, personaId: string, attnId: string, response?: string) => resolveAttention(personaId, attnId, response))
  ipcMain.handle('persona:dismissAttention', (_e, personaId: string, attnId: string) => dismissAttention(personaId, attnId))
  ipcMain.handle('persona:getTemplates', () => getAllTemplates())
  ipcMain.handle('persona:createFromTemplate', (_e, templateId: string) => createPersonaFromTemplate(templateId))
  ipcMain.handle('persona:compareConfig', (_e, idA: string, idB: string) => getPersonaConfigPair(idA, idB))
  ipcMain.handle('persona:searchLearnings', (_e, query: string) => searchPersonaLearnings(query))
  ipcMain.handle('persona:previewPrompt', async (_e, fileName: string): Promise<string> => {
    return previewPersonaPrompt(fileName)
  })
  ipcMain.handle('persona:testPrompt', async (_e, personaId: string, prompt: string) => {
    return testPersonaPrompt(personaId, prompt)
  })
}
