/**
 * Shared utility for waiting on a Claude session to finish processing.
 * Used by pipeline-engine, persona-manager, and arena-handlers.
 */

import { getDaemonRouter } from './daemon-router'

/**
 * Wait for an instance to go busy then idle, indicating it has finished
 * processing the last prompt. Returns true on completion, false on timeout.
 */
export async function waitForSessionCompletion(instanceId: string, timeoutMs = 600000): Promise<boolean> {
  const client = getDaemonRouter()
  return new Promise((resolve) => {
    let done = false
    let seenBusy = false

    const cleanup = () => {
      done = true
      client.removeListener('activity', handler)
      clearTimeout(timeoutId)
    }

    const handler = (id: string, activity: string) => {
      if (id !== instanceId || done) return
      if (activity === 'busy') {
        seenBusy = true
      } else if (activity === 'waiting' && seenBusy) {
        cleanup()
        resolve(true)
      }
    }

    client.on('activity', handler)
    const timeoutId = setTimeout(() => { cleanup(); resolve(false) }, timeoutMs)
  })
}

/** Default stable-waiting window (ms) before declaring a session truly idle. */
export const DEFAULT_STABLE_WAITING_MS = 20_000

export interface StableIdleOptions {
  /**
   * How long the session must remain 'waiting' continuously before we
   * consider it truly idle. Guards against daemon false-positives where
   * a 2-second PTY lull during tool execution flips the activity state
   * to 'waiting' mid-work. Default 20s.
   */
  stableMs?: number
  /**
   * Absolute upper bound. When this fires, we give up waiting and take
   * the timeout branch regardless of activity state.
   */
  absoluteMs?: number
}

export type StableIdleOutcome = 'stable' | 'timeout' | 'exited'

/**
 * Watches an instance's activity and resolves once it has been in the
 * 'waiting' state continuously for `stableMs`. A transition back to
 * 'busy' cancels the pending stable timer — common when Claude is
 * executing tools or pausing between reasoning steps.
 *
 * Returns a promise with the outcome plus a `cancel()` that callers
 * must invoke if they resolve the wait by other means (e.g., external
 * kill, session exit). Cancelling removes listeners and clears timers.
 */
export function waitForStableIdle(
  instanceId: string,
  opts: StableIdleOptions = {}
): { promise: Promise<StableIdleOutcome>; cancel: () => void } {
  const stableMs = opts.stableMs ?? DEFAULT_STABLE_WAITING_MS
  const absoluteMs = opts.absoluteMs
  const client = getDaemonRouter()

  let settled = false
  let stableTimer: ReturnType<typeof setTimeout> | null = null
  let absoluteTimer: ReturnType<typeof setTimeout> | null = null
  let resolver!: (outcome: StableIdleOutcome) => void

  const clearStable = () => {
    if (stableTimer) { clearTimeout(stableTimer); stableTimer = null }
  }

  const cleanup = () => {
    settled = true
    client.removeListener('activity', handler)
    client.removeListener('exited', exitHandler)
    clearStable()
    if (absoluteTimer) { clearTimeout(absoluteTimer); absoluteTimer = null }
  }

  const handler = (id: string, activity: string) => {
    if (settled || id !== instanceId) return
    if (activity === 'waiting') {
      if (stableTimer) return
      stableTimer = setTimeout(() => {
        if (settled) return
        cleanup()
        resolver('stable')
      }, stableMs)
    } else if (activity === 'busy') {
      // Session resumed work — cancel the pending stable timer and keep watching.
      clearStable()
    }
  }

  // Safety net: if the instance exits before reaching stable-waiting, resolve and detach.
  // Without this, the 'activity' listener would leak forever on the shared DaemonRouter.
  const exitHandler = (id: string) => {
    if (settled || id !== instanceId) return
    cleanup()
    resolver('exited')
  }

  const promise = new Promise<StableIdleOutcome>((resolve) => {
    resolver = resolve
    client.on('activity', handler)
    client.on('exited', exitHandler)
    if (absoluteMs != null) {
      absoluteTimer = setTimeout(() => {
        if (settled) return
        cleanup()
        resolve('timeout')
      }, absoluteMs)
    }
  })

  return {
    promise,
    cancel: () => { if (!settled) cleanup() },
  }
}
