/**
 * Tests for writeProofBundle() and pruneOldProofs() inside wireDaemonEvents().
 *
 * Both functions are private to wireDaemonEvents(). We reach them by:
 *  - writeProofBundle: capturing the router 'exited' handler and calling it
 *  - pruneOldProofs: using fake timers to advance past the 60s startup setTimeout
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ---- Shared mock state ----

const mockFsp = {
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn().mockRejectedValue(new Error('ENOENT')),
  readdir: vi.fn().mockResolvedValue([]),
  stat: vi.fn().mockResolvedValue({ mtimeMs: 0 }),
  unlink: vi.fn().mockResolvedValue(undefined),
  rmdir: vi.fn().mockResolvedValue(undefined),
}

const mockExecFile = vi.hoisted(() => vi.fn())
const mockBroadcast = vi.hoisted(() => vi.fn())
const mockGetInstance = vi.hoisted(() => vi.fn())
const mockGetInstanceBuffer = vi.hoisted(() => vi.fn().mockResolvedValue(''))
const mockGetAllInstances = vi.hoisted(() => vi.fn().mockResolvedValue([]))

// Captures router event handlers registered by wireDaemonEvents()
const _routerHandlers: Record<string, (...args: unknown[]) => unknown> = {}

const MOCK_PROOFS_DIR = '/mock/.claude-colony/proofs'

function makeInst(overrides: Record<string, unknown> = {}) {
  return {
    id: 'inst-1',
    name: 'Test Session',
    status: 'exited' as const,
    args: [],
    createdAt: new Date(Date.now() - 10_000).toISOString(), // 10s ago by default → passes 5s threshold
    workingDirectory: '/repos/test',
    tokenUsage: { cost: 0.05, input: 1000, output: 500 },
    gitBranch: 'main',
    parentId: null,
    childIds: [],
    ...overrides,
  }
}

function registerMocks() {
  vi.doMock('electron', () => ({
    app: { getPath: vi.fn().mockReturnValue('/mock/home') },
    ipcMain: { handle: vi.fn(), on: vi.fn() },
    BrowserWindow: { getAllWindows: vi.fn().mockReturnValue([]) },
    shell: { openExternal: vi.fn(), openPath: vi.fn() },
  }))

  vi.doMock('fs', () => ({
    promises: mockFsp,
    existsSync: vi.fn().mockReturnValue(false),
    statSync: vi.fn().mockReturnValue({ mtime: new Date() }),
  }))

  vi.doMock('child_process', () => ({ exec: vi.fn(), execFile: mockExecFile }))

  vi.doMock('../daemon-router', () => ({
    getDaemonRouter: () => ({
      wireEvents: vi.fn(),
      primaryClient: {},
      on: (event: string, handler: (...args: unknown[]) => unknown) => {
        _routerHandlers[event] = handler
      },
      getAllInstances: mockGetAllInstances,
      getInstance: mockGetInstance,
      getInstanceBuffer: mockGetInstanceBuffer,
      removeInstance: vi.fn().mockResolvedValue(undefined),
    }),
  }))

  vi.doMock('../../shared/colony-paths', () => ({
    colonyPaths: {
      proofs: MOCK_PROOFS_DIR,
      proofFile: (date: string, slug: string, ts: number) =>
        `${MOCK_PROOFS_DIR}/${date}/${slug}-${ts}.md`,
    },
  }))

  vi.doMock('../broadcast', () => ({ broadcast: mockBroadcast }))

  vi.doMock('../settings', () => ({
    getSettings: vi.fn().mockResolvedValue({}),
    getSetting: vi.fn().mockResolvedValue(''),
    getDefaultArgs: vi.fn().mockResolvedValue(''),
    getDefaultCliBackend: vi.fn().mockResolvedValue('claude'),
    gitRemoteUrl: vi.fn().mockResolvedValue(''),
    getSettingSync: vi.fn().mockReturnValue(''),
  }))

  vi.doMock('../activity-manager', () => ({ appendActivity: vi.fn().mockResolvedValue(undefined) }))
  vi.doMock('../notifications', () => ({ notify: vi.fn() }))
  vi.doMock('../commit-attributor', () => ({ scanNewCommits: vi.fn().mockResolvedValue(undefined) }))
  vi.doMock('../onboarding-state', () => ({ markChecklistItem: vi.fn() }))
  vi.doMock('../recent-sessions', () => ({ trackOpened: vi.fn(), trackClosed: vi.fn() }))
  vi.doMock('../error-parser', () => ({ parseErrorSummary: vi.fn().mockReturnValue(null) }))
  vi.doMock('../jira', () => ({ transitionTicket: vi.fn(), addComment: vi.fn() }))
  vi.doMock('../mcp-catalog', () => ({
    buildMcpConfig: vi.fn().mockResolvedValue(null),
    cleanMcpConfigFile: vi.fn(),
  }))
  vi.doMock('../rate-limit-state', () => ({ setRateLimited: vi.fn() }))
  vi.doMock('../project-brief', () => ({ getProjectBriefPath: vi.fn().mockReturnValue(null) }))
  vi.doMock('../playbook-manager', () => ({
    getPlaybookMemory: vi.fn().mockResolvedValue(null),
    appendPlaybookMemory: vi.fn(),
  }))
  vi.doMock('../resolve-command', () => ({ resolveCommand: vi.fn() }))
  vi.doMock('../shell-pty', () => ({
    createShell: vi.fn(),
    writeShell: vi.fn(),
    resizeShell: vi.fn(),
    killShell: vi.fn(),
  }))
  vi.doMock('../git-utils', () => ({ getLiveChanges: vi.fn() }))
  vi.doMock('../scorecard-store', () => ({
    getScoreCard: vi.fn(),
    saveScoreCard: vi.fn(),
    clearScoreCard: vi.fn(),
  }))
  vi.doMock('../send-prompt-when-ready', () => ({ sendPromptWhenReady: vi.fn() }))
}

// Flush pending microtasks and immediate callbacks so fire-and-forget chains complete
function flushAsync() {
  return new Promise<void>(resolve => setTimeout(resolve, 10))
}

// ---- writeProofBundle tests ----

describe('writeProofBundle (via exited event handler)', () => {
  beforeEach(async () => {
    vi.resetModules()
    vi.resetAllMocks()
    // Reset fsp mock return values after resetAllMocks
    mockFsp.mkdir.mockResolvedValue(undefined)
    mockFsp.writeFile.mockResolvedValue(undefined)
    mockFsp.readdir.mockResolvedValue([])
    mockFsp.stat.mockResolvedValue({ mtimeMs: 0 })
    mockFsp.unlink.mockResolvedValue(undefined)
    mockFsp.rmdir.mockResolvedValue(undefined)
    mockGetInstanceBuffer.mockResolvedValue('')
    mockGetAllInstances.mockResolvedValue([])
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: object, callback: (err: null, out: string) => void) => {
        callback(null, 'abc123 feat: some commit')
      }
    )
    // Clear captured handlers from previous test
    for (const key of Object.keys(_routerHandlers)) delete _routerHandlers[key]
    registerMocks()

    const mod = await import('../instance-manager')
    mod.wireDaemonEvents()
  })

  it('skips writing proof for sessions shorter than 5 seconds', async () => {
    const shortInst = makeInst({ createdAt: new Date(Date.now() - 1_000).toISOString() })
    mockGetInstance.mockResolvedValue(shortInst)

    await _routerHandlers['exited']('inst-1', 0)
    await flushAsync()

    expect(mockFsp.writeFile).not.toHaveBeenCalled()
  })

  it('writes proof file for sessions >= 5 seconds', async () => {
    const inst = makeInst() // 10s ago by default
    mockGetInstance.mockResolvedValue(inst)

    await _routerHandlers['exited']('inst-1', 0)
    await flushAsync()

    expect(mockFsp.writeFile).toHaveBeenCalledTimes(1)
  })

  it('skips writing if getInstance returns null inside writeProofBundle', async () => {
    // First getInstance call (outer exited handler) returns an instance
    // Second call (inside writeProofBundle) returns null
    mockGetInstance
      .mockResolvedValueOnce(makeInst())
      .mockResolvedValueOnce(null)

    await _routerHandlers['exited']('inst-1', 0)
    await flushAsync()

    expect(mockFsp.writeFile).not.toHaveBeenCalled()
  })

  it('proof file content includes YAML frontmatter fields', async () => {
    const inst = makeInst({ tokenUsage: { cost: 0.1234, input: 1000, output: 500 } })
    mockGetInstance.mockResolvedValue(inst)

    await _routerHandlers['exited']('inst-1', 0)
    await flushAsync()

    const writtenContent = mockFsp.writeFile.mock.calls[0]?.[1] as string
    expect(writtenContent).toMatch(/^---/)
    expect(writtenContent).toContain('session: "Test Session"')
    expect(writtenContent).toContain('exitCode: 0')
    expect(writtenContent).toContain('cost: 0.1234')
    expect(writtenContent).toMatch(/duration: \d+s/)
  })

  it('includes git commits section when workingDirectory is set', async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, args: string[], _opts: object, callback: (err: null, out: string) => void) => {
        if (args.includes('log')) callback(null, 'abc123 feat: add thing\ndef456 fix: bug')
        else callback(null, ' 2 files changed')
      }
    )
    mockGetInstance.mockResolvedValue(makeInst())

    await _routerHandlers['exited']('inst-1', 0)
    await flushAsync()

    const writtenContent = mockFsp.writeFile.mock.calls[0]?.[1] as string
    expect(writtenContent).toContain('## Commits')
    expect(writtenContent).toContain('abc123 feat: add thing')
  })

  it('omits git section when no workingDirectory', async () => {
    // Clear execFile mock so we can verify it's not called for git
    mockExecFile.mockReset()
    mockGetInstance.mockResolvedValue(makeInst({ workingDirectory: undefined }))

    await _routerHandlers['exited']('inst-1', 0)
    await flushAsync()

    const writtenContent = mockFsp.writeFile.mock.calls[0]?.[1] as string
    expect(writtenContent).not.toContain('## Commits')
    // execFile only called by other parts of exited handler (Jira), not for git proof
    const gitExecCalls = mockExecFile.mock.calls.filter((c: string[]) => c[0] === 'git')
    expect(gitExecCalls).toHaveLength(0)
  })

  it('broadcasts instance:proof event with the proof file path', async () => {
    mockGetInstance.mockResolvedValue(makeInst())

    await _routerHandlers['exited']('inst-1', 0)
    await flushAsync()

    const proofBroadcasts = mockBroadcast.mock.calls.filter(
      (c: [string, unknown]) => c[0] === 'instance:proof'
    )
    expect(proofBroadcasts).toHaveLength(1)
    const payload = proofBroadcasts[0][1] as { id: string; path: string }
    expect(payload.id).toBe('inst-1')
    expect(payload.path).toMatch(/proofs\/\d{4}-\d{2}-\d{2}\/test-session-\d+\.md/)
  })

  it('includes error section for non-zero exit code', async () => {
    mockGetInstance.mockResolvedValue(makeInst())

    await _routerHandlers['exited']('inst-1', 127)
    await flushAsync()

    const writtenContent = mockFsp.writeFile.mock.calls[0]?.[1] as string
    expect(writtenContent).toContain('## Error')
    expect(writtenContent).toContain('exitCode: 127')
  })
})

// ---- pruneOldProofs tests ----

describe('pruneOldProofs (via startup setTimeout)', () => {
  beforeEach(async () => {
    vi.useFakeTimers()
    vi.resetModules()
    vi.resetAllMocks()
    mockFsp.mkdir.mockResolvedValue(undefined)
    mockFsp.writeFile.mockResolvedValue(undefined)
    mockFsp.readdir.mockResolvedValue([])
    mockFsp.stat.mockResolvedValue({ mtimeMs: Date.now() }) // recent by default
    mockFsp.unlink.mockResolvedValue(undefined)
    mockFsp.rmdir.mockResolvedValue(undefined)
    mockGetInstanceBuffer.mockResolvedValue('')
    mockGetAllInstances.mockResolvedValue([])
    for (const key of Object.keys(_routerHandlers)) delete _routerHandlers[key]
    registerMocks()

    const mod = await import('../instance-manager')
    mod.wireDaemonEvents()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('prunes day directories older than 14 days', async () => {
    const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000
    const oldMtime = cutoff - 1_000 // just past the cutoff

    // proofs dir contains one old day with one file
    mockFsp.readdir.mockImplementation((dirPath: string) => {
      if (dirPath === MOCK_PROOFS_DIR) return Promise.resolve(['2026-01-01'])
      return Promise.resolve(['proof-abc.md'])
    })
    mockFsp.stat.mockResolvedValue({ mtimeMs: oldMtime })

    await vi.advanceTimersByTimeAsync(60_001)

    expect(mockFsp.unlink).toHaveBeenCalledWith(`${MOCK_PROOFS_DIR}/2026-01-01/proof-abc.md`)
    expect(mockFsp.rmdir).toHaveBeenCalledWith(`${MOCK_PROOFS_DIR}/2026-01-01`)
  })

  it('does not prune day directories newer than 14 days', async () => {
    const recentMtime = Date.now() - 1_000 // 1 second ago — well within 14 days

    mockFsp.readdir.mockImplementation((dirPath: string) => {
      if (dirPath === MOCK_PROOFS_DIR) return Promise.resolve(['2026-05-03'])
      return Promise.resolve(['proof-xyz.md'])
    })
    mockFsp.stat.mockResolvedValue({ mtimeMs: recentMtime })

    await vi.advanceTimersByTimeAsync(60_001)

    expect(mockFsp.unlink).not.toHaveBeenCalled()
    expect(mockFsp.rmdir).not.toHaveBeenCalled()
  })

  it('handles readdir error on proofs dir without crashing', async () => {
    mockFsp.readdir.mockRejectedValue(new Error('ENOENT'))

    await expect(vi.advanceTimersByTimeAsync(60_001)).resolves.not.toThrow()

    expect(mockFsp.unlink).not.toHaveBeenCalled()
  })
})
