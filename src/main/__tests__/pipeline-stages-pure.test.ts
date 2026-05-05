/**
 * Tests for pure/isolated logic in pipeline-stages.ts:
 *   - isApproved(text)
 *   - extractReviewObservations(verdict)
 *   - loadReviewRules / appendReviewRule (mocked FS)
 *
 * The module has many integration-level dependencies; they are mocked below to
 * prevent import errors. Only the testable pure functions are exercised here.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

// ---- Hoisted mocks for FS ----
const mockReadFile = vi.hoisted(() => vi.fn(async () => '[]'))
const mockWriteFile = vi.hoisted(() => vi.fn(async () => undefined))
const mockMkdir = vi.hoisted(() => vi.fn(async () => undefined))

vi.mock('electron', () => ({ app: { getPath: vi.fn().mockReturnValue('/mock/home') } }))
vi.mock('fs', () => ({
  promises: {
    readFile: mockReadFile,
    writeFile: mockWriteFile,
    mkdir: mockMkdir,
    access: vi.fn(async () => undefined),
  },
}))
vi.mock('child_process', () => ({ execFile: vi.fn() }))
vi.mock('../resolve-command', () => ({ resolveCommand: vi.fn(async () => 'claude') }))
vi.mock('../instance-manager', () => ({
  createInstance: vi.fn(),
  getAllInstances: vi.fn(() => []),
  killInstance: vi.fn(),
  updateDockBadge: vi.fn(),
}))
vi.mock('../daemon-router', () => ({ getDaemonRouter: vi.fn() }))
vi.mock('../send-prompt-when-ready', () => ({ sendPromptWhenReady: vi.fn() }))
vi.mock('../activity-manager', () => ({ appendActivity: vi.fn() }))
vi.mock('../broadcast', () => ({ broadcast: vi.fn() }))
vi.mock('../notifications', () => ({ notify: vi.fn() }))
vi.mock('../worktree-manager', () => ({ createWorktree: vi.fn(), removeWorktree: vi.fn() }))
vi.mock('../arena-stats', () => ({ readArenaStats: vi.fn(async () => ({})), writeArenaStats: vi.fn() }))
vi.mock('../session-completion', () => ({ waitForSessionCompletion: vi.fn() }))
vi.mock('../session-artifacts', () => ({ tagArtifactPipeline: vi.fn() }))
vi.mock('../shared/colony-paths', () => ({
  colonyPaths: {
    root: '/mock/.claude-colony',
    reviewRules: '/mock/.claude-colony/review-rules.json',
  },
}))
vi.mock('../pipeline-engine', () => ({
  plog: vi.fn(),
  log: vi.fn(),
  resolveTemplate: vi.fn((s: string) => s),
  writePromptFile: vi.fn(async () => '/mock/prompt.md'),
  pathExists: vi.fn(async () => false),
  APPROVAL_DEFAULT_TTL_HOURS: 24,
  pendingApprovals: new Map(),
  pendingApprovalKeys: new Map(),
  pipelines: new Map(),
  PIPELINES_DIR: '/mock/.claude-colony/pipelines',
}))

import { isApproved, extractReviewObservations, loadReviewRules, appendReviewRule } from '../pipeline-stages'

// ---------------------------------------------------------------------------
// isApproved
// ---------------------------------------------------------------------------

describe('pipeline-stages: isApproved', () => {
  it('returns true for "APPROVED"', () => expect(isApproved('APPROVED')).toBe(true))
  it('returns true for lowercase "approved"', () => expect(isApproved('approved')).toBe(true))
  it('returns true for "LGTM"', () => expect(isApproved('LGTM')).toBe(true))
  it('returns true for lowercase "lgtm"', () => expect(isApproved('lgtm')).toBe(true))
  it('returns true when "approved" is embedded in longer text', () => {
    expect(isApproved('This change is approved! Great work.')).toBe(true)
  })
  it('returns false for empty string', () => expect(isApproved('')).toBe(false))
  it('returns false for unrelated text', () => expect(isApproved('Needs more changes.')).toBe(false))
  it('returns false for "approval" (not "approved")', () => expect(isApproved('awaiting approval')).toBe(false))
})

// ---------------------------------------------------------------------------
// extractReviewObservations
// ---------------------------------------------------------------------------

describe('pipeline-stages: extractReviewObservations', () => {
  it('returns empty string for empty verdict', () => {
    expect(extractReviewObservations('')).toBe('')
  })

  it('returns empty string when no approved/lgtm line', () => {
    expect(extractReviewObservations('Looks good but needs cleanup.')).toBe('')
  })

  it('returns empty string when APPROVED is last line with nothing after', () => {
    expect(extractReviewObservations('APPROVED')).toBe('')
  })

  it('returns observations from lines after APPROVED', () => {
    const verdict = 'APPROVED\nFix the typo in README\nRemove unused import'
    expect(extractReviewObservations(verdict)).toBe('Fix the typo in README\nRemove unused import')
  })

  it('filters blank lines after APPROVED', () => {
    const verdict = 'APPROVED\n\n  \nFix the typo'
    expect(extractReviewObservations(verdict)).toBe('Fix the typo')
  })

  it('works when APPROVED appears mid-verdict', () => {
    const verdict = 'Overall this is good.\nAPPROVED\nMinor: add trailing newline'
    expect(extractReviewObservations(verdict)).toBe('Minor: add trailing newline')
  })

  it('works with LGTM keyword', () => {
    const verdict = 'LGTM\nOne suggestion: rename the variable'
    expect(extractReviewObservations(verdict)).toBe('One suggestion: rename the variable')
  })

  it('trims leading/trailing whitespace from result', () => {
    const verdict = 'APPROVED\n\nNote 1\n'
    expect(extractReviewObservations(verdict)).toBe('Note 1')
  })
})

// ---------------------------------------------------------------------------
// loadReviewRules
// ---------------------------------------------------------------------------

describe('pipeline-stages: loadReviewRules', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockReadFile.mockResolvedValue('[]')
  })

  it('returns empty array on read error', async () => {
    mockReadFile.mockRejectedValue(new Error('ENOENT'))
    expect(await loadReviewRules()).toEqual([])
  })

  it('returns all rules when no repoGlob specified', async () => {
    const rules = [{ id: 'r1', pattern: 'avoid console.log', severity: 'warning', repo: 'org/repo', createdAt: '2026-01-01', source: 'manual' }]
    mockReadFile.mockResolvedValue(JSON.stringify(rules))
    const result = await loadReviewRules()
    expect(result).toHaveLength(1)
  })

  it('returns all rules when repoGlob is "*"', async () => {
    const rules = [{ id: 'r1', pattern: 'test', severity: 'info', repo: 'other/repo', createdAt: '2026-01-01', source: 'manual' }]
    mockReadFile.mockResolvedValue(JSON.stringify(rules))
    const result = await loadReviewRules('*')
    expect(result).toHaveLength(1)
  })

  it('filters rules by matching repo', async () => {
    const rules = [
      { id: 'r1', pattern: 'p1', severity: 'info', repo: 'org/repo', createdAt: '2026-01-01', source: 'manual' },
      { id: 'r2', pattern: 'p2', severity: 'info', repo: 'other/thing', createdAt: '2026-01-01', source: 'manual' },
      { id: 'r3', pattern: 'p3', severity: 'info', repo: '*', createdAt: '2026-01-01', source: 'manual' },
    ]
    mockReadFile.mockResolvedValue(JSON.stringify(rules))
    const result = await loadReviewRules('org/repo')
    expect(result.map((r: { id: string }) => r.id)).toEqual(['r1', 'r3'])
  })
})

// ---------------------------------------------------------------------------
// appendReviewRule
// ---------------------------------------------------------------------------

describe('pipeline-stages: appendReviewRule', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockReadFile.mockResolvedValue('[]')
  })

  it('writes a new rule when history is empty', async () => {
    await appendReviewRule({ pattern: 'no console.log', severity: 'warning', repo: '*', source: 'manual' })
    expect(mockWriteFile).toHaveBeenCalledOnce()
    const written = JSON.parse(mockWriteFile.mock.calls[0][1] as string)
    expect(written).toHaveLength(1)
    expect(written[0].pattern).toBe('no console.log')
    expect(written[0].id).toMatch(/^rule-/)
  })

  it('skips duplicate when word overlap >= 80%', async () => {
    const existing = [{
      id: 'r1', pattern: 'avoid using console log statements', severity: 'warning', repo: '*', createdAt: '2026-01-01', source: 'manual',
    }]
    mockReadFile.mockResolvedValue(JSON.stringify(existing))
    // Very similar pattern — should be deduped
    await appendReviewRule({ pattern: 'avoid using console log statements please', severity: 'warning', repo: '*', source: 'manual' })
    expect(mockWriteFile).not.toHaveBeenCalled()
  })

  it('adds non-duplicate rule', async () => {
    const existing = [{ id: 'r1', pattern: 'no console.log', severity: 'warning', repo: '*', createdAt: '2026-01-01', source: 'manual' }]
    mockReadFile.mockResolvedValue(JSON.stringify(existing))
    await appendReviewRule({ pattern: 'use async/await not callbacks', severity: 'info', repo: '*', source: 'manual' })
    const written = JSON.parse(mockWriteFile.mock.calls[0][1] as string)
    expect(written).toHaveLength(2)
  })

  it('prunes oldest rules when limit of 50 exceeded', async () => {
    const existing = Array.from({ length: 50 }, (_, i) => ({
      id: `r${i}`, pattern: `unique pattern ${i}`, severity: 'info', repo: '*',
      createdAt: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`, source: 'manual',
    }))
    mockReadFile.mockResolvedValue(JSON.stringify(existing))
    await appendReviewRule({ pattern: 'brand new unique rule here', severity: 'warning', repo: '*', source: 'manual' })
    const written = JSON.parse(mockWriteFile.mock.calls[0][1] as string)
    expect(written).toHaveLength(50)
    // Oldest (r0) should be pruned
    expect(written.find((r: { id: string }) => r.id === 'r0')).toBeUndefined()
  })
})
