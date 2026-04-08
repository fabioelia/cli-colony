import { useEffect } from 'react'

/**
 * Compute the next tab index when cycling left/right. Wraps at both ends.
 * Returns `null` if `active` isn't present in `tabs` (no navigation).
 *
 * Pure, so it can be unit-tested without jsdom / real DOM events.
 */
export function computeNextPanelTab<T extends string>(
  tabs: readonly T[],
  active: T,
  direction: 'prev' | 'next'
): T | null {
  if (tabs.length < 2) return null
  const currentIndex = tabs.indexOf(active)
  if (currentIndex === -1) return null
  const nextIndex = direction === 'next'
    ? (currentIndex + 1) % tabs.length
    : (currentIndex - 1 + tabs.length) % tabs.length
  return tabs[nextIndex]
}

/**
 * Returns `true` if the key event should be ignored because it originated
 * from a text input / editor / terminal. Pure so it's testable.
 */
export function shouldIgnoreTabKeyEvent(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el) return false
  const tag = el.tagName?.toLowerCase()
  if (tag === 'input' || tag === 'textarea') return true
  if (el.isContentEditable) return true
  if (typeof el.closest === 'function' && el.closest('.xterm-helper-textarea, .xterm-screen, .terminal-container')) return true
  return false
}

/**
 * Cmd+{ / Cmd+} (Ctrl+{ / Ctrl+} on non-Mac) tab cycling for panels with a
 * tab row. Cycles left / right through the supplied `tabs` array, wrapping
 * at both ends.
 *
 * Pass the *currently visible* tab list so role- or state-gated tabs are
 * only part of the cycle when they're actually rendered. Call sites should
 * recompute the array on each render (cheap — it's just a few strings).
 *
 * - Ignores events inside `<input>`, `<textarea>`, xterm helper textareas,
 *   and contentEditable elements so typing `{`/`}` in a prompt still works.
 * - `enabled` flag lets the caller scope activation (e.g. only when the
 *   panel is focused / visible) so multiple panels mounted at once don't
 *   fight over the shortcut.
 * - Uses capture phase so the handler runs before any child listeners.
 */
export function usePanelTabKeys<T extends string>(
  tabs: readonly T[],
  active: T,
  setActive: (tab: T) => void,
  enabled: boolean = true
): void {
  useEffect(() => {
    if (!enabled) return
    if (tabs.length < 2) return

    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || !e.shiftKey) return
      if (e.key !== '{' && e.key !== '}') return
      if (shouldIgnoreTabKeyEvent(e.target)) return

      const next = computeNextPanelTab(tabs, active, e.key === '}' ? 'next' : 'prev')
      if (next === null) return

      e.preventDefault()
      e.stopPropagation()
      setActive(next)
    }

    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [tabs, active, setActive, enabled])
}
