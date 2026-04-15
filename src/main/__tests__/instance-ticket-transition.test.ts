import { describe, it, expect, vi, beforeEach } from 'vitest'

// Hoisted mock functions
const mockTransitionTicket = vi.hoisted(() => vi.fn())
const mockGetSetting = vi.hoisted(() => vi.fn())
const mockCreateInstance = vi.hoisted(() => vi.fn())

vi.doMock('electron', () => ({
  app: { getPath: vi.fn().mockReturnValue('/mock/home') },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  BrowserWindow: { getAllWindows: vi.fn().mockReturnValue([]) },
  shell: { openExternal: vi.fn() },
}))

vi.doMock('../jira', () => ({ transitionTicket: mockTransitionTicket }))
vi.doMock('../settings', () => ({
  getSettings: vi.fn().mockResolvedValue({}),
  getSetting: mockGetSetting,
  getDefaultArgs: vi.fn().mockResolvedValue(''),
  getDefaultCliBackend: vi.fn().mockResolvedValue('claude-code'),
  gitRemoteUrl: vi.fn().mockResolvedValue(''),
  getSettingSync: vi.fn().mockReturnValue(''),
}))
vi.doMock('../daemon-router', () => ({
  getDaemonRouter: () => ({ createInstance: mockCreateInstance, on: vi.fn(), removeListener: vi.fn() }),
}))
vi.doMock('../broadcast', () => ({ broadcast: vi.fn() }))
vi.doMock('../mcp-catalog', () => ({ buildMcpConfig: vi.fn().mockResolvedValue(null), cleanMcpConfigFile: vi.fn() }))
vi.doMock('../rate-limit-state', () => ({ setRateLimited: vi.fn() }))
vi.doMock('../commit-attributor', () => ({ scanNewCommits: vi.fn() }))
vi.doMock('../onboarding-state', () => ({ markChecklistItem: vi.fn() }))
vi.doMock('../activity-manager', () => ({ appendActivity: vi.fn().mockResolvedValue(undefined) }))
vi.doMock('../error-parser', () => ({ parseErrorSummary: vi.fn().mockReturnValue(null) }))
vi.doMock('../recent-sessions', () => ({ trackOpened: vi.fn(), trackClosed: vi.fn() }))
vi.doMock('../notifications', () => ({ notify: vi.fn() }))

const TICKET = { key: 'NP-123', summary: 'Test ticket', url: 'https://jira.example.com/NP-123' }
const INST = { id: 'inst-1', name: 'Test', args: [], status: 'waiting' }

describe('instance session-start Jira transition', () => {
  let createInstance: (opts: Record<string, unknown>) => Promise<unknown>

  beforeEach(async () => {
    vi.resetModules()
    vi.doMock('electron', () => ({
      app: { getPath: vi.fn().mockReturnValue('/mock/home') },
      ipcMain: { handle: vi.fn(), on: vi.fn() },
      BrowserWindow: { getAllWindows: vi.fn().mockReturnValue([]) },
      shell: { openExternal: vi.fn() },
    }))
    vi.doMock('../jira', () => ({ transitionTicket: mockTransitionTicket }))
    vi.doMock('../settings', () => ({
      getSettings: vi.fn().mockResolvedValue({}),
      getSetting: mockGetSetting,
      getDefaultArgs: vi.fn().mockResolvedValue(''),
      getDefaultCliBackend: vi.fn().mockResolvedValue('claude-code'),
      gitRemoteUrl: vi.fn().mockResolvedValue(''),
      getSettingSync: vi.fn().mockReturnValue(''),
    }))
    vi.doMock('../daemon-router', () => ({
      getDaemonRouter: () => ({ createInstance: mockCreateInstance, on: vi.fn(), removeListener: vi.fn() }),
    }))
    vi.doMock('../broadcast', () => ({ broadcast: vi.fn() }))
    vi.doMock('../mcp-catalog', () => ({ buildMcpConfig: vi.fn().mockResolvedValue(null), cleanMcpConfigFile: vi.fn() }))
    vi.doMock('../rate-limit-state', () => ({ setRateLimited: vi.fn() }))
    vi.doMock('../commit-attributor', () => ({ scanNewCommits: vi.fn() }))
    vi.doMock('../onboarding-state', () => ({ markChecklistItem: vi.fn() }))
    vi.doMock('../activity-manager', () => ({ appendActivity: vi.fn().mockResolvedValue(undefined) }))
    vi.doMock('../error-parser', () => ({ parseErrorSummary: vi.fn().mockReturnValue(null) }))
    vi.doMock('../recent-sessions', () => ({ trackOpened: vi.fn(), trackClosed: vi.fn() }))
    vi.doMock('../notifications', () => ({ notify: vi.fn() }))

    mockTransitionTicket.mockReset()
    mockGetSetting.mockReset()
    mockCreateInstance.mockReset()
    mockCreateInstance.mockResolvedValue(INST)

    const mod = await import('../instance-manager')
    createInstance = mod.createInstance
  })

  it('calls transitionTicket with ticket key and setting when both present', async () => {
    mockGetSetting.mockResolvedValue('In Progress')
    await createInstance({ ticket: TICKET, workingDirectory: '/tmp' })
    // Fire-and-forget: allow microtasks to flush
    await new Promise(r => setTimeout(r, 0))
    expect(mockTransitionTicket).toHaveBeenCalledOnce()
    expect(mockTransitionTicket).toHaveBeenCalledWith(TICKET.key, 'In Progress')
  })

  it('does not call transitionTicket when setting is empty', async () => {
    mockGetSetting.mockResolvedValue('')
    await createInstance({ ticket: TICKET, workingDirectory: '/tmp' })
    await new Promise(r => setTimeout(r, 0))
    expect(mockTransitionTicket).not.toHaveBeenCalled()
  })

  it('does not call transitionTicket when setting is whitespace-only', async () => {
    mockGetSetting.mockResolvedValue('   ')
    await createInstance({ ticket: TICKET, workingDirectory: '/tmp' })
    await new Promise(r => setTimeout(r, 0))
    expect(mockTransitionTicket).not.toHaveBeenCalled()
  })

  it('does not call transitionTicket when no ticket attached', async () => {
    mockGetSetting.mockResolvedValue('In Progress')
    await createInstance({ workingDirectory: '/tmp' })
    await new Promise(r => setTimeout(r, 0))
    expect(mockTransitionTicket).not.toHaveBeenCalled()
  })

  it('swallows rejection — createInstance resolves even if transitionTicket throws', async () => {
    mockGetSetting.mockResolvedValue('In Progress')
    mockTransitionTicket.mockRejectedValue(new Error('Jira down'))
    await expect(createInstance({ ticket: TICKET, workingDirectory: '/tmp' })).resolves.toBeDefined()
    await new Promise(r => setTimeout(r, 0))
    // No unhandled rejection thrown
  })
})
