import { app } from 'electron'
import * as fs from 'fs'
import { join } from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { resolveCommand } from './resolve-command'
import type { CommitAttribution } from '../shared/types'

const execFileAsync = promisify(execFile)

const ATTRIBUTION_PATH = join(app.getPath('home'), '.claude-colony', 'commit-attribution.json')
const MAX_ENTRIES = 200

function readEntries(): CommitAttribution[] {
  try {
    if (!fs.existsSync(ATTRIBUTION_PATH)) return []
    const raw = fs.readFileSync(ATTRIBUTION_PATH, 'utf-8')
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed as CommitAttribution[]
  } catch {
    return []
  }
}

function writeEntries(entries: CommitAttribution[]): void {
  const dir = join(app.getPath('home'), '.claude-colony')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(ATTRIBUTION_PATH, JSON.stringify(entries, null, 2), 'utf-8')
}

/**
 * Scan for git commits made during a session and append them to the attribution log.
 * Fire-and-forget — does not throw on any error.
 */
export async function scanNewCommits(
  instanceId: string,
  sessionName: string,
  dir: string,
  startedAtMs: number,
  personaName?: string,
  cost?: number
): Promise<void> {
  if (!dir) return

  try {
    // Verify it's a git repo — bail silently if not
    await execFileAsync(resolveCommand('git'), ['rev-parse', '--git-dir'], { cwd: dir, timeout: 3000 })
  } catch {
    return
  }

  try {
    const afterIso = new Date(startedAtMs).toISOString()
    const { stdout } = await execFileAsync(
      'git',
      ['log', '--format=%H|%s', `--after=${afterIso}`],
      { cwd: dir, encoding: 'utf-8', timeout: 5000 }
    )

    if (!stdout.trim()) return

    const lines = stdout.trim().split('\n').filter(Boolean)
    if (lines.length === 0) return

    const existing = readEntries()
    const existingHashes = new Set(existing.map(e => e.commitHash))
    const stoppedAt = Date.now()

    const newEntries: CommitAttribution[] = []
    for (const line of lines) {
      const pipeIdx = line.indexOf('|')
      if (pipeIdx === -1) continue
      const commitHash = line.slice(0, pipeIdx).trim()
      const shortMsg = line.slice(pipeIdx + 1).trim()
      if (!commitHash || existingHashes.has(commitHash)) continue
      newEntries.push({
        commitHash,
        shortMsg,
        sessionId: instanceId,
        sessionName,
        personaName,
        costUsd: cost,
        startedAt: startedAtMs,
        stoppedAt,
        dir,
      })
    }

    if (newEntries.length === 0) return

    const merged = [...existing, ...newEntries]
    const trimmed = merged.length > MAX_ENTRIES ? merged.slice(merged.length - MAX_ENTRIES) : merged
    writeEntries(trimmed)
    console.log(`[commit-attributor] attributed ${newEntries.length} commit(s) to session "${sessionName}"`)
  } catch (err) {
    console.error('[commit-attributor] scanNewCommits failed:', err)
  }
}

/** Return all attributed commits, newest first. Optionally filter by directory. */
export function getAttributedCommits(dir?: string): CommitAttribution[] {
  const entries = readEntries()
  const filtered = dir ? entries.filter(e => e.dir === dir) : entries
  return filtered.slice().reverse()
}

/** Delete the attribution log file. */
export function clearAttributions(): void {
  try {
    if (fs.existsSync(ATTRIBUTION_PATH)) {
      fs.unlinkSync(ATTRIBUTION_PATH)
    }
  } catch (err) {
    console.error('[commit-attributor] clearAttributions failed:', err)
  }
}
