import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderToString } from 'react-dom/server'
import { createElement } from 'react'

// Stub the browser API at global level for SSR
beforeEach(() => {
  ;(globalThis as any).window = {
    api: {
      prerequisites: { check: vi.fn().mockResolvedValue({ claude: { ok: true }, auth: { ok: true }, git: { ok: true }, github: { ok: false }, ready: true, checkedAt: Date.now() }) },
      onboarding: { skip: vi.fn().mockResolvedValue({}) },
      env: { listTemplates: vi.fn().mockResolvedValue([]) },
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
  })

  it('renders the feature discovery section', async () => {
    const mod = await import('../WelcomeModal')
    const html = renderToString(createElement(mod.default, { onClose: vi.fn() }))
    expect(html).toContain('Sessions')
    expect(html).toContain('Environments')
    expect(html).toContain('Personas')
    expect(html).toContain('Pipelines')
    expect(html).toContain('Orchestrate AI agents')
  })

  it('renders all 4 feature cards with descriptions', async () => {
    const mod = await import('../WelcomeModal')
    const html = renderToString(createElement(mod.default, { onClose: vi.fn() }))
    expect(html).toContain('Run multiple Claude agents side-by-side')
    expect(html).toContain('Spin up full dev stacks')
    expect(html).toContain('persistent memory')
    expect(html).toContain('Automated workflows')
  })

  it('renders the plus line', async () => {
    const mod = await import('../WelcomeModal')
    const html = renderToString(createElement(mod.default, { onClose: vi.fn() }))
    expect(html).toContain('GitHub PR tracking')
  })

  it('renders prerequisites section', async () => {
    const mod = await import('../WelcomeModal')
    const html = renderToString(createElement(mod.default, { onClose: vi.fn() }))
    expect(html).toContain('Prerequisites')
    expect(html).toContain('Claude CLI')
    expect(html).toContain('Anthropic auth')
    expect(html).toContain('Git user.email')
    expect(html).toContain('GitHub token')
  })

  it('renders the Get started button', async () => {
    const mod = await import('../WelcomeModal')
    const html = renderToString(createElement(mod.default, { onClose: vi.fn() }))
    expect(html).toContain('Get started')
  })

  it('renders Skip and Re-check controls', async () => {
    const mod = await import('../WelcomeModal')
    const html = renderToString(createElement(mod.default, { onClose: vi.fn() }))
    expect(html).toContain('Skip for now')
    expect(html).toContain('Re-check')
  })

  it('renders the command palette replay tip', async () => {
    const mod = await import('../WelcomeModal')
    const html = renderToString(createElement(mod.default, { onClose: vi.fn() }))
    expect(html).toContain('Show Welcome')
  })

  it('marks GitHub as optional', async () => {
    const mod = await import('../WelcomeModal')
    const html = renderToString(createElement(mod.default, { onClose: vi.fn() }))
    expect(html).toContain('(optional)')
  })

  it('has correct aria attributes', async () => {
    const mod = await import('../WelcomeModal')
    const html = renderToString(createElement(mod.default, { onClose: vi.fn() }))
    expect(html).toContain('role="dialog"')
    expect(html).toContain('aria-modal="true"')
    expect(html).toContain('aria-labelledby="welcome-title"')
  })

  it('renders template callout', async () => {
    const mod = await import('../WelcomeModal')
    const html = renderToString(createElement(mod.default, { onClose: vi.fn() }))
    // Shows the zero-templates message on initial render
    expect(html).toContain('Create your first environment template')
  })
})
