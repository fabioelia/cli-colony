/**
 * Tests for src/main/session-router.ts
 *
 * Covers:
 *   - nameMatchesBranch  — pure function, no mocking needed
 *   - getLiveBranch      — mocked child_process.execFileSync
 *   - getLiveBranchInSubdir — mocked fs (readdirSync + statSync) + getLiveBranch
 *   - scoreSessionDir    — mocked child_process + github + fs
 *
 * findBestRoute is integration-level (calls getAllInstances + scanSessions) — skipped.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---- Shared mutable mock instances ----
// These are declared outside so every loadModule() call picks them up via doMock closures.

const mockExecFileSync = vi.fn()
const mockGetRepos = vi.fn().mockResolvedValue([])
const mockReaddirSync = vi.fn().mockReturnValue([])
const mockStatSync = vi.fn()

/**
 * Fresh module load per test group.
 * vi.resetModules() + vi.doMock() lets each describe block get an isolated module
 * instance so there is no cross-test state leakage.
 */
async function loadModule() {
  vi.resetModules()

  vi.doMock('child_process', () => ({
    execFileSync: mockExecFileSync,
  }))

  vi.doMock('../github', () => ({
    getRepos: mockGetRepos,
  }))

  vi.doMock('fs', () => ({
    readdirSync: mockReaddirSync,
    statSync: mockStatSync,
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  }))

  vi.doMock('../instance-manager', () => ({ getAllInstances: vi.fn().mockResolvedValue([]) }))
  vi.doMock('../session-scanner', () => ({ scanSessions: vi.fn().mockResolvedValue([]) }))

  return await import('../session-router')
}

// ---------------------------------------------------------------------------
// nameMatchesBranch
// ---------------------------------------------------------------------------

