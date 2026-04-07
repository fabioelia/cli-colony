import { describe, it, expect, beforeEach, vi } from 'vitest'
import { existsSync, writeFileSync } from 'fs'

vi.mock('fs')
vi.mock('../../shared/colony-paths', () => ({
  colonyPaths: { root: '/mock-colony' },
}))

const { appendRunEntry, getRunHistory } = await import('../persona-run-history')

const mockRead = vi.mocked(vi.fn())
const mockWrite = vi.mocked(vi.fn())

// fs mocks are set up per test
const fs = await import('fs')

describe('persona-run-history', () => {
  const entry1 = { personaId: 'colony-developer', timestamp: '2026-04-07T00:00:00.000Z', durationMs: 120000, cost: 0.05, success: true }
  const entry2 = { personaId: 'colony-developer', timestamp: '2026-04-07T01:00:00.000Z', durationMs: 90000, cost: 0.03, success: false }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('getRunHistory', () => {
    it('returns empty array when file does not exist', () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT') })
      const result = getRunHistory('colony-developer')
      expect(result).toEqual([])
    })

    it('returns parsed entries when file exists', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify([entry1, entry2]))
      const result = getRunHistory('colony-developer')
      expect(result).toEqual([entry1, entry2])
    })

    it('caps result at max parameter', () => {
      const entries = Array.from({ length: 10 }, (_, i) => ({ ...entry1, timestamp: `2026-04-07T0${i}:00:00.000Z` }))
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(entries))
      const result = getRunHistory('colony-developer', 5)
      expect(result).toHaveLength(5)
    })

    it('handles malformed JSON gracefully', () => {
      vi.mocked(fs.readFileSync).mockReturnValue('not json')
      expect(getRunHistory('colony-developer')).toEqual([])
    })

    it('handles non-array JSON gracefully', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ not: 'array' }))
      expect(getRunHistory('colony-developer')).toEqual([])
    })
  })

  describe('appendRunEntry', () => {
    it('writes a new entry when file does not exist', () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT') })
      appendRunEntry('colony-developer', entry1)
      expect(vi.mocked(fs.writeFileSync)).toHaveBeenCalledOnce()
      const written = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string)
      expect(written).toHaveLength(1)
      expect(written[0]).toEqual(entry1)
    })

    it('prepends new entry to existing entries', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify([entry1]))
      appendRunEntry('colony-developer', entry2)
      const written = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string)
      expect(written[0]).toEqual(entry2)
      expect(written[1]).toEqual(entry1)
    })

    it('trims to MAX_ENTRIES (50) when overflow', () => {
      const existing = Array.from({ length: 50 }, (_, i) => ({ ...entry1, timestamp: `2026-04-0${i + 1}` }))
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(existing))
      appendRunEntry('colony-developer', entry2)
      const written = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string)
      expect(written).toHaveLength(50)
      expect(written[0]).toEqual(entry2)
    })

    it('silently ignores write failures', () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT') })
      vi.mocked(fs.writeFileSync).mockImplementation(() => { throw new Error('EACCES') })
      expect(() => appendRunEntry('colony-developer', entry1)).not.toThrow()
    })
  })
})
