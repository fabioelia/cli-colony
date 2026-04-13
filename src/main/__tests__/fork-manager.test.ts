import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ForkGroup } from '../../shared/types'

// Hoist mocks so they're available in factory functions
const mockExistsSync = vi.hoisted(() => vi.fn())
const mockReadFileSync = vi.hoisted(() => vi.fn())
const mockWriteFileSync = vi.hoisted(() => vi.fn())
const mockMkdirSync = vi.hoisted(() => vi.fn())
const mockUnlinkSync = vi.hoisted(() => vi.fn())
const mockBroadcast = vi.hoisted(() => vi.fn())
const mockGetInstance = vi.hoisted(() => vi.fn())
const mockWriteToInstance = vi.hoisted(() => vi.fn())
const mockGetGitRoot = vi.hoisted(() => vi.fn())
const mockAddWorktree = vi.hoisted(() => vi.fn())
const mockRemoveWorktree = vi.hoisted(() => vi.fn())
const mockCreateInstance = vi.hoisted(() => vi.fn())
const mockSendPromptWhenReady = vi.hoisted(() => vi.fn())

vi.mock('fs', () => ({
  existsSync: mockExistsSync,
  readFileSync: mockReadFileSync,
  writeFileSync: mockWriteFileSync,
  mkdirSync: mockMkdirSync,
  unlinkSync: mockUnlinkSync,
}))

vi.mock('electron', () => ({
  app: { getPath: vi.fn().mockReturnValue('/mock/home') },
}))

vi.mock('../../shared/colony-paths', () => ({
  colonyPaths: {
    forkGroups: '/mock/home/.claude-colony/fork-groups.json',
    forks: '/mock/home/.claude-colony/forks',
  },
}))

vi.mock('../broadcast', () => ({ broadcast: mockBroadcast }))

vi.mock('../daemon-router', () => ({
  getDaemonRouter: () => ({
    getInstance: mockGetInstance,
    writeToInstance: mockWriteToInstance,
  }),
}))

vi.mock('../git-worktree', () => ({
  getGitRoot: mockGetGitRoot,
  addWorktree: mockAddWorktree,
  removeWorktree: mockRemoveWorktree,
}))

vi.mock('../instance-manager', () => ({ createInstance: mockCreateInstance }))
vi.mock('../send-prompt-when-ready', () => ({ sendPromptWhenReady: mockSendPromptWhenReady }))

// Import after mocks are set up
const { getForkGroups, createForkGroup, pickWinner, discardFork, cleanupStaleForkGroups } =
  await import('../fork-manager')

// ---- helpers ----

function makeGroup(overrides: Partial<ForkGroup> = {}): ForkGroup {
  return {
    id: 'fork-123-abc',
    parentId: 'parent-1',
    parentName: 'Parent Session',
    label: 'Test forks',
    created: '2026-04-06T00:00:00.000Z',
    status: 'active',
    forks: [
      {
        id: 'f1',
        sessionId: 'sess-1',
        sessionName: 'Fork: A',
        branch: 'colony-fork-123-f1',
        worktreePath: '/mock/home/.claude-colony/forks/fork-123-abc/f1',
        contextFilePath: '/mock/home/.claude-colony/fork-context-fork-123-abc-f1.md',
        label: 'Approach A',
        directive: 'Do it this way',
        status: 'running',
      },
      {
        id: 'f2',
        sessionId: 'sess-2',
        sessionName: 'Fork: B',
        branch: 'colony-fork-123-f2',
        worktreePath: '/mock/home/.claude-colony/forks/fork-123-abc/f2',
        contextFilePath: '/mock/home/.claude-colony/fork-context-fork-123-abc-f2.md',
        label: 'Approach B',
        directive: 'Do it that way',
        status: 'running',
      },
    ],
    ...overrides,
  }
}

function mockGroupsFile(groups: ForkGroup[]): void {
  mockExistsSync.mockReturnValue(true)
  mockReadFileSync.mockReturnValue(JSON.stringify(groups))
}

// ---- tests ----

beforeEach(() => {
  vi.clearAllMocks()
  mockSendPromptWhenReady.mockReturnValue(Promise.resolve())
  mockWriteToInstance.mockResolvedValue(undefined)
  mockAddWorktree.mockResolvedValue(undefined)
  mockRemoveWorktree.mockResolvedValue(undefined)
})

describe('getForkGroups', () => {
  it('returns [] when file does not exist', () => {
    mockExistsSync.mockReturnValue(false)
    expect(getForkGroups()).toEqual([])
  })

  it('returns [] when file contains malformed JSON', () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue('not-json{{{')
    expect(getForkGroups()).toEqual([])
  })

  it('returns [] when parsed value is not an array', () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(JSON.stringify({ id: 'foo' }))
    expect(getForkGroups()).toEqual([])
  })

  it('returns parsed array when file is valid', () => {
    const groups = [makeGroup()]
    mockGroupsFile(groups)
    expect(getForkGroups()).toEqual(groups)
  })
})

