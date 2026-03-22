# Architecture Plan: Hybrid PTY + SDK Flow System (Phase 1)

## Current State

The existing architecture is a clean three-layer system:

1. **PTY Daemon** (`src/daemon/pty-daemon.ts`, 582 lines) -- standalone Node process owning PTY file descriptors. Communicates via NDJSON over Unix domain socket at `~/.claude-colony/daemon.sock`. Manages instance lifecycle (create/kill/restart), streams output as base64, detects activity via 2s polling. Has zero knowledge of flows or triggers.

2. **Electron Main** (`src/main/`) -- `DaemonClient` (441 lines) connects to daemon socket with auto-reconnect. `instance-manager.ts` adds Electron concerns (notifications, sound, auto-cleanup). IPC handlers bridge everything to the renderer.

3. **Renderer** -- React UI with terminal views, sidebar, agent panel, settings.

### What Works

- Daemon architecture: crash-resilient, NDJSON protocol is trivially extensible (new `type` values in the discriminated union).
- Settings at `~/.claude-colony/settings.json` -- simple JSON, no database.
- Agent scanner already reads markdown files with YAML frontmatter from `~/.claude/agents/`.
- The build config (`electron.vite.config.ts`) already compiles the daemon as a separate entry point alongside `main`, so adding more daemon-side modules costs nothing.

### What Doesn't

- **No programmatic execution.** Every Claude interaction goes through a PTY. There is no headless mode. The SDK changes this.
- **No flow concept.** Nothing chains one Claude task into another.
- **No trigger concept.** Nothing fires actions on schedule or in response to events.
- **Activity detection is heuristic.** The daemon polls every 2s comparing output buffer tails. This is adequate for UI indicators but unreliable for flow orchestration ("is Claude actually done?"). The SDK solves this -- `query()` returns a `result` message with explicit `subtype: 'success'` or error states.

### Key Decision: Hybrid PTY + SDK

PTY instances remain for interactive use (user watches, intervenes, sends follow-up prompts). But automated flow steps use the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) directly. This gives us:

- **Clean exit signals.** The SDK's `SDKResultMessage` tells us exactly when a step finished and whether it succeeded.
- **Structured output.** The `result` field on success messages contains Claude's final text response. With `outputFormat`, we can even get JSON-schema-validated output.
- **No ANSI parsing.** No terminal escape codes, no TUI redraws, no heuristic activity detection.
- **Cost tracking.** `total_cost_usd` and `usage` come back on every result.
- **Abort control.** `AbortController` for cancellation, `maxTurns` and `maxBudgetUsd` for guardrails.

The tradeoff: SDK steps are not visible in the terminal UI as live PTY sessions. They run headless. The flow run viewer will show their status, output, and cost instead. This is the right tradeoff -- you don't need to watch automated background tasks character by character.

---

## Target State (Phase 1 Scope)

Phase 1 delivers: **YAML flow definitions + cron triggers + sequential SDK-based flow execution**. No file watchers, no webhooks, no instance-event triggers, no parallel steps. Those come later and the design accommodates them without rework.

### Components

| Component | Responsibility | Location |
|-----------|---------------|----------|
| **Flow Store** | Loads and parses YAML flow definitions from `~/.claude-colony/flows/` | `src/daemon/flow-store.ts` |
| **Trigger Store** | Loads/saves trigger definitions from `~/.claude-colony/triggers.json` | `src/daemon/trigger-store.ts` |
| **Cron Engine** | Schedules and fires cron triggers | `src/daemon/cron-engine.ts` |
| **SDK Executor** | Runs a single Claude Agent SDK step: prompt in, structured result out | `src/daemon/sdk-executor.ts` |
| **Flow Engine** | Orchestrates multi-step flows: runs steps sequentially, passes data between them, persists run state | `src/daemon/flow-engine.ts` |
| **Protocol extensions** | New daemon request/response/event types for flows and triggers | `src/daemon/protocol.ts` (modified) |

### Data Flow

```
Cron fires -> Trigger Store resolves action -> Flow Engine starts run
  -> For each step:
       Flow Engine calls SDK Executor with resolved prompt
       SDK Executor calls query() from @anthropic-ai/claude-agent-sdk
       SDK Executor streams messages, collects result
       Flow Engine captures result, interpolates into next step's prompt
  -> Flow Engine persists FlowRun state
  -> Daemon broadcasts flow:progress events to subscribers
  -> Electron UI receives events, shows flow status
```

---

## Data Model

### Flow Definition Format (`~/.claude-colony/flows/*.yaml`)

YAML, not markdown. Rationale: flow definitions are structured data (step names, parameters, references). YAML handles this cleanly. Markdown is great for prose-heavy documents (agent prompts, READMEs) but awkward when you need nested structured fields. The prompt text within each step can be multi-line YAML strings, which is perfectly readable.

```yaml
# ~/.claude-colony/flows/daily-review.yaml

name: daily-review
description: Review open PRs and summarize status

# Inputs supplied at runtime (by trigger or manual invocation)
inputs:
  repo:
    type: string
    required: true
    description: Path to the repository
  branch:
    type: string
    default: main

# Default options applied to all steps (overridable per step)
defaults:
  model: claude-sonnet-4-20250514
  maxTurns: 10
  maxBudgetUsd: 0.50
  permissionMode: bypassPermissions
  allowedTools:
    - Read
    - Glob
    - Grep
    - Bash

steps:
  - name: check-prs
    prompt: |
      List all open PRs in this repo. For each PR, summarize:
      - Title and author
      - Files changed
      - CI status
      Return results as a JSON array.
    cwd: "{{inputs.repo}}"
    # outputFormat constrains Claude to return valid JSON matching this schema
    outputFormat:
      type: json_schema
      schema:
        type: object
        properties:
          prs:
            type: array
            items:
              type: object
              properties:
                title: { type: string }
                author: { type: string }
                status: { type: string }
              required: [title, author, status]
        required: [prs]

  - name: summarize
    prompt: |
      Given these PR statuses:
      {{steps.check-prs.output}}

      Write a concise daily summary suitable for Slack.
      Include an overall health assessment.
    cwd: "{{inputs.repo}}"
    model: claude-sonnet-4-20250514
    # No outputFormat -- plain text result

  - name: notify
    prompt: |
      Post this summary to the #dev-updates channel:
      {{steps.summarize.result}}
    cwd: "{{inputs.repo}}"
    allowedTools:
      - Bash
    maxTurns: 3
```

