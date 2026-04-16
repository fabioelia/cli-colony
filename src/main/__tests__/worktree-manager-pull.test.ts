/**
 * Tests for pullWorktree, getWorktreeUpstreamStatus, fetchWorktree.
 *
 * Mocks: electron, fs, colony-paths, child_process, resolve-command,
 *        shell-env, shared/git-worktree, settings, broadcast, utils.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

// ---- Hoisted mocks ----

const mockExecFile = vi.hoisted(() => {
  const fn = vi.fn()
  // Give it the promisify.custom symbol so promisify() uses our mock
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
const mockReaddir = vi.hoisted(() => vi.fn(async () => []))
const mockAccess = vi.hoisted(() => vi.fn(async () => undefined))
const mockBroadcast = vi.hoisted(() => vi.fn())

vi.mock('electron', () => ({ app: { getPath: vi.fn().mockReturnValue('/mock/home') } }))

vi.mock('fs', () => ({
  promises: {
    mkdir: vi.fn(async () => undefined),
    writeFile: vi.fn(async () => undefined),
    readFile: mockReadFile,
    readdir: mockReaddir,
    access: mockAccess,
    rm: vi.fn(async () => undefined),
  },
}))

vi.mock('child_process', () => ({
  execFile: mockExecFile,
}))

vi.mock('../resolve-command', () => ({
  resolveCommand: vi.fn(() => '/usr/bin/git'),
}))

vi.mock('../../shared/shell-env', () => ({
  loadShellEnv: vi.fn(() => ({ PATH: '/usr/bin' })),
}))

vi.mock('../../shared/colony-paths', () => ({
  colonyPaths: {
    worktrees: '/mock/colony/worktrees',
    worktreeDir: (id: string) => `/mock/colony/worktrees/${id}`,
  },
}))

vi.mock('../../shared/git-worktree', () => ({
  ensureBareRepo: vi.fn(async () => '/mock/bare/owner/repo.git'),
  addWorktree: vi.fn(async () => undefined),
  removeWorktree: vi.fn(async () => undefined),
}))

vi.mock('../settings', () => ({
  gitRemoteUrl: vi.fn(async () => 'git@github.com:owner/repo.git'),
}))

vi.mock('../broadcast', () => ({ broadcast: mockBroadcast }))

vi.mock('../../shared/utils', () => ({ genId: vi.fn(() => 'test-id') }))

import { pullWorktree, getWorktreeUpstreamStatus, fetchWorktree } from '../worktree-manager'

// ---- Helpers ----

const BARE = '/mock/bare'
const REPO = '/mock/repo'

function makeWorktreeJson(branch = 'develop') {
  return JSON.stringify({
    id: 'wt-01',
    displayName: `${branch} (wt-01)`,
    branch,
    createdAt: new Date().toISOString(),
    mountedEnvId: null,
    repos: [{ owner: 'org', name: 'repo', alias: 'backend', path: REPO, bareRepoPath: BARE }],
    repo: { owner: 'org', name: 'repo' },
    path: REPO,
    bareRepoPath: BARE,
    repoAlias: 'backend',
  })
}

/** Queue git command responses in order. Each call to execFile returns the next response. */
function queueGitResponses(responses: Array<string | Error>) {
  let i = 0
  mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: (err: any, stdout: string, stderr: string) => void) => {
    const r = responses[i++]
    if (r instanceof Error) {
      Object.assign(r, { stderr: r.message })
      cb(r, '', r.message)
    } else {
      cb(null, r as string, '')
    }
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockReadFile.mockResolvedValue(makeWorktreeJson())
  mockAccess.mockResolvedValue(undefined)
})

// ---- pullWorktree ----

