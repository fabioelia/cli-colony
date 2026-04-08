import { describe, it, expect, vi } from 'vitest'
import { computeNextPanelTab, computeTabKeyAction, shouldIgnoreTabKeyEvent } from '../usePanelTabKeys'

describe('computeNextPanelTab', () => {
  const tabs = ['session', 'shell', 'files', 'changes'] as const

  it('advances to the next tab', () => {
    expect(computeNextPanelTab(tabs, 'session', 'next')).toBe('shell')
    expect(computeNextPanelTab(tabs, 'shell', 'next')).toBe('files')
  })

  it('wraps to the first tab after the last', () => {
    expect(computeNextPanelTab(tabs, 'changes', 'next')).toBe('session')
  })

  it('moves to the previous tab', () => {
    expect(computeNextPanelTab(tabs, 'shell', 'prev')).toBe('session')
    expect(computeNextPanelTab(tabs, 'files', 'prev')).toBe('shell')
  })

  it('wraps to the last tab from the first', () => {
    expect(computeNextPanelTab(tabs, 'session', 'prev')).toBe('changes')
  })

  it('returns null when there are fewer than two tabs', () => {
    expect(computeNextPanelTab(['only'] as const, 'only', 'next')).toBeNull()
    expect(computeNextPanelTab([] as const, 'missing' as never, 'prev')).toBeNull()
  })

  it('returns null when active is not in the list', () => {
    expect(computeNextPanelTab(tabs, 'replay' as unknown as typeof tabs[number], 'next')).toBeNull()
  })

  it('supports dynamically shrinking tab arrays (role-gated tabs)', () => {
    const full = ['session', 'shell', 'team', 'metrics'] as const
    const limited = ['session', 'shell'] as const
    expect(computeNextPanelTab(full, 'metrics', 'next')).toBe('session')
    // Once team/metrics are filtered out, wrapping still works on the short list
    expect(computeNextPanelTab(limited, 'shell', 'next')).toBe('session')
  })
})

describe('shouldIgnoreTabKeyEvent', () => {
  function makeEl(tag: string, opts: { contentEditable?: boolean; closestMatch?: boolean } = {}): EventTarget {
    return {
      tagName: tag.toUpperCase(),
      isContentEditable: opts.contentEditable ?? false,
      closest: (_sel: string) => (opts.closestMatch ? {} : null),
    } as unknown as EventTarget
  }

  it('ignores input fields', () => {
    expect(shouldIgnoreTabKeyEvent(makeEl('input'))).toBe(true)
  })

  it('ignores textareas', () => {
    expect(shouldIgnoreTabKeyEvent(makeEl('textarea'))).toBe(true)
  })

  it('ignores contentEditable elements', () => {
    expect(shouldIgnoreTabKeyEvent(makeEl('div', { contentEditable: true }))).toBe(true)
  })

  it('ignores events inside the xterm terminal', () => {
    expect(shouldIgnoreTabKeyEvent(makeEl('div', { closestMatch: true }))).toBe(true)
  })

  it('passes through regular div clicks', () => {
    expect(shouldIgnoreTabKeyEvent(makeEl('div'))).toBe(false)
  })

  it('handles null target safely', () => {
    expect(shouldIgnoreTabKeyEvent(null)).toBe(false)
  })
})

