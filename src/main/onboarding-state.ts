/**
 * Onboarding State — tracks first-run welcome flow + prerequisite snapshot +
 * activation checklist. Stored as JSON at ~/.claude-colony/onboarding-state.json.
 *
 * Usage:
 *   import { getOnboardingState, markChecklistItem, skipWelcome, replayWelcome } from './onboarding-state'
 */

import { promises as fsp } from 'fs'
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

async function readState(): Promise<OnboardingState> {
  if (_cache) return _cache
  try {
    const raw = await fsp.readFile(colonyPaths.onboardingStateJson, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<OnboardingState>
    // Merge with defaults so new keys added in future releases don't crash old files.
    _cache = {
      firstRunCompletedAt: parsed.firstRunCompletedAt ?? null,
      prerequisitesOk: { ...DEFAULT_STATE.prerequisitesOk, ...(parsed.prerequisitesOk || {}) },
      checklist: { ...DEFAULT_STATE.checklist, ...(parsed.checklist || {}) },
    }
    return _cache
  } catch {
    // File doesn't exist or is invalid
  }
  _cache = { ...DEFAULT_STATE, prerequisitesOk: { ...DEFAULT_STATE.prerequisitesOk }, checklist: { ...DEFAULT_STATE.checklist } }
  return _cache
}

async function writeState(state: OnboardingState): Promise<void> {
  try {
    await fsp.mkdir(dirname(colonyPaths.onboardingStateJson), { recursive: true })
    await fsp.writeFile(colonyPaths.onboardingStateJson, JSON.stringify(state, null, 2), 'utf-8')
  } catch (err) {
    console.error('[onboarding-state] write failed:', err)
  }
}

function broadcastChange(state: OnboardingState): void {
  try {
    broadcast('onboarding:stateChanged', state)
  } catch { /* non-fatal */ }
}

export async function getOnboardingState(): Promise<OnboardingState> {
  return readState()
}

export async function markChecklistItem(key: OnboardingChecklistKey): Promise<OnboardingState> {
  const state = await readState()
  if (state.checklist[key]) return state // idempotent — no write, no broadcast
  state.checklist[key] = true
  await writeState(state)
  broadcastChange(state)
  return state
}

export async function setPrerequisiteSnapshot(prereqs: Record<PrerequisiteKey, boolean>): Promise<OnboardingState> {
  const state = await readState()
  state.prerequisitesOk = { ...state.prerequisitesOk, ...prereqs }
  await writeState(state)
  broadcastChange(state)
  return state
}

/** Mark the welcome flow as complete (user clicked Start or Skip). */
export async function skipWelcome(): Promise<OnboardingState> {
  const state = await readState()
  state.firstRunCompletedAt = new Date().toISOString()
  await writeState(state)
  broadcastChange(state)
  return state
}

/** Re-open the welcome modal (Show Welcome command / Settings replay button). */
export async function replayWelcome(): Promise<OnboardingState> {
  const state = await readState()
  state.firstRunCompletedAt = null
  await writeState(state)
  broadcastChange(state)
  return state
}

/** Reset everything — welcome, prereqs snapshot, and checklist. */
export async function resetOnboarding(): Promise<OnboardingState> {
  const fresh: OnboardingState = {
    firstRunCompletedAt: null,
    prerequisitesOk: { ...DEFAULT_STATE.prerequisitesOk },
    checklist: { ...DEFAULT_STATE.checklist },
  }
  _cache = fresh
  await writeState(fresh)
  broadcastChange(fresh)
  return fresh
}

/** @internal Test hook — clears the module-level cache so each test gets a fresh read. */
export function __resetCacheForTest(): void {
  _cache = null
}
