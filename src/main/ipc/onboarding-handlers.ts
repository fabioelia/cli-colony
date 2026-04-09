import { ipcMain } from 'electron'
import {
  getOnboardingState,
  markChecklistItem,
  skipWelcome,
  replayWelcome,
  resetOnboarding,
} from '../onboarding-state'
import { checkAllPrerequisites } from '../prerequisites'
import type { OnboardingChecklistKey } from '../../shared/types'

const VALID_CHECKLIST_KEYS = new Set<OnboardingChecklistKey>([
  'createdSession',
  'ranFirstPrompt',
  'createdPersona',
  'connectedGitHub',
  'ranPipeline',
])

export function registerOnboardingHandlers(): void {
  ipcMain.handle('onboarding:getState', () => getOnboardingState())

  ipcMain.handle('onboarding:markComplete', (_e, key: string) => {
    if (!VALID_CHECKLIST_KEYS.has(key as OnboardingChecklistKey)) {
      throw new Error(`Unknown checklist key: ${key}`)
    }
    return markChecklistItem(key as OnboardingChecklistKey)
  })

  ipcMain.handle('onboarding:skip', () => skipWelcome())
  ipcMain.handle('onboarding:replay', () => replayWelcome())
  ipcMain.handle('onboarding:reset', () => resetOnboarding())

  ipcMain.handle('prerequisites:check', () => checkAllPrerequisites())
}
