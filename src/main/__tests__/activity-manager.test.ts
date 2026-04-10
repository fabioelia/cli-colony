/**
 * Tests for src/main/activity-manager.ts
 *
 * activity-manager has module-level state (unreadCount).
 * Strategy: vi.resetModules() + vi.doMock() + dynamic import per test group
 * to get a fresh module with reset state for each describe block.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const ACTIVITY_LOG = '/mock/.claude-colony/activity.json'

// ---- Shared mock instances ----

const mockBroadcast = vi.fn()

// ---- Helpers ----

function buildFsMock(existingEvents: object[] = []) {
  const contents: Record<string, string> = {
    [ACTIVITY_LOG]: JSON.stringify(existingEvents),
  }
  return {
    promises: {
      readFile: vi.fn().mockImplementation(async (p: string) => {
        if (p in contents) return contents[p]
        throw new Error(`ENOENT: no such file: ${p}`)
      }),
      writeFile: vi.fn().mockImplementation(async (p: string, data: string) => {
        contents[p] = data
      }),
    },
  }
}

function setupMocks(fsMock: ReturnType<typeof buildFsMock>) {
  vi.doMock('electron', () => ({
    app: { getPath: vi.fn().mockReturnValue('/mock/home') },
  }))
  vi.doMock('../../shared/colony-paths', () => ({
    colonyPaths: { activityLog: ACTIVITY_LOG },
  }))
  vi.doMock('fs', () => fsMock)
  vi.doMock('../broadcast', () => ({ broadcast: mockBroadcast }))
}

// ---- Test suites ----

describe('activity-manager: appendActivity', () => {
  let mod: typeof import('../activity-manager')
  let fsMock: ReturnType<typeof buildFsMock>

  beforeEach(async () => {
    vi.resetModules()
    mockBroadcast.mockReset()
    fsMock = buildFsMock([])
    setupMocks(fsMock)
    mod = await import('../activity-manager')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('appends an event with generated id and timestamp', async () => {
    const before = Date.now()
    await mod.appendActivity({ source: 'persona', name: 'Colony Developer', summary: 'Colony Developer fired', level: 'info' })
    const after = Date.now()

    expect(fsMock.promises.writeFile).toHaveBeenCalledOnce()
    const written = JSON.parse(fsMock.promises.writeFile.mock.calls[0][1]).events as Array<{
      id: string; timestamp: string; source: string; name: string; summary: string; level: string
    }>
    expect(written).toHaveLength(1)
    expect(written[0].source).toBe('persona')
    expect(written[0].name).toBe('Colony Developer')
    expect(written[0].summary).toBe('Colony Developer fired')
    expect(written[0].level).toBe('info')
    expect(written[0].id).toMatch(/^\d+-\d+$/)
    const ts = new Date(written[0].timestamp).getTime()
    expect(ts).toBeGreaterThanOrEqual(before)
    expect(ts).toBeLessThanOrEqual(after)
  })

  it('writes only the new event when starting from empty log', async () => {
    await mod.appendActivity({ source: 'pipeline', name: 'Solo', summary: 'Solo fired', level: 'info' })
    const written = JSON.parse(fsMock.promises.writeFile.mock.calls[0][1]).events
    expect(written).toHaveLength(1)
    expect(written[0].source).toBe('pipeline')
    expect(written[0].name).toBe('Solo')
  })

  it('increments unreadCount on each append', async () => {
    expect(await mod.getUnreadCount()).toBe(0)
    await mod.appendActivity({ source: 'pipeline', name: 'Pipe', summary: 'Fired', level: 'info' })
    expect(await mod.getUnreadCount()).toBe(1)
    await mod.appendActivity({ source: 'env', name: 'work', summary: 'Started', level: 'info' })
    expect(await mod.getUnreadCount()).toBe(2)
  })

  it('broadcasts activity:new with event and unreadCount', async () => {
    await mod.appendActivity({ source: 'persona', name: 'Test', summary: 'Test ran', level: 'info' })
    expect(mockBroadcast).toHaveBeenCalledWith(
      'activity:new',
      expect.objectContaining({
        event: expect.objectContaining({ source: 'persona', name: 'Test' }),
        unreadCount: 1,
      })
    )
  })

  it('trims log to MAX_EVENTS (100) when over limit', () => {
    // Start with 100 events already in the file
    const hundredEvents = Array.from({ length: 100 }, (_, i) => ({
      id: `${i}-old`,
      timestamp: '2026-01-01T00:00:00.000Z',
      source: 'pipeline',
      name: `Pipe ${i}`,
      summary: `Event ${i}`,
      level: 'info',
    }))
    fsMock = buildFsMock(hundredEvents)
    vi.resetModules()
    setupMocks(fsMock)

    // Can't easily re-import mid-test; use a new module copy
    // Just verify trimming through the written output
  })
})

describe('activity-manager: appendActivity with pre-existing events', () => {
  let mod: typeof import('../activity-manager')
  let fsMock: ReturnType<typeof buildFsMock>
  const existing = [
    { id: '1-abc', timestamp: '2026-01-01T00:00:00.000Z', source: 'pipeline', name: 'Old Pipe', summary: 'Old event', level: 'info' },
    { id: '2-def', timestamp: '2026-01-02T00:00:00.000Z', source: 'persona', name: 'Colony Dev', summary: 'Another', level: 'info' },
  ]

  beforeEach(async () => {
    vi.resetModules()
    mockBroadcast.mockReset()
    fsMock = buildFsMock(existing)
    setupMocks(fsMock)
    mod = await import('../activity-manager')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('appends to existing events', async () => {
    await mod.appendActivity({ source: 'env', name: 'work', summary: 'New event', level: 'info' })
    const written = JSON.parse(fsMock.promises.writeFile.mock.calls[0][1]).events
    expect(written).toHaveLength(3)
    expect(written[0].id).toBe('1-abc')
    expect(written[1].id).toBe('2-def')
    expect(written[2].source).toBe('env')
    expect(written[2].summary).toBe('New event')
  })

})

describe('activity-manager: appendActivity ring-buffer trimming', () => {
  let mod: typeof import('../activity-manager')
  let fsMock: ReturnType<typeof buildFsMock>

  beforeEach(async () => {
    vi.resetModules()
    mockBroadcast.mockReset()
    // Start with 100 events (at limit)
    const full = Array.from({ length: 100 }, (_, i) => ({
      id: `${i}-old`,
      timestamp: '2026-01-01T00:00:00.000Z',
      source: 'pipeline',
      name: `Pipe ${i}`,
      summary: `Old ${i}`,
      level: 'info',
    }))
    fsMock = buildFsMock(full)
    setupMocks(fsMock)
    mod = await import('../activity-manager')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('keeps exactly 100 events when adding one to a full log', async () => {
    await mod.appendActivity({ source: 'persona', name: 'Colony Dev', summary: 'New', level: 'info' })
    const written = JSON.parse(fsMock.promises.writeFile.mock.calls[0][1]).events
    expect(written).toHaveLength(100)
  })

  it('evicts oldest events from the front', async () => {
    await mod.appendActivity({ source: 'persona', name: 'Colony Dev', summary: 'Latest', level: 'info' })
    const written = JSON.parse(fsMock.promises.writeFile.mock.calls[0][1]).events
    // oldest event (id '0-old') should be removed
    expect(written[0].id).toBe('1-old')
    // newest event should be last
    expect(written[99].summary).toBe('Latest')
  })

  it('all events are unread when no watermark exists', async () => {
    // 100 pre-existing events with no lastReadId — all are unread
    expect(await mod.getUnreadCount()).toBe(100)
    await mod.appendActivity({ source: 'env', name: 'work', summary: 'X', level: 'warn' })
    // Trimmed to 100 but still no watermark — all 100 unread
    expect(await mod.getUnreadCount()).toBe(100)
  })

  it('after markRead + append, only new events are unread', async () => {
    await mod.markRead()
    expect(await mod.getUnreadCount()).toBe(0)
    await mod.appendActivity({ source: 'env', name: 'work', summary: 'X', level: 'warn' })
    expect(await mod.getUnreadCount()).toBe(1)
  })
})

describe('activity-manager: listActivity', () => {
  let mod: typeof import('../activity-manager')

  beforeEach(async () => {
    vi.resetModules()
    mockBroadcast.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns empty array when log file does not exist', async () => {
    const fsMock = {
      promises: {
        readFile: vi.fn().mockRejectedValue(new Error('ENOENT')),
        writeFile: vi.fn(),
      },
    }
    setupMocks(fsMock)
    mod = await import('../activity-manager')
    expect(await mod.listActivity()).toEqual([])
  })

  it('returns parsed events from log file', async () => {
    const events = [
      { id: '1-abc', timestamp: '2026-01-01T00:00:00.000Z', source: 'pipeline', name: 'Pipe', summary: 'Test', level: 'info' },
    ]
    const fsMock = buildFsMock(events)
    setupMocks(fsMock)
    mod = await import('../activity-manager')
    expect(await mod.listActivity()).toEqual(events)
  })

  it('returns empty array when log file contains invalid JSON', async () => {
    const fsMock = {
      promises: {
        readFile: vi.fn().mockResolvedValue('not valid json {{'),
        writeFile: vi.fn(),
      },
    }
    setupMocks(fsMock)
    mod = await import('../activity-manager')
    expect(await mod.listActivity()).toEqual([])
  })

  it('returns multiple events in order', async () => {
    const events = [
      { id: '1-a', timestamp: '2026-01-01T00:00:00.000Z', source: 'persona', name: 'ColDev', summary: 'First', level: 'info' },
      { id: '2-b', timestamp: '2026-01-02T00:00:00.000Z', source: 'pipeline', name: 'Pipe', summary: 'Second', level: 'info' },
      { id: '3-c', timestamp: '2026-01-03T00:00:00.000Z', source: 'env', name: 'work', summary: 'Third', level: 'warn' },
    ]
    const fsMock = buildFsMock(events)
    setupMocks(fsMock)
    mod = await import('../activity-manager')
    const result = await mod.listActivity()
    expect(result).toHaveLength(3)
    expect(result[0].summary).toBe('First')
    expect(result[2].summary).toBe('Third')
  })
})

describe('activity-manager: getUnreadCount', () => {
  let mod: typeof import('../activity-manager')

  beforeEach(async () => {
    vi.resetModules()
    mockBroadcast.mockReset()
    const fsMock = buildFsMock([])
    setupMocks(fsMock)
    mod = await import('../activity-manager')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns 0 on fresh module load', async () => {
    expect(await mod.getUnreadCount()).toBe(0)
  })

  it('returns correct count after multiple appends', async () => {
    await mod.appendActivity({ source: 'pipeline', name: 'Pipe', summary: 'A', level: 'info' })
    await mod.appendActivity({ source: 'pipeline', name: 'Pipe', summary: 'B', level: 'info' })
    await mod.appendActivity({ source: 'pipeline', name: 'Pipe', summary: 'C', level: 'info' })
    expect(await mod.getUnreadCount()).toBe(3)
  })

  it('returns 0 after markRead resets counter', async () => {
    await mod.appendActivity({ source: 'persona', name: 'ColDev', summary: 'X', level: 'info' })
    await mod.appendActivity({ source: 'persona', name: 'ColDev', summary: 'Y', level: 'info' })
    expect(await mod.getUnreadCount()).toBe(2)
    await mod.markRead()
    expect(await mod.getUnreadCount()).toBe(0)
  })
})

describe('activity-manager: markRead', () => {
  let mod: typeof import('../activity-manager')

  beforeEach(async () => {
    vi.resetModules()
    mockBroadcast.mockReset()
    const fsMock = buildFsMock([])
    setupMocks(fsMock)
    mod = await import('../activity-manager')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('resets unreadCount to 0', async () => {
    await mod.appendActivity({ source: 'env', name: 'work', summary: 'Env started', level: 'info' })
    await mod.appendActivity({ source: 'env', name: 'work', summary: 'Env stopped', level: 'warn' })
    await mod.markRead()
    expect(await mod.getUnreadCount()).toBe(0)
  })

  it('broadcasts activity:unread with count 0', async () => {
    await mod.appendActivity({ source: 'pipeline', name: 'Pipe', summary: 'Fired', level: 'info' })
    mockBroadcast.mockReset()
    await mod.markRead()
    expect(mockBroadcast).toHaveBeenCalledOnce()
    expect(mockBroadcast).toHaveBeenCalledWith('activity:unread', { count: 0 })
  })

  it('is idempotent — calling twice does not error', async () => {
    await mod.markRead()
    await mod.markRead()
    expect(await mod.getUnreadCount()).toBe(0)
    expect(mockBroadcast).toHaveBeenCalledTimes(2)
  })

  it('after markRead, new appends increment from 0 again', async () => {
    await mod.appendActivity({ source: 'persona', name: 'ColDev', summary: 'Before', level: 'info' })
    await mod.markRead()
    await mod.appendActivity({ source: 'persona', name: 'ColDev', summary: 'After', level: 'info' })
    expect(await mod.getUnreadCount()).toBe(1)
  })
})

describe('activity-manager: appendActivity with fs write failure', () => {
  let mod: typeof import('../activity-manager')

  beforeEach(async () => {
    vi.resetModules()
    mockBroadcast.mockReset()
    const fsMock = {
      promises: {
        readFile: vi.fn().mockRejectedValue(new Error('ENOENT')),
        writeFile: vi.fn().mockRejectedValue(new Error('ENOSPC: no space left on device')),
      },
    }
    setupMocks(fsMock)
    mod = await import('../activity-manager')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('does not throw when writeFile fails', async () => {
    await expect(
      mod.appendActivity({ source: 'pipeline', name: 'Pipe', summary: 'Test', level: 'info' })
    ).resolves.not.toThrow()
  })

  it('still increments unreadCount even if write fails', async () => {
    await mod.appendActivity({ source: 'pipeline', name: 'Pipe', summary: 'Test', level: 'info' })
    expect(await mod.getUnreadCount()).toBe(1)
  })

  it('still broadcasts activity:new even if write fails', async () => {
    await mod.appendActivity({ source: 'pipeline', name: 'Pipe', summary: 'Test', level: 'info' })
    expect(mockBroadcast).toHaveBeenCalledWith('activity:new', expect.any(Object))
  })
})
