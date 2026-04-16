/**
 * Tests for getWorktreeSize — disk usage via `du -sk` + JS-walk fallback.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

// ---- Hoisted mocks ----

const mockExecFile = vi.hoisted(() => {
  const fn = vi.fn()
  fn[Symbol.for('nodejs.util.promisify.custom')] = vi.fn(
    async (...args: any[]) =>
      new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        fn(...args, (err: any, stdout: string, stderr: string) => {
          if (err) reject(err)
          else resolve({ stdout, stderr })
        })
      }),
  )
  return fn
})

const mockReadFile = vi.hoisted(() => vi.fn(async () => '{}'))
const mockReaddir = vi.hoisted(() => vi.fn(async () => [] as any[]))
const mockStat = vi.hoisted(() => vi.fn(async () => ({ size: 0, isDirectory: () => false, isSymbolicLink: () => false })))
const mockAccess = vi.hoisted(() => vi.fn(async () => undefined))

vi.mock('electron', () => ({ app: { getPath: vi.fn().mockReturnValue('/mock/home') } }))

vi.mock('fs', () => ({
  promises: {
    mkdir: vi.fn(async () => undefined),
    writeFile: vi.fn(async () => undefined),
    readFile: mockReadFile,
    readdir: mockReaddir,
    access: mockAccess,
    rm: vi.fn(async () => undefined),
    stat: mockStat,
  },
}))

vi.mock('child_process', () => ({ execFile: mockExecFile }))

vi.mock('../resolve-command', () => ({ resolveCommand: vi.fn(() => '/usr/bin/git') }))

vi.mock('../../shared/shell-env', () => ({ loadShellEnv: vi.fn(() => ({ PATH: '/usr/bin' })) }))

vi.mock('../../shared/colony-paths', () => ({
  colonyPaths: {
    worktrees: '/mock/colony/worktrees',
    worktreeDir: (id: string) => `/mock/colony/worktrees/${id}`,
  },
}))

vi.mock('../../shared/git-worktree', () => ({
  ensureBareRepo: vi.fn(async () => '/mock/bare'),
  addWorktree: vi.fn(async () => undefined),
  removeWorktree: vi.fn(async () => undefined),
}))

vi.mock('../settings', () => ({ gitRemoteUrl: vi.fn(async () => 'git@github.com:owner/repo.git') }))

vi.mock('../broadcast', () => ({ broadcast: vi.fn() }))

vi.mock('../../shared/utils', () => ({ genId: vi.fn(() => 'test-id') }))

import { getWorktreeSize } from '../worktree-manager'

// ---- Helpers ----

function makeWorktreeJson(repos: Array<{ path: string }> = [{ path: '/mock/repo' }]) {
  return JSON.stringify({
    id: 'wt-01',
    displayName: 'develop (wt-01)',
    branch: 'develop',
    createdAt: new Date().toISOString(),
    mountedEnvId: null,
    repos: repos.map(r => ({ owner: 'org', name: 'repo', alias: 'backend', path: r.path, bareRepoPath: '/mock/bare' })),
    repo: { owner: 'org', name: 'repo' },
    path: repos[0]?.path ?? '/mock/repo',
    bareRepoPath: '/mock/bare',
    repoAlias: 'backend',
  })
}

function queueDuResponse(stdout: string): void {
  mockExecFile.mockImplementationOnce((_cmd: string, _args: string[], _opts: any, cb: (err: any, stdout: string, stderr: string) => void) => {
    cb(null, stdout, '')
  })
}

function queueDuError(): void {
  const err = new Error('du: command not found')
  mockExecFile.mockImplementationOnce((_cmd: string, _args: string[], _opts: any, cb: (err: any, stdout: string, stderr: string) => void) => {
    cb(err, '', err.message)
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockAccess.mockResolvedValue(undefined)
  // Default: du fails immediately so JS walk fallback is exercised unless overridden
  mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: (err: any, stdout: string, stderr: string) => void) => {
    cb(new Error('du: not queued'), '', '')
  })
})

// ---- Tests ----

describe('getWorktreeSize', () => {
  it('sums KB × 1024 across multiple repos', async () => {
    mockReadFile.mockResolvedValue(makeWorktreeJson([
      { path: '/mock/repo1' },
      { path: '/mock/repo2' },
    ]))
    // du -sk returns "100\t/mock/repo1" and "250\t/mock/repo2"
    queueDuResponse('100\t/mock/repo1\n')
    queueDuResponse('250\t/mock/repo2\n')

    const result = await getWorktreeSize('wt-01')

    expect(result.bytes).toBe((100 + 250) * 1024)
    expect(result.computedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('returns zero bytes for a worktree with no repos (migration backfills empty path)', async () => {
    // repos: [] triggers migrateWorktreeInfo to backfill one entry with path: '/mock/empty'
    // du fails (default mockExecFile), JS walk on the path returns [] entries → 0 bytes
    mockReadFile.mockResolvedValue(makeWorktreeJson([{ path: '/mock/empty' }]))
    // du fails → jsWalkSize called; readdir returns no entries
    mockReaddir.mockResolvedValueOnce([])

    const result = await getWorktreeSize('wt-01')
    expect(result.bytes).toBe(0)
  })

  it('returns zero bytes when worktree id is unknown', async () => {
    mockReadFile.mockRejectedValue(new Error('ENOENT'))

    const result = await getWorktreeSize('unknown-id')
    expect(result.bytes).toBe(0)
  })

  it('falls back to JS walk when du fails', async () => {
    mockReadFile.mockResolvedValue(makeWorktreeJson([{ path: '/mock/repo' }]))
    queueDuError()

    // JS walk: one file of 4096 bytes
    mockReaddir.mockResolvedValueOnce([
      { name: 'file.ts', isDirectory: () => false, isSymbolicLink: () => false },
    ] as any)
    mockStat.mockResolvedValueOnce({ size: 4096 } as any)

    const result = await getWorktreeSize('wt-01')
    expect(result.bytes).toBe(4096)
  })

  it('skips missing repo path (orphaned repo) — returns 0 for that entry', async () => {
    mockReadFile.mockResolvedValue(makeWorktreeJson([{ path: '/missing/repo' }]))
    // du fails on missing path
    queueDuError()
    // JS walk on missing dir also returns 0
    mockReaddir.mockRejectedValueOnce(new Error('ENOENT'))

    const result = await getWorktreeSize('wt-01')
    expect(result.bytes).toBe(0)
  })
})