### Template Variable Resolution

Templates use `{{...}}` syntax. Available variables:

| Variable | Scope | Value |
|----------|-------|-------|
| `{{inputs.NAME}}` | All steps | Flow input value |
| `{{steps.STEP_NAME.result}}` | Steps after the named step | The `result` string from the SDK's `SDKResultMessage` |
| `{{steps.STEP_NAME.output}}` | Steps after the named step | If `outputFormat` was used, the parsed structured output (JSON-stringified). Otherwise, same as `result`. |
| `{{steps.STEP_NAME.cost}}` | Steps after the named step | `total_cost_usd` from the step |
| `{{steps.STEP_NAME.session_id}}` | Steps after the named step | Claude session ID (for resumption) |
| `{{trigger.timestamp}}` | All steps (if trigger-started) | ISO timestamp of trigger fire |
| `{{trigger.name}}` | All steps (if trigger-started) | Trigger name |
| `{{run.id}}` | All steps | Current flow run ID |

### Trigger Definition Format (`~/.claude-colony/triggers.json`)

```typescript
interface TriggerDefinition {
  id: string
  name: string
  enabled: boolean

  // Phase 1: only 'cron' and 'manual'
  condition:
    | { type: 'cron'; expression: string; timezone?: string }
    | { type: 'manual' }
  // Future: | { type: 'file-watch'; ... } | { type: 'webhook'; ... } | { type: 'instance-event'; ... }

  action:
    | { type: 'run-flow'; flowName: string; inputs?: Record<string, string> }
  // Future: | { type: 'spawn'; ... } | { type: 'prompt'; ... }

  createdAt: string
  lastFiredAt: string | null
  fireCount: number
}
```

### Flow Run State (`~/.claude-colony/flow-runs/{id}.json`)

```typescript
interface FlowRun {
  id: string
  flowName: string
  status: 'running' | 'completed' | 'failed' | 'cancelled'
  triggerId: string | null       // null if manually started
  inputs: Record<string, unknown>
  steps: FlowStepRun[]
  startedAt: string
  completedAt: string | null
  error: string | null
  totalCostUsd: number
}

interface FlowStepRun {
  name: string
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped'
  result: string | null          // SDKResultMessage.result (plain text)
  output: unknown | null         // parsed structured_output if outputFormat was used
  sessionId: string | null       // Claude session ID
  costUsd: number
  usage: { input: number; output: number } | null
  numTurns: number
  startedAt: string | null
  completedAt: string | null
  durationMs: number | null
  error: string | null
}
```

---

## Module Design

### 1. SDK Executor (`src/daemon/sdk-executor.ts`)

Single responsibility: run one Claude Agent SDK query and return a structured result.

```typescript
import { query } from '@anthropic-ai/claude-agent-sdk'
import type { SDKMessage, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk'

export interface SdkStepOptions {
  prompt: string
  cwd: string
  model?: string
  maxTurns?: number
  maxBudgetUsd?: number
  permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions'
  allowedTools?: string[]
  disallowedTools?: string[]
  systemPrompt?: string
  outputFormat?: { type: 'json_schema'; schema: Record<string, unknown> }
  abortSignal?: AbortSignal
  onMessage?: (msg: SDKMessage) => void  // progress callback
}

export interface SdkStepResult {
  success: boolean
  result: string                  // final text result (empty string on error)
  structuredOutput: unknown | null // parsed output if outputFormat was used
  sessionId: string
  costUsd: number
  usage: { input: number; output: number }
  numTurns: number
  durationMs: number
  error: string | null            // error message if failed
  subtype: string                 // 'success' | 'error_max_turns' | etc.
}

export async function runSdkStep(opts: SdkStepOptions): Promise<SdkStepResult> {
  const startTime = Date.now()
  const abortController = new AbortController()

  // Wire external abort signal if provided
  if (opts.abortSignal) {
    opts.abortSignal.addEventListener('abort', () => abortController.abort())
  }

  const q = query({
    prompt: opts.prompt,
    options: {
      cwd: opts.cwd,
      model: opts.model,
      maxTurns: opts.maxTurns,
      maxBudgetUsd: opts.maxBudgetUsd,
      permissionMode: opts.permissionMode || 'bypassPermissions',
      allowedTools: opts.allowedTools,
      disallowedTools: opts.disallowedTools,
      systemPrompt: opts.systemPrompt,
      outputFormat: opts.outputFormat,
      abortController,
      // Don't load any filesystem settings -- we control everything
      settingSources: [],
      // Don't persist sessions to disk by default (the flow engine tracks state)
      persistSession: true,  // keep true so we can resume if needed
    },
  })

  let resultMsg: SDKResultMessage | null = null
  let sessionId = ''

  for await (const msg of q) {
    // Capture session ID from init message
    if (msg.type === 'system' && msg.subtype === 'init') {
      sessionId = msg.session_id
    }

    // Forward all messages to progress callback
    opts.onMessage?.(msg)

    // Capture the result
    if (msg.type === 'result') {
      resultMsg = msg
    }
  }

  const durationMs = Date.now() - startTime

  if (!resultMsg) {
    return {
      success: false,
      result: '',
      structuredOutput: null,
      sessionId,
      costUsd: 0,
      usage: { input: 0, output: 0 },
      numTurns: 0,
      durationMs,
      error: 'No result message received from SDK',
      subtype: 'error_during_execution',
    }
  }

  if (resultMsg.subtype === 'success') {
    return {
      success: true,
      result: resultMsg.result,
      structuredOutput: resultMsg.structured_output ?? null,
      sessionId: resultMsg.session_id,
      costUsd: resultMsg.total_cost_usd,
      usage: {
        input: resultMsg.usage.input_tokens,
        output: resultMsg.usage.output_tokens,
      },
      numTurns: resultMsg.num_turns,
      durationMs,
      error: null,
      subtype: 'success',
    }
  }

  // Error subtypes: error_max_turns, error_during_execution, error_max_budget_usd
  return {
    success: false,
    result: '',
    structuredOutput: null,
    sessionId: resultMsg.session_id,
    costUsd: resultMsg.total_cost_usd,
    usage: {
      input: resultMsg.usage.input_tokens,
      output: resultMsg.usage.output_tokens,
    },
    numTurns: resultMsg.num_turns,
    durationMs,
    error: resultMsg.errors?.join('; ') || `Step failed: ${resultMsg.subtype}`,
    subtype: resultMsg.subtype,
  }
}
```