describe('createForkGroup — input validation', () => {
  it('throws when forks array is empty', async () => {
    await expect(
      createForkGroup('parent-1', { label: 'test', taskSummary: '', forks: [] })
    ).rejects.toThrow('At least 1 fork is required')
  })

  it('throws when more than 3 forks are requested', async () => {
    const forks = Array.from({ length: 4 }, (_, i) => ({
      label: `Fork ${i}`,
      directive: `Directive ${i}`,
    }))
    await expect(
      createForkGroup('parent-1', { label: 'test', taskSummary: '', forks })
    ).rejects.toThrow('Maximum 3 forks allowed per group')
  })

  it('throws when parent session is not found', async () => {
    mockGetInstance.mockResolvedValue(null)
    await expect(
      createForkGroup('missing-parent', {
        label: 'test',
        taskSummary: '',
        forks: [{ label: 'A', directive: 'do A' }],
      })
    ).rejects.toThrow('Parent session missing-parent not found')
  })

  it('throws when parent directory is not a git repo', async () => {
    mockGetInstance.mockResolvedValue({ name: 'Parent', workingDirectory: '/not/a/repo' })
    mockGetGitRoot.mockRejectedValue(new Error('not a git repo'))
    await expect(
      createForkGroup('parent-1', {
        label: 'test',
        taskSummary: '',
        forks: [{ label: 'A', directive: 'do A' }],
      })
    ).rejects.toThrow('not a git repository')
  })
})

describe('createForkGroup — success path', () => {
  beforeEach(() => {
    mockGetInstance.mockResolvedValue({
      name: 'Parent Session',
      workingDirectory: '/my/project',
    })
    mockGetGitRoot.mockResolvedValue('/my/project')
    mockCreateInstance.mockImplementation(async (opts: { name: string }) => ({
      id: `sess-new`,
      name: opts.name,
    }))
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(JSON.stringify([]))
  })

  it('creates a group with correct structure and persists it', async () => {
    const result = await createForkGroup('parent-1', {
      label: 'Explore approaches',
      taskSummary: 'Sort algorithm task',
      forks: [
        { label: 'QuickSort', directive: 'Use quicksort' },
        { label: 'MergeSort', directive: 'Use mergesort' },
      ],
    })

    expect(result.label).toBe('Explore approaches')
    expect(result.parentId).toBe('parent-1')
    expect(result.status).toBe('active')
    expect(result.forks).toHaveLength(2)
    expect(result.forks[0].label).toBe('QuickSort')
    expect(result.forks[1].label).toBe('MergeSort')
    expect(result.forks[0].status).toBe('running')
    expect(result.forks[0].branch).toMatch(/^colony-fork-/)

    expect(mockWriteFileSync).toHaveBeenCalled()
    expect(mockBroadcast).toHaveBeenCalledWith('fork:groups', expect.any(Array))
  })

  it('writes a context file for each fork', async () => {
    await createForkGroup('parent-1', {
      label: 'test',
      taskSummary: 'Do X',
      forks: [{ label: 'Alpha', directive: 'Try Alpha' }],
    })

    // One context file write + one groups JSON write
    const contextWrites = mockWriteFileSync.mock.calls.filter(([p]) =>
      String(p).includes('fork-context-')
    )
    expect(contextWrites).toHaveLength(1)
    expect(contextWrites[0][1]).toContain('Try Alpha')
  })
})

describe('pickWinner', () => {
  it('throws when group is not found', async () => {
    mockGroupsFile([])
    await expect(pickWinner('nonexistent', 'f1')).rejects.toThrow(
      'Fork group nonexistent not found'
    )
  })

  it('throws when winner fork id is not found', async () => {
    mockGroupsFile([makeGroup()])
    await expect(pickWinner('fork-123-abc', 'f99')).rejects.toThrow(
      'Fork f99 not found in group fork-123-abc'
    )
  })

  it('marks winner as winner and losers as discarded, group as resolved', async () => {
    // existsSync: true for groups file read, false for context file cleanup
    mockExistsSync.mockReturnValueOnce(true).mockReturnValue(false)
    mockReadFileSync.mockReturnValue(JSON.stringify([makeGroup()]))
    mockGetGitRoot.mockResolvedValue('/my/project')

    await pickWinner('fork-123-abc', 'f1')

    const [, writtenJson] = mockWriteFileSync.mock.calls[0]
    const written: ForkGroup[] = JSON.parse(writtenJson as string)
    const group = written[0]

    expect(group.status).toBe('resolved')
    const winner = group.forks.find((f) => f.id === 'f1')
    const loser = group.forks.find((f) => f.id === 'f2')
    expect(winner?.status).toBe('winner')
    expect(loser?.status).toBe('discarded')
  })

  it('removes losing worktrees', async () => {
    mockExistsSync.mockReturnValueOnce(true).mockReturnValue(false)
    mockReadFileSync.mockReturnValue(JSON.stringify([makeGroup()]))
    mockGetGitRoot.mockResolvedValue('/my/project')

    await pickWinner('fork-123-abc', 'f1')

    expect(mockRemoveWorktree).toHaveBeenCalledTimes(1)
    expect(mockRemoveWorktree).toHaveBeenCalledWith(
      '/my/project',
      '/mock/home/.claude-colony/forks/fork-123-abc/f2'
    )
  })
})

