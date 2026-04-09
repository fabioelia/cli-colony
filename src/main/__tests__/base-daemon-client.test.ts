import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'

// Mock fs before import
vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  unlinkSync: vi.fn(),
}))

vi.mock('child_process', () => ({
  spawn: vi.fn().mockReturnValue({ unref: vi.fn() }),
}))

vi.mock('electron', () => ({
  app: { getPath: vi.fn().mockReturnValue('/mock/home') },
}))

vi.mock('../../daemon/protocol', () => ({
  DAEMON_VERSION: 42,
}))

// We'll create mock sockets per-test and have net.createConnection return them
let currentMockSocket: EventEmitter & { write: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> }

vi.mock('net', () => ({
  createConnection: vi.fn(() => currentMockSocket),
}))

import { BaseDaemonClient } from '../base-daemon-client'
import * as fs from 'fs'

// Concrete test subclass
class TestDaemonClient extends BaseDaemonClient {
  protected socketPath = '/tmp/test-daemon.sock'
  protected pidPath = '/tmp/test-daemon.pid'
  protected daemonScriptName = 'test-daemon.js'
  protected label = 'test-daemon'

  public handledEvents: any[] = []

  protected handleEvent(msg: any): void {
    this.handledEvents.push(msg)
  }

  public getNextReqId(): string {
    return this.nextReqId()
  }
}

function createMockSocket() {
  const sock = Object.assign(new EventEmitter(), {
    write: vi.fn(),
    destroy: vi.fn(),
  })
  currentMockSocket = sock
  return sock
}

let client: TestDaemonClient

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  client = new TestDaemonClient()
  createMockSocket()
})

afterEach(() => {
  vi.useRealTimers()
})

/** Helper: simulate a successful socket connection */
async function connectClient() {
  const connectPromise = (client as any).connectToSocket()
  currentMockSocket.emit('connect')
  await connectPromise
}

// ==================== request() ====================

describe('request', () => {
  it('rejects immediately when not connected', async () => {
    expect(client.connected).toBe(false)
    await expect(client.request({ type: 'test' })).rejects.toThrow('not connected to daemon')
  })

  it('writes NDJSON to socket and resolves when response arrives', async () => {
    await connectClient()
    expect(client.connected).toBe(true)

    const resultPromise = client.request({ type: 'ping', reqId: 'req-1' })

    expect(currentMockSocket.write).toHaveBeenCalledWith(
      expect.stringContaining('"type":"ping"')
    )
    const written = currentMockSocket.write.mock.calls[0][0] as string
    expect(written.endsWith('\n')).toBe(true)

    currentMockSocket.emit('data', JSON.stringify({ reqId: 'req-1', type: 'ok', data: { pong: true } }) + '\n')

    const result = await resultPromise
    expect(result).toEqual({ pong: true })
  })

  it('rejects on timeout', async () => {
    await connectClient()

    const resultPromise = client.request({ type: 'slow', reqId: 'req-2' }, 5000)

    vi.advanceTimersByTime(5001)

    await expect(resultPromise).rejects.toThrow('timed out after 5000ms')
  })

  it('rejects when response is an error type', async () => {
    await connectClient()

    const resultPromise = client.request({ type: 'bad', reqId: 'req-3' })

    currentMockSocket.emit('data', JSON.stringify({ reqId: 'req-3', type: 'error', message: 'not found' }) + '\n')

    await expect(resultPromise).rejects.toThrow('not found')
  })

  it('generates reqId when not provided', async () => {
    await connectClient()

    client.request({ type: 'auto-id' })

    const written = JSON.parse((currentMockSocket.write.mock.calls[0][0] as string).trim())
    expect(written.reqId).toMatch(/^req-\d+-\d+$/)
  })
})

// ==================== NDJSON protocol ====================

