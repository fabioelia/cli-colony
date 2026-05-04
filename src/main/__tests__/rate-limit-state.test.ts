/**
 * Tests for src/main/rate-limit-state.ts
 *
 * rate-limit-state has module-level mutable state (_state, _samples, _clearTimer).
 * Strategy: vi.resetModules() + vi.doMock() + dynamic import in beforeEach
 * to get a fresh module with clean state for every test.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mockBroadcast = vi.hoisted(() => vi.fn())

function setupMocks() {
  vi.doMock('../broadcast', () => ({ broadcast: mockBroadcast }))
}

async function importMod() {
  return import('../rate-limit-state')
}

describe('rate-limit-state: initial state', () => {
  let mod: Awaited<ReturnType<typeof importMod>>

  beforeEach(async () => {
    vi.useFakeTimers()
    vi.resetModules()
    setupMocks()
    mod = await importMod()
    mockBroadcast.mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts unpaused', () => {
    expect(mod.isRateLimited()).toBe(false)
  })

  it('getRateLimitState returns default unpaused state', () => {
    const s = mod.getRateLimitState()
    expect(s.paused).toBe(false)
    expect(s.resetAt).toBeNull()
    expect(s.source).toBeNull()
    expect(s.utilization).toBeNull()
  })

  it('getProjectedMinutesToLimit returns null with no samples', () => {
    expect(mod.getProjectedMinutesToLimit()).toBeNull()
  })
})

describe('rate-limit-state: setRateLimited (pty)', () => {
  let mod: Awaited<ReturnType<typeof importMod>>

  beforeEach(async () => {
    vi.useFakeTimers()
    vi.resetModules()
    setupMocks()
    mod = await importMod()
    mockBroadcast.mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('sets paused=true with explicit retryAfterSecs', () => {
    vi.setSystemTime(1_000_000)
    mod.setRateLimited(60, 'rate limit hit')
    expect(mod.isRateLimited()).toBe(true)
    const s = mod.getRateLimitState()
    expect(s.paused).toBe(true)
    expect(s.resetAt).toBe(1_000_000 + 60_000)
    expect(s.source).toBe('pty')
    expect(s.lastError).toBe('rate limit hit')
  })

  it('uses DEFAULT_PAUSE_SECS (300s) when retryAfterSecs is null', () => {
    vi.setSystemTime(0)
    mod.setRateLimited(null, 'no retry-after')
    const s = mod.getRateLimitState()
    expect(s.resetAt).toBe(300_000)
  })

  it('does not shorten an existing pause', () => {
    vi.setSystemTime(0)
    mod.setRateLimited(300, 'first hit')   // resetAt = 300_000
    mod.setRateLimited(60, 'second hit')   // would be resetAt = 60_000 — should be ignored
    expect(mod.getRateLimitState().resetAt).toBe(300_000)
  })

  it('extends an existing pause when new resetAt is further out', () => {
    vi.setSystemTime(0)
    mod.setRateLimited(60, 'first')        // resetAt = 60_000
    mod.setRateLimited(600, 'second')      // resetAt = 600_000 — should take effect
    expect(mod.getRateLimitState().resetAt).toBe(600_000)
  })

  it('skips if probe source is already active and status=allowed', () => {
    // Establish probe as source with allowed status
    mod.setRateLimitFromProbe({ status: 'allowed', utilization: 0.5 } as any, null)
    mockBroadcast.mockClear()
    // PTY hit should be ignored
    mod.setRateLimited(60, 'pty override attempt')
    expect(mod.isRateLimited()).toBe(false)
    expect(mockBroadcast).not.toHaveBeenCalled()
  })

  it('broadcasts state change on setRateLimited', () => {
    mod.setRateLimited(60, 'msg')
    expect(mockBroadcast).toHaveBeenCalledWith('colony:rateLimitChange', expect.objectContaining({ paused: true }))
  })

  it('auto-clears after timeout fires', async () => {
    mod.setRateLimited(60, 'msg')
    expect(mod.isRateLimited()).toBe(true)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(mod.isRateLimited()).toBe(false)
  })
})

describe('rate-limit-state: setRateLimitFromProbe', () => {
  let mod: Awaited<ReturnType<typeof importMod>>

  beforeEach(async () => {
    vi.useFakeTimers()
    vi.resetModules()
    setupMocks()
    mod = await importMod()
    mockBroadcast.mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('sets paused=true when status=rejected', () => {
    mod.setRateLimitFromProbe(
      { status: 'rejected', rateLimitType: 'five_hour', utilization: 0.99 } as any,
      300
    )
    const s = mod.getRateLimitState()
    expect(s.paused).toBe(true)
    expect(s.source).toBe('probe')
    expect(s.rateLimitType).toBe('five_hour')
  })

  it('sets paused=false when status=allowed', () => {
    mod.setRateLimitFromProbe(
      { status: 'allowed', utilization: 0.3 } as any,
      null
    )
    expect(mod.isRateLimited()).toBe(false)
  })

  it('sets paused=false when status=allowed_warning', () => {
    mod.setRateLimitFromProbe(
      { status: 'allowed_warning', utilization: 0.8 } as any,
      null
    )
    expect(mod.isRateLimited()).toBe(false)
  })

  it('accumulates utilization samples', () => {
    vi.setSystemTime(0)
    mod.setRateLimitFromProbe({ status: 'allowed', utilization: 0.3 } as any, null)
    vi.setSystemTime(60_000)
    mod.setRateLimitFromProbe({ status: 'allowed', utilization: 0.5 } as any, null)
    vi.setSystemTime(120_000)
    mod.setRateLimitFromProbe({ status: 'allowed', utilization: 0.7 } as any, null)
    // Slope: (0.7 - 0.3) / 2 = 0.2/min, remaining: 0.3, projection: 1.5 → rounded = 2
    const proj = mod.getProjectedMinutesToLimit()
    expect(proj).not.toBeNull()
    expect(proj).toBeGreaterThan(0)
  })

  it('stores resetsAt (epoch seconds → ms)', () => {
    vi.setSystemTime(0)
    mod.setRateLimitFromProbe(
      { status: 'rejected', resetsAt: 1000, utilization: null } as any,
      60
    )
    expect(mod.getRateLimitState().resetAt).toBe(1_000_000)
  })

  it('stores overage fields', () => {
    mod.setRateLimitFromProbe(
      { status: 'allowed', isUsingOverage: true, overageDisabledReason: 'none' } as any,
      null
    )
    const s = mod.getRateLimitState()
    expect(s.isUsingOverage).toBe(true)
    expect(s.overageDisabledReason).toBe('none')
  })

  it('auto-clears after retryAfterSecs timer fires', async () => {
    mod.setRateLimitFromProbe({ status: 'rejected', utilization: null } as any, 30)
    expect(mod.isRateLimited()).toBe(true)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(mod.isRateLimited()).toBe(false)
  })
})

describe('rate-limit-state: clearRateLimit / isRateLimited auto-clear', () => {
  let mod: Awaited<ReturnType<typeof importMod>>

  beforeEach(async () => {
    vi.useFakeTimers()
    vi.resetModules()
    setupMocks()
    mod = await importMod()
    mockBroadcast.mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('clearRateLimit resets all state fields', () => {
    mod.setRateLimited(60, 'msg')
    mod.clearRateLimit()
    const s = mod.getRateLimitState()
    expect(s.paused).toBe(false)
    expect(s.resetAt).toBeNull()
    expect(s.lastError).toBe('')
    expect(s.source).toBeNull()
    expect(s.utilization).toBeNull()
  })

  it('clearRateLimit is a no-op when already unpaused', () => {
    mockBroadcast.mockClear()
    mod.clearRateLimit()
    expect(mockBroadcast).not.toHaveBeenCalled()
  })

  it('isRateLimited auto-clears when past resetAt', () => {
    vi.setSystemTime(0)
    mod.setRateLimited(60, 'msg')
    vi.setSystemTime(61_000)
    expect(mod.isRateLimited()).toBe(false)
  })

  it('getRateLimitState auto-clears when past resetAt', () => {
    vi.setSystemTime(0)
    mod.setRateLimited(60, 'msg')
    vi.setSystemTime(61_000)
    const s = mod.getRateLimitState()
    expect(s.paused).toBe(false)
  })

  it('resumeCrons clears rate limit', () => {
    mod.setRateLimited(300, 'msg')
    expect(mod.isRateLimited()).toBe(true)
    mod.resumeCrons()
    expect(mod.isRateLimited()).toBe(false)
  })
})

describe('rate-limit-state: onRateLimitStateChange callback', () => {
  let mod: Awaited<ReturnType<typeof importMod>>

  beforeEach(async () => {
    vi.useFakeTimers()
    vi.resetModules()
    setupMocks()
    mod = await importMod()
    mockBroadcast.mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('fires callback when rate limited', () => {
    const cb = vi.fn()
    mod.onRateLimitStateChange(cb)
    mod.setRateLimited(60, 'msg')
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('fires callback when cleared', () => {
    const cb = vi.fn()
    mod.onRateLimitStateChange(cb)
    mod.setRateLimited(60, 'msg')
    cb.mockClear()
    mod.clearRateLimit()
    expect(cb).toHaveBeenCalledTimes(1)
  })
})

describe('rate-limit-state: getProjectedMinutesToLimit', () => {
  let mod: Awaited<ReturnType<typeof importMod>>

  beforeEach(async () => {
    vi.useFakeTimers()
    vi.resetModules()
    setupMocks()
    mod = await importMod()
    mockBroadcast.mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns null with fewer than 3 samples', () => {
    vi.setSystemTime(0)
    mod.setRateLimitFromProbe({ status: 'allowed', utilization: 0.5 } as any, null)
    vi.setSystemTime(60_000)
    mod.setRateLimitFromProbe({ status: 'allowed', utilization: 0.6 } as any, null)
    expect(mod.getProjectedMinutesToLimit()).toBeNull()
  })

  it('returns null when last utilization is below 0.3', () => {
    for (let i = 0; i < 3; i++) {
      vi.setSystemTime(i * 60_000)
      mod.setRateLimitFromProbe({ status: 'allowed', utilization: 0.1 + i * 0.05 } as any, null)
    }
    expect(mod.getProjectedMinutesToLimit()).toBeNull()
  })

  it('returns null when slope is zero or negative', () => {
    for (let i = 0; i < 3; i++) {
      vi.setSystemTime(i * 60_000)
      mod.setRateLimitFromProbe({ status: 'allowed', utilization: 0.9 - i * 0.1 } as any, null)
    }
    expect(mod.getProjectedMinutesToLimit()).toBeNull()
  })

  it('returns null when time window is less than 1 minute', () => {
    for (let i = 0; i < 3; i++) {
      vi.setSystemTime(i * 10_000) // 10 seconds apart → dtMinutes = 0.33
      mod.setRateLimitFromProbe({ status: 'allowed', utilization: 0.5 + i * 0.1 } as any, null)
    }
    expect(mod.getProjectedMinutesToLimit()).toBeNull()
  })

  it('computes correct projection with valid linear data', () => {
    // util at t=0: 0.4, t=1min: 0.6, t=2min: 0.8
    // slope = 0.2/min, remaining = 0.2 → projection = 1 min
    vi.setSystemTime(0)
    mod.setRateLimitFromProbe({ status: 'allowed', utilization: 0.4 } as any, null)
    vi.setSystemTime(60_000)
    mod.setRateLimitFromProbe({ status: 'allowed', utilization: 0.6 } as any, null)
    vi.setSystemTime(120_000)
    mod.setRateLimitFromProbe({ status: 'allowed', utilization: 0.8 } as any, null)
    const proj = mod.getProjectedMinutesToLimit()
    expect(proj).toBe(1)
  })
})
