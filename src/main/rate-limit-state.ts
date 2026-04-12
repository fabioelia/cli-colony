/**
 * Central rate limit state — tracks whether Colony should pause cron activity.
 * Daemon detects rate limit errors in PTY output; this module holds the state
 * and auto-clears when the reset time passes.
 */

import { broadcast } from './broadcast'

export interface RateLimitState {
  paused: boolean
  resetAt: number | null  // epoch ms
  lastError: string
  detectedAt: number | null  // epoch ms
}

const DEFAULT_PAUSE_SECS = 60 * 60 // 1 hour fallback when no retry-after found

let _state: RateLimitState = {
  paused: false,
  resetAt: null,
  lastError: '',
  detectedAt: null,
}
let _clearTimer: ReturnType<typeof setTimeout> | null = null

function broadcastState(): void {
  broadcast('colony:rateLimitChange', _state)
}

export function getRateLimitState(): RateLimitState {
  // Auto-clear if past resetAt
  if (_state.paused && _state.resetAt && Date.now() >= _state.resetAt) {
    clearRateLimit()
  }
  return { ..._state }
}

export function isRateLimited(): boolean {
  if (_state.paused && _state.resetAt && Date.now() >= _state.resetAt) {
    clearRateLimit()
  }
  return _state.paused
}

export function setRateLimited(retryAfterSecs: number | null, rawMessage: string): void {
  const pauseSecs = retryAfterSecs ?? DEFAULT_PAUSE_SECS
  const resetAt = Date.now() + pauseSecs * 1000

  // Don't shorten an existing pause
  if (_state.paused && _state.resetAt && resetAt < _state.resetAt) return

  _state = {
    paused: true,
    resetAt,
    lastError: rawMessage,
    detectedAt: Date.now(),
  }

  // Schedule auto-clear
  if (_clearTimer) clearTimeout(_clearTimer)
  _clearTimer = setTimeout(() => {
    clearRateLimit()
  }, pauseSecs * 1000)

  console.log(`[rate-limit] paused until ${new Date(resetAt).toLocaleTimeString()} (${pauseSecs}s)`)
  broadcastState()
}

export function clearRateLimit(): void {
  if (!_state.paused) return
  if (_clearTimer) {
    clearTimeout(_clearTimer)
    _clearTimer = null
  }
  _state = { paused: false, resetAt: null, lastError: '', detectedAt: null }
  console.log('[rate-limit] cleared — crons resuming')
  broadcastState()
}

/** Manual resume — user explicitly resumes cron firing. */
export function resumeCrons(): void {
  clearRateLimit()
}
