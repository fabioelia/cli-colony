import { describe, it, expect, vi, beforeEach } from 'vitest'

// Hoisted mock functions
const mockDaemonCreateInstance = vi.hoisted(() => vi.fn())
const mockDaemonGetAll = vi.hoisted(() => vi.fn())
const mockDaemonKill = vi.hoisted(() => vi.fn())
const mockIpcHandle = vi.hoisted(() => vi.fn())

// Capture registered IPC handlers so we can call them directly in tests
const _ipcHandlers: Record<string, (...args: unknown[]) => unknown> = {}

vi.doMock('electron', () => ({
  app: { getPath: vi.fn().mockReturnValue('/mock/home') },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      _ipcHandlers[channel] = handler
      mockIpcHandle(channel, handler)
    },
    on: vi.fn(),
  },
  BrowserWindow: { getAllWindows: vi.fn().mockReturnValue([]) },
  shell: { openExternal: vi.fn() },
}))

vi.doMock('../daemon-router', () => ({
  getDaemonRouter: () => ({
    createInstance: mockDaemonCreateInstance,
    getAllInstances: mockDaemonGetAll,
    killInstance: mockDaemonKill,
    on: vi.fn(),
    removeListener: vi.fn(),
    wireEvents: vi.fn(),
    getUpgradeState: vi.fn().mockReturnValue('idle'),
  }),
}))