**Key design decisions:**

- `permissionMode` defaults to `bypassPermissions` for automated flows. The user opted into running this flow; prompting for permission per tool call makes no sense in a headless context.
- `settingSources: []` -- the flow definition controls everything. No surprise behavior from user's global Claude settings.
- `persistSession: true` -- sessions are saved so the flow engine can reference them later (for debugging, resumption, or attaching to a PTY view).
- The `onMessage` callback lets the flow engine forward progress events to subscribers without the SDK executor needing to know about the daemon protocol.

### 2. Flow Store (`src/daemon/flow-store.ts`)

Reads YAML files from `~/.claude-colony/flows/`. No write operations -- users create/edit flow files with their editor. The store re-scans on demand.

```typescript
import * as fs from 'fs'
import * as path from 'path'

// We'll use a lightweight YAML parser -- see dependencies section
import { parse as parseYaml } from 'yaml'

export interface FlowInputDef {
  type: 'string' | 'number' | 'boolean'
  required?: boolean
  default?: unknown
  description?: string
}

export interface FlowStepDef {
  name: string
  prompt: string
  cwd?: string                    // template-resolvable
  model?: string
  maxTurns?: number
  maxBudgetUsd?: number
  permissionMode?: string
  allowedTools?: string[]
  disallowedTools?: string[]
  systemPrompt?: string
  outputFormat?: { type: 'json_schema'; schema: Record<string, unknown> }
}

export interface FlowDefinition {
  name: string
  description: string
  filePath: string                // absolute path to the YAML file
  inputs: Record<string, FlowInputDef>
  defaults: Partial<FlowStepDef>  // defaults applied to all steps
  steps: FlowStepDef[]
}

const FLOWS_DIR = path.join(process.env.HOME || '/', '.claude-colony', 'flows')

export function scanFlows(): FlowDefinition[] {
  if (!fs.existsSync(FLOWS_DIR)) return []
  const files = fs.readdirSync(FLOWS_DIR).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'))
  const flows: FlowDefinition[] = []

  for (const file of files) {
    const filePath = path.join(FLOWS_DIR, file)
    try {
      const content = fs.readFileSync(filePath, 'utf-8')
      const parsed = parseYaml(content)
      if (!parsed?.name || !parsed?.steps?.length) continue

      const inputs: Record<string, FlowInputDef> = {}
      if (parsed.inputs) {
        for (const [key, val] of Object.entries(parsed.inputs)) {
          const v = val as Record<string, unknown>
          inputs[key] = {
            type: (v.type as string) || 'string',
            required: v.required !== false,
            default: v.default,
            description: (v.description as string) || '',
          }
        }
      }

      const defaults: Partial<FlowStepDef> = parsed.defaults || {}

      const steps: FlowStepDef[] = parsed.steps.map((s: Record<string, unknown>) => ({
        name: s.name as string,
        prompt: s.prompt as string,
        cwd: (s.cwd as string) || defaults.cwd,
        model: (s.model as string) || defaults.model,
        maxTurns: (s.maxTurns as number) || defaults.maxTurns,
        maxBudgetUsd: (s.maxBudgetUsd as number) || defaults.maxBudgetUsd,
        permissionMode: (s.permissionMode as string) || defaults.permissionMode,
        allowedTools: (s.allowedTools as string[]) || defaults.allowedTools,
        disallowedTools: (s.disallowedTools as string[]) || defaults.disallowedTools,
        systemPrompt: (s.systemPrompt as string) || defaults.systemPrompt,
        outputFormat: (s.outputFormat as FlowStepDef['outputFormat']) || defaults.outputFormat,
      }))

      flows.push({
        name: parsed.name,
        description: parsed.description || '',
        filePath,
        inputs,
        defaults,
        steps,
      })
    } catch (err) {
      // Skip unparseable files, log to stderr
      process.stderr.write(`[flow-store] failed to parse ${file}: ${err}\n`)
    }
  }

  return flows
}

export function getFlow(name: string): FlowDefinition | null {
  return scanFlows().find(f => f.name === name) || null
}
```

### 3. Trigger Store (`src/daemon/trigger-store.ts`)

```typescript
import * as fs from 'fs'
import * as path from 'path'

export interface TriggerDefinition {
  id: string
  name: string
  enabled: boolean
  condition:
    | { type: 'cron'; expression: string; timezone?: string }
    | { type: 'manual' }
  action:
    | { type: 'run-flow'; flowName: string; inputs?: Record<string, string> }
  createdAt: string
  lastFiredAt: string | null
  fireCount: number
}

const TRIGGERS_PATH = path.join(process.env.HOME || '/', '.claude-colony', 'triggers.json')

export class TriggerStore {
  private triggers: TriggerDefinition[] = []

  load(): void {
    try {
      if (fs.existsSync(TRIGGERS_PATH)) {
        this.triggers = JSON.parse(fs.readFileSync(TRIGGERS_PATH, 'utf-8'))
      }
    } catch {
      this.triggers = []
    }
  }

  save(): void {
    const dir = path.dirname(TRIGGERS_PATH)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(TRIGGERS_PATH, JSON.stringify(this.triggers, null, 2), 'utf-8')
  }

  getAll(): TriggerDefinition[] { return this.triggers }
  getEnabled(): TriggerDefinition[] { return this.triggers.filter(t => t.enabled) }
  get(id: string): TriggerDefinition | null { return this.triggers.find(t => t.id === id) || null }

  create(trigger: TriggerDefinition): void {
    this.triggers.push(trigger)
    this.save()
  }

  update(id: string, updates: Partial<TriggerDefinition>): boolean {
    const idx = this.triggers.findIndex(t => t.id === id)
    if (idx < 0) return false
    this.triggers[idx] = { ...this.triggers[idx], ...updates }
    this.save()
    return true
  }

  delete(id: string): boolean {
    const before = this.triggers.length
    this.triggers = this.triggers.filter(t => t.id !== id)
    if (this.triggers.length < before) { this.save(); return true }
    return false
  }

  recordFired(id: string): void {
    const trigger = this.get(id)
    if (trigger) {
      trigger.lastFiredAt = new Date().toISOString()
      trigger.fireCount++
      this.save()
    }
  }
}
```

