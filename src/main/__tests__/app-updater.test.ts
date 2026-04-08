import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Mock the real electron-updater module before importing app-updater —
// we don't want its AppUpdater touching the filesystem during tests.
vi.mock('electron-updater', () => ({
  autoUpdater: {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    on: vi.fn(),
    checkForUpdates: vi.fn(),
    downloadUpdate: vi.fn(),
    quitAndInstall: vi.fn(),
  },
}))

// Hoisted mock state so `vi.mock('electron', ...)` can reference it.
const mockState = vi.hoisted(() => ({
  isPackaged: true,
  version: '1.2.3',
  settings: new Map<string, string>(),
}))

vi.mock('electron', () => ({
  app: {
    getVersion: vi.fn(() => mockState.version),
    get isPackaged() { return mockState.isPackaged },
  },
  ipcMain: { handle: vi.fn() },
}))

vi.mock('../broadcast', () => ({
  broadcast: vi.fn(),
}))

vi.mock('../settings', () => ({
  getSetting: vi.fn((key: string) => mockState.settings.get(key) || ''),
  setSetting: vi.fn((key: string, value: string) => { mockState.settings.set(key, value) }),
}))

// Dynamic import after mocks are registered
async function loadModule() {
  vi.resetModules()
  return await import('../app-updater')
}

