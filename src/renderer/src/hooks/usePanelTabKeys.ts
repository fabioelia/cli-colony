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
 *
 * NOTE: no longer called from `usePanelTabKeys` — the Cmd+Shift modifier gate
 * is sufficient proof the user is issuing a command (typing `{`/`}` is bare
 * Shift+[ / Shift+] with no Cmd). Left exported for other callers that may
 * need a text-input guard.
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
 * Pure handler body for `usePanelTabKeys`. Given a KeyboardEvent-like object
 * and the current tab state, returns the next tab (and calls
 * `preventDefault` + `stopPropagation` on the event) or returns `null` when
 * the event doesn't match the Cmd+Shift+{/} shortcut or the tab list can't
 * be navigated.
 *
 * Exported so the full decision logic — including the intentional absence of
 * a text-input / xterm-target guard — can be exercised directly from unit
 * tests without jsdom.
 */
export function computeTabKeyAction<T extends string>(
  e: Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'shiftKey' | 'key'> & {
    preventDefault?: () => void
    stopPropagation?: () => void
  },
  tabs: readonly T[],
  active: T
): T | null {
  if (!(e.metaKey || e.ctrlKey)) return null
  // Cmd+{ / Cmd+} (with Shift) or Cmd+[ / Cmd+] (without Shift)
  // macOS Electron sometimes reports '['/']' instead of '{'/'}' when Cmd is held
  const isNext = e.key === '}' || (e.key === ']' && !e.shiftKey)
  const isPrev = e.key === '{' || (e.key === '[' && !e.shiftKey)
  if (!isNext && !isPrev) return null
  const next = computeNextPanelTab(tabs, active, isNext ? 'next' : 'prev')
  if (next === null) return null
  e.preventDefault?.()
  e.stopPropagation?.()
  return next
}

/**
 * Cmd+Shift+{ / Cmd+Shift+} (Ctrl+Shift on non-Mac) tab cycling for panels
 * with a tab row. Cycles left / right through the supplied `tabs` array,
 * wrapping at both ends.
 *
 * Pass the *currently visible* tab list so role- or state-gated tabs are
 * only part of the cycle when they're actually rendered. Call sites should
 * recompute the array on each render (cheap — it's just a few strings).
 *
 * - Works even when focus is inside a `<textarea>`, `<input>`, or the xterm
 *   helper textarea. The Cmd+Shift modifier combo is distinct from bare
 *   `{`/`}` typing (which is Shift+[ / Shift+] with no Cmd), so there's no
 *   risk of stealing keystrokes from a prompt.
 * - `enabled` flag lets the caller scope activation (e.g. only when the
 *   panel is focused / visible) so multiple panels mounted at once don't
 *   fight over the shortcut.
 * - Uses capture phase so the handler runs before any child listeners
 *   (including xterm's own keydown table).
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
      const next = computeTabKeyAction(e, tabs, active)
      if (next !== null) setActive(next)
    }

    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [tabs, active, setActive, enabled])
}