vi.doMock('../settings', () => ({
  getSettings: vi.fn().mockResolvedValue({}),
  getSetting: vi.fn().mockResolvedValue(''),
  getDefaultArgs: vi.fn().mockResolvedValue(''),
  getDefaultCliBackend: vi.fn().mockResolvedValue('claude'),
  gitRemoteUrl: vi.fn().mockResolvedValue(''),
  getSettingSync: vi.fn().mockReturnValue(''),
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
vi.doMock('../jira', () => ({ transitionTicket: vi.fn(), addComment: vi.fn() }))

// Heavy deps used only by other handlers — stub to prevent import errors
vi.doMock('../resolve-command', () => ({ resolveCommand: vi.fn() }))
vi.doMock('../shell-pty', () => ({ createShell: vi.fn(), writeShell: vi.fn(), resizeShell: vi.fn(), killShell: vi.fn() }))
vi.doMock('../git-utils', () => ({ getLiveChanges: vi.fn() }))
vi.doMock('../scorecard-store', () => ({ getScoreCard: vi.fn(), saveScoreCard: vi.fn(), clearScoreCard: vi.fn() }))
vi.doMock('../send-prompt-when-ready', () => ({ sendPromptWhenReady: vi.fn() }))

const INST = { id: 'inst-1', name: 'Test', args: [], status: 'running', parentId: null, childIds: [], tokenUsage: { input: 0, output: 0 } }

describe('instance parent-child', () => {
  let createInstance: (opts: Record<string, unknown>) => Promise<unknown>

  beforeEach(async () => {
    vi.resetModules()
    vi.resetAllMocks()
    // Re-register mocks after resetModules
    vi.doMock('electron', () => ({
      app: { getPath: vi.fn().mockReturnValue('/mock/home') },
      ipcMain: {
        handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
          _ipcHandlers[channel] = handler
        },
        on: vi.fn(),
      },
      BrowserWindow: { getAllWindows: vi.fn().mockReturnValue([]) },
      shell: { openExternal: vi.fn() },
    }))
    vi.doMock('../daemon-router', () => ({
      getDaemonRouter: () => ({
        createInstance: mockDaemonCreateInstance,
        getAllInstances: mockDaemonGetAll,
        killInstance: mockDaemonKill,
        on: vi.fn(),
        removeListener: vi.fn(),
        wireEvents: vi.fn(),
        getUpgradeState: vi.fn().mockReturnValue('idle'),
      }),
    }))
    vi.doMock('../settings', () => ({
      getSettings: vi.fn().mockResolvedValue({}),
      getSetting: vi.fn().mockResolvedValue(''),
      getDefaultArgs: vi.fn().mockResolvedValue(''),
      getDefaultCliBackend: vi.fn().mockResolvedValue('claude'),
      gitRemoteUrl: vi.fn().mockResolvedValue(''),
      getSettingSync: vi.fn().mockReturnValue(''),
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
    vi.doMock('../jira', () => ({ transitionTicket: vi.fn(), addComment: vi.fn() }))
    vi.doMock('../resolve-command', () => ({ resolveCommand: vi.fn() }))
    vi.doMock('../shell-pty', () => ({ createShell: vi.fn(), writeShell: vi.fn(), resizeShell: vi.fn(), killShell: vi.fn() }))
    vi.doMock('../git-utils', () => ({ getLiveChanges: vi.fn() }))
    vi.doMock('../scorecard-store', () => ({ getScoreCard: vi.fn(), saveScoreCard: vi.fn(), clearScoreCard: vi.fn() }))
    vi.doMock('../send-prompt-when-ready', () => ({ sendPromptWhenReady: vi.fn() }))

    mockDaemonCreateInstance.mockResolvedValue({ ...INST })
    mockDaemonKill.mockResolvedValue(true)

    const mod = await import('../instance-manager')
    createInstance = mod.createInstance
  })

  // (a) createInstance persists parentId — passes it through to the daemon
  it('passes parentId to daemon when creating a child session', async () => {
    await createInstance({ workingDirectory: '/tmp', parentId: 'parent-session-1' })
    expect(mockDaemonCreateInstance).toHaveBeenCalledWith(
      expect.objectContaining({ parentId: 'parent-session-1' })
    )
  })

  it('omits parentId from daemon opts when not provided', async () => {
    await createInstance({ workingDirectory: '/tmp' })
    const opts = mockDaemonCreateInstance.mock.calls[0]?.[0] ?? {}
    expect(opts.parentId).toBeUndefined()
  })
})

describe('instance:stopChildren IPC handler', () => {
  beforeEach(async () => {
    vi.resetModules()
    vi.resetAllMocks()
    vi.doMock('electron', () => ({
      app: { getPath: vi.fn().mockReturnValue('/mock/home') },
      ipcMain: {
        handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
          _ipcHandlers[channel] = handler
        },
        on: vi.fn(),
      },
      BrowserWindow: { getAllWindows: vi.fn().mockReturnValue([]) },
      shell: { openExternal: vi.fn() },
    }))
    vi.doMock('../daemon-router', () => ({
      getDaemonRouter: () => ({
        createInstance: mockDaemonCreateInstance,
        getAllInstances: mockDaemonGetAll,
        killInstance: mockDaemonKill,
        on: vi.fn(),
        removeListener: vi.fn(),
        wireEvents: vi.fn(),
        getUpgradeState: vi.fn().mockReturnValue('idle'),
      }),
    }))
    vi.doMock('../settings', () => ({
      getSettings: vi.fn().mockResolvedValue({}),
      getSetting: vi.fn().mockResolvedValue(''),
      getDefaultArgs: vi.fn().mockResolvedValue(''),
      getDefaultCliBackend: vi.fn().mockResolvedValue('claude'),
      getSettingSync: vi.fn().mockReturnValue(''),
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
    vi.doMock('../jira', () => ({ transitionTicket: vi.fn(), addComment: vi.fn() }))
    vi.doMock('../resolve-command', () => ({ resolveCommand: vi.fn() }))
    vi.doMock('../shell-pty', () => ({ createShell: vi.fn(), writeShell: vi.fn(), resizeShell: vi.fn(), killShell: vi.fn() }))
    vi.doMock('../git-utils', () => ({ getLiveChanges: vi.fn() }))
    vi.doMock('../scorecard-store', () => ({ getScoreCard: vi.fn(), saveScoreCard: vi.fn(), clearScoreCard: vi.fn() }))
    vi.doMock('../send-prompt-when-ready', () => ({ sendPromptWhenReady: vi.fn() }))

    mockDaemonKill.mockResolvedValue(true)

    // Register handlers so _ipcHandlers is populated
    const { registerInstanceHandlers } = await import('../ipc/instance-handlers')
    registerInstanceHandlers()
  })

  // (b) stopChildren only kills running children of the given parent — not exited children, not other parents' children
  it('kills only running children of the target parent', async () => {
    const instances = [
      { id: 'p-1', parentId: null, status: 'running' },
      { id: 'c-1', parentId: 'p-1', status: 'running' },   // should stop
      { id: 'c-2', parentId: 'p-1', status: 'exited' },    // skip — exited
      { id: 'c-3', parentId: 'p-2', status: 'running' },   // skip — different parent
    ]
    mockDaemonGetAll.mockResolvedValue(instances)

    const handler = _ipcHandlers['instance:stopChildren']
    expect(handler).toBeDefined()
    const count = await handler({} as Event, 'p-1')

    expect(count).toBe(1)
    expect(mockDaemonKill).toHaveBeenCalledOnce()
    expect(mockDaemonKill).toHaveBeenCalledWith('c-1')
  })

  it('returns 0 and kills nothing when parent has no running children', async () => {
    const instances = [
      { id: 'c-1', parentId: 'p-1', status: 'exited' },
      { id: 'c-2', parentId: 'p-2', status: 'running' },
    ]
    mockDaemonGetAll.mockResolvedValue(instances)

    const handler = _ipcHandlers['instance:stopChildren']
    const count = await handler({} as Event, 'p-1')

    expect(count).toBe(0)
    expect(mockDaemonKill).not.toHaveBeenCalled()
  })
})
