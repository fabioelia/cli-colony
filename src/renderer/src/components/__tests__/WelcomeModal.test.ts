import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderToString } from 'react-dom/server'
import { createElement } from 'react'

// Stub the browser API at global level for SSR
beforeEach(() => {
  ;(globalThis as any).window = {
    api: {
      prerequisites: { check: vi.fn().mockResolvedValue({ claude: { ok: true }, auth: { ok: true }, git: { ok: true }, github: { ok: false }, ready: true, checkedAt: Date.now() }) },
      onboarding: { skip: vi.fn().mockResolvedValue({}) },
    },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }
})

describe('WelcomeModal', () => {
  it('renders without throwing (SSR smoke test)', async () => {
    const mod = await import('../WelcomeModal')
    const WelcomeModal = mod.default
    const html = renderToString(createElement(WelcomeModal, { onClose: vi.fn() }))
    expect(html).toContain('Welcome to Colony')
    expect(html).toContain('Prerequisites')
    expect(html).toContain('Claude CLI')
    expect(html).toContain('Anthropic auth')
    expect(html).toContain('Git user.email')
    expect(html).toContain('GitHub token')
  })

  it('renders the Start button', async () => {
    const mod = await import('../WelcomeModal')
    const WelcomeModal = mod.default
    const html = renderToString(createElement(WelcomeModal, { onClose: vi.fn() }))
    expect(html).toContain('Start your first session')
  })

  it('renders Skip and Re-check controls', async () => {
    const mod = await import('../WelcomeModal')
    const WelcomeModal = mod.default
    const html = renderToString(createElement(WelcomeModal, { onClose: vi.fn() }))
    expect(html).toContain('Skip for now')
    expect(html).toContain('Re-check')
  })

  it('renders the command palette replay tip', async () => {
    const mod = await import('../WelcomeModal')
    const WelcomeModal = mod.default
    const html = renderToString(createElement(WelcomeModal, { onClose: vi.fn() }))
    expect(html).toContain('Show Welcome')
  })

  it('marks GitHub as optional', async () => {
    const mod = await import('../WelcomeModal')
    const WelcomeModal = mod.default
    const html = renderToString(createElement(WelcomeModal, { onClose: vi.fn() }))
    expect(html).toContain('(optional)')
  })

  it('has correct aria attributes', async () => {
    const mod = await import('../WelcomeModal')
    const WelcomeModal = mod.default
    const html = renderToString(createElement(WelcomeModal, { onClose: vi.fn() }))
    expect(html).toContain('role="dialog"')
    expect(html).toContain('aria-modal="true"')
    expect(html).toContain('aria-labelledby="welcome-title"')
  })
})
