/**
 * Tests for src/main/pending-session-launches.ts
 *
 * Strategy: mock broadcast, createInstance, getEnvironmentLogs, sendPromptWhenReady,
 * and the electron import (genId pulls from crypto, not electron — no mock needed there).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { EnvStatus } from '../../shared/types'

// ---- Shared mocks ----
const mockBroadcast = vi.fn()
const mockCreateInstance = vi.fn()
const mockGetEnvironmentLogs = vi.fn()
const mockSendPromptWhenReady = vi.fn()

function setupMocks(): void {
  vi.doMock('../broadcast', () => ({ broadcast: mockBroadcast }))
  vi.doMock('../instance-manager', () => ({
    createInstance: mockCreateInstance,
  }))
  vi.doMock('../env-manager', () => ({
    getEnvironmentLogs: mockGetEnvironmentLogs,
  }))
  vi.doMock('../send-prompt-when-ready', () => ({
    sendPromptWhenReady: mockSendPromptWhenReady,
  }))
}

function makeEnv(overrides: Partial<EnvStatus> = {}): EnvStatus {
  return {
    id: 'env-1',
    name: 'test-env',
    projectType: 'generic',
    branch: 'develop',
    status: 'running',
    services: [
      { name: 'backend', status: 'running', pid: 111, port: 3001, uptime: 5, restarts: 0 },
      { name: 'frontend', status: 'running', pid: 222, port: 3002, uptime: 5, restarts: 0 },
    ],
    urls: {},
    ports: {},
    paths: {},
    createdAt: new Date().toISOString(),
    ...overrides,
  }
}

describe('pending-session-launches', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    mockBroadcast.mockClear()
    mockCreateInstance.mockReset().mockResolvedValue({ id: 'inst-1', name: 'Test' })
    mockGetEnvironmentLogs.mockReset().mockResolvedValue('log line 1\nlog line 2')
    mockSendPromptWhenReady.mockReset().mockResolvedValue(undefined)
    setupMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.doUnmock('../broadcast')
    vi.doUnmock('../instance-manager')
    vi.doUnmock('../env-manager')
    vi.doUnmock('../send-prompt-when-ready')
  })

  it('registerPendingLaunch returns an id and broadcasts waiting status', async () => {
    const mod = await import('../pending-session-launches')
    const id = mod.registerPendingLaunch({
      envId: 'env-1',
      envName: 'test-env',
      spawnOpts: { workingDirectory: '/tmp/env' },
    })
    expect(typeof id).toBe('string')
    expect(id.length).toBeGreaterThan(0)
    expect(mockBroadcast).toHaveBeenCalledWith(
      'pendingLaunch:status',
      expect.objectContaining({ id, envId: 'env-1', state: 'waiting' }),
    )
    mod._resetPendingLaunches()
  })

  it('fires ready path when all required services become running', async () => {
    const mod = await import('../pending-session-launches')
    const id = mod.registerPendingLaunch({
      envId: 'env-1',
      envName: 'test-env',
      spawnOpts: { workingDirectory: '/tmp/env', name: 'Session' },
    })

    // Env comes up — all services running
    mod.handleEnvStatusUpdate([makeEnv()])
    // Let firePending's microtasks settle
    await vi.runAllTimersAsync()

    expect(mockCreateInstance).toHaveBeenCalledWith(
      expect.objectContaining({ workingDirectory: '/tmp/env', name: 'Session' }),
    )
    expect(mockBroadcast).toHaveBeenCalledWith(
      'pendingLaunch:status',
      expect.objectContaining({ id, state: 'ready' }),
    )
    expect(mockBroadcast).toHaveBeenCalledWith(
      'pendingLaunch:spawned',
      expect.objectContaining({ pendingId: id, autoHeal: false }),
    )
    expect(mod.getPendingLaunches()).toHaveLength(0)
  })

  it('ignores optional mcp-server crashes', async () => {
    const mod = await import('../pending-session-launches')
    mod.registerPendingLaunch({
      envId: 'env-1',
      envName: 'test-env',
      spawnOpts: {},
    })

    const env = makeEnv({
      services: [
        { name: 'backend', status: 'running', pid: 1, port: 3001, uptime: 1, restarts: 0 },
        { name: 'mcp-server', status: 'crashed', pid: null, port: null, uptime: 0, restarts: 0 },
      ],
    })
    mod.handleEnvStatusUpdate([env])
    await vi.runAllTimersAsync()

    expect(mockCreateInstance).toHaveBeenCalledTimes(1)
    expect(mockBroadcast).toHaveBeenCalledWith(
      'pendingLaunch:spawned',
      expect.objectContaining({ autoHeal: false }),
    )
  })

  it('fires failed path with auto-heal prompt when a required service crashes', async () => {
    const mod = await import('../pending-session-launches')
    mockGetEnvironmentLogs.mockResolvedValue('Error: ECONNREFUSED\nFailed to bind port 3001')

    mod.registerPendingLaunch({
      envId: 'env-1',
      envName: 'test-env',
      spawnOpts: { name: 'Worker' },
    })

    const env = makeEnv({
      status: 'partial',
      services: [
        { name: 'backend', status: 'crashed', pid: null, port: 3001, uptime: 0, restarts: 1 },
        { name: 'frontend', status: 'running', pid: 2, port: 3002, uptime: 5, restarts: 0 },
      ],
    })
    mod.handleEnvStatusUpdate([env])
    await vi.runAllTimersAsync()

    expect(mockCreateInstance).toHaveBeenCalled()
    expect(mockSendPromptWhenReady).toHaveBeenCalled()
    const promptArg = mockSendPromptWhenReady.mock.calls[0][1].prompt as string
    expect(promptArg).toContain('failed to start cleanly')
    expect(promptArg).toContain('backend')
    expect(promptArg).toContain('Error: ECONNREFUSED')
    expect(mockBroadcast).toHaveBeenCalledWith(
      'pendingLaunch:spawned',
      expect.objectContaining({ autoHeal: true }),
    )
  })

  it('fires failed path when env.status is error', async () => {
    const mod = await import('../pending-session-launches')
    mod.registerPendingLaunch({
      envId: 'env-1',
      envName: 'test-env',
      spawnOpts: {},
    })

    const env = makeEnv({
      status: 'error',
      services: [], // no services yet — setup errored out
    })
    mod.handleEnvStatusUpdate([env])
    await vi.runAllTimersAsync()

    expect(mockCreateInstance).toHaveBeenCalled()
    expect(mockBroadcast).toHaveBeenCalledWith(
      'pendingLaunch:spawned',
      expect.objectContaining({ autoHeal: true }),
    )
  })

  it('stays waiting while env is creating', async () => {
    const mod = await import('../pending-session-launches')
    mod.registerPendingLaunch({
      envId: 'env-1',
      envName: 'test-env',
      spawnOpts: {},
    })

    const env = makeEnv({ status: 'creating' })
    mod.handleEnvStatusUpdate([env])
    // Flush microtasks without advancing the 5-minute timeout timer
    await Promise.resolve()

    expect(mockCreateInstance).not.toHaveBeenCalled()
    expect(mod.getPendingLaunches()).toHaveLength(1)
    expect(mod.getPendingLaunches()[0].state).toBe('waiting')
    mod._resetPendingLaunches()
  })

  it('cancelPendingLaunch removes the entry without spawning', async () => {
    const mod = await import('../pending-session-launches')
    const id = mod.registerPendingLaunch({
      envId: 'env-1',
      envName: 'test-env',
      spawnOpts: {},
    })
    const ok = mod.cancelPendingLaunch(id)
    expect(ok).toBe(true)
    expect(mod.getPendingLaunches()).toHaveLength(0)
    expect(mockBroadcast).toHaveBeenCalledWith(
      'pendingLaunch:status',
      expect.objectContaining({ id, state: 'cancelled' }),
    )

    // Subsequent env-ready update should NOT spawn
    mod.handleEnvStatusUpdate([makeEnv()])
    await vi.runAllTimersAsync()
    expect(mockCreateInstance).not.toHaveBeenCalled()
  })

  it('cancelPendingLaunch returns false for unknown id', async () => {
    const mod = await import('../pending-session-launches')
    expect(mod.cancelPendingLaunch('not-real')).toBe(false)
  })

  it('timeout after 5 minutes spawns session anyway', async () => {
    const mod = await import('../pending-session-launches')
    const id = mod.registerPendingLaunch({
      envId: 'env-1',
      envName: 'test-env',
      spawnOpts: { workingDirectory: '/tmp/stuck' },
    })

    // Advance time past the timeout
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1)

    expect(mockCreateInstance).toHaveBeenCalledWith(
      expect.objectContaining({ workingDirectory: '/tmp/stuck' }),
    )
    expect(mockBroadcast).toHaveBeenCalledWith(
      'pendingLaunch:status',
      expect.objectContaining({ id, state: 'timeout' }),
    )
    expect(mockBroadcast).toHaveBeenCalledWith(
      'pendingLaunch:spawned',
      expect.objectContaining({ timedOut: true }),
    )
  })

  it('getPendingLaunches filters by envId', async () => {
    const mod = await import('../pending-session-launches')
    mod.registerPendingLaunch({ envId: 'env-1', envName: 'a', spawnOpts: {} })
    mod.registerPendingLaunch({ envId: 'env-2', envName: 'b', spawnOpts: {} })
    mod.registerPendingLaunch({ envId: 'env-1', envName: 'c', spawnOpts: {} })

    expect(mod.getPendingLaunches()).toHaveLength(3)
    expect(mod.getPendingLaunches('env-1')).toHaveLength(2)
    expect(mod.getPendingLaunches('env-2')).toHaveLength(1)
    expect(mod.getPendingLaunches('nope')).toHaveLength(0)
    mod._resetPendingLaunches()
  })

  it('ignores env updates for unrelated envIds', async () => {
    const mod = await import('../pending-session-launches')
    mod.registerPendingLaunch({
      envId: 'env-1',
      envName: 'test-env',
      spawnOpts: {},
    })

    // Update for a different env
    mod.handleEnvStatusUpdate([makeEnv({ id: 'env-other' })])
    await Promise.resolve()

    expect(mockCreateInstance).not.toHaveBeenCalled()
    expect(mod.getPendingLaunches()).toHaveLength(1)
    mod._resetPendingLaunches()
  })

  it('ignores status updates after the entry has resolved', async () => {
    const mod = await import('../pending-session-launches')
    mod.registerPendingLaunch({
      envId: 'env-1',
      envName: 'test-env',
      spawnOpts: {},
    })

    // First update → ready, spawns once
    mod.handleEnvStatusUpdate([makeEnv()])
    await vi.runAllTimersAsync()
    expect(mockCreateInstance).toHaveBeenCalledTimes(1)

    // Second update → should not spawn again
    mod.handleEnvStatusUpdate([makeEnv()])
    await vi.runAllTimersAsync()
    expect(mockCreateInstance).toHaveBeenCalledTimes(1)
  })

  it('prefixes initialPrompt with auto-heal context when failed', async () => {
    const mod = await import('../pending-session-launches')
    mod.registerPendingLaunch({
      envId: 'env-1',
      envName: 'test-env',
      spawnOpts: {},
      initialPrompt: 'Review the PR and comment.',
    })

    mod.handleEnvStatusUpdate([makeEnv({
      services: [
        { name: 'backend', status: 'crashed', pid: null, port: null, uptime: 0, restarts: 1 },
      ],
    })])
    await vi.runAllTimersAsync()

    expect(mockSendPromptWhenReady).toHaveBeenCalled()
    const promptArg = mockSendPromptWhenReady.mock.calls[0][1].prompt as string
    expect(promptArg).toContain('failed to start cleanly')
    expect(promptArg).toContain('Review the PR and comment.')
  })
})
