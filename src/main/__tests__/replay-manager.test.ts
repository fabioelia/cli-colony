/**
 * Tests for src/main/replay-manager.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ---- Mock fs ----
const mockFs = {
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn().mockReturnValue('[]'),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}

// ---- Mock colony-paths ----
const MOCK_SESSIONS_DIR = '/mock/.claude-colony/sessions'

describe('replay-manager', () => {
  let mod: typeof import('../replay-manager')

  beforeEach(async () => {
    vi.resetModules()

    mockFs.existsSync.mockReset().mockReturnValue(false)
    mockFs.readFileSync.mockReset().mockReturnValue('[]')
    mockFs.writeFileSync.mockReset()
    mockFs.mkdirSync.mockReset()

    vi.doMock('fs', () => mockFs)

    vi.doMock('../../shared/colony-paths', () => ({
      colonyPaths: {
        sessions: MOCK_SESSIONS_DIR,
      },
    }))

    vi.doMock('../../shared/utils', () => ({
      stripAnsi: (s: string) => s.replace(/\x1b\[[0-9;]*m/g, ''),
    }))

    mod = await import('../replay-manager')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // ---- parseToolLine ----
  describe('parseToolLine', () => {
    it('parses a simple tool line with parens', () => {
      const result = mod.parseToolLine('⏺ Read(/path/to/file.ts)')
      expect(result).not.toBeNull()
      expect(result!.tool).toBe('Read')
      expect(result!.inputSummary).toBe('/path/to/file.ts')
    })

    it('parses Edit with multiple args', () => {
      const result = mod.parseToolLine('⏺ Edit(src/foo.ts, old, new)')
      expect(result).not.toBeNull()
      expect(result!.tool).toBe('Edit')
      expect(result!.inputSummary).toContain('src/foo.ts')
    })

    it('parses Bash with a command', () => {
      const result = mod.parseToolLine('⏺ Bash(npm test)')
      expect(result).not.toBeNull()
      expect(result!.tool).toBe('Bash')
      expect(result!.inputSummary).toBe('npm test')
    })

    it('parses a tool with no args', () => {
      const result = mod.parseToolLine('⏺ Write()')
      expect(result).not.toBeNull()
      expect(result!.tool).toBe('Write')
      expect(result!.inputSummary).toBe('')
    })

    it('returns null for lines without ⏺ prefix', () => {
      expect(mod.parseToolLine('  Read(file.ts)')).toBeNull()
      expect(mod.parseToolLine('normal text')).toBeNull()
    })

    it('truncates inputSummary to 200 chars', () => {
      const longArgs = 'x'.repeat(300)
      const result = mod.parseToolLine(`⏺ Bash(${longArgs})`)
      expect(result).not.toBeNull()
      expect(result!.inputSummary.length).toBeLessThanOrEqual(200)
    })
  })

  // ---- parseOutputLine ----
  describe('parseOutputLine', () => {
    it('parses a ⎿ output line', () => {
      const result = mod.parseOutputLine('⎿ File written successfully')
      expect(result).toBe('File written successfully')
    })

    it('returns null for non-output lines', () => {
      expect(mod.parseOutputLine('⏺Read(file)')).toBeNull()
      expect(mod.parseOutputLine('regular text')).toBeNull()
    })

    it('truncates output to 200 chars', () => {
      const longOutput = 'y'.repeat(300)
      const result = mod.parseOutputLine(`⎿ ${longOutput}`)
      expect(result).not.toBeNull()
      expect(result!.length).toBeLessThanOrEqual(200)
    })
  })

  // ---- readReplay ----
  describe('readReplay', () => {
    it('returns [] when file does not exist', () => {
      mockFs.existsSync.mockReturnValue(false)
      const result = mod.readReplay('inst-123')
      expect(result).toEqual([])
    })

    it('returns [] when file contains invalid JSON', () => {
      mockFs.existsSync.mockReturnValue(true)
      mockFs.readFileSync.mockReturnValue('not valid json {{{')
      const result = mod.readReplay('inst-bad')
      expect(result).toEqual([])
    })

    it('returns [] when file contains non-array JSON', () => {
      mockFs.existsSync.mockReturnValue(true)
      mockFs.readFileSync.mockReturnValue('{"foo": "bar"}')
      const result = mod.readReplay('inst-obj')
      expect(result).toEqual([])
    })

    it('returns parsed events when file is valid', () => {
      const events = [
        { ts: '2026-04-05T00:00:00.000Z', tool: 'Read', inputSummary: 'foo.ts', outputSummary: 'content' },
      ]
      mockFs.existsSync.mockReturnValue(true)
      mockFs.readFileSync.mockReturnValue(JSON.stringify(events))
      const result = mod.readReplay('inst-456')
      expect(result).toHaveLength(1)
      expect(result[0].tool).toBe('Read')
    })

    it('reads from the correct file path', () => {
      mockFs.existsSync.mockReturnValue(true)
      mockFs.readFileSync.mockReturnValue('[]')
      mod.readReplay('my-instance')
      expect(mockFs.existsSync).toHaveBeenCalledWith(
        `${MOCK_SESSIONS_DIR}/my-instance.replay.json`
      )
    })
  })

  // ---- appendReplayEvent ----
  describe('appendReplayEvent', () => {
    it('creates the sessions dir if it does not exist', () => {
      mockFs.existsSync.mockReturnValue(false)
      mod.appendReplayEvent('inst-1', { ts: '2026-01-01T00:00:00.000Z', tool: 'Read', inputSummary: 'a', outputSummary: 'b' })
      expect(mockFs.mkdirSync).toHaveBeenCalledWith(MOCK_SESSIONS_DIR, { recursive: true })
    })

    it('appends an event to an empty file', () => {
      mockFs.existsSync.mockReturnValueOnce(false) // sessions dir
      mockFs.existsSync.mockReturnValueOnce(false) // replay file
      mod.appendReplayEvent('inst-new', { ts: '2026-01-01T00:00:00.000Z', tool: 'Edit', inputSummary: 'file.ts', outputSummary: 'done' })
      expect(mockFs.writeFileSync).toHaveBeenCalled()
      const written = JSON.parse(mockFs.writeFileSync.mock.calls[0][1] as string)
      expect(written).toHaveLength(1)
      expect(written[0].tool).toBe('Edit')
    })

    it('appends to existing events', () => {
      const existing = [
        { ts: '2026-01-01T00:00:00.000Z', tool: 'Read', inputSummary: 'a', outputSummary: 'b' },
      ]
      mockFs.existsSync.mockReturnValue(true)
      mockFs.readFileSync.mockReturnValue(JSON.stringify(existing))
      mod.appendReplayEvent('inst-existing', { ts: '2026-01-02T00:00:00.000Z', tool: 'Bash', inputSummary: 'ls', outputSummary: 'file1' })
      const written = JSON.parse(mockFs.writeFileSync.mock.calls[0][1] as string)
      expect(written).toHaveLength(2)
      expect(written[1].tool).toBe('Bash')
    })

    it('caps at 200 events, keeping the most recent', () => {
      const existing = Array.from({ length: 200 }, (_, i) => ({
        ts: `2026-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
        tool: 'Read', inputSummary: `file-${i}`, outputSummary: 'x',
      }))
      mockFs.existsSync.mockReturnValue(true)
      mockFs.readFileSync.mockReturnValue(JSON.stringify(existing))
      mod.appendReplayEvent('inst-cap', { ts: '2026-02-01T00:00:00.000Z', tool: 'Write', inputSummary: 'new.ts', outputSummary: 'done' })
      const written = JSON.parse(mockFs.writeFileSync.mock.calls[0][1] as string)
      expect(written).toHaveLength(200)
      // The newest event (Write) should be at the end
      expect(written[written.length - 1].tool).toBe('Write')
    })
  })

  // ---- processOutput ----
  describe('processOutput', () => {
    it('detects a ⏺ line and stores pending state', () => {
      // If we send a ⏺ line without a ⎿ follow-up, no event should be written yet
      mod.processOutput('inst-parse', '⏺ Read(/some/file.ts)\n')
      expect(mockFs.writeFileSync).not.toHaveBeenCalled()
    })

    it('writes a replay event when ⏺ is followed by ⎿', () => {
      mockFs.existsSync.mockReturnValue(false)
      mod.processOutput('inst-flow', '⏺ Bash(npm test)\n⎿ Tests passed\n')
      expect(mockFs.writeFileSync).toHaveBeenCalled()
      const written = JSON.parse(mockFs.writeFileSync.mock.calls[0][1] as string)
      expect(written).toHaveLength(1)
      expect(written[0].tool).toBe('Bash')
      expect(written[0].inputSummary).toBe('npm test')
      expect(written[0].outputSummary).toBe('Tests passed')
    })

    it('handles multiple tool calls in a single chunk', () => {
      mockFs.existsSync.mockReturnValue(false)
      const chunk = '⏺ Read(a.ts)\n⎿ content A\n⏺ Edit(b.ts)\n⎿ written\n'
      mod.processOutput('inst-multi', chunk)
      // writeFileSync called twice (one per event)
      expect(mockFs.writeFileSync).toHaveBeenCalledTimes(2)
    })

    it('strips ANSI escape codes before parsing', () => {
      mockFs.existsSync.mockReturnValue(false)
      const chunk = '\x1b[32m⏺ Read(ansi-file.ts)\x1b[0m\n\x1b[33m⎿ got content\x1b[0m\n'
      mod.processOutput('inst-ansi', chunk)
      // After stripping ANSI, should parse correctly
      expect(mockFs.writeFileSync).toHaveBeenCalled()
      const written = JSON.parse(mockFs.writeFileSync.mock.calls[0][1] as string)
      expect(written[0].tool).toBe('Read')
    })
  })

  // ---- clearPending ----
  describe('clearPending', () => {
    it('clears pending state without error', () => {
      // Add a pending entry
      mod.processOutput('inst-clear', '⏺ Bash(cmd)\n')
      // Clear it — should not throw
      expect(() => mod.clearPending('inst-clear')).not.toThrow()
      // After clearing, a subsequent ⎿ should not produce an event
      mockFs.writeFileSync.mockClear()
      mod.processOutput('inst-clear', '⎿ some output\n')
      expect(mockFs.writeFileSync).not.toHaveBeenCalled()
    })
  })
})
