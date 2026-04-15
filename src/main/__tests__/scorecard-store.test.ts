import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock electron before any imports
vi.doMock('electron', () => ({ app: { getPath: vi.fn().mockReturnValue('/mock/home') } }))

// We control the file system via module-level mock
const mockReadFile = vi.hoisted(() => vi.fn())
const mockWriteFile = vi.hoisted(() => vi.fn())

vi.mock('fs', () => ({
  promises: {
    readFile: mockReadFile,
    writeFile: mockWriteFile,
  },
}))

vi.mock('../../shared/colony-paths', () => ({
  colonyPaths: { scorecards: '/mock/home/.claude-colony/scorecards.json' },
}))

describe('scorecard-store', () => {
  let mod: typeof import('../scorecard-store')

  const sampleCard = {
    confidence: 4,
    scopeCreep: false,
    testCoverage: 'partial' as const,
    summary: 'Looks good.',
    raw: '{}',
  }

  beforeEach(async () => {
    vi.resetAllMocks()
    vi.resetModules()
    mockReadFile.mockRejectedValue(new Error('ENOENT'))
    mockWriteFile.mockResolvedValue(undefined)
    mod = await import('../scorecard-store')
  })

  it('returns null on empty store', async () => {
    const result = await mod.getScoreCard('inst-1', 'abc123')
    expect(result).toBeNull()
  })

  it('round-trip: save then get returns the card', async () => {
    // After save, subsequent reads use the written content
    let stored = ''
    mockWriteFile.mockImplementation((_path: string, content: string) => {
      stored = content
      return Promise.resolve()
    })
    mockReadFile.mockImplementation(() =>
      stored ? Promise.resolve(stored) : Promise.reject(new Error('ENOENT'))
    )

    await mod.saveScoreCard('inst-1', 'hash-abc', sampleCard)
    const result = await mod.getScoreCard('inst-1', 'hash-abc')
    expect(result).toEqual(sampleCard)
  })

  it('hash mismatch returns null', async () => {
    let stored = ''
    mockWriteFile.mockImplementation((_path: string, content: string) => {
      stored = content
      return Promise.resolve()
    })
    mockReadFile.mockImplementation(() =>
      stored ? Promise.resolve(stored) : Promise.reject(new Error('ENOENT'))
    )

    await mod.saveScoreCard('inst-1', 'hash-abc', sampleCard)
    const result = await mod.getScoreCard('inst-1', 'hash-different')
    expect(result).toBeNull()
  })

  it('clearScoreCard removes the entry', async () => {
    let stored = ''
    mockWriteFile.mockImplementation((_path: string, content: string) => {
      stored = content
      return Promise.resolve()
    })
    mockReadFile.mockImplementation(() =>
      stored ? Promise.resolve(stored) : Promise.reject(new Error('ENOENT'))
    )

    await mod.saveScoreCard('inst-1', 'hash-abc', sampleCard)
    await mod.clearScoreCard('inst-1')
    const result = await mod.getScoreCard('inst-1', 'hash-abc')
    expect(result).toBeNull()
  })

  it('LRU cap: adding 51 entries prunes to 50 newest', async () => {
    vi.useFakeTimers()
    let stored = ''
    mockWriteFile.mockImplementation((_path: string, content: string) => {
      stored = content
      return Promise.resolve()
    })
    mockReadFile.mockImplementation(() =>
      stored ? Promise.resolve(stored) : Promise.reject(new Error('ENOENT'))
    )

    // Insert 51 entries with distinct timestamps so LRU order is deterministic
    for (let i = 0; i < 51; i++) {
      vi.advanceTimersByTime(1)
      await mod.saveScoreCard(`inst-${i}`, `hash-${i}`, { ...sampleCard, summary: `Entry ${i}` })
    }

    vi.useRealTimers()

    const finalStore = JSON.parse(stored)
    expect(Object.keys(finalStore).length).toBe(50)
    // inst-0 should have been pruned (oldest)
    expect(finalStore['inst-0']).toBeUndefined()
    // inst-50 should be present (newest)
    expect(finalStore['inst-50']).toBeDefined()
  })

  it('pruneScorecards removes orphaned instance entries', async () => {
    let stored = ''
    mockWriteFile.mockImplementation((_path: string, content: string) => {
      stored = content
      return Promise.resolve()
    })
    mockReadFile.mockImplementation(() =>
      stored ? Promise.resolve(stored) : Promise.reject(new Error('ENOENT'))
    )

    await mod.saveScoreCard('inst-alive', 'hash-a', sampleCard)
    await mod.saveScoreCard('inst-dead', 'hash-b', sampleCard)

    await mod.pruneScorecards(new Set(['inst-alive']))

    const finalStore = JSON.parse(stored)
    expect(finalStore['inst-alive']).toBeDefined()
    expect(finalStore['inst-dead']).toBeUndefined()
  })
})