describe('computeTabKeyAction', () => {
  const tabs = ['session', 'shell', 'files', 'changes'] as const

  function makeEvent(opts: {
    meta?: boolean
    ctrl?: boolean
    shift?: boolean
    key: string
    target?: EventTarget | null
  }) {
    return {
      metaKey: opts.meta ?? false,
      ctrlKey: opts.ctrl ?? false,
      shiftKey: opts.shift ?? false,
      key: opts.key,
      target: opts.target ?? null,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    }
  }

  function xtermTextareaTarget(): EventTarget {
    // Shape matches the real DOM path: a <textarea> living inside the
    // .xterm-helper-textarea wrapper that xterm.js focuses while the
    // session tab is active.
    return {
      tagName: 'TEXTAREA',
      isContentEditable: false,
      closest: (sel: string) =>
        sel.includes('xterm-helper-textarea') ? ({} as HTMLElement) : null,
    } as unknown as EventTarget
  }

  it('advances to the next tab on Cmd+Shift+}', () => {
    const e = makeEvent({ meta: true, shift: true, key: '}' })
    expect(computeTabKeyAction(e, tabs, 'session')).toBe('shell')
    expect(e.preventDefault).toHaveBeenCalledTimes(1)
    expect(e.stopPropagation).toHaveBeenCalledTimes(1)
  })

  it('moves to the previous tab on Cmd+Shift+{', () => {
    const e = makeEvent({ meta: true, shift: true, key: '{' })
    expect(computeTabKeyAction(e, tabs, 'shell')).toBe('session')
    expect(e.preventDefault).toHaveBeenCalledTimes(1)
  })

  it('accepts Ctrl+Shift+{/} for non-Mac users', () => {
    const next = makeEvent({ ctrl: true, shift: true, key: '}' })
    expect(computeTabKeyAction(next, tabs, 'session')).toBe('shell')
    const prev = makeEvent({ ctrl: true, shift: true, key: '{' })
    expect(computeTabKeyAction(prev, tabs, 'session')).toBe('changes')
  })

  it('REGRESSION: fires even when the event target is a textarea inside xterm', () => {
    // Fabio reported 2026-04-08: the shortcut silently died whenever the
    // session tab was focused because xterm's helper textarea was the
    // keydown target. The previous `shouldIgnoreTabKeyEvent(e.target)`
    // early-return has been removed — assert the xterm-hosted target no
    // longer blocks the cycle.
    const e = makeEvent({
      meta: true,
      shift: true,
      key: '}',
      target: xtermTextareaTarget(),
    })
    expect(computeTabKeyAction(e, tabs, 'files')).toBe('changes')
    expect(e.preventDefault).toHaveBeenCalledTimes(1)
    expect(e.stopPropagation).toHaveBeenCalledTimes(1)
  })

  it('REGRESSION: fires even when the event target is a bare <input>', () => {
    const inputTarget = { tagName: 'INPUT', isContentEditable: false, closest: () => null } as unknown as EventTarget
    const e = makeEvent({ meta: true, shift: true, key: '{', target: inputTarget })
    expect(computeTabKeyAction(e, tabs, 'session')).toBe('changes')
  })

  it('does NOT fire on bare `{` / `}` without modifiers (typing is still safe)', () => {
    // The real risk of removing the text-input guard is stealing bare
    // `{`/`}` keystrokes from a user typing into a prompt. Bare `{` is
    // `Shift+[` with no Cmd — the modifier gate catches it.
    const typed = makeEvent({ shift: true, key: '{', target: xtermTextareaTarget() })
    expect(computeTabKeyAction(typed, tabs, 'session')).toBeNull()
    expect(typed.preventDefault).not.toHaveBeenCalled()
    expect(typed.stopPropagation).not.toHaveBeenCalled()
  })

  it('does NOT fire without the Shift modifier', () => {
    const e = makeEvent({ meta: true, key: '{' })
    expect(computeTabKeyAction(e, tabs, 'session')).toBeNull()
    expect(e.preventDefault).not.toHaveBeenCalled()
  })

  it('does NOT fire without Cmd or Ctrl', () => {
    const e = makeEvent({ shift: true, key: '}' })
    expect(computeTabKeyAction(e, tabs, 'session')).toBeNull()
    expect(e.preventDefault).not.toHaveBeenCalled()
  })

  it('does NOT fire on unrelated keys', () => {
    const e = makeEvent({ meta: true, shift: true, key: 'a' })
    expect(computeTabKeyAction(e, tabs, 'session')).toBeNull()
    expect(e.preventDefault).not.toHaveBeenCalled()
  })

  it('returns null and skips preventDefault when the tab list is too short', () => {
    const e = makeEvent({ meta: true, shift: true, key: '}' })
    expect(computeTabKeyAction(e, ['only'] as const, 'only')).toBeNull()
    expect(e.preventDefault).not.toHaveBeenCalled()
  })

  it('returns null and skips preventDefault when active is not in the tab list', () => {
    const e = makeEvent({ meta: true, shift: true, key: '}' })
    expect(
      computeTabKeyAction(e, tabs, 'replay' as unknown as typeof tabs[number])
    ).toBeNull()
    expect(e.preventDefault).not.toHaveBeenCalled()
  })
})