### 4. Cron Engine (`src/daemon/cron-engine.ts`)

```typescript
import { schedule, ScheduledTask, validate } from 'node-cron'
import type { TriggerStore, TriggerDefinition } from './trigger-store'

export class CronEngine {
  private jobs = new Map<string, ScheduledTask>()
  private onFire: (trigger: TriggerDefinition) => void

  constructor(
    private triggerStore: TriggerStore,
    onFire: (trigger: TriggerDefinition) => void,
  ) {
    this.onFire = onFire
  }

  /** Call after trigger store is loaded and whenever triggers change */
  sync(): void {
    // Stop all existing jobs
    for (const job of this.jobs.values()) job.stop()
    this.jobs.clear()

    // Schedule enabled cron triggers
    for (const trigger of this.triggerStore.getEnabled()) {
      if (trigger.condition.type !== 'cron') continue
      if (!validate(trigger.condition.expression)) {
        process.stderr.write(`[cron] invalid expression for trigger ${trigger.id}: ${trigger.condition.expression}\n`)
        continue
      }
      const opts = trigger.condition.timezone ? { timezone: trigger.condition.timezone } : {}
      const job = schedule(trigger.condition.expression, () => {
        process.stderr.write(`[cron] firing trigger ${trigger.id} (${trigger.name})\n`)
        this.triggerStore.recordFired(trigger.id)
        this.onFire(trigger)
      }, opts)
      this.jobs.set(trigger.id, job)
    }

    process.stderr.write(`[cron] ${this.jobs.size} jobs scheduled\n`)
  }

  stop(): void {
    for (const job of this.jobs.values()) job.stop()
    this.jobs.clear()
  }

  hasActiveJobs(): boolean {
    return this.jobs.size > 0
  }
}
```

### 5. Flow Engine (`src/daemon/flow-engine.ts`)

The orchestrator. Runs in the daemon process (not a separate process). Rationale: the daemon already survives Electron crashes and manages its own lifecycle. Adding another process adds operational complexity for zero benefit. The flow engine is just async functions -- it doesn't block the event loop (the SDK executor spawns a child process internally).

