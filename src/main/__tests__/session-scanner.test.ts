/**
 * Tests for src/main/session-scanner.ts
 *
 * Covers: scanSessions() JSONL parsing logic and readSessionMessages() extraction logic.
 * scanExternalSessions() and takeoverSession() are skipped (execSync/process.kill).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockFs = {
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  readdirSync: vi.fn(),
  statSync: vi.fn(),
  openSync: vi.fn(),
  readSync: vi.fn(),
  closeSync: vi.fn(),
  createReadStream: vi.fn(),
}

const mockGetRecentSessions = vi.fn()
const mockGetAllInstances = vi.fn()

describe('session-scanner', () => {
  let mod: typeof import('../session-scanner')

  beforeEach(async () => {
    vi.resetModules()

    for (const fn of Object.values(mockFs)) fn.mockReset()
    mockGetRecentSessions.mockReset().mockReturnValue([])
    mockGetAllInstances.mockReset().mockResolvedValue([])

    vi.doMock('electron', () => ({
      app: { getPath: vi.fn().mockReturnValue('/mock/home') },
    }))

    vi.doMock('fs', () => ({
      ...mockFs,
      default: mockFs,
    }))

    vi.doMock('child_process', () => ({ execSync: vi.fn() }))
    vi.doMock('readline', () => ({ createInterface: vi.fn() }))

    vi.doMock('../recent-sessions', () => ({
      getRecentSessions: mockGetRecentSessions,
      discoverSessionId: vi.fn().mockReturnValue(null),
    }))

    vi.doMock('../instance-manager', () => ({
      getAllInstances: mockGetAllInstances,
    }))

    mod = await import('../session-scanner')
  })

  // ─── scanSessions ───────────────────────────────────────────────────────────

  describe('scanSessions', () => {
    it('returns [] when history.jsonl does not exist', () => {
      mockFs.existsSync.mockReturnValue(false)
      expect(mod.scanSessions()).toEqual([])
    })

    it('returns [] on readFileSync error', () => {
      mockFs.existsSync.mockReturnValue(true)
      mockFs.readFileSync.mockImplementation(() => { throw new Error('ENOENT') })
      expect(mod.scanSessions()).toEqual([])
    })

    it('returns [] when history.jsonl is empty', () => {
      mockFs.existsSync.mockReturnValue(true)
      mockFs.readFileSync.mockImplementation((path: string) => {
        if (path === '/mock/home/.claude/history.jsonl') return ''
        return '[]'
      })
      mockFs.readdirSync.mockReturnValue([])
      expect(mod.scanSessions()).toEqual([])
    })

    it('parses a single session from history.jsonl', () => {
      const entry = JSON.stringify({ sessionId: 'sess-1', display: 'hello world', project: '/home/user/myapp', timestamp: 1000 })
      mockFs.existsSync.mockReturnValue(true)
      mockFs.readFileSync.mockImplementation((path: string) => {
        if (path === '/mock/home/.claude/history.jsonl') return entry
        return ''
      })
      mockFs.readdirSync.mockReturnValue([])

      const result = mod.scanSessions()
      expect(result).toHaveLength(1)
      expect(result[0].sessionId).toBe('sess-1')
      expect(result[0].display).toBe('hello world')
      expect(result[0].project).toBe('/home/user/myapp')
      expect(result[0].projectName).toBe('myapp')
      expect(result[0].timestamp).toBe(1000)
      expect(result[0].messageCount).toBe(1)
      expect(result[0].name).toBeNull()
    })

    it('deduplicates entries for the same sessionId', () => {
      const e1 = JSON.stringify({ sessionId: 'sess-1', display: 'first msg', project: '/p', timestamp: 1000 })
      const e2 = JSON.stringify({ sessionId: 'sess-1', display: 'second msg', project: '/p', timestamp: 2000 })
      const content = [e1, e2].join('\n')

      mockFs.existsSync.mockReturnValue(true)
      mockFs.readFileSync.mockImplementation((path: string) => {
        if (path === '/mock/home/.claude/history.jsonl') return content
        return ''
      })
      mockFs.readdirSync.mockReturnValue([])

      const result = mod.scanSessions()
      expect(result).toHaveLength(1)
      expect(result[0].messageCount).toBe(2)
      expect(result[0].display).toBe('first msg')
      expect(result[0].lastMessage).toBe('second msg')
      expect(result[0].timestamp).toBe(2000)
    })

    it('sets lastMessage to null when only one message exists', () => {
      const entry = JSON.stringify({ sessionId: 'sess-1', display: 'only msg', project: '/p', timestamp: 1000 })
      mockFs.existsSync.mockReturnValue(true)
      mockFs.readFileSync.mockImplementation((path: string) => {
        if (path === '/mock/home/.claude/history.jsonl') return entry
        return ''
      })
      mockFs.readdirSync.mockReturnValue([])

      const result = mod.scanSessions()
      expect(result[0].lastMessage).toBeNull()
    })

    it('extracts name from /rename command', () => {
      const e1 = JSON.stringify({ sessionId: 'sess-1', display: 'hello', project: '/p', timestamp: 1000 })
      const e2 = JSON.stringify({ sessionId: 'sess-1', display: '/rename My Project', project: '/p', timestamp: 2000 })
      const content = [e1, e2].join('\n')

      mockFs.existsSync.mockReturnValue(true)
      mockFs.readFileSync.mockImplementation((path: string) => {
        if (path === '/mock/home/.claude/history.jsonl') return content
        return ''
      })
      mockFs.readdirSync.mockReturnValue([])

      const result = mod.scanSessions()
      expect(result[0].name).toBe('My Project')
    })

    it('/rename overrides customTitle from --name', () => {
      // history.jsonl has /rename
      const e1 = JSON.stringify({ sessionId: 'sess-1', display: 'hello', project: '/p', timestamp: 1000 })
      const e2 = JSON.stringify({ sessionId: 'sess-1', display: '/rename Renamed', project: '/p', timestamp: 2000 })
      const histContent = [e1, e2].join('\n')

      // project dir has customTitle
      const sessionJsonl = JSON.stringify({ type: 'custom-title', customTitle: 'Named Title', sessionId: 'sess-1' })

      mockFs.existsSync.mockReturnValue(true)
      mockFs.readFileSync.mockImplementation((path: string) => {
        if (path === '/mock/home/.claude/history.jsonl') return histContent
        if (path.endsWith('.jsonl')) return sessionJsonl
        return ''
      })
      mockFs.readdirSync.mockImplementation((dir: string) => {
        if (dir === '/mock/home/.claude/projects') return ['proj-dir']
        if (dir.endsWith('proj-dir')) return ['sess-1.jsonl']
        return []
      })

      const result = mod.scanSessions()
      expect(result[0].name).toBe('Renamed')
    })

    it('uses customTitle when no /rename present', () => {
      const histEntry = JSON.stringify({ sessionId: 'sess-1', display: 'hello', project: '/p', timestamp: 1000 })
      const sessionJsonl = JSON.stringify({ type: 'custom-title', customTitle: 'Named Title', sessionId: 'sess-1' })

      mockFs.existsSync.mockReturnValue(true)
      mockFs.readFileSync.mockImplementation((path: string) => {
        if (path === '/mock/home/.claude/history.jsonl') return histEntry
        if (path.endsWith('.jsonl')) return sessionJsonl
        return ''
      })
      mockFs.readdirSync.mockImplementation((dir: string) => {
        if (dir === '/mock/home/.claude/projects') return ['proj-dir']
        if (dir.endsWith('proj-dir')) return ['sess-1.jsonl']
        return []
      })

      const result = mod.scanSessions()
      expect(result[0].name).toBe('Named Title')
    })

    it('sets recentlyOpened for sessions in getRecentSessions', () => {
      const entry = JSON.stringify({ sessionId: 'sess-1', display: 'hello', project: '/p', timestamp: 1000 })
      mockGetRecentSessions.mockReturnValue([{ sessionId: 'sess-1', instanceName: 'test', instanceId: 'i1', workingDirectory: '/p', color: '#f00', args: [], openedAt: '', closedAt: null, exitType: 'running' }])

      mockFs.existsSync.mockReturnValue(true)
      mockFs.readFileSync.mockImplementation((path: string) => {
        if (path === '/mock/home/.claude/history.jsonl') return entry
        return ''
      })
      mockFs.readdirSync.mockReturnValue([])

      const result = mod.scanSessions()
      expect(result[0].recentlyOpened).toBe(true)
    })

    it('sorts sessions by timestamp descending', () => {
      const e1 = JSON.stringify({ sessionId: 'sess-a', display: 'older', project: '/p', timestamp: 1000 })
      const e2 = JSON.stringify({ sessionId: 'sess-b', display: 'newer', project: '/p', timestamp: 5000 })
      const e3 = JSON.stringify({ sessionId: 'sess-c', display: 'middle', project: '/p', timestamp: 3000 })

      mockFs.existsSync.mockReturnValue(true)
      mockFs.readFileSync.mockImplementation((path: string) => {
        if (path === '/mock/home/.claude/history.jsonl') return [e1, e2, e3].join('\n')
        return ''
      })
      mockFs.readdirSync.mockReturnValue([])

      const result = mod.scanSessions()
      expect(result.map(s => s.sessionId)).toEqual(['sess-b', 'sess-c', 'sess-a'])
    })

    it('respects the limit parameter', () => {
      const entries = Array.from({ length: 10 }, (_, i) =>
        JSON.stringify({ sessionId: `sess-${i}`, display: `msg ${i}`, project: '/p', timestamp: i * 100 })
      ).join('\n')

      mockFs.existsSync.mockReturnValue(true)
      mockFs.readFileSync.mockImplementation((path: string) => {
        if (path === '/mock/home/.claude/history.jsonl') return entries
        return ''
      })
      mockFs.readdirSync.mockReturnValue([])

      const result = mod.scanSessions(3)
      expect(result).toHaveLength(3)
    })

    it('skips malformed JSONL lines without crashing', () => {
      const content = [
        'not-valid-json',
        JSON.stringify({ sessionId: 'sess-1', display: 'valid', project: '/p', timestamp: 1000 }),
        '{ bad json }',
      ].join('\n')

      mockFs.existsSync.mockReturnValue(true)
      mockFs.readFileSync.mockImplementation((path: string) => {
        if (path === '/mock/home/.claude/history.jsonl') return content
        return ''
      })
      mockFs.readdirSync.mockReturnValue([])

      const result = mod.scanSessions()
      expect(result).toHaveLength(1)
      expect(result[0].sessionId).toBe('sess-1')
    })
  })

  // ─── readSessionMessages ────────────────────────────────────────────────────

  describe('readSessionMessages', () => {
    const PROJECTS_DIR = '/mock/home/.claude/projects'

    it('returns empty if projectsDir does not exist', () => {
      mockFs.existsSync.mockReturnValue(false)
      const result = mod.readSessionMessages('sess-1')
      expect(result.messages).toEqual([])
      expect(result.project).toBeNull()
    })

    it('returns empty if session file not found in any project dir', () => {
      mockFs.existsSync.mockImplementation((p: string) => p === PROJECTS_DIR)
      mockFs.readdirSync.mockImplementation((dir: string) => {
        if (dir === PROJECTS_DIR) return ['proj-a']
        return ['other.jsonl']
      })

      const result = mod.readSessionMessages('sess-missing')
      expect(result.messages).toEqual([])
    })

    it('parses user message with string content', () => {
      const sessionContent = JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'hello from user' },
        timestamp: '2026-04-01T00:00:00Z',
      })

      mockFs.existsSync.mockImplementation((p: string) =>
        p === PROJECTS_DIR || p.endsWith('sess-1.jsonl')
      )
      mockFs.readdirSync.mockImplementation((dir: string) => {
        if (dir === PROJECTS_DIR) return ['-home-user-proj']
        if (dir.endsWith('-home-user-proj')) return ['sess-1.jsonl']
        return []
      })
      mockFs.statSync.mockReturnValue({ size: 100 })
      mockFs.readFileSync.mockReturnValue(sessionContent)

      const result = mod.readSessionMessages('sess-1')
      expect(result.messages).toHaveLength(1)
      expect(result.messages[0].role).toBe('human')
      expect(result.messages[0].text).toBe('hello from user')
    })

    it('parses assistant message with string content', () => {
      const sessionContent = JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: 'reply from assistant' },
        timestamp: '2026-04-01T00:00:00Z',
      })

      mockFs.existsSync.mockImplementation((p: string) =>
        p === PROJECTS_DIR || p.endsWith('sess-1.jsonl')
      )
      mockFs.readdirSync.mockImplementation((dir: string) => {
        if (dir === PROJECTS_DIR) return ['proj-dir']
        if (dir.endsWith('proj-dir')) return ['sess-1.jsonl']
        return []
      })
      mockFs.statSync.mockReturnValue({ size: 100 })
      mockFs.readFileSync.mockReturnValue(sessionContent)

      const result = mod.readSessionMessages('sess-1')
      expect(result.messages).toHaveLength(1)
      expect(result.messages[0].role).toBe('assistant')
      expect(result.messages[0].text).toBe('reply from assistant')
    })

    it('parses user message with array content (text type)', () => {
      const sessionContent = JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'part one' },
            { type: 'text', text: 'part two' },
          ],
        },
      })

      mockFs.existsSync.mockImplementation((p: string) =>
        p === PROJECTS_DIR || p.endsWith('sess-1.jsonl')
      )
      mockFs.readdirSync.mockImplementation((dir: string) => {
        if (dir === PROJECTS_DIR) return ['proj-dir']
        if (dir.endsWith('proj-dir')) return ['sess-1.jsonl']
        return []
      })
      mockFs.statSync.mockReturnValue({ size: 100 })
      mockFs.readFileSync.mockReturnValue(sessionContent)

      const result = mod.readSessionMessages('sess-1')
      expect(result.messages).toHaveLength(1)
      expect(result.messages[0].text).toBe('part one\npart two')
    })

    it('skips user messages that contain tool_result entries', () => {
      const sessionContent = JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tu-1', content: 'result' },
          ],
        },
      })

      mockFs.existsSync.mockImplementation((p: string) =>
        p === PROJECTS_DIR || p.endsWith('sess-1.jsonl')
      )
      mockFs.readdirSync.mockImplementation((dir: string) => {
        if (dir === PROJECTS_DIR) return ['proj-dir']
        if (dir.endsWith('proj-dir')) return ['sess-1.jsonl']
        return []
      })
      mockFs.statSync.mockReturnValue({ size: 100 })
      mockFs.readFileSync.mockReturnValue(sessionContent)

      const result = mod.readSessionMessages('sess-1')
      expect(result.messages).toHaveLength(0)
    })

    it('parses assistant message with array content', () => {
      const sessionContent = JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'thinking...' },
            { type: 'tool_use', name: 'Bash', input: {} },
            { type: 'text', text: 'done' },
          ],
        },
      })

      mockFs.existsSync.mockImplementation((p: string) =>
        p === PROJECTS_DIR || p.endsWith('sess-1.jsonl')
      )
      mockFs.readdirSync.mockImplementation((dir: string) => {
        if (dir === PROJECTS_DIR) return ['proj-dir']
        if (dir.endsWith('proj-dir')) return ['sess-1.jsonl']
        return []
      })
      mockFs.statSync.mockReturnValue({ size: 100 })
      mockFs.readFileSync.mockReturnValue(sessionContent)

      const result = mod.readSessionMessages('sess-1')
      expect(result.messages).toHaveLength(1)
      expect(result.messages[0].text).toBe('thinking...\ndone')
    })

    it('skips entries without a message field', () => {
      const lines = [
        JSON.stringify({ type: 'system', sessionId: 'sess-1', cwd: '/tmp' }),
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'real msg' } }),
      ].join('\n')

      mockFs.existsSync.mockImplementation((p: string) =>
        p === PROJECTS_DIR || p.endsWith('sess-1.jsonl')
      )
      mockFs.readdirSync.mockImplementation((dir: string) => {
        if (dir === PROJECTS_DIR) return ['proj-dir']
        if (dir.endsWith('proj-dir')) return ['sess-1.jsonl']
        return []
      })
      mockFs.statSync.mockReturnValue({ size: 100 })
      mockFs.readFileSync.mockReturnValue(lines)

      const result = mod.readSessionMessages('sess-1')
      expect(result.messages).toHaveLength(1)
      expect(result.messages[0].text).toBe('real msg')
    })

    it('returns last N messages up to limit', () => {
      const lines = Array.from({ length: 10 }, (_, i) =>
        JSON.stringify({ type: 'user', message: { role: 'user', content: `msg ${i}` } })
      ).join('\n')

      mockFs.existsSync.mockImplementation((p: string) =>
        p === PROJECTS_DIR || p.endsWith('sess-1.jsonl')
      )
      mockFs.readdirSync.mockImplementation((dir: string) => {
        if (dir === PROJECTS_DIR) return ['proj-dir']
        if (dir.endsWith('proj-dir')) return ['sess-1.jsonl']
        return []
      })
      mockFs.statSync.mockReturnValue({ size: 100 })
      mockFs.readFileSync.mockReturnValue(lines)

      const result = mod.readSessionMessages('sess-1', 3)
      expect(result.messages).toHaveLength(3)
      // last 3 of 10
      expect(result.messages[2].text).toBe('msg 9')
      expect(result.messages[0].text).toBe('msg 7')
    })

    it('extracts projectPath from the directory name', () => {
      const sessionContent = JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'hi' },
      })

      mockFs.existsSync.mockImplementation((p: string) =>
        p === PROJECTS_DIR || p.endsWith('sess-1.jsonl')
      )
      mockFs.readdirSync.mockImplementation((dir: string) => {
        if (dir === PROJECTS_DIR) return ['-Users-fabio-projects-myapp']
        if (dir.endsWith('-Users-fabio-projects-myapp')) return ['sess-1.jsonl']
        return []
      })
      mockFs.statSync.mockReturnValue({ size: 100 })
      mockFs.readFileSync.mockReturnValue(sessionContent)

      const result = mod.readSessionMessages('sess-1')
      // dir name "-Users-fabio-projects-myapp" → replace(/-/g, '/') → "/Users/fabio/projects/myapp"
      expect(result.project).toBe('/Users/fabio/projects/myapp')
    })
  })
})
