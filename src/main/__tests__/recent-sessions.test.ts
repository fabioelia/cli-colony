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

// Mutable mock state for fs
const mockFs = {
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn().mockReturnValue('[]'),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  readdirSync: vi.fn().mockReturnValue([]),
  statSync: vi.fn(),
  unlinkSync: vi.fn(),
}

const mockExecSync = vi.fn()

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

    mockFs.existsSync.mockReset().mockReturnValue(false)
    mockFs.readFileSync.mockReset().mockReturnValue('[]')
    mockFs.writeFileSync.mockReset()
    mockFs.mkdirSync.mockReset()
    mockFs.readdirSync.mockReset().mockReturnValue([])
    mockFs.statSync.mockReset()
    mockFs.unlinkSync.mockReset()
    mockExecSync.mockReset()

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
      existsSync: mockFs.existsSync,
      readFileSync: mockFs.readFileSync,
      writeFileSync: mockFs.writeFileSync,
      mkdirSync: mockFs.mkdirSync,
      readdirSync: mockFs.readdirSync,
      statSync: mockFs.statSync,
      unlinkSync: mockFs.unlinkSync,
    }))

    vi.doMock('child_process', () => ({
      execSync: mockExecSync,
    }))

    mod = await import('../recent-sessions')
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  describe('getRecentSessions', () => {
    it('returns empty array when file does not exist', () => {
      mockFs.existsSync.mockReturnValue(false)
      expect(mod.getRecentSessions()).toEqual([])
    })

    it('returns parsed sessions from file', () => {
      const sessions = [makeSession()]
      mockFs.existsSync.mockReturnValue(true)
      mockFs.readFileSync.mockReturnValue(JSON.stringify(sessions))
      expect(mod.getRecentSessions()).toHaveLength(1)
      expect(mod.getRecentSessions()[0].instanceId).toBe('inst-001')
    })

    it('returns empty array when file is corrupted', () => {
      mockFs.existsSync.mockReturnValue(true)
      mockFs.readFileSync.mockReturnValue('{invalid json')
      expect(mod.getRecentSessions()).toEqual([])
    })
  })

  describe('trackOpened', () => {
    it('prepends a new session to the list', () => {
      mockFs.existsSync.mockReturnValue(false) // no existing file
      mod.trackOpened({
        instanceName: 'my-session',
        instanceId: 'inst-001',
        sessionId: 'sess-abc',
        workingDirectory: '/projects/app',
        color: '#00ff00',
        args: [],
      })
      const written = JSON.parse(mockFs.writeFileSync.mock.calls[0][1] as string) as RecentSession[]
      expect(written).toHaveLength(1)
      expect(written[0].instanceName).toBe('my-session')
      expect(written[0].exitType).toBe('running')
      expect(written[0].closedAt).toBeNull()
    })

    it('prepends to existing sessions (most recent first)', () => {
      const existing = [makeSession({ instanceId: 'old-inst', instanceName: 'old' })]
      mockFs.existsSync.mockReturnValue(true)
      mockFs.readFileSync.mockReturnValue(JSON.stringify(existing))
      mod.trackOpened({
        instanceName: 'new-session',
        instanceId: 'new-inst',
        sessionId: null,
        workingDirectory: '/projects/app',
        color: '#0000ff',
        args: [],
      })
      const written = JSON.parse(mockFs.writeFileSync.mock.calls[0][1] as string) as RecentSession[]
      expect(written[0].instanceName).toBe('new-session')
      expect(written[1].instanceName).toBe('old')
    })

    it('limits stored sessions to 50', () => {
      const existing = Array.from({ length: 50 }, (_, i) =>
        makeSession({ instanceId: `inst-${i}`, instanceName: `session-${i}` })
      )
      mockFs.existsSync.mockReturnValue(true)
      mockFs.readFileSync.mockReturnValue(JSON.stringify(existing))
      mod.trackOpened({
        instanceName: 'newest',
        instanceId: 'inst-new',
        sessionId: null,
        workingDirectory: '/projects/app',
        color: '#fff',
        args: [],
      })
      const written = JSON.parse(mockFs.writeFileSync.mock.calls[0][1] as string) as RecentSession[]
      expect(written).toHaveLength(50)
      expect(written[0].instanceName).toBe('newest')
    })
  })

  describe('trackClosed', () => {
    it('marks a running session as closed with exitType', () => {
      const sessions = [makeSession({ instanceId: 'inst-001', closedAt: null, exitType: 'running', sessionId: 'sess-abc' })]
      mockFs.existsSync.mockReturnValue(true)
      mockFs.readFileSync.mockReturnValue(JSON.stringify(sessions))
      mod.trackClosed('inst-001', 'exited')
      const written = JSON.parse(mockFs.writeFileSync.mock.calls[0][1] as string) as RecentSession[]
      expect(written[0].exitType).toBe('exited')
      expect(written[0].closedAt).not.toBeNull()
    })

    it('does not close a session that is already closed', () => {
      const closedAt = new Date().toISOString()
      const sessions = [makeSession({ instanceId: 'inst-001', closedAt, exitType: 'exited' })]
      mockFs.existsSync.mockReturnValue(true)
      mockFs.readFileSync.mockReturnValue(JSON.stringify(sessions))
      mod.trackClosed('inst-001', 'killed')
      // writeFileSync should not have been called (no match)
      expect(mockFs.writeFileSync).not.toHaveBeenCalled()
    })

    it('ignores unknown instance IDs', () => {
      const sessions = [makeSession({ instanceId: 'inst-001' })]
      mockFs.existsSync.mockReturnValue(true)
      mockFs.readFileSync.mockReturnValue(JSON.stringify(sessions))
      mod.trackClosed('inst-999', 'exited')
      expect(mockFs.writeFileSync).not.toHaveBeenCalled()
    })
  })

  describe('updateSessionId', () => {
    it('updates sessionId for matching instance with null sessionId', () => {
      const sessions = [makeSession({ instanceId: 'inst-001', sessionId: null })]
      mockFs.existsSync.mockReturnValue(true)
      mockFs.readFileSync.mockReturnValue(JSON.stringify(sessions))
      mod.updateSessionId('inst-001', 'newly-discovered-id')
      const written = JSON.parse(mockFs.writeFileSync.mock.calls[0][1] as string) as RecentSession[]
      expect(written[0].sessionId).toBe('newly-discovered-id')
    })

    it('does not overwrite an already-set sessionId', () => {
      const sessions = [makeSession({ instanceId: 'inst-001', sessionId: 'existing-sess' })]
      mockFs.existsSync.mockReturnValue(true)
      mockFs.readFileSync.mockReturnValue(JSON.stringify(sessions))
      mod.updateSessionId('inst-001', 'new-sess')
      // Should not have written (no match because sessionId was already set)
      expect(mockFs.writeFileSync).not.toHaveBeenCalled()
    })
  })

  describe('snapshotRunning', () => {
    it('does nothing when there are no running sessions', () => {
      const sessions = [makeSession({ closedAt: new Date().toISOString(), exitType: 'exited' })]
      mockFs.existsSync.mockReturnValue(true)
      mockFs.readFileSync.mockReturnValue(JSON.stringify(sessions))
      mod.snapshotRunning()
      expect(mockFs.writeFileSync).not.toHaveBeenCalled()
    })

    it('does nothing when running sessions have no sessionId', () => {
      const sessions = [makeSession({ closedAt: null, exitType: 'running', sessionId: null })]
      mockFs.existsSync.mockReturnValue(true)
      mockFs.readFileSync.mockReturnValue(JSON.stringify(sessions))
      mod.snapshotRunning()
      expect(mockFs.writeFileSync).not.toHaveBeenCalled()
    })

    it('writes running sessions with sessionIds to snapshot file', () => {
      const sessions = [
        makeSession({ instanceId: 'inst-001', sessionId: 'sess-1', closedAt: null, exitType: 'running' }),
        makeSession({ instanceId: 'inst-002', sessionId: null, closedAt: null, exitType: 'running' }),
      ]
      mockFs.existsSync.mockReturnValue(true)
      mockFs.readFileSync.mockReturnValue(JSON.stringify(sessions))
      mod.snapshotRunning()
      // Should write only the session with a sessionId
      const snapshot = JSON.parse(mockFs.writeFileSync.mock.calls[0][1] as string) as RecentSession[]
      expect(snapshot).toHaveLength(1)
      expect(snapshot[0].sessionId).toBe('sess-1')
    })

    it('deduplicates by sessionId, keeping the most recent openedAt', () => {
      const older = makeSession({ instanceId: 'inst-001', sessionId: 'sess-dup', openedAt: '2026-01-01T00:00:00.000Z', closedAt: null, exitType: 'running' })
      const newer = makeSession({ instanceId: 'inst-002', sessionId: 'sess-dup', openedAt: '2026-01-02T00:00:00.000Z', closedAt: null, exitType: 'running' })
      mockFs.existsSync.mockReturnValue(true)
      mockFs.readFileSync.mockReturnValue(JSON.stringify([older, newer]))
      mod.snapshotRunning()
      const snapshot = JSON.parse(mockFs.writeFileSync.mock.calls[0][1] as string) as RecentSession[]
      expect(snapshot).toHaveLength(1)
      expect(snapshot[0].instanceId).toBe('inst-002') // the newer one
    })
  })

  describe('getRestorableSessions', () => {
    it('returns empty array when snapshot file does not exist', () => {
      mockFs.existsSync.mockImplementation((p) => p !== MOCK_SNAPSHOT_FILE)
      expect(mod.getRestorableSessions()).toEqual([])
    })

    it('returns sessions from snapshot file', () => {
      const snapshot = [makeSession({ sessionId: 'sess-restore' })]
      mockFs.existsSync.mockImplementation((p) => p === MOCK_SNAPSHOT_FILE)
      mockFs.readFileSync.mockReturnValue(JSON.stringify(snapshot))
      const result = mod.getRestorableSessions()
      expect(result).toHaveLength(1)
      expect(result[0].sessionId).toBe('sess-restore')
    })

    it('excludes sessions already running in the daemon', () => {
      const snapshot = [
        makeSession({ sessionId: 'sess-already-running' }),
        makeSession({ instanceId: 'inst-002', sessionId: 'sess-to-restore' }),
      ]
      mockFs.existsSync.mockImplementation((p) => p === MOCK_SNAPSHOT_FILE)
      mockFs.readFileSync.mockReturnValue(JSON.stringify(snapshot))
      const result = mod.getRestorableSessions(new Set(['sess-already-running']))
      expect(result).toHaveLength(1)
      expect(result[0].sessionId).toBe('sess-to-restore')
    })

    it('excludes sessions with null sessionId', () => {
      const snapshot = [makeSession({ sessionId: null })]
      mockFs.existsSync.mockImplementation((p) => p === MOCK_SNAPSHOT_FILE)
      mockFs.readFileSync.mockReturnValue(JSON.stringify(snapshot))
      const result = mod.getRestorableSessions()
      expect(result).toHaveLength(0)
    })

    it('returns empty array on corrupt snapshot file', () => {
      mockFs.existsSync.mockImplementation((p) => p === MOCK_SNAPSHOT_FILE)
      mockFs.readFileSync.mockReturnValue('{bad json}')
      expect(mod.getRestorableSessions()).toEqual([])
    })
  })

  describe('clearRestorable', () => {
    it('deletes snapshot file if it exists', () => {
      mockFs.existsSync.mockImplementation((p) => p === MOCK_SNAPSHOT_FILE)
      mockFs.readFileSync.mockReturnValue('[]') // main sessions file is empty
      mod.clearRestorable()
      expect(mockFs.unlinkSync).toHaveBeenCalledWith(MOCK_SNAPSHOT_FILE)
    })

    it('does not throw when snapshot file does not exist', () => {
      mockFs.existsSync.mockReturnValue(false)
      mockFs.readFileSync.mockReturnValue('[]')
      expect(() => mod.clearRestorable()).not.toThrow()
    })

    it('marks running sessions as exited', () => {
      const sessions = [
        makeSession({ instanceId: 'inst-001', closedAt: null, exitType: 'running' }),
        makeSession({ instanceId: 'inst-002', closedAt: new Date().toISOString(), exitType: 'exited' }),
      ]
      mockFs.existsSync.mockImplementation((p) => p === MOCK_SESSIONS_FILE)
      mockFs.readFileSync.mockImplementation((p) => {
        if (p === MOCK_SESSIONS_FILE) return JSON.stringify(sessions)
        return '[]'
      })
      mod.clearRestorable()
      const written = JSON.parse(mockFs.writeFileSync.mock.calls[0][1] as string) as RecentSession[]
      const inst1 = written.find((s) => s.instanceId === 'inst-001')
      expect(inst1?.exitType).toBe('exited')
      expect(inst1?.closedAt).not.toBeNull()
    })
  })

  describe('discoverSessionId', () => {
    it('returns session ID found via lsof', () => {
      const uuid = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'
      mockExecSync.mockReturnValue(
        `node  123  user  txt  /home/user/.claude/projects/-Users-app/${uuid}.jsonl\n`
      )
      const result = mod.discoverSessionId(123, '/Users/app')
      expect(result).toBe(uuid)
    })

    it('skips lsof when pid is null', () => {
      mockExecSync.mockReturnValue('some output')
      // With null pid and no claude project dirs, returns null
      const result = mod.discoverSessionId(null, '/projects/app')
      expect(mockExecSync).not.toHaveBeenCalled()
      expect(result).toBeNull()
    })

    it('returns null when lsof finds no matching jsonl', () => {
      mockExecSync.mockReturnValue('no jsonl files here')
      // No project dir either
      mockFs.existsSync.mockReturnValue(false)
      const result = mod.discoverSessionId(999, '/projects/app')
      expect(result).toBeNull()
    })

    it('falls back to filesystem scan when lsof finds nothing', () => {
      const uuid = 'b2c3d4e5-f6a7-8901-bcde-f12345678901'
      const now = Date.now()

      // lsof returns nothing useful
      mockExecSync.mockReturnValue('')

      const projectDir = '/mock/home/.claude/projects/-projects-myapp'
      mockFs.existsSync.mockImplementation((p) => p === projectDir)
      mockFs.readdirSync.mockReturnValue([`${uuid}.jsonl`] as unknown as ReturnType<typeof mockFs.readdirSync>)
      mockFs.statSync.mockReturnValue({ mtimeMs: now - 5000 } as ReturnType<typeof mockFs.statSync>) // 5s old, within 60s window

      const result = mod.discoverSessionId(123, '/projects/myapp')
      expect(result).toBe(uuid)
    })

    it('returns null when filesystem file is too old', () => {
      const uuid = 'c3d4e5f6-a7b8-9012-cdef-123456789012'
      const old = Date.now() - 120_000 // 2 minutes old

      mockExecSync.mockReturnValue('')
      const projectDir = '/mock/home/.claude/projects/-projects-stale'
      mockFs.existsSync.mockImplementation((p) => p === projectDir)
      mockFs.readdirSync.mockReturnValue([`${uuid}.jsonl`] as unknown as ReturnType<typeof mockFs.readdirSync>)
      mockFs.statSync.mockReturnValue({ mtimeMs: old } as ReturnType<typeof mockFs.statSync>)

      const result = mod.discoverSessionId(null, '/projects/stale', 60_000)
      expect(result).toBeNull()
    })
  })
})
