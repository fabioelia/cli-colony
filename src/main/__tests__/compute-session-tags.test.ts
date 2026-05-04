import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ClaudeInstance } from '../../shared/types'

// Hoisted mocks
const mockExecSync = vi.hoisted(() => vi.fn())
const mockDaemonCreateInstance = vi.hoisted(() => vi.fn())

vi.doMock('child_process', () => ({
  execSync: mockExecSync,
  exec: vi.fn(),
  execFile: vi.fn(),
}))
vi.doMock('electron', () => ({
  app: { getPath: vi.fn().mockReturnValue('/mock/home') },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  BrowserWindow: { getAllWindows: vi.fn().mockReturnValue([]) },
  shell: { openExternal: vi.fn() },
}))
vi.doMock('../daemon-router', () => ({
  getDaemonRouter: () => ({
    createInstance: mockDaemonCreateInstance,
    getAllInstances: vi.fn().mockResolvedValue([]),
    killInstance: vi.fn().mockResolvedValue(true),
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
vi.doMock('../playbook-manager', () => ({ getPlaybookMemory: vi.fn().mockResolvedValue(''), appendPlaybookMemory: vi.fn() }))
vi.doMock('../project-brief', () => ({ getProjectBriefPath: vi.fn().mockReturnValue(null) }))
vi.doMock('../resolve-command', () => ({ resolveCommand: vi.fn() }))
vi.doMock('../shell-pty', () => ({ createShell: vi.fn(), writeShell: vi.fn(), resizeShell: vi.fn(), killShell: vi.fn() }))
vi.doMock('../git-utils', () => ({ getLiveChanges: vi.fn() }))
vi.doMock('../scorecard-store', () => ({ getScoreCard: vi.fn(), saveScoreCard: vi.fn(), clearScoreCard: vi.fn() }))
vi.doMock('../send-prompt-when-ready', () => ({ sendPromptWhenReady: vi.fn() }))

// Base instance: recent (< 2 min), no cost, no budget flag, plain name
const BASE: ClaudeInstance = {
  id: 'test-id',
  name: 'Test Session',
  color: '#fff',
  status: 'exited',
  activity: 'waiting',
  workingDirectory: '/proj',
  createdAt: new Date().toISOString(),
  exitCode: null,
  pid: null,
  args: [],
  cliBackend: 'claude',
  gitBranch: null,
  gitRepo: null,
  tokenUsage: { input: 0, output: 0, cost: 0 },
  pinned: false,
  mcpServers: [],
  parentId: null,
  childIds: [],
  roleTag: null,
}

describe('computeSessionTags', () => {
  let computeSessionTags: (inst: ClaudeInstance, exitCode: number) => string[]
  let recordStartHead: (instanceId: string, cwd: string) => void

  beforeEach(async () => {
    vi.resetModules()
    vi.resetAllMocks()
    // Re-register all mocks after resetModules
    vi.doMock('child_process', () => ({ execSync: mockExecSync, exec: vi.fn(), execFile: vi.fn() }))
    vi.doMock('electron', () => ({
      app: { getPath: vi.fn().mockReturnValue('/mock/home') },
      ipcMain: { handle: vi.fn(), on: vi.fn() },
      BrowserWindow: { getAllWindows: vi.fn().mockReturnValue([]) },
      shell: { openExternal: vi.fn() },
    }))
    vi.doMock('../daemon-router', () => ({
      getDaemonRouter: () => ({
        createInstance: mockDaemonCreateInstance,
        getAllInstances: vi.fn().mockResolvedValue([]),
        killInstance: vi.fn().mockResolvedValue(true),
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
    vi.doMock('../playbook-manager', () => ({ getPlaybookMemory: vi.fn().mockResolvedValue(''), appendPlaybookMemory: vi.fn() }))
    vi.doMock('../project-brief', () => ({ getProjectBriefPath: vi.fn().mockReturnValue(null) }))
    vi.doMock('../resolve-command', () => ({ resolveCommand: vi.fn() }))
    vi.doMock('../shell-pty', () => ({ createShell: vi.fn(), writeShell: vi.fn(), resizeShell: vi.fn(), killShell: vi.fn() }))
    vi.doMock('../git-utils', () => ({ getLiveChanges: vi.fn() }))
    vi.doMock('../scorecard-store', () => ({ getScoreCard: vi.fn(), saveScoreCard: vi.fn(), clearScoreCard: vi.fn() }))
    vi.doMock('../send-prompt-when-ready', () => ({ sendPromptWhenReady: vi.fn() }))

    const mod = await import('../instance-manager')
    computeSessionTags = mod.computeSessionTags
    recordStartHead = mod.recordStartHead
  })

  // --- failed tag ---
  it('adds failed when exitCode !== 0', () => {
    expect(computeSessionTags(BASE, 1)).toContain('failed')
  })

  it('omits failed when exitCode === 0', () => {
    expect(computeSessionTags(BASE, 0)).not.toContain('failed')
  })

  // --- pipeline / persona tags ---
  it('adds pipeline tag when pipelineName is set', () => {
    const inst = { ...BASE, pipelineName: 'My Pipeline' }
    expect(computeSessionTags(inst, 0)).toContain('pipeline')
  })

  it('adds persona tag when name starts with Persona:', () => {
    const inst = { ...BASE, name: 'Persona: Colony QA' }
    expect(computeSessionTags(inst, 0)).toContain('persona')
  })

  it('adds neither pipeline nor persona for plain session names', () => {
    const tags = computeSessionTags(BASE, 0)
    expect(tags).not.toContain('pipeline')
    expect(tags).not.toContain('persona')
  })

  // --- long-running tag ---
  it('adds long-running when session ran over 30 minutes', () => {
    const old = { ...BASE, createdAt: new Date(Date.now() - 31 * 60 * 1000).toISOString() }
    expect(computeSessionTags(old, 0)).toContain('long-running')
  })

  it('omits long-running for recent sessions', () => {
    expect(computeSessionTags(BASE, 0)).not.toContain('long-running')
  })

  // --- budget-exceeded tag ---
  it('adds budget-exceeded when inst.budgetExceeded is true', () => {
    const inst = { ...BASE, budgetExceeded: true }
    expect(computeSessionTags(inst, 0)).toContain('budget-exceeded')
  })

  it('omits budget-exceeded when flag is unset', () => {
    expect(computeSessionTags(BASE, 0)).not.toContain('budget-exceeded')
  })

  // --- costly tag ---
  it('adds costly when cost > $0.50', () => {
    const inst = { ...BASE, tokenUsage: { input: 0, output: 0, cost: 0.51 } }
    expect(computeSessionTags(inst, 0)).toContain('costly')
  })

  it('omits costly when cost is exactly $0.50 (boundary)', () => {
    const inst = { ...BASE, tokenUsage: { input: 0, output: 0, cost: 0.50 } }
    expect(computeSessionTags(inst, 0)).not.toContain('costly')
  })

  it('omits costly when tokenUsage.cost is undefined', () => {
    const inst = { ...BASE, tokenUsage: { input: 0, output: 0 } }
    expect(computeSessionTags(inst, 0)).not.toContain('costly')
  })

  // --- quick tag ---
  it('adds quick for short successful sessions', () => {
    const inst = { ...BASE, createdAt: new Date(Date.now() - 30_000).toISOString() }
    expect(computeSessionTags(inst, 0)).toContain('quick')
  })

  it('omits quick when exitCode !== 0 even if duration < 2 min', () => {
    const inst = { ...BASE, createdAt: new Date(Date.now() - 30_000).toISOString() }
    expect(computeSessionTags(inst, 1)).not.toContain('quick')
  })

  it('omits quick when duration >= 2 min', () => {
    const old = { ...BASE, createdAt: new Date(Date.now() - 3 * 60 * 1000).toISOString() }
    expect(computeSessionTags(old, 0)).not.toContain('quick')
  })

  // --- committed tag ---
  it('adds committed when HEAD changed between session start and exit', () => {
    mockExecSync
      .mockReturnValueOnce('abc123\n')  // recordStartHead
      .mockReturnValueOnce('def456\n')  // computeSessionTags check
    recordStartHead('test-id', '/proj')
    expect(computeSessionTags(BASE, 0)).toContain('committed')
  })

  it('omits committed when HEAD is unchanged', () => {
    mockExecSync.mockReturnValue('abc123\n')
    recordStartHead('test-id', '/proj')
    expect(computeSessionTags(BASE, 0)).not.toContain('committed')
  })

  it('omits committed when recordStartHead was never called', () => {
    // _startHeadCommits is empty; no git call should be made
    expect(computeSessionTags(BASE, 0)).not.toContain('committed')
    expect(mockExecSync).not.toHaveBeenCalled()
  })

  it('does not throw when recordStartHead git call fails', () => {
    mockExecSync.mockImplementation(() => { throw new Error('not a repo') })
    expect(() => recordStartHead('test-id', '/proj')).not.toThrow()
  })

  it('does not throw when computeSessionTags HEAD check fails after recordStartHead succeeds', () => {
    mockExecSync
      .mockReturnValueOnce('abc123\n')           // recordStartHead succeeds
      .mockImplementationOnce(() => { throw new Error('repo gone') })  // check fails
    recordStartHead('test-id', '/proj')
    expect(() => computeSessionTags(BASE, 0)).not.toThrow()
    expect(computeSessionTags(BASE, 0)).not.toContain('committed')
  })

  // --- fan-out tag ---
  it('adds fan-out tag when session was created as a fan-out child', async () => {
    mockDaemonCreateInstance.mockResolvedValue({
      ...BASE,
      id: 'child-id',
      status: 'running',
      activity: 'busy',
    })
    const mod = await import('../instance-manager')
    await mod.createInstance({ workingDirectory: '/tmp', fanOutParentId: 'parent-id' })
    const childInst = { ...BASE, id: 'child-id' }
    expect(mod.computeSessionTags(childInst, 0)).toContain('fan-out')
  })
})
