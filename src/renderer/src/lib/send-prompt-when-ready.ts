/**
 * Wait for a Claude instance to become ready, then send input.
 *
 * The workspace trust dialog always appears in interactive mode.
 * On the first "waiting" activity we send \r to dismiss it.
 * On the second "waiting" (Claude is ready for input) we send the prompt.
 *
 * If the instance was launched in an already-trusted directory (only one
 * "waiting" event), the force timeout fires and sends the prompt.
 *
 * Returns an unsub function to cancel early.
 */
export function sendPromptWhenReady(
  instanceId: string,
  opts: {
    /** Prompt text to send. Written to PTY with a delayed \r so the TUI processes text before submit. */
    prompt?: string
    /** Called when the instance is ready. Use for custom logic; if `prompt` is set, called after submit. */
    onReady?: () => void
    /** Timeout (ms) after first waiting before force-sending. Default 3000. */
    forceTimeout?: number
    /** Timeout (ms) before giving up entirely. Default 15000. */
    abandonTimeout?: number
  }
): () => void {
  let sent = false
  let waitCount = 0
  const forceTimeout = opts.forceTimeout ?? 3000
  const abandonTimeout = opts.abandonTimeout ?? 15000

  const cleanup = () => {
    unsub()
    clearTimeout(forceTimer)
    clearTimeout(abandonTimer)
  }

  const fire = () => {
    if (sent) return
    sent = true
    cleanup()
    if (opts.prompt) {
      // Write text first, then submit after a short delay so the TUI
      // processes the input before receiving the Enter key.
      window.api.instance.write(instanceId, opts.prompt)
      setTimeout(() => {
        window.api.instance.write(instanceId, '\r')
        opts.onReady?.()
      }, 150)
    } else {
      opts.onReady?.()
    }
  }

  let forceTimer: ReturnType<typeof setTimeout>

  const unsub = window.api.instance.onActivity(({ id, activity }) => {
    if (id !== instanceId || sent) return
    if (activity === 'waiting') {
      waitCount++
      if (waitCount === 1) {
        // Dismiss trust/directory prompt (or harmless if already trusted)
        window.api.instance.write(instanceId, '\r')
        // If no second waiting arrives (dir was already trusted), force-send
        forceTimer = setTimeout(() => fire(), forceTimeout)
      } else {
        // Trust dismissed, Claude is ready for real input
        fire()
      }
    }
  })

  const abandonTimer = setTimeout(() => {
    if (!sent) {
      sent = true
      cleanup()
    }
  }, abandonTimeout)

  return () => {
    if (!sent) {
      sent = true
      cleanup()
    }
  }
}
