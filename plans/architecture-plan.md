# Architecture Plan: Triggers & Agentic Flows for Claude Colony

## Current State

### What Exists Today

Claude Colony is an Electron app managing multiple Claude CLI instances through a PTY daemon.

**Three-layer architecture:**
1. **PTY Daemon** (`src/daemon/pty-daemon.ts`) -- standalone Node.js process, owns all PTY file descriptors, communicates over Unix domain socket (NDJSON). Survives app crashes. Has zero knowledge of scheduling, flows, or triggers.
2. **Electron Main** (`src/main/`) -- thin proxy layer. `DaemonClient` connects to daemon socket. `instance-manager.ts` adds Electron concerns (notifications, sound, auto-cleanup, session tracking). IPC handlers bridge to renderer.
3. **Renderer** (`src/renderer/`) -- React UI. Terminal views, sidebar, agent panel, settings.

**Relevant existing concepts:**
- **Agents** (`agent-scanner.ts`) -- markdown files with YAML frontmatter scanned from `~/.claude/agents/` and `~/projects/*/. claude/agents/`. Currently just metadata (name, description, tools, model, color). Launching an agent = opening the new-instance dialog with prefilled values.
- **Activity detection** -- daemon polls every 2s, comparing output buffer tails. Emits `busy`/`waiting` states. This is the only reactive signal the system produces today.
- **Instance lifecycle events** -- `output`, `exited`, `activity`, `list-changed` broadcast to all socket subscribers.

**Adjacent systems the user has built:**
- **Automate** (`~/projects/automate/`) -- separate Electron app with SQLite DB, `node-cron` scheduler, prompt/workflow execution via Claude CLI (non-PTY, headless). Has schedules, runs, workflow steps with output chaining.
- **FlowRunner** (`~/projects/flowrunner/`) -- CLI/SDK for markdown-defined agentic flows. Phases executed via Claude Code SDK. Supports parallel groups, sub-flows, hooks, state persistence, interactive approval mode.

### What Works

- Daemon architecture is solid: clean separation, crash resilience, NDJSON protocol is extensible.
- Activity detection (busy/waiting) gives us a primitive but useful reactive signal.
- Agent definitions as markdown files is a good convention.
- FlowRunner already has the right execution model (phased, resumable, parallel-capable).
- The automate app proves the scheduler pattern works.

### What Doesn't

- **Agents are inert.** They're just prefill data for the new-instance dialog. No concept of "run this agent automatically" or "chain this agent's output to another."
- **No reactive infrastructure.** The daemon emits events but nothing acts on them programmatically. When an instance goes from `busy` -> `waiting`, the only response is a macOS notification.
- **No concept of "what to do next."** When Claude finishes a task and goes to `waiting`, the system has no way to feed it the next prompt or spawn a follow-up instance.
- **Three separate tools.** Colony (PTY management), Automate (scheduling), and FlowRunner (flow orchestration) are three disconnected systems that should be one.
- **No output capture for automation.** The daemon stores raw terminal output in a ring buffer (10K entries). There's no structured output extraction, no way to parse "what did Claude produce?" for use as input to the next step.

---

## Target State

Colony becomes the single control plane for all Claude automation: interactive sessions, scheduled tasks, triggered flows, and multi-instance orchestration. The daemon gains a **trigger engine** and a **flow executor**, making it capable of running headless agentic workflows that survive the Electron app being closed.

### Design Principles

1. **Triggers and flows live in the daemon, not Electron.** The daemon already survives app crashes. Scheduled tasks and triggered flows should too. The Electron app is a viewer/editor, not the execution engine.
2. **Flows are defined as files, not database rows.** Following the FlowRunner pattern, flow definitions live in `~/.claude-colony/flows/` as markdown/YAML. Versionable, portable, editable with any text editor.
3. **Triggers are lightweight and composable.** A trigger is "when X happens, do Y." X is a condition (cron, file change, webhook, instance event). Y is an action (spawn instance, send prompt to existing instance, run flow).
4. **Output capture is explicit.** When a flow step finishes, the system extracts the meaningful output from the terminal buffer. This is a known-hard problem with PTY output (ANSI codes, TUI redraws), so we define a convention: Claude Colony prompts include an instruction for Claude to write structured results to a temp file, which the orchestrator reads.

