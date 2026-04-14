/**
 * Tests for waitForStableIdle — the stable-waiting guard that protects
 * against daemon PTY-lull false-positives. Core regression: #263.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

type Handler = (id: string, activity: string) => void

let handlers: Handler[]
let mockRouter: {
  on: ReturnType<typeof vi.fn>
  removeListener: ReturnType<typeof vi.fn>
}

beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
  handlers = []
  mockRouter = {
    on: vi.fn((event: string, h: Handler) => {
      if (event === 'activity') handlers.push(h)
    }),
    removeListener: vi.fn((event: string, h: Handler) => {
      if (event === 'activity') handlers = handlers.filter(x => x !== h)
    }),
  }
  vi.doMock('../daemon-router', () => ({ getDaemonRouter: () => mockRouter }))
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function fire(id: string, activity: string): void {
  for (const h of [...handlers]) h(id, activity)
}

describe('waitForStableIdle', () => {
  it('resolves "stable" only after waiting holds for the full window', async () => {
    const { waitForStableIdle } = await import('../session-completion')
    const { promise } = waitForStableIdle('inst-1', { stableMs: 20_000 })

    let resolved: string | null = null
    promise.then(v => { resolved = v })

    fire('inst-1', 'waiting')
    await vi.advanceTimersByTimeAsync(19_000)
    expect(resolved).toBeNull()

    await vi.advanceTimersByTimeAsync(1_000)
    expect(resolved).toBe('stable')
  })

  it('cancels the pending stable timer when activity returns to busy', async () => {
    const { waitForStableIdle } = await import('../session-completion')
    const { promise } = waitForStableIdle('inst-1', { stableMs: 20_000, absoluteMs: 60_000 })

    let resolved: string | null = null
    promise.then(v => { resolved = v })

    // False-positive: waiting mid-tool-exec
    fire('inst-1', 'waiting')
    await vi.advanceTimersByTimeAsync(15_000)
    fire('inst-1', 'busy')
    await vi.advanceTimersByTimeAsync(10_000) // would have fired stable otherwise
    expect(resolved).toBeNull()

    // Eventual real idle — must hold for the full window again
    fire('inst-1', 'waiting')
    await vi.advanceTimersByTimeAsync(19_000)
    expect(resolved).toBeNull()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(resolved).toBe('stable')
  })

  it('resolves "timeout" when absoluteMs elapses before stable idle', async () => {
    const { waitForStableIdle } = await import('../session-completion')
    const { promise } = waitForStableIdle('inst-1', { stableMs: 20_000, absoluteMs: 30_000 })

    let resolved: string | null = null
    promise.then(v => { resolved = v })

    // Oscillate between busy and brief waitings — never stable enough
    for (let i = 0; i < 3; i++) {
      fire('inst-1', 'waiting')
      await vi.advanceTimersByTimeAsync(5_000)
      fire('inst-1', 'busy')
      await vi.advanceTimersByTimeAsync(5_000)
    }
    // Advance past the 30s absolute timeout
    await vi.advanceTimersByTimeAsync(5_000)
    expect(resolved).toBe('timeout')
  })

  it('ignores activity events for different instance IDs', async () => {
    const { waitForStableIdle } = await import('../session-completion')
    const { promise } = waitForStableIdle('inst-1', { stableMs: 10_000 })

    let resolved: string | null = null
    promise.then(v => { resolved = v })

    fire('other-inst', 'waiting')
    await vi.advanceTimersByTimeAsync(20_000)
    expect(resolved).toBeNull()
  })

  it('cancel() removes listeners and clears timers', async () => {
    const { waitForStableIdle } = await import('../session-completion')
    const { promise, cancel } = waitForStableIdle('inst-1', { stableMs: 10_000, absoluteMs: 30_000 })

    let resolved: string | null = null
    promise.then(v => { resolved = v })

    fire('inst-1', 'waiting')
    await vi.advanceTimersByTimeAsync(5_000)
    cancel()

    // Further events must not resolve the promise
    await vi.advanceTimersByTimeAsync(100_000)
    fire('inst-1', 'waiting')
    await vi.advanceTimersByTimeAsync(100_000)

    expect(resolved).toBeNull()
    expect(mockRouter.removeListener).toHaveBeenCalledWith('activity', expect.any(Function))
  })
})
