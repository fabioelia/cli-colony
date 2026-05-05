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
    unlink: vi.fn(async () => undefined),
  },
}))

import { buildJudgeHistorySection, appendMatchRecord, readMatchHistory } from '../arena-stats'

function makeRecord(overrides: Partial<ArenaMatchRecord> = {}): ArenaMatchRecord {
  return {
    id: 'r1',
    timestamp: '2026-01-01T00:00:00.000Z',
    participants: [{ name: 'A' }, { name: 'B' }],
    winnerId: 'A',
    winnerName: 'A',
    judgeType: 'manual',
    reason: 'Better explanation',
    ...overrides,
  }
}

describe('arena-stats: buildJudgeHistorySection', () => {
  it('returns empty string for empty history', () => {
    expect(buildJudgeHistorySection([])).toBe('')
  })

  it('returns empty string when no manual entries exist', () => {
    const history = [makeRecord({ judgeType: 'llm', reason: 'good' })]
    expect(buildJudgeHistorySection(history)).toBe('')
  })

  it('returns empty string when manual entries have no reason', () => {
    const history = [makeRecord({ judgeType: 'manual', reason: undefined })]
    expect(buildJudgeHistorySection(history)).toBe('')
  })

  it('returns empty string when manual entries have blank reason', () => {
    const history = [makeRecord({ judgeType: 'manual', reason: '   ' })]
    expect(buildJudgeHistorySection(history)).toBe('')
  })

  it('includes winner name and reason for manual entries', () => {
    const history = [makeRecord({ winnerName: 'ModelX', reason: 'Cleaner output' })]
    const result = buildJudgeHistorySection(history)
    expect(result).toContain('ModelX')
    expect(result).toContain('Cleaner output')
    expect(result).toContain('User preference history')
  })

  it('shows at most 5 most recent manual entries', () => {
    const history = Array.from({ length: 8 }, (_, i) =>
      makeRecord({ winnerName: `Model${i}`, reason: `reason${i}` })
    )
    const result = buildJudgeHistorySection(history)
    // Last 5 entries (3-7) should appear, first 3 should not
    expect(result).toContain('Model7')
    expect(result).toContain('Model3')
    expect(result).not.toContain('Model0')
    expect(result).not.toContain('Model2')
  })

  it('skips command/llm judgeType even with reason', () => {
    const history = [
      makeRecord({ judgeType: 'command', reason: 'auto-picked' }),
      makeRecord({ judgeType: 'llm', reason: 'llm reasoning' }),
      makeRecord({ judgeType: 'manual', reason: 'manual pick', winnerName: 'TheOne' }),
    ]
    const result = buildJudgeHistorySection(history)
    expect(result).toContain('TheOne')
    expect(result).not.toContain('auto-picked')
    expect(result).not.toContain('llm reasoning')
  })

  it('includes participant names in the output', () => {
    const history = [makeRecord({ participants: [{ name: 'Alpha' }, { name: 'Beta' }], reason: 'great' })]
    const result = buildJudgeHistorySection(history)
    expect(result).toContain('Alpha')
    expect(result).toContain('Beta')
  })
})

describe('arena-stats: appendMatchRecord', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockReadFile.mockResolvedValue('[]')
  })

  it('appends a record to empty history', async () => {
    const record = makeRecord()
    await appendMatchRecord(record)
    expect(mockWriteFile).toHaveBeenCalledOnce()
    const written = JSON.parse(mockWriteFile.mock.calls[0][1] as string)
    expect(written).toHaveLength(1)
    expect(written[0].id).toBe('r1')
  })

  it('appends to existing history', async () => {
    const existing = [makeRecord({ id: 'old' })]
    mockReadFile.mockResolvedValue(JSON.stringify(existing))
    const newRecord = makeRecord({ id: 'new' })
    await appendMatchRecord(newRecord)
    const written = JSON.parse(mockWriteFile.mock.calls[0][1] as string)
    expect(written).toHaveLength(2)
    expect(written[1].id).toBe('new')
  })

  it('prunes to MAX_MATCH_HISTORY (100) when limit exceeded', async () => {
    const existing = Array.from({ length: 100 }, (_, i) => makeRecord({ id: `r${i}` }))
    mockReadFile.mockResolvedValue(JSON.stringify(existing))
    await appendMatchRecord(makeRecord({ id: 'newest' }))
    const written = JSON.parse(mockWriteFile.mock.calls[0][1] as string)
    expect(written).toHaveLength(100)
    // Oldest entry (r0) removed, newest kept
    expect(written[99].id).toBe('newest')
    expect(written.find((r: ArenaMatchRecord) => r.id === 'r0')).toBeUndefined()
  })

  it('does not prune when exactly at limit', async () => {
    const existing = Array.from({ length: 99 }, (_, i) => makeRecord({ id: `r${i}` }))
    mockReadFile.mockResolvedValue(JSON.stringify(existing))
    await appendMatchRecord(makeRecord({ id: 'hundredth' }))
    const written = JSON.parse(mockWriteFile.mock.calls[0][1] as string)
    expect(written).toHaveLength(100)
    expect(written[0].id).toBe('r0')
  })

  it('handles corrupt read gracefully (returns empty, then appends)', async () => {
    mockReadFile.mockRejectedValue(new Error('ENOENT'))
    await appendMatchRecord(makeRecord({ id: 'first' }))
    const written = JSON.parse(mockWriteFile.mock.calls[0][1] as string)
    expect(written).toHaveLength(1)
  })
})

describe('arena-stats: readMatchHistory', () => {
  it('returns empty array on read error', async () => {
    mockReadFile.mockRejectedValue(new Error('ENOENT'))
    const result = await readMatchHistory()
    expect(result).toEqual([])
  })

  it('returns empty array for non-array JSON', async () => {
    mockReadFile.mockResolvedValue('{"not": "array"}')
    const result = await readMatchHistory()
    expect(result).toEqual([])
  })

  it('returns parsed array', async () => {
    const records = [makeRecord({ id: 'x' })]
    mockReadFile.mockResolvedValue(JSON.stringify(records))
    const result = await readMatchHistory()
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('x')
  })
})
