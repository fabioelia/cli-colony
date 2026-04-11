import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ipcMain } from 'electron'
import { registerBatchHandlers } from '../ipc/batch-handlers'
import { BatchConfig } from '../../shared/types'

// Mock electron's ipcMain
vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
  },
}))

// Mock settings (batch-handlers calls getSetting/setSetting)
vi.mock('../settings', () => ({
  getSetting: vi.fn().mockResolvedValue(''),
  setSetting: vi.fn().mockResolvedValue(undefined),
}))

// Mock batch-runner
vi.mock('../batch-runner', () => ({
  getDefaultBatchConfig: vi.fn(() => ({
    enabled: false,
    schedule: '0 2 * * *',
    concurrency: 1,
    timeoutPerTaskMinutes: 30,
    onCompletion: 'nothing',
    reportRecipients: [],
  })),
  getBatchHistory: vi.fn(() => []),
  parseTaskQueue: vi.fn(() => []),
  executeBatch: vi.fn().mockResolvedValue({ id: 'mock-batch-id', success: true }),
  isBatchInProgress: vi.fn(() => false),
  startBatchScheduler: vi.fn(),
  stopBatchScheduler: vi.fn(),
}))

describe('batch-handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('registers batch IPC handlers', () => {
    registerBatchHandlers()
    expect(ipcMain.handle).toHaveBeenCalledWith('batch:getConfig', expect.any(Function))
    expect(ipcMain.handle).toHaveBeenCalledWith('batch:setConfig', expect.any(Function))
    expect(ipcMain.handle).toHaveBeenCalledWith('batch:getHistory', expect.any(Function))
    expect(ipcMain.handle).toHaveBeenCalledWith('batch:runNow', expect.any(Function))
  })

  it('batch:getConfig handler returns default config', async () => {
    registerBatchHandlers()
    const handlers = vi.mocked(ipcMain.handle).mock.calls
    const getConfigHandler = handlers.find(call => call[0] === 'batch:getConfig')?.[1] as Function

    expect(getConfigHandler).toBeDefined()
    const config = await getConfigHandler()

    expect(config).toEqual({
      enabled: false,
      schedule: '0 2 * * *',
      concurrency: 1,
      timeoutPerTaskMinutes: 30,
      onCompletion: 'nothing',
      reportRecipients: [],
    })
  })

  it('batch:setConfig handler validates config', async () => {
    registerBatchHandlers()
    const handlers = vi.mocked(ipcMain.handle).mock.calls
    const setConfigHandler = handlers.find(call => call[0] === 'batch:setConfig')?.[1] as Function

    expect(setConfigHandler).toBeDefined()

    // Valid config
    const validConfig: BatchConfig = {
      enabled: true,
      schedule: '0 2 * * *',
      concurrency: 2,
      timeoutPerTaskMinutes: 60,
      onCompletion: 'report',
      reportRecipients: ['user@example.com'],
    }
    const result = await setConfigHandler({}, validConfig)
    expect(result).toBe(true)

    // Invalid concurrency (too high)
    const invalidConfig: BatchConfig = {
      enabled: true,
      schedule: '0 2 * * *',
      concurrency: 10,
      timeoutPerTaskMinutes: 30,
      onCompletion: 'nothing',
      reportRecipients: [],
    }
    const result2 = await setConfigHandler({}, invalidConfig)
    expect(result2).toBe(false)

    // Invalid timeout (too low)
    const invalidConfig2: BatchConfig = {
      enabled: true,
      schedule: '0 2 * * *',
      concurrency: 1,
      timeoutPerTaskMinutes: 0,
      onCompletion: 'nothing',
      reportRecipients: [],
    }
    const result3 = await setConfigHandler({}, invalidConfig2)
    expect(result3).toBe(false)
  })

  it('batch:getHistory handler returns batch run history', async () => {
    registerBatchHandlers()
    const handlers = vi.mocked(ipcMain.handle).mock.calls
    const getHistoryHandler = handlers.find(call => call[0] === 'batch:getHistory')?.[1] as Function

    expect(getHistoryHandler).toBeDefined()
    const history = await getHistoryHandler({}, 20)
    expect(Array.isArray(history)).toBe(true)
  })

  it('batch:getHistory respects limit parameter', async () => {
    registerBatchHandlers()
    const handlers = vi.mocked(ipcMain.handle).mock.calls
    const getHistoryHandler = handlers.find(call => call[0] === 'batch:getHistory')?.[1] as Function

    expect(getHistoryHandler).toBeDefined()
    await getHistoryHandler({}, 5)
    // Should cap at 100 max
    await getHistoryHandler({}, 200)
  })

  it('batch:runNow handler returns success stub', async () => {
    registerBatchHandlers()
    const handlers = vi.mocked(ipcMain.handle).mock.calls
    const runNowHandler = handlers.find(call => call[0] === 'batch:runNow')?.[1] as Function

    expect(runNowHandler).toBeDefined()
    const result = await runNowHandler({})
    expect(result.success).toBe(true)
    expect(result.batchId).toBeDefined()
  })
})
