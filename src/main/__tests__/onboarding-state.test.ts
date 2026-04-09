import { describe, it, expect, beforeEach, vi } from 'vitest'

const mockFs = vi.hoisted(() => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => ''),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}))

vi.mock('fs', () => mockFs)

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
    mockFs.existsSync.mockReturnValue(false)
  })

  it('returns default state when no file exists', async () => {
    const mod = await loadModule()
    const state = mod.getOnboardingState()
    expect(state.firstRunCompletedAt).toBeNull()
    expect(state.prerequisitesOk.claude).toBe(false)
    expect(state.prerequisitesOk.auth).toBe(false)
    expect(state.prerequisitesOk.git).toBe(false)
    expect(state.prerequisitesOk.github).toBe(false)
    expect(state.checklist.createdSession).toBe(false)
    expect(state.checklist.ranFirstPrompt).toBe(false)
  })

  it('reads existing state from disk', async () => {
    mockFs.existsSync.mockReturnValue(true)
    mockFs.readFileSync.mockReturnValue(JSON.stringify({
      firstRunCompletedAt: '2026-01-01T00:00:00Z',
      prerequisitesOk: { claude: true, auth: true, git: true, github: false },
      checklist: { createdSession: true, ranFirstPrompt: false, createdPersona: false, connectedGitHub: false, ranPipeline: false },
    }))
    const mod = await loadModule()
    const state = mod.getOnboardingState()
    expect(state.firstRunCompletedAt).toBe('2026-01-01T00:00:00Z')
    expect(state.prerequisitesOk.claude).toBe(true)
    expect(state.checklist.createdSession).toBe(true)
    expect(state.checklist.ranFirstPrompt).toBe(false)
  })

  it('merges partial state with defaults (forward-compat)', async () => {
    mockFs.existsSync.mockReturnValue(true)
    mockFs.readFileSync.mockReturnValue(JSON.stringify({
      firstRunCompletedAt: '2026-01-01T00:00:00Z',
      // missing prerequisitesOk and checklist entirely
    }))
    const mod = await loadModule()
    const state = mod.getOnboardingState()
    expect(state.firstRunCompletedAt).toBe('2026-01-01T00:00:00Z')
    expect(state.prerequisitesOk.claude).toBe(false)
    expect(state.checklist.createdSession).toBe(false)
  })

  it('markChecklistItem flips a key and writes to disk', async () => {
    const mod = await loadModule()
    const state = mod.markChecklistItem('createdSession')
    expect(state.checklist.createdSession).toBe(true)
    expect(mockFs.writeFileSync).toHaveBeenCalledTimes(1)
    const written = JSON.parse(mockFs.writeFileSync.mock.calls[0][1])
    expect(written.checklist.createdSession).toBe(true)
  })

  it('markChecklistItem is idempotent — no write on second call', async () => {
    const mod = await loadModule()
    mod.markChecklistItem('createdSession')
    expect(mockFs.writeFileSync).toHaveBeenCalledTimes(1)
    mod.markChecklistItem('createdSession')
    expect(mockFs.writeFileSync).toHaveBeenCalledTimes(1)
  })

  it('setPrerequisiteSnapshot updates the boolean snapshot', async () => {
    const mod = await loadModule()
    mod.setPrerequisiteSnapshot({ claude: true, auth: true, git: true, github: false })
    const state = mod.getOnboardingState()
    expect(state.prerequisitesOk.claude).toBe(true)
    expect(state.prerequisitesOk.github).toBe(false)
  })

  it('skipWelcome sets firstRunCompletedAt to an ISO string', async () => {
    const mod = await loadModule()
    const state = mod.skipWelcome()
    expect(state.firstRunCompletedAt).toBeTruthy()
    // Verify it's a valid ISO date
    expect(new Date(state.firstRunCompletedAt!).toISOString()).toBe(state.firstRunCompletedAt)
  })

  it('replayWelcome resets firstRunCompletedAt to null', async () => {
    const mod = await loadModule()
    mod.skipWelcome()
    const state = mod.replayWelcome()
    expect(state.firstRunCompletedAt).toBeNull()
  })

  it('resetOnboarding clears everything back to defaults', async () => {
    const mod = await loadModule()
    mod.skipWelcome()
    mod.markChecklistItem('createdSession')
    mod.setPrerequisiteSnapshot({ claude: true, auth: true, git: true, github: true })
    const state = mod.resetOnboarding()
    expect(state.firstRunCompletedAt).toBeNull()
    expect(state.prerequisitesOk.claude).toBe(false)
    expect(state.checklist.createdSession).toBe(false)
  })

  it('broadcasts onboarding:stateChanged on each mutation', async () => {
    const { broadcast } = await import('../broadcast')
    const mod = await loadModule()
    mod.markChecklistItem('ranFirstPrompt')
    expect(broadcast).toHaveBeenCalledWith('onboarding:stateChanged', expect.objectContaining({
      checklist: expect.objectContaining({ ranFirstPrompt: true }),
    }))
  })

  it('handles corrupted JSON gracefully — falls back to defaults', async () => {
    mockFs.existsSync.mockReturnValue(true)
    mockFs.readFileSync.mockReturnValue('{not valid json')
    const mod = await loadModule()
    const state = mod.getOnboardingState()
    expect(state.firstRunCompletedAt).toBeNull()
    expect(state.checklist.createdSession).toBe(false)
  })

  it('__resetCacheForTest clears the in-memory cache', async () => {
    const mod = await loadModule()
    mod.markChecklistItem('createdSession')
    expect(mod.getOnboardingState().checklist.createdSession).toBe(true)
    mod.__resetCacheForTest()
    // After reset, the module re-reads from disk (which is mocked as non-existent)
    const state = mod.getOnboardingState()
    expect(state.checklist.createdSession).toBe(false)
  })
})
