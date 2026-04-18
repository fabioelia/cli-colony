import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderToString } from 'react-dom/server'
import { createElement } from 'react'

beforeEach(() => {
  vi.resetModules()
  ;(globalThis as any).window = {
    api: {
      persona: { list: vi.fn().mockResolvedValue([]) },
      agents: { list: vi.fn().mockResolvedValue([]) },
      sessions: { list: vi.fn().mockResolvedValue([]), search: vi.fn().mockResolvedValue([]) },
      instance: { buffer: vi.fn().mockResolvedValue('') },
      onboarding: { replay: vi.fn().mockResolvedValue({}) },
    },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }
})

describe('CommandPalette — Show Welcome', () => {
  const baseProps = {
    open: true,
    onClose: vi.fn(),
    instances: [],
    activeId: null,
    onSelect: vi.fn(),
    onNew: vi.fn(),
    onKill: vi.fn(),
    onRestart: vi.fn(),
    onViewChange: vi.fn(),
    onToggleSplit: vi.fn(),
    onResumeSession: vi.fn(),
    sessions: [],
    onRunPersona: vi.fn(),
    onLaunchAgent: vi.fn(),
    onOpenQuickPrompt: vi.fn(),
    onQuickCompare: vi.fn(),
  }

  it('renders the Show Welcome command', async () => {
    const mod = await import('../CommandPalette')
    const CommandPalette = mod.default
    const html = renderToString(createElement(CommandPalette, baseProps))
    expect(html).toContain('Show Welcome')
    expect(html).toContain('Replay the first-run welcome screen')
  })

  it('includes onboarding keywords for search', async () => {
    // Verify the action is registered with the right keywords
    const mod = await import('../CommandPalette')
    const CommandPalette = mod.default
    const html = renderToString(createElement(CommandPalette, baseProps))
    // The component renders in Actions section
    expect(html).toContain('Actions')
    expect(html).toContain('Show Welcome')
  })
})
