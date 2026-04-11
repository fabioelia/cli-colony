/**
 * Batch Task Executor — spawn and manage batch runs from task queues.
 * Handles schedule firing, task spawning, history tracking, and report generation.
 */

import { promises as fsp } from 'fs'
import { join } from 'path'
import { v4 as uuid } from 'uuid'
import { parseYaml } from '../shared/yaml-parser'
import { colonyPaths } from '../shared/colony-paths'
import { cronMatches } from '../shared/cron'
import { BatchConfig, BatchRun, BatchTaskRun, BatchTaskStatus } from '../shared/types'
import { createInstance } from './instance-manager'
import { sendPromptWhenReady } from './send-prompt-when-ready'
import { waitForSessionCompletion } from './session-completion'
import { broadcast } from './broadcast'

const BATCH_HISTORY_FILE = join(colonyPaths.root, 'batch-history.jsonl')
const BATCH_CONFIG_KEY = 'batch-config'
const MAX_HISTORY_ENTRIES = 100

interface TaskQueueItem {
  id: string
  name: string
  priority?: number
  prompt: string
  [key: string]: any
}

interface TaskQueueYaml {
  name: string
  tasks: TaskQueueItem[]
  [key: string]: any
}

/**
 * Load batch config from settings (or return defaults).
 * In a real implementation, this would read from settings.json.
 */
export function getDefaultBatchConfig(): BatchConfig {
  return {
    enabled: false,
    schedule: '0 2 * * *',  // 2am daily
    concurrency: 1,
    timeoutPerTaskMinutes: 30,
    onCompletion: 'nothing',
    reportRecipients: [],
  }
}

/**
 * Parse a task queue YAML file and extract tasks.
 * Returns null if parsing fails.
 */
export async function parseTaskQueue(filePath: string): Promise<TaskQueueItem[] | null> {
  try {
    const content = await fsp.readFile(filePath, 'utf-8')
    const parsed = parseYaml(content)
    if (!parsed || !Array.isArray(parsed.tasks)) return null
    return parsed.tasks as TaskQueueItem[]
  } catch (err) {
    console.error(`Failed to parse task queue ${filePath}:`, err)
    return null
  }
}

/**
 * Append a batch run to history (ring buffer, max 100 entries).
 */
export async function appendBatchHistory(run: BatchRun): Promise<void> {
  try {
    let entries: BatchRun[] = []
    try {
      const lines = (await fsp.readFile(BATCH_HISTORY_FILE, 'utf-8'))
        .split('\n')
        .filter(l => l.trim())
      entries = lines.map(l => {
        try { return JSON.parse(l) } catch { return null }
      }).filter((e): e is BatchRun => e !== null)
    } catch { /* file doesn't exist */ }
    entries.push(run)
    // Trim to last 100 entries
    if (entries.length > MAX_HISTORY_ENTRIES) {
      entries = entries.slice(entries.length - MAX_HISTORY_ENTRIES)
    }
    // Write as JSONL (one entry per line)
    const content = entries.map(e => JSON.stringify(e)).join('\n') + '\n'
    await fsp.writeFile(BATCH_HISTORY_FILE, content, 'utf-8')
  } catch (err) {
    console.error('Failed to append batch history:', err)
  }
}

/**
 * Retrieve recent batch runs from history.
 */
export async function getBatchHistory(limit: number = 20): Promise<BatchRun[]> {
  try {
    const lines = (await fsp.readFile(BATCH_HISTORY_FILE, 'utf-8'))
      .split('\n')
      .filter(l => l.trim())
    const entries = lines.map(l => {
      try { return JSON.parse(l) } catch { return null }
    }).filter((e): e is BatchRun => e !== null)
    return entries.slice(-limit)
  } catch {
    return []
  }
}

/**
 * Generate a summary report markdown for a batch run.
 */
export function generateBatchReport(run: BatchRun): string {
  const timestamp = new Date(run.createdAt).toLocaleString()
  const durationSec = run.totalDurationMs / 1000
  const durationMin = Math.round(durationSec / 60)

  return `# Batch Run #${run.id.slice(0, 8)} — ${timestamp}

## Summary
- **Tasks**: ${run.taskCount} total
- **Completed**: ${run.successCount} ✓ ${run.failedCount} ✗ ${run.timeoutCount} ⏱
- **Cost**: $${run.totalCostUsd.toFixed(2)}
- **Duration**: ${durationMin}m

## Tasks
${run.tasks.map(t => `- **${t.taskId}** — ${t.status} (${t.durationMs}ms, $${(t.costUsd || 0).toFixed(2)})`).join('\n')}
`
}

/**
 * Create a new batch run record.
 * Called when batch execution starts.
 */
export function createBatchRun(taskCount: number): BatchRun {
  return {
    id: uuid(),
    createdAt: new Date().toISOString(),
    taskCount,
    successCount: 0,
    failedCount: 0,
    timeoutCount: 0,
    totalCostUsd: 0,
    totalDurationMs: 0,
    tasks: [],
  }
}

