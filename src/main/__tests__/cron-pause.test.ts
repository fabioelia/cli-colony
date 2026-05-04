import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockGetSettings = vi.fn()
const mockSetSetting = vi.fn()
const mockGetSettingSync = vi.fn()
const mockBroadcast = vi.fn()
const mockAppendActivity = vi.fn().mockResolvedValue(undefined)

vi.mock('../settings', () => ({
  getSettings: (...args: unknown[]) => mockGetSettings(...args),
  setSetting: (...args: unknown[]) => mockSetSetting(...args),
  getSettingSync: (...args: unknown[]) => mockGetSettingSync(...args),
}))

vi.mock('../broadcast', () => ({
  broadcast: (...args: unknown[]) => mockBroadcast(...args),
}))

vi.mock('../activity-manager', () => ({
  appendActivity: (...args: unknown[]) => mockAppendActivity(...args),
}))

import { isCronsPaused, isCronsPausedSync, setCronsPaused } from '../cron-pause'

describe('cron-pause', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSetSetting.mockResolvedValue(undefined)
  })

  describe('isCronsPaused', () => {
    it('returns true when setting is "true"', async () => {
      mockGetSettings.mockResolvedValue({ cronsPaused: 'true' })
      expect(await isCronsPaused()).toBe(true)
    })

    it('returns false when setting is "false"', async () => {
      mockGetSettings.mockResolvedValue({ cronsPaused: 'false' })
      expect(await isCronsPaused()).toBe(false)
    })

    it('returns false when setting is absent', async () => {
      mockGetSettings.mockResolvedValue({})
      expect(await isCronsPaused()).toBe(false)
    })
  })

  describe('isCronsPausedSync', () => {
    it('returns true when cached setting is "true"', () => {
      mockGetSettingSync.mockReturnValue('true')
      expect(isCronsPausedSync()).toBe(true)
    })

    it('returns false when cached setting is "false"', () => {
      mockGetSettingSync.mockReturnValue('false')
      expect(isCronsPausedSync()).toBe(false)
    })

    it('returns false when cached setting is undefined', () => {
      mockGetSettingSync.mockReturnValue(undefined)
      expect(isCronsPausedSync()).toBe(false)
    })
  })

  describe('setCronsPaused', () => {
    it('sets cronsPaused to "true" and broadcasts when pausing', async () => {
      await setCronsPaused(true)
      expect(mockSetSetting).toHaveBeenCalledWith('cronsPaused', 'true')
      expect(mockBroadcast).toHaveBeenCalledWith('colony:cronsPauseChange', true)
    })

    it('sets cronsPaused to "false" and broadcasts when resuming', async () => {
      await setCronsPaused(false)
      expect(mockSetSetting).toHaveBeenCalledWith('cronsPaused', 'false')
      expect(mockBroadcast).toHaveBeenCalledWith('colony:cronsPauseChange', false)
    })

    it('appends activity with pause message when pausing', async () => {
      await setCronsPaused(true)
      expect(mockAppendActivity).toHaveBeenCalledWith(
        expect.objectContaining({ summary: 'All cron jobs paused manually' })
      )
    })

    it('appends activity with resume message when resuming', async () => {
      await setCronsPaused(false)
      expect(mockAppendActivity).toHaveBeenCalledWith(
        expect.objectContaining({ summary: 'All cron jobs resumed manually' })
      )
    })

    it('activity source is pipeline', async () => {
      await setCronsPaused(true)
      expect(mockAppendActivity).toHaveBeenCalledWith(
        expect.objectContaining({ source: 'pipeline', level: 'info' })
      )
    })
  })
})