describe('pullWorktree', () => {
  it('happy path: fetch → clean → upstream → ancestor → ff-merge', async () => {
    queueGitResponses([
      '',            // fetch
      '',            // status --porcelain (clean)
      'origin/develop', // rev-parse HEAD@{u}
      'abc123\n',    // rev-parse HEAD (before)
      '',            // merge-base --is-ancestor (exit 0)
      '3\n',         // rev-list --count HEAD..origin/develop
      '',            // merge --ff-only
      'def456\n',    // rev-parse HEAD (after)
    ])

    const result = await pullWorktree('wt-01')
    expect(result).toMatchObject({ ok: true, commitsPulled: 3, before: 'abc123', after: 'def456' })
    expect(mockBroadcast).toHaveBeenCalledWith('worktree:changed', null)
  })

  it('up-to-date: 0 commits behind — returns ok without merging', async () => {
    queueGitResponses([
      '',            // fetch
      '',            // status --porcelain (clean)
      'origin/develop', // rev-parse HEAD@{u}
      'abc123\n',    // rev-parse HEAD
      '',            // merge-base --is-ancestor (ok)
      '0\n',         // rev-list --count (0 behind)
      'abc123\n',    // rev-parse HEAD (after — no merge happened)
    ])

    const result = await pullWorktree('wt-01')
    expect(result).toMatchObject({ ok: true, commitsPulled: 0 })
  })

  it('dirty path: uncommitted changes — returns dirty without touching branch', async () => {
    queueGitResponses([
      '',            // fetch
      'M src/foo.ts\n', // status --porcelain (dirty)
    ])

    const result = await pullWorktree('wt-01')
    expect(result).toMatchObject({ ok: false, reason: 'dirty' })
    expect(mockBroadcast).not.toHaveBeenCalled()
  })

  it('diverged path: local commits ahead of origin — refuses to merge', async () => {
    const ancestorErr = Object.assign(new Error('not ancestor'), { stderr: '', code: 1 })
    queueGitResponses([
      '',            // fetch
      '',            // status --porcelain (clean)
      'origin/develop', // rev-parse HEAD@{u}
      'abc123\n',    // rev-parse HEAD
      ancestorErr,   // merge-base --is-ancestor → non-zero exit
    ])

    const result = await pullWorktree('wt-01')
    expect(result).toMatchObject({ ok: false, reason: 'diverged' })
  })

  it('no-upstream path: HEAD@{u} fails → no-upstream', async () => {
    queueGitResponses([
      '',             // fetch
      '',             // status --porcelain (clean)
      new Error('no upstream'), // rev-parse HEAD@{u} fails
    ])

    const result = await pullWorktree('wt-01')
    expect(result).toMatchObject({ ok: false, reason: 'no-upstream' })
  })

  it('fetch-failed: network error → returns fetch-failed', async () => {
    queueGitResponses([new Error('connection refused')])

    const result = await pullWorktree('wt-01')
    expect(result).toMatchObject({ ok: false, reason: 'fetch-failed' })
  })

  it('not-found: worktree does not exist', async () => {
    mockReadFile.mockRejectedValue(new Error('ENOENT'))
    const result = await pullWorktree('nonexistent')
    expect(result).toMatchObject({ ok: false, reason: 'not-found' })
  })
})

// ---- getWorktreeUpstreamStatus ----

describe('getWorktreeUpstreamStatus', () => {
  it('returns behind/ahead counts and dirty flag', async () => {
    queueGitResponses([
      '5\t2\n',   // rev-list --left-right --count
      'M foo.ts\n', // status --porcelain (dirty)
    ])

    const result = await getWorktreeUpstreamStatus('wt-01')
    expect(result).toMatchObject({ behind: 5, ahead: 2, dirty: true, upToDate: false, upstream: 'origin/develop' })
  })

  it('returns upToDate=true when clean and 0/0', async () => {
    queueGitResponses([
      '0\t0\n',  // rev-list counts
      '',         // status --porcelain (clean)
    ])

    const result = await getWorktreeUpstreamStatus('wt-01')
    expect(result).toMatchObject({ behind: 0, ahead: 0, dirty: false, upToDate: true })
  })

  it('returns error field on git failure without throwing', async () => {
    queueGitResponses([new Error('git not in PATH')])

    const result = await getWorktreeUpstreamStatus('wt-01')
    expect(result.error).toBeDefined()
    expect(result.upToDate).toBe(true) // safe fallback
  })
})

// ---- fetchWorktree ----

describe('fetchWorktree', () => {
  it('calls git fetch on bareRepoPath and returns ok', async () => {
    queueGitResponses([''])

    const result = await fetchWorktree('wt-01')
    expect(result).toEqual({ ok: true })
    expect(mockExecFile).toHaveBeenCalledWith(
      '/usr/bin/git',
      ['fetch', 'origin', 'develop'],
      expect.objectContaining({ cwd: BARE }),
      expect.any(Function),
    )
  })

  it('returns ok:false on network failure', async () => {
    queueGitResponses([new Error('remote: not found')])

    const result = await fetchWorktree('wt-01')
    expect(result).toMatchObject({ ok: false })
  })
})
