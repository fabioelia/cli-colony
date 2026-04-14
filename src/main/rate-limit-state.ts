/**
 * Central rate limit state — tracks whether Colony should pause cron activity.
 *
 * Two detection sources:
 *   1. PTY regex parsing (legacy) — daemon parses retry-after from error text
 *   2. Heartbeat probe (preferred) — structured rate_limit_event from CLI stream-json
 *
 * The probe provides richer data: utilization, rate limit type, exact reset
 * times, and early warnings before the limit is actually hit.
 */

import { broadcast } from './broadcast'
import type { ProbeRateLimitInfo } from './rate-limit-probe'

export interface RateLimitState {
  paused: boolean
  resetAt: number | null     // epoch ms
  lastError: string
  detectedAt: number | null  // epoch ms
  // Structured fields from probe (when available)
  utilization: number | null       // 0–1 fraction of current window
  rateLimitType: string | null     // five_hour, seven_day, etc.
  status: string | null            // allowed, allowed_warning, rejected
  isUsingOverage: boolean | null
  overageDisabledReason: string | null
  source: 'pty' | 'probe' | null  // which detection source set this
}

const DEFAULT_PAUSE_SECS = 5 * 60 // 5 min fallback when no retry-after found (was 1 hour)

let _state: RateLimitState = {
  paused: false,
  resetAt: null,
  lastError: '',
  detectedAt: null,
  utilization: null,
  rateLimitType: null,
  status: null,
  isUsingOverage: null,
  overageDisabledReason: null,
  source: null,
}
let _clearTimer: ReturnType<typeof setTimeout> | null = null
let _onChangeCallback: (() => void) | null = null

/** Register a callback invoked whenever rate limit state changes (set or cleared). */
export function onRateLimitStateChange(cb: () => void): void {
  _onChangeCallback = cb
}

function broadcastState(): void {
  broadcast('colony:rateLimitChange', _state)
  _onChangeCallback?.()
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
  // If probe is active and says we're allowed, trust the probe over PTY regex
  if (_state.source === 'probe' && _state.status === 'allowed') return

  const pauseSecs = retryAfterSecs ?? DEFAULT_PAUSE_SECS
  const resetAt = Date.now() + pauseSecs * 1000

  // Don't shorten an existing pause
  if (_state.paused && _state.resetAt && resetAt < _state.resetAt) return

  _state = {
    ..._state,
    paused: true,
    resetAt,
    lastError: rawMessage,
    detectedAt: Date.now(),
    source: 'pty',
  }

  // Schedule auto-clear
  if (_clearTimer) clearTimeout(_clearTimer)
  _clearTimer = setTimeout(() => {
    clearRateLimit()
  }, pauseSecs * 1000)

  console.log(`[rate-limit] paused until ${new Date(resetAt).toLocaleTimeString()} (${pauseSecs}s) [pty]`)
  broadcastState()
}

/** Set rate limit state from structured probe data (preferred over PTY parsing). */
export function setRateLimitFromProbe(info: ProbeRateLimitInfo, retryAfterSecs: number | null): void {
  const paused = info.status === 'rejected'
  const resetAt = info.resetsAt ? info.resetsAt * 1000 : null // convert epoch seconds → ms

  _state = {
    paused,
    resetAt,
    lastError: paused ? `Rate limited (${info.rateLimitType || 'unknown'})` : '',
    detectedAt: paused ? Date.now() : _state.detectedAt,
    utilization: info.utilization ?? null,
    rateLimitType: info.rateLimitType ?? null,
    status: info.status,
    isUsingOverage: info.isUsingOverage ?? null,
    overageDisabledReason: info.overageDisabledReason ?? null,
    source: 'probe',
  }

  // Schedule auto-clear for rejected state
  if (_clearTimer) clearTimeout(_clearTimer)
  if (paused && retryAfterSecs && retryAfterSecs > 0) {
    _clearTimer = setTimeout(() => {
      clearRateLimit()
    }, retryAfterSecs * 1000)
    console.log(`[rate-limit] paused until ${resetAt ? new Date(resetAt).toLocaleTimeString() : '?'} (${retryAfterSecs}s) [probe]`)
  }

  broadcastState()
}

export function clearRateLimit(): void {
  if (!_state.paused) return
  if (_clearTimer) {
    clearTimeout(_clearTimer)
    _clearTimer = null
  }
  _state = {
    paused: false, resetAt: null, lastError: '', detectedAt: null,
    utilization: null, rateLimitType: null, status: null,
    isUsingOverage: null, overageDisabledReason: null, source: null,
  }
  console.log('[rate-limit] cleared — crons resuming')
  broadcastState()
}

/** Manual resume — user explicitly resumes cron firing. */
export function resumeCrons(): void {
  clearRateLimit()
}
