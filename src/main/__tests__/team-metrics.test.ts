/**
 * Tests for team-metrics.ts — worker session tracking and aggregation.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Shared mock state for fs.promises
const mockFsp = {
  readFile: vi.fn(),
  writeFile: vi.fn().mockResolvedValue(undefined),
  appendFile: vi.fn().mockResolvedValue(undefined),
}

describe('team-metrics', () => {
  let mod: typeof import('../team-metrics')

  beforeEach(async () => {
    vi.resetModules()

    mockFsp.readFile.mockReset().mockRejectedValue(new Error('ENOENT'))
    mockFsp.writeFile.mockReset().mockResolvedValue(undefined)
    mockFsp.appendFile.mockReset().mockResolvedValue(undefined)

    vi.doMock('fs', () => ({
      promises: mockFsp,
    }))

    vi.doMock('../../shared/colony-paths', () => ({
      colonyPaths: { root: '/mock/.claude-colony' },
    }))

    mod = await import('../team-metrics')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('extracts worker ID from "Worker: <name>" pattern', async () => {
    const entries: any[] = []

    // Mock appendFile to capture entries
    mockFsp.appendFile.mockImplementation(async (path: string, data: string) => {
      entries.push(JSON.parse(data.trim()))
    })
    // readFile for trimToRetention — return empty to avoid interference
    mockFsp.readFile.mockRejectedValue(new Error('ENOENT'))

    await mod.recordWorkerExit('Worker: deploy-service', 'session-1', 0, 5000, 0.15)

    expect(entries).toHaveLength(1)
    expect(entries[0].workerId).toBe('deploy-service')
    expect(entries[0].status).toBe('success')
  })

  it('marks session as success when exitCode === 0', async () => {
    const entries: any[] = []
    mockFsp.appendFile.mockImplementation(async (path: string, data: string) => {
      entries.push(JSON.parse(data.trim()))
    })
    mockFsp.readFile.mockRejectedValue(new Error('ENOENT'))

    await mod.recordWorkerExit('Worker: test', 'session-1', 0, 5000, 0.1)

    expect(entries[0].status).toBe('success')
  })

  it('marks session as failed when exitCode !== 0', async () => {
    const entries: any[] = []
    mockFsp.appendFile.mockImplementation(async (path: string, data: string) => {
      entries.push(JSON.parse(data.trim()))
    })
    mockFsp.readFile.mockRejectedValue(new Error('ENOENT'))

    await mod.recordWorkerExit('Worker: test', 'session-1', 1, 5000, 0.1)

    expect(entries[0].status).toBe('failed')
  })

  it('extracts worker ID from null name as "unknown"', async () => {
    const entries: any[] = []
    mockFsp.appendFile.mockImplementation(async (path: string, data: string) => {
      entries.push(JSON.parse(data.trim()))
    })
    mockFsp.readFile.mockRejectedValue(new Error('ENOENT'))

    await mod.recordWorkerExit(null, 'session-1', 0, 5000, 0.1)

    expect(entries[0].workerId).toBe('unknown')
  })

  it('getTeamMetrics returns empty metrics when no entries exist', async () => {
    mockFsp.readFile.mockRejectedValue(new Error('ENOENT'))

    const metrics = await mod.getTeamMetrics('7d')

    expect(metrics.teamSuccessRate).toBe(0)
    expect(metrics.avgDurationMs).toBe(0)
    expect(metrics.activeWorkerCount).toBe(0)
    expect(metrics.workers).toHaveLength(0)
  })

  it('getTeamMetrics aggregates multiple workers correctly', async () => {
    const entries = [
      {
        id: '1',
        timestamp: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
        workerId: 'worker-a',
        status: 'success',
        durationMs: 6000,
        costUsd: 0.1,
      },
      {
        id: '2',
        timestamp: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
        workerId: 'worker-a',
        status: 'failed',
        durationMs: 4000,
        costUsd: 0.05,
      },
      {
        id: '3',
        timestamp: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString(),
        workerId: 'worker-b',
        status: 'success',
        durationMs: 8000,
        costUsd: 0.2,
      },
    ]

    mockFsp.readFile.mockResolvedValue(entries.map(e => JSON.stringify(e)).join('\n'))

    const metrics = await mod.getTeamMetrics('7d')

    // 2 successes out of 3 = 66.67%
    expect(metrics.teamSuccessRate).toBeCloseTo(66.67, 1)
    // avg duration = (6000 + 4000 + 8000) / 3 = 6000
    expect(metrics.avgDurationMs).toBe(6000)
    // 2 active workers
    expect(metrics.activeWorkerCount).toBe(2)
    expect(metrics.workers).toHaveLength(2)

    // worker-a: 2 runs, 50% success
    const workerA = metrics.workers.find(w => w.workerId === 'worker-a')
    expect(workerA?.runsCount).toBe(2)
    expect(workerA?.successRate).toBeCloseTo(50, 1)

    // worker-b: 1 run, 100% success
    const workerB = metrics.workers.find(w => w.workerId === 'worker-b')
    expect(workerB?.runsCount).toBe(1)
    expect(workerB?.successRate).toBeCloseTo(100, 1)
  })

  it('getTeamMetrics respects 7d window filter', async () => {
    const now = Date.now()
    const entries = [
      {
        id: '1',
        timestamp: new Date(now - 5 * 24 * 60 * 60 * 1000).toISOString(), // 5 days ago
        workerId: 'worker-a',
        status: 'success',
        durationMs: 5000,
        costUsd: 0.1,
      },
      {
        id: '2',
        timestamp: new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString(), // 10 days ago
        workerId: 'worker-b',
        status: 'success',
        durationMs: 5000,
        costUsd: 0.1,
      },
    ]

    mockFsp.readFile.mockResolvedValue(entries.map(e => JSON.stringify(e)).join('\n'))

    const metrics = await mod.getTeamMetrics('7d')

    // Only 1 entry within 7 days
    expect(metrics.activeWorkerCount).toBe(1)
    expect(metrics.workers[0].workerId).toBe('worker-a')
  })

  it('getTeamMetrics includes YTD cost (not window-limited)', async () => {
    const now = Date.now()
    const entries = [
      {
        id: '1',
        timestamp: new Date(now - 5 * 24 * 60 * 60 * 1000).toISOString(), // 5 days ago, in 7d window
        workerId: 'worker-a',
        status: 'success',
        durationMs: 5000,
        costUsd: 0.1,
      },
      {
        id: '2',
        timestamp: new Date(now - 100 * 24 * 60 * 60 * 1000).toISOString(), // 100 days ago, outside 7d window
        workerId: 'worker-b',
        status: 'success',
        durationMs: 5000,
        costUsd: 0.9,
      },
    ]

    mockFsp.readFile.mockResolvedValue(entries.map(e => JSON.stringify(e)).join('\n'))

    const metrics = await mod.getTeamMetrics('7d')

    // totalCostYtd should include BOTH entries (not windowed)
    expect(metrics.totalCostYtd).toBeCloseTo(1.0, 2)
  })

  it('getWorkerHistory returns recent runs for a worker', async () => {
    const entries = [
      {
        id: '1',
        timestamp: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
        workerId: 'worker-a',
        status: 'success',
        durationMs: 5000,
        costUsd: 0.1,
      },
      {
        id: '2',
        timestamp: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
        workerId: 'worker-a',
        status: 'failed',
        durationMs: 4000,
        costUsd: 0.05,
      },
      {
        id: '3',
        timestamp: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(),
        workerId: 'worker-b',
        status: 'success',
        durationMs: 8000,
        costUsd: 0.2,
      },
    ]

    mockFsp.readFile.mockResolvedValue(entries.map(e => JSON.stringify(e)).join('\n'))

    const history = await mod.getWorkerHistory('worker-a', 10)

    expect(history).toHaveLength(2)
    // Most recent first
    expect(history[0].id).toBe('2')
    expect(history[1].id).toBe('1')
  })

  it('getWorkerHistory filters by status', async () => {
    const entries = [
      {
        id: '1',
        timestamp: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
        workerId: 'worker-a',
        status: 'success',
        durationMs: 5000,
        costUsd: 0.1,
      },
      {
        id: '2',
        timestamp: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
        workerId: 'worker-a',
        status: 'failed',
        durationMs: 4000,
        costUsd: 0.05,
      },
    ]

    mockFsp.readFile.mockResolvedValue(entries.map(e => JSON.stringify(e)).join('\n'))

    const successes = await mod.getWorkerHistory('worker-a', 10, 'success')

    expect(successes).toHaveLength(1)
    expect(successes[0].status).toBe('success')
  })

  it('getWorkerHistory respects limit parameter', async () => {
    const entries = Array.from({ length: 30 }, (_, i) => ({
      id: `${i}`,
      timestamp: new Date(Date.now() - i * 60 * 60 * 1000).toISOString(),
      workerId: 'worker-a',
      status: 'success',
      durationMs: 5000,
      costUsd: 0.1,
    }))

    mockFsp.readFile.mockResolvedValue(entries.map(e => JSON.stringify(e)).join('\n'))

    const history = await mod.getWorkerHistory('worker-a', 10)

    expect(history).toHaveLength(10)
  })

  it('exportMetricsAsCsv generates valid CSV', async () => {
    const entries = [
      {
        id: '1',
        timestamp: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
        workerId: 'worker-a',
        status: 'success',
        durationMs: 6000,
        costUsd: 0.1,
      },
      {
        id: '2',
        timestamp: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
        workerId: 'worker-b',
        status: 'success',
        durationMs: 8000,
        costUsd: 0.2,
      },
    ]

    mockFsp.readFile.mockResolvedValue(entries.map(e => JSON.stringify(e)).join('\n'))

    const csv = await mod.exportMetricsAsCsv('7d')

    expect(csv).toContain('Worker ID')
    expect(csv).toContain('worker-a')
    expect(csv).toContain('worker-b')
    expect(csv).toContain('100.00') // 100% success
    expect(csv).toContain('0.1000') // cost format
  })

  it('skips malformed JSONL entries during parsing', async () => {
    const content = [
      '{"id":"1","timestamp":"2024-01-01T00:00:00Z","workerId":"worker-a","status":"success","durationMs":5000,"costUsd":0.1}',
      'INVALID JSON that should be skipped',
      '{"id":"2","timestamp":"2024-01-02T00:00:00Z","workerId":"worker-b","status":"success","durationMs":5000,"costUsd":0.1}',
      '',  // empty line
    ].join('\n')

    mockFsp.readFile.mockResolvedValue(content)

    const metrics = await mod.getTeamMetrics('30d')

    expect(metrics).toBeDefined()
  })

  it('handles missing file gracefully', async () => {
    mockFsp.readFile.mockRejectedValue(new Error('ENOENT'))

    const metrics = await mod.getTeamMetrics('7d')
    const history = await mod.getWorkerHistory('worker-a')
    const csv = await mod.exportMetricsAsCsv('7d')

    expect(metrics.activeWorkerCount).toBe(0)
    expect(history).toHaveLength(0)
    expect(csv).toContain('Worker ID') // Header only
  })
})