describe('session-router: nameMatchesBranch', () => {
  let mod: Awaited<ReturnType<typeof loadModule>>

  beforeEach(async () => {
    mockGetRepos.mockResolvedValue([])
    mod = await loadModule()
  })

  it('returns false for empty session name', () => {
    expect(mod.nameMatchesBranch('', 'feature/foo')).toBe(false)
  })

  it('returns false for empty branch', () => {
    expect(mod.nameMatchesBranch('login page', '')).toBe(false)
  })

  it('returns false when name is exactly 3 chars (< 4)', () => {
    expect(mod.nameMatchesBranch('abc', 'abc-feature')).toBe(false)
  })

  it('returns false when name is 3 chars after trim (< 4)', () => {
    // Leading/trailing space trimmed inside the function
    expect(mod.nameMatchesBranch('  ab ', 'feature/ab-test')).toBe(false)
  })

  it('returns true when name is an exact substring of branch', () => {
    expect(mod.nameMatchesBranch('login', 'feature/login-refactor')).toBe(true)
  })

  it('returns true when branch is a substring of name', () => {
    expect(mod.nameMatchesBranch('feature/login', 'login')).toBe(true)
  })

  it('returns true on case-insensitive exact match', () => {
    expect(mod.nameMatchesBranch('Login Page', 'feature/login-page')).toBe(true)
  })

  it('returns true when all significant words (>2 chars) from name appear in branch', () => {
    // words: ['auth', 'refactor'] — both present in 'feature/auth-service-refactor'
    expect(mod.nameMatchesBranch('auth refactor', 'feature/auth-service-refactor')).toBe(true)
  })

  it('returns false when word-level match is incomplete (one word missing)', () => {
    // words: ['auth', 'billing'] — 'billing' not in branch
    expect(mod.nameMatchesBranch('auth billing', 'feature/auth-service-refactor')).toBe(false)
  })

  it('returns false when all words are <= 2 chars and no substring match (empty nameWords)', () => {
    // 'to do' → both words filtered out → nameWords empty → returns false
    expect(mod.nameMatchesBranch('to do', 'feature/todo-list')).toBe(false)
  })

  it('returns false for completely unrelated name and branch', () => {
    expect(mod.nameMatchesBranch('payment service', 'feature/auth-login')).toBe(false)
  })

  it('handles hyphenated session name — splits on hyphens for word matching', () => {
    // 'auth-refactor' → words ['auth', 'refactor'], both in 'feature/auth-module-refactor'
    expect(mod.nameMatchesBranch('auth-refactor', 'feature/auth-module-refactor')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// getLiveBranch
// ---------------------------------------------------------------------------

describe('session-router: getLiveBranch', () => {
  let mod: Awaited<ReturnType<typeof loadModule>>

  beforeEach(async () => {
    mockExecFileSync.mockReset()
    mod = await loadModule()
  })

  it('returns the trimmed branch name on success', () => {
    mockExecFileSync.mockReturnValue('main\n')
    expect(mod.getLiveBranch('/projects/app')).toBe('main')
  })

  it('trims whitespace from output', () => {
    mockExecFileSync.mockReturnValue('  feature/my-branch  \n')
    expect(mod.getLiveBranch('/projects/app')).toBe('feature/my-branch')
  })

  it('returns null when execFileSync throws', () => {
    mockExecFileSync.mockImplementation(() => { throw new Error('not a git repo') })
    expect(mod.getLiveBranch('/tmp/not-a-repo')).toBeNull()
  })

  it('returns null when output is an empty string', () => {
    mockExecFileSync.mockReturnValue('')
    expect(mod.getLiveBranch('/projects/app')).toBeNull()
  })

  it('returns null when output is only whitespace', () => {
    mockExecFileSync.mockReturnValue('   \n')
    expect(mod.getLiveBranch('/projects/app')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// getLiveBranchInSubdir
// ---------------------------------------------------------------------------

describe('session-router: getLiveBranchInSubdir', () => {
  let mod: Awaited<ReturnType<typeof loadModule>>

  beforeEach(async () => {
    mockExecFileSync.mockReset()
    mockReaddirSync.mockReset()
    mockStatSync.mockReset()
    mod = await loadModule()
  })

  it('returns null immediately when repoName is empty', () => {
    expect(mod.getLiveBranchInSubdir('/projects', '')).toBeNull()
    // readdirSync should not have been called
    expect(mockReaddirSync).not.toHaveBeenCalled()
  })

  it('returns the branch from the matching subdirectory (case-insensitive)', () => {
    // Directory listing contains 'MyRepo' which matches repoName 'myrepo'
    mockReaddirSync.mockReturnValue(['other', 'MyRepo', 'another'])
    mockStatSync.mockImplementation((p: string) => ({
      isDirectory: () => p.endsWith('MyRepo'),
    }))
    mockExecFileSync.mockReturnValue('feature/test\n')

    expect(mod.getLiveBranchInSubdir('/projects', 'myrepo')).toBe('feature/test')
  })

  it('returns null when no entry matches the repo name', () => {
    mockReaddirSync.mockReturnValue(['foo', 'bar', 'baz'])
    mockStatSync.mockImplementation(() => ({ isDirectory: () => true }))

    expect(mod.getLiveBranchInSubdir('/projects', 'myrepo')).toBeNull()
  })

  it('skips entries that are not directories', () => {
    mockReaddirSync.mockReturnValue(['myrepo'])
    mockStatSync.mockImplementation(() => ({ isDirectory: () => false }))
    // execFileSync should never be reached
    mockExecFileSync.mockReturnValue('feature/test\n')

    expect(mod.getLiveBranchInSubdir('/projects', 'myrepo')).toBeNull()
    expect(mockExecFileSync).not.toHaveBeenCalled()
  })

  it('skips entries where statSync throws', () => {
    mockReaddirSync.mockReturnValue(['myrepo'])
    mockStatSync.mockImplementation(() => { throw new Error('EACCES') })
    mockExecFileSync.mockReturnValue('feature/test\n')

    expect(mod.getLiveBranchInSubdir('/projects', 'myrepo')).toBeNull()
    expect(mockExecFileSync).not.toHaveBeenCalled()
  })

  it('returns null when the subdirectory is not a git repo', () => {
    mockReaddirSync.mockReturnValue(['myrepo'])
    mockStatSync.mockImplementation(() => ({ isDirectory: () => true }))
    mockExecFileSync.mockImplementation(() => { throw new Error('not a git repo') })

    expect(mod.getLiveBranchInSubdir('/projects', 'myrepo')).toBeNull()
  })

  it('returns null when readdirSync throws', () => {
    mockReaddirSync.mockImplementation(() => { throw new Error('ENOENT') })

    expect(mod.getLiveBranchInSubdir('/nonexistent', 'myrepo')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// scoreSessionDir
// ---------------------------------------------------------------------------

describe('session-router: scoreSessionDir', () => {
  let mod: Awaited<ReturnType<typeof loadModule>>

  beforeEach(async () => {
    mockExecFileSync.mockReset()
    mockGetRepos.mockResolvedValue([])
    mockReaddirSync.mockReturnValue([])
    mockStatSync.mockReset()
    mod = await loadModule()
  })

  // ---- Branch scoring ----

  it('returns 0 when no criteria match', async () => {
    mockExecFileSync.mockReturnValue('different-branch\n')
    const score = await mod.scoreSessionDir('/projects/app', 'My Session', null, { gitBranch: 'feature/foo' })
    expect(score).toBe(0)
  })

  it('scores +15 for live branch exact match', async () => {
    mockExecFileSync.mockReturnValue('feature/foo\n')
    const score = await mod.scoreSessionDir('/projects/app', '', null, { gitBranch: 'feature/foo' })
    expect(score).toBe(15)
  })

  it('scores +10 for metadata branch match when live branch misses', async () => {
    mockExecFileSync.mockImplementation(() => { throw new Error('not a git repo') })
    const score = await mod.scoreSessionDir('/projects/app', '', 'feature/foo', { gitBranch: 'feature/foo' })
    expect(score).toBe(10)
  })

  it('does not add metadata branch score when live branch already matched (+15 only)', async () => {
    mockExecFileSync.mockReturnValue('feature/foo\n')
    const score = await mod.scoreSessionDir('/projects/app', '', 'feature/foo', { gitBranch: 'feature/foo' })
    // metadata branch check runs only when score===0, so total is just 15
    expect(score).toBe(15)
  })

  it('scores higher for subdir branch match in a deep directory than in a shallow one', async () => {
    // scoreSessionDir calls getLiveBranch(dir) first (throws), then getLiveBranchInSubdir.
    // Use mockReturnValueOnce sequence: 1st execFileSync call throws, 2nd returns the branch.
    // Deep dir: more than (homeDepth+1) segments → subdir branch contributes +12.
    // Shallow dir: exactly (homeDepth+1) segments → subdir branch contributes +3.
    // Both also get +3 from the repo-subdir statSync check, so deep=15 and shallow=6.
    const home = process.env.HOME || '/home/user'
    const deepDir = home + '/workspace/projects'   // homeDepth+2 segments
    const shallowDir = home + '/projects'           // homeDepth+1 segments

    async function scoreWithSubdirBranch(dir: string) {
      mockExecFileSync.mockReset()
      mockExecFileSync
        .mockImplementationOnce(() => { throw new Error('not a repo') })
        .mockReturnValueOnce('feature/foo\n')
      mockReaddirSync.mockReturnValue(['myrepo'])
      mockStatSync.mockImplementation(() => ({ isDirectory: () => true }))
      return mod.scoreSessionDir(dir, '', null, { gitBranch: 'feature/foo', repoName: 'myrepo' })
    }

    const deepScore = await scoreWithSubdirBranch(deepDir)
    const shallowScore = await scoreWithSubdirBranch(shallowDir)

    // Deep dir gets +12 for subdir branch; shallow gets +3. Both add +3 for repo-subdir exists.
    expect(deepScore).toBeGreaterThan(shallowScore)
    expect(deepScore).toBe(15)   // 12 + 3
    expect(shallowScore).toBe(6) // 3 + 3
  })

  // ---- Working directory scoring ----

  it('scores +5 for exact working directory match', async () => {
    mockExecFileSync.mockImplementation(() => { throw new Error() })
    const score = await mod.scoreSessionDir('/projects/app', '', null, { workingDirectory: '/projects/app' })
    expect(score).toBe(5)
  })

  it('scores +3 for working directory prefix match', async () => {
    mockExecFileSync.mockImplementation(() => { throw new Error() })
    const score = await mod.scoreSessionDir('/projects/app/subdir', '', null, { workingDirectory: '/projects/app' })
    expect(score).toBe(3)
  })

  it('does not score prefix match when dir equals workingDirectory without trailing segment', async () => {
    // /projects/app-extra does NOT start with /projects/app/
    mockExecFileSync.mockImplementation(() => { throw new Error() })
    const score = await mod.scoreSessionDir('/projects/app-extra', '', null, { workingDirectory: '/projects/app' })
    expect(score).toBe(0)
  })

  // ---- Repo name in path ----

  it('scores +4 when repo name is a path suffix of the directory', async () => {
    mockExecFileSync.mockImplementation(() => { throw new Error() })
    const score = await mod.scoreSessionDir('/projects/my-repo', '', null, { repoName: 'my-repo' })
    expect(score).toBe(4)
  })

  it('scores +4 when repo name appears as an interior path segment', async () => {
    mockExecFileSync.mockImplementation(() => { throw new Error() })
    const score = await mod.scoreSessionDir('/projects/my-repo/frontend', '', null, { repoName: 'my-repo' })
    expect(score).toBe(4)
  })

  it('scores +3 when repo exists as a subdirectory of dir (statSync check)', async () => {
    mockExecFileSync.mockImplementation(() => { throw new Error() })
    // dir does not contain repo name in the path, but the subdir exists
    mockStatSync.mockImplementation(() => ({ isDirectory: () => true }))
    const score = await mod.scoreSessionDir('/projects/workspace', '', null, { repoName: 'my-repo' })
    expect(score).toBe(3)
  })

  it('does not score repo path when workingDirectory is also provided (mutual exclusion)', async () => {
    mockExecFileSync.mockImplementation(() => { throw new Error() })
    // workingDirectory present → repo-name path check is skipped
    const score = await mod.scoreSessionDir('/projects/my-repo', '', null, {
      repoName: 'my-repo',
      workingDirectory: '/other/path',
    })
    // workingDirectory does not match, repoName check skipped → 0
    expect(score).toBe(0)
  })

  // ---- PR number in name ----

  it('scores +8 when PR number appears in session name (#N format)', async () => {
    mockExecFileSync.mockImplementation(() => { throw new Error() })
    const score = await mod.scoreSessionDir('/projects/app', 'Fix #42', null, { prNumber: 42 })
    expect(score).toBe(8)
  })

  it('scores +8 when PR number appears in session name (pr N format)', async () => {
    mockExecFileSync.mockImplementation(() => { throw new Error() })
    const score = await mod.scoreSessionDir('/projects/app', 'Review PR 42', null, { prNumber: 42 })
    expect(score).toBe(8)
  })

  it('does not score PR number when session name contains a different number', async () => {
    mockExecFileSync.mockImplementation(() => { throw new Error() })
    const score = await mod.scoreSessionDir('/projects/app', 'Fix #99', null, { prNumber: 42 })
    expect(score).toBe(0)
  })

  // ---- Name matches branch ----

  it('scores +6 when session name contains the branch as an exact substring', async () => {
    mockExecFileSync.mockImplementation(() => { throw new Error() })
    const score = await mod.scoreSessionDir('/projects/app', 'feature/login-refactor session', null, {
      gitBranch: 'feature/login-refactor',
    })
    expect(score).toBe(6)
  })

  it('scores +5 when session name matches branch via word-level matching', async () => {
    mockExecFileSync.mockImplementation(() => { throw new Error() })
    // 'login refactor' → words ['login', 'refactor'] — both in 'feature/login-refactor' → +5
    const score = await mod.scoreSessionDir('/projects/app', 'login refactor', null, {
      gitBranch: 'feature/login-refactor',
    })
    expect(score).toBe(5)
  })

  // ---- Wrong-repo penalty ----

  it('applies -10 penalty when dir is inside a different tracked repo', async () => {
    mockGetRepos.mockResolvedValue([
      { name: 'other-repo', owner: 'org' },
      { name: 'my-repo', owner: 'org' },
    ])
    mockExecFileSync.mockReturnValue('feature/foo\n')
    // Dir is inside 'other-repo' but we are matching for 'my-repo'
    const score = await mod.scoreSessionDir('/projects/other-repo', '', null, {
      gitBranch: 'feature/foo',
      repoName: 'my-repo',
    })
    // live branch: +15, then penalty for 'other-repo' path: -10 → 5
    expect(score).toBe(5)
  })

  it('clamps penalty at 0 — score never goes negative', async () => {
    mockGetRepos.mockResolvedValue([
      { name: 'other-repo', owner: 'org' },
      { name: 'my-repo', owner: 'org' },
    ])
    mockExecFileSync.mockImplementation(() => { throw new Error() })
    // Only signal is working dir prefix match (+3); penalty (-10) would take it below 0
    const score = await mod.scoreSessionDir('/projects/other-repo/src', '', null, {
      workingDirectory: '/projects/other-repo',
      repoName: 'my-repo',
    })
    // workingDirectory check: starts with /projects/other-repo/ → +3
    // repoName present + workingDirectory also present → repo-path check skipped (no +4)
    // score > 0 → penalty check: 'other-repo' path segment matches → clamp to max(0, 3-10) = 0
    expect(score).toBe(0)
  })

  it('penalty does not apply when score is 0 before penalty check', async () => {
    mockGetRepos.mockResolvedValue([{ name: 'other-repo', owner: 'org' }])
    mockExecFileSync.mockImplementation(() => { throw new Error() })
    // Nothing matches → score stays 0 → penalty block is gated on score > 0
    const score = await mod.scoreSessionDir('/projects/other-repo', '', null, { repoName: 'my-repo' })
    expect(score).toBeGreaterThanOrEqual(0)
    expect(score).toBe(0)
  })

  it('penalty does not apply when the matching repo is the target repo itself', async () => {
    mockGetRepos.mockResolvedValue([{ name: 'my-repo', owner: 'org' }])
    mockExecFileSync.mockReturnValue('feature/foo\n')
    // Use a dir whose path does NOT contain 'my-repo' as a segment, so only live branch (+15) applies.
    // The penalty loop skips the repo when it equals the target repo.
    const score = await mod.scoreSessionDir('/projects/workspace', '', null, {
      gitBranch: 'feature/foo',
      repoName: 'my-repo',
    })
    // live branch: +15, no repo-in-path bonus (workspace != my-repo), no penalty
    expect(score).toBe(15)
  })

  // ---- Combined scoring ----

  it('combines live branch match and exact working directory', async () => {
    mockExecFileSync.mockReturnValue('feature/foo\n')
    const score = await mod.scoreSessionDir('/projects/app', '', null, {
      gitBranch: 'feature/foo',
      workingDirectory: '/projects/app',
    })
    // live branch: +15, exact workdir: +5
    expect(score).toBe(20)
  })

  it('combines live branch match and PR number in name', async () => {
    mockExecFileSync.mockReturnValue('feature/login\n')
    const score = await mod.scoreSessionDir('/projects/app', 'PR #99 login fix', null, {
      gitBranch: 'feature/login',
      prNumber: 99,
    })
    // live branch: +15, PR# in name: +8
    // session name 'PR #99 login fix' does not contain 'feature/login' → no +6
    // nameMatchesBranch('PR #99 login fix', 'feature/login'):
    //   words ['login', 'fix'] → 'login' in 'feature/login', 'fix' in 'feature/login'? No.
    //   → no +5 either
    expect(score).toBe(23)
  })

  it('getLiveBranch returning null yields no live branch score', async () => {
    mockExecFileSync.mockImplementation(() => { throw new Error('not a repo') })
    const score = await mod.scoreSessionDir('/tmp/not-a-repo', '', null, { gitBranch: 'main' })
    expect(score).toBe(0)
  })
})