```typescript
import * as fs from 'fs'
import * as path from 'path'
import { runSdkStep, SdkStepResult, SdkStepOptions } from './sdk-executor'
import { getFlow, FlowDefinition, FlowStepDef } from './flow-store'

// ---- Types ----

export interface FlowRun {
  id: string
  flowName: string
  status: 'running' | 'completed' | 'failed' | 'cancelled'
  triggerId: string | null
  inputs: Record<string, unknown>
  steps: FlowStepRun[]
  startedAt: string
  completedAt: string | null
  error: string | null
  totalCostUsd: number
}

export interface FlowStepRun {
  name: string
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped'
  result: string | null
  output: unknown | null
  sessionId: string | null
  costUsd: number
  usage: { input: number; output: number } | null
  numTurns: number
  startedAt: string | null
  completedAt: string | null
  durationMs: number | null
  error: string | null
}

const RUNS_DIR = path.join(process.env.HOME || '/', '.claude-colony', 'flow-runs')

// ---- Template resolution ----

function resolveTemplate(
  template: string,
  context: {
    inputs: Record<string, unknown>
    steps: Record<string, { result: string | null; output: unknown; cost: number; session_id: string | null }>
    trigger: { timestamp: string; name: string } | null
    run: { id: string }
  },
): string {
  return template.replace(/\{\{(\S+?)\}\}/g, (match, keyPath: string) => {
    const parts = keyPath.split('.')
    let value: unknown

    if (parts[0] === 'inputs' && parts[1]) {
      value = context.inputs[parts[1]]
    } else if (parts[0] === 'steps' && parts[1] && parts[2]) {
      const step = context.steps[parts[1]]
      if (step) {
        if (parts[2] === 'result') value = step.result
        else if (parts[2] === 'output') value = typeof step.output === 'string' ? step.output : JSON.stringify(step.output)
        else if (parts[2] === 'cost') value = step.cost
        else if (parts[2] === 'session_id') value = step.session_id
      }
    } else if (parts[0] === 'trigger' && parts[1] && context.trigger) {
      value = context.trigger[parts[1] as keyof typeof context.trigger]
    } else if (parts[0] === 'run' && parts[1]) {
      value = context.run[parts[1] as keyof typeof context.run]
    }

    return value != null ? String(value) : match  // leave unresolved templates as-is
  })
}

// ---- Persistence ----

function ensureRunsDir(): void {
  if (!fs.existsSync(RUNS_DIR)) fs.mkdirSync(RUNS_DIR, { recursive: true })
}

function persistRun(run: FlowRun): void {
  ensureRunsDir()
  fs.writeFileSync(path.join(RUNS_DIR, `${run.id}.json`), JSON.stringify(run, null, 2), 'utf-8')
}

export function loadRun(id: string): FlowRun | null {
  const filePath = path.join(RUNS_DIR, `${id}.json`)
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'))
  } catch { return null }
}

export function listRuns(limit = 50): FlowRun[] {
  ensureRunsDir()
  const files = fs.readdirSync(RUNS_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => ({ name: f, mtime: fs.statSync(path.join(RUNS_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit)

  return files.map(f => {
    try { return JSON.parse(fs.readFileSync(path.join(RUNS_DIR, f.name), 'utf-8')) }
    catch { return null }
  }).filter(Boolean) as FlowRun[]
}

// ---- Engine ----

// Active runs tracked for cancellation
const activeRuns = new Map<string, AbortController>()

export function getActiveRunIds(): string[] {
  return Array.from(activeRuns.keys())
}

export function cancelRun(runId: string): boolean {
  const controller = activeRuns.get(runId)
  if (!controller) return false
  controller.abort()
  return true
}

export async function executeFlow(
  flowName: string,
  inputs: Record<string, unknown>,
  opts: {
    triggerId?: string
    triggerName?: string
    onProgress?: (run: FlowRun) => void
  } = {},
): Promise<FlowRun> {
  const flow = getFlow(flowName)
  if (!flow) throw new Error(`Flow not found: ${flowName}`)

  // Validate required inputs
  for (const [key, def] of Object.entries(flow.inputs)) {
    if (def.required && inputs[key] == null) {
      if (def.default != null) {
        inputs[key] = def.default
      } else {
        throw new Error(`Missing required input: ${key}`)
      }
    }
  }

  // Apply defaults for optional inputs
  for (const [key, def] of Object.entries(flow.inputs)) {
    if (inputs[key] == null && def.default != null) {
      inputs[key] = def.default
    }
  }

  const runId = genId()
  const abortController = new AbortController()
  activeRuns.set(runId, abortController)

  const run: FlowRun = {
    id: runId,
    flowName,
    status: 'running',
    triggerId: opts.triggerId || null,
    inputs,
    steps: flow.steps.map(s => ({
      name: s.name,
      status: 'pending',
      result: null,
      output: null,
      sessionId: null,
      costUsd: 0,
      usage: null,
      numTurns: 0,
      startedAt: null,
      completedAt: null,
      durationMs: null,
      error: null,
    })),
    startedAt: new Date().toISOString(),
    completedAt: null,
    error: null,
    totalCostUsd: 0,
  }

  persistRun(run)
  opts.onProgress?.(run)

  // Template context accumulates step results
  const stepResults: Record<string, { result: string | null; output: unknown; cost: number; session_id: string | null }> = {}
  const triggerCtx = opts.triggerId
    ? { timestamp: new Date().toISOString(), name: opts.triggerName || '' }
    : null

  try {
    for (let i = 0; i < flow.steps.length; i++) {
      if (abortController.signal.aborted) {
        run.status = 'cancelled'
        // Mark remaining steps as skipped
        for (let j = i; j < flow.steps.length; j++) {
          run.steps[j].status = 'skipped'
        }
        break
      }

      const stepDef = flow.steps[i]
      const stepRun = run.steps[i]

      stepRun.status = 'running'
      stepRun.startedAt = new Date().toISOString()
      persistRun(run)
      opts.onProgress?.(run)

      // Resolve templates in prompt and cwd
      const templateCtx = {
        inputs,
        steps: stepResults,
        trigger: triggerCtx,
        run: { id: runId },
      }
      const resolvedPrompt = resolveTemplate(stepDef.prompt, templateCtx)
      const resolvedCwd = stepDef.cwd ? resolveTemplate(stepDef.cwd, templateCtx) : (process.env.HOME || '/')

      const stepOpts: SdkStepOptions = {
        prompt: resolvedPrompt,
        cwd: resolvedCwd,
        model: stepDef.model,
        maxTurns: stepDef.maxTurns,
        maxBudgetUsd: stepDef.maxBudgetUsd,
        permissionMode: (stepDef.permissionMode as SdkStepOptions['permissionMode']) || 'bypassPermissions',
        allowedTools: stepDef.allowedTools,
        disallowedTools: stepDef.disallowedTools,
        systemPrompt: stepDef.systemPrompt,
        outputFormat: stepDef.outputFormat,
        abortSignal: abortController.signal,
      }

      let result: SdkStepResult
      try {
        result = await runSdkStep(stepOpts)
      } catch (err) {
        stepRun.status = 'failed'
        stepRun.error = String(err)
        stepRun.completedAt = new Date().toISOString()
        stepRun.durationMs = Date.now() - new Date(stepRun.startedAt!).getTime()
        run.status = 'failed'
        run.error = `Step "${stepDef.name}" threw: ${err}`
        break
      }

      stepRun.result = result.result
      stepRun.output = result.structuredOutput
      stepRun.sessionId = result.sessionId
      stepRun.costUsd = result.costUsd
      stepRun.usage = result.usage
      stepRun.numTurns = result.numTurns
      stepRun.durationMs = result.durationMs
      stepRun.completedAt = new Date().toISOString()
      run.totalCostUsd += result.costUsd

      if (result.success) {
        stepRun.status = 'completed'
        stepResults[stepDef.name] = {
          result: result.result,
          output: result.structuredOutput ?? result.result,
          cost: result.costUsd,
          session_id: result.sessionId,
        }
      } else {
        stepRun.status = 'failed'
        stepRun.error = result.error
        run.status = 'failed'
        run.error = `Step "${stepDef.name}" failed: ${result.error}`
        // Mark remaining steps as skipped
        for (let j = i + 1; j < flow.steps.length; j++) {
          run.steps[j].status = 'skipped'
        }
        break
      }

      persistRun(run)
      opts.onProgress?.(run)
    }

    if (run.status === 'running') {
      run.status = 'completed'
    }
  } catch (err) {
    run.status = 'failed'
    run.error = String(err)
  } finally {
    run.completedAt = new Date().toISOString()
    persistRun(run)
    activeRuns.delete(runId)
    opts.onProgress?.(run)
  }

  return run
}

// Simple ID generator (same as daemon's genId)
function genId(): string {
  const hex = () => Math.random().toString(16).substring(2, 10)
  return `${hex()}${hex()}-${hex()}-${hex()}`
}
```

### 6. Protocol Changes (`src/daemon/protocol.ts`)

New request types, response data, and events added to the existing discriminated unions.

