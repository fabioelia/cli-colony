import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { ArenaMatchRecord } from '../../shared/types'

// ---- Hoisted mocks ----
const mockMkdir = vi.hoisted(() => vi.fn(async () => undefined))
const mockWriteFile = vi.hoisted(() => vi.fn(async () => undefined))
const mockReadFile = vi.hoisted(() => vi.fn(async () => '[]'))

vi.mock('electron', () => ({ app: { getPath: vi.fn().mockReturnValue('/mock/home') } }))

vi.mock('fs', () => ({
  promises: {
    mkdir: mockMkdir,
    writeFile: mockWriteFile,
    readFile: mockReadFile,
  },
}))

import { appendMatchRecord, readMatchHistory, buildJudgeHistorySection } from '../arena-stats'

function makeRecord(overrides: Partial<ArenaMatchRecord> = {}): ArenaMatchRecord {
  return {
    id: `match-${Date.now()}-abc`,
    timestamp: new Date().toISOString(),
    participants: [
      { name: 'Arena 1' },
      { name: 'Arena 2' },
    ],
    winnerId: 'Arena 1',
    winnerName: 'Arena 1',
    judgeType: 'manual',
    ...overrides,
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  mockReadFile.mockResolvedValue('[]')
})

describe('Arena Judge Learning V1', () => {
  describe('appendMatchRecord + readMatchHistory round-trip', () => {
    it('persists reason field through write/read cycle', async () => {
      const record = makeRecord({ reason: 'cleaner code, fewer side effects' })

      let stored: string | null = null
      mockWriteFile.mockImplementation(async (_path: string, data: string) => {
        stored = data
      })
      mockReadFile.mockImplementation(async () => stored ?? '[]')

      await appendMatchRecord(record)
      const history = await readMatchHistory()

      expect(history).toHaveLength(1)
      expect(history[0].reason).toBe('cleaner code, fewer side effects')
    })

    it('stores undefined reason when not provided', async () => {
      const record = makeRecord()

      let stored: string | null = null
      mockWriteFile.mockImplementation(async (_path: string, data: string) => {
        stored = data
      })
      mockReadFile.mockImplementation(async () => stored ?? '[]')

      await appendMatchRecord(record)
      const history = await readMatchHistory()

      expect(history).toHaveLength(1)
      expect(history[0].reason).toBeUndefined()
    })
  })

  describe('buildJudgeHistorySection', () => {
    it('returns empty string when no manual records with reasons', () => {
      const history: ArenaMatchRecord[] = [
        makeRecord({ judgeType: 'llm' }),
        makeRecord({ judgeType: 'command' }),
        makeRecord({ judgeType: 'manual' }),          // no reason
        makeRecord({ judgeType: 'manual', reason: '' }), // empty reason
      ]
      expect(buildJudgeHistorySection(history)).toBe('')
    })

    it('returns formatted section for 1 reason', () => {
      const history: ArenaMatchRecord[] = [
        makeRecord({ winnerName: 'Arena 1', participants: [{ name: 'Arena 1' }, { name: 'Arena 2' }], reason: 'more tests' }),
      ]
      const result = buildJudgeHistorySection(history)
      expect(result).toContain('User preference history')
      expect(result).toContain('Winner "Arena 1"')
      expect(result).toContain('reason: more tests')
      expect(result).toContain('soft guide')
    })

    it('returns formatted section for 5 reasons', () => {
      const history: ArenaMatchRecord[] = Array.from({ length: 5 }, (_, i) =>
        makeRecord({ winnerName: `Arena ${i + 1}`, reason: `reason ${i + 1}` })
      )
      const result = buildJudgeHistorySection(history)
      expect(result).toContain('1.')
      expect(result).toContain('5.')
      expect(result).toContain('reason 5')
    })

    it('caps at last 5 when 7 records exist', () => {
      const history: ArenaMatchRecord[] = Array.from({ length: 7 }, (_, i) =>
        makeRecord({ winnerName: `Arena ${i + 1}`, reason: `reason ${i + 1}` })
      )
      const result = buildJudgeHistorySection(history)
      // Only entries 3-7 (the last 5) should appear
      expect(result).not.toContain('reason 1')
      expect(result).not.toContain('reason 2')
      expect(result).toContain('reason 3')
      expect(result).toContain('reason 7')
      // Should have entries 1-5 (re-indexed)
      expect(result).toContain('1.')
      expect(result).toContain('5.')
      expect(result).not.toContain('6.')
    })
  })
})
