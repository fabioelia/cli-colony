/**
 * Persona Scheduler — cron-based persona launch and stale session reconciliation.
 * Extracted from persona-manager.ts to separate scheduling concerns.
 */

import { appendFileSync } from 'fs'
import { colonyPaths } from '../shared/colony-paths'
import { cronMatches } from '../shared/cron'
import { getAllInstances, killInstance } from './instance-manager'
import { broadcast } from './broadcast'
import { getPersonaList, getState, saveState, runPersona } from './persona-manager'

function schedulerLog(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`
  try { appendFileSync(colonyPaths.schedulerLog, line, 'utf-8') } catch { /* non-fatal */ }
  console.log(`[persona] ${msg}`)
}

let schedulerInterval: ReturnType<typeof setInterval> | null = null
let lastCronMinute = -1
/** Tracks when we first observed a persona session in 'waiting' state (for stale detection). */
const _waitingSince = new Map<string, number>()

function broadcastStatus(): void {
  broadcast('persona:status', getPersonaList())
}

export function startScheduler(): void {
  if (schedulerInterval) return
  schedulerLog('scheduler started')

  schedulerInterval = setInterval(async () => {
    // Reconcile stale activeSessionId — clear if the session no longer exists.
    // Use a snapshot only for the reconciliation pass; re-read fresh state for the cron check
    // so that sessions cleared here are immediately visible to the cron loop this same tick.
    try {
      const reconcileSnapshot = getPersonaList()
      const instances = await getAllInstances()
      let reconciled = false
      for (const persona of reconcileSnapshot) {
        if (!persona.activeSessionId) continue
        const inst = instances.find(i => i.id === persona.activeSessionId && i.status === 'running')
        if (!inst) {
          const state = getState(persona.name)
          state.activeSessionId = null
          _waitingSince.delete(persona.activeSessionId)
          reconciled = true
          continue
        }

        // Stale waiting detection: if cron-triggered and waiting > 60s, force-kill.
        // Catches the race where the activity listener missed the 'waiting' transition.
        const state = getState(persona.name)
        if (state.triggerType === 'cron' && inst.activity === 'waiting') {
          if (!_waitingSince.has(persona.activeSessionId)) {
            _waitingSince.set(persona.activeSessionId, Date.now())
          } else if (Date.now() - _waitingSince.get(persona.activeSessionId)! > 60_000) {
            schedulerLog(`session ${persona.activeSessionId} for "${persona.name}" waiting > 60s (cron), killing`)
            try { await killInstance(persona.activeSessionId) } catch { /* already gone */ }
            _waitingSince.delete(persona.activeSessionId)
            state.activeSessionId = null
            reconciled = true
          }
        } else {
          _waitingSince.delete(persona.activeSessionId)
        }
      }
      if (reconciled) {
        saveState()
        broadcastStatus()
      }
    } catch { /* daemon may be down */ }

    const currentMinute = new Date().getMinutes()
    if (currentMinute === lastCronMinute) return // only check once per minute
    lastCronMinute = currentMinute

    // Re-read after reconciliation so cleared sessions don't block this tick's cron check
    const personas = getPersonaList()
    for (const persona of personas) {
      if (!persona.enabled || !persona.schedule) continue

      if (persona.activeSessionId) {
        schedulerLog(`skip "${persona.name}" — already running (session ${persona.activeSessionId})`)
        continue
      }

      if (cronMatches(persona.schedule)) {
        schedulerLog(`cron matched "${persona.name}" (${persona.schedule}) — launching`)
        runPersona(persona.id, { type: 'cron', schedule: persona.schedule }).catch(err => {
          schedulerLog(`launch failed for "${persona.name}": ${err.message}`)
        })
      }
    }
  }, 15_000) // check every 15 seconds
}

export function stopScheduler(): void {
  if (schedulerInterval) {
    clearInterval(schedulerInterval)
    schedulerInterval = null
    schedulerLog('scheduler stopped')
  }
}
