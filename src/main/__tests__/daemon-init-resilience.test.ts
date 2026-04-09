import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock dependencies before importing the module
const mockConnect = vi.hoisted(() => vi.fn())
const mockKillDaemonProcess = vi.hoisted(() => vi.fn())
const mockOn = vi.hoisted(() => vi.fn())

vi.mock('../daemon-client', () => ({
  getDaemonClient: () => ({
    connect: mockConnect,
    killDaemonProcess: mockKillDaemonProcess,
    on: mockOn,
  }),
  DaemonClient: class {},
}))
vi.mock('../settings', () => ({
  getDefaultArgs: vi.fn(() => []),
  getSetting: vi.fn(() => ''),
  getDefaultCliBackend: vi.fn(() => 'claude'),
}))
vi.mock('../notifications', () => ({ notify: vi.fn() }))
vi.mock('electron', () => ({ app: { getPath: vi.fn(() => '/mock/home') } }))
vi.mock('../broadcast', () => ({ broadcast: vi.fn() }))
vi.mock('../../shared/colony-paths', () => ({
  colonyPaths: {
    root: '/mock/.claude-colony',
    onboardingStateJson: '/mock/.claude-colony/onboarding-state.json',
  },
}))

async function loadModule() {
  vi.resetModules()
  // Re-apply mocks after reset
  vi.doMock('../daemon-client', () => ({
    getDaemonClient: () => ({
      connect: mockConnect,
      killDaemonProcess: mockKillDaemonProcess,
      on: mockOn,
    }),
    DaemonClient: class {},
  }))
  vi.doMock('../settings', () => ({
    getDefaultArgs: vi.fn(() => []),
    getSetting: vi.fn(() => ''),
    getDefaultCliBackend: vi.fn(() => 'claude'),
  }))
  vi.doMock('../notifications', () => ({ notify: vi.fn() }))
  vi.doMock('electron', () => ({ app: { getPath: vi.fn(() => '/mock/home') } }))
  vi.doMock('../broadcast', () => ({ broadcast: vi.fn() }))
  vi.doMock('../../shared/colony-paths', () => ({
    colonyPaths: {
      root: '/mock/.claude-colony',
      onboardingStateJson: '/mock/.claude-colony/onboarding-state.json',
    },
  }))
  return await import('../instance-manager')
}

describe('initDaemon resilience', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('connects on first attempt when daemon is healthy', async () => {
    mockConnect.mockResolvedValueOnce(undefined)
    const mod = await loadModule()
    await mod.initDaemon()
    expect(mockConnect).toHaveBeenCalledTimes(1)
    expect(mockKillDaemonProcess).not.toHaveBeenCalled()
  })

  it('retries after first failure and succeeds on second attempt', async () => {
    mockConnect
      .mockRejectedValueOnce(new Error('subscribe timed out'))
      .mockResolvedValueOnce(undefined)
    const mod = await loadModule()
    await mod.initDaemon()
    expect(mockConnect).toHaveBeenCalledTimes(2)
    expect(mockKillDaemonProcess).toHaveBeenCalledTimes(1)
  })

  it('retries up to 3 times, killing daemon between attempts', async () => {
    mockConnect
      .mockRejectedValueOnce(new Error('timeout 1'))
      .mockRejectedValueOnce(new Error('timeout 2'))
      .mockResolvedValueOnce(undefined)
    const mod = await loadModule()
    await mod.initDaemon()
    expect(mockConnect).toHaveBeenCalledTimes(3)
    expect(mockKillDaemonProcess).toHaveBeenCalledTimes(2)
  })

  it('throws after 3 failed attempts', async () => {
    mockConnect
      .mockRejectedValueOnce(new Error('timeout 1'))
      .mockRejectedValueOnce(new Error('timeout 2'))
      .mockRejectedValueOnce(new Error('timeout 3'))
    const mod = await loadModule()
    await expect(mod.initDaemon()).rejects.toThrow('daemon init failed after 3 attempts')
    expect(mockConnect).toHaveBeenCalledTimes(3)
    expect(mockKillDaemonProcess).toHaveBeenCalledTimes(2)
  })

  it('does not kill daemon process after the final failed attempt', async () => {
    mockConnect.mockRejectedValue(new Error('always fails'))
    const mod = await loadModule()
    await expect(mod.initDaemon()).rejects.toThrow()
    // killDaemonProcess should only be called between retries (2 times for 3 attempts)
    expect(mockKillDaemonProcess).toHaveBeenCalledTimes(2)
  })
})