/**
 * Add a completed task to a batch run.
 */
export function addTaskToBatchRun(
  run: BatchRun,
  task: BatchTaskRun,
): void {
  run.tasks.push(task)
  if (task.status === 'success') run.successCount++
  else if (task.status === 'timeout') run.timeoutCount++
  else if (task.status === 'failed') run.failedCount++

  if (task.costUsd) run.totalCostUsd += task.costUsd
  if (task.durationMs) run.totalDurationMs += task.durationMs
}

/**
 * Mark a batch run as completed.
 */
export function completeBatchRun(run: BatchRun): void {
  run.completedAt = new Date().toISOString()
}

/**
 * Execute a batch run: scan task queues, spawn sessions with concurrency limit,
 * track results, and persist history.
 */
export async function executeBatch(config: BatchConfig): Promise<BatchRun> {
  // 1. Scan task queue directory
  const taskQueueDir = colonyPaths.taskQueues
  const files = (await fsp.readdir(taskQueueDir))
    .filter(f => (f.endsWith('.yaml') || f.endsWith('.yml')) && !f.endsWith('.memory.md'))

  // 2. Parse all tasks
  const allTasks: Array<{ task: TaskQueueItem; queueName: string }> = []
  for (const file of files) {
    const tasks = await parseTaskQueue(join(taskQueueDir, file))
    if (tasks) {
      const queueName = file.replace(/\.(yaml|yml)$/, '')
      for (const task of tasks) allTasks.push({ task, queueName })
    }
  }

  if (allTasks.length === 0) throw new Error('No tasks found in task queues')

  // 3. Create batch run tracker
  const run = createBatchRun(allTasks.length)
  broadcast('batch:started', { batchId: run.id, taskCount: allTasks.length })

  // 4. Execute with concurrency limit
  const taskQueue = [...allTasks]
  const timeoutMs = config.timeoutPerTaskMinutes * 60_000

  async function runNext(): Promise<void> {
    const item = taskQueue.shift()
    if (!item) return
    const { task, queueName } = item
    const start = Date.now()
    const taskRun: BatchTaskRun = {
      taskId: task.id || task.name || uuid(),
      queueName,
      status: 'running' as BatchTaskStatus,
      startedAt: new Date().toISOString(),
      durationMs: 0,
    }
    try {
      const inst = await createInstance({
        name: `Batch: ${task.name || task.id}`,
        workingDirectory: (task as any).directory || colonyPaths.root,
      })
      // Attach completion listener BEFORE sending prompt (race condition guard)
      const completionPromise = waitForSessionCompletion(inst.id, timeoutMs)
      await sendPromptWhenReady(inst.id, { prompt: task.prompt, abandonTimeout: 30_000 })
      const completed = await completionPromise
      taskRun.status = completed ? 'success' : 'timeout'
    } catch (err) {
      taskRun.status = 'failed'
    }
    taskRun.durationMs = Date.now() - start
    addTaskToBatchRun(run, taskRun)
    broadcast('batch:taskComplete', { batchId: run.id, task: taskRun })
    await runNext()
  }

  // Launch up to concurrency workers
  const workers = Array.from({ length: config.concurrency }, () => runNext())
  await Promise.all(workers)

  // 5. Finalize
  completeBatchRun(run)
  await appendBatchHistory(run)

  // Generate report if configured
  if (config.onCompletion === 'report') {
    const report = generateBatchReport(run)
    const reportDir = join(colonyPaths.root, 'outputs', 'batch-reports')
    await fsp.mkdir(reportDir, { recursive: true })
    await fsp.writeFile(join(reportDir, `${run.id}.md`), report, 'utf-8')
  }

  broadcast('batch:completed', { batchId: run.id, run })
  return run
}

// --- Batch Cron Scheduler ---

let batchTimer: ReturnType<typeof setInterval> | null = null
let lastBatchCronMinute = -1

/**
 * Start the batch cron scheduler. Clears any existing timer first.
 * Checks every 60s if the cron expression matches and fires executeBatch.
 */
export function startBatchScheduler(config: BatchConfig): void {
  stopBatchScheduler()
  if (!config.enabled || !config.schedule) return

  batchTimer = setInterval(() => {
    const now = new Date()
    const currentMinute = now.getHours() * 60 + now.getMinutes()
    if (cronMatches(config.schedule, now) && currentMinute !== lastBatchCronMinute) {
      lastBatchCronMinute = currentMinute
      console.log(`[batch] Cron matched at ${now.toLocaleTimeString()}, firing batch`)
      executeBatch(config).catch(err => {
        console.error('[batch] Scheduled batch execution failed:', err)
      })
    }
  }, 60_000)
}

/**
 * Stop the batch cron scheduler.
 */
export function stopBatchScheduler(): void {
  if (batchTimer) {
    clearInterval(batchTimer)
    batchTimer = null
  }
}
