/**
 * Send Prompt When Ready -- shared main-process implementation.
 *
 * Waits for a Claude CLI instance to become idle, dismisses the workspace
 * trust dialog, then sends the prompt text. Used by pipeline-engine and
 * persona-manager.
 *
 * State machine:
 *   1. Listen for 'activity' events from the daemon client
 *   2. First 'waiting' = trust/directory prompt -> dismiss with Enter
 *   3. Second 'waiting' = CLI ready for input -> send the prompt
 *   4. If only one 'waiting' arrives (already trusted), force-send after timeout
 *   5. Safety abandon if nothing happens within abandonTimeout
 */

import { getDaemonClient } from './daemon-client'

/** Options for sendPromptWhenReady */
export interface SendPromptOpts {
  /** Prompt text to write to the PTY */
  prompt: string
  /** Timeout (ms) after first waiting before force-sending. Default 3000. */
  forceTimeout?: number
  /** Timeout (ms) before giving up entirely. Default 15000. */
  abandonTimeout?: number
  /** Called after the prompt has been sent successfully */
  onSent?: () => void
}

/**
 * Wait for the instance to be ready, then send the prompt.
 * Returns a promise that resolves when the prompt has been sent (or abandoned).
 */
export async function sendPromptWhenReady(instanceId: string, opts: SendPromptOpts): Promise<void> {
  const client = getDaemonClient()
  const forceTimeout = opts.forceTimeout ?? 3000
  const abandonTimeout = opts.abandonTimeout ?? 15000

  return new Promise((resolve) => {
    let sent = false
    let waitCount = 0
    let forceTimer: ReturnType<typeof setTimeout>

    const cleanup = () => {
      client.removeListener('activity', handler)
      clearTimeout(forceTimer)
      clearTimeout(abandonTimer)
    }

    const fire = () => {
      if (sent) return
      sent = true
      cleanup()
      // Write text first, then submit after a short delay so the TUI
      // has time to process the input before receiving the Enter key.
      client.writeToInstance(instanceId, opts.prompt)
      setTimeout(() => {
        client.writeToInstance(instanceId, '\r')
        opts.onSent?.()
        resolve()
      }, 150)
    }

    const handler = (_id: string, activity: string) => {
      if (_id !== instanceId || sent) return
      if (activity === 'waiting') {
        waitCount++
        if (waitCount === 1) {
          // Dismiss trust/directory prompt
          client.writeToInstance(instanceId, '\r')
          // If no second waiting arrives, force-send after timeout
          forceTimer = setTimeout(() => fire(), forceTimeout)
        } else {
          // Second 'waiting' = CLI is actually ready for input
          clearTimeout(forceTimer)
          fire()
        }
      }
    }

    client.on('activity', handler)

    // Check current state in case the first 'waiting' already fired before
    // we attached the listener (race between createInstance resolving and
    // the CLI reaching its idle prompt).
    client.getInstance(instanceId).then((inst) => {
      if (inst && inst.activity === 'waiting' && !sent && waitCount === 0) {
        handler(instanceId, 'waiting')
      }
    }).catch(() => {})

    const abandonTimer = setTimeout(() => {
      if (!sent) {
        sent = true
        cleanup()
        resolve()
      }
    }, abandonTimeout)
  })
}
