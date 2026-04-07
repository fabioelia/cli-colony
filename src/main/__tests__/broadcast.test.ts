/**
 * Tests for broadcast.ts listener mechanism.
 * The broadcast() → renderer path is not unit-tested (requires Electron BrowserWindow),
 * but the listener subscription / unsubscription logic is pure and testable.
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: vi.fn().mockReturnValue([]) },
}))

import { broadcast, addBroadcastListener } from '../broadcast'

describe('addBroadcastListener', () => {
  it('receives events when broadcast is called', () => {
    const received: Array<[string, unknown[]]> = []
    const unsub = addBroadcastListener((ch, ...args) => received.push([ch, args]))

    broadcast('test:channel', { foo: 1 })

    expect(received).toHaveLength(1)
    expect(received[0][0]).toBe('test:channel')
    expect(received[0][1]).toEqual([{ foo: 1 }])

    unsub()
  })

  it('supports multiple arguments', () => {
    const received: unknown[][] = []
    const unsub = addBroadcastListener((_ch, ...args) => received.push(args))

    broadcast('multi', 'a', 'b', 'c')

    expect(received[0]).toEqual(['a', 'b', 'c'])
    unsub()
  })

  it('unsubscribe stops receiving events', () => {
    const calls: number[] = []
    const unsub = addBroadcastListener(() => calls.push(1))

    broadcast('before-unsub')
    unsub()
    broadcast('after-unsub')

    expect(calls).toHaveLength(1)
  })

  it('multiple listeners all receive the event', () => {
    const a: string[] = []
    const b: string[] = []
    const unsubA = addBroadcastListener((ch) => a.push(ch))
    const unsubB = addBroadcastListener((ch) => b.push(ch))

    broadcast('shared:event')

    expect(a).toContain('shared:event')
    expect(b).toContain('shared:event')

    unsubA()
    unsubB()
  })

  it('unsubscribing one listener does not affect others', () => {
    const a: string[] = []
    const b: string[] = []
    const unsubA = addBroadcastListener((ch) => a.push(ch))
    const unsubB = addBroadcastListener((ch) => b.push(ch))

    broadcast('first')
    unsubA()
    broadcast('second')

    expect(a).toEqual(['first'])
    expect(b).toEqual(['first', 'second'])

    unsubB()
  })
})
