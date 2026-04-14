/**
 * Rate Limit Probe — lightweight heartbeat that queries Claude CLI
 * for structured rate limit info via `--output-format stream-json`.
 *
 * Spawns a minimal `claude -p "hi" …` at a configurable interval
 * (default 15 min) and parses the `rate_limit_event` NDJSON line
 * to get exact utilization, reset times, and early warnings directly
 * from Anthropic's response headers — no PTY regex guessing.
 */

import { spawn } from 'child_process'
import { resolveCommand } from './resolve-command'
import { loadShellEnv } from '../shared/shell-env'
import { getSetting } from './settings'
import { setRateLimitFromProbe, clearRateLimit } from './rate-limit-state'
import { broadcast } from './broadcast'

let _timer: ReturnType<typeof setInterval> | null = null
let _running = false

/** Parsed rate_limit_event from Claude CLI stream-json output. */
export interface ProbeRateLimitInfo {
  status: 'allowed' | 'allowed_warning' | 'rejected'
  resetsAt?: number        // Unix epoch seconds
  rateLimitType?: string   // five_hour, seven_day, etc.
  utilization?: number     // 0–1 fraction
  overageStatus?: string
  overageResetsAt?: number
  overageDisabledReason?: string
  isUsingOverage?: boolean
  surpassedThreshold?: number
}

/** Run a single probe. Exported for manual trigger / testing. */
export async function runProbe(): Promise<ProbeRateLimitInfo | null> {
  if (_running) return null
  _running = true

  try {
    const cmd = resolveCommand('claude')
    const argv = [
      '-p', 'hi',
      '--output-format', 'stream-json',
      '--tools', '',
      '--model', 'haiku',
      '--effort', 'low',
      '--max-budget-usd', '0.01',
      '--no-session-persistence',
    ]

    const info = await new Promise<ProbeRateLimitInfo | null>((resolve) => {
      let result: ProbeRateLimitInfo | null = null
      let stdout = ''

      const proc = spawn(cmd, argv, {
        env: loadShellEnv(),
        stdio: ['pipe', 'pipe', 'ignore'],
        timeout: 30_000,
      })

      proc.stdin.end()

      proc.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString()
        // Parse NDJSON lines as they arrive
        const lines = stdout.split('\n')
        stdout = lines.pop() || '' // keep incomplete last line
        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const msg = JSON.parse(line)
            if (msg.type === 'rate_limit_event' && msg.rate_limit_info) {
              result = msg.rate_limit_info as ProbeRateLimitInfo
            }
          } catch { /* skip non-JSON lines */ }
        }
      })

      proc.on('error', () => resolve(null))

      proc.on('close', () => {
        // Check any remaining buffered data
        if (stdout.trim()) {
          try {
            const msg = JSON.parse(stdout)
            if (msg.type === 'rate_limit_event' && msg.rate_limit_info) {
              result = msg.rate_limit_info as ProbeRateLimitInfo
            }
          } catch { /* ignore */ }
        }
        resolve(result)
      })

      // Hard kill if it hangs
      setTimeout(() => {
        try { proc.kill('SIGKILL') } catch { /* */ }
      }, 30_000)
    })

    if (info) {
      console.log(`[rate-limit-probe] status=${info.status} utilization=${info.utilization ?? '?'} type=${info.rateLimitType ?? '?'} resetsAt=${info.resetsAt ? new Date(info.resetsAt * 1000).toLocaleTimeString() : '?'}`)

      if (info.status === 'rejected') {
        // Convert resetsAt (epoch seconds) to retryAfterSecs for the state module
        const retryAfterSecs = info.resetsAt
          ? Math.max(0, info.resetsAt - Math.floor(Date.now() / 1000))
          : null
        setRateLimitFromProbe(info, retryAfterSecs)
      } else if (info.status === 'allowed_warning') {
        // Early warning — broadcast but don't pause
        setRateLimitFromProbe(info, null)
      } else {
        // status === 'allowed' — clear any existing pause from stale PTY detection
        clearRateLimit()
      }
      broadcast('colony:rateLimitProbe', info)
    }

    return info
  } catch (err) {
    console.warn('[rate-limit-probe] failed:', err)
    return null
  } finally {
    _running = false
  }
}

async function getIntervalMs(): Promise<number> {
  const raw = await getSetting('rateLimitProbeIntervalMinutes').catch(() => '')
  const mins = parseInt(raw || '', 10)
  return (mins > 0 ? mins : 15) * 60_000
}

export async function startProbe(): Promise<void> {
  if (_timer) return
  const intervalMs = await getIntervalMs()
  console.log(`[rate-limit-probe] starting — interval ${intervalMs / 60_000}m`)

  // Run first probe after a short delay (let the app settle)
  setTimeout(() => runProbe(), 10_000)

  _timer = setInterval(async () => {
    const intervalMs = await getIntervalMs()
    // Re-check interval in case setting changed — reschedule if different
    runProbe()
  }, intervalMs)
}

export function stopProbe(): void {
  if (_timer) {
    clearInterval(_timer)
    _timer = null
  }
}
