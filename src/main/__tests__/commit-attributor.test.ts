/**
 * Tests for src/main/commit-attributor.ts
 *
 * Strategy: vi.resetModules() + vi.doMock() + dynamic import per test.
 * Mocks electron, fs, child_process, and util.
 * `execFileAsync` is the promisified execFile — we mock util.promisify to
 * return our mock directly so async/await works.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const MOCK_HOME = '/mock/home'
const MOCK_ATTR_PATH = `${MOCK_HOME}/.claude-colony/commit-attribution.json`

const mockFs = {
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  unlinkSync: vi.fn(),
}

// execFileAsync — the promisified version returned by our util.promisify mock
const mockExecFileAsync = vi.fn()

function setupMocks(fileExists: boolean, fileContent?: string) {
  mockFs.existsSync.mockReset().mockReturnValue(fileExists)
  mockFs.readFileSync.mockReset().mockReturnValue(fileContent ?? '[]')
  mockFs.writeFileSync.mockReset()
  mockFs.mkdirSync.mockReset()
  mockFs.unlinkSync.mockReset()
  mockExecFileAsync.mockReset()

  vi.doMock('electron', () => ({
    app: { getPath: vi.fn().mockReturnValue(MOCK_HOME) },
  }))
  vi.doMock('fs', () => mockFs)
  vi.doMock('child_process', () => ({ execFile: vi.fn() }))
  // promisify → always returns our async mock so module-level assignment works
  vi.doMock('util', () => ({ promisify: () => mockExecFileAsync }))
}

describe('commit-attributor', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  // ---- scanNewCommits ----

  it('scanNewCommits: skips when dir is empty', async () => {
    setupMocks(false)
    const mod = await import('../commit-attributor')
    await mod.scanNewCommits('id1', 'Test', '', Date.now())
    expect(mockExecFileAsync).not.toHaveBeenCalled()
  })

  it('scanNewCommits: skips when not a git repo', async () => {
    setupMocks(false)
    mockExecFileAsync.mockRejectedValueOnce(new Error('not a git repo'))
    const mod = await import('../commit-attributor')
    await mod.scanNewCommits('id1', 'Test', '/some/dir', Date.now())
    expect(mockFs.writeFileSync).not.toHaveBeenCalled()
  })

  it('scanNewCommits: appends new commits to the log', async () => {
    setupMocks(false)
    // First call: git rev-parse → success; second call: git log → commits
    mockExecFileAsync
      .mockResolvedValueOnce({ stdout: '.git' })
      .mockResolvedValueOnce({ stdout: 'abc1234|feat: add feature\ndef5678|fix: bug fix\n' })

    const mod = await import('../commit-attributor')
    await mod.scanNewCommits('session-1', 'My Session', '/repo', 1000000, 'Colony QA', 0.05)

    expect(mockFs.writeFileSync).toHaveBeenCalledOnce()
    const [writePath, writeContent] = mockFs.writeFileSync.mock.calls[0]
    expect(writePath).toBe(MOCK_ATTR_PATH)
    const written = JSON.parse(writeContent as string)
    expect(written).toHaveLength(2)
    expect(written[0].commitHash).toBe('abc1234')
    expect(written[0].sessionId).toBe('session-1')
    expect(written[0].sessionName).toBe('My Session')
    expect(written[0].personaName).toBe('Colony QA')
    expect(written[0].cost).toBe(0.05)
    expect(written[1].commitHash).toBe('def5678')
  })

  it('scanNewCommits: deduplicates — skips commits already in log', async () => {
    const existing = [
      { commitHash: 'abc1234', shortMsg: 'existing', sessionId: 'old', sessionName: 'Old', startedAt: 0, stoppedAt: 1, dir: '/repo' },
    ]
    setupMocks(true, JSON.stringify(existing))
    mockExecFileAsync
      .mockResolvedValueOnce({ stdout: '.git' })
      .mockResolvedValueOnce({ stdout: 'abc1234|feat: already known\nnew9999|feat: brand new\n' })

    const mod = await import('../commit-attributor')
    await mod.scanNewCommits('session-2', 'New Session', '/repo', 1000000)

    const [, writeContent] = mockFs.writeFileSync.mock.calls[0]
    const written = JSON.parse(writeContent as string)
    expect(written).toHaveLength(2) // 1 existing + 1 new (abc1234 deduped)
    expect(written[1].commitHash).toBe('new9999')
  })

  it('scanNewCommits: no-ops when git log returns empty output', async () => {
    setupMocks(false)
    mockExecFileAsync
      .mockResolvedValueOnce({ stdout: '.git' })
      .mockResolvedValueOnce({ stdout: '' })

    const mod = await import('../commit-attributor')
    await mod.scanNewCommits('session-3', 'My Session', '/repo', Date.now())
    expect(mockFs.writeFileSync).not.toHaveBeenCalled()
  })

  it('scanNewCommits: trims to MAX_ENTRIES (200)', async () => {
    const existing = Array.from({ length: 199 }, (_, i) => ({
      commitHash: `hash${i}`,
      shortMsg: `msg ${i}`,
      sessionId: 'old',
      sessionName: 'Old',
      startedAt: 0,
      stoppedAt: 1,
      dir: '/repo',
    }))
    setupMocks(true, JSON.stringify(existing))
    mockExecFileAsync
      .mockResolvedValueOnce({ stdout: '.git' })
      .mockResolvedValueOnce({ stdout: 'brand000|new commit\nbrand001|another\n' })

    const mod = await import('../commit-attributor')
    await mod.scanNewCommits('session-trim', 'Trim Session', '/repo', 1000000)

    const [, writeContent] = mockFs.writeFileSync.mock.calls[0]
    const written = JSON.parse(writeContent as string)
    expect(written).toHaveLength(200) // trimmed from 201 to 200
  })

  // ---- getAttributedCommits ----

  it('getAttributedCommits: returns empty array when file missing', async () => {
    setupMocks(false)
    const mod = await import('../commit-attributor')
    expect(mod.getAttributedCommits()).toEqual([])
    expect(mockFs.readFileSync).not.toHaveBeenCalled()
  })

  it('getAttributedCommits: returns entries newest first', async () => {
    const entries = [
      { commitHash: 'aaa', shortMsg: 'first', sessionId: 's1', sessionName: 'S1', startedAt: 1, stoppedAt: 100, dir: '/a' },
      { commitHash: 'bbb', shortMsg: 'second', sessionId: 's2', sessionName: 'S2', startedAt: 2, stoppedAt: 200, dir: '/b' },
    ]
    setupMocks(true, JSON.stringify(entries))
    const mod = await import('../commit-attributor')
    const result = mod.getAttributedCommits()
    expect(result[0].commitHash).toBe('bbb') // newest first (last in array → first)
    expect(result[1].commitHash).toBe('aaa')
  })

  it('getAttributedCommits: filters by directory when dir provided', async () => {
    const entries = [
      { commitHash: 'aaa', shortMsg: 'a', sessionId: 's1', sessionName: 'S1', startedAt: 1, stoppedAt: 100, dir: '/repo-a' },
      { commitHash: 'bbb', shortMsg: 'b', sessionId: 's2', sessionName: 'S2', startedAt: 2, stoppedAt: 200, dir: '/repo-b' },
    ]
    setupMocks(true, JSON.stringify(entries))
    const mod = await import('../commit-attributor')
    const result = mod.getAttributedCommits('/repo-a')
    expect(result).toHaveLength(1)
    expect(result[0].commitHash).toBe('aaa')
  })

  // ---- clearAttributions ----

  it('clearAttributions: deletes the file when it exists', async () => {
    setupMocks(true)
    const mod = await import('../commit-attributor')
    mod.clearAttributions()
    expect(mockFs.unlinkSync).toHaveBeenCalledWith(MOCK_ATTR_PATH)
  })

  it('clearAttributions: no-ops when file does not exist', async () => {
    setupMocks(false)
    const mod = await import('../commit-attributor')
    mod.clearAttributions()
    expect(mockFs.unlinkSync).not.toHaveBeenCalled()
  })
})
