/**
 * Tests for src/main/notifications.ts
 *
 * The module depends on electron (BrowserWindow, Notification), settings, and broadcast.
 * We use vi.resetModules() + vi.doMock() + dynamic import per test so the module picks
 * up fresh mocks each time.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ─── Shared mock state ────────────────────────────────────────────────────────

const mockNotificationInstance = {
  on: vi.fn(),
  show: vi.fn(),
}

const mockNotificationConstructor = vi.fn(() => mockNotificationInstance)
const mockIsSupported = vi.fn(() => true)
const mockGetSetting = vi.fn(() => '')
const mockBroadcast = vi.fn()
const mockAllWindows = vi.fn(() => [] as object[])

// ─── Setup ────────────────────────────────────────────────────────────────────

describe('notifications module', () => {
  let mod: typeof import('../notifications')

  beforeEach(async () => {
    vi.resetModules()

    mockNotificationInstance.on.mockReset()
    mockNotificationInstance.show.mockReset()
    mockNotificationConstructor.mockReset().mockReturnValue(mockNotificationInstance)
    mockIsSupported.mockReset().mockReturnValue(true)
    mockGetSetting.mockReset().mockReturnValue('')
    mockBroadcast.mockReset()
    mockAllWindows.mockReset().mockReturnValue([])

    vi.doMock('electron', () => ({
      BrowserWindow: { getAllWindows: mockAllWindows },
      Notification: Object.assign(mockNotificationConstructor, { isSupported: mockIsSupported }),
    }))

    vi.doMock('../settings', () => ({ getSetting: mockGetSetting }))
    vi.doMock('../broadcast', () => ({ broadcast: mockBroadcast }))
    vi.doMock('path', async () => {
      const actual = await vi.importActual<typeof import('path')>('path')
      return actual
    })

    mod = await import('../notifications')
  })

  // ─── Opt-out guard ──────────────────────────────────────────────────────────

  it('does not show notification when notificationsEnabled is "false"', async () => {
    mockGetSetting.mockReturnValue('false')
    await mod.notify('Title', 'Body')
    expect(mockNotificationConstructor).not.toHaveBeenCalled()
  })

  it('shows notification when notificationsEnabled is empty string (default on)', async () => {
    mockGetSetting.mockReturnValue('')
    await mod.notify('Title', 'Body')
    expect(mockNotificationConstructor).toHaveBeenCalled()
    expect(mockNotificationInstance.show).toHaveBeenCalled()
  })

  it('shows notification when notificationsEnabled is "true"', async () => {
    mockGetSetting.mockReturnValue('true')
    await mod.notify('Title', 'Body')
    expect(mockNotificationConstructor).toHaveBeenCalled()
    expect(mockNotificationInstance.show).toHaveBeenCalled()
  })

  // ─── isSupported guard ──────────────────────────────────────────────────────

  it('does not show notification when Notification.isSupported() is false', async () => {
    mockIsSupported.mockReturnValue(false)
    await mod.notify('Title', 'Body')
    expect(mockNotificationConstructor).not.toHaveBeenCalled()
  })

  // ─── Notification construction ──────────────────────────────────────────────

  it('creates notification with correct title and body', async () => {
    await mod.notify('My Title', 'My Body')
    expect(mockNotificationConstructor).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'My Title', body: 'My Body' })
    )
  })

  it('creates notification with silent:true', async () => {
    await mod.notify('T', 'B')
    expect(mockNotificationConstructor).toHaveBeenCalledWith(
      expect.objectContaining({ silent: true })
    )
  })

  it('registers a click handler and calls show()', async () => {
    await mod.notify('T', 'B')
    expect(mockNotificationInstance.on).toHaveBeenCalledWith('click', expect.any(Function))
    expect(mockNotificationInstance.show).toHaveBeenCalledTimes(1)
  })

  // ─── Click handler ──────────────────────────────────────────────────────────

  async function getClickHandler(): Promise<() => void> {
    await mod.notify('T', 'B')
    const call = mockNotificationInstance.on.mock.calls.find(([event]) => event === 'click')
    expect(call).toBeDefined()
    return call![1] as () => void
  }

  it('click handler focuses the window when one exists', async () => {
    const mockWin = { isDestroyed: () => false, show: vi.fn(), focus: vi.fn() }
    mockAllWindows.mockReturnValue([mockWin])
    const clickHandler = await getClickHandler()
    clickHandler()
    expect(mockWin.show).toHaveBeenCalled()
    expect(mockWin.focus).toHaveBeenCalled()
  })

  it('click handler does not crash when no windows exist', async () => {
    mockAllWindows.mockReturnValue([])
    const clickHandler = await getClickHandler()
    mockBroadcast.mockClear() // clear the notification:new broadcast from notify()
    expect(() => clickHandler()).not.toThrow()
    expect(mockBroadcast).not.toHaveBeenCalled()
  })

  it('click handler does not focus a destroyed window', async () => {
    const mockWin = { isDestroyed: () => true, show: vi.fn(), focus: vi.fn() }
    mockAllWindows.mockReturnValue([mockWin])
    const clickHandler = await getClickHandler()
    clickHandler()
    expect(mockWin.show).not.toHaveBeenCalled()
    expect(mockWin.focus).not.toHaveBeenCalled()
  })

  it('click handler broadcasts route when route string is provided', async () => {
    const mockWin = { isDestroyed: () => false, show: vi.fn(), focus: vi.fn() }
    mockAllWindows.mockReturnValue([mockWin])
    await mod.notify('T', 'B', 'pipelines')
    const call = mockNotificationInstance.on.mock.calls.find(([e]) => e === 'click')
    const clickHandler = call![1] as () => void
    clickHandler()
    expect(mockBroadcast).toHaveBeenCalledWith('app:navigate', { route: 'pipelines' })
  })

  it('click handler broadcasts route when route is an object', async () => {
    const mockWin = { isDestroyed: () => false, show: vi.fn(), focus: vi.fn() }
    mockAllWindows.mockReturnValue([mockWin])
    await mod.notify('T', 'B', { type: 'session', id: 'abc123' })
    const call = mockNotificationInstance.on.mock.calls.find(([e]) => e === 'click')
    const clickHandler = call![1] as () => void
    clickHandler()
    expect(mockBroadcast).toHaveBeenCalledWith('app:navigate', {
      route: { type: 'session', id: 'abc123' },
    })
  })

  it('click handler does not broadcast navigate when no route provided', async () => {
    const mockWin = { isDestroyed: () => false, show: vi.fn(), focus: vi.fn() }
    mockAllWindows.mockReturnValue([mockWin])
    await mod.notify('T', 'B')
    const call = mockNotificationInstance.on.mock.calls.find(([e]) => e === 'click')
    const clickHandler = call![1] as () => void
    mockBroadcast.mockClear() // clear the notification:new broadcast from notify()
    clickHandler()
    expect(mockBroadcast).not.toHaveBeenCalledWith('app:navigate', expect.anything())
  })
})

// ─── History CRUD ─────────────────────────────────────────────────────────────

describe('notification history functions', () => {
  let mod: typeof import('../notifications')

  beforeEach(async () => {
    vi.resetModules()
    vi.useFakeTimers()

    vi.doMock('electron', () => ({
      BrowserWindow: { getAllWindows: vi.fn().mockReturnValue([]) },
      Notification: Object.assign(
        vi.fn().mockReturnValue({ on: vi.fn(), show: vi.fn() }),
        { isSupported: vi.fn().mockReturnValue(false) }, // don't show OS notifications
      ),
    }))
    vi.doMock('../settings', () => ({ getSetting: vi.fn().mockReturnValue('') }))
    vi.doMock('../broadcast', () => ({ broadcast: vi.fn() }))
    vi.doMock('../notification-channels', () => ({
      fireWebhookChannels: vi.fn().mockResolvedValue(undefined),
    }))
    vi.doMock('fs', () => ({
      promises: {
        readFile: vi.fn().mockRejectedValue(new Error('ENOENT')),
        writeFile: vi.fn().mockResolvedValue(undefined),
      },
    }))
    vi.doMock('path', async () => {
      const actual = await vi.importActual<typeof import('path')>('path')
      return actual
    })

    mod = await import('../notifications')
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('getHistory returns empty array on fresh module', async () => {
    const history = await mod.getHistory()
    expect(history).toEqual([])
  })

  it('getHistory returns entries in newest-first order', async () => {
    await mod.notify('First', 'Body 1')
    await mod.notify('Second', 'Body 2')
    const history = await mod.getHistory()
    expect(history).toHaveLength(2)
    expect(history[0].title).toBe('Second')
    expect(history[1].title).toBe('First')
  })

  it('getHistory entries have expected shape', async () => {
    await mod.notify('Pipeline done', 'All steps passed', 'pipelines')
    const history = await mod.getHistory()
    const entry = history[0]
    expect(entry).toMatchObject({
      title: 'Pipeline done',
      body: 'All steps passed',
      route: 'pipelines',
      read: false,
      source: 'pipeline',
    })
    expect(typeof entry.id).toBe('string')
    expect(typeof entry.timestamp).toBe('number')
  })

  it('getUnreadCount returns 0 initially', async () => {
    expect(await mod.getUnreadCount()).toBe(0)
  })

  it('getUnreadCount reflects entries added via notify()', async () => {
    await mod.notify('A', 'B')
    await mod.notify('C', 'D')
    expect(await mod.getUnreadCount()).toBe(2)
  })

  it('markRead marks a single entry as read', async () => {
    await mod.notify('Title', 'Body')
    const history = await mod.getHistory()
    const { id } = history[0]
    await mod.markRead(id)
    const updated = await mod.getHistory()
    expect(updated[0].read).toBe(true)
    expect(await mod.getUnreadCount()).toBe(0)
  })

  it('markRead ignores unknown id gracefully', async () => {
    await mod.notify('T', 'B')
    await expect(mod.markRead('unknown-id')).resolves.not.toThrow()
    expect(await mod.getUnreadCount()).toBe(1)
  })

  it('markAllRead marks all entries as read', async () => {
    await mod.notify('A', 'B')
    await mod.notify('C', 'D')
    await mod.markAllRead()
    const history = await mod.getHistory()
    expect(history.every(e => e.read)).toBe(true)
    expect(await mod.getUnreadCount()).toBe(0)
  })

  it('clearHistory removes all entries', async () => {
    await mod.notify('A', 'B')
    await mod.notify('C', 'D')
    await mod.clearHistory()
    expect(await mod.getHistory()).toEqual([])
    expect(await mod.getUnreadCount()).toBe(0)
  })

  it('inferSource maps pipeline title to pipeline source', async () => {
    await mod.notify('Pipeline failed', 'An error occurred')
    const [entry] = await mod.getHistory()
    expect(entry.source).toBe('pipeline')
  })

  it('inferSource maps persona title to persona source', async () => {
    await mod.notify('Persona finished', 'Done')
    const [entry] = await mod.getHistory()
    expect(entry.source).toBe('persona')
  })

  it('inferSource defaults to system for unknown titles', async () => {
    await mod.notify('Something happened', 'Details')
    const [entry] = await mod.getHistory()
    expect(entry.source).toBe('system')
  })

  it('explicit source overrides inferred source', async () => {
    await mod.notify('Something', 'Body', undefined, 'custom-source')
    const [entry] = await mod.getHistory()
    expect(entry.source).toBe('custom-source')
  })
})
