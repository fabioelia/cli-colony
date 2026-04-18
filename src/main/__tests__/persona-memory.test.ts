/**
 * Tests for persona-memory.ts — structured JSON sidecar for persona state.
 *
 * Mocks: fs (sync), colony-paths.
 * Tests: CRUD for situations/learnings/sessionLog, limit enforcement, migration.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

// ---- Hoisted mocks ----
const mockExistsSync = vi.hoisted(() => vi.fn((_p: string) => false))
const mockReadFileSync = vi.hoisted(() => vi.fn(() => '{}'))
const mockWriteFileSync = vi.hoisted(() => vi.fn())
const mockMkdirSync = vi.hoisted(() => vi.fn())

vi.mock('fs', () => ({
  existsSync: mockExistsSync,
  readFileSync: mockReadFileSync,
  writeFileSync: mockWriteFileSync,
  mkdirSync: mockMkdirSync,
}))

vi.mock('../../shared/colony-paths', () => ({
  colonyPaths: {
    personas: '/mock/colony/personas',
  },
}))

// ---- Import after mocks ----
import {
  readPersonaMemory, setSituations, addSituation, updateSituation, removeSituation,
  addLearning, removeLearning, setLearnings,
  addSessionLogEntry, setSessionLog,
  migrateFromMarkdown, getMemoryPath,
} from '../persona-memory'
import type { PersonaMemory, PersonaMemorySituation } from '../../shared/types'

// Helpers
function mockMemoryFile(mem: PersonaMemory): void {
  mockExistsSync.mockImplementation((p: string) => p.endsWith('.memory.json'))
  mockReadFileSync.mockReturnValue(JSON.stringify(mem))
}

function lastWrittenMemory(): PersonaMemory {
  const calls = mockWriteFileSync.mock.calls
  expect(calls.length).toBeGreaterThan(0)
  return JSON.parse(calls[calls.length - 1][1] as string)
}

describe('persona-memory', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockExistsSync.mockReturnValue(false)
  })

  describe('getMemoryPath', () => {
    it('returns correct path for persona ID', () => {
      expect(getMemoryPath('colony-developer')).toBe('/mock/colony/personas/colony-developer.memory.json')
    })

    it('strips .md extension from persona ID', () => {
      expect(getMemoryPath('colony-developer.md')).toBe('/mock/colony/personas/colony-developer.memory.json')
    })
  })

  describe('readPersonaMemory', () => {
    it('returns empty memory when file does not exist', () => {
      const mem = readPersonaMemory('test')
      expect(mem).toEqual({ activeSituations: [], learnings: [], sessionLog: [] })
    })

    it('reads and parses existing memory file', () => {
      const data: PersonaMemory = {
        activeSituations: [{ status: 'pending', text: 'test', updatedAt: '2026-01-01' }],
        learnings: [{ text: 'learned something', addedAt: '2026-01-01' }],
        sessionLog: [{ timestamp: '2026-01-01', summary: 'did stuff' }],
      }
      mockMemoryFile(data)
      const mem = readPersonaMemory('test')
      expect(mem).toEqual(data)
    })

    it('returns empty memory for corrupt JSON', () => {
      mockExistsSync.mockReturnValue(true)
      mockReadFileSync.mockReturnValue('{invalid json')
      const mem = readPersonaMemory('test')
      expect(mem).toEqual({ activeSituations: [], learnings: [], sessionLog: [] })
    })

    it('handles partial/missing arrays gracefully', () => {
      mockExistsSync.mockImplementation((p: string) => p.endsWith('.memory.json'))
      mockReadFileSync.mockReturnValue(JSON.stringify({ learnings: [{ text: 'x', addedAt: '2026-01-01' }] }))
      const mem = readPersonaMemory('test')
      expect(mem.activeSituations).toEqual([])
      expect(mem.learnings).toHaveLength(1)
      expect(mem.sessionLog).toEqual([])
    })
  })

  describe('Active Situations', () => {
    it('setSituations replaces all situations', () => {
      mockMemoryFile({ activeSituations: [{ status: 'done', text: 'old', updatedAt: '2025-01-01' }], learnings: [], sessionLog: [] })
      const newSits: PersonaMemorySituation[] = [
        { status: 'pending', text: 'new task', updatedAt: '2026-04-09' },
      ]
      setSituations('test', newSits)
      const written = lastWrittenMemory()
      expect(written.activeSituations).toHaveLength(1)
      expect(written.activeSituations[0].text).toBe('new task')
    })

    it('addSituation appends to existing', () => {
      mockMemoryFile({ activeSituations: [{ status: 'pending', text: 'existing', updatedAt: '2026-01-01' }], learnings: [], sessionLog: [] })
      addSituation('test', { status: 'delegated', text: 'new work', updatedAt: '2026-04-09' })
      const written = lastWrittenMemory()
      expect(written.activeSituations).toHaveLength(2)
      expect(written.activeSituations[1].status).toBe('delegated')
    })

    it('updateSituation modifies in place and updates timestamp', () => {
      mockMemoryFile({
        activeSituations: [
          { status: 'pending', text: 'task A', updatedAt: '2026-01-01' },
          { status: 'delegated', text: 'task B', updatedAt: '2026-01-01' },
        ],
        learnings: [], sessionLog: [],
      })
      updateSituation('test', 1, { status: 'done' })
      const written = lastWrittenMemory()
      expect(written.activeSituations[1].status).toBe('done')
      expect(written.activeSituations[1].text).toBe('task B')
      expect(written.activeSituations[1].updatedAt).not.toBe('2026-01-01')
    })

    it('updateSituation ignores out-of-range index', () => {
      mockMemoryFile({ activeSituations: [{ status: 'pending', text: 'only one', updatedAt: '2026-01-01' }], learnings: [], sessionLog: [] })
      updateSituation('test', 5, { status: 'done' })
      // Should not write (no change)
      expect(mockWriteFileSync).not.toHaveBeenCalled()
    })

    it('removeSituation removes by index', () => {
      mockMemoryFile({
        activeSituations: [
          { status: 'pending', text: 'first', updatedAt: '2026-01-01' },
          { status: 'done', text: 'second', updatedAt: '2026-01-01' },
          { status: 'blocked', text: 'third', updatedAt: '2026-01-01' },
        ],
        learnings: [], sessionLog: [],
      })
      removeSituation('test', 1)
      const written = lastWrittenMemory()
      expect(written.activeSituations).toHaveLength(2)
      expect(written.activeSituations[0].text).toBe('first')
      expect(written.activeSituations[1].text).toBe('third')
    })

    it('removeSituation ignores negative index', () => {
      mockMemoryFile({ activeSituations: [{ status: 'pending', text: 'x', updatedAt: '2026-01-01' }], learnings: [], sessionLog: [] })
      removeSituation('test', -1)
      expect(mockWriteFileSync).not.toHaveBeenCalled()
    })
  })

  describe('Learnings', () => {
    it('addLearning appends with timestamp', () => {
      mockMemoryFile({ activeSituations: [], learnings: [], sessionLog: [] })
      addLearning('test', 'vitest is great')
      const written = lastWrittenMemory()
      expect(written.learnings).toHaveLength(1)
      expect(written.learnings[0].text).toBe('vitest is great')
      expect(written.learnings[0].addedAt).toBeTruthy()
    })

    it('addLearning enforces 30 item limit', () => {
      const existing = Array.from({ length: 30 }, (_, i) => ({ text: `learning ${i}`, addedAt: '2026-01-01' }))
      mockMemoryFile({ activeSituations: [], learnings: existing, sessionLog: [] })
      addLearning('test', 'newest learning')
      const written = lastWrittenMemory()
      expect(written.learnings).toHaveLength(30)
      expect(written.learnings[0].text).toBe('learning 1')  // oldest trimmed
      expect(written.learnings[29].text).toBe('newest learning')
    })

    it('removeLearning removes by index', () => {
      const existing = [
        { text: 'a', addedAt: '2026-01-01' },
        { text: 'b', addedAt: '2026-01-01' },
        { text: 'c', addedAt: '2026-01-01' },
      ]
      mockMemoryFile({ activeSituations: [], learnings: existing, sessionLog: [] })
      removeLearning('test', 0)
      const written = lastWrittenMemory()
      expect(written.learnings).toHaveLength(2)
      expect(written.learnings[0].text).toBe('b')
    })

    it('setLearnings replaces all and enforces limit', () => {
      mockMemoryFile({ activeSituations: [], learnings: [], sessionLog: [] })
      const bigList = Array.from({ length: 50 }, (_, i) => ({ text: `l${i}`, addedAt: '2026-01-01' }))
      setLearnings('test', bigList)
      const written = lastWrittenMemory()
      expect(written.learnings).toHaveLength(30)
      expect(written.learnings[0].text).toBe('l20')  // kept last 30
    })
  })

  describe('Session Log', () => {
    it('addSessionLogEntry appends with auto-timestamp', () => {
      mockMemoryFile({ activeSituations: [], learnings: [], sessionLog: [] })
      addSessionLogEntry('test', 'Session #1: did things')
      const written = lastWrittenMemory()
      expect(written.sessionLog).toHaveLength(1)
      expect(written.sessionLog[0].summary).toBe('Session #1: did things')
      expect(written.sessionLog[0].timestamp).toBeTruthy()
    })

    it('addSessionLogEntry enforces 20 item limit', () => {
      const existing = Array.from({ length: 20 }, (_, i) => ({ timestamp: '2026-01-01', summary: `session ${i}` }))
      mockMemoryFile({ activeSituations: [], learnings: [], sessionLog: existing })
      addSessionLogEntry('test', 'newest session')
      const written = lastWrittenMemory()
      expect(written.sessionLog).toHaveLength(20)
      expect(written.sessionLog[0].summary).toBe('session 1')
      expect(written.sessionLog[19].summary).toBe('newest session')
    })

    it('setSessionLog replaces all and enforces limit', () => {
      mockMemoryFile({ activeSituations: [], learnings: [], sessionLog: [] })
      const bigList = Array.from({ length: 30 }, (_, i) => ({ timestamp: '2026-01-01', summary: `s${i}` }))
      setSessionLog('test', bigList)
      const written = lastWrittenMemory()
      expect(written.sessionLog).toHaveLength(20)
      expect(written.sessionLog[0].summary).toBe('s10')
    })
  })

  describe('Migration from Markdown', () => {
    it('returns false when sidecar already exists', () => {
      mockExistsSync.mockReturnValue(true)
      expect(migrateFromMarkdown('test')).toBe(false)
    })

    it('returns false when md file does not exist', () => {
      mockExistsSync.mockReturnValue(false)
      expect(migrateFromMarkdown('test')).toBe(false)
    })

    it('migrates active situations from markdown', () => {
      mockExistsSync.mockImplementation((p: string) => {
        if (p.endsWith('.memory.json')) return false
        if (p.endsWith('.md')) return true
        return false
      })
      mockReadFileSync.mockReturnValue(`---
name: "Test"
---

## Role
A test persona.

## Active Situations

- [DELEGATED] PR #38 review
- [DONE] Auth refactor complete
- [BLOCKED] Waiting on API changes
- Simple text without status

## Learnings

- Vitest is great for unit tests
- Always mock electron at the boundary

## Session Log

- [2026-04-01T10:00:00Z] Session #1: initial setup
- [2026-04-02T10:00:00Z] Session #2: added tests
`)

      const result = migrateFromMarkdown('test')
      expect(result).toBe(true)
      expect(mockWriteFileSync).toHaveBeenCalledTimes(1)

      const written = lastWrittenMemory()

      // Situations
      expect(written.activeSituations).toHaveLength(4)
      expect(written.activeSituations[0].status).toBe('delegated')
      expect(written.activeSituations[0].text).toBe('PR #38 review')
      expect(written.activeSituations[1].status).toBe('done')
      expect(written.activeSituations[2].status).toBe('blocked')
      expect(written.activeSituations[3].status).toBe('pending')  // default for untagged
      expect(written.activeSituations[3].text).toBe('Simple text without status')

      // Learnings
      expect(written.learnings).toHaveLength(2)
      expect(written.learnings[0].text).toBe('Vitest is great for unit tests')
      expect(written.learnings[1].text).toBe('Always mock electron at the boundary')

      // Session log
      expect(written.sessionLog).toHaveLength(2)
      expect(written.sessionLog[0].timestamp).toBe('2026-04-01T10:00:00Z')
      expect(written.sessionLog[0].summary).toBe('Session #1: initial setup')
      expect(written.sessionLog[1].timestamp).toBe('2026-04-02T10:00:00Z')
    })

    it('handles markdown with empty sections', () => {
      mockExistsSync.mockImplementation((p: string) => {
        if (p.endsWith('.memory.json')) return false
        if (p.endsWith('.md')) return true
        return false
      })
      mockReadFileSync.mockReturnValue(`---
name: "Empty"
---

## Role
No data.

## Active Situations

(No active situations yet)

## Learnings

(No learnings yet)

## Session Log

(No sessions yet)
`)

      const result = migrateFromMarkdown('test')
      expect(result).toBe(false)
      expect(mockWriteFileSync).not.toHaveBeenCalled()
    })

    it('enforces limits during migration', () => {
      mockExistsSync.mockImplementation((p: string) => {
        if (p.endsWith('.memory.json')) return false
        if (p.endsWith('.md')) return true
        return false
      })

      const learningLines = Array.from({ length: 40 }, (_, i) => `- Learning number ${i}`).join('\n')
      const logLines = Array.from({ length: 25 }, (_, i) => `- [2026-01-${String(i + 1).padStart(2, '0')}] Session ${i}`).join('\n')

      mockReadFileSync.mockReturnValue(`---
name: "Big"
---

## Learnings

${learningLines}

## Session Log

${logLines}
`)

      migrateFromMarkdown('test')
      const written = lastWrittenMemory()
      expect(written.learnings).toHaveLength(30)
      expect(written.sessionLog).toHaveLength(20)
    })
  })

  describe('directory creation', () => {
    it('creates parent directory when writing if it does not exist', () => {
      mockExistsSync.mockReturnValue(false)
      addLearning('test', 'something')
      expect(mockMkdirSync).toHaveBeenCalledWith('/mock/colony/personas', { recursive: true })
    })
  })
})