```typescript
// ---- New types to add ----

// Flow definition summary (sent to clients, no need for full step details)
export interface FlowSummary {
  name: string
  description: string
  filePath: string
  inputNames: string[]
  stepCount: number
}

// Flow run type (re-exported from flow-engine for protocol use)
export type { FlowRun, FlowStepRun } from './flow-engine'
export type { TriggerDefinition } from './trigger-store'

// ---- Additions to DaemonRequest union ----
// Add these variants:

  | { type: 'flow:list'; reqId: string }
  | { type: 'flow:get'; reqId: string; flowName: string }
  | { type: 'flow:run'; reqId: string; flowName: string; inputs?: Record<string, unknown> }
  | { type: 'flow:cancel'; reqId: string; runId: string }
  | { type: 'flow:list-runs'; reqId: string; limit?: number }
  | { type: 'flow:get-run'; reqId: string; runId: string }
  | { type: 'trigger:list'; reqId: string }
  | { type: 'trigger:create'; reqId: string; trigger: Omit<TriggerDefinition, 'id' | 'createdAt' | 'lastFiredAt' | 'fireCount'> }
  | { type: 'trigger:update'; reqId: string; triggerId: string; updates: Partial<TriggerDefinition> }
  | { type: 'trigger:delete'; reqId: string; triggerId: string }
  | { type: 'trigger:fire'; reqId: string; triggerId: string }  // manual fire

// ---- Additions to DaemonEvent union ----

  | { type: 'flow:progress'; run: FlowRun }
  | { type: 'trigger:fired'; triggerId: string; triggerName: string; flowName?: string; runId?: string }
```

### 7. Daemon Integration (`src/daemon/pty-daemon.ts` modifications)

The daemon's `main()` function initializes the new subsystems. The `handleRequest` switch gains new cases. The idle timer accounts for active triggers and running flows.

Key changes (not full rewrite -- surgical additions):

```typescript
// In main(), after server starts listening:
import { TriggerStore } from './trigger-store'
import { CronEngine } from './cron-engine'
import { scanFlows, getFlow } from './flow-store'
import { executeFlow, listRuns, loadRun, cancelRun, getActiveRunIds } from './flow-engine'

const triggerStore = new TriggerStore()
triggerStore.load()

const cronEngine = new CronEngine(triggerStore, (trigger) => {
  // When a cron trigger fires, execute its action
  if (trigger.action.type === 'run-flow') {
    executeFlow(trigger.action.flowName, trigger.action.inputs || {}, {
      triggerId: trigger.id,
      triggerName: trigger.name,
      onProgress: (run) => {
        broadcastEvent({ type: 'flow:progress', run })
      },
    }).then((run) => {
      log(`flow run ${run.id} completed: ${run.status}`)
      broadcastEvent({
        type: 'trigger:fired',
        triggerId: trigger.id,
        triggerName: trigger.name,
        flowName: trigger.action.type === 'run-flow' ? trigger.action.flowName : undefined,
        runId: run.id,
      })
    }).catch((err) => {
      log(`flow run failed: ${err}`)
    })
  }
})
cronEngine.sync()

// In handleRequest, add cases for new request types
// (Each case follows the same pattern as existing ones: extract params, call function, send response)

// In resetIdleTimer(), modify the condition:
function resetIdleTimer(): void {
  if (idleTimer) clearTimeout(idleTimer)
  const hasRunning = Array.from(instances.values()).some(i => i.status === 'running')
  const hasActiveFlows = getActiveRunIds().length > 0
  const hasCronJobs = cronEngine.hasActiveJobs()
  if (subscribers.size === 0 && !hasRunning && instances.size === 0 && !hasActiveFlows && !hasCronJobs) {
    idleTimer = setTimeout(() => { /* ... */ }, IDLE_TIMEOUT_MS)
  }
}
```

---

## Protocol Messages -- Complete Specification

For reference, here is exactly what gets added to each union type in `protocol.ts`:

### New DaemonRequest variants

```typescript
// Flows
{ type: 'flow:list'; reqId: string }
// Response data: FlowSummary[]

{ type: 'flow:get'; reqId: string; flowName: string }
// Response data: FlowDefinition | null

{ type: 'flow:run'; reqId: string; flowName: string; inputs?: Record<string, unknown> }
// Response data: { runId: string } (returns immediately, flow runs async)

{ type: 'flow:cancel'; reqId: string; runId: string }
// Response data: boolean

{ type: 'flow:list-runs'; reqId: string; limit?: number }
// Response data: FlowRun[]

{ type: 'flow:get-run'; reqId: string; runId: string }
// Response data: FlowRun | null

// Triggers
{ type: 'trigger:list'; reqId: string }
// Response data: TriggerDefinition[]

{ type: 'trigger:create'; reqId: string;
  trigger: { name: string; enabled: boolean;
    condition: { type: 'cron'; expression: string; timezone?: string } | { type: 'manual' };
    action: { type: 'run-flow'; flowName: string; inputs?: Record<string, string> } } }
// Response data: TriggerDefinition (with generated id, timestamps)

{ type: 'trigger:update'; reqId: string; triggerId: string;
  updates: Partial<TriggerDefinition> }
// Response data: boolean

{ type: 'trigger:delete'; reqId: string; triggerId: string }
// Response data: boolean

{ type: 'trigger:fire'; reqId: string; triggerId: string }
// Response data: { runId: string } | null (null if trigger has no flow action)
```

### New DaemonEvent variants

```typescript
{ type: 'flow:progress'; run: FlowRun }
// Broadcast whenever a flow run's state changes (step starts, completes, fails)

{ type: 'trigger:fired'; triggerId: string; triggerName: string;
  flowName?: string; runId?: string }
// Broadcast when any trigger fires
```

---

## Build and Dependency Changes

### New dependencies

```
yarn add @anthropic-ai/claude-agent-sdk   # SDK for headless execution
yarn add node-cron                         # Cron scheduling
yarn add yaml                              # YAML parsing for flow definitions
yarn add -D @types/node-cron               # Type definitions
```

