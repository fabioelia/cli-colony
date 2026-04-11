import { useState, useEffect, useRef } from 'react'
import { stripAnsi } from '../../../shared/utils'
import type { ClaudeInstance } from '../types'

interface OutputTrackingResult {
  unreadIds: Set<string>
  setUnreadIds: React.Dispatch<React.SetStateAction<Set<string>>>
  outputBytes: Map<string, number>
}

/**
 * Tracks unread session output and per-instance byte counts.
 *
 * Listens to `instance:output` events. Marks an instance as unread when
 * novel output exceeds a threshold (80 bytes of non-ANSI, non-duplicate
 * text). Skips marking when the user is actively viewing the instance.
 *
 * Also accumulates raw output bytes per instance, flushed to state every
 * 15 seconds to keep renders infrequent.
 */
export function useOutputTracking(
  activeViewRef: React.MutableRefObject<{ activeId: string | null; view: string }>,
  instances: ClaudeInstance[],
): OutputTrackingResult {
  const [unreadIds, setUnreadIds] = useState<Set<string>>(new Set())
  const [outputBytes, setOutputBytes] = useState<Map<string, number>>(new Map())
  const outputBytesAccRef = useRef<Map<string, number>>(new Map())

  // Single onOutput listener — handles both unread tracking and output byte counting
  useEffect(() => {
    const recentOutput = new Map<string, string>()
    const novelBytes = new Map<string, number>()
    const THRESHOLD = 80

    const unsub = window.api.instance.onOutput(({ id, data }) => {
      // Output byte accumulator (cheap — always runs)
      const acc = outputBytesAccRef.current
      acc.set(id, (acc.get(id) || 0) + data.length)

      // Unread tracking — skip if user is looking at this instance
      const { activeId: currentActive, view: currentView } = activeViewRef.current
      const isVisible = currentView === 'instances' && id === currentActive
      if (isVisible) {
        novelBytes.delete(id)
        recentOutput.delete(id)
        return
      }

      // Strip ANSI escapes and control chars
      const clean = stripAnsi(data)
        .replace(/[\x00-\x1F\x7F]/g, '')
        .trim()
      if (clean.length < 3) return

      // Compare against recent output — if the new text is a substring of
      // what we've already seen (or vice versa), it's a TUI redraw
      const prev = recentOutput.get(id) || ''
      if (prev.includes(clean) || clean.includes(prev)) {
        recentOutput.set(id, clean)
        return
      }

      // Check character-level novelty
      const prevChars = new Set(prev.split(''))
      let novelCount = 0
      for (const ch of clean) {
        if (!prevChars.has(ch)) novelCount++
      }
      if (clean.length > 10 && novelCount / clean.length < 0.3) {
        recentOutput.set(id, clean)
        return
      }

      recentOutput.set(id, clean)
      const total = (novelBytes.get(id) || 0) + clean.length
      novelBytes.set(id, total)

      if (total >= THRESHOLD) {
        novelBytes.delete(id)
        setUnreadIds((prev) => {
          if (prev.has(id)) return prev
          const next = new Set(prev)
          next.add(id)
          return next
        })
      }
    })
    // Flush accumulated bytes to state every 15s so renders stay infrequent
    const timer = setInterval(() => {
      setOutputBytes(new Map(outputBytesAccRef.current))
    }, 15_000)
    return () => { unsub(); clearInterval(timer) }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Remove stale entries when sessions are removed
  useEffect(() => {
    const ids = new Set(instances.map(i => i.id))
    outputBytesAccRef.current.forEach((_, id) => {
      if (!ids.has(id)) outputBytesAccRef.current.delete(id)
    })
  }, [instances])

  return { unreadIds, setUnreadIds, outputBytes }
}