### Components

| Component | Responsibility | Location |
|-----------|---------------|----------|
| **Trigger Registry** | Stores trigger definitions. Loads from `~/.claude-colony/triggers.json`. CRUD operations. | Daemon |
| **Cron Engine** | Evaluates cron expressions, fires trigger events on schedule. | Daemon |
| **File Watcher** | Watches specified paths for changes, fires trigger events. | Daemon |
| **Webhook Server** | Listens on a local port for HTTP POST requests, fires trigger events. | Daemon |
| **Instance Event Router** | Listens to instance lifecycle events (exited, activity->waiting), fires matching triggers. | Daemon |
| **Flow Executor** | Runs multi-step flows. Creates instances, sends prompts, waits for completion, chains outputs. State persisted to `~/.claude-colony/flow-runs/`. | Daemon |
| **Output Extractor** | Reads structured output from completed instances (via convention file or buffer parsing). | Daemon |
| **Trigger/Flow UI** | Editor for triggers and flows. Displays active triggers, running flows, execution history. | Renderer |

### Data Model

#### Trigger Definition

```typescript
interface TriggerDefinition {
  id: string
  name: string
  enabled: boolean

  // What fires this trigger -- exactly one of:
  condition:
    | { type: 'cron'; expression: string }
    | { type: 'file-watch'; paths: string[]; events: ('change' | 'create' | 'delete')[] }
    | { type: 'webhook'; path: string; secret?: string }  // POST to http://localhost:{port}/{path}
    | { type: 'instance-event'; event: 'exited' | 'waiting'; namePattern?: string }
    | { type: 'manual' }  // UI button only

  // What happens when fired -- exactly one of:
  action:
    | { type: 'spawn'; opts: CreateOpts; prompt?: string }  // Create instance, optionally send initial prompt
    | { type: 'prompt'; instanceNamePattern: string; prompt: string }  // Send prompt to existing waiting instance
    | { type: 'flow'; flowName: string; inputs?: Record<string, string> }  // Run a flow

  // Optional: template variables available in prompt/inputs
  // For instance-event triggers: {{instanceId}}, {{instanceName}}, {{exitCode}}
  // For webhook triggers: {{body}}, {{body.field}}
  // For file-watch triggers: {{path}}, {{event}}
  // For cron triggers: {{timestamp}}

  createdAt: string
  lastFiredAt?: string
  fireCount: number
}
```

#### Flow Definition (markdown file in `~/.claude-colony/flows/{name}/flow.md`)

```markdown
---
name: daily-review
description: Review PRs, check CI, summarize status
inputs:
  - name: repo
    type: string
    required: true
---

## Step 1: Check Open PRs

> instance: pr-checker
> cwd: {{repo}}
> prompt: |
>   List all open PRs in this repo. For each, summarize the changes
>   and whether CI is passing. Write results to /tmp/colony-output.json
> wait: completion
> output: /tmp/colony-output.json

## Step 2: Summarize

> instance: summarizer
> cwd: {{repo}}
> prompt: |
>   Given these PR statuses: {{steps.step-1.output}}
>   Write a brief daily summary suitable for posting to Slack.
> wait: completion
> output: stdout
```

#### Flow Run State (persisted to `~/.claude-colony/flow-runs/{id}.json`)

```typescript
interface FlowRun {
  id: string
  flowName: string
  status: 'running' | 'completed' | 'failed' | 'paused'
  triggerId?: string  // what trigger started this
  inputs: Record<string, unknown>
  steps: FlowStepRun[]
  startedAt: string
  completedAt?: string
  error?: string
}

interface FlowStepRun {
  name: string
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped'
  instanceId?: string
  output?: string
  startedAt?: string
  completedAt?: string
  error?: string
}
```

### How It Works End-to-End

**Example: "Every morning at 9am, review open PRs and post summary to Slack"**