The `@anthropic-ai/claude-agent-sdk` package internally spawns a Node child process (it does not use `node-pty`). It needs to be available at runtime in the daemon process. Since the daemon runs via `ELECTRON_RUN_AS_NODE=1`, it has full Node.js access. The `externalizeDepsPlugin()` in the vite config already externalizes all `node_modules`, so these packages will be resolved from `node_modules` at runtime rather than bundled -- which is correct.

### electron.vite.config.ts -- no changes needed

The daemon is already compiled as a separate entry point (`'daemon/pty-daemon': 'src/daemon/pty-daemon.ts'`). The new daemon modules (`sdk-executor.ts`, `flow-store.ts`, `trigger-store.ts`, `cron-engine.ts`, `flow-engine.ts`) are imported by `pty-daemon.ts` and will be included in the daemon bundle automatically.

### tsconfig.node.json -- no changes needed

The `include` already covers `src/main/**/*`. The daemon files are in `src/daemon/` but they are compiled by electron-vite's rollup, not directly by tsc. The daemon files import from each other and from `protocol.ts` which is already in scope. No tsconfig changes required.

---

## Migration Plan

### Phase 1a: Data Layer (Stores + Types)

**Goal:** Flow and trigger definitions can be loaded, parsed, and persisted. No execution yet.

**Files:**
- Create: `src/daemon/flow-store.ts`
- Create: `src/daemon/trigger-store.ts`
- Modify: `src/daemon/protocol.ts` -- add flow/trigger types and all new request/response/event variants to the unions

**Steps:**
1. Add `yaml` dependency: `yarn add yaml`
2. Add `node-cron` dependency: `yarn add node-cron && yarn add -D @types/node-cron`
3. Create `src/daemon/trigger-store.ts` with `TriggerStore` class
4. Create `src/daemon/flow-store.ts` with `scanFlows()` and `getFlow()`
5. Extend `protocol.ts` with all new types (FlowSummary, FlowRun, FlowStepRun, TriggerDefinition) and all new DaemonRequest/DaemonEvent variants
6. Create a test flow file at `~/.claude-colony/flows/test-echo.yaml` to validate parsing:
   ```yaml
   name: test-echo
   description: Simple test flow
   inputs:
     message:
       type: string
       required: true
   steps:
     - name: echo
       prompt: "Repeat this message back to me: {{inputs.message}}"
       maxTurns: 1
   ```

**Validation:** Import flow-store in a test script, call `scanFlows()`, verify the test flow parses correctly. Import trigger-store, create/list/delete triggers, verify JSON persistence.

**Risk:** Minimal. Pure data layer, no side effects.

### Phase 1b: SDK Executor

**Goal:** A single SDK step can be executed headlessly and returns a structured result.

**Files:**
- Create: `src/daemon/sdk-executor.ts`

**Steps:**
1. Add SDK dependency: `yarn add @anthropic-ai/claude-agent-sdk`
2. Implement `runSdkStep()` as specified above
3. Test standalone: import in a small script, run with a simple prompt, verify result structure

**Validation:** Call `runSdkStep({ prompt: 'What is 2+2?', cwd: '/tmp', maxTurns: 1 })`. Verify it returns `{ success: true, result: '...4...', costUsd: <number>, ... }`.

**Risk:** The SDK spawns a child process. In the daemon's `ELECTRON_RUN_AS_NODE=1` environment, the SDK needs to find its own executable. The SDK's `pathToClaudeCodeExecutable` option can override this if auto-detection fails. Test this early.

### Phase 1c: Flow Engine

**Goal:** Multi-step flows execute end-to-end with template variable resolution and state persistence.

**Files:**
- Create: `src/daemon/flow-engine.ts`

**Steps:**
1. Implement the flow engine as specified above
2. Test with the `test-echo` flow: `executeFlow('test-echo', { message: 'hello' })`
3. Test template resolution: create a two-step flow where step 2 references `{{steps.step1.result}}`
4. Test error handling: create a flow with an impossible task, verify step failure propagates
5. Test cancellation: start a flow, call `cancelRun(id)`, verify it stops

**Validation:** Two-step flow completes. Run state persisted to `~/.claude-colony/flow-runs/`. Step results chain correctly via templates.

**Risk:** Template resolution edge cases (missing variables, deeply nested references). The current implementation leaves unresolved templates as-is, which is safe but may cause confusing prompts. Log a warning when a template variable doesn't resolve.

### Phase 1d: Cron Engine + Daemon Integration

**Goal:** The daemon can schedule cron triggers that fire flows, and clients can manage triggers/flows via the socket protocol.

**Files:**
- Create: `src/daemon/cron-engine.ts`
- Modify: `src/daemon/pty-daemon.ts` -- initialize stores, cron engine, wire new request handlers, fix idle timer

**Steps:**
1. Implement `CronEngine` class
2. In `pty-daemon.ts`:
   - Import all new modules at top
   - In `main()`, after server starts: initialize TriggerStore, CronEngine, wire the `onFire` callback to call `executeFlow`
   - Add all new `case` branches to `handleRequest()`
   - Fix `resetIdleTimer()` to account for active triggers and running flows
3. Test end-to-end: create a trigger via socket (`trigger:create` with cron `*/1 * * * *`), wait, verify flow runs

**Validation:** Create a cron trigger pointing to `test-echo` flow. Verify it fires on schedule. Verify `flow:progress` events broadcast to subscribers. Verify the daemon doesn't idle-shutdown while triggers are active.

**Risk:** The daemon's event loop must not be blocked by flow execution. Since `runSdkStep` is async (the SDK spawns a subprocess), this should be fine. But test with multiple concurrent flows to verify.

### Phase 1e: Electron Client Integration

**Goal:** The Electron app can list flows, list/create/delete triggers, start flows manually, and see flow run status.

**Files:**
- Modify: `src/main/daemon-client.ts` -- add methods for all new protocol messages
- Modify: `src/main/ipc-handlers.ts` -- register new IPC handlers
- Modify: `src/preload/index.ts` -- expose flow/trigger API to renderer

