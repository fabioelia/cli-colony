import { describe, it, expect } from 'vitest'
import { computeNextPanelTab, shouldIgnoreTabKeyEvent } from '../usePanelTabKeys'

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