describe('NDJSON protocol', () => {
  beforeEach(async () => {
    await connectClient()
  })

  it('handles multiple messages in a single data chunk', () => {
    const msg1 = { type: 'event1', data: 'a' }
    const msg2 = { type: 'event2', data: 'b' }

    currentMockSocket.emit('data', JSON.stringify(msg1) + '\n' + JSON.stringify(msg2) + '\n')

    expect(client.handledEvents).toHaveLength(2)
    expect(client.handledEvents[0]).toMatchObject(msg1)
    expect(client.handledEvents[1]).toMatchObject(msg2)
  })

  it('handles messages split across data chunks', () => {
    const msg = { type: 'split', data: 'hello' }
    const json = JSON.stringify(msg)
    const half = Math.floor(json.length / 2)

    currentMockSocket.emit('data', json.slice(0, half))
    expect(client.handledEvents).toHaveLength(0)

    currentMockSocket.emit('data', json.slice(half) + '\n')
    expect(client.handledEvents).toHaveLength(1)
    expect(client.handledEvents[0]).toMatchObject(msg)
  })

  it('skips blank lines', () => {
    currentMockSocket.emit('data', '\n\n' + JSON.stringify({ type: 'real' }) + '\n\n')

    expect(client.handledEvents).toHaveLength(1)
  })

  it('handles malformed JSON gracefully', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    currentMockSocket.emit('data', '{ broken json }\n' + JSON.stringify({ type: 'valid' }) + '\n')

    expect(client.handledEvents).toHaveLength(1)
    expect(client.handledEvents[0].type).toBe('valid')
    expect(consoleSpy).toHaveBeenCalled()

    consoleSpy.mockRestore()
  })

  it('routes responses to pending requests by reqId', async () => {
    const resultPromise = client.request({ type: 'q', reqId: 'match-me' })

    currentMockSocket.emit('data', JSON.stringify({ reqId: 'match-me', type: 'ok', data: 42 }) + '\n')

    const result = await resultPromise
    expect(result).toBe(42)
    expect(client.handledEvents).toHaveLength(0)
  })

  it('delegates events without reqId to handleEvent', () => {
    currentMockSocket.emit('data', JSON.stringify({ type: 'broadcast', info: 'hi' }) + '\n')

    expect(client.handledEvents).toHaveLength(1)
    expect(client.handledEvents[0].info).toBe('hi')
  })

  it('resets buffer on overflow (>50MB)', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const bigChunk = 'x'.repeat(51 * 1024 * 1024)
    currentMockSocket.emit('data', bigChunk)

    currentMockSocket.emit('data', JSON.stringify({ type: 'afterOverflow' }) + '\n')
    expect(client.handledEvents).toHaveLength(1)
    expect(client.handledEvents[0].type).toBe('afterOverflow')

    consoleSpy.mockRestore()
  })
})

// ==================== disconnect ====================

describe('disconnect', () => {
  it('sets connected to false and destroys socket', async () => {
    await connectClient()
    expect(client.connected).toBe(true)

    client.disconnect()

    expect(client.connected).toBe(false)
    expect(currentMockSocket.destroy).toHaveBeenCalled()
  })

  it('is safe to call when not connected', () => {
    expect(() => client.disconnect()).not.toThrow()
  })
})

// ==================== killDaemonProcess ====================

describe('killDaemonProcess', () => {
  it('reads PID file and kills the process', () => {
    const mockFsModule = fs as any
    mockFsModule.existsSync.mockReturnValue(true)
    mockFsModule.readFileSync.mockReturnValue('12345\n')

    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)

    client.killDaemonProcess()

    expect(killSpy).toHaveBeenCalledWith(12345, 'SIGKILL')
    expect(mockFsModule.unlinkSync).toHaveBeenCalledWith('/tmp/test-daemon.pid')
    expect(mockFsModule.unlinkSync).toHaveBeenCalledWith('/tmp/test-daemon.sock')

    killSpy.mockRestore()
  })

  it('does nothing when PID file does not exist', () => {
    const mockFsModule = fs as any
    mockFsModule.existsSync.mockReturnValue(false)

    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)

    client.killDaemonProcess()

    expect(killSpy).not.toHaveBeenCalled()
    killSpy.mockRestore()
  })

  it('handles kill failure gracefully', () => {
    const mockFsModule = fs as any
    mockFsModule.existsSync.mockReturnValue(true)
    mockFsModule.readFileSync.mockReturnValue('99999\n')

    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('ESRCH')
    })

    expect(() => client.killDaemonProcess()).not.toThrow()
    killSpy.mockRestore()
  })
})

