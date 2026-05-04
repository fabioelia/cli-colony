import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockWriteFileSync = vi.fn()
const mockReadFileSync = vi.fn()
const mockReaddirSync = vi.fn()
const mockExistsSync = vi.fn()
const mockAddWhisper = vi.fn().mockReturnValue(true)

vi.mock('fs', () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
  writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
  readdirSync: (...args: unknown[]) => mockReaddirSync(...args),
}))

vi.mock('../../shared/colony-paths', () => ({
  colonyPaths: { personas: '/mock/personas' },
}))

vi.mock('../persona-manager', () => ({
  addWhisper: (...args: unknown[]) => mockAddWhisper(...args),
}))

import {
  getAttentionRequests,
  getAllPendingAttention,
  getAttentionCount,
  resolveAttention,
  dismissAttention,
  pruneOldAttention,
} from '../persona-attention'
import type { PersonaAttentionRequest } from '../../shared/types'

function makeItem(overrides: Partial<PersonaAttentionRequest> = {}): PersonaAttentionRequest {
  return {
    id: 'attn-1',
    personaId: 'colony-qa',
    personaName: 'Colony QA',
    message: 'Need input',
    createdAt: new Date().toISOString(),
    resolved: false,
    ...overrides,
  }
}

describe('persona-attention', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockAddWhisper.mockReturnValue(true)
  })

  describe('getAttentionRequests', () => {
    it('returns parsed array from file', () => {
      const items = [makeItem({ id: 'a1' }), makeItem({ id: 'a2' })]
      mockReadFileSync.mockReturnValue(JSON.stringify(items))
      expect(getAttentionRequests('colony-qa')).toEqual(items)
    })

    it('returns [] on read error', () => {
      mockReadFileSync.mockImplementation(() => { throw new Error('ENOENT') })
      expect(getAttentionRequests('colony-qa')).toEqual([])
    })

    it('returns [] when file contains non-array JSON', () => {
      mockReadFileSync.mockReturnValue(JSON.stringify({ not: 'an array' }))
      expect(getAttentionRequests('colony-qa')).toEqual([])
    })

    it('filters out items missing required fields', () => {
      const valid = makeItem({ id: 'good' })
      const bad = { id: 123, message: 'hi', resolved: false }
      mockReadFileSync.mockReturnValue(JSON.stringify([valid, bad]))
      const result = getAttentionRequests('colony-qa')
      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('good')
    })

    it('filters out null items in array', () => {
      const valid = makeItem()
      mockReadFileSync.mockReturnValue(JSON.stringify([valid, null]))
      expect(getAttentionRequests('colony-qa')).toHaveLength(1)
    })
  })

  describe('getAllPendingAttention', () => {
    it('returns [] when personas dir does not exist', () => {
      mockExistsSync.mockReturnValue(false)
      expect(getAllPendingAttention()).toEqual([])
    })

    it('returns only unresolved items across all files', () => {
      mockExistsSync.mockReturnValue(true)
      mockReaddirSync.mockReturnValue(['colony-qa.attention.json', 'colony-dev.attention.json'])
      const item1 = makeItem({ id: 'a1', personaId: 'colony-qa', resolved: false })
      const item2 = makeItem({ id: 'a2', personaId: 'colony-qa', resolved: true })
      const item3 = makeItem({ id: 'a3', personaId: 'colony-dev', resolved: false })
      mockReadFileSync
        .mockReturnValueOnce(JSON.stringify([item1, item2]))
        .mockReturnValueOnce(JSON.stringify([item3]))
      const result = getAllPendingAttention()
      expect(result.map(r => r.id).sort()).toEqual(['a1', 'a3'])
    })

    it('sorts by createdAt descending', () => {
      mockExistsSync.mockReturnValue(true)
      mockReaddirSync.mockReturnValue(['p.attention.json'])
      const older = makeItem({ id: 'old', createdAt: '2026-01-01T00:00:00Z', resolved: false })
      const newer = makeItem({ id: 'new', createdAt: '2026-05-01T00:00:00Z', resolved: false })
      mockReadFileSync.mockReturnValue(JSON.stringify([older, newer]))
      const result = getAllPendingAttention()
      expect(result[0].id).toBe('new')
      expect(result[1].id).toBe('old')
    })

    it('returns [] on readdir error', () => {
      mockExistsSync.mockReturnValue(true)
      mockReaddirSync.mockImplementation(() => { throw new Error('EACCES') })
      expect(getAllPendingAttention()).toEqual([])
    })
  })

  describe('getAttentionCount', () => {
    it('counts only unresolved items', () => {
      const items = [
        makeItem({ id: 'a', resolved: false }),
        makeItem({ id: 'b', resolved: true }),
        makeItem({ id: 'c', resolved: false }),
      ]
      mockReadFileSync.mockReturnValue(JSON.stringify(items))
      expect(getAttentionCount('colony-qa')).toBe(2)
    })

    it('returns 0 when file is missing', () => {
      mockReadFileSync.mockImplementation(() => { throw new Error('ENOENT') })
      expect(getAttentionCount('colony-qa')).toBe(0)
    })
  })

  describe('resolveAttention', () => {
    it('marks item resolved and writes back', () => {
      const item = makeItem({ id: 'attn-1', resolved: false })
      mockReadFileSync.mockReturnValue(JSON.stringify([item]))
      const result = resolveAttention('colony-qa', 'attn-1')
      expect(result).toBe(true)
      const written = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string)
      expect(written[0].resolved).toBe(true)
      expect(written[0].resolvedAt).toBeDefined()
    })

    it('calls addWhisper when response is provided', () => {
      const item = makeItem({ id: 'attn-1', resolved: false })
      mockReadFileSync.mockReturnValue(JSON.stringify([item]))
      resolveAttention('colony-qa', 'attn-1', 'Acknowledged')
      expect(mockAddWhisper).toHaveBeenCalledWith('colony-qa', '[Attention response] Acknowledged')
    })

    it('does not call addWhisper when no response', () => {
      const item = makeItem({ id: 'attn-1', resolved: false })
      mockReadFileSync.mockReturnValue(JSON.stringify([item]))
      resolveAttention('colony-qa', 'attn-1')
      expect(mockAddWhisper).not.toHaveBeenCalled()
    })

    it('returns false when item not found', () => {
      mockReadFileSync.mockReturnValue(JSON.stringify([makeItem({ id: 'other' })]))
      expect(resolveAttention('colony-qa', 'missing')).toBe(false)
    })

    it('returns false on write error', () => {
      const item = makeItem({ id: 'attn-1' })
      mockReadFileSync.mockReturnValue(JSON.stringify([item]))
      mockWriteFileSync.mockImplementation(() => { throw new Error('EACCES') })
      expect(resolveAttention('colony-qa', 'attn-1')).toBe(false)
    })
  })

  describe('dismissAttention', () => {
    it('marks item resolved without whisper', () => {
      const item = makeItem({ id: 'attn-1', resolved: false })
      mockReadFileSync.mockReturnValue(JSON.stringify([item]))
      const result = dismissAttention('colony-qa', 'attn-1')
      expect(result).toBe(true)
      expect(mockAddWhisper).not.toHaveBeenCalled()
      const written = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string)
      expect(written[0].resolved).toBe(true)
    })

    it('returns false when item not found', () => {
      mockReadFileSync.mockReturnValue(JSON.stringify([]))
      expect(dismissAttention('colony-qa', 'missing')).toBe(false)
    })

    it('returns false on write error', () => {
      const item = makeItem({ id: 'attn-1' })
      mockReadFileSync.mockReturnValue(JSON.stringify([item]))
      mockWriteFileSync.mockImplementation(() => { throw new Error('EPERM') })
      expect(dismissAttention('colony-qa', 'attn-1')).toBe(false)
    })
  })

  describe('pruneOldAttention', () => {
    it('does nothing when personas dir missing', () => {
      mockExistsSync.mockReturnValue(false)
      pruneOldAttention()
      expect(mockReaddirSync).not.toHaveBeenCalled()
    })

    it('removes resolved items older than 7 days', () => {
      mockExistsSync.mockReturnValue(true)
      mockReaddirSync.mockReturnValue(['colony-qa.attention.json'])
      const old = makeItem({
        id: 'old',
        resolved: true,
        createdAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
      })
      const fresh = makeItem({ id: 'fresh', resolved: false })
      mockReadFileSync.mockReturnValue(JSON.stringify([old, fresh]))
      pruneOldAttention()
      const written = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string)
      expect(written).toHaveLength(1)
      expect(written[0].id).toBe('fresh')
    })

    it('keeps resolved items newer than 7 days', () => {
      mockExistsSync.mockReturnValue(true)
      mockReaddirSync.mockReturnValue(['colony-qa.attention.json'])
      const recent = makeItem({
        id: 'recent',
        resolved: true,
        createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
      })
      mockReadFileSync.mockReturnValue(JSON.stringify([recent]))
      pruneOldAttention()
      expect(mockWriteFileSync).not.toHaveBeenCalled()
    })

    it('skips non-attention files', () => {
      mockExistsSync.mockReturnValue(true)
      mockReaddirSync.mockReturnValue(['colony-qa.md', 'colony-qa.attention.json'])
      mockReadFileSync.mockReturnValue(JSON.stringify([]))
      pruneOldAttention()
      // Only called once (for the .attention.json file)
      expect(mockReadFileSync).toHaveBeenCalledTimes(1)
    })
  })
})
