import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderToString } from 'react-dom/server'
import { createElement } from 'react'

const mockOnboardingState = {
  firstRunCompletedAt: '2026-01-01T00:00:00Z',
  prerequisitesOk: { claude: true, auth: true, git: true, github: false },
  checklist: {
    createdSession: true,
    ranFirstPrompt: true,
    createdPersona: false,
    connectedGitHub: false,
    ranPipeline: false,
  },
}

beforeEach(() => {
  vi.resetModules()
  ;(globalThis as any).window = {
    api: {
      settings: { getAll: vi.fn().mockResolvedValue({}), getShells: vi.fn().mockResolvedValue([]), detectGitProtocol: vi.fn().mockResolvedValue('ssh'), set: vi.fn().mockResolvedValue(undefined) },
      daemon: { getVersion: vi.fn().mockResolvedValue({ running: 1, expected: 1 }) },
      mcp: { list: vi.fn().mockResolvedValue([]), getAuditLog: vi.fn().mockResolvedValue([]) },
      session: { getAttributedCommits: vi.fn().mockResolvedValue([]) },
      sessionTemplates: { list: vi.fn().mockResolvedValue([]) },
      governance: { getQuotas: vi.fn().mockResolvedValue({ quotas: [] }), auditLog: vi.fn().mockResolvedValue([]) },
      approvalRules: { list: vi.fn().mockResolvedValue([]) },
      onboarding: {
        getState: vi.fn().mockResolvedValue(mockOnboardingState),
        replay: vi.fn().mockResolvedValue({ ...mockOnboardingState, firstRunCompletedAt: null }),
        reset: vi.fn().mockResolvedValue({ firstRunCompletedAt: null, prerequisitesOk: { claude: false, auth: false, git: false, github: false }, checklist: { createdSession: false, ranFirstPrompt: false, createdPersona: false, connectedGitHub: false, ranPipeline: false } }),
      },
      logs: { get: vi.fn().mockResolvedValue(''), getScheduler: vi.fn().mockResolvedValue([]), clear: vi.fn() },
      updates: { getStatus: vi.fn().mockResolvedValue(null), checkNow: vi.fn().mockResolvedValue(null), setAutoCheck: vi.fn() },
    },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }
})

describe('SettingsPanel — Onboarding section', () => {
  it('renders the Onboarding section header', async () => {
    const mod = await import('../SettingsPanel')
    const SettingsPanel = mod.default
    const html = renderToString(createElement(SettingsPanel, { onBack: vi.fn() }))
    expect(html).toContain('Onboarding')
  })

  it('renders within the settings panel structure', async () => {
    const mod = await import('../SettingsPanel')
    const SettingsPanel = mod.default
    const html = renderToString(createElement(SettingsPanel, { onBack: vi.fn() }))
    // Verify it renders alongside other known sections
    expect(html).toContain('CLI')
    expect(html).toContain('General')
    expect(html).toContain('Onboarding')
    expect(html).toContain('Scheduler Log')
  })
})
