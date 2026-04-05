/**
 * Tests for src/main/send-prompt-when-ready.ts
 *
 * The module wraps a non-trivial state machine:
 *   1. Listen for 'activity' events from the daemon client
 *   2. First 'waiting' → dismiss trust prompt with Enter
 *   3. Second 'waiting' → send actual prompt + Enter
 *   4. If only one 'waiting' comes, forceTimeout fires and sends
 *   5. abandonTimeout → resolve without sending if nothing happens
 *
 * Strategy: vi.doMock + vi.resetModules + vi.useFakeTimers to
 * control async timer behaviour without hitting real I/O.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ---- Mock daemon-client ----

function makeMockClient() {
  const listeners: Record<string, ((...args: unknown[]) => void)[]> = {}

  const mockClient = {
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (!listeners[event]) listeners[event] = []
      listeners[event].push(handler)
    }),
    removeListener: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (listeners[event]) {
        listeners[event] = listeners[event].filter((h) => h !== handler)
      }
    }),
    writeToInstance: vi.fn(),
    getInstance: vi.fn().mockResolvedValue(null),
    // Test helper: fire an event
    emit(event: string, ...args: unknown[]) {
      ;(listeners[event] ?? []).forEach((h) => h(...args))
    },
  }
  return mockClient
}

type MockClient = ReturnType<typeof makeMockClient>

let mockClient: MockClient
const mockGetDaemonClient = vi.hoisted(() => vi.fn())

// ---- Setup / teardown ----

beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
  mockClient = makeMockClient()
  mockGetDaemonClient.mockReturnValue(mockClient)
  vi.doMock('../daemon-client', () => ({ getDaemonClient: mockGetDaemonClient }))
})

afterEach(() => {
  vi.useRealTimers()
})

// ---- Helper ----

async function importMod() {
  return import('../send-prompt-when-ready')
}

// ---- Tests ----

describe('sendPromptWhenReady: two waiting events (normal path)', () => {
  it('dismisses trust prompt on first waiting, sends prompt on second', async () => {
    const { sendPromptWhenReady } = await importMod()
    const onSent = vi.fn()

    const promise = sendPromptWhenReady('inst-1', { prompt: 'hello', onSent })

    // First 'waiting' — trust/directory prompt
    mockClient.emit('activity', 'inst-1', 'waiting')
    expect(mockClient.writeToInstance).toHaveBeenCalledWith('inst-1', '\r')

    // Second 'waiting' — CLI is ready
    mockClient.writeToInstance.mockClear()
    mockClient.emit('activity', 'inst-1', 'waiting')

    // fire() writes prompt immediately, then \r after 150ms
    expect(mockClient.writeToInstance).toHaveBeenCalledWith('inst-1', 'hello')

    // Advance past the 150ms post-fire delay
    await vi.advanceTimersByTimeAsync(200)
    await promise

    expect(mockClient.writeToInstance).toHaveBeenCalledWith('inst-1', '\r')
    expect(onSent).toHaveBeenCalledOnce()
  })

  it('removes the activity listener after firing', async () => {
    const { sendPromptWhenReady } = await importMod()

    const promise = sendPromptWhenReady('inst-1', { prompt: 'test' })
    mockClient.emit('activity', 'inst-1', 'waiting')
    mockClient.emit('activity', 'inst-1', 'waiting')
    await vi.advanceTimersByTimeAsync(200)
    await promise

    expect(mockClient.removeListener).toHaveBeenCalled()
  })

  it('ignores events for a different instance id', async () => {
    const { sendPromptWhenReady } = await importMod()

    sendPromptWhenReady('inst-mine', { prompt: 'test', abandonTimeout: 500 })

    // Event for a different instance — should be ignored
    mockClient.emit('activity', 'inst-other', 'waiting')
    mockClient.emit('activity', 'inst-other', 'waiting')

    expect(mockClient.writeToInstance).not.toHaveBeenCalled()

    // Cleanup: advance abandon timer so no open handles
    await vi.advanceTimersByTimeAsync(600)
  })
})

describe('sendPromptWhenReady: force-send path (already trusted)', () => {
  it('sends after forceTimeout when second waiting never arrives', async () => {
    const { sendPromptWhenReady } = await importMod()
    const onSent = vi.fn()

    const promise = sendPromptWhenReady('inst-1', {
      prompt: 'force me',
      forceTimeout: 1000,
      abandonTimeout: 30000,
      onSent,
    })

    // First 'waiting' only
    mockClient.emit('activity', 'inst-1', 'waiting')
    expect(mockClient.writeToInstance).toHaveBeenCalledWith('inst-1', '\r')

    // Advance past forceTimeout
    await vi.advanceTimersByTimeAsync(1100)
    // Advance past 150ms post-fire delay
    await vi.advanceTimersByTimeAsync(200)
    await promise

    expect(mockClient.writeToInstance).toHaveBeenCalledWith('inst-1', 'force me')
    expect(mockClient.writeToInstance).toHaveBeenCalledWith('inst-1', '\r')
    expect(onSent).toHaveBeenCalledOnce()
  })

  it('second waiting before forceTimeout cancels the force timer', async () => {
    const { sendPromptWhenReady } = await importMod()

    const promise = sendPromptWhenReady('inst-1', {
      prompt: 'test',
      forceTimeout: 2000,
      abandonTimeout: 30000,
    })

    mockClient.emit('activity', 'inst-1', 'waiting')
    // Second waiting comes before the 2s forceTimeout
    mockClient.emit('activity', 'inst-1', 'waiting')

    await vi.advanceTimersByTimeAsync(200)
    await promise

    // writeToInstance called exactly 3 times: '\r' (trust dismiss), prompt, '\r' (submit)
    const calls = mockClient.writeToInstance.mock.calls
    expect(calls).toHaveLength(3)
    expect(calls[0]).toEqual(['inst-1', '\r'])
    expect(calls[1]).toEqual(['inst-1', 'test'])
    expect(calls[2]).toEqual(['inst-1', '\r'])
  })
})

describe('sendPromptWhenReady: abandon path', () => {
  it('resolves without sending when abandonTimeout expires', async () => {
    const { sendPromptWhenReady } = await importMod()
    const onSent = vi.fn()

    const promise = sendPromptWhenReady('inst-1', {
      prompt: 'never sent',
      abandonTimeout: 500,
      onSent,
    })

    // No events — advance past abandon timeout
    await vi.advanceTimersByTimeAsync(600)
    await promise

    expect(mockClient.writeToInstance).not.toHaveBeenCalled()
    expect(onSent).not.toHaveBeenCalled()
  })

  it('removes listener on abandon', async () => {
    const { sendPromptWhenReady } = await importMod()

    const promise = sendPromptWhenReady('inst-1', { prompt: 'x', abandonTimeout: 100 })
    await vi.advanceTimersByTimeAsync(200)
    await promise

    expect(mockClient.removeListener).toHaveBeenCalled()
  })
})

describe('sendPromptWhenReady: already-waiting race condition', () => {
  it('calls handler immediately when instance is already waiting on attach', async () => {
    // getInstance resolves with activity='waiting'
    mockClient.getInstance.mockResolvedValue({ id: 'inst-1', activity: 'waiting' })

    const { sendPromptWhenReady } = await importMod()

    const promise = sendPromptWhenReady('inst-1', {
      prompt: 'race win',
      forceTimeout: 500,
      abandonTimeout: 10000,
    })

    // Let the getInstance promise resolve
    await vi.advanceTimersByTimeAsync(0)
    // After detecting 'waiting' via race-check, forceTimer starts
    // Advance past forceTimeout + fire delay
    await vi.advanceTimersByTimeAsync(600)
    await vi.advanceTimersByTimeAsync(200)
    await promise

    expect(mockClient.writeToInstance).toHaveBeenCalledWith('inst-1', 'race win')
  })

  it('does not double-fire if a waiting event also arrives', async () => {
    mockClient.getInstance.mockResolvedValue({ id: 'inst-1', activity: 'waiting' })

    const { sendPromptWhenReady } = await importMod()
    const onSent = vi.fn()

    const promise = sendPromptWhenReady('inst-1', {
      prompt: 'no double',
      forceTimeout: 500,
      abandonTimeout: 10000,
      onSent,
    })

    // Race check fires (waitCount=1 via getInstance)
    await vi.advanceTimersByTimeAsync(0)

    // Listener event arrives for the same instance — waitCount would go to 2
    // which triggers fire(), but sent=false so it fires once
    mockClient.emit('activity', 'inst-1', 'waiting')

    await vi.advanceTimersByTimeAsync(200)
    await promise

    // onSent should be called exactly once regardless of path
    expect(onSent).toHaveBeenCalledOnce()
  })
})

describe('sendPromptWhenReady: no-op on sent guard', () => {
  it('does not re-fire after already sent', async () => {
    const { sendPromptWhenReady } = await importMod()
    const onSent = vi.fn()

    const promise = sendPromptWhenReady('inst-1', {
      prompt: 'once only',
      abandonTimeout: 10000,
      onSent,
    })

    // Trigger two back-to-back second-waitings
    mockClient.emit('activity', 'inst-1', 'waiting') // waitCount=1
    mockClient.emit('activity', 'inst-1', 'waiting') // waitCount=2, fires

    await vi.advanceTimersByTimeAsync(200)
    await promise

    // Trigger again after resolve — should be a no-op (removeListener already called)
    const callsBefore = mockClient.writeToInstance.mock.calls.length
    mockClient.emit('activity', 'inst-1', 'waiting')
    await vi.advanceTimersByTimeAsync(200)

    expect(mockClient.writeToInstance.mock.calls.length).toBe(callsBefore)
    expect(onSent).toHaveBeenCalledOnce()
  })
})
