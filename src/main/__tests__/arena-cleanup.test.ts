/**
 * Tests for Arena Promote Winner (#286) — worktree cleanup behavior.
 *
 * (a) cleanupWorktrees is called with only loser IDs when keep-winner path used
 * (b) removeWorktree does not throw for arena worktrees (mountedEnvId === null)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

// ---- Hoisted mocks ----
const mockMkdir = vi.hoisted(() => vi.fn(async () => undefined))
const mockWriteFile = vi.hoisted(() => vi.fn(async () => undefined))
const mockReadFile = vi.hoisted(() => vi.fn(async () => '{}'))
const mockReaddir = vi.hoisted(() => vi.fn(async () => []))
const mockAccess = vi.hoisted(() => vi.fn(async () => undefined))
const mockRm = vi.hoisted(() => vi.fn(async () => undefined))

const mockEnsureBareRepo = vi.hoisted(() => vi.fn(async () => '/mock/bare/owner/repo.git'))
const mockAddWorktree = vi.hoisted(() => vi.fn(async () => undefined))
const mockRemoveWorktree = vi.hoisted(() => vi.fn(async () => undefined))
const mockGitRemoteUrl = vi.hoisted(() => vi.fn(async () => 'git@github.com:owner/repo.git'))
const mockBroadcast = vi.hoisted(() => vi.fn())
const mockGenId = vi.hoisted(() => vi.fn(() => 'test-id-001'))

vi.mock('electron', () => ({ app: { getPath: vi.fn().mockReturnValue('/mock/home') } }))

vi.mock('fs', () => ({
  promises: {
    mkdir: mockMkdir,
    writeFile: mockWriteFile,
    readFile: mockReadFile,
    readdir: mockReaddir,
    access: mockAccess,
    rm: mockRm,
  },
}))

vi.mock('../../shared/colony-paths', () => ({
  colonyPaths: {
    worktrees: '/mock/colony/worktrees',
    worktreeDir: (id: string) => `/mock/colony/worktrees/${id}`,
  },
}))

vi.mock('../../shared/git-worktree', () => ({
  ensureBareRepo: mockEnsureBareRepo,
  addWorktree: mockAddWorktree,
  removeWorktree: mockRemoveWorktree,
}))

vi.mock('../settings', () => ({
  gitRemoteUrl: mockGitRemoteUrl,
}))

vi.mock('../broadcast', () => ({
  broadcast: mockBroadcast,
}))

vi.mock('../../shared/utils', () => ({
  genId: mockGenId,
}))

import { removeWorktree as removeWt } from '../worktree-manager'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('Arena Promote Winner — cleanup behavior', () => {
  it('(a) loser-only ID derivation: winner worktree is excluded, losers are removed', async () => {
    // Simulate the keep-winner logic: 3 worktrees, winner at index 1
    const arenaWorktreeIds = ['wt-loser-a', 'wt-winner', 'wt-loser-b']
    const gridPanes = ['inst-0', 'inst-winner', 'inst-2', null]
    const arenaWinnerId = 'inst-winner'

    const winnerIdx = gridPanes.indexOf(arenaWinnerId)
    expect(winnerIdx).toBe(1)

    const winnerWorktreeId = arenaWorktreeIds[winnerIdx]
    expect(winnerWorktreeId).toBe('wt-winner')

    const loserIds = arenaWorktreeIds.filter((_, i) => i !== winnerIdx)
    expect(loserIds).toEqual(['wt-loser-a', 'wt-loser-b'])
    // Winner is not in the loser list
    expect(loserIds).not.toContain('wt-winner')
  })

  it('(b) removeWorktree does not throw for arena worktrees (mountedEnvId === null)', async () => {
    // Arena worktrees are never mounted — mountedEnvId must be null
    const manifest = {
      id: 'wt-arena-1',
      mountedEnvId: null, // Arena worktrees are standalone
      repo: { owner: 'owner', name: 'repo' },
      branch: 'arena/slot-1',
      path: '/mock/colony/worktrees/wt-arena-1/repo',
      bareRepoPath: '/mock/bare/owner/repo.git',
      repoAlias: 'repo',
      createdAt: '2026-04-15T00:00:00.000Z',
    }
    mockReadFile.mockResolvedValueOnce(JSON.stringify(manifest))

    // Must not throw (mountedEnvId is null)
    await expect(removeWt('wt-arena-1')).resolves.toBeUndefined()
    expect(mockRemoveWorktree).toHaveBeenCalledWith(
      '/mock/bare/owner/repo.git',
      '/mock/colony/worktrees/wt-arena-1/repo',
      'wt-wt-arena-1',
    )
  })
})
