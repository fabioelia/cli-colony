/**
 * Tests for src/main/session-artifacts.ts
 *
 * Strategy: vi.resetModules() + vi.doMock() + dynamic import per test.
 * Mocks fs.promises, child_process (promisified execFile), and daemon-client.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const MOCK_HOME = '/mock/home'
const MOCK_ARTIFACTS_PATH = `${MOCK_HOME}/.claude-colony/session-artifacts.json`

const mockFsp = {
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
}

const mockExecFileAsync = vi.fn()

const mockGetInstance = vi.fn()

function setupMocks(existingArtifacts?: string) {
  mockFsp.readFile.mockReset()
  mockFsp.writeFile.mockReset()
  mockFsp.mkdir.mockReset()
  mockExecFileAsync.mockReset()
  mockGetInstance.mockReset()

  if (existingArtifacts) {
    mockFsp.readFile.mockResolvedValue(existingArtifacts)
  } else {
    mockFsp.readFile.mockRejectedValue(new Error('ENOENT'))
  }
  mockFsp.writeFile.mockResolvedValue(undefined)
  mockFsp.mkdir.mockResolvedValue(undefined)

  vi.doMock('fs', () => ({
    promises: mockFsp,
  }))
  vi.doMock('path', async () => await vi.importActual('path'))
  vi.doMock('child_process', () => ({ execFile: vi.fn() }))
  vi.doMock('util', () => ({ promisify: () => mockExecFileAsync }))
  vi.doMock('../../shared/colony-paths', () => ({
    colonyPaths: {
      sessionArtifacts: MOCK_ARTIFACTS_PATH,
    },
  }))
  vi.doMock('../daemon-client', () => ({
    getDaemonClient: () => ({
      getInstance: mockGetInstance,
    }),
  }))
}

const MOCK_INSTANCE = {
  id: 'inst-1',
  name: 'Test Session',
  workingDirectory: '/repos/test',
  createdAt: new Date(Date.now() - 300_000).toISOString(), // 5 min ago
  exitCode: 0,
  tokenUsage: { input: 1000, output: 500, cost: 0.05 },
}

describe('session-artifacts', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  // ---- collectSessionArtifact ----

  it('collectSessionArtifact: returns null when instance not found', async () => {
    setupMocks()
    mockGetInstance.mockResolvedValue(null)
    const mod = await import('../session-artifacts')
    const result = await mod.collectSessionArtifact('nonexistent')
    expect(result).toBeNull()
  })

  it('collectSessionArtifact: returns null when no workingDirectory', async () => {
    setupMocks()
    mockGetInstance.mockResolvedValue({ ...MOCK_INSTANCE, workingDirectory: '' })
    const mod = await import('../session-artifacts')
    const result = await mod.collectSessionArtifact('inst-1')
    expect(result).toBeNull()
  })

  it('collectSessionArtifact: returns null when not a git repo', async () => {
    setupMocks()
    mockGetInstance.mockResolvedValue(MOCK_INSTANCE)
    // git rev-parse fails — not a git repo
    mockExecFileAsync.mockRejectedValue(new Error('not a git repo'))
    const mod = await import('../session-artifacts')
    const result = await mod.collectSessionArtifact('inst-1')
    expect(result).toBeNull()
  })

  it('collectSessionArtifact: returns null when no changes and no commits', async () => {
    setupMocks()
    mockGetInstance.mockResolvedValue(MOCK_INSTANCE)
    mockExecFileAsync
      .mockResolvedValueOnce({ stdout: '' }) // git rev-parse (isGitRepo)
      .mockResolvedValueOnce({ stdout: '' }) // git diff --numstat
      .mockResolvedValueOnce({ stdout: '' }) // git diff --name-status
      .mockResolvedValueOnce({ stdout: '' }) // git log (commits)
      .mockResolvedValueOnce({ stdout: '' }) // git rev-parse --abbrev-ref (branch)
      .mockResolvedValueOnce({ stdout: '' }) // git remote get-url (remote)
    const mod = await import('../session-artifacts')
    const result = await mod.collectSessionArtifact('inst-1')
    expect(result).toBeNull()
  })

  it('collectSessionArtifact: collects artifact with commits and changes', async () => {
    setupMocks()
    mockGetInstance.mockResolvedValue(MOCK_INSTANCE)
    mockExecFileAsync
      .mockResolvedValueOnce({ stdout: '' }) // git rev-parse (isGitRepo)
      .mockResolvedValueOnce({ stdout: '10\t2\tsrc/main.ts\n5\t0\tsrc/utils.ts\n' }) // git diff --numstat
      .mockResolvedValueOnce({ stdout: 'M\tsrc/main.ts\nA\tsrc/utils.ts\n' }) // git diff --name-status
      .mockResolvedValueOnce({ stdout: 'abc1234|feat: add feature\ndef5678|fix: bug fix\n' }) // git log
      .mockResolvedValueOnce({ stdout: 'feature-branch\n' }) // git rev-parse --abbrev-ref
      .mockResolvedValueOnce({ stdout: 'https://github.com/test/repo.git\n' }) // git remote get-url

    const mod = await import('../session-artifacts')
    const result = await mod.collectSessionArtifact('inst-1')

    expect(result).not.toBeNull()
    expect(result!.sessionId).toBe('inst-1')
    expect(result!.sessionName).toBe('Test Session')
    expect(result!.commits).toHaveLength(2)
    expect(result!.commits[0].hash).toBe('abc1234')
    expect(result!.commits[0].shortMsg).toBe('feat: add feature')
    expect(result!.changes).toHaveLength(2)
    expect(result!.changes[0].file).toBe('src/main.ts')
    expect(result!.changes[0].insertions).toBe(10)
    expect(result!.changes[0].status).toBe('M')
    expect(result!.changes[1].status).toBe('A')
    expect(result!.totalInsertions).toBe(15)
    expect(result!.totalDeletions).toBe(2)
    expect(result!.gitBranch).toBe('feature-branch')
    expect(result!.gitRepo).toBe('https://github.com/test/repo.git')
    expect(result!.costUsd).toBe(0.05)
    expect(result!.exitCode).toBe(0)

    // Verify it was persisted
    expect(mockFsp.writeFile).toHaveBeenCalledWith(
      MOCK_ARTIFACTS_PATH,
      expect.any(String),
      'utf-8'
    )
  })

  it('collectSessionArtifact: extracts persona name from session name', async () => {
    setupMocks()
    mockGetInstance.mockResolvedValue({
      ...MOCK_INSTANCE,
      name: 'Persona: Colony Developer',
    })
    mockExecFileAsync
      .mockResolvedValueOnce({ stdout: '' }) // isGitRepo
      .mockResolvedValueOnce({ stdout: '1\t0\ttest.ts\n' }) // numstat
      .mockResolvedValueOnce({ stdout: 'A\ttest.ts\n' }) // name-status
      .mockResolvedValueOnce({ stdout: '' }) // git log
      .mockResolvedValueOnce({ stdout: 'main\n' }) // branch
      .mockResolvedValueOnce({ stdout: '' }) // remote

    const mod = await import('../session-artifacts')
    const result = await mod.collectSessionArtifact('inst-1')

    expect(result!.personaName).toBe('Colony Developer')
  })

  it('collectSessionArtifact: caps at 200 artifacts', async () => {
    const existing = Array.from({ length: 200 }, (_, i) => ({
      sessionId: `old-${i}`,
      sessionName: `Old ${i}`,
      createdAt: new Date().toISOString(),
      sessionStartedAt: new Date().toISOString(),
      exitCode: 0,
      durationMs: 1000,
      workingDirectory: '/test',
      gitBranch: null,
      gitRepo: null,
      commits: [],
      changes: [],
      totalInsertions: 0,
      totalDeletions: 0,
    }))
    setupMocks(JSON.stringify(existing))
    mockGetInstance.mockResolvedValue(MOCK_INSTANCE)
    mockExecFileAsync
      .mockResolvedValueOnce({ stdout: '' }) // isGitRepo
      .mockResolvedValueOnce({ stdout: '1\t0\tnew.ts\n' }) // numstat
      .mockResolvedValueOnce({ stdout: 'A\tnew.ts\n' }) // name-status
      .mockResolvedValueOnce({ stdout: '' }) // git log
      .mockResolvedValueOnce({ stdout: '' }) // branch
      .mockResolvedValueOnce({ stdout: '' }) // remote

    const mod = await import('../session-artifacts')
    await mod.collectSessionArtifact('inst-1')

    const writeCall = mockFsp.writeFile.mock.calls[0]
    const written = JSON.parse(writeCall[1])
    expect(written).toHaveLength(200)
    // Oldest should be trimmed, newest should be present
    expect(written[written.length - 1].sessionId).toBe('inst-1')
    expect(written[0].sessionId).toBe('old-1') // old-0 was trimmed
  })

  // ---- listArtifacts ----

  it('listArtifacts: returns empty array when no file', async () => {
    setupMocks()
    const mod = await import('../session-artifacts')
    const result = await mod.listArtifacts()
    expect(result).toEqual([])
  })

  it('listArtifacts: returns artifacts in reverse order (newest first)', async () => {
    const artifacts = [
      { sessionId: 'a', createdAt: '2026-01-01' },
      { sessionId: 'b', createdAt: '2026-01-02' },
    ]
    setupMocks(JSON.stringify(artifacts))
    const mod = await import('../session-artifacts')
    const result = await mod.listArtifacts()
    expect(result).toHaveLength(2)
    expect(result[0].sessionId).toBe('b')
    expect(result[1].sessionId).toBe('a')
  })

  // ---- getArtifact ----

  it('getArtifact: returns null when session not found', async () => {
    setupMocks(JSON.stringify([{ sessionId: 'other' }]))
    const mod = await import('../session-artifacts')
    const result = await mod.getArtifact('missing')
    expect(result).toBeNull()
  })

  it('getArtifact: returns most recent artifact for session', async () => {
    const artifacts = [
      { sessionId: 'inst-1', createdAt: '2026-01-01', commits: [] },
      { sessionId: 'inst-1', createdAt: '2026-01-02', commits: [{ hash: 'abc', shortMsg: 'latest' }] },
    ]
    setupMocks(JSON.stringify(artifacts))
    const mod = await import('../session-artifacts')
    const result = await mod.getArtifact('inst-1')
    expect(result!.createdAt).toBe('2026-01-02')
    expect(result!.commits[0].shortMsg).toBe('latest')
  })

  // ---- clearArtifacts ----

  it('clearArtifacts: writes empty array', async () => {
    setupMocks(JSON.stringify([{ sessionId: 'a' }]))
    const mod = await import('../session-artifacts')
    await mod.clearArtifacts()
    expect(mockFsp.writeFile).toHaveBeenCalledWith(
      MOCK_ARTIFACTS_PATH,
      '[]',
      'utf-8'
    )
  })

  // ---- tagArtifactPipeline ----

  it('tagArtifactPipeline: tags an existing artifact', async () => {
    const artifacts = [
      { sessionId: 'inst-1', pipelineRunId: undefined },
    ]
    setupMocks(JSON.stringify(artifacts))
    const mod = await import('../session-artifacts')
    const result = await mod.tagArtifactPipeline('inst-1', 'pipeline-run-42')
    expect(result).toBe(true)

    const writeCall = mockFsp.writeFile.mock.calls[0]
    const written = JSON.parse(writeCall[1])
    expect(written[0].pipelineRunId).toBe('pipeline-run-42')
  })

  it('tagArtifactPipeline: returns false when session not found', async () => {
    setupMocks(JSON.stringify([{ sessionId: 'other' }]))
    const mod = await import('../session-artifacts')
    const result = await mod.tagArtifactPipeline('missing', 'pipeline-run-1')
    expect(result).toBe(false)
    expect(mockFsp.writeFile).not.toHaveBeenCalled()
  })

  // ---- Edge cases ----

  it('handles corrupt JSON in artifacts file', async () => {
    setupMocks('not valid json{{{')
    const mod = await import('../session-artifacts')
    const result = await mod.listArtifacts()
    expect(result).toEqual([])
  })

  it('handles non-array JSON in artifacts file', async () => {
    setupMocks(JSON.stringify({ wrong: 'shape' }))
    const mod = await import('../session-artifacts')
    const result = await mod.listArtifacts()
    expect(result).toEqual([])
  })

  it('collectSessionArtifact: handles git command failures gracefully', async () => {
    setupMocks()
    mockGetInstance.mockResolvedValue(MOCK_INSTANCE)
    mockExecFileAsync
      .mockResolvedValueOnce({ stdout: '' }) // isGitRepo succeeds
      .mockRejectedValueOnce(new Error('git diff failed')) // numstat fails
      .mockRejectedValueOnce(new Error('git diff failed')) // name-status fails
      .mockRejectedValueOnce(new Error('git log failed')) // commits fail
      .mockRejectedValueOnce(new Error('branch failed')) // branch fails
      .mockRejectedValueOnce(new Error('remote failed')) // remote fails

    const mod = await import('../session-artifacts')
    const result = await mod.collectSessionArtifact('inst-1')
    // All git ops failed → no changes, no commits → null
    expect(result).toBeNull()
  })
})
