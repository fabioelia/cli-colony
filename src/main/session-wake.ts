import { promises as fsp, watch, FSWatcher, existsSync } from 'fs'
import { join, basename } from 'path'
import { colonyPaths } from '../shared/colony-paths'
import { createInstance } from './instance-manager'

interface WakeRequest {
  delay: number
  prompt: string
  workingDirectory: string
  model?: string
  note?: string
}

interface PendingWake {
  timers: NodeJS.Timeout[]
  count: number
}

const MAX_DELAY_S = 86400
const MAX_PER_SESSION = 5

const _pending = new Map<string, PendingWake>()
let _watcher: FSWatcher | null = null
let _pollInterval: NodeJS.Timeout | null = null

async function processWakeFile(filePath: string): Promise<void> {
  let raw: string
  try {
    raw = await fsp.readFile(filePath, 'utf-8')
  } catch {
    return
  }

  let req: WakeRequest
  try {
    req = JSON.parse(raw) as WakeRequest
  } catch {
    console.warn('[wake] malformed JSON in', filePath)
    await fsp.unlink(filePath).catch(() => {})
    return
  }

  if (
    typeof req.delay !== 'number' ||
    req.delay < 60 ||
    req.delay > MAX_DELAY_S ||
    typeof req.prompt !== 'string' ||
    !req.prompt.trim() ||
    typeof req.workingDirectory !== 'string' ||
    !req.workingDirectory.trim()
  ) {
    console.warn('[wake] invalid fields in', filePath)
    await fsp.unlink(filePath).catch(() => {})
    return
  }

  // Extract instanceId from filename: {instanceId}.json
  const instanceId = basename(filePath, '.json')

  const entry = _pending.get(instanceId) ?? { timers: [], count: 0 }
  if (entry.count >= MAX_PER_SESSION) {
    console.warn('[wake] max pending wakes reached for', instanceId)
    await fsp.unlink(filePath).catch(() => {})
    return
  }

  entry.count++
  _pending.set(instanceId, entry)

  const timer = setTimeout(async () => {
    await fireWake(instanceId, req, filePath)
    const e = _pending.get(instanceId)
    if (e) {
      e.count = Math.max(0, e.count - 1)
      const idx = e.timers.indexOf(timer)
      if (idx >= 0) e.timers.splice(idx, 1)
    }
  }, req.delay * 1000)

  entry.timers.push(timer)
}

async function fireWake(instanceId: string, req: WakeRequest, filePath: string): Promise<void> {
  try {
    await createInstance({
      name: req.note ? `Wake: ${req.note}` : 'Session Self-Wake',
      workingDirectory: req.workingDirectory,
      model: req.model,
      args: ['--print', req.prompt],
      triggeredBy: instanceId,
    })
  } catch (err) {
    console.error('[wake] failed to create wake session:', err)
  }
  await fsp.unlink(filePath).catch(() => {})
}

async function scanAndSchedule(): Promise<void> {
  const dir = colonyPaths.wake
  let files: string[]
  try {
    files = await fsp.readdir(dir)
  } catch {
    return
  }

  const now = Date.now()
  for (const f of files) {
    if (!f.endsWith('.json')) continue
    const filePath = join(dir, f)

    // Check if already scheduled (watcher may have handled it)
    const instanceId = basename(filePath, '.json')
    if (_pending.has(instanceId)) continue

    // Check mtime: if file is older than MAX_DELAY_S, it's expired
    try {
      const stat = await fsp.stat(filePath)
      const ageS = (now - stat.mtimeMs) / 1000
      if (ageS > MAX_DELAY_S) {
        await fsp.unlink(filePath).catch(() => {})
        continue
      }
      // Re-schedule: remaining delay = original delay - elapsed
      let raw: string
      try { raw = await fsp.readFile(filePath, 'utf-8') } catch { continue }
      let req: WakeRequest
      try { req = JSON.parse(raw) as WakeRequest } catch { await fsp.unlink(filePath).catch(() => {}); continue }
      const remaining = Math.max(0, req.delay - ageS)
      req.delay = Math.max(60, remaining)
      await processWakeFile(filePath)
    } catch {
      continue
    }
  }
}

export async function startWakeWatcher(): Promise<void> {
  const dir = colonyPaths.wake
  await fsp.mkdir(dir, { recursive: true })

  // Scan on startup (handles files written before watcher started or after restart)
  await scanAndSchedule()

  // Clean up expired files every 30s + re-scan for stragglers
  _pollInterval = setInterval(() => { scanAndSchedule().catch(() => {}) }, 30_000)

  try {
    _watcher = watch(dir, { persistent: false }, (event, filename) => {
      if (!filename || !filename.endsWith('.json')) return
      if (event === 'rename' && existsSync(join(dir, filename))) {
        processWakeFile(join(dir, filename)).catch(() => {})
      }
    })
  } catch (err) {
    console.warn('[wake] fs.watch failed, falling back to poll:', err)
  }
}

export function stopWakeWatcher(): void {
  if (_watcher) {
    try { _watcher.close() } catch { /* */ }
    _watcher = null
  }
  if (_pollInterval) {
    clearInterval(_pollInterval)
    _pollInterval = null
  }
  for (const { timers } of _pending.values()) {
    for (const t of timers) clearTimeout(t)
  }
  _pending.clear()
}
