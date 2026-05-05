import { promises as fsp } from 'fs'
import { colonyPaths } from '../shared/colony-paths'
import type { NotificationChannel } from '../shared/types'

let _channels: NotificationChannel[] = []
let _loaded = false

async function ensureLoaded(): Promise<void> {
  if (_loaded) return
  _loaded = true
  try {
    const raw = await fsp.readFile(colonyPaths.notificationChannelsJson, 'utf-8')
    _channels = JSON.parse(raw) as NotificationChannel[]
  } catch {
    _channels = []
  }
}

async function save(): Promise<void> {
  await fsp.writeFile(colonyPaths.notificationChannelsJson, JSON.stringify(_channels, null, 2), 'utf-8')
}

export async function loadChannels(): Promise<NotificationChannel[]> {
  await ensureLoaded()
  return _channels
}

export async function saveChannels(channels: NotificationChannel[]): Promise<void> {
  _channels = channels
  await save()
}

function buildPayload(channel: NotificationChannel, title: string, body: string, source: string): string {
  const ts = new Date().toISOString()
  if (channel.type === 'slack') {
    return JSON.stringify({
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: `*${title}*\n${body}` } },
        { type: 'context', elements: [{ type: 'mrkdwn', text: `Source: ${source} | ${ts}` }] },
      ],
    })
  }
  if (channel.type === 'discord') {
    return JSON.stringify({
      embeds: [{ title, description: body, footer: { text: `${source} | ${ts}` }, color: 0x34d399 }],
    })
  }
  return JSON.stringify({ title, body, source, timestamp: ts })
}

function sourceMatches(channel: NotificationChannel, source: string): boolean {
  if (!channel.filters || channel.filters.length === 0) return true
  if (channel.filters.includes('all')) return true
  return channel.filters.some(f => source?.toLowerCase().includes(f.toLowerCase()))
}

export async function fireWebhookChannels(title: string, body: string, source: string): Promise<void> {
  await ensureLoaded()
  const active = _channels.filter(c => c.enabled && sourceMatches(c, source))
  if (!active.length) return

  await Promise.allSettled(
    active.map(ch => {
      const payload = buildPayload(ch, title, body, source)
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 5000)
      return fetch(ch.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        signal: ctrl.signal,
      }).finally(() => clearTimeout(timer))
    })
  )
}

export async function testChannel(channel: NotificationChannel): Promise<{ ok: boolean; error?: string }> {
  const payload = buildPayload(channel, 'Colony Test Notification', 'This is a test from Colony.', 'system')
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 5000)
  try {
    const res = await fetch(channel.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      signal: ctrl.signal,
    })
    clearTimeout(timer)
    if (res.ok) return { ok: true }
    return { ok: false, error: `HTTP ${res.status}` }
  } catch (err: unknown) {
    clearTimeout(timer)
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
