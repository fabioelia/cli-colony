import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NotificationChannel } from '../../shared/types'

const mockReadFile = vi.hoisted(() => vi.fn())
const mockWriteFile = vi.hoisted(() => vi.fn())
const mockFetch = vi.hoisted(() => vi.fn())

vi.mock('fs', () => ({
  promises: { readFile: mockReadFile, writeFile: mockWriteFile },
}))
vi.mock('../../shared/colony-paths', () => ({
  colonyPaths: { notificationChannelsJson: '/mock/notification-channels.json' },
}))

global.fetch = mockFetch as unknown as typeof fetch

function makeChannel(overrides: Partial<NotificationChannel> = {}): NotificationChannel {
  return {
    id: 'ch-1',
    name: 'My Channel',
    url: 'https://hooks.example.com/test',
    type: 'generic',
    enabled: true,
    filters: [],
    ...overrides,
  }
}

describe('notification-channels', () => {
  beforeEach(async () => {
    vi.resetModules()
    mockReadFile.mockReset()
    mockWriteFile.mockReset()
    mockFetch.mockReset()
  })

  async function load() {
    return import('../notification-channels')
  }

  describe('loadChannels', () => {
    it('returns empty array when file not found', async () => {
      mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
      const mod = await load()
      const result = await mod.loadChannels()
      expect(result).toEqual([])
    })

    it('returns parsed channels when file exists', async () => {
      const channels = [makeChannel()]
      mockReadFile.mockResolvedValue(JSON.stringify(channels))
      const mod = await load()
      const result = await mod.loadChannels()
      expect(result).toEqual(channels)
    })

    it('caches after first load — does not re-read file', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify([makeChannel()]))
      const mod = await load()
      await mod.loadChannels()
      await mod.loadChannels()
      expect(mockReadFile).toHaveBeenCalledTimes(1)
    })
  })

  describe('saveChannels', () => {
    it('writes JSON to the correct path', async () => {
      mockReadFile.mockRejectedValue(new Error('ENOENT'))
      mockWriteFile.mockResolvedValue(undefined)
      const mod = await load()
      const channels = [makeChannel()]
      await mod.saveChannels(channels)
      expect(mockWriteFile).toHaveBeenCalledWith(
        '/mock/notification-channels.json',
        JSON.stringify(channels, null, 2),
        'utf-8'
      )
    })

    it('subsequent loadChannels returns saved channels without re-reading file', async () => {
      // load first (sets _loaded=true), then save, then reload — no extra readFile
      mockReadFile.mockResolvedValue(JSON.stringify([]))
      mockWriteFile.mockResolvedValue(undefined)
      const mod = await load()
      await mod.loadChannels() // _loaded = true
      const channels = [makeChannel({ id: 'ch-saved' })]
      await mod.saveChannels(channels)
      const result = await mod.loadChannels()
      expect(result).toEqual(channels)
      expect(mockReadFile).toHaveBeenCalledTimes(1)
    })
  })

  describe('fireWebhookChannels', () => {
    it('does nothing when no channels', async () => {
      mockReadFile.mockRejectedValue(new Error('ENOENT'))
      const mod = await load()
      await mod.fireWebhookChannels('title', 'body', 'pipeline')
      expect(mockFetch).not.toHaveBeenCalled()
    })

    it('skips disabled channels', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify([makeChannel({ enabled: false })]))
      const mod = await load()
      await mod.fireWebhookChannels('title', 'body', 'pipeline')
      expect(mockFetch).not.toHaveBeenCalled()
    })

    it('skips channels where source does not match filter', async () => {
      const ch = makeChannel({ filters: ['persona'] })
      mockReadFile.mockResolvedValue(JSON.stringify([ch]))
      const mod = await load()
      await mod.fireWebhookChannels('title', 'body', 'pipeline')
      expect(mockFetch).not.toHaveBeenCalled()
    })

    it('fires channel when filters is empty (matches all)', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify([makeChannel({ filters: [] })]))
      mockFetch.mockResolvedValue({ ok: true, status: 200 })
      const mod = await load()
      await mod.fireWebhookChannels('title', 'body', 'pipeline')
      expect(mockFetch).toHaveBeenCalledTimes(1)
    })

    it('fires channel when filters includes "all"', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify([makeChannel({ filters: ['all'] })]))
      mockFetch.mockResolvedValue({ ok: true, status: 200 })
      const mod = await load()
      await mod.fireWebhookChannels('title', 'body', 'anything')
      expect(mockFetch).toHaveBeenCalledTimes(1)
    })

    it('fires channel when source matches filter substring', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify([makeChannel({ filters: ['pipe'] })]))
      mockFetch.mockResolvedValue({ ok: true, status: 200 })
      const mod = await load()
      await mod.fireWebhookChannels('title', 'body', 'pipeline')
      expect(mockFetch).toHaveBeenCalledTimes(1)
    })

    it('sends Slack blocks payload for slack type', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify([makeChannel({ type: 'slack' })]))
      mockFetch.mockResolvedValue({ ok: true, status: 200 })
      const mod = await load()
      await mod.fireWebhookChannels('My Title', 'My Body', 'system')
      const body = JSON.parse(mockFetch.mock.calls[0][1].body)
      expect(body).toHaveProperty('blocks')
      expect(body.blocks[0].text.text).toContain('My Title')
    })

    it('sends Discord embeds payload for discord type', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify([makeChannel({ type: 'discord' })]))
      mockFetch.mockResolvedValue({ ok: true, status: 200 })
      const mod = await load()
      await mod.fireWebhookChannels('DTitle', 'DBody', 'system')
      const body = JSON.parse(mockFetch.mock.calls[0][1].body)
      expect(body).toHaveProperty('embeds')
      expect(body.embeds[0].title).toBe('DTitle')
    })

    it('sends plain JSON payload for generic type', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify([makeChannel({ type: 'generic' })]))
      mockFetch.mockResolvedValue({ ok: true, status: 200 })
      const mod = await load()
      await mod.fireWebhookChannels('GTitle', 'GBody', 'mysource')
      const body = JSON.parse(mockFetch.mock.calls[0][1].body)
      expect(body.title).toBe('GTitle')
      expect(body.source).toBe('mysource')
    })

    it('does not throw when fetch rejects (Promise.allSettled)', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify([makeChannel()]))
      mockFetch.mockRejectedValue(new Error('network error'))
      const mod = await load()
      await expect(mod.fireWebhookChannels('t', 'b', 's')).resolves.toBeUndefined()
    })
  })

  describe('testChannel', () => {
    it('returns {ok: true} for a 2xx response', async () => {
      mockReadFile.mockRejectedValue(new Error('ENOENT'))
      mockFetch.mockResolvedValue({ ok: true, status: 200 })
      const mod = await load()
      const result = await mod.testChannel(makeChannel())
      expect(result).toEqual({ ok: true })
    })

    it('returns {ok: false, error: "HTTP 500"} for non-ok response', async () => {
      mockReadFile.mockRejectedValue(new Error('ENOENT'))
      mockFetch.mockResolvedValue({ ok: false, status: 500 })
      const mod = await load()
      const result = await mod.testChannel(makeChannel())
      expect(result).toEqual({ ok: false, error: 'HTTP 500' })
    })

    it('returns {ok: false, error: message} on network error', async () => {
      mockReadFile.mockRejectedValue(new Error('ENOENT'))
      mockFetch.mockRejectedValue(new Error('timeout'))
      const mod = await load()
      const result = await mod.testChannel(makeChannel())
      expect(result).toEqual({ ok: false, error: 'timeout' })
    })

    it('posts Content-Type: application/json', async () => {
      mockReadFile.mockRejectedValue(new Error('ENOENT'))
      mockFetch.mockResolvedValue({ ok: true, status: 200 })
      const mod = await load()
      await mod.testChannel(makeChannel({ url: 'https://example.com/hook' }))
      expect(mockFetch).toHaveBeenCalledWith(
        'https://example.com/hook',
        expect.objectContaining({ headers: { 'Content-Type': 'application/json' } })
      )
    })
  })
})
