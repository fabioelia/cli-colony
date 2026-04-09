/**
 * Tests for src/main/session-scanner.ts
 *
 * Covers: scanSessions() JSONL parsing logic and readSessionMessages() extraction logic.
 * scanExternalSessions() and takeoverSession() are skipped (execFile/process.kill).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockFsp = {
  stat: vi.fn(),
  readFile: vi.fn(),
  readdir: vi.fn(),
  open: vi.fn(),
}

const mockCreateReadStream = vi.fn()

const mockGetRecentSessions = vi.fn()
const mockGetAllInstances = vi.fn()

describe('session-scanner', () => {
  let mod: typeof import('../session-scanner')

  beforeEach(async () => {
    vi.resetModules()

    for (const fn of Object.values(mockFsp)) fn.mockReset()
    mockCreateReadStream.mockReset()
    mockGetRecentSessions.mockReset().mockResolvedValue([])
    mockGetAllInstances.mockReset().mockResolvedValue([])

    vi.doMock('electron', () => ({
      app: { getPath: vi.fn().mockReturnValue('/mock/home') },
    }))

    vi.doMock('fs', () => ({
      promises: mockFsp,
      createReadStream: mockCreateReadStream,
    }))

    vi.doMock('child_process', () => ({ execFile: vi.fn() }))
    vi.doMock('readline', () => ({ createInterface: vi.fn() }))

    vi.doMock('../recent-sessions', () => ({
      getRecentSessions: mockGetRecentSessions,
      discoverSessionId: vi.fn().mockResolvedValue(null),
    }))

    vi.doMock('../instance-manager', () => ({
      getAllInstances: mockGetAllInstances,
    }))

    mod = await import('../session-scanner')
  })

  // ─── scanSessions ───────────────────────────────────────────────────────────

  describe('scanSessions', () => {
    it('returns [] when history.jsonl does not exist', async () => {
      mockFsp.stat.mockRejectedValue(new Error('ENOENT'))
      expect(await mod.scanSessions()).toEqual([])
    })

    it('returns [] on readFile error', async () => {
      mockFsp.stat.mockResolvedValue({ size: 100 })
      mockFsp.readFile.mockRejectedValue(new Error('ENOENT'))
      expect(await mod.scanSessions()).toEqual([])
    })

    it('returns [] when history.jsonl is empty', async () => {
      mockFsp.stat.mockResolvedValue({ size: 0 })
      mockFsp.readFile.mockResolvedValue('')
      mockFsp.readdir.mockRejectedValue(new Error('ENOENT'))
      expect(await mod.scanSessions()).toEqual([])
    })

    it('parses a single session from history.jsonl', async () => {
      const entry = JSON.stringify({ sessionId: 'sess-1', display: 'hello world', project: '/home/user/myapp', timestamp: 1000 })
      mockFsp.stat.mockResolvedValue({ size: 100 })
      mockFsp.readFile.mockImplementation(async (path: string) => {
        if (path === '/mock/home/.claude/history.jsonl') return entry
        return ''
      })
      mockFsp.readdir.mockRejectedValue(new Error('ENOENT'))

      const result = await mod.scanSessions()
      expect(result).toHaveLength(1)
      expect(result[0].sessionId).toBe('sess-1')
      expect(result[0].display).toBe('hello world')
      expect(result[0].project).toBe('/home/user/myapp')
      expect(result[0].projectName).toBe('myapp')
      expect(result[0].timestamp).toBe(1000)
      expect(result[0].messageCount).toBe(1)
      expect(result[0].name).toBeNull()
    })

    it('deduplicates entries for the same sessionId', async () => {
      const e1 = JSON.stringify({ sessionId: 'sess-1', display: 'first msg', project: '/p', timestamp: 1000 })
      const e2 = JSON.stringify({ sessionId: 'sess-1', display: 'second msg', project: '/p', timestamp: 2000 })
      const content = [e1, e2].join('\n')

      mockFsp.stat.mockResolvedValue({ size: 100 })
      mockFsp.readFile.mockImplementation(async (path: string) => {
        if (path === '/mock/home/.claude/history.jsonl') return content
        return ''
      })
      mockFsp.readdir.mockRejectedValue(new Error('ENOENT'))

      const result = await mod.scanSessions()
      expect(result).toHaveLength(1)
      expect(result[0].messageCount).toBe(2)
      expect(result[0].display).toBe('first msg')
      expect(result[0].lastMessage).toBe('second msg')
      expect(result[0].timestamp).toBe(2000)
    })

    it('sets lastMessage to null when only one message exists', async () => {
      const entry = JSON.stringify({ sessionId: 'sess-1', display: 'only msg', project: '/p', timestamp: 1000 })
      mockFsp.stat.mockResolvedValue({ size: 100 })
      mockFsp.readFile.mockImplementation(async (path: string) => {
        if (path === '/mock/home/.claude/history.jsonl') return entry
        return ''
      })
      mockFsp.readdir.mockRejectedValue(new Error('ENOENT'))

      const result = await mod.scanSessions()
      expect(result[0].lastMessage).toBeNull()
    })

    it('extracts name from /rename command', async () => {
      const e1 = JSON.stringify({ sessionId: 'sess-1', display: 'hello', project: '/p', timestamp: 1000 })
      const e2 = JSON.stringify({ sessionId: 'sess-1', display: '/rename My Project', project: '/p', timestamp: 2000 })
      const content = [e1, e2].join('\n')

      mockFsp.stat.mockResolvedValue({ size: 100 })
      mockFsp.readFile.mockImplementation(async (path: string) => {
        if (path === '/mock/home/.claude/history.jsonl') return content
        return ''
      })
      mockFsp.readdir.mockRejectedValue(new Error('ENOENT'))

      const result = await mod.scanSessions()
      expect(result[0].name).toBe('My Project')
    })

    it('/rename overrides customTitle from --name', async () => {
      // history.jsonl has /rename
      const e1 = JSON.stringify({ sessionId: 'sess-1', display: 'hello', project: '/p', timestamp: 1000 })
      const e2 = JSON.stringify({ sessionId: 'sess-1', display: '/rename Renamed', project: '/p', timestamp: 2000 })
      const histContent = [e1, e2].join('\n')

      // project dir has customTitle
      const sessionJsonl = JSON.stringify({ type: 'custom-title', customTitle: 'Named Title', sessionId: 'sess-1' })

      mockFsp.stat.mockResolvedValue({ size: 100 })
      mockFsp.readFile.mockImplementation(async (path: string) => {
        if (path === '/mock/home/.claude/history.jsonl') return histContent
        if (path.endsWith('.jsonl')) return sessionJsonl
        return ''
      })
      mockFsp.readdir.mockImplementation(async (dir: string) => {
        if (dir === '/mock/home/.claude/projects') return ['proj-dir']
        if (dir.endsWith('proj-dir')) return ['sess-1.jsonl']
        return []
      })

      const result = await mod.scanSessions()
      expect(result[0].name).toBe('Renamed')
    })

    it('uses customTitle when no /rename present', async () => {
      const histEntry = JSON.stringify({ sessionId: 'sess-1', display: 'hello', project: '/p', timestamp: 1000 })
      const sessionJsonl = JSON.stringify({ type: 'custom-title', customTitle: 'Named Title', sessionId: 'sess-1' })

      mockFsp.stat.mockResolvedValue({ size: 100 })
      mockFsp.readFile.mockImplementation(async (path: string) => {
        if (path === '/mock/home/.claude/history.jsonl') return histEntry
        if (path.endsWith('.jsonl')) return sessionJsonl
        return ''
      })
      mockFsp.readdir.mockImplementation(async (dir: string) => {
        if (dir === '/mock/home/.claude/projects') return ['proj-dir']
        if (dir.endsWith('proj-dir')) return ['sess-1.jsonl']
        return []
      })

      const result = await mod.scanSessions()
      expect(result[0].name).toBe('Named Title')
    })

    it('sets recentlyOpened for sessions in getRecentSessions', async () => {
      const entry = JSON.stringify({ sessionId: 'sess-1', display: 'hello', project: '/p', timestamp: 1000 })
      mockGetRecentSessions.mockResolvedValue([{ sessionId: 'sess-1', instanceName: 'test', instanceId: 'i1', workingDirectory: '/p', color: '#f00', args: [], openedAt: '', closedAt: null, exitType: 'running' }])

      mockFsp.stat.mockResolvedValue({ size: 100 })
      mockFsp.readFile.mockImplementation(async (path: string) => {
        if (path === '/mock/home/.claude/history.jsonl') return entry
        return ''
      })
      mockFsp.readdir.mockRejectedValue(new Error('ENOENT'))

      const result = await mod.scanSessions()
      expect(result[0].recentlyOpened).toBe(true)
    })

    it('sorts sessions by timestamp descending', async () => {
      const e1 = JSON.stringify({ sessionId: 'sess-a', display: 'older', project: '/p', timestamp: 1000 })
      const e2 = JSON.stringify({ sessionId: 'sess-b', display: 'newer', project: '/p', timestamp: 5000 })
      const e3 = JSON.stringify({ sessionId: 'sess-c', display: 'middle', project: '/p', timestamp: 3000 })

      mockFsp.stat.mockResolvedValue({ size: 100 })
      mockFsp.readFile.mockImplementation(async (path: string) => {
        if (path === '/mock/home/.claude/history.jsonl') return [e1, e2, e3].join('\n')
        return ''
      })
      mockFsp.readdir.mockRejectedValue(new Error('ENOENT'))

      const result = await mod.scanSessions()
      expect(result.map(s => s.sessionId)).toEqual(['sess-b', 'sess-c', 'sess-a'])
    })

    it('respects the limit parameter', async () => {
      const entries = Array.from({ length: 10 }, (_, i) =>
        JSON.stringify({ sessionId: `sess-${i}`, display: `msg ${i}`, project: '/p', timestamp: i * 100 })
      ).join('\n')

      mockFsp.stat.mockResolvedValue({ size: 100 })
      mockFsp.readFile.mockImplementation(async (path: string) => {
        if (path === '/mock/home/.claude/history.jsonl') return entries
        return ''
      })
      mockFsp.readdir.mockRejectedValue(new Error('ENOENT'))

      const result = await mod.scanSessions(3)
      expect(result).toHaveLength(3)
    })

    it('skips malformed JSONL lines without crashing', async () => {
      const content = [
        'not-valid-json',
        JSON.stringify({ sessionId: 'sess-1', display: 'valid', project: '/p', timestamp: 1000 }),
        '{ bad json }',
      ].join('\n')

      mockFsp.stat.mockResolvedValue({ size: 100 })
      mockFsp.readFile.mockImplementation(async (path: string) => {
        if (path === '/mock/home/.claude/history.jsonl') return content
        return ''
      })
      mockFsp.readdir.mockRejectedValue(new Error('ENOENT'))

      const result = await mod.scanSessions()
      expect(result).toHaveLength(1)
      expect(result[0].sessionId).toBe('sess-1')
    })
  })

  // ─── readSessionMessages ────────────────────────────────────────────────────

  describe('readSessionMessages', () => {
    const PROJECTS_DIR = '/mock/home/.claude/projects'

    it('returns empty if projectsDir does not exist', async () => {
      mockFsp.stat.mockRejectedValue(new Error('ENOENT'))
      const result = await mod.readSessionMessages('sess-1')
      expect(result.messages).toEqual([])
      expect(result.project).toBeNull()
    })

    it('returns empty if session file not found in any project dir', async () => {
      mockFsp.stat.mockImplementation(async (p: string) => {
        if (p === PROJECTS_DIR) return { isDirectory: () => true }
        throw new Error('ENOENT')
      })
      mockFsp.readdir.mockImplementation(async (dir: string) => {
        if (dir === PROJECTS_DIR) return ['proj-a']
        return ['other.jsonl']
      })

      const result = await mod.readSessionMessages('sess-missing')
      expect(result.messages).toEqual([])
    })

    it('parses user message with string content', async () => {
      const sessionContent = JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'hello from user' },
        timestamp: '2026-04-01T00:00:00Z',
      })

      mockFsp.stat.mockImplementation(async (p: string) => {
        if (p === PROJECTS_DIR) return { isDirectory: () => true }
        if (p.endsWith('sess-1.jsonl')) return { size: 100 }
        throw new Error('ENOENT')
      })
      mockFsp.readdir.mockImplementation(async (dir: string) => {
        if (dir === PROJECTS_DIR) return ['-home-user-proj']
        if (dir.endsWith('-home-user-proj')) return ['sess-1.jsonl']
        return []
      })
      mockFsp.readFile.mockResolvedValue(sessionContent)

      const result = await mod.readSessionMessages('sess-1')
      expect(result.messages).toHaveLength(1)
      expect(result.messages[0].role).toBe('human')
      expect(result.messages[0].text).toBe('hello from user')
    })

    it('parses assistant message with string content', async () => {
      const sessionContent = JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: 'reply from assistant' },
        timestamp: '2026-04-01T00:00:00Z',
      })

      mockFsp.stat.mockImplementation(async (p: string) => {
        if (p === PROJECTS_DIR) return { isDirectory: () => true }
        if (p.endsWith('sess-1.jsonl')) return { size: 100 }
        throw new Error('ENOENT')
      })
      mockFsp.readdir.mockImplementation(async (dir: string) => {
        if (dir === PROJECTS_DIR) return ['proj-dir']
        if (dir.endsWith('proj-dir')) return ['sess-1.jsonl']
        return []
      })
      mockFsp.readFile.mockResolvedValue(sessionContent)

      const result = await mod.readSessionMessages('sess-1')
      expect(result.messages).toHaveLength(1)
      expect(result.messages[0].role).toBe('assistant')
      expect(result.messages[0].text).toBe('reply from assistant')
    })

    it('parses user message with array content (text type)', async () => {
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

      mockFsp.stat.mockImplementation(async (p: string) => {
        if (p === PROJECTS_DIR) return { isDirectory: () => true }
        if (p.endsWith('sess-1.jsonl')) return { size: 100 }
        throw new Error('ENOENT')
      })
      mockFsp.readdir.mockImplementation(async (dir: string) => {
        if (dir === PROJECTS_DIR) return ['proj-dir']
        if (dir.endsWith('proj-dir')) return ['sess-1.jsonl']
        return []
      })
      mockFsp.readFile.mockResolvedValue(sessionContent)

      const result = await mod.readSessionMessages('sess-1')
      expect(result.messages).toHaveLength(1)
      expect(result.messages[0].text).toBe('part one\npart two')
    })

    it('skips user messages that contain tool_result entries', async () => {
      const sessionContent = JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tu-1', content: 'result' },
          ],
        },
      })

      mockFsp.stat.mockImplementation(async (p: string) => {
        if (p === PROJECTS_DIR) return { isDirectory: () => true }
        if (p.endsWith('sess-1.jsonl')) return { size: 100 }
        throw new Error('ENOENT')
      })
      mockFsp.readdir.mockImplementation(async (dir: string) => {
        if (dir === PROJECTS_DIR) return ['proj-dir']
        if (dir.endsWith('proj-dir')) return ['sess-1.jsonl']
        return []
      })
      mockFsp.readFile.mockResolvedValue(sessionContent)

      const result = await mod.readSessionMessages('sess-1')
      expect(result.messages).toHaveLength(0)
    })

    it('parses assistant message with array content', async () => {
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

      mockFsp.stat.mockImplementation(async (p: string) => {
        if (p === PROJECTS_DIR) return { isDirectory: () => true }
        if (p.endsWith('sess-1.jsonl')) return { size: 100 }
        throw new Error('ENOENT')
      })
      mockFsp.readdir.mockImplementation(async (dir: string) => {
        if (dir === PROJECTS_DIR) return ['proj-dir']
        if (dir.endsWith('proj-dir')) return ['sess-1.jsonl']
        return []
      })
      mockFsp.readFile.mockResolvedValue(sessionContent)

      const result = await mod.readSessionMessages('sess-1')
      expect(result.messages).toHaveLength(1)
      expect(result.messages[0].text).toBe('thinking...\ndone')
    })

    it('skips entries without a message field', async () => {
      const lines = [
        JSON.stringify({ type: 'system', sessionId: 'sess-1', cwd: '/tmp' }),
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'real msg' } }),
      ].join('\n')

      mockFsp.stat.mockImplementation(async (p: string) => {
        if (p === PROJECTS_DIR) return { isDirectory: () => true }
        if (p.endsWith('sess-1.jsonl')) return { size: 100 }
        throw new Error('ENOENT')
      })
      mockFsp.readdir.mockImplementation(async (dir: string) => {
        if (dir === PROJECTS_DIR) return ['proj-dir']
        if (dir.endsWith('proj-dir')) return ['sess-1.jsonl']
        return []
      })
      mockFsp.readFile.mockResolvedValue(lines)

      const result = await mod.readSessionMessages('sess-1')
      expect(result.messages).toHaveLength(1)
      expect(result.messages[0].text).toBe('real msg')
    })

    it('returns last N messages up to limit', async () => {
      const lines = Array.from({ length: 10 }, (_, i) =>
        JSON.stringify({ type: 'user', message: { role: 'user', content: `msg ${i}` } })
      ).join('\n')

      mockFsp.stat.mockImplementation(async (p: string) => {
        if (p === PROJECTS_DIR) return { isDirectory: () => true }
        if (p.endsWith('sess-1.jsonl')) return { size: 100 }
        throw new Error('ENOENT')
      })
      mockFsp.readdir.mockImplementation(async (dir: string) => {
        if (dir === PROJECTS_DIR) return ['proj-dir']
        if (dir.endsWith('proj-dir')) return ['sess-1.jsonl']
        return []
      })
      mockFsp.readFile.mockResolvedValue(lines)

      const result = await mod.readSessionMessages('sess-1', 3)
      expect(result.messages).toHaveLength(3)
      // last 3 of 10
      expect(result.messages[2].text).toBe('msg 9')
      expect(result.messages[0].text).toBe('msg 7')
    })

    it('extracts projectPath from the directory name', async () => {
      const sessionContent = JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'hi' },
      })

      mockFsp.stat.mockImplementation(async (p: string) => {
        if (p === PROJECTS_DIR) return { isDirectory: () => true }
        if (p.endsWith('sess-1.jsonl')) return { size: 100 }
        throw new Error('ENOENT')
      })
      mockFsp.readdir.mockImplementation(async (dir: string) => {
        if (dir === PROJECTS_DIR) return ['-Users-fabio-projects-myapp']
        if (dir.endsWith('-Users-fabio-projects-myapp')) return ['sess-1.jsonl']
        return []
      })
      mockFsp.readFile.mockResolvedValue(sessionContent)

      const result = await mod.readSessionMessages('sess-1')
      // dir name "-Users-fabio-projects-myapp" -> replace(/-/g, '/') -> "/Users/fabio/projects/myapp"
      expect(result.project).toBe('/Users/fabio/projects/myapp')
    })
  })
})
