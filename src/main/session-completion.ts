/**
 * Shared utility for waiting on a Claude session to finish processing.
 * Used by pipeline-engine and arena-handlers.
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