1. User creates trigger via UI:
   - Condition: `cron: "0 9 * * 1-5"`
   - Action: `flow: daily-review` with input `repo: /Users/fabio/projects/myapp`

2. At 9am, daemon's cron engine fires the trigger.

3. Flow executor loads `~/.claude-colony/flows/daily-review/flow.md`, parses steps.

4. Step 1: executor calls `createInstance({name: 'pr-checker', cwd: '/Users/fabio/projects/myapp'})`. Once the instance reaches `waiting` state (Claude is ready), executor writes the prompt. Then waits for instance to go `busy` -> `waiting` again (task complete). Reads output from `/tmp/colony-output.json`.

5. Step 2: executor creates a new instance, sends prompt with Step 1's output interpolated. Waits for completion. Captures output.

6. Flow completes. History recorded. Instance cleanup per settings.

If Electron is open, the user sees all of this happening live in the terminal views. If Electron is closed, the daemon runs it headless -- the instances and their output are available when the user reconnects.

**Example: "When any instance finishes, play a sound and auto-cleanup if exit code 0"**

1. Trigger: condition `instance-event: exited`, action `spawn` with prompt template that checks `{{exitCode}}`.

This is already partially handled by `instance-manager.ts` notifications, but triggers generalize it.

**Example: "Watch my Jira export folder for new CSV files, auto-import them"**

1. Trigger: condition `file-watch: ~/Downloads/*.csv`, action `spawn` with prompt referencing `{{path}}`.

---

## Migration Plan

### Phase 1: Daemon Protocol Extension -- Trigger/Flow CRUD

**Goal:** Extend the daemon protocol to support creating, listing, updating, and deleting triggers and flows. No execution yet -- just data management.

**Files:**
- Modify: `src/daemon/protocol.ts` (add trigger/flow request/response types)
- Modify: `src/daemon/pty-daemon.ts` (add trigger store, CRUD handlers)
- Create: `src/daemon/trigger-store.ts` (load/save triggers from `~/.claude-colony/triggers.json`)
- Create: `src/daemon/flow-store.ts` (load/save/parse flow definitions from `~/.claude-colony/flows/`)

**Steps:**
1. Define `TriggerDefinition` and `FlowDefinition` types in `protocol.ts`.
2. Add protocol messages: `trigger:create`, `trigger:list`, `trigger:update`, `trigger:delete`, `trigger:fire` (manual), `flow:list`, `flow:get`.
3. Implement `TriggerStore` class: reads/writes `~/.claude-colony/triggers.json`. Simple JSON file, no database.
4. Implement `FlowStore` class: scans `~/.claude-colony/flows/*/flow.md`, parses markdown into step definitions.
5. Wire CRUD handlers in daemon's `handleRequest` switch.

**Validation:** Can create/list/delete triggers via the daemon socket. Flow definitions are parsed from markdown files.

**Risk:** Protocol changes must be backward-compatible (old clients ignore unknown message types). The NDJSON protocol handles this naturally -- unknown `type` values get an error response, which is fine.

### Phase 2: Cron Engine

**Goal:** Triggers with `type: 'cron'` fire on schedule. For now, the only action is `spawn` (create a new instance with an optional prompt).

**Files:**
- Create: `src/daemon/cron-engine.ts`
- Modify: `src/daemon/pty-daemon.ts` (initialize cron engine on startup, reload on trigger changes)

**Steps:**
1. Add `node-cron` as a dependency (already used in automate, proven to work).
2. `CronEngine` class: takes trigger store reference. On init, schedules all enabled cron triggers. On trigger change, reschedules.
3. When a cron trigger fires, resolve the action:
   - `spawn`: call `createInstance()` in daemon. If `prompt` is set, wait for instance to reach `waiting` state, then write prompt + `\r` to PTY.
   - For now, skip `flow` and `prompt` actions (Phase 4).
4. Update trigger's `lastFiredAt` and `fireCount`.
5. Broadcast a `trigger:fired` event to subscribers so the UI can show it.

**Validation:** Create a trigger with cron `*/1 * * * *` (every minute) and action `spawn`. Verify instance appears every minute.

