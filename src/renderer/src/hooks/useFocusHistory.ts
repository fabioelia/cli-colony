import { useState, useEffect, useRef, useCallback } from 'react'

interface FocusHistoryResult {
  /** Suppress history push during programmatic back/forward navigation. */
  focusNavRef: React.MutableRefObject<boolean>
  /** Remove an instance from the history (call on instance removal). */
  removeFromHistory: (id: string) => void
}

/**
 * Maintains a back/forward focus history for session navigation.
 *
 * Pushes `activeId` changes onto a capped (20-entry) stack. Registers
 * Cmd+Alt+Left/Right keyboard handlers for back/forward navigation.
 * Set `focusNavRef.current = true` before programmatic `setActiveId`
 * calls to suppress the push.
 */
export function useFocusHistory(
  activeId: string | null,
  setActiveId: (id: string) => void,
): FocusHistoryResult {
  const [focusHistory, setFocusHistory] = useState<string[]>([])
  const [focusHistoryIdx, setFocusHistoryIdx] = useState(-1)
  const focusNavRef = useRef(false)

  // Push to focus history when activeId changes (skip during back/forward nav)
  useEffect(() => {
    if (!activeId || focusNavRef.current) {
      focusNavRef.current = false
      return
    }
    setFocusHistory(prev => {
      const trimmed = prev.slice(0, focusHistoryIdx + 1) // clear forward stack
      if (trimmed[trimmed.length - 1] === activeId) return trimmed // collapse duplicates
      const next = [...trimmed, activeId].slice(-20) // cap at 20
      setFocusHistoryIdx(next.length - 1)
      return next
    })
  }, [activeId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Cmd+Alt+Left/Right for session focus history (back/forward)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || !e.altKey) return
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        setFocusHistoryIdx(prev => {
          if (prev <= 0) return prev
          const newIdx = prev - 1
          focusNavRef.current = true
          setActiveId(focusHistory[newIdx])
          return newIdx
        })
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        setFocusHistoryIdx(prev => {
          if (prev >= focusHistory.length - 1) return prev
          const newIdx = prev + 1
          focusNavRef.current = true
          setActiveId(focusHistory[newIdx])
          return newIdx
        })
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [focusHistory, setActiveId])

  const removeFromHistory = useCallback((id: string) => {
    setFocusHistory(prev => prev.filter(h => h !== id))
    setFocusHistoryIdx(prev => {
      const filtered = focusHistory.filter(h => h !== id)
      return Math.min(prev, filtered.length - 1)
    })
  }, [focusHistory])

  return { focusNavRef, removeFromHistory }
}
