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

/** Planning prefix prepended to prompts when planFirst is enabled */
export const PLAN_FIRST_PREFIX = `IMPORTANT: Before taking any action, first create a structured plan:
1. Summarize your understanding of the task
2. List the files you expect to modify and why
3. Outline your step-by-step approach
4. Note any risks or assumptions

Present the plan, then WAIT for my approval before proceeding.
Do not use any tools or make any changes until I confirm.

Task: `

/** Options for sendPromptWhenReady */
export interface SendPromptOpts {
  /** Prompt text to write to the PTY */
  prompt: string
  /** When true, prefix the prompt with a planning instruction so the session
   *  produces a plan and waits for approval before acting. */
  planFirst?: boolean
  /** Timeout (ms) after first waiting before force-sending. Default 3000. */
  forceTimeout?: number
  /** Timeout (ms) before giving up entirely. Default 15000. */
  abandonTimeout?: number
  /** Called after the prompt has been sent successfully */
  onSent?: () => void
}

/** Result of sendPromptWhenReady — callers should check before updating dedup state */
export type SendPromptResult = 'sent' | 'abandoned'

/**
 * Wait for the instance to be ready, then send the prompt.
 * Returns 'sent' if the prompt was delivered, 'abandoned' if the timeout
 * expired without ever reaching a ready state. Callers should skip state
 * updates (e.g. recordFired, runCount) on 'abandoned'.
 */
export async function sendPromptWhenReady(instanceId: string, opts: SendPromptOpts): Promise<SendPromptResult> {
  const client = getDaemonClient()
  const promptText = opts.planFirst ? PLAN_FIRST_PREFIX + opts.prompt : opts.prompt
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
      client.writeToInstance(instanceId, promptText)
      setTimeout(() => {
        client.writeToInstance(instanceId, '\r')
        opts.onSent?.()
        resolve('sent')
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
        resolve('abandoned')
      }
    }, abandonTimeout)
  })
}
