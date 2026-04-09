/**
 * Tests for resolvePrompt() in src/main/github.ts
 *
 * resolvePrompt() builds a context object from a GitHubPR + GitHubRepo,
 * then runs it through resolveMustacheTemplate. The context has several
 * computed fields (status, assignees, reviewers, labels, reviewDecision,
 * description, remoteUrl) that could silently regress.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { QuickPrompt, GitHubPR, GitHubRepo } from '../../shared/types'

// ---- Static mocks (evaluated before imports) ----

vi.mock('electron', () => ({
  app: { getPath: vi.fn().mockReturnValue('/mock/home') },
}))

const mockGitRemoteUrl = vi.fn().mockReturnValue('git@github.com:owner/repo.git')

vi.mock('../settings', () => ({
  gitRemoteUrl: (...args: unknown[]) => mockGitRemoteUrl(...args),
  getSetting: vi.fn().mockReturnValue(null),
  getDefaultArgs: vi.fn().mockReturnValue([]),
  getDefaultCliBackend: vi.fn().mockReturnValue('claude'),
}))

// Prevent git worktree from running real git operations
vi.mock('../../shared/git-worktree', () => ({
  ensureBareRepo: vi.fn().mockResolvedValue('/mock/bare'),
}))

// Prevent repo-config-loader from doing fs scans
vi.mock('../repo-config-loader', () => ({
  getAllRepoConfigs: vi.fn().mockReturnValue([]),
  getRepoConfig: vi.fn().mockReturnValue(null),
  getRepoContext: vi.fn().mockReturnValue(null),
}))

import { resolvePrompt } from '../github'

// ---- Helpers ----

function makePR(overrides: Partial<GitHubPR> = {}): GitHubPR {
  return {
    number: 42,
    title: 'Add feature X',
    body: '',
    author: 'alice',
    assignees: [],
    reviewers: [],
    branch: 'feature/x',
    baseBranch: 'main',
    state: 'open',
    draft: false,
    url: 'https://github.com/owner/repo/pull/42',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z',
    additions: 20,
    deletions: 5,
    reviewDecision: '',
    labels: [],
    comments: [],
    headSha: 'abc123',
    ...overrides,
  }
}

function makeRepo(overrides: Partial<GitHubRepo> = {}): GitHubRepo {
  return { owner: 'owner', name: 'repo', ...overrides }
}

function makePrompt(template: string): QuickPrompt {
  return { id: 'test', label: 'Test', prompt: template, scope: 'pr' }
}

// ---- Tests ----

describe('resolvePrompt', () => {
  beforeEach(() => {
    mockGitRemoteUrl.mockReturnValue('git@github.com:owner/repo.git')
  })

  describe('pr.status computed field', () => {
    it('sets status to "draft" for draft PRs', async () => {
      const result = await resolvePrompt(makePrompt('{{pr.status}}'), makePR({ draft: true, state: 'open' }), makeRepo())
      expect(result).toBe('draft')
    })

    it('sets status to the PR state for non-draft PRs', async () => {
      const result = await resolvePrompt(makePrompt('{{pr.status}}'), makePR({ draft: false, state: 'open' }), makeRepo())
      expect(result).toBe('open')
    })

    it('sets status to "merged" for merged non-draft PRs', async () => {
      const result = await resolvePrompt(makePrompt('{{pr.status}}'), makePR({ draft: false, state: 'merged' }), makeRepo())
      expect(result).toBe('merged')
    })
  })

  describe('pr.assignees / reviewers / labels formatting', () => {
    it('formats empty assignees as "none"', async () => {
      const result = await resolvePrompt(makePrompt('{{pr.assignees}}'), makePR({ assignees: [] }), makeRepo())
      expect(result).toBe('none')
    })

    it('joins multiple assignees with ", "', async () => {
      const result = await resolvePrompt(makePrompt('{{pr.assignees}}'), makePR({ assignees: ['alice', 'bob'] }), makeRepo())
      expect(result).toBe('alice, bob')
    })

    it('formats empty reviewers as "none"', async () => {
      const result = await resolvePrompt(makePrompt('{{pr.reviewers}}'), makePR({ reviewers: [] }), makeRepo())
      expect(result).toBe('none')
    })

    it('joins multiple reviewers with ", "', async () => {
      const result = await resolvePrompt(makePrompt('{{pr.reviewers}}'), makePR({ reviewers: ['carol', 'dave'] }), makeRepo())
      expect(result).toBe('carol, dave')
    })

    it('formats empty labels as "none"', async () => {
      const result = await resolvePrompt(makePrompt('{{pr.labels}}'), makePR({ labels: [] }), makeRepo())
      expect(result).toBe('none')
    })

    it('joins multiple labels with ", "', async () => {
      const result = await resolvePrompt(makePrompt('{{pr.labels}}'), makePR({ labels: ['bug', 'urgent'] }), makeRepo())
      expect(result).toBe('bug, urgent')
    })
  })

  describe('pr.reviewDecision', () => {
    it('defaults to "none" when reviewDecision is empty string', async () => {
      const result = await resolvePrompt(makePrompt('{{pr.reviewDecision}}'), makePR({ reviewDecision: '' }), makeRepo())
      expect(result).toBe('none')
    })

    it('passes through a non-empty reviewDecision', async () => {
      const result = await resolvePrompt(makePrompt('{{pr.reviewDecision}}'), makePR({ reviewDecision: 'APPROVED' }), makeRepo())
      expect(result).toBe('APPROVED')
    })
  })

  describe('pr.description', () => {
    it('sets description to empty string when body is empty', async () => {
      const result = await resolvePrompt(makePrompt('{{pr.description}}'), makePR({ body: '' }), makeRepo())
      expect(result).toBe('')
    })

    it('sets description to the PR body', async () => {
      const result = await resolvePrompt(makePrompt('{{pr.description}}'), makePR({ body: 'Fixes the bug.' }), makeRepo())
      expect(result).toBe('Fixes the bug.')
    })
  })

  describe('repo context', () => {
    it('calls gitRemoteUrl with repo owner and name', async () => {
      await resolvePrompt(makePrompt('{{repo.remoteUrl}}'), makePR(), makeRepo({ owner: 'acme', name: 'app' }))
      expect(mockGitRemoteUrl).toHaveBeenCalledWith('acme', 'app')
    })

    it('injects remoteUrl from gitRemoteUrl into the template', async () => {
      mockGitRemoteUrl.mockReturnValue('https://github.com/acme/app.git')
      const result = await resolvePrompt(makePrompt('{{repo.remoteUrl}}'), makePR(), makeRepo({ owner: 'acme', name: 'app' }))
      expect(result).toBe('https://github.com/acme/app.git')
    })

    it('exposes repo owner and name in the template', async () => {
      const result = await resolvePrompt(
        makePrompt('{{repo.owner}}/{{repo.name}}'),
        makePR(),
        makeRepo({ owner: 'acme', name: 'widgets' }),
      )
      expect(result).toBe('acme/widgets')
    })
  })

  describe('reviewer field', () => {
    it('defaults reviewer to "unknown" when no user is cached', async () => {
      const result = await resolvePrompt(makePrompt('{{reviewer}}'), makePR(), makeRepo())
      expect(result).toBe('unknown')
    })
  })

  describe('PR fields available in template', () => {
    it('exposes pr.number and pr.title', async () => {
      const result = await resolvePrompt(
        makePrompt('PR #{{pr.number}}: {{pr.title}}'),
        makePR({ number: 99, title: 'My Change' }),
        makeRepo(),
      )
      expect(result).toBe('PR #99: My Change')
    })

    it('exposes pr.branch and pr.baseBranch', async () => {
      const result = await resolvePrompt(
        makePrompt('{{pr.branch}} → {{pr.baseBranch}}'),
        makePR({ branch: 'feat/foo', baseBranch: 'develop' }),
        makeRepo(),
      )
      expect(result).toBe('feat/foo → develop')
    })
  })
})