**Steps:**
1. Add methods to `DaemonClient`: `listFlows()`, `getFlow()`, `runFlow()`, `cancelFlow()`, `listFlowRuns()`, `getFlowRun()`, `listTriggers()`, `createTrigger()`, `updateTrigger()`, `deleteTrigger()`, `fireTrigger()`
2. Register IPC handlers: `flow:list`, `flow:get`, `flow:run`, `flow:cancel`, `flow:list-runs`, `flow:get-run`, `trigger:list`, `trigger:create`, `trigger:update`, `trigger:delete`, `trigger:fire`
3. Add event forwarding in `instance-manager.ts` (or a new `flow-manager.ts`): listen for `flow:progress` and `trigger:fired` events from daemon, broadcast to renderer windows
4. Expose in preload: `window.api.flows.list()`, `window.api.flows.run()`, etc.

**Validation:** From the renderer console: `window.api.flows.list()` returns the test flow. `window.api.flows.run('test-echo', { message: 'hi' })` returns a run ID. Flow progress events arrive.

**Risk:** Low. This is the same proxy pattern as existing instance management.

---

## Decisions Log

| Decision | Rationale | Alternatives Considered |
|----------|-----------|------------------------|
| YAML for flow definitions, not markdown | Flow definitions are structured data (step configs, input schemas, tool lists). YAML handles nested structures cleanly. Markdown requires custom block-quote parsing for structured fields, which is fragile. | Markdown with frontmatter + blockquote syntax (FlowRunner pattern -- works but the blockquote parsing is custom and brittle), JSON (unreadable for multi-line prompts) |
| SDK for flow steps, not PTY | SDK gives clean exit codes, structured output, cost tracking, abort control. PTY requires heuristic activity detection, ANSI stripping, output file conventions. The whole point of the hybrid approach. | PTY-only (unreliable completion detection), SDK with PTY view overlay (complexity not worth it for Phase 1) |
| Flow engine in daemon, not separate process | Daemon already handles process lifecycle, crash resilience, idle shutdown. A separate flow-runner process adds IPC complexity and another thing to manage. The SDK executor spawns its own child processes so the daemon's event loop stays free. | Separate flow-runner process (unnecessary indirection), Electron main process (dies when app closes) |
| `bypassPermissions` as default for flow steps | Automated flows should not prompt for permission interactively. The user opted into the flow by creating and triggering it. Per-tool-call permission prompts would hang the headless executor forever. | `dontAsk` (denies unpermitted tools silently -- would cause cryptic failures), `acceptEdits` (too narrow -- flows need Bash, not just edits) |
| Template syntax `{{...}}` not `${...}` | `${...}` conflicts with JavaScript template literals and YAML string interpolation. `{{...}}` is unambiguous in all contexts (YAML values, prompt text) and familiar from Handlebars/Mustache. | `${...}` (conflicts), `<% ... %>` (ERB-style, verbose), custom delimiters (unnecessary) |
| `flow:run` returns immediately with `runId` | Flows can take minutes. A synchronous request would hit the daemon client's 10-second timeout. Return the run ID immediately, stream progress via `flow:progress` events. | Synchronous long-poll (timeout issues), WebSocket upgrade (unnecessary complexity over existing NDJSON events) |
| `node-cron` for scheduling | Proven, lightweight, no external dependencies. Already used in the user's automate project. Runs in-process, no system crontab management. | `cron` npm package (similar), `later.js` (abandoned), system crontab (fragile, no UI integration), `node-schedule` (heavier) |
| `yaml` npm package for parsing | The `yaml` package is the standard YAML 1.2 parser for Node.js. Zero dependencies, TypeScript types included, actively maintained. | `js-yaml` (YAML 1.1, slightly different behavior), `gray-matter` (markdown-focused, overkill for pure YAML) |

## Open Questions

- **SDK executable resolution in daemon context.** The daemon runs with `ELECTRON_RUN_AS_NODE=1`. The Claude Agent SDK internally needs to find the Claude Code CLI executable. Does it auto-detect correctly in this environment, or do we need to pass `pathToClaudeCodeExecutable` pointing to the globally installed `claude` binary? Test this in Phase 1b before building further.

- **Concurrent flow execution limits.** Phase 1 has no concurrency limit. Multiple cron triggers could fire simultaneously, each spawning a flow that runs multiple SDK steps. Each SDK step spawns a child process. Should we add a configurable `maxConcurrentFlows` (default 3)? This is a settings question, not an architecture question -- easy to add later via a semaphore in the flow engine.

- **Flow run cleanup.** Flow run JSON files accumulate in `~/.claude-colony/flow-runs/`. Add a retention policy (delete runs older than N days, or keep last N runs). Not blocking for Phase 1 -- the files are tiny.

- **UI.** Phase 1 focuses on the daemon-side machinery. The renderer needs a Flows panel and Triggers panel. That's a separate plan -- the IPC/preload bridge from Phase 1e gives the renderer everything it needs.

## File Summary

| File | Action | Description |
|------|--------|-------------|
| `src/daemon/sdk-executor.ts` | Create | Wraps Claude Agent SDK `query()` into a single async function call |
| `src/daemon/flow-store.ts` | Create | Scans and parses YAML flow definitions from `~/.claude-colony/flows/` |
| `src/daemon/trigger-store.ts` | Create | CRUD for trigger definitions persisted to `~/.claude-colony/triggers.json` |
| `src/daemon/cron-engine.ts` | Create | Schedules `node-cron` jobs for enabled cron triggers |
| `src/daemon/flow-engine.ts` | Create | Orchestrates multi-step flow execution with template resolution |
| `src/daemon/protocol.ts` | Modify | Add flow/trigger types and 12 new request types + 2 new event types |
| `src/daemon/pty-daemon.ts` | Modify | Initialize stores, cron engine; add request handlers; fix idle timer |
| `src/main/daemon-client.ts` | Modify | Add 11 new methods for flow/trigger protocol messages |
| `src/main/ipc-handlers.ts` | Modify | Register 11 new IPC handlers |
| `src/preload/index.ts` | Modify | Expose `flows` and `triggers` API namespaces |
| `src/renderer/src/types/index.ts` | Modify | Add flow/trigger TypeScript types for renderer |
| `package.json` | Modify | Add 3 new dependencies |