**Risk:** Cron in the daemon means the daemon must handle `node-cron` dependency. Since the daemon is compiled by electron-vite alongside main, this should bundle cleanly. Test that the daemon's idle shutdown timer (`IDLE_TIMEOUT_MS`) doesn't kill the daemon while triggers are active.

### Phase 3: Instance Event Triggers & "Send Prompt" Action

**Goal:** Triggers can fire when instances reach specific states. The `prompt` action can send text to a waiting instance.

**Files:**
- Create: `src/daemon/event-router.ts`
- Modify: `src/daemon/pty-daemon.ts` (hook event router into activity/exit broadcasts)

**Steps:**
1. `EventRouter` class: holds reference to trigger store. When an instance event occurs (activity change, exit), checks all enabled `instance-event` triggers for matches.
2. Pattern matching: `namePattern` uses simple glob (e.g., `"worker-*"` matches `"worker-1"`).
3. Template resolution: replace `{{instanceId}}`, `{{instanceName}}`, `{{exitCode}}` in action prompt/inputs.
4. Implement `prompt` action: find a running instance matching `instanceNamePattern` that is in `waiting` state, write the resolved prompt to its PTY.
5. Important: add a guard against trigger loops (instance-event trigger spawns instance, which triggers another event). Simple: skip triggers for instances that were spawned by a trigger within the last 5 seconds, or add a `triggeredBy` field to instances.

**Validation:** Create two instances. Set up a trigger: "when instance named 'analyzer' goes waiting, send 'continue with the next file' to it." Verify the prompt is sent automatically.

**Risk:** Trigger loops are the main danger. The guard in step 5 is essential. Also: the activity detection is heuristic (2s polling interval comparing output buffer tails) -- it can miss rapid busy/waiting transitions or misclassify. For flow orchestration, we may need a more reliable signal. Consider checking for Claude's actual idle prompt pattern in the output buffer.

### Phase 4: Flow Executor

**Goal:** Multi-step flows execute end-to-end. Each step spawns or reuses an instance, sends a prompt, waits for completion, captures output, and feeds it to the next step.

**Files:**
- Create: `src/daemon/flow-executor.ts`
- Create: `src/daemon/output-extractor.ts`
- Modify: `src/daemon/protocol.ts` (add `flow:run`, `flow:status`, `flow:list-runs`, `flow:cancel` messages)
- Modify: `src/daemon/pty-daemon.ts` (wire flow executor)

**Steps:**
1. `FlowExecutor` class: takes references to instance map, trigger store, flow store.
2. `runFlow(flowName, inputs, triggerId?)`:
   - Parse flow definition into steps.
   - For each step sequentially:
     a. Create or find instance per step config.
     b. Wait for instance to reach `waiting` (Claude is ready for input).
     c. Resolve template variables in prompt (inputs + previous step outputs).
     d. Write prompt to instance PTY.
     e. Wait for instance to transition: `busy` -> `waiting` (task done).
     f. Extract output (see output extraction below).
     g. Store step result.
   - On completion/failure, persist `FlowRun` state to disk.
3. **Output extraction strategy:**
   - Primary: the prompt instructs Claude to write results to a temp file (e.g., `/tmp/colony-{runId}-step-{n}.json`). Executor reads this file after step completes.
   - Fallback: parse the instance's output buffer, strip ANSI codes, extract last meaningful block.
   - The flow step definition specifies which method: `output: /path/to/file` or `output: stdout`.
4. `cancelFlow(runId)`: kill all instances owned by this flow run.
5. Broadcast `flow:progress` events so the UI can render flow status.

**Validation:** Create a two-step flow. Step 1 asks Claude to create a file. Step 2 asks Claude to read and summarize it. Verify both steps execute, output chains correctly, flow completes.

**Risk:** Waiting for `busy -> waiting` transitions is fragile. Claude might produce output in bursts that briefly look like `waiting`. Mitigation: require the `waiting` state to persist for at least 3 seconds before considering the step done. Also: long-running tasks could hit the daemon's PTY buffer limits (10K entries). For flows, consider a larger buffer or writing to disk.