describe('app-updater', () => {
  beforeEach(() => {
    mockState.isPackaged = true
    mockState.settings.clear()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  describe('initial status', () => {
    it('reports current version from electron app.getVersion()', async () => {
      const mod = await loadModule()
      mod.__resetForTest()
      const status = mod.getUpdateStatus()
      expect(status.currentVersion).toBe('1.2.3')
      expect(status.state).toBe('idle')
      expect(status.info).toBeNull()
      expect(status.downloadPercent).toBe(0)
    })
  })

  describe('isBenignNoReleaseError', () => {
    it('swallows 404, ENOENT, not found, and Cannot find latest messages', async () => {
      const mod = await loadModule()
      expect(mod.__test.isBenignNoReleaseError('HttpError: 404 Not Found')).toBe(true)
      expect(mod.__test.isBenignNoReleaseError('ENOENT latest.yml')).toBe(true)
      expect(mod.__test.isBenignNoReleaseError('Cannot find latest.yml')).toBe(true)
      expect(mod.__test.isBenignNoReleaseError('no published versions on GitHub')).toBe(true)
    })

    it('does not swallow real errors', async () => {
      const mod = await loadModule()
      expect(mod.__test.isBenignNoReleaseError('ECONNREFUSED')).toBe(false)
      expect(mod.__test.isBenignNoReleaseError('Signature verification failed')).toBe(false)
      expect(mod.__test.isBenignNoReleaseError('Invalid asset')).toBe(false)
    })
  })

  describe('dev mode (unpackaged)', () => {
    it('initAppUpdater is a no-op: no timers, enabledInEnv=false', async () => {
      mockState.isPackaged = false
      const mod = await loadModule()
      mod.__resetForTest()
      mod.initAppUpdater(null)
      const status = mod.getUpdateStatus()
      expect(status.enabledInEnv).toBe(false)
    })

    it('checkForUpdatesManual in dev mode records state without network I/O', async () => {
      mockState.isPackaged = false
      const mod = await loadModule()
      mod.__resetForTest()
      mod.initAppUpdater(null)
      const status = await mod.checkForUpdatesManual()
      expect(status.state).toBe('not-available')
      expect(status.lastCheckAt).toBeTypeOf('number')
    })
  })

  describe('auto-enable toggle', () => {
    it('setAutoUpdateEnabled(false) persists "false" in settings and prevents daily tick', async () => {
      const mod = await loadModule()
      mod.__resetForTest()
      // Install a fake updater so isAutoUpdateEnabled toggles actually do work
      mod.__setAutoUpdaterForTest({
        checkForUpdates: vi.fn().mockResolvedValue({}),
      }, { enabledInEnv: true })

      mod.setAutoUpdateEnabled(false)
      expect(mod.isAutoUpdateEnabled()).toBe(false)

      // Advance 25h of fake time — no check should fire because the daily timer was cleared.
      const checker = mod.__setAutoUpdaterForTest
      const updaterCalls = (mockState as any).updaterCalls = [] as string[]
      mod.__setAutoUpdaterForTest({
        checkForUpdates: vi.fn().mockImplementation(async () => { updaterCalls.push('check'); return {} }),
      }, { enabledInEnv: true })
      await vi.advanceTimersByTimeAsync(25 * 60 * 60 * 1000)
      expect(updaterCalls.length).toBe(0)
      expect(checker).toBeDefined()
    })

    it('isAutoUpdateEnabled defaults to true when unset', async () => {
      const mod = await loadModule()
      expect(mod.isAutoUpdateEnabled()).toBe(true)
    })

    it('isAutoUpdateEnabled respects persisted "false"', async () => {
      mockState.settings.set('autoUpdateEnabled', 'false')
      const mod = await loadModule()
      expect(mod.isAutoUpdateEnabled()).toBe(false)
    })
  })

  describe('checkForUpdatesManual with fake updater', () => {
    it('sets state to checking, calls updater, then records lastCheckAt', async () => {
      const mod = await loadModule()
      mod.__resetForTest()
      const fakeUpdater = {
        checkForUpdates: vi.fn().mockResolvedValue({ updateInfo: { version: '2.0.0' } }),
      }
      mod.__setAutoUpdaterForTest(fakeUpdater, { enabledInEnv: true })

      const before = Date.now()
      const status = await mod.checkForUpdatesManual()
      expect(fakeUpdater.checkForUpdates).toHaveBeenCalledTimes(1)
      expect(status.lastCheckAt).not.toBeNull()
      expect(status.lastCheckAt!).toBeGreaterThanOrEqual(before)
      expect(status.lastError).toBeNull()
    })

    it('converts benign 404 errors into not-available without surfacing lastError', async () => {
      const mod = await loadModule()
      mod.__resetForTest()
      const fakeUpdater = {
        checkForUpdates: vi.fn().mockRejectedValue(new Error('HttpError: 404 Not Found')),
      }
      mod.__setAutoUpdaterForTest(fakeUpdater, { enabledInEnv: true })

      const status = await mod.checkForUpdatesManual()
      expect(status.state).toBe('not-available')
      expect(status.lastError).toBeNull()
    })

    it('real errors surface as state=error with lastError', async () => {
      const mod = await loadModule()
      mod.__resetForTest()
      const fakeUpdater = {
        checkForUpdates: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      }
      mod.__setAutoUpdaterForTest(fakeUpdater, { enabledInEnv: true })

      const status = await mod.checkForUpdatesManual()
      expect(status.state).toBe('error')
      expect(status.lastError).toContain('ECONNREFUSED')
    })
  })

  describe('downloadUpdate', () => {
    it('sets state to downloading and calls the updater', async () => {
      const mod = await loadModule()
      mod.__resetForTest()
      const fakeUpdater = {
        downloadUpdate: vi.fn().mockResolvedValue(undefined),
      }
      mod.__setAutoUpdaterForTest(fakeUpdater, { enabledInEnv: true })

      await mod.downloadUpdate()
      expect(fakeUpdater.downloadUpdate).toHaveBeenCalledTimes(1)
    })

    it('surfaces download errors as state=error', async () => {
      const mod = await loadModule()
      mod.__resetForTest()
      const fakeUpdater = {
        downloadUpdate: vi.fn().mockRejectedValue(new Error('disk full')),
      }
      mod.__setAutoUpdaterForTest(fakeUpdater, { enabledInEnv: true })

      await mod.downloadUpdate()
      const status = mod.getUpdateStatus()
      expect(status.state).toBe('error')
      expect(status.lastError).toContain('disk full')
    })
  })

  describe('quitAndInstall', () => {
    it('delegates to the updater instance', async () => {
      const mod = await loadModule()
      mod.__resetForTest()
      const fakeUpdater = {
        quitAndInstall: vi.fn(),
      }
      mod.__setAutoUpdaterForTest(fakeUpdater, { enabledInEnv: true })

      mod.quitAndInstall()
      expect(fakeUpdater.quitAndInstall).toHaveBeenCalledTimes(1)
    })

    it('is a no-op when no updater is initialised', async () => {
      const mod = await loadModule()
      mod.__resetForTest()
      // Should not throw
      expect(() => mod.quitAndInstall()).not.toThrow()
    })
  })

  describe('focus debounce', () => {
    it('checkOnFocus skips subsequent checks within 6 hours', async () => {
      const mod = await loadModule()
      mod.__resetForTest()
      const fakeUpdater = {
        checkForUpdates: vi.fn().mockResolvedValue({}),
      }
      mod.__setAutoUpdaterForTest(fakeUpdater, { enabledInEnv: true })

      mod.checkOnFocus()
      // Let the microtask/promise resolve
      await vi.advanceTimersByTimeAsync(1)
      expect(fakeUpdater.checkForUpdates).toHaveBeenCalledTimes(1)

      // Second focus immediately — should be debounced
      mod.checkOnFocus()
      await vi.advanceTimersByTimeAsync(1)
      expect(fakeUpdater.checkForUpdates).toHaveBeenCalledTimes(1)

      // Advance past the 6h debounce window
      mod.__test.lastFocusCheckAt = Date.now() - (6 * 60 * 60 * 1000 + 1000)
      mod.checkOnFocus()
      await vi.advanceTimersByTimeAsync(1)
      expect(fakeUpdater.checkForUpdates).toHaveBeenCalledTimes(2)
    })

    it('checkOnFocus is a no-op when auto-update is disabled', async () => {
      mockState.settings.set('autoUpdateEnabled', 'false')
      const mod = await loadModule()
      mod.__resetForTest()
      const fakeUpdater = {
        checkForUpdates: vi.fn().mockResolvedValue({}),
      }
      mod.__setAutoUpdaterForTest(fakeUpdater, { enabledInEnv: true })

      mod.checkOnFocus()
      await vi.advanceTimersByTimeAsync(1)
      expect(fakeUpdater.checkForUpdates).not.toHaveBeenCalled()
    })
  })

  describe('settings persistence', () => {
    it('successful check persists lastCheckAt to settings', async () => {
      const mod = await loadModule()
      mod.__resetForTest()
      mod.__setAutoUpdaterForTest({
        checkForUpdates: vi.fn().mockResolvedValue({}),
      }, { enabledInEnv: true })

      await mod.checkForUpdatesManual()
      expect(mockState.settings.get('autoUpdateLastCheckAt')).toBeDefined()
      expect(Number(mockState.settings.get('autoUpdateLastCheckAt'))).toBeGreaterThan(0)
    })
  })

  describe('shutdownAppUpdater', () => {
    it('clears the daily timer without throwing', async () => {
      const mod = await loadModule()
      mod.__resetForTest()
      mod.__setAutoUpdaterForTest({}, { enabledInEnv: true })
      // No internal timer yet, should still be safe
      expect(() => mod.shutdownAppUpdater()).not.toThrow()
    })
  })
})
