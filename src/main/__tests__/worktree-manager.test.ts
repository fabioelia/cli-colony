/**
 * Tests for worktree-manager.ts — standalone worktree lifecycle management.
 *
 * Mocks: electron, fs, colony-paths, git-worktree, settings, broadcast, utils.
 * Tests the full CRUD + mount/unmount lifecycle through the public API.
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

import {
  createWorktree,
  listWorktrees,
  getWorktree,
  mountWorktree,
  unmountWorktree,
  removeWorktree as removeWt,
  getWorktreesForEnv,
  unmountAllForEnv,
} from '../worktree-manager'

beforeEach(() => {
  vi.clearAllMocks()
  mockGenId.mockReturnValue('test-id-001')
})

describe('createWorktree', () => {
  it('creates worktree directory, bare repo, git worktree, writes manifest, and broadcasts', async () => {
    const result = await createWorktree('owner', 'repo', 'develop', 'backend')

    expect(mockMkdir).toHaveBeenCalledWith('/mock/colony/worktrees/test-id-001', { recursive: true })
    expect(mockGitRemoteUrl).toHaveBeenCalledWith('owner', 'repo')
    expect(mockEnsureBareRepo).toHaveBeenCalledWith('owner', 'repo', 'git@github.com:owner/repo.git')
    expect(mockAddWorktree).toHaveBeenCalledWith(
      '/mock/bare/owner/repo.git',
      '/mock/colony/worktrees/test-id-001/repo',
      'develop',
      'wt-test-id-001',
    )

    // Verify manifest write
    expect(mockWriteFile).toHaveBeenCalledWith(
      '/mock/colony/worktrees/test-id-001/worktree.json',
      expect.any(String),
      'utf-8',
    )
    const manifest = JSON.parse(mockWriteFile.mock.calls[0][1])
    expect(manifest.id).toBe('test-id-001')
    expect(manifest.repo).toEqual({ owner: 'owner', name: 'repo' })
    expect(manifest.branch).toBe('develop')
    expect(manifest.path).toBe('/mock/colony/worktrees/test-id-001/repo')
    expect(manifest.mountedEnvId).toBeNull()
    expect(manifest.repoAlias).toBe('backend')

    // Verify broadcast
    expect(mockBroadcast).toHaveBeenCalledWith('worktree:changed', null)

    // Verify return value
    expect(result.id).toBe('test-id-001')
    expect(result.repo).toEqual({ owner: 'owner', name: 'repo' })
  })

  it('uses explicit remoteUrl when provided instead of resolving from settings', async () => {
    await createWorktree('owner', 'repo', 'main', 'frontend', 'https://custom.example.com/repo.git')

    expect(mockGitRemoteUrl).not.toHaveBeenCalled()
    expect(mockEnsureBareRepo).toHaveBeenCalledWith('owner', 'repo', 'https://custom.example.com/repo.git')
  })

  it('generates unique IDs for each worktree', async () => {
    mockGenId.mockReturnValueOnce('id-aaa').mockReturnValueOnce('id-bbb')

    const wt1 = await createWorktree('owner', 'repo', 'develop', 'backend')
    const wt2 = await createWorktree('owner', 'repo', 'feature', 'backend')

    expect(wt1.id).toBe('id-aaa')
    expect(wt2.id).toBe('id-bbb')
  })
})

describe('listWorktrees', () => {
  it('returns empty array when worktrees dir does not exist', async () => {
    mockAccess.mockRejectedValueOnce(new Error('ENOENT'))
    const result = await listWorktrees()
    expect(result).toEqual([])
  })

  it('lists all worktrees with valid manifests', async () => {
    mockReaddir.mockResolvedValueOnce(['wt-1', 'wt-2', 'invalid'])
    const manifest1 = { id: 'wt-1', repo: { owner: 'o', name: 'r' }, branch: 'main' }
    const manifest2 = { id: 'wt-2', repo: { owner: 'o', name: 'r2' }, branch: 'dev' }

    mockReadFile
      .mockResolvedValueOnce(JSON.stringify(manifest1))
      .mockResolvedValueOnce(JSON.stringify(manifest2))
      .mockRejectedValueOnce(new Error('ENOENT'))  // invalid entry

    const result = await listWorktrees()
    expect(result).toHaveLength(2)
    expect(result[0].id).toBe('wt-1')
    expect(result[1].id).toBe('wt-2')
  })

  it('skips entries with invalid JSON manifests', async () => {
    mockReaddir.mockResolvedValueOnce(['good', 'bad'])
    mockReadFile
      .mockResolvedValueOnce(JSON.stringify({ id: 'good' }))
      .mockRejectedValueOnce(new Error('parse error'))

    const result = await listWorktrees()
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('good')
  })
})

describe('getWorktree', () => {
  it('returns worktree info when manifest exists', async () => {
    const manifest = { id: 'wt-x', repo: { owner: 'o', name: 'n' }, branch: 'develop' }
    mockReadFile.mockResolvedValueOnce(JSON.stringify(manifest))

    const result = await getWorktree('wt-x')
    expect(result).toEqual(manifest)
    expect(mockReadFile).toHaveBeenCalledWith(
      '/mock/colony/worktrees/wt-x/worktree.json',
      'utf-8',
    )
  })

  it('returns null when worktree does not exist', async () => {
    mockReadFile.mockRejectedValueOnce(new Error('ENOENT'))
    const result = await getWorktree('nonexistent')
    expect(result).toBeNull()
  })
})

describe('mountWorktree', () => {
  it('mounts a worktree to an environment and broadcasts', async () => {
    const manifest = {
      id: 'wt-1', repo: { owner: 'o', name: 'r' }, branch: 'develop',
      path: '/mock/path', bareRepoPath: '/mock/bare', mountedEnvId: null,
      repoAlias: 'backend', createdAt: '2026-01-01',
    }
    mockReadFile.mockResolvedValueOnce(JSON.stringify(manifest))

    const result = await mountWorktree('wt-1', 'env-abc')

    expect(result.mountedEnvId).toBe('env-abc')
    expect(mockWriteFile).toHaveBeenCalledWith(
      '/mock/colony/worktrees/wt-1/worktree.json',
      expect.stringContaining('"mountedEnvId": "env-abc"'),
      'utf-8',
    )
    expect(mockBroadcast).toHaveBeenCalledWith('worktree:changed', null)
  })

  it('throws when worktree does not exist', async () => {
    mockReadFile.mockRejectedValueOnce(new Error('ENOENT'))
    await expect(mountWorktree('missing', 'env-1')).rejects.toThrow('Worktree missing not found')
  })

  it('throws when worktree is mounted to a different environment', async () => {
    const manifest = {
      id: 'wt-1', mountedEnvId: 'env-other',
      repo: { owner: 'o', name: 'r' }, branch: 'dev', path: '/p', bareRepoPath: '/b',
      repoAlias: 'be', createdAt: '2026-01-01',
    }
    mockReadFile.mockResolvedValueOnce(JSON.stringify(manifest))
    await expect(mountWorktree('wt-1', 'env-new')).rejects.toThrow(
      'already mounted to environment env-other',
    )
  })

  it('allows re-mounting to the same environment (idempotent)', async () => {
    const manifest = {
      id: 'wt-1', mountedEnvId: 'env-same',
      repo: { owner: 'o', name: 'r' }, branch: 'dev', path: '/p', bareRepoPath: '/b',
      repoAlias: 'be', createdAt: '2026-01-01',
    }
    mockReadFile.mockResolvedValueOnce(JSON.stringify(manifest))

    const result = await mountWorktree('wt-1', 'env-same')
    expect(result.mountedEnvId).toBe('env-same')
  })
})

describe('unmountWorktree', () => {
  it('clears mountedEnvId and broadcasts', async () => {
    const manifest = {
      id: 'wt-1', mountedEnvId: 'env-abc',
      repo: { owner: 'o', name: 'r' }, branch: 'dev', path: '/p', bareRepoPath: '/b',
      repoAlias: 'be', createdAt: '2026-01-01',
    }
    mockReadFile.mockResolvedValueOnce(JSON.stringify(manifest))

    const result = await unmountWorktree('wt-1')
    expect(result.mountedEnvId).toBeNull()
    expect(mockWriteFile).toHaveBeenCalledWith(
      '/mock/colony/worktrees/wt-1/worktree.json',
      expect.stringContaining('"mountedEnvId": null'),
      'utf-8',
    )
    expect(mockBroadcast).toHaveBeenCalledWith('worktree:changed', null)
  })

  it('throws when worktree does not exist', async () => {
    mockReadFile.mockRejectedValueOnce(new Error('ENOENT'))
    await expect(unmountWorktree('missing')).rejects.toThrow('Worktree missing not found')
  })
})

describe('removeWorktree', () => {
  it('removes git worktree, deletes directory, and broadcasts', async () => {
    const manifest = {
      id: 'wt-1', mountedEnvId: null,
      repo: { owner: 'o', name: 'r' }, branch: 'dev',
      path: '/mock/colony/worktrees/wt-1/r', bareRepoPath: '/mock/bare/o/r.git',
      repoAlias: 'be', createdAt: '2026-01-01',
    }
    mockReadFile.mockResolvedValueOnce(JSON.stringify(manifest))

    await removeWt('wt-1')

    expect(mockRemoveWorktree).toHaveBeenCalledWith(
      '/mock/bare/o/r.git',
      '/mock/colony/worktrees/wt-1/r',
      'wt-wt-1',
    )
    expect(mockRm).toHaveBeenCalledWith(
      '/mock/colony/worktrees/wt-1',
      { recursive: true, force: true },
    )
    expect(mockBroadcast).toHaveBeenCalledWith('worktree:changed', null)
  })

  it('throws when worktree does not exist', async () => {
    mockReadFile.mockRejectedValueOnce(new Error('ENOENT'))
    await expect(removeWt('missing')).rejects.toThrow('Worktree missing not found')
  })

  it('throws when worktree is still mounted', async () => {
    const manifest = {
      id: 'wt-1', mountedEnvId: 'env-active',
      repo: { owner: 'o', name: 'r' }, branch: 'dev', path: '/p', bareRepoPath: '/b',
      repoAlias: 'be', createdAt: '2026-01-01',
    }
    mockReadFile.mockResolvedValueOnce(JSON.stringify(manifest))
    await expect(removeWt('wt-1')).rejects.toThrow('mounted to environment env-active')
  })

  it('continues cleanup even if git worktree removal fails', async () => {
    const manifest = {
      id: 'wt-1', mountedEnvId: null,
      repo: { owner: 'o', name: 'r' }, branch: 'dev',
      path: '/mock/colony/worktrees/wt-1/r', bareRepoPath: '/mock/bare/o/r.git',
      repoAlias: 'be', createdAt: '2026-01-01',
    }
    mockReadFile.mockResolvedValueOnce(JSON.stringify(manifest))
    mockRemoveWorktree.mockRejectedValueOnce(new Error('git error'))

    await removeWt('wt-1')

    // Should still delete directory and broadcast despite git error
    expect(mockRm).toHaveBeenCalled()
    expect(mockBroadcast).toHaveBeenCalledWith('worktree:changed', null)
  })
})

describe('getWorktreesForEnv', () => {
  it('returns only worktrees mounted to the specified env', async () => {
    const wt1 = { id: 'wt-1', mountedEnvId: 'env-abc' }
    const wt2 = { id: 'wt-2', mountedEnvId: 'env-xyz' }
    const wt3 = { id: 'wt-3', mountedEnvId: 'env-abc' }

    mockReaddir.mockResolvedValueOnce(['wt-1', 'wt-2', 'wt-3'])
    mockReadFile
      .mockResolvedValueOnce(JSON.stringify(wt1))
      .mockResolvedValueOnce(JSON.stringify(wt2))
      .mockResolvedValueOnce(JSON.stringify(wt3))

    const result = await getWorktreesForEnv('env-abc')
    expect(result).toHaveLength(2)
    expect(result.map(w => w.id)).toEqual(['wt-1', 'wt-3'])
  })

  it('returns empty array when no worktrees are mounted to the env', async () => {
    mockReaddir.mockResolvedValueOnce(['wt-1'])
    mockReadFile.mockResolvedValueOnce(JSON.stringify({ id: 'wt-1', mountedEnvId: 'other' }))

    const result = await getWorktreesForEnv('env-empty')
    expect(result).toEqual([])
  })
})

describe('unmountAllForEnv', () => {
  it('unmounts all worktrees from an environment and broadcasts once', async () => {
    const wt1 = {
      id: 'wt-1', mountedEnvId: 'env-abc',
      repo: { owner: 'o', name: 'r' }, branch: 'dev', path: '/p1', bareRepoPath: '/b',
      repoAlias: 'be', createdAt: '2026-01-01',
    }
    const wt2 = {
      id: 'wt-2', mountedEnvId: 'env-abc',
      repo: { owner: 'o', name: 'r2' }, branch: 'dev', path: '/p2', bareRepoPath: '/b2',
      repoAlias: 'fe', createdAt: '2026-01-01',
    }
    const wt3 = { id: 'wt-3', mountedEnvId: 'other-env' }

    mockReaddir.mockResolvedValueOnce(['wt-1', 'wt-2', 'wt-3'])
    mockReadFile
      .mockResolvedValueOnce(JSON.stringify(wt1))
      .mockResolvedValueOnce(JSON.stringify(wt2))
      .mockResolvedValueOnce(JSON.stringify(wt3))

    await unmountAllForEnv('env-abc')

    // Should write 2 manifests (wt-1 and wt-2) with mountedEnvId: null
    expect(mockWriteFile).toHaveBeenCalledTimes(2)
    const written1 = JSON.parse(mockWriteFile.mock.calls[0][1])
    const written2 = JSON.parse(mockWriteFile.mock.calls[1][1])
    expect(written1.mountedEnvId).toBeNull()
    expect(written2.mountedEnvId).toBeNull()

    // Single broadcast
    expect(mockBroadcast).toHaveBeenCalledTimes(1)
    expect(mockBroadcast).toHaveBeenCalledWith('worktree:changed', null)
  })

  it('does not broadcast when no worktrees were mounted to the env', async () => {
    mockReaddir.mockResolvedValueOnce([])

    await unmountAllForEnv('env-empty')
    expect(mockBroadcast).not.toHaveBeenCalled()
    expect(mockWriteFile).not.toHaveBeenCalled()
  })
})
