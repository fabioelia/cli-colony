/**
 * Tests for src/main/notifications.ts
 *
 * The module depends on electron (BrowserWindow, Notification), settings, and broadcast.
 * We use vi.resetModules() + vi.doMock() + dynamic import per test so the module picks
 * up fresh mocks each time.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── Shared mock state ────────────────────────────────────────────────────────

const mockNotificationInstance = {
  on: vi.fn(),
  show: vi.fn(),
}

const mockNotificationConstructor = vi.fn(() => mockNotificationInstance)
const mockIsSupported = vi.fn(() => true)
const mockGetSetting = vi.fn(() => '')
const mockBroadcast = vi.fn()
const mockAllWindows = vi.fn(() => [])

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

  it('does not show notification when notificationsEnabled is "false"', () => {
    mockGetSetting.mockReturnValue('false')
    mod.notify('Title', 'Body')
    expect(mockNotificationConstructor).not.toHaveBeenCalled()
  })

  it('shows notification when notificationsEnabled is empty string (default on)', () => {
    mockGetSetting.mockReturnValue('')
    mod.notify('Title', 'Body')
    expect(mockNotificationConstructor).toHaveBeenCalled()
    expect(mockNotificationInstance.show).toHaveBeenCalled()
  })

  it('shows notification when notificationsEnabled is "true"', () => {
    mockGetSetting.mockReturnValue('true')
    mod.notify('Title', 'Body')
    expect(mockNotificationConstructor).toHaveBeenCalled()
    expect(mockNotificationInstance.show).toHaveBeenCalled()
  })

  // ─── isSupported guard ──────────────────────────────────────────────────────

  it('does not show notification when Notification.isSupported() is false', () => {
    mockIsSupported.mockReturnValue(false)
    mod.notify('Title', 'Body')
    expect(mockNotificationConstructor).not.toHaveBeenCalled()
  })

  // ─── Notification construction ──────────────────────────────────────────────

  it('creates notification with correct title and body', () => {
    mod.notify('My Title', 'My Body')
    expect(mockNotificationConstructor).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'My Title', body: 'My Body' })
    )
  })

  it('creates notification with silent:true', () => {
    mod.notify('T', 'B')
    expect(mockNotificationConstructor).toHaveBeenCalledWith(
      expect.objectContaining({ silent: true })
    )
  })

  it('registers a click handler and calls show()', () => {
    mod.notify('T', 'B')
    expect(mockNotificationInstance.on).toHaveBeenCalledWith('click', expect.any(Function))
    expect(mockNotificationInstance.show).toHaveBeenCalledTimes(1)
  })

  // ─── Click handler ──────────────────────────────────────────────────────────

  function getClickHandler(): () => void {
    mod.notify('T', 'B')
    const call = mockNotificationInstance.on.mock.calls.find(([event]) => event === 'click')
    expect(call).toBeDefined()
    return call![1] as () => void
  }

  it('click handler focuses the window when one exists', () => {
    const mockWin = { isDestroyed: () => false, show: vi.fn(), focus: vi.fn() }
    mockAllWindows.mockReturnValue([mockWin])
    const clickHandler = getClickHandler()
    clickHandler()
    expect(mockWin.show).toHaveBeenCalled()
    expect(mockWin.focus).toHaveBeenCalled()
  })

  it('click handler does not crash when no windows exist', () => {
    mockAllWindows.mockReturnValue([])
    const clickHandler = getClickHandler()
    expect(() => clickHandler()).not.toThrow()
    expect(mockBroadcast).not.toHaveBeenCalled()
  })

  it('click handler does not focus a destroyed window', () => {
    const mockWin = { isDestroyed: () => true, show: vi.fn(), focus: vi.fn() }
    mockAllWindows.mockReturnValue([mockWin])
    const clickHandler = getClickHandler()
    clickHandler()
    expect(mockWin.show).not.toHaveBeenCalled()
    expect(mockWin.focus).not.toHaveBeenCalled()
  })

  it('click handler broadcasts route when route string is provided', () => {
    const mockWin = { isDestroyed: () => false, show: vi.fn(), focus: vi.fn() }
    mockAllWindows.mockReturnValue([mockWin])
    mod.notify('T', 'B', 'pipelines')
    const call = mockNotificationInstance.on.mock.calls.find(([e]) => e === 'click')
    const clickHandler = call![1] as () => void
    clickHandler()
    expect(mockBroadcast).toHaveBeenCalledWith('app:navigate', { route: 'pipelines' })
  })

  it('click handler broadcasts route when route is an object', () => {
    const mockWin = { isDestroyed: () => false, show: vi.fn(), focus: vi.fn() }
    mockAllWindows.mockReturnValue([mockWin])
    mod.notify('T', 'B', { type: 'session', id: 'abc123' })
    const call = mockNotificationInstance.on.mock.calls.find(([e]) => e === 'click')
    const clickHandler = call![1] as () => void
    clickHandler()
    expect(mockBroadcast).toHaveBeenCalledWith('app:navigate', {
      route: { type: 'session', id: 'abc123' },
    })
  })

  it('click handler does not broadcast when no route provided', () => {
    const mockWin = { isDestroyed: () => false, show: vi.fn(), focus: vi.fn() }
    mockAllWindows.mockReturnValue([mockWin])
    mod.notify('T', 'B')
    const call = mockNotificationInstance.on.mock.calls.find(([e]) => e === 'click')
    const clickHandler = call![1] as () => void
    clickHandler()
    expect(mockBroadcast).not.toHaveBeenCalled()
  })
})
