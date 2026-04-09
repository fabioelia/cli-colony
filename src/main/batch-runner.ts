/**
 * Batch Task Executor — spawn and manage batch runs from task queues.
 * Handles schedule firing, task spawning, history tracking, and report generation.
 */

import { promises as fsp } from 'fs'
import { join } from 'path'
import { v4 as uuid } from 'uuid'
import { parseYaml } from '../shared/yaml-parser'
import { colonyPaths } from '../shared/colony-paths'
import { BatchConfig, BatchRun, BatchTaskRun, BatchTaskStatus } from '../shared/types'

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