### Phase 5: File Watcher & Webhook Triggers

**Goal:** Triggers can fire on file system changes and incoming HTTP requests.

**Files:**
- Create: `src/daemon/file-watcher.ts`
- Create: `src/daemon/webhook-server.ts`
- Modify: `src/daemon/pty-daemon.ts` (initialize watchers and webhook server)

**Steps:**
1. `FileWatcher` class: uses `fs.watch` (or `chokidar` if we need reliability across platforms). Watches paths from enabled `file-watch` triggers. Debounces rapid changes (100ms). Fires trigger with `{{path}}` and `{{event}}` variables.
2. `WebhookServer` class: lightweight HTTP server on a configurable port (default: `7779`). Routes defined by trigger `path` field. Validates `secret` header if set. Fires trigger with `{{body}}` template variable.
3. Both register/unregister watchers/routes when triggers are created/modified/deleted.

**Validation:**
- File watcher: create trigger watching a test directory. Touch a file. Verify trigger fires.
- Webhook: create trigger with path `/deploy`. `curl -X POST localhost:7779/deploy -d '{"env":"prod"}'`. Verify trigger fires.

**Risk:** File watcher reliability varies by OS. `fs.watch` on macOS uses FSEvents and is generally reliable but can miss rapid changes. Acceptable for this use case. Webhook server means the daemon now listens on a TCP port -- document the security implications (localhost only, optional secret).

### Phase 6: Electron UI for Triggers & Flows

**Goal:** Users can create, edit, enable/disable triggers and view flow executions from the Electron UI.

**Files:**
- Modify: `src/main/daemon-client.ts` (add trigger/flow client methods)
- Modify: `src/main/ipc-handlers.ts` (add trigger/flow IPC handlers)
- Modify: `src/preload/index.ts` (expose trigger/flow API)
- Create: `src/renderer/src/components/TriggersPanel.tsx`
- Create: `src/renderer/src/components/FlowsPanel.tsx`
- Create: `src/renderer/src/components/TriggerEditor.tsx`
- Create: `src/renderer/src/components/FlowRunViewer.tsx`
- Modify: `src/renderer/src/components/Sidebar.tsx` (add triggers/flows nav items)
- Modify: `src/renderer/src/App.tsx` (add views for triggers/flows)

**Steps:**
1. Extend `DaemonClient` with methods: `listTriggers()`, `createTrigger()`, `updateTrigger()`, `deleteTrigger()`, `fireTrigger()`, `listFlows()`, `runFlow()`, `listFlowRuns()`, `cancelFlow()`.
2. Register IPC handlers that proxy these to the daemon client.
3. Build `TriggersPanel`: list of triggers with enable/disable toggles, fire count, last fired time. "New Trigger" button opens `TriggerEditor`.
4. Build `TriggerEditor`: form with condition type selector, action type selector, template variable documentation. Preview of cron schedule (next 5 fire times).
5. Build `FlowsPanel`: list of flow definitions (scanned from `~/.claude-colony/flows/`). Each shows name, description, step count. "Run" button. List of recent flow runs with status.
6. Build `FlowRunViewer`: shows flow execution in progress. Each step shows status, linked instance (clickable to view terminal), output preview. Cancel button.
7. Add "Triggers" and "Flows" items to the sidebar navigation.

**Validation:** Full round-trip: create trigger in UI, see it fire, see instance spawn, see flow execute, see results.

**Risk:** UI complexity. Keep it simple -- the trigger editor is a form, not a visual builder. The flow viewer shows status, not a DAG. Complexity can be added later.

### Phase 7: Daemon Idle Timer Fix & Robustness

**Goal:** Ensure the daemon doesn't shut down while triggers are active, and handle edge cases.

**Files:**
- Modify: `src/daemon/pty-daemon.ts` (fix idle timer logic)
- Modify: `src/daemon/flow-executor.ts` (add timeout, retry, error handling)