// ==================== Socket close drains pending ====================

describe('socket close handling', () => {
  it('rejects all pending requests when socket closes', async () => {
    await connectClient()

    const p1 = client.request({ type: 'a', reqId: 'r1' })
    const p2 = client.request({ type: 'b', reqId: 'r2' })

    currentMockSocket.emit('close')

    await expect(p1).rejects.toThrow('daemon connection closed')
    await expect(p2).rejects.toThrow('daemon connection closed')
  })

  it('emits disconnected event on socket close', async () => {
    await connectClient()

    const disconnectedSpy = vi.fn()
    client.on('disconnected', disconnectedSpy)

    currentMockSocket.emit('close')

    expect(disconnectedSpy).toHaveBeenCalledOnce()
  })

  it('emits connected event on socket connect', async () => {
    const connectedSpy = vi.fn()
    client.on('connected', connectedSpy)

    await connectClient()

    expect(connectedSpy).toHaveBeenCalledOnce()
  })
})

// ==================== nextReqId ====================

describe('nextReqId', () => {
  it('generates incrementing request IDs', () => {
    const id1 = client.getNextReqId()
    const id2 = client.getNextReqId()

    expect(id1).toMatch(/^req-\d+-\d+$/)
    expect(id2).toMatch(/^req-\d+-\d+$/)

    const counter1 = parseInt(id1.split('-')[1])
    const counter2 = parseInt(id2.split('-')[1])
    expect(counter2).toBe(counter1 + 1)
  })
})

// ==================== Version check ====================

describe('version check', () => {
  it('emits version-mismatch when daemon version differs', async () => {
    await connectClient()

    const mismatchSpy = vi.fn()
    client.on('version-mismatch', mismatchSpy)

    const versionCheckPromise = (client as any).checkDaemonVersion()

    const lastCall = currentMockSocket.write.mock.calls[currentMockSocket.write.mock.calls.length - 1]
    const payload = JSON.parse((lastCall[0] as string).trim())
    expect(payload.type).toBe('version')

    currentMockSocket.emit('data', JSON.stringify({ reqId: payload.reqId, type: 'ok', data: { version: 1 } }) + '\n')

    await versionCheckPromise

    expect(mismatchSpy).toHaveBeenCalledWith({ running: 1, expected: 42 })
  })

  it('does not emit when versions match', async () => {
    await connectClient()

    const mismatchSpy = vi.fn()
    client.on('version-mismatch', mismatchSpy)

    const versionCheckPromise = (client as any).checkDaemonVersion()

    const lastCall = currentMockSocket.write.mock.calls[currentMockSocket.write.mock.calls.length - 1]
    const payload = JSON.parse((lastCall[0] as string).trim())

    currentMockSocket.emit('data', JSON.stringify({ reqId: payload.reqId, type: 'ok', data: { version: 42 } }) + '\n')

    await versionCheckPromise

    expect(mismatchSpy).not.toHaveBeenCalled()
  })

  it('emits version-mismatch when version request fails (old daemon)', async () => {
    await connectClient()

    const mismatchSpy = vi.fn()
    client.on('version-mismatch', mismatchSpy)

    const versionCheckPromise = (client as any).checkDaemonVersion()

    const lastCall = currentMockSocket.write.mock.calls[currentMockSocket.write.mock.calls.length - 1]
    const payload = JSON.parse((lastCall[0] as string).trim())

    currentMockSocket.emit('data', JSON.stringify({ reqId: payload.reqId, type: 'error', message: 'unknown type' }) + '\n')

    await versionCheckPromise

    expect(mismatchSpy).toHaveBeenCalledWith({ running: 0, expected: 42 })
  })
})
