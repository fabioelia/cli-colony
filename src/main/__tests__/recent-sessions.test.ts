/**
 * Tests for src/main/recent-sessions.ts
 *
 * Uses vi.resetModules() + vi.doMock() + dynamic import per describe-block
 * to isolate the in-memory load() state between test groups.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { RecentSession } from '../recent-sessions'

const MOCK_ROOT = '/mock/.claude-colony'
const MOCK_SESSIONS_FILE = `${MOCK_ROOT}/recent-sessions.json`
const MOCK_SNAPSHOT_FILE = `${MOCK_ROOT}/restore-snapshot.json`

// Mutable mock state for fs.promises
const mockFsp = {
  readFile: vi.fn().mockResolvedValue('[]'),
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
  readdir: vi.fn().mockResolvedValue([]),
  stat: vi.fn().mockResolvedValue({ isDirectory: () => true, mtimeMs: Date.now() }),
  unlink: vi.fn().mockResolvedValue(undefined),
}

// Sync mocks for snapshotRunningSync
const mockReadFileSync = vi.fn().mockReturnValue('[]')
const mockWriteFileSync = vi.fn()
const mockMkdirSync = vi.fn()

const mockExecFile = vi.fn()

function makeSession(overrides: Partial<RecentSession> = {}): RecentSession {
  return {
    instanceName: 'test-session',
    instanceId: 'inst-001',
    sessionId: 'sess-abc',
    workingDirectory: '/projects/myapp',
    color: '#ff0000',
    args: [],
    openedAt: new Date().toISOString(),
    closedAt: null,
    exitType: 'running',
    ...overrides,
  }
}

describe('recent-sessions', () => {
  let mod: typeof import('../recent-sessions')

  beforeEach(async () => {
    vi.resetModules()

    mockFsp.readFile.mockReset().mockResolvedValue('[]')
    mockFsp.writeFile.mockReset().mockResolvedValue(undefined)
    mockFsp.mkdir.mockReset().mockResolvedValue(undefined)
    mockFsp.readdir.mockReset().mockResolvedValue([])
    mockFsp.stat.mockReset().mockResolvedValue({ isDirectory: () => true, mtimeMs: Date.now() })
    mockFsp.unlink.mockReset().mockResolvedValue(undefined)
    mockReadFileSync.mockReset().mockReturnValue('[]')
    mockWriteFileSync.mockReset()
    mockMkdirSync.mockReset()
    mockExecFile.mockReset()

    vi.doMock('electron', () => ({
      app: { getPath: vi.fn().mockReturnValue('/mock/home') },
    }))

    vi.doMock('../../shared/colony-paths', () => ({
      colonyPaths: {
        root: MOCK_ROOT,
        recentSessions: MOCK_SESSIONS_FILE,
      },
    }))

    vi.doMock('fs', () => ({
      promises: mockFsp,
      readFileSync: mockReadFileSync,
      writeFileSync: mockWriteFileSync,
      mkdirSync: mockMkdirSync,
    }))

    vi.doMock('child_process', () => ({
      execFile: mockExecFile,
    }))

    mod = await import('../recent-sessions')
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  describe('getRecentSessions', () => {
    it('returns empty array when file does not exist', async () => {
      mockFsp.readFile.mockRejectedValue(new Error('ENOENT'))
      expect(await mod.getRecentSessions()).toEqual([])
    })

    it('returns parsed sessions from file', async () => {
      const sessions = [makeSession()]
      mockFsp.readFile.mockResolvedValue(JSON.stringify(sessions))
      const result = await mod.getRecentSessions()
      expect(result).toHaveLength(1)
      expect(result[0].instanceId).toBe('inst-001')
    })

    it('returns empty array when file is corrupted', async () => {
      mockFsp.readFile.mockResolvedValue('{invalid json')
      expect(await mod.getRecentSessions()).toEqual([])
    })
  })

  describe('trackOpened', () => {
    it('prepends a new session to the list', async () => {
      mockFsp.readFile.mockRejectedValue(new Error('ENOENT')) // no existing file
      await mod.trackOpened({
        instanceName: 'my-session',
        instanceId: 'inst-001',
        sessionId: 'sess-abc',
        workingDirectory: '/projects/app',
        color: '#00ff00',
        args: [],
      })
      const written = JSON.parse(mockFsp.writeFile.mock.calls[0][1] as string) as RecentSession[]
      expect(written).toHaveLength(1)
      expect(written[0].instanceName).toBe('my-session')
      expect(written[0].exitType).toBe('running')
      expect(written[0].closedAt).toBeNull()
    })

    it('prepends to existing sessions (most recent first)', async () => {
      const existing = [makeSession({ instanceId: 'old-inst', instanceName: 'old' })]
      mockFsp.readFile.mockResolvedValue(JSON.stringify(existing))
      await mod.trackOpened({
        instanceName: 'new-session',
        instanceId: 'new-inst',
        sessionId: null,
        workingDirectory: '/projects/app',
        color: '#0000ff',
        args: [],
      })
      const written = JSON.parse(mockFsp.writeFile.mock.calls[0][1] as string) as RecentSession[]
      expect(written[0].instanceName).toBe('new-session')
      expect(written[1].instanceName).toBe('old')
    })

    it('limits stored sessions to 50', async () => {
      const existing = Array.from({ length: 50 }, (_, i) =>
        makeSession({ instanceId: `inst-${i}`, instanceName: `session-${i}` })
      )
      mockFsp.readFile.mockResolvedValue(JSON.stringify(existing))
      await mod.trackOpened({
        instanceName: 'newest',
        instanceId: 'inst-new',
        sessionId: null,
        workingDirectory: '/projects/app',
        color: '#fff',
        args: [],
      })
      const written = JSON.parse(mockFsp.writeFile.mock.calls[0][1] as string) as RecentSession[]
      expect(written).toHaveLength(50)
      expect(written[0].instanceName).toBe('newest')
    })
  })

  describe('trackClosed', () => {
    it('marks a running session as closed with exitType', async () => {
      const sessions = [makeSession({ instanceId: 'inst-001', closedAt: null, exitType: 'running', sessionId: 'sess-abc' })]
      mockFsp.readFile.mockResolvedValue(JSON.stringify(sessions))
      await mod.trackClosed('inst-001', 'exited')
      const written = JSON.parse(mockFsp.writeFile.mock.calls[0][1] as string) as RecentSession[]
      expect(written[0].exitType).toBe('exited')
      expect(written[0].closedAt).not.toBeNull()
    })

    it('does not close a session that is already closed', async () => {
      const closedAt = new Date().toISOString()
      const sessions = [makeSession({ instanceId: 'inst-001', closedAt, exitType: 'exited' })]
      mockFsp.readFile.mockResolvedValue(JSON.stringify(sessions))
      await mod.trackClosed('inst-001', 'killed')
      // writeFile should not have been called (no match)
      expect(mockFsp.writeFile).not.toHaveBeenCalled()
    })

    it('ignores unknown instance IDs', async () => {
      const sessions = [makeSession({ instanceId: 'inst-001' })]
      mockFsp.readFile.mockResolvedValue(JSON.stringify(sessions))
      await mod.trackClosed('inst-999', 'exited')
      expect(mockFsp.writeFile).not.toHaveBeenCalled()
    })
  })

  describe('updateSessionId', () => {
    it('updates sessionId for matching instance with null sessionId', async () => {
      const sessions = [makeSession({ instanceId: 'inst-001', sessionId: null })]
      mockFsp.readFile.mockResolvedValue(JSON.stringify(sessions))
      await mod.updateSessionId('inst-001', 'newly-discovered-id')
      const written = JSON.parse(mockFsp.writeFile.mock.calls[0][1] as string) as RecentSession[]
      expect(written[0].sessionId).toBe('newly-discovered-id')
    })

    it('does not overwrite an already-set sessionId', async () => {
      const sessions = [makeSession({ instanceId: 'inst-001', sessionId: 'existing-sess' })]
      mockFsp.readFile.mockResolvedValue(JSON.stringify(sessions))
      await mod.updateSessionId('inst-001', 'new-sess')
      // Should not have written (no match because sessionId was already set)
      expect(mockFsp.writeFile).not.toHaveBeenCalled()
    })
  })

  describe('snapshotRunning', () => {
    it('does nothing when there are no running sessions', async () => {
      const sessions = [makeSession({ closedAt: new Date().toISOString(), exitType: 'exited' })]
      mockFsp.readFile.mockResolvedValue(JSON.stringify(sessions))
      await mod.snapshotRunning()
      expect(mockFsp.writeFile).not.toHaveBeenCalled()
    })

    it('does nothing when running sessions have no sessionId', async () => {
      const sessions = [makeSession({ closedAt: null, exitType: 'running', sessionId: null })]
      mockFsp.readFile.mockResolvedValue(JSON.stringify(sessions))
      await mod.snapshotRunning()
      expect(mockFsp.writeFile).not.toHaveBeenCalled()
    })

    it('writes running sessions with sessionIds to snapshot file', async () => {
      const sessions = [
        makeSession({ instanceId: 'inst-001', sessionId: 'sess-1', closedAt: null, exitType: 'running' }),
        makeSession({ instanceId: 'inst-002', sessionId: null, closedAt: null, exitType: 'running' }),
      ]
      mockFsp.readFile.mockResolvedValue(JSON.stringify(sessions))
      await mod.snapshotRunning()
      // Should write only the session with a sessionId
      const snapshot = JSON.parse(mockFsp.writeFile.mock.calls[0][1] as string) as RecentSession[]
      expect(snapshot).toHaveLength(1)
      expect(snapshot[0].sessionId).toBe('sess-1')
    })

    it('deduplicates by sessionId, keeping the most recent openedAt', async () => {
      const older = makeSession({ instanceId: 'inst-001', sessionId: 'sess-dup', openedAt: '2026-01-01T00:00:00.000Z', closedAt: null, exitType: 'running' })
      const newer = makeSession({ instanceId: 'inst-002', sessionId: 'sess-dup', openedAt: '2026-01-02T00:00:00.000Z', closedAt: null, exitType: 'running' })
      mockFsp.readFile.mockResolvedValue(JSON.stringify([older, newer]))
      await mod.snapshotRunning()
      const snapshot = JSON.parse(mockFsp.writeFile.mock.calls[0][1] as string) as RecentSession[]
      expect(snapshot).toHaveLength(1)
      expect(snapshot[0].instanceId).toBe('inst-002') // the newer one
    })
  })

  describe('getRestorableSessions', () => {
    it('returns empty array when snapshot file does not exist', async () => {
      mockFsp.readFile.mockRejectedValue(new Error('ENOENT'))
      expect(await mod.getRestorableSessions()).toEqual([])
    })

    it('returns sessions from snapshot file', async () => {
      const snapshot = [makeSession({ sessionId: 'sess-restore' })]
      mockFsp.readFile.mockResolvedValue(JSON.stringify(snapshot))
      const result = await mod.getRestorableSessions()
      expect(result).toHaveLength(1)
      expect(result[0].sessionId).toBe('sess-restore')
    })

    it('excludes sessions already running in the daemon', async () => {
      const snapshot = [
        makeSession({ sessionId: 'sess-already-running' }),
        makeSession({ instanceId: 'inst-002', sessionId: 'sess-to-restore' }),
      ]
      mockFsp.readFile.mockResolvedValue(JSON.stringify(snapshot))
      const result = await mod.getRestorableSessions(new Set(['sess-already-running']))
      expect(result).toHaveLength(1)
      expect(result[0].sessionId).toBe('sess-to-restore')
    })

    it('excludes sessions with null sessionId', async () => {
      const snapshot = [makeSession({ sessionId: null })]
      mockFsp.readFile.mockResolvedValue(JSON.stringify(snapshot))
      const result = await mod.getRestorableSessions()
      expect(result).toHaveLength(0)
    })

    it('returns empty array on corrupt snapshot file', async () => {
      mockFsp.readFile.mockResolvedValue('{bad json}')
      // The production code catches the JSON.parse error
      expect(await mod.getRestorableSessions()).toEqual([])
    })
  })

  describe('clearRestorable', () => {
    it('deletes snapshot file', async () => {
      // load() for main sessions returns empty
      mockFsp.readFile.mockResolvedValue('[]')
      await mod.clearRestorable()
      expect(mockFsp.unlink).toHaveBeenCalled()
    })

    it('does not throw when snapshot file does not exist', async () => {
      mockFsp.unlink.mockRejectedValue(new Error('ENOENT'))
      mockFsp.readFile.mockResolvedValue('[]')
      await expect(mod.clearRestorable()).resolves.not.toThrow()
    })

    it('marks running sessions as exited', async () => {
      const sessions = [
        makeSession({ instanceId: 'inst-001', closedAt: null, exitType: 'running' }),
        makeSession({ instanceId: 'inst-002', closedAt: new Date().toISOString(), exitType: 'exited' }),
      ]
      mockFsp.readFile.mockResolvedValue(JSON.stringify(sessions))
      await mod.clearRestorable()
      // writeFile is called for saving the sessions (after the unlink call)
      const writeCall = mockFsp.writeFile.mock.calls.find((c: any[]) => {
        try { JSON.parse(c[1] as string); return true } catch { return false }
      })
      expect(writeCall).toBeDefined()
      const written = JSON.parse(writeCall![1] as string) as RecentSession[]
      const inst1 = written.find((s) => s.instanceId === 'inst-001')
      expect(inst1?.exitType).toBe('exited')
      expect(inst1?.closedAt).not.toBeNull()
    })
  })

  describe('discoverSessionId', () => {
    it('returns session ID found via lsof', async () => {
      const uuid = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'
      mockExecFile.mockImplementation((cmd: string, args: string[], opts: any, cb: Function) => {
        cb(null, `node  123  user  txt  /home/user/.claude/projects/-Users-app/${uuid}.jsonl\n`, '')
      })
      const result = await mod.discoverSessionId(123, '/Users/app')
      expect(result).toBe(uuid)
    })

    it('skips lsof when pid is null', async () => {
      // With null pid and no claude project dirs, returns null
      mockFsp.stat.mockRejectedValue(new Error('ENOENT'))
      mockFsp.readdir.mockRejectedValue(new Error('ENOENT'))
      const result = await mod.discoverSessionId(null, '/projects/app')
      expect(mockExecFile).not.toHaveBeenCalled()
      expect(result).toBeNull()
    })

    it('returns null when lsof finds no matching jsonl', async () => {
      mockExecFile.mockImplementation((cmd: string, args: string[], opts: any, cb: Function) => {
        cb(null, 'no jsonl files here', '')
      })
      // No project dir either
      mockFsp.stat.mockRejectedValue(new Error('ENOENT'))
      mockFsp.readdir.mockRejectedValue(new Error('ENOENT'))
      const result = await mod.discoverSessionId(999, '/projects/app')
      expect(result).toBeNull()
    })

    it('falls back to filesystem scan when lsof finds nothing', async () => {
      const uuid = 'b2c3d4e5-f6a7-8901-bcde-f12345678901'
      const now = Date.now()

      // lsof returns nothing useful
      mockExecFile.mockImplementation((cmd: string, args: string[], opts: any, cb: Function) => {
        cb(null, '', '')
      })

      const projectDir = '/mock/home/.claude/projects/-projects-myapp'
      // stat for projectDir succeeds (isDirectory)
      mockFsp.stat.mockImplementation(async (p: string) => {
        if (p === projectDir) return { isDirectory: () => true }
        if (p.endsWith(`${uuid}.jsonl`)) return { mtimeMs: now - 5000 }
        throw new Error('ENOENT')
      })
      mockFsp.readdir.mockResolvedValue([`${uuid}.jsonl`])

      const result = await mod.discoverSessionId(123, '/projects/myapp')
      expect(result).toBe(uuid)
    })

    it('returns null when filesystem file is too old', async () => {
      const uuid = 'c3d4e5f6-a7b8-9012-cdef-123456789012'
      const old = Date.now() - 120_000 // 2 minutes old

      mockExecFile.mockImplementation((cmd: string, args: string[], opts: any, cb: Function) => {
        cb(new Error('no lsof'), '', '')
      })

      const projectDir = '/mock/home/.claude/projects/-projects-stale'
      mockFsp.stat.mockImplementation(async (p: string) => {
        if (p === projectDir) return { isDirectory: () => true }
        if (p.endsWith(`${uuid}.jsonl`)) return { mtimeMs: old }
        throw new Error('ENOENT')
      })
      mockFsp.readdir.mockResolvedValue([`${uuid}.jsonl`])

      const result = await mod.discoverSessionId(null, '/projects/stale', 60_000)
      expect(result).toBeNull()
    })
  })
})