**Steps:**
1. Fix `resetIdleTimer()`: don't start idle timer if there are enabled triggers with `type: 'cron'`, active file watchers, or the webhook server is running. The daemon should stay alive as long as there's work to do.
2. Add flow execution timeouts: each step has a max duration (configurable, default 10 minutes). If exceeded, mark step as failed.
3. Add flow retry logic: steps can specify `retries: N` in their definition.
4. Handle daemon restart gracefully: on startup, check for `FlowRun` states with `status: 'running'`. Mark them as `failed` with reason "daemon restarted" (don't try to resume -- the PTY instances are gone).
5. Add health check: periodic validation that cron jobs are still scheduled, file watchers are still active.

**Validation:** Stop daemon while a flow is running. Restart. Verify the stale flow run is marked failed. Verify cron triggers resume firing.

**Risk:** Low. This is cleanup and hardening.

---

## Decisions Log

| Decision | Rationale | Alternatives Considered |
|----------|-----------|------------------------|
| Triggers live in the daemon, not Electron | Daemon survives app crashes. Cron jobs should fire even if the UI is closed. | Electron main process (fragile), separate scheduler process (unnecessary complexity) |
| Trigger definitions in JSON, flow definitions in markdown | Triggers are config (JSON is fine). Flows have rich content/prompts (markdown is natural, matches FlowRunner convention). | SQLite database (overkill, not portable), all-JSON (prompts in JSON are painful), all-markdown (triggers don't benefit from markdown) |
| Output extraction via temp files, not buffer parsing | PTY output is messy (ANSI codes, TUI redraws, progress bars). Parsing it reliably is a losing battle. Having Claude write to a file is deterministic. | Buffer parsing only (unreliable), Claude Code SDK `--output-format json` (requires non-PTY execution, breaks the interactive terminal model) |
| No database | The system has <1000 triggers and <10000 flow runs. JSON files are sufficient, portable, and easy to debug. | SQLite (what automate uses -- adds dependency, migration complexity, no real benefit at this scale) |
| Don't reuse FlowRunner directly | FlowRunner uses Claude Code SDK (headless, non-PTY). Colony's flows need PTY instances for visual interaction. The execution model is fundamentally different. | Import FlowRunner as dependency (wrong execution model), adapt FlowRunner to use PTY (major rewrite of FlowRunner) |
| Cron in daemon, not system crontab | User doesn't need to manage system cron. Daemon lifecycle controls trigger lifecycle. | launchd/crontab (fragile, hard to manage, no UI integration), separate scheduler service (unnecessary) |
| Localhost-only webhook server | Simple, secure by default. External access requires the user to set up a tunnel (ngrok, cloudflare tunnel). | Public-facing server (security nightmare), named pipes (not HTTP-compatible, hard to integrate with external tools) |
| Activity detection for flow step completion | The daemon already has busy/waiting detection. Flows build on top of it. | Polling instance status via API (same thing with extra steps), Claude exit detection (Claude doesn't exit between prompts in interactive mode) |

## Open Questions

- **Better completion signal:** The 2-second activity polling is adequate for notifications but potentially flaky for flow orchestration. Should we add a more reliable signal? Options: (a) look for Claude's actual prompt character/pattern in the output, (b) instrument Claude CLI with a custom MCP tool that signals "task complete", (c) use `--output-format json` for headless flow steps (losing the interactive terminal view).

- **Flow definition format:** The markdown format above is a starting point. Should it match FlowRunner's format exactly (easing future convergence), or diverge where Colony's PTY-centric model demands it?

- **Concurrency limits:** Should there be a configurable max number of concurrent instances spawned by triggers/flows? The daemon currently has no limit. Running 10 Claude instances simultaneously would consume significant API quota and system resources.

- **Consolidating with Automate:** Long-term, should the Automate app's functionality be fully absorbed into Colony? The automate app uses headless Claude execution (no PTY), which is lighter weight for simple prompt->result tasks. Colony could support both modes: PTY instances for interactive flows, headless execution for simple scheduled prompts.

- **Webhook authentication:** Is `localhost + optional secret header` sufficient? Or should the webhook server support API keys, IP allowlisting, or HMAC signatures for integration with external CI/CD systems?
