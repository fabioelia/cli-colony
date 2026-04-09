/**
 * Tests for src/main/github.ts
 *
 * Module-level state: `configFile` (JsonFile instance), `_cachedUser`, constants.
 * Uses vi.resetModules() + vi.doMock() + dynamic imports for isolation.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Shared mock objects — hoisted so vi.doMock factories can reference them
const mockJsonFileRead = vi.hoisted(() => vi.fn())
const mockJsonFileWrite = vi.hoisted(() => vi.fn())
const mockExecFile = vi.hoisted(() => vi.fn())
const mockExecSync = vi.hoisted(() => vi.fn())
const mockFsp = vi.hoisted(() => ({
  stat: vi.fn().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
  readFile: vi.fn().mockResolvedValue(''),
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
  readdir: vi.fn().mockResolvedValue([]),
  access: vi.fn().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
  unlink: vi.fn().mockResolvedValue(undefined),
}))
const mockGetAllRepoConfigs = vi.hoisted(() => vi.fn().mockReturnValue([]))
const mockGetRepoConfig = vi.hoisted(() => vi.fn().mockReturnValue(null))
const mockGitRemoteUrl = vi.hoisted(() => vi.fn().mockReturnValue('git@github.com:test/repo.git'))
const mockEnsureBareRepo = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))

const MOCK_ROOT = '/mock/.claude-colony'

const DEFAULT_PROMPTS = [
  { id: 'summarize', label: 'Summarize PR', prompt: 'Summarize...', scope: 'pr' },
  { id: 'checkout', label: 'Checkout & Test', prompt: 'Checkout...', scope: 'pr' },
  { id: 'my-prs', label: 'My open PRs', prompt: 'Which PRs...', scope: 'global' },
  { id: 'needs-review', label: 'Needs my review', prompt: 'Which PRs need...', scope: 'global' },
  { id: 'stale-prs', label: 'Stale PRs', prompt: 'Which PRs haven\'t...', scope: 'global' },
]

function setupMocks(): void {
  vi.doMock('electron', () => ({
    app: { getPath: vi.fn().mockReturnValue('/mock/home') },
  }))

  vi.doMock('../../shared/colony-paths', () => ({
    colonyPaths: {
      root: MOCK_ROOT,
      githubJson: `${MOCK_ROOT}/github.json`,
      repos: `${MOCK_ROOT}/repos`,
      pipelines: `${MOCK_ROOT}/pipelines`,
      personas: `${MOCK_ROOT}/personas`,
      environments: `${MOCK_ROOT}/environments`,
      prWorkspace: `${MOCK_ROOT}/pr-workspace`,
      prComments: `${MOCK_ROOT}/pr-workspace/comments`,
      repoDir: (owner: string, name: string) => `${MOCK_ROOT}/repos/${owner}/${name}`,
      bareRepoDir: (owner: string, name: string) => `${MOCK_ROOT}/repos/${owner}/${name}.git`,
    },
  }))

  vi.doMock('../../shared/json-file', () => ({
    JsonFile: class MockJsonFile {
      constructor() {}
      read = mockJsonFileRead
      write = mockJsonFileWrite
    },
  }))

  vi.doMock('fs', () => ({
    promises: mockFsp,
  }))

  vi.doMock('child_process', () => ({
    execFile: mockExecFile,
    execSync: mockExecSync,
  }))

  vi.doMock('../repo-config-loader', () => ({
    getAllRepoConfigs: mockGetAllRepoConfigs,
    getRepoConfig: mockGetRepoConfig,
  }))

  vi.doMock('../settings', () => ({
    gitRemoteUrl: mockGitRemoteUrl,
  }))

  vi.doMock('../../shared/git-worktree', () => ({
    ensureBareRepo: mockEnsureBareRepo,
  }))
}

describe('github module', () => {
  let mod: typeof import('../github')

  beforeEach(async () => {
    vi.resetModules()
    vi.resetAllMocks()

    mockJsonFileRead.mockReturnValue({ repos: [], prompts: DEFAULT_PROMPTS })
    mockFsp.stat.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
    mockFsp.readFile.mockResolvedValue('')
    mockFsp.readdir.mockResolvedValue([])
    mockFsp.writeFile.mockResolvedValue(undefined)
    mockFsp.mkdir.mockResolvedValue(undefined)
    mockGetAllRepoConfigs.mockReturnValue([])
    mockGitRemoteUrl.mockReturnValue('git@github.com:test/repo.git')
    mockEnsureBareRepo.mockResolvedValue(undefined)

    setupMocks()
    mod = await import('../github')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // ---- gh CLI wrapper ----

  describe('gh', () => {
    it('resolves with stdout on success', async () => {
      mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
        cb(null, 'output-data', '')
      })
      const result = await mod.gh(['auth', 'status'])
      expect(result).toBe('output-data')
      expect(mockExecFile).toHaveBeenCalledWith('gh', ['auth', 'status'], expect.any(Object), expect.any(Function))
    })

    it('rejects with stderr on failure', async () => {
      mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
        cb(new Error('command failed'), '', 'auth error message')
      })
      await expect(mod.gh(['auth', 'status'])).rejects.toThrow('auth error message')
    })

    it('rejects with error message when stderr is empty', async () => {
      mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
        cb(new Error('command failed'), '', '')
      })
      await expect(mod.gh(['pr', 'list'])).rejects.toThrow('command failed')
    })
  })

  // ---- checkGhAuth ----

  describe('checkGhAuth', () => {
    it('returns true when gh auth status succeeds', async () => {
      mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
        cb(null, 'Logged in as user', '')
      })
      expect(await mod.checkGhAuth()).toBe(true)
    })

    it('returns false when gh auth status fails', async () => {
      mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
        cb(new Error('not logged in'), '', 'not logged in')
      })
      expect(await mod.checkGhAuth()).toBe(false)
    })
  })

  // ---- getGitHubUser ----

  describe('getGitHubUser', () => {
    it('returns the login from gh api user', async () => {
      mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
        cb(null, 'octocat\n', '')
      })
      const user = await mod.getGitHubUser()
      expect(user).toBe('octocat')
    })

    it('returns null on error', async () => {
      mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
        cb(new Error('not authed'), '', 'error')
      })
      expect(await mod.getGitHubUser()).toBeNull()
    })

    it('returns null when output is empty', async () => {
      mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
        cb(null, '  \n', '')
      })
      expect(await mod.getGitHubUser()).toBeNull()
    })

    it('caches the result after first call', async () => {
      mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
        cb(null, 'cached-user\n', '')
      })
      expect(await mod.getGitHubUser()).toBe('cached-user')
      // Second call should not invoke execFile again
      mockExecFile.mockClear()
      expect(await mod.getGitHubUser()).toBe('cached-user')
      expect(mockExecFile).not.toHaveBeenCalled()
    })
  })

  // ---- Config CRUD ----

  describe('getRepos', () => {
    it('returns empty array when no repos configured', async () => {
      mockJsonFileRead.mockReturnValue({ repos: [], prompts: [] })
      expect(await mod.getRepos()).toEqual([])
    })

    it('returns repos with resolved localPath', async () => {
      mockJsonFileRead.mockReturnValue({
        repos: [{ owner: 'acme', name: 'web', localPath: undefined }],
        prompts: [],
      })
      // pathExists uses fsp.stat — reject = not exists
      mockFsp.stat.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
      const repos = await mod.getRepos()
      expect(repos).toHaveLength(1)
      expect(repos[0].owner).toBe('acme')
      // localPath should be set to bareRepoDir since none exist
      expect(repos[0].localPath).toBe(`${MOCK_ROOT}/repos/acme/web.git`)
    })

    it('sets cloned=true when bare clone dir exists', async () => {
      mockJsonFileRead.mockReturnValue({
        repos: [{ owner: 'acme', name: 'web' }],
        prompts: [],
      })
      // stat resolves for the bare dir path (exists), rejects for others
      mockFsp.stat.mockImplementation(async (p: string) => {
        if (p === `${MOCK_ROOT}/repos/acme/web.git`) return { isDirectory: () => true }
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      })
      const repos = await mod.getRepos()
      expect((repos[0] as any).cloned).toBe(true)
    })

    it('saves config when localPath is updated', async () => {
      mockJsonFileRead.mockReturnValue({
        repos: [{ owner: 'acme', name: 'web', localPath: '/old/path' }],
        prompts: [],
      })
      mockFsp.stat.mockImplementation(async (p: string) => {
        if (p === '/old/path') throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        if (p === `${MOCK_ROOT}/repos/acme/web.git`) return { isDirectory: () => true }
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      })
      await mod.getRepos()
      expect(mockJsonFileWrite).toHaveBeenCalled()
    })
  })

  describe('addRepo', () => {
    it('adds a new repo to config', () => {
      mockJsonFileRead.mockReturnValue({ repos: [], prompts: [] })
      const result = mod.addRepo({ owner: 'test', name: 'new-repo' })
      expect(mockJsonFileWrite).toHaveBeenCalledWith(expect.objectContaining({
        repos: [expect.objectContaining({ owner: 'test', name: 'new-repo' })],
      }))
      expect(result).toHaveLength(1)
    })

    it('does not add duplicate repo', () => {
      mockJsonFileRead.mockReturnValue({
        repos: [{ owner: 'test', name: 'existing' }],
        prompts: [],
      })
      const result = mod.addRepo({ owner: 'test', name: 'existing' })
      expect(mockJsonFileWrite).not.toHaveBeenCalled()
      expect(result).toHaveLength(1)
    })

    it('sets localPath to bare repo dir if not provided', () => {
      mockJsonFileRead.mockReturnValue({ repos: [], prompts: [] })
      mod.addRepo({ owner: 'org', name: 'app' })
      expect(mockJsonFileWrite).toHaveBeenCalledWith(expect.objectContaining({
        repos: [expect.objectContaining({ localPath: `${MOCK_ROOT}/repos/org/app.git` })],
      }))
    })

    it('triggers bare repo clone in background', () => {
      mockJsonFileRead.mockReturnValue({ repos: [], prompts: [] })
      mod.addRepo({ owner: 'org', name: 'app' })
      expect(mockEnsureBareRepo).toHaveBeenCalledWith('org', 'app', 'git@github.com:org/app.git')
    })
  })

  describe('removeRepo', () => {
    it('removes repo from config by owner/name', () => {
      mockJsonFileRead.mockReturnValue({
        repos: [
          { owner: 'a', name: 'one' },
          { owner: 'b', name: 'two' },
        ],
        prompts: [],
      })
      const result = mod.removeRepo('a', 'one')
      expect(result).toHaveLength(1)
      expect(result[0]).toEqual({ owner: 'b', name: 'two' })
      expect(mockJsonFileWrite).toHaveBeenCalled()
    })

    it('no-ops when repo not found', () => {
      mockJsonFileRead.mockReturnValue({
        repos: [{ owner: 'a', name: 'one' }],
        prompts: [],
      })
      const result = mod.removeRepo('x', 'none')
      expect(result).toHaveLength(1)
      expect(mockJsonFileWrite).toHaveBeenCalled()
    })
  })

  describe('updateRepoPath', () => {
    it('updates localPath for matching repo', () => {
      mockJsonFileRead.mockReturnValue({
        repos: [{ owner: 'o', name: 'r', localPath: '/old' }],
        prompts: [],
      })
      mod.updateRepoPath('o', 'r', '/new/path')
      expect(mockJsonFileWrite).toHaveBeenCalledWith(expect.objectContaining({
        repos: [expect.objectContaining({ localPath: '/new/path' })],
      }))
    })

    it('does nothing when repo not found', () => {
      mockJsonFileRead.mockReturnValue({
        repos: [{ owner: 'o', name: 'r' }],
        prompts: [],
      })
      mod.updateRepoPath('x', 'y', '/some/path')
      // Still saves (no guard against missing)
      expect(mockJsonFileWrite).not.toHaveBeenCalled()
    })
  })

  // ---- Prompts ----

  describe('getPrompts', () => {
    it('returns default prompts when no review prompt exists', async () => {
      mockJsonFileRead.mockReturnValue({ repos: [], prompts: DEFAULT_PROMPTS })
      const prompts = await mod.getPrompts()
      // Should prepend BASIC_REVIEW_PROMPT since no colony-feedback pipeline
      expect(prompts[0].id).toBe('review')
      expect(prompts.length).toBe(DEFAULT_PROMPTS.length + 1)
    })

    it('does not inject review prompt when one already exists', async () => {
      const withReview = [...DEFAULT_PROMPTS, { id: 'review', label: 'My Review', prompt: 'custom', scope: 'pr' as const }]
      mockJsonFileRead.mockReturnValue({ repos: [], prompts: withReview })
      const prompts = await mod.getPrompts()
      expect(prompts).toEqual(withReview)
    })

    it('injects colony-review when colony-feedback pipeline is enabled', async () => {
      mockJsonFileRead.mockReturnValue({ repos: [], prompts: DEFAULT_PROMPTS })
      mockFsp.stat.mockImplementation(async (p: string) => {
        if (p === `${MOCK_ROOT}/pipelines/colony-feedback.yaml`) return { isFile: () => true }
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      })
      mockFsp.readFile.mockResolvedValue('enabled: true\nname: Colony Feedback')
      const prompts = await mod.getPrompts()
      expect(prompts[0].id).toBe('colony-review')
    })

    it('falls back to basic review when pipeline file exists but disabled', async () => {
      mockJsonFileRead.mockReturnValue({ repos: [], prompts: DEFAULT_PROMPTS })
      mockFsp.stat.mockImplementation(async (p: string) => {
        if (p === `${MOCK_ROOT}/pipelines/colony-feedback.yaml`) return { isFile: () => true }
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      })
      mockFsp.readFile.mockResolvedValue('enabled: false\nname: Colony Feedback')
      const prompts = await mod.getPrompts()
      expect(prompts[0].id).toBe('review')
    })

    it('merges repo-defined prompts without duplicates', async () => {
      mockJsonFileRead.mockReturnValue({ repos: [], prompts: DEFAULT_PROMPTS })
      mockGetAllRepoConfigs.mockReturnValue([
        { repoSlug: 'test/repo', prompts: [{ id: 'repo-custom', label: 'Repo Custom', prompt: 'custom', scope: 'pr' }], pipelines: [], templates: [] },
      ])
      const prompts = await mod.getPrompts()
      expect(prompts.some(p => p.id === 'repo-custom')).toBe(true)
    })

    it('does not add repo prompts that collide with existing IDs', async () => {
      mockJsonFileRead.mockReturnValue({ repos: [], prompts: DEFAULT_PROMPTS })
      mockGetAllRepoConfigs.mockReturnValue([
        { repoSlug: 'test/repo', prompts: [{ id: 'summarize', label: 'Dup', prompt: 'dup', scope: 'pr' }], pipelines: [], templates: [] },
      ])
      const prompts = await mod.getPrompts()
      const summaries = prompts.filter(p => p.id === 'summarize')
      expect(summaries).toHaveLength(1)
    })
  })

  describe('savePrompts', () => {
    it('saves prompts to config and returns them', () => {
      mockJsonFileRead.mockReturnValue({ repos: [], prompts: DEFAULT_PROMPTS })
      const newPrompts = [{ id: 'x', label: 'X', prompt: 'x', scope: 'global' as const }]
      const result = mod.savePrompts(newPrompts)
      expect(mockJsonFileWrite).toHaveBeenCalledWith(expect.objectContaining({ prompts: newPrompts }))
      expect(result).toEqual(newPrompts)
    })
  })

  // ---- resolvePrompt ----

  describe('resolvePrompt', () => {
    it('resolves mustache template with pr and repo context', async () => {
      const prompt = {
        id: 'test',
        label: 'Test',
        prompt: 'Review PR #{{pr.number}} ({{pr.title}}) on {{repo.owner}}/{{repo.name}}',
        scope: 'pr' as const,
      }
      const pr = {
        number: 42,
        title: 'Fix bug',
        body: 'Fixes something',
        author: 'alice',
        assignees: ['bob'],
        reviewers: ['carol'],
        branch: 'fix/bug',
        baseBranch: 'main',
        state: 'OPEN',
        draft: false,
        url: 'https://github.com/test/repo/pull/42',
        createdAt: '2026-01-01',
        updatedAt: '2026-01-02',
        additions: 10,
        deletions: 5,
        reviewDecision: 'APPROVED',
        labels: ['bugfix'],
        comments: [],
        headSha: 'abc123',
      }
      const repo = { owner: 'test', name: 'repo' }
      const result = await mod.resolvePrompt(prompt, pr, repo)
      expect(result).toBe('Review PR #42 (Fix bug) on test/repo')
    })

    it('resolves status as draft when pr.draft is true', async () => {
      const prompt = { id: 't', label: 'T', prompt: 'Status: {{pr.status}}', scope: 'pr' as const }
      const pr = {
        number: 1, title: '', body: '', author: '', assignees: [], reviewers: [],
        branch: '', baseBranch: '', state: 'OPEN', draft: true, url: '', createdAt: '',
        updatedAt: '', additions: 0, deletions: 0, reviewDecision: '', labels: [],
        comments: [], headSha: '',
      }
      expect(await mod.resolvePrompt(prompt, pr, { owner: 'o', name: 'n' })).toBe('Status: draft')
    })

    it('falls back to none for empty assignees/reviewers/labels/reviewDecision', async () => {
      const prompt = {
        id: 't', label: 'T',
        prompt: 'A:{{pr.assignees}} R:{{pr.reviewers}} L:{{pr.labels}} D:{{pr.reviewDecision}}',
        scope: 'pr' as const,
      }
      const pr = {
        number: 1, title: '', body: '', author: '', assignees: [], reviewers: [],
        branch: '', baseBranch: '', state: 'OPEN', draft: false, url: '', createdAt: '',
        updatedAt: '', additions: 0, deletions: 0, reviewDecision: '', labels: [],
        comments: [], headSha: '',
      }
      const result = await mod.resolvePrompt(prompt, pr, { owner: 'o', name: 'n' })
      expect(result).toBe('A:none R:none L:none D:none')
    })

    it('joins multiple assignees with commas', async () => {
      const prompt = { id: 't', label: 'T', prompt: '{{pr.assignees}}', scope: 'pr' as const }
      const pr = {
        number: 1, title: '', body: '', author: '', assignees: ['alice', 'bob'], reviewers: [],
        branch: '', baseBranch: '', state: 'OPEN', draft: false, url: '', createdAt: '',
        updatedAt: '', additions: 0, deletions: 0, reviewDecision: '', labels: [],
        comments: [], headSha: '',
      }
      expect(await mod.resolvePrompt(prompt, pr, { owner: 'o', name: 'n' })).toBe('alice, bob')
    })

    it('includes repo.remoteUrl via gitRemoteUrl', async () => {
      mockGitRemoteUrl.mockReturnValue('git@github.com:abc/xyz.git')
      const prompt = { id: 't', label: 'T', prompt: '{{repo.remoteUrl}}', scope: 'pr' as const }
      const pr = {
        number: 1, title: '', body: '', author: '', assignees: [], reviewers: [],
        branch: '', baseBranch: '', state: 'OPEN', draft: false, url: '', createdAt: '',
        updatedAt: '', additions: 0, deletions: 0, reviewDecision: '', labels: [],
        comments: [], headSha: '',
      }
      expect(await mod.resolvePrompt(prompt, pr, { owner: 'abc', name: 'xyz' })).toBe('git@github.com:abc/xyz.git')
    })
  })

  // ---- PR Workspace ----

  describe('getPrWorkspacePath', () => {
    it('creates directory if it does not exist', async () => {
      mockFsp.stat.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
      const result = await mod.getPrWorkspacePath()
      expect(result).toBe(`${MOCK_ROOT}/pr-workspace`)
      expect(mockFsp.mkdir).toHaveBeenCalledWith(`${MOCK_ROOT}/pr-workspace`, { recursive: true })
    })

    it('returns path without creating if it already exists', async () => {
      mockFsp.stat.mockResolvedValue({ isDirectory: () => true })
      mockFsp.mkdir.mockClear()
      await mod.getPrWorkspacePath()
      expect(mockFsp.mkdir).not.toHaveBeenCalled()
    })
  })

  describe('getPrMemory', () => {
    it('returns file contents when file exists', async () => {
      mockFsp.stat.mockImplementation(async (p: string) => {
        if (p === `${MOCK_ROOT}/pr-workspace/pr-memory.md`) return { isFile: () => true }
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      })
      mockFsp.readFile.mockResolvedValue('# PR Memory\nSome content')
      expect(await mod.getPrMemory()).toBe('# PR Memory\nSome content')
    })

    it('returns empty string when file does not exist', async () => {
      mockFsp.stat.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
      expect(await mod.getPrMemory()).toBe('')
    })

    it('returns empty string on read error', async () => {
      mockFsp.stat.mockResolvedValue({ isFile: () => true })
      mockFsp.readFile.mockRejectedValue(new Error('read error'))
      expect(await mod.getPrMemory()).toBe('')
    })
  })

  describe('savePrMemory', () => {
    it('writes content and returns true', async () => {
      expect(await mod.savePrMemory('new content')).toBe(true)
      expect(mockFsp.writeFile).toHaveBeenCalledWith(
        `${MOCK_ROOT}/pr-workspace/pr-memory.md`,
        'new content',
        'utf-8'
      )
    })

    it('returns false on write error', async () => {
      mockFsp.writeFile.mockRejectedValue(new Error('write failed'))
      expect(await mod.savePrMemory('data')).toBe(false)
    })
  })

  describe('getPrMemoryPath', () => {
    it('creates file with default content when it does not exist', async () => {
      mockFsp.stat.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
      const path = await mod.getPrMemoryPath()
      expect(path).toBe(`${MOCK_ROOT}/pr-workspace/pr-memory.md`)
      // Should create workspace dir + memory file
      expect(mockFsp.mkdir).toHaveBeenCalled()
      expect(mockFsp.writeFile).toHaveBeenCalledWith(
        expect.stringContaining('pr-memory.md'),
        expect.stringContaining('# PR Memory'),
        'utf-8'
      )
    })

    it('does not overwrite when file exists', async () => {
      mockFsp.stat.mockResolvedValue({ isFile: () => true })
      mockFsp.writeFile.mockClear()
      await mod.getPrMemoryPath()
      // writeFile should not be called for the memory file content
      expect(mockFsp.writeFile).not.toHaveBeenCalled()
    })
  })

  // ---- writePrContext ----

  describe('writePrContext', () => {
    it('writes markdown with PR data', async () => {
      // getPrWorkspacePath needs stat to resolve (path exists)
      mockFsp.stat.mockResolvedValue({ isDirectory: () => true })
      const prs = {
        'test/repo': [{
          number: 1,
          title: 'First PR',
          body: 'Description text',
          author: 'alice',
          assignees: ['bob'],
          reviewers: ['carol'],
          branch: 'feature',
          baseBranch: 'main',
          state: 'OPEN',
          draft: false,
          url: 'https://github.com/test/repo/pull/1',
          createdAt: '2026-01-01',
          updatedAt: '2026-01-02',
          additions: 10,
          deletions: 5,
          reviewDecision: 'APPROVED',
          labels: ['enhancement'],
          comments: [{ author: 'bob', body: 'Looks good', createdAt: '2026-01-02' }],
          headSha: 'abc',
        }],
      }
      const contextPath = await mod.writePrContext(prs)
      expect(contextPath).toBe(`${MOCK_ROOT}/pr-workspace/pr-context.md`)

      // Check that writeFile was called for context and comment files
      const contextCall = mockFsp.writeFile.mock.calls.find(
        (c: any[]) => (c[0] as string).endsWith('pr-context.md')
      )
      expect(contextCall).toBeDefined()
      const content = contextCall![1] as string
      expect(content).toContain('# Open Pull Requests')
      expect(content).toContain('## test/repo')
      expect(content).toContain('### #1: First PR')
      expect(content).toContain('**Author:** alice')
      expect(content).toContain('+10 / -5')
      expect(content).toContain('**Labels:** enhancement')
      expect(content).toContain('Description text')
    })

    it('skips repos with no PRs', async () => {
      mockFsp.stat.mockResolvedValue({ isDirectory: () => true })
      await mod.writePrContext({ 'empty/repo': [] })
      const contextCall = mockFsp.writeFile.mock.calls.find(
        (c: any[]) => (c[0] as string).endsWith('pr-context.md')
      )
      expect(contextCall).toBeDefined()
      const content = contextCall![1] as string
      expect(content).not.toContain('empty/repo')
    })

    it('writes comment files for PRs with comments', async () => {
      mockFsp.stat.mockResolvedValue({ isDirectory: () => true })
      const prs = {
        'org/app': [{
          number: 5, title: 'PR5', body: '', author: 'a', assignees: [], reviewers: [],
          branch: 'b', baseBranch: 'main', state: 'OPEN', draft: false,
          url: 'https://github.com/org/app/pull/5', createdAt: '', updatedAt: '',
          additions: 0, deletions: 0, reviewDecision: '', labels: [],
          comments: [
            { author: 'reviewer', body: 'Fix this', createdAt: '2026-01-01', path: 'src/main.ts' },
          ],
          headSha: 'def',
        }],
      }
      await mod.writePrContext(prs)
      const commentCall = mockFsp.writeFile.mock.calls.find(
        (c: any[]) => (c[0] as string).includes('org-app-5.md')
      )
      expect(commentCall).toBeDefined()
      const commentContent = commentCall![1] as string
      expect(commentContent).toContain('reviewer')
      expect(commentContent).toContain('Fix this')
      expect(commentContent).toContain('(file: src/main.ts)')
    })

    it('handles PRs with no comments', async () => {
      mockFsp.stat.mockResolvedValue({ isDirectory: () => true })
      const prs = {
        'org/app': [{
          number: 3, title: 'PR3', body: '', author: 'a', assignees: [], reviewers: [],
          branch: 'b', baseBranch: 'main', state: 'OPEN', draft: false,
          url: '', createdAt: '', updatedAt: '', additions: 0, deletions: 0,
          reviewDecision: '', labels: [], comments: [], headSha: '',
        }],
      }
      await mod.writePrContext(prs)
      const contextCall = mockFsp.writeFile.mock.calls.find(
        (c: any[]) => (c[0] as string).endsWith('pr-context.md')
      )
      const content = contextCall![1] as string
      expect(content).toContain('**Comments:** none')
    })
  })

  // ---- getRemovalImpact ----

  describe('getRemovalImpact', () => {
    it('returns empty impact when nothing references the repo', async () => {
      mockFsp.stat.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
      const impact = await mod.getRemovalImpact('org', 'app')
      expect(impact.slug).toBe('org/app')
      expect(impact.pipelineFiles).toEqual([])
      expect(impact.personaFiles).toEqual([])
      expect(impact.environments).toEqual([])
      expect(impact.repoPipelines).toEqual([])
      expect(impact.prCommentFiles).toBe(0)
      expect(impact.bareCloneExists).toBe(false)
      expect(impact.bareClonePath).toBe(`${MOCK_ROOT}/repos/org/app.git`)
    })

    it('finds pipeline files referencing the repo', async () => {
      mockFsp.stat.mockImplementation(async (p: string) => {
        if (p === `${MOCK_ROOT}/pipelines`) return { isDirectory: () => true }
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      })
      mockFsp.readdir.mockImplementation(async (p: string) => {
        if (p === `${MOCK_ROOT}/pipelines`) return ['ci.yaml', 'deploy.yml', 'other.txt']
        return []
      })
      mockFsp.readFile.mockImplementation(async (p: string) => {
        if ((p as string).includes('ci.yaml')) return 'repo: org/app\ntrigger: push'
        if ((p as string).includes('deploy.yml')) return 'no reference here'
        return ''
      })
      const impact = await mod.getRemovalImpact('org', 'app')
      expect(impact.pipelineFiles).toHaveLength(1)
      expect(impact.pipelineFiles[0].fileName).toBe('ci.yaml')
      expect(impact.pipelineFiles[0].matchingLines[0]).toContain('org/app')
    })

    it('finds environments referencing the repo', async () => {
      mockFsp.stat.mockImplementation(async (p: string) => {
        if (p === `${MOCK_ROOT}/environments`) return { isDirectory: () => true }
        if (p.endsWith('manifest.json')) return { isFile: () => true }
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      })
      mockFsp.readdir.mockImplementation(async (p: string) => {
        if (p === `${MOCK_ROOT}/environments`) return ['env-1']
        return []
      })
      mockFsp.readFile.mockImplementation(async (p: string) => {
        if ((p as string).includes('manifest.json')) {
          return JSON.stringify({
            displayName: 'My Env',
            git: { branch: 'main' },
            setup: { status: 'ready' },
            paths: { repo: `${MOCK_ROOT}/repos/org/app.git` },
          })
        }
        return ''
      })
      const impact = await mod.getRemovalImpact('org', 'app')
      expect(impact.environments).toHaveLength(1)
      expect(impact.environments[0].name).toBe('My Env')
      expect(impact.environments[0].branch).toBe('main')
    })

    it('counts PR comment files', async () => {
      mockFsp.stat.mockImplementation(async (p: string) => {
        if (p === `${MOCK_ROOT}/pr-workspace/comments`) return { isDirectory: () => true }
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      })
      mockFsp.readdir.mockImplementation(async (p: string) => {
        if (p === `${MOCK_ROOT}/pr-workspace/comments`) return ['org-app-1.md', 'org-app-5.md', 'other-repo-2.md']
        return []
      })
      const impact = await mod.getRemovalImpact('org', 'app')
      expect(impact.prCommentFiles).toBe(2)
    })

    it('reports bare clone existence', async () => {
      mockFsp.stat.mockImplementation(async (p: string) => {
        if (p === `${MOCK_ROOT}/repos/org/app.git`) return { isDirectory: () => true }
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      })
      const impact = await mod.getRemovalImpact('org', 'app')
      expect(impact.bareCloneExists).toBe(true)
    })

    it('includes repo pipelines from .colony/ config', async () => {
      mockGetAllRepoConfigs.mockReturnValue([
        { repoSlug: 'org/app', pipelines: [{ name: 'CI', enabled: true }, { name: 'Deploy', enabled: false }], prompts: [], templates: [] },
      ])
      const impact = await mod.getRemovalImpact('org', 'app')
      expect(impact.repoPipelines).toHaveLength(2)
      expect(impact.repoPipelines[0]).toEqual({ name: 'CI', enabled: true })
    })
  })

  // ---- fetchPRs ----

  describe('fetchPRs', () => {
    const mockPrListOutput = JSON.stringify([{
      number: 10,
      title: 'Add feature',
      body: 'description',
      author: { login: 'alice' },
      assignees: [{ login: 'bob' }],
      reviewRequests: [{ login: 'carol' }, { name: 'team-x' }],
      headRefName: 'feat/new',
      headRefOid: 'sha123',
      baseRefName: 'main',
      state: 'OPEN',
      isDraft: false,
      url: 'https://github.com/org/repo/pull/10',
      createdAt: '2026-01-01',
      updatedAt: '2026-01-02',
      additions: 42,
      deletions: 7,
      reviewDecision: 'REVIEW_REQUIRED',
      labels: [{ name: 'feature' }],
      comments: [{ author: { login: 'dave' }, body: 'Nice!', createdAt: '2026-01-02' }],
    }])

    it('parses PR list from gh output', async () => {
      let callCount = 0
      mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: any, cb: Function) => {
        callCount++
        if (callCount === 1) {
          // pr list call
          cb(null, mockPrListOutput, '')
        } else {
          // review comments API call - return empty
          cb(null, '', '')
        }
      })
      mockFsp.stat.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })) // no bare repo for refreshBareRepoConfig

      const prs = await mod.fetchPRs({ owner: 'org', name: 'repo' })
      expect(prs).toHaveLength(1)
      expect(prs[0].number).toBe(10)
      expect(prs[0].title).toBe('Add feature')
      expect(prs[0].author).toBe('alice')
      expect(prs[0].assignees).toEqual(['bob'])
      expect(prs[0].reviewers).toEqual(['carol', 'team-x'])
      expect(prs[0].branch).toBe('feat/new')
      expect(prs[0].headSha).toBe('sha123')
      expect(prs[0].additions).toBe(42)
      expect(prs[0].labels).toEqual(['feature'])
      expect(prs[0].comments).toHaveLength(1)
      expect(prs[0].comments[0].author).toBe('dave')
    })

    it('appends review comments from API', async () => {
      let callCount = 0
      mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
        callCount++
        if (callCount === 1) {
          cb(null, mockPrListOutput, '')
        } else {
          // Return a review comment
          cb(null, '{"author":"eve","body":"Review comment","createdAt":"2026-01-03","path":"src/app.ts"}\n', '')
        }
      })
      mockFsp.stat.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))

      const prs = await mod.fetchPRs({ owner: 'org', name: 'repo' })
      expect(prs[0].comments).toHaveLength(2) // 1 general + 1 review
      expect(prs[0].comments[1].author).toBe('eve')
      expect(prs[0].comments[1].path).toBe('src/app.ts')
    })
  })

  // ---- fetchChecks ----

  describe('fetchChecks', () => {
    it('parses check runs into CheckRun[] with correct overall status', async () => {
      mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
        cb(null, JSON.stringify([
          { name: 'lint', state: 'SUCCESS', link: 'https://example.com/1' },
          { name: 'test', state: 'FAILURE', link: 'https://example.com/2' },
          { name: 'build', state: 'PENDING', link: '' },
        ]), '')
      })
      const result = await mod.fetchChecks({ owner: 'o', name: 'r' }, 1)
      expect(result.overall).toBe('failure')
      expect(result.checks).toHaveLength(3)
      expect(result.checks[0]).toEqual({ name: 'lint', status: 'completed', conclusion: 'success', url: 'https://example.com/1' })
      expect(result.checks[1]).toEqual({ name: 'test', status: 'completed', conclusion: 'failure', url: 'https://example.com/2' })
      expect(result.checks[2]).toEqual({ name: 'build', status: 'in_progress', conclusion: null, url: '' })
    })

    it('returns success when all checks pass', async () => {
      mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
        cb(null, JSON.stringify([
          { name: 'lint', state: 'SUCCESS', link: '' },
          { name: 'test', state: 'SUCCESS', link: '' },
        ]), '')
      })
      const result = await mod.fetchChecks({ owner: 'o', name: 'r' }, 1)
      expect(result.overall).toBe('success')
    })

    it('returns pending when some checks are in progress', async () => {
      mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
        cb(null, JSON.stringify([
          { name: 'lint', state: 'SUCCESS', link: '' },
          { name: 'test', state: 'QUEUED', link: '' },
        ]), '')
      })
      const result = await mod.fetchChecks({ owner: 'o', name: 'r' }, 1)
      expect(result.overall).toBe('pending')
    })

    it('returns none when no checks exist', async () => {
      mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
        cb(null, '[]', '')
      })
      const result = await mod.fetchChecks({ owner: 'o', name: 'r' }, 1)
      expect(result.overall).toBe('none')
      expect(result.checks).toEqual([])
    })

    it('returns none on gh error', async () => {
      mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
        cb(new Error('not found'), '', 'not found')
      })
      const result = await mod.fetchChecks({ owner: 'o', name: 'r' }, 999)
      expect(result.overall).toBe('none')
    })

    it('maps SKIPPED, CANCELLED, NEUTRAL, STARTUP_FAILURE states correctly', async () => {
      mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
        cb(null, JSON.stringify([
          { name: 'a', state: 'SKIPPED', link: '' },
          { name: 'b', state: 'CANCELLED', link: '' },
          { name: 'c', state: 'NEUTRAL', link: '' },
          { name: 'd', state: 'STARTUP_FAILURE', link: '' },
        ]), '')
      })
      const result = await mod.fetchChecks({ owner: 'o', name: 'r' }, 1)
      expect(result.checks[0].conclusion).toBe('skipped')
      expect(result.checks[1].conclusion).toBe('cancelled')
      expect(result.checks[2].conclusion).toBe('neutral')
      expect(result.checks[3].conclusion).toBe('failure')
      // STARTUP_FAILURE counts as failure
      expect(result.overall).toBe('failure')
    })
  })

  // ---- shallowCloneRepo ----

  describe('shallowCloneRepo', () => {
    it('delegates to ensureBareRepo with correct remote URL', async () => {
      mockGitRemoteUrl.mockReturnValue('git@github.com:test/repo.git')
      await mod.shallowCloneRepo({ owner: 'test', name: 'repo' })
      expect(mockEnsureBareRepo).toHaveBeenCalledWith('test', 'repo', 'git@github.com:test/repo.git')
    })
  })

  // ---- ensureRepoClones ----

  describe('ensureRepoClones', () => {
    it('triggers bare clone for repos without existing bare dir', async () => {
      mockJsonFileRead.mockReturnValue({
        repos: [{ owner: 'a', name: 'b' }],
        prompts: [],
      })
      mockFsp.stat.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
      await mod.ensureRepoClones()
      expect(mockEnsureBareRepo).toHaveBeenCalledWith('a', 'b', 'git@github.com:test/repo.git')
    })

    it('skips repos that already have bare clones', async () => {
      mockJsonFileRead.mockReturnValue({
        repos: [{ owner: 'a', name: 'b' }],
        prompts: [],
      })
      mockFsp.stat.mockImplementation(async (p: string) => {
        if (p === `${MOCK_ROOT}/repos/a/b.git`) return { isDirectory: () => true }
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      })
      await mod.ensureRepoClones()
      expect(mockEnsureBareRepo).not.toHaveBeenCalled()
    })
  })
})
