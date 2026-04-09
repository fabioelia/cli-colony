import { describe, it, expect, beforeEach, vi } from 'vitest'

const mockFsp = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
}))

vi.mock('fs', () => ({
  promises: mockFsp,
}))

vi.mock('../../shared/colony-paths', () => ({
  colonyPaths: {
    onboardingStateJson: '/mock/.claude-colony/onboarding-state.json',
  },
}))

vi.mock('../broadcast', () => ({
  broadcast: vi.fn(),
}))

async function loadModule() {
  vi.resetModules()
  return await import('../onboarding-state')
}

describe('onboarding-state', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Default: readFile rejects with ENOENT (file does not exist)
    mockFsp.readFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
    mockFsp.writeFile.mockResolvedValue(undefined)
    mockFsp.mkdir.mockResolvedValue(undefined)
  })

  it('returns default state when no file exists', async () => {
    const mod = await loadModule()
    const state = await mod.getOnboardingState()
    expect(state.firstRunCompletedAt).toBeNull()
    expect(state.prerequisitesOk.claude).toBe(false)
    expect(state.prerequisitesOk.auth).toBe(false)
    expect(state.prerequisitesOk.git).toBe(false)
    expect(state.prerequisitesOk.github).toBe(false)
    expect(state.checklist.createdSession).toBe(false)
    expect(state.checklist.ranFirstPrompt).toBe(false)
  })

  it('reads existing state from disk', async () => {
    mockFsp.readFile.mockResolvedValue(JSON.stringify({
      firstRunCompletedAt: '2026-01-01T00:00:00Z',
      prerequisitesOk: { claude: true, auth: true, git: true, github: false },
      checklist: { createdSession: true, ranFirstPrompt: false, createdPersona: false, connectedGitHub: false, ranPipeline: false },
    }))
    const mod = await loadModule()
    const state = await mod.getOnboardingState()
    expect(state.firstRunCompletedAt).toBe('2026-01-01T00:00:00Z')
    expect(state.prerequisitesOk.claude).toBe(true)
    expect(state.checklist.createdSession).toBe(true)
    expect(state.checklist.ranFirstPrompt).toBe(false)
  })

  it('merges partial state with defaults (forward-compat)', async () => {
    mockFsp.readFile.mockResolvedValue(JSON.stringify({
      firstRunCompletedAt: '2026-01-01T00:00:00Z',
      // missing prerequisitesOk and checklist entirely
    }))
    const mod = await loadModule()
    const state = await mod.getOnboardingState()
    expect(state.firstRunCompletedAt).toBe('2026-01-01T00:00:00Z')
    expect(state.prerequisitesOk.claude).toBe(false)
    expect(state.checklist.createdSession).toBe(false)
  })

  it('markChecklistItem flips a key and writes to disk', async () => {
    const mod = await loadModule()
    const state = await mod.markChecklistItem('createdSession')
    expect(state.checklist.createdSession).toBe(true)
    expect(mockFsp.writeFile).toHaveBeenCalledTimes(1)
    const written = JSON.parse(mockFsp.writeFile.mock.calls[0][1])
    expect(written.checklist.createdSession).toBe(true)
  })

  it('markChecklistItem is idempotent — no write on second call', async () => {
    const mod = await loadModule()
    await mod.markChecklistItem('createdSession')
    expect(mockFsp.writeFile).toHaveBeenCalledTimes(1)
    await mod.markChecklistItem('createdSession')
    expect(mockFsp.writeFile).toHaveBeenCalledTimes(1)
  })

  it('setPrerequisiteSnapshot updates the boolean snapshot', async () => {
    const mod = await loadModule()
    await mod.setPrerequisiteSnapshot({ claude: true, auth: true, git: true, github: false })
    const state = await mod.getOnboardingState()
    expect(state.prerequisitesOk.claude).toBe(true)
    expect(state.prerequisitesOk.github).toBe(false)
  })

  it('skipWelcome sets firstRunCompletedAt to an ISO string', async () => {
    const mod = await loadModule()
    const state = await mod.skipWelcome()
    expect(state.firstRunCompletedAt).toBeTruthy()
    // Verify it's a valid ISO date
    expect(new Date(state.firstRunCompletedAt!).toISOString()).toBe(state.firstRunCompletedAt)
  })

  it('replayWelcome resets firstRunCompletedAt to null', async () => {
    const mod = await loadModule()
    await mod.skipWelcome()
    const state = await mod.replayWelcome()
    expect(state.firstRunCompletedAt).toBeNull()
  })

  it('resetOnboarding clears everything back to defaults', async () => {
    const mod = await loadModule()
    await mod.skipWelcome()
    await mod.markChecklistItem('createdSession')
    await mod.setPrerequisiteSnapshot({ claude: true, auth: true, git: true, github: true })
    const state = await mod.resetOnboarding()
    expect(state.firstRunCompletedAt).toBeNull()
    expect(state.prerequisitesOk.claude).toBe(false)
    expect(state.checklist.createdSession).toBe(false)
  })

  it('broadcasts onboarding:stateChanged on each mutation', async () => {
    const { broadcast } = await import('../broadcast')
    const mod = await loadModule()
    await mod.markChecklistItem('ranFirstPrompt')
    expect(broadcast).toHaveBeenCalledWith('onboarding:stateChanged', expect.objectContaining({
      checklist: expect.objectContaining({ ranFirstPrompt: true }),
    }))
  })

  it('handles corrupted JSON gracefully — falls back to defaults', async () => {
    mockFsp.readFile.mockResolvedValue('{not valid json')
    const mod = await loadModule()
    const state = await mod.getOnboardingState()
    expect(state.firstRunCompletedAt).toBeNull()
    expect(state.checklist.createdSession).toBe(false)
  })

  it('__resetCacheForTest clears the in-memory cache', async () => {
    const mod = await loadModule()
    await mod.markChecklistItem('createdSession')
    expect((await mod.getOnboardingState()).checklist.createdSession).toBe(true)
    mod.__resetCacheForTest()
    // After reset, the module re-reads from disk (which is mocked as non-existent)
    const state = await mod.getOnboardingState()
    expect(state.checklist.createdSession).toBe(false)
  })
})
