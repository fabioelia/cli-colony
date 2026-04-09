import { ipcMain } from 'electron'
import {
  readPersonaMemory, setSituations, addSituation, updateSituation, removeSituation,
  addLearning, removeLearning, setLearnings,
  addSessionLogEntry, setSessionLog,
  migrateFromMarkdown,
} from '../persona-memory'
import type { PersonaMemorySituation, PersonaMemoryLearning, PersonaMemoryLogEntry } from '../../shared/types'

export function registerPersonaMemoryHandlers(): void {
  ipcMain.handle('persona:memory:get', (_e, personaId: string) => readPersonaMemory(personaId))
  ipcMain.handle('persona:memory:migrate', (_e, personaId: string) => migrateFromMarkdown(personaId))

  // Situations
  ipcMain.handle('persona:memory:setSituations', (_e, personaId: string, situations: PersonaMemorySituation[]) =>
    setSituations(personaId, situations))
  ipcMain.handle('persona:memory:addSituation', (_e, personaId: string, situation: PersonaMemorySituation) =>
    addSituation(personaId, situation))
  ipcMain.handle('persona:memory:updateSituation', (_e, personaId: string, index: number, updates: Partial<PersonaMemorySituation>) =>
    updateSituation(personaId, index, updates))
  ipcMain.handle('persona:memory:removeSituation', (_e, personaId: string, index: number) =>
    removeSituation(personaId, index))

  // Learnings
  ipcMain.handle('persona:memory:addLearning', (_e, personaId: string, text: string) =>
    addLearning(personaId, text))
  ipcMain.handle('persona:memory:removeLearning', (_e, personaId: string, index: number) =>
    removeLearning(personaId, index))
  ipcMain.handle('persona:memory:setLearnings', (_e, personaId: string, learnings: PersonaMemoryLearning[]) =>
    setLearnings(personaId, learnings))

  // Session Log
  ipcMain.handle('persona:memory:addLogEntry', (_e, personaId: string, summary: string) =>
    addSessionLogEntry(personaId, summary))
  ipcMain.handle('persona:memory:setLog', (_e, personaId: string, entries: PersonaMemoryLogEntry[]) =>
    setSessionLog(personaId, entries))
}
