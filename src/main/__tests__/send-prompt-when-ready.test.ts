/**
 * Tests for src/main/send-prompt-when-ready.ts
 *
 * The module wraps a non-trivial state machine:
 *   1. Listen for 'activity' events from the daemon client
 *   2. First 'waiting' → check buffer for trust dialog
 *      a. Trust dialog present → dismiss with Enter, wait for second waiting
 *      b. No trust dialog → send prompt directly (already trusted)
 *   3. Second 'waiting' → send actual prompt + Enter
 *   4. If trust dismissed but only one 'waiting' comes, forceTimeout fires
 *   5. abandonTimeout → resolve without sending if nothing happens
 *
 * Strategy: vi.doMock + vi.resetModules + vi.useFakeTimers to
 * control async timer behaviour without hitting real I/O.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ---- Mock daemon-client ----

function makeMockClient(bufferContent = '') {
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
    getInstanceBuffer: vi.fn().mockResolvedValue(bufferContent),
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

describe('sendPromptWhenReady: two waiting events (trust dialog path)', () => {
  it('dismisses trust prompt on first waiting, sends prompt on second', async () => {
    // Buffer contains trust dialog text
    mockClient.getInstanceBuffer.mockResolvedValue('Do you trust the files in this folder?')
    const { sendPromptWhenReady } = await importMod()
    const onSent = vi.fn()

    const promise = sendPromptWhenReady('inst-1', { prompt: 'hello', onSent })

    // First 'waiting' — triggers buffer check
    mockClient.emit('activity', 'inst-1', 'waiting')
    // Flush the getInstanceBuffer promise
    await vi.advanceTimersByTimeAsync(0)
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
    mockClient.getInstanceBuffer.mockResolvedValue('trust prompt showing')
    const { sendPromptWhenReady } = await importMod()

    const promise = sendPromptWhenReady('inst-1', { prompt: 'test' })
    mockClient.emit('activity', 'inst-1', 'waiting')
    await vi.advanceTimersByTimeAsync(0)
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

describe('sendPromptWhenReady: already trusted (no trust dialog)', () => {
  it('sends prompt directly on first waiting when no trust dialog detected', async () => {
    // Buffer has no trust-related text
    mockClient.getInstanceBuffer.mockResolvedValue('> ')
    const { sendPromptWhenReady } = await importMod()
    const onSent = vi.fn()

    const promise = sendPromptWhenReady('inst-1', {
      prompt: 'direct send',
      abandonTimeout: 30000,
      onSent,
    })

    // First 'waiting' — no trust dialog, should fire immediately
    mockClient.emit('activity', 'inst-1', 'waiting')
    // Flush the getInstanceBuffer promise
    await vi.advanceTimersByTimeAsync(0)

    // Should write prompt directly (no '\r' dismiss)
    expect(mockClient.writeToInstance).toHaveBeenCalledWith('inst-1', 'direct send')

    // Advance past 150ms post-fire delay
    await vi.advanceTimersByTimeAsync(200)
    await promise

    expect(mockClient.writeToInstance).toHaveBeenCalledWith('inst-1', '\r')
    expect(onSent).toHaveBeenCalledOnce()
    // No trust dismiss '\r' — only prompt + submit '\r'
    const calls = mockClient.writeToInstance.mock.calls
    expect(calls).toHaveLength(2)
    expect(calls[0]).toEqual(['inst-1', 'direct send'])
    expect(calls[1]).toEqual(['inst-1', '\r'])
  })
})

describe('sendPromptWhenReady: force-send after trust dismiss', () => {
  it('sends after forceTimeout when trust dismissed but second waiting never arrives', async () => {
    mockClient.getInstanceBuffer.mockResolvedValue('Do you trust this directory?')
    const { sendPromptWhenReady } = await importMod()
    const onSent = vi.fn()

    const promise = sendPromptWhenReady('inst-1', {
      prompt: 'force me',
      forceTimeout: 1000,
      abandonTimeout: 30000,
      onSent,
    })

    // First 'waiting' — trust dialog detected
    mockClient.emit('activity', 'inst-1', 'waiting')
    await vi.advanceTimersByTimeAsync(0)
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
    mockClient.getInstanceBuffer.mockResolvedValue('trust prompt here')
    const { sendPromptWhenReady } = await importMod()

    const promise = sendPromptWhenReady('inst-1', {
      prompt: 'test',
      forceTimeout: 2000,
      abandonTimeout: 30000,
    })

    mockClient.emit('activity', 'inst-1', 'waiting')
    await vi.advanceTimersByTimeAsync(0)
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

describe('sendPromptWhenReady: buffer check failure fallback', () => {
  it('falls back to dismiss + force-send when getInstanceBuffer rejects', async () => {
    mockClient.getInstanceBuffer.mockRejectedValue(new Error('disconnected'))
    const { sendPromptWhenReady } = await importMod()
    const onSent = vi.fn()

    const promise = sendPromptWhenReady('inst-1', {
      prompt: 'fallback',
      forceTimeout: 500,
      abandonTimeout: 30000,
      onSent,
    })

    mockClient.emit('activity', 'inst-1', 'waiting')
    // Flush rejected promise
    await vi.advanceTimersByTimeAsync(0)

    // Falls back to dismiss behavior
    expect(mockClient.writeToInstance).toHaveBeenCalledWith('inst-1', '\r')

    // Force-send after timeout
    await vi.advanceTimersByTimeAsync(600)
    await vi.advanceTimersByTimeAsync(200)
    await promise

    expect(mockClient.writeToInstance).toHaveBeenCalledWith('inst-1', 'fallback')
    expect(onSent).toHaveBeenCalledOnce()
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
    // getInstance resolves with activity='waiting', no trust dialog
    mockClient.getInstance.mockResolvedValue({ id: 'inst-1', activity: 'waiting' })
    mockClient.getInstanceBuffer.mockResolvedValue('> ')

    const { sendPromptWhenReady } = await importMod()

    const promise = sendPromptWhenReady('inst-1', {
      prompt: 'race win',
      forceTimeout: 500,
      abandonTimeout: 10000,
    })

    // Let the getInstance promise resolve + buffer check
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(0)

    // No trust dialog — fires directly
    expect(mockClient.writeToInstance).toHaveBeenCalledWith('inst-1', 'race win')

    await vi.advanceTimersByTimeAsync(200)
    await promise
  })

  it('does not double-fire if a waiting event also arrives', async () => {
    mockClient.getInstance.mockResolvedValue({ id: 'inst-1', activity: 'waiting' })
    mockClient.getInstanceBuffer.mockResolvedValue('> ')

    const { sendPromptWhenReady } = await importMod()
    const onSent = vi.fn()

    const promise = sendPromptWhenReady('inst-1', {
      prompt: 'no double',
      forceTimeout: 500,
      abandonTimeout: 10000,
      onSent,
    })

    // Race check fires (waitCount=1 via getInstance + buffer check)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(0)

    // Listener event arrives for the same instance — should be no-op (already sent)
    mockClient.emit('activity', 'inst-1', 'waiting')

    await vi.advanceTimersByTimeAsync(200)
    await promise

    // onSent should be called exactly once regardless of path
    expect(onSent).toHaveBeenCalledOnce()
  })
})

describe('sendPromptWhenReady: no-op on sent guard', () => {
  it('does not re-fire after already sent', async () => {
    mockClient.getInstanceBuffer.mockResolvedValue('trust dialog')
    const { sendPromptWhenReady } = await importMod()
    const onSent = vi.fn()

    const promise = sendPromptWhenReady('inst-1', {
      prompt: 'once only',
      abandonTimeout: 10000,
      onSent,
    })

    // Trigger first waiting — trust dialog detected
    mockClient.emit('activity', 'inst-1', 'waiting')
    await vi.advanceTimersByTimeAsync(0)
    // Second waiting — fires
    mockClient.emit('activity', 'inst-1', 'waiting')

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

describe('sendPromptWhenReady: return value', () => {
  it('returns "sent" on successful delivery', async () => {
    mockClient.getInstanceBuffer.mockResolvedValue('> ')
    const { sendPromptWhenReady } = await importMod()

    const promise = sendPromptWhenReady('inst-1', { prompt: 'test' })
    mockClient.emit('activity', 'inst-1', 'waiting')
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(200)

    expect(await promise).toBe('sent')
  })

  it('returns "abandoned" on timeout', async () => {
    const { sendPromptWhenReady } = await importMod()

    const promise = sendPromptWhenReady('inst-1', { prompt: 'test', abandonTimeout: 100 })
    await vi.advanceTimersByTimeAsync(200)

    expect(await promise).toBe('abandoned')
  })
})

describe('sendPromptWhenReady: planFirst prefix', () => {
  it('prepends PLAN_FIRST_PREFIX when planFirst is true', async () => {
    mockClient.getInstanceBuffer.mockResolvedValue('> ')
    const { sendPromptWhenReady, PLAN_FIRST_PREFIX } = await importMod()

    const promise = sendPromptWhenReady('inst-1', { prompt: 'my task', planFirst: true })
    mockClient.emit('activity', 'inst-1', 'waiting')
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(200)
    await promise

    expect(mockClient.writeToInstance).toHaveBeenCalledWith('inst-1', PLAN_FIRST_PREFIX + 'my task')
  })
})
