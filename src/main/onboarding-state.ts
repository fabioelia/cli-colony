/**
 * Onboarding State — tracks first-run welcome flow + prerequisite snapshot +
 * activation checklist. Stored as JSON at ~/.claude-colony/onboarding-state.json.
 *
 * Usage:
 *   import { getOnboardingState, markChecklistItem, skipWelcome, replayWelcome } from './onboarding-state'
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { dirname } from 'path'
import { colonyPaths } from '../shared/colony-paths'
import { broadcast } from './broadcast'
import type {
  OnboardingState,
  OnboardingChecklistKey,
  PrerequisiteKey,
} from '../shared/types'

const DEFAULT_STATE: OnboardingState = {
  firstRunCompletedAt: null,
  prerequisitesOk: { claude: false, auth: false, git: false, github: false },
  checklist: {
    createdSession: false,
    ranFirstPrompt: false,
    createdPersona: false,
    connectedGitHub: false,
    ranPipeline: false,
  },
}

let _cache: OnboardingState | null = null

function readState(): OnboardingState {
  if (_cache) return _cache
  try {
    if (existsSync(colonyPaths.onboardingStateJson)) {
      const raw = readFileSync(colonyPaths.onboardingStateJson, 'utf-8')
      const parsed = JSON.parse(raw) as Partial<OnboardingState>
      // Merge with defaults so new keys added in future releases don't crash old files.
      _cache = {
        firstRunCompletedAt: parsed.firstRunCompletedAt ?? null,
        prerequisitesOk: { ...DEFAULT_STATE.prerequisitesOk, ...(parsed.prerequisitesOk || {}) },
        checklist: { ...DEFAULT_STATE.checklist, ...(parsed.checklist || {}) },
      }
      return _cache
    }
  } catch (err) {
    console.error('[onboarding-state] read failed:', err)
  }
  _cache = { ...DEFAULT_STATE, prerequisitesOk: { ...DEFAULT_STATE.prerequisitesOk }, checklist: { ...DEFAULT_STATE.checklist } }
  return _cache
}

function writeState(state: OnboardingState): void {
  try {
    mkdirSync(dirname(colonyPaths.onboardingStateJson), { recursive: true })
    writeFileSync(colonyPaths.onboardingStateJson, JSON.stringify(state, null, 2), 'utf-8')
  } catch (err) {
    console.error('[onboarding-state] write failed:', err)
  }
}

function broadcastChange(state: OnboardingState): void {
  try {
    broadcast('onboarding:stateChanged', state)
  } catch { /* non-fatal */ }
}

export function getOnboardingState(): OnboardingState {
  return readState()
}

export function markChecklistItem(key: OnboardingChecklistKey): OnboardingState {
  const state = readState()
  if (state.checklist[key]) return state // idempotent — no write, no broadcast
  state.checklist[key] = true
  writeState(state)
  broadcastChange(state)
  return state
}

export function setPrerequisiteSnapshot(prereqs: Record<PrerequisiteKey, boolean>): OnboardingState {
  const state = readState()
  state.prerequisitesOk = { ...state.prerequisitesOk, ...prereqs }
  writeState(state)
  broadcastChange(state)
  return state
}

/** Mark the welcome flow as complete (user clicked Start or Skip). */
export function skipWelcome(): OnboardingState {
  const state = readState()
  state.firstRunCompletedAt = new Date().toISOString()
  writeState(state)
  broadcastChange(state)
  return state
}

/** Re-open the welcome modal (Show Welcome command / Settings replay button). */
export function replayWelcome(): OnboardingState {
  const state = readState()
  state.firstRunCompletedAt = null
  writeState(state)
  broadcastChange(state)
  return state
}

/** Reset everything — welcome, prereqs snapshot, and checklist. */
export function resetOnboarding(): OnboardingState {
  const fresh: OnboardingState = {
    firstRunCompletedAt: null,
    prerequisitesOk: { ...DEFAULT_STATE.prerequisitesOk },
    checklist: { ...DEFAULT_STATE.checklist },
  }
  _cache = fresh
  writeState(fresh)
  broadcastChange(fresh)
  return fresh
}

/** @internal Test hook — clears the module-level cache so each test gets a fresh read. */
export function __resetCacheForTest(): void {
  _cache = null
}