describe('discardFork', () => {
  it('throws when group is not found', async () => {
    mockGroupsFile([])
    await expect(discardFork('nope', 'f1')).rejects.toThrow('Fork group nope not found')
  })

  it('throws when fork id is not found', async () => {
    mockGroupsFile([makeGroup()])
    await expect(discardFork('fork-123-abc', 'f99')).rejects.toThrow(
      'Fork f99 not found in group fork-123-abc'
    )
  })

  it('marks discarded fork as discarded', async () => {
    mockExistsSync.mockReturnValueOnce(true).mockReturnValue(false)
    mockReadFileSync.mockReturnValue(JSON.stringify([makeGroup()]))
    mockGetGitRoot.mockResolvedValue('/my/project')

    await discardFork('fork-123-abc', 'f1')

    const [, writtenJson] = mockWriteFileSync.mock.calls[0]
    const written: ForkGroup[] = JSON.parse(writtenJson as string)
    const fork = written[0].forks.find((f) => f.id === 'f1')
    expect(fork?.status).toBe('discarded')
  })

  it('auto-closes group when all forks are in terminal state', async () => {
    const group = makeGroup()
    group.forks[0].status = 'winner'
    // f2 will be discarded in this test
    mockExistsSync.mockReturnValueOnce(true).mockReturnValue(false)
    mockReadFileSync.mockReturnValue(JSON.stringify([group]))
    mockGetGitRoot.mockResolvedValue('/my/project')

    await discardFork('fork-123-abc', 'f2')

    const [, writtenJson] = mockWriteFileSync.mock.calls[0]
    const written: ForkGroup[] = JSON.parse(writtenJson as string)
    expect(written[0].status).toBe('resolved')
  })

  it('does not auto-close group when other forks are still running', async () => {
    mockExistsSync.mockReturnValueOnce(true).mockReturnValue(false)
    mockReadFileSync.mockReturnValue(JSON.stringify([makeGroup()])) // both forks 'running'
    mockGetGitRoot.mockResolvedValue('/my/project')

    await discardFork('fork-123-abc', 'f1')

    const [, writtenJson] = mockWriteFileSync.mock.calls[0]
    const written: ForkGroup[] = JSON.parse(writtenJson as string)
    expect(written[0].status).toBe('active')
  })
})

describe('cleanupStaleForkGroups', () => {
  it('keeps active groups with running forks', () => {
    mockGroupsFile([makeGroup()])

    cleanupStaleForkGroups()

    // writeGroups should NOT be called (nothing to remove)
    expect(mockWriteFileSync).not.toHaveBeenCalled()
    expect(mockBroadcast).toHaveBeenCalledWith('fork:groups', expect.any(Array))
  })

  it('removes resolved groups where all forks are in terminal state', () => {
    const resolved = makeGroup({
      status: 'resolved',
      forks: [
        { ...makeGroup().forks[0], status: 'winner' },
        { ...makeGroup().forks[1], status: 'discarded' },
      ],
    })
    mockGroupsFile([resolved])

    cleanupStaleForkGroups()

    expect(mockWriteFileSync).toHaveBeenCalled()
    const [, writtenJson] = mockWriteFileSync.mock.calls[0]
    const written: ForkGroup[] = JSON.parse(writtenJson as string)
    expect(written).toHaveLength(0)
  })

  it('keeps active groups and removes only resolved all-terminal ones', () => {
    const active = makeGroup()
    const resolved = makeGroup({
      id: 'fork-999-xyz',
      status: 'resolved',
      forks: [
        { ...makeGroup().forks[0], status: 'winner' },
        { ...makeGroup().forks[1], status: 'discarded' },
      ],
    })
    mockGroupsFile([active, resolved])

    cleanupStaleForkGroups()

    expect(mockWriteFileSync).toHaveBeenCalled()
    const [, writtenJson] = mockWriteFileSync.mock.calls[0]
    const written: ForkGroup[] = JSON.parse(writtenJson as string)
    expect(written).toHaveLength(1)
    expect(written[0].id).toBe('fork-123-abc')
  })
})
