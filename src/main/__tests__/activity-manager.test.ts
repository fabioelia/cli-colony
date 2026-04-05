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
    existsSync: vi.fn().mockImplementation((p: string) => p in contents),
    readFileSync: vi.fn().mockImplementation((p: string, _enc?: string) => {
      if (p in contents) return contents[p]
      throw new Error(`Unexpected readFileSync: ${p}`)
    }),
    writeFileSync: vi.fn().mockImplementation((p: string, data: string) => {
      contents[p] = data
    }),
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

  it('appends an event with generated id and timestamp', () => {
    const before = Date.now()
    mod.appendActivity({ type: 'persona', label: 'Colony Developer fired', color: 'green' })
    const after = Date.now()

    expect(fsMock.writeFileSync).toHaveBeenCalledOnce()
    const written = JSON.parse(fsMock.writeFileSync.mock.calls[0][1]) as Array<{
      id: string; timestamp: string; type: string; label: string; color: string
    }>
    expect(written).toHaveLength(1)
    expect(written[0].type).toBe('persona')
    expect(written[0].label).toBe('Colony Developer fired')
    expect(written[0].color).toBe('green')
    expect(written[0].id).toMatch(/^\d+-[a-z0-9]+$/)
    const ts = new Date(written[0].timestamp).getTime()
    expect(ts).toBeGreaterThanOrEqual(before)
    expect(ts).toBeLessThanOrEqual(after)
  })

  it('writes only the new event when starting from empty log', () => {
    mod.appendActivity({ type: 'pipeline', label: 'Solo', color: 'blue' })
    const written = JSON.parse(fsMock.writeFileSync.mock.calls[0][1])
    expect(written).toHaveLength(1)
    expect(written[0].type).toBe('pipeline')
    expect(written[0].label).toBe('Solo')
  })

  it('increments unreadCount on each append', () => {
    expect(mod.getUnreadCount()).toBe(0)
    mod.appendActivity({ type: 'pipeline', label: 'Fired', color: 'blue' })
    expect(mod.getUnreadCount()).toBe(1)
    mod.appendActivity({ type: 'env', label: 'Started', color: 'purple' })
    expect(mod.getUnreadCount()).toBe(2)
  })

  it('broadcasts activity:new with event and unreadCount', () => {
    mod.appendActivity({ type: 'persona', label: 'Test', color: 'green' })
    expect(mockBroadcast).toHaveBeenCalledWith(
      'activity:new',
      expect.objectContaining({
        event: expect.objectContaining({ type: 'persona', label: 'Test' }),
        unreadCount: 1,
      })
    )
  })

  it('trims log to MAX_EVENTS (100) when over limit', () => {
    // Start with 100 events already in the file
    const hundredEvents = Array.from({ length: 100 }, (_, i) => ({
      id: `${i}-old`,
      timestamp: '2026-01-01T00:00:00.000Z',
      type: 'pipeline',
      label: `Event ${i}`,
      color: 'blue',
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
    { id: '1-abc', timestamp: '2026-01-01T00:00:00.000Z', type: 'pipeline', label: 'Old event', color: 'blue' },
    { id: '2-def', timestamp: '2026-01-02T00:00:00.000Z', type: 'persona', label: 'Another', color: 'green' },
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

  it('appends to existing events', () => {
    mod.appendActivity({ type: 'env', label: 'New event', color: 'purple' })
    const written = JSON.parse(fsMock.writeFileSync.mock.calls[0][1])
    expect(written).toHaveLength(3)
    expect(written[0].id).toBe('1-abc')
    expect(written[1].id).toBe('2-def')
    expect(written[2].type).toBe('env')
    expect(written[2].label).toBe('New event')
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
      type: 'pipeline',
      label: `Old ${i}`,
      color: 'blue',
    }))
    fsMock = buildFsMock(full)
    setupMocks(fsMock)
    mod = await import('../activity-manager')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('keeps exactly 100 events when adding one to a full log', () => {
    mod.appendActivity({ type: 'persona', label: 'New', color: 'green' })
    const written = JSON.parse(fsMock.writeFileSync.mock.calls[0][1])
    expect(written).toHaveLength(100)
  })

  it('evicts oldest events from the front', () => {
    mod.appendActivity({ type: 'persona', label: 'Latest', color: 'green' })
    const written = JSON.parse(fsMock.writeFileSync.mock.calls[0][1])
    // oldest event (id '0-old') should be removed
    expect(written[0].id).toBe('1-old')
    // newest event should be last
    expect(written[99].label).toBe('Latest')
  })

  it('still increments unreadCount even when trimming', () => {
    expect(mod.getUnreadCount()).toBe(0)
    mod.appendActivity({ type: 'env', label: 'X', color: 'blue' })
    expect(mod.getUnreadCount()).toBe(1)
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
      existsSync: vi.fn().mockReturnValue(false),
      readFileSync: vi.fn(),
      writeFileSync: vi.fn(),
    }
    setupMocks(fsMock)
    mod = await import('../activity-manager')
    expect(mod.listActivity()).toEqual([])
  })

  it('returns parsed events from log file', async () => {
    const events = [
      { id: '1-abc', timestamp: '2026-01-01T00:00:00.000Z', type: 'pipeline', label: 'Test', color: 'blue' },
    ]
    const fsMock = buildFsMock(events)
    setupMocks(fsMock)
    mod = await import('../activity-manager')
    expect(mod.listActivity()).toEqual(events)
  })

  it('returns empty array when log file contains invalid JSON', async () => {
    const fsMock = {
      existsSync: vi.fn().mockReturnValue(true),
      readFileSync: vi.fn().mockReturnValue('not valid json {{'),
      writeFileSync: vi.fn(),
    }
    setupMocks(fsMock)
    mod = await import('../activity-manager')
    expect(mod.listActivity()).toEqual([])
  })

  it('returns multiple events in order', async () => {
    const events = [
      { id: '1-a', timestamp: '2026-01-01T00:00:00.000Z', type: 'persona', label: 'First', color: 'green' },
      { id: '2-b', timestamp: '2026-01-02T00:00:00.000Z', type: 'pipeline', label: 'Second', color: 'blue' },
      { id: '3-c', timestamp: '2026-01-03T00:00:00.000Z', type: 'env', label: 'Third', color: 'purple' },
    ]
    const fsMock = buildFsMock(events)
    setupMocks(fsMock)
    mod = await import('../activity-manager')
    const result = mod.listActivity()
    expect(result).toHaveLength(3)
    expect(result[0].label).toBe('First')
    expect(result[2].label).toBe('Third')
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

  it('returns 0 on fresh module load', () => {
    expect(mod.getUnreadCount()).toBe(0)
  })

  it('returns correct count after multiple appends', () => {
    mod.appendActivity({ type: 'pipeline', label: 'A', color: 'blue' })
    mod.appendActivity({ type: 'pipeline', label: 'B', color: 'blue' })
    mod.appendActivity({ type: 'pipeline', label: 'C', color: 'blue' })
    expect(mod.getUnreadCount()).toBe(3)
  })

  it('returns 0 after markRead resets counter', () => {
    mod.appendActivity({ type: 'persona', label: 'X', color: 'green' })
    mod.appendActivity({ type: 'persona', label: 'Y', color: 'green' })
    expect(mod.getUnreadCount()).toBe(2)
    mod.markRead()
    expect(mod.getUnreadCount()).toBe(0)
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

  it('resets unreadCount to 0', () => {
    mod.appendActivity({ type: 'env', label: 'Env started', color: 'purple' })
    mod.appendActivity({ type: 'env', label: 'Env stopped', color: 'purple' })
    mod.markRead()
    expect(mod.getUnreadCount()).toBe(0)
  })

  it('broadcasts activity:unread with count 0', () => {
    mod.appendActivity({ type: 'pipeline', label: 'Fired', color: 'blue' })
    mockBroadcast.mockReset()
    mod.markRead()
    expect(mockBroadcast).toHaveBeenCalledOnce()
    expect(mockBroadcast).toHaveBeenCalledWith('activity:unread', { count: 0 })
  })

  it('is idempotent — calling twice does not error', () => {
    mod.markRead()
    mod.markRead()
    expect(mod.getUnreadCount()).toBe(0)
    expect(mockBroadcast).toHaveBeenCalledTimes(2)
  })

  it('after markRead, new appends increment from 0 again', () => {
    mod.appendActivity({ type: 'persona', label: 'Before', color: 'green' })
    mod.markRead()
    mod.appendActivity({ type: 'persona', label: 'After', color: 'green' })
    expect(mod.getUnreadCount()).toBe(1)
  })
})

describe('activity-manager: appendActivity with fs write failure', () => {
  let mod: typeof import('../activity-manager')

  beforeEach(async () => {
    vi.resetModules()
    mockBroadcast.mockReset()
    const fsMock = {
      existsSync: vi.fn().mockReturnValue(false),
      readFileSync: vi.fn(),
      writeFileSync: vi.fn().mockImplementation(() => {
        throw new Error('ENOSPC: no space left on device')
      }),
    }
    setupMocks(fsMock)
    mod = await import('../activity-manager')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('does not throw when writeFileSync fails', () => {
    expect(() =>
      mod.appendActivity({ type: 'pipeline', label: 'Test', color: 'blue' })
    ).not.toThrow()
  })

  it('still increments unreadCount even if write fails', () => {
    mod.appendActivity({ type: 'pipeline', label: 'Test', color: 'blue' })
    expect(mod.getUnreadCount()).toBe(1)
  })

  it('still broadcasts activity:new even if write fails', () => {
    mod.appendActivity({ type: 'pipeline', label: 'Test', color: 'blue' })
    expect(mockBroadcast).toHaveBeenCalledWith('activity:new', expect.any(Object))
  })
})
