import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { BatchRun, BatchConfig } from '../../shared/types'

describe('batch-runner', () => {
  let tmpDir: string
  let mod: typeof import('../batch-runner')

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `batch-test-${Date.now()}-${Math.random()}`)
    fs.mkdirSync(tmpDir, { recursive: true })

    vi.resetModules()

    // Fresh module import with mocked colony-paths
    vi.doMock('../../shared/colony-paths', () => ({
      colonyPaths: { root: tmpDir },
    }), { virtual: true })

    mod = await import('../batch-runner')
  })

  afterEach(() => {
    vi.unmock('../../shared/colony-paths')
    vi.resetModules()
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('returns default batch config', () => {
    const config = mod.getDefaultBatchConfig()
    expect(config).toEqual({
      enabled: false,
      schedule: '0 2 * * *',
      concurrency: 1,
      timeoutPerTaskMinutes: 30,
      onCompletion: 'nothing',
      reportRecipients: [],
    })
  })

  it('parses valid task queue YAML', async () => {
    const yamlFile = path.join(tmpDir, 'test-queue.yaml')
    const content = `name: Test Queue
tasks:
  - id: task1
    name: First Task
    prompt: Hello world
  - id: task2
    name: Second Task
    prompt: Goodbye
    priority: 2
`
    fs.writeFileSync(yamlFile, content, 'utf-8')

    const tasks = await mod.parseTaskQueue(yamlFile)
    expect(tasks).not.toBeNull()
    expect(tasks).toHaveLength(2)
    expect(tasks?.[0]).toEqual({
      id: 'task1',
      name: 'First Task',
      prompt: 'Hello world',
    })
    expect(tasks?.[1].priority).toBe(2)
  })

  it('returns null for missing task queue file', async () => {
    const result = await mod.parseTaskQueue('/nonexistent/path.yaml')
    expect(result).toBeNull()
  })

  it('returns null for invalid YAML', async () => {
    const yamlFile = path.join(tmpDir, 'bad.yaml')
    fs.writeFileSync(yamlFile, 'invalid: : : yaml', 'utf-8')

    const result = await mod.parseTaskQueue(yamlFile)
    // parseYaml will try to parse it, but it won't have a tasks array
    expect(result).toBeNull()
  })

  it('creates a new batch run', () => {
    const run = mod.createBatchRun(5)
    expect(run.id).toBeDefined()
    expect(run.taskCount).toBe(5)
    expect(run.successCount).toBe(0)
    expect(run.failedCount).toBe(0)
    expect(run.timeoutCount).toBe(0)
    expect(run.totalCostUsd).toBe(0)
    expect(run.totalDurationMs).toBe(0)
    expect(run.tasks).toEqual([])
    expect(run.createdAt).toBeDefined()
  })

  it('adds tasks to batch run and updates counts', () => {
    const run = mod.createBatchRun(3)

    mod.addTaskToBatchRun(run, {
      taskId: 'task1',
      status: 'success',
      costUsd: 0.05,
      durationMs: 5000,
      startedAt: new Date().toISOString(),
    })

    expect(run.successCount).toBe(1)
    expect(run.totalCostUsd).toBe(0.05)
    expect(run.totalDurationMs).toBe(5000)

    mod.addTaskToBatchRun(run, {
      taskId: 'task2',
      status: 'timeout',
      costUsd: 0.03,
      durationMs: 1800000, // 30 min timeout
      startedAt: new Date().toISOString(),
    })

    expect(run.timeoutCount).toBe(1)
    expect(run.totalCostUsd).toBe(0.08)

    mod.addTaskToBatchRun(run, {
      taskId: 'task3',
      status: 'failed',
      costUsd: 0.02,
      durationMs: 2000,
      startedAt: new Date().toISOString(),
    })

    expect(run.failedCount).toBe(1)
    expect(run.tasks).toHaveLength(3)
  })

  it('completes batch run with timestamp', () => {
    const run = mod.createBatchRun(1)
    expect(run.completedAt).toBeUndefined()

    mod.completeBatchRun(run)
    expect(run.completedAt).toBeDefined()
  })

  it('generates batch report markdown', () => {
    const run = mod.createBatchRun(3)
    run.startedAt = '2026-04-08T12:00:00Z'
    run.completedAt = '2026-04-08T12:05:00Z'

    mod.addTaskToBatchRun(run, {
      taskId: 'task1',
      status: 'success',
      costUsd: 0.05,
      durationMs: 100000,
      startedAt: '2026-04-08T12:00:00Z',
      completedAt: '2026-04-08T12:01:40Z',
    })

    mod.addTaskToBatchRun(run, {
      taskId: 'task2',
      status: 'success',
      costUsd: 0.03,
      durationMs: 80000,
      startedAt: '2026-04-08T12:01:40Z',
      completedAt: '2026-04-08T12:03:00Z',
    })

    mod.addTaskToBatchRun(run, {
      taskId: 'task3',
      status: 'failed',
      costUsd: 0.02,
      durationMs: 20000,
      startedAt: '2026-04-08T12:03:00Z',
      completedAt: '2026-04-08T12:03:20Z',
    })

    const report = mod.generateBatchReport(run)
    expect(report).toContain('Batch Run')
    expect(report).toContain('3 total')
    expect(report).toContain('2 ✓')
    expect(report).toContain('1 ✗')
    expect(report).toContain('$0.10')
    expect(report).toContain('task1')
    expect(report).toContain('task3')
  })

  it('appends and retrieves batch history (ring buffer, max 100)', async () => {
    // Create 150 batch runs
    const runs: BatchRun[] = []
    for (let i = 0; i < 150; i++) {
      const run = mod.createBatchRun(1)
      run.successCount = 1
      runs.push(run)
    }

    // Append all runs (ring buffer should trim to 100)
    for (const run of runs) {
      await mod.appendBatchHistory(run)
    }

    // Retrieve history
    const retrieved = await mod.getBatchHistory(150)
    expect(retrieved).toHaveLength(100) // max 100
    expect(retrieved[0].id).toBe(runs[50].id) // first 50 trimmed
    expect(retrieved[99].id).toBe(runs[149].id) // last one
  })

  it('handles empty history file gracefully', async () => {
    const history = await mod.getBatchHistory(20)
    expect(history).toEqual([])
  })

  it('respects limit parameter in getBatchHistory', async () => {
    const runs: BatchRun[] = []
    for (let i = 0; i < 30; i++) {
      const run = mod.createBatchRun(1)
      runs.push(run)
      await mod.appendBatchHistory(run)
    }

    const history = await mod.getBatchHistory(10)
    expect(history).toHaveLength(10)
    // Should be the last 10
    expect(history[9].id).toBe(runs[29].id)
  })
})
