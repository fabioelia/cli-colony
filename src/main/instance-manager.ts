/**
 * Instance Manager — thin proxy that delegates to the PTY daemon.
 *
 * Preserves the same export signatures so ipc-handlers.ts and tray.ts
 * need zero changes. All PTY ownership lives in the daemon process.
 */

import { app, BrowserWindow, shell } from 'electron'
import { exec, execFile, execSync } from 'child_process'
import { join, basename } from 'path'
import { existsSync, statSync } from 'fs'
import { promises as fsp } from 'fs'
import { getDaemonRouter } from './daemon-router'
import type { UpgradeState } from './daemon-router'
import { getDefaultArgs, getSetting, getSettingSync, getDefaultCliBackend } from './settings'
import { notify } from './notifications'
import { DAEMON_VERSION } from '../daemon/protocol'
import type { CliBackend, ColonyComment } from '../shared/types'
import { trackOpened, trackClosed } from './recent-sessions'
import { broadcast } from './broadcast'
import { buildMcpConfig, cleanMcpConfigFile } from './mcp-catalog'
import { setRateLimited } from './rate-limit-state'
import { scanNewCommits } from './commit-attributor'
import { markChecklistItem } from './onboarding-state'
import { appendActivity } from './activity-manager'
import { getProjectBriefPath } from './project-brief'
import { parseErrorSummary } from './error-parser'
import { transitionTicket, addComment } from './jira'
import { getPlaybookMemory, appendPlaybookMemory } from './playbook-manager'
import { colonyPaths } from '../shared/colony-paths'
import { slugify, stripAnsi } from '../shared/utils'

export type { ClaudeInstance } from '../daemon/protocol'
import type { ClaudeInstance } from '../daemon/protocol'

// Track HEAD commit at session start to detect commits made during the session
const _startHeadCommits = new Map<string, string>()

export function recordStartHead(instanceId: string, cwd: string): void {
  try {
    const head = execSync('git rev-parse HEAD', { cwd, encoding: 'utf8', timeout: 3000 }).trim()
    _startHeadCommits.set(instanceId, head)
  } catch {
    // not a git repo or git unavailable — skip
  }
}

export function computeSessionTags(inst: ClaudeInstance, exitCode: number): string[] {
  const tags: string[] = []
  if (exitCode !== 0) tags.push('failed')
  if (inst.pipelineName) {
    tags.push('pipeline')
  } else if (inst.name.startsWith('Persona: ')) {
    tags.push('persona')
  }
  const durationMs = Date.now() - new Date(inst.createdAt).getTime()
  if (durationMs > 30 * 60 * 1000) tags.push('long-running')

  // Enriched tags
  if (inst.budgetExceeded) tags.push('budget-exceeded')
  if (_fanOutParent.has(inst.id)) tags.push('fan-out')
  const cost = inst.tokenUsage?.cost ?? 0
  if (cost > 0.50) tags.push('costly')
  if (durationMs < 2 * 60 * 1000 && exitCode === 0) tags.push('quick')

  // Detect commits made during this session
  const startHead = _startHeadCommits.get(inst.id)
  _startHeadCommits.delete(inst.id)
  if (startHead && inst.workingDirectory) {
    try {
      const currentHead = execSync('git rev-parse HEAD', {
        cwd: inst.workingDirectory, encoding: 'utf8', timeout: 3000,
      }).trim()
      if (currentHead !== startHead) tags.push('committed')
    } catch {
      // repo gone or git unavailable — skip
    }
  }

  return tags
}

// Track MCP config files by instance ID so we can clean them up on exit
const _mcpConfigPaths = new Map<string, string>()

// Track Jira ticket attached at creation time — overlaid onto ClaudeInstance for the renderer
const _instanceTickets = new Map<string, { source: 'jira'; key: string; summary: string }>()

// Track triggeredBy (persona name) for overlay onto ClaudeInstance — not stored in daemon
const _instanceTriggeredBy = new Map<string, string>()

// Track fan-out parent linkage: childId → parentId
const _fanOutParent = new Map<string, string>()

// Track which session IDs have non-empty notes files
const _noteIds = new Set<string>()

export function setNoteFlag(sessionId: string, hasNotes: boolean): void {
  if (hasNotes) _noteIds.add(sessionId)
  else _noteIds.delete(sessionId)
}

// Track last output timestamp per instance for idle detection
const _lastOutputAt = new Map<string, number>()
// Track last stale notification threshold per instance (ms) to avoid repeat fires
const _staleNotified = new Map<string, number>()

// Rate-limit cost checks: track last check timestamp per instance (30s throttle)
const _lastCostCheckAt = new Map<string, number>()
// Track which instances have already been budget-stopped (prevent double-stop)
const _budgetStopped = new Set<string>()

interface OutputAlert {
  id: string
  pattern: string
  isRegex: boolean
  oneShot: boolean
  _regex?: RegExp  // cached compiled regex
}

const _outputAlerts = new Map<string, OutputAlert[]>()
const _outputBuffers = new Map<string, string>()  // line buffer per instance
const _instancePlaybooks = new Map<string, string>()  // instanceId → playbook name

/** Check if an instance was stopped due to budget exceeded. */
export function wasBudgetStopped(instanceId: string): boolean {
  return _budgetStopped.has(instanceId)
}

/** Get idle info for all running instances. Only includes instances that have output tracking. */
export function getIdleInfo(): Array<{ id: string; idleMs: number }> {
  const now = Date.now()
  const result: Array<{ id: string; idleMs: number }> = []
  for (const [id, lastAt] of _lastOutputAt) {
    result.push({ id, idleMs: now - lastAt })
  }
  return result
}

// Callback to resolve persona cost cap — registered by persona-manager at startup to avoid circular import
let _costCapResolver: ((instanceId: string) => number | undefined) | null = null
export function setCostCapResolver(fn: (instanceId: string) => number | undefined): void {
  _costCapResolver = fn
}

// Approval count getter — registered by pipeline-engine at startup to avoid circular import
let _approvalCountGetter: () => number = () => 0
export function setApprovalCountGetter(fn: () => number): void {
  _approvalCountGetter = fn
}

// Attention count getter — registered by persona-manager at startup to avoid circular import
let _attentionCountGetter: () => number = () => 0
export function setAttentionCountGetter(fn: () => number): void {
  _attentionCountGetter = fn
}

export function updateDockBadge(): void {
  getDaemonRouter().getAllInstances().then(instances => {
    const waitingCount = instances.filter(i => i.status === 'running' && i.activity === 'waiting').length
    const total = waitingCount + _approvalCountGetter() + _attentionCountGetter()
    if (process.platform === 'darwin') {
      app.dock?.setBadge(total > 0 ? String(total) : '')
    } else {
      app.setBadgeCount(total)
    }
  }).catch(() => {})
}

// Tray update callback
let onInstanceListChanged: (() => void) | null = null
export function setOnInstanceListChanged(cb: () => void): void {
  onInstanceListChanged = cb
}

// Session exit callback — registered at startup to avoid circular imports
let onSessionExitCallback: ((instanceId: string) => void) | null = null
export function setOnSessionExit(cb: (instanceId: string) => void): void {
  onSessionExitCallback = cb
}

/** Overlay ticket metadata and triggeredBy onto instances from the in-memory maps. */
function applyTickets(instances: ClaudeInstance[]): ClaudeInstance[] {
  // Build fan-out children map for this batch of instances
  const fanOutChildren = new Map<string, string[]>()
  for (const [childId, parentId] of _fanOutParent.entries()) {
    if (!fanOutChildren.has(parentId)) fanOutChildren.set(parentId, [])
    fanOutChildren.get(parentId)!.push(childId)
  }
  return instances.map(inst => {
    const ticket = _instanceTickets.get(inst.id)
    const triggeredBy = _instanceTriggeredBy.get(inst.id)
    const fanOutParentId = _fanOutParent.get(inst.id)
    const fanOutChildIds = fanOutChildren.get(inst.id)
    const extra: Partial<ClaudeInstance> = {}
    if (ticket) extra.ticket = ticket
    if (triggeredBy) extra.triggeredBy = triggeredBy
    if (fanOutParentId) extra.fanOutParentId = fanOutParentId
    if (fanOutChildIds?.length) extra.fanOutChildIds = fanOutChildIds
    if (_noteIds.has(inst.id)) extra.hasNotes = true
    return Object.keys(extra).length > 0 ? { ...inst, ...extra } : inst
  })
}

/** Expand ~ and trim; default to ~/.claude-colony for Colony sessions. */
function resolveWorkingDirectory(input: string | undefined, home: string): string {
  const raw = (input ?? '').trim()
  if (!raw) return join(home, '.claude-colony')
  if (raw === '~') return home
  if (raw.startsWith('~/')) return join(home, raw.slice(2))
  return raw
}

// ---- Daemon event wiring ----

async function checkStaleNotifications(): Promise<void> {
  const now = Date.now()
  const STALE_15M = 900_000
  const STALE_30M = 1_800_000
  const instances = await getDaemonRouter().getAllInstances().catch(() => [])
  const byId = new Map(instances.map(i => [i.id, i]))
  for (const [id, lastAt] of _lastOutputAt) {
    const idleMs = now - lastAt
    const inst = byId.get(id)
    if (!inst || inst.status !== 'running' || inst.activity !== 'busy') continue
    const lastNotified = _staleNotified.get(id) ?? 0
    if (idleMs >= STALE_30M && lastNotified < STALE_30M) {
      _staleNotified.set(id, STALE_30M)
      notify(
        'Colony: Session may be stuck',
        `"${inst.name}" has had no output for 30 minutes — consider checking or stopping`,
        { type: 'session', id },
        'session'
      )
    } else if (idleMs >= STALE_15M && lastNotified < STALE_15M) {
      _staleNotified.set(id, STALE_15M)
      notify(
        'Colony: Session may be stuck',
        `No output from "${inst.name}" for 15 minutes`,
        { type: 'session', id },
        'session'
      )
    }
  }
}

let _wired = false

export function wireDaemonEvents(): void {
  if (_wired) return
  _wired = true

  const router = getDaemonRouter()
  router.wireEvents(router.primaryClient)

  // Forward output to renderer + track idle time + check persona cost cap
  router.on('output', (instanceId: string, data: string) => {
    broadcast('instance:output', { id: instanceId, data })
    _lastOutputAt.set(instanceId, Date.now())
    _staleNotified.delete(instanceId)

    // Check output alerts
    const alerts = _outputAlerts.get(instanceId)
    if (alerts?.length) {
      let buf = (_outputBuffers.get(instanceId) ?? '') + data
      // Keep last 4KB
      if (buf.length > 4096) buf = buf.slice(-4096)
      _outputBuffers.set(instanceId, buf)
      const lines = buf.split('\n')
      // Keep incomplete last line in buffer
      _outputBuffers.set(instanceId, lines[lines.length - 1])
      const completeLines = lines.slice(0, -1).join('\n')
      if (completeLines) {
        const remaining: OutputAlert[] = []
        for (const alert of alerts) {
          const matched = alert.isRegex && alert._regex
            ? alert._regex.test(completeLines)
            : completeLines.toLowerCase().includes(alert.pattern.toLowerCase())
          if (matched) {
            router.getInstance(instanceId).then(inst => {
              notify(
                `Colony: pattern matched`,
                `"${alert.pattern}" in ${inst?.name ?? instanceId}`,
                { type: 'session', id: instanceId }, 'session'
              )
            })
            if (alert.oneShot) {
              broadcast('session:alertMatched', { instanceId, alertId: alert.id })
              continue
            }
          }
          remaining.push(alert)
        }
        if (remaining.length !== alerts.length) _outputAlerts.set(instanceId, remaining)
      }
    }

    // Rate-limited persona cost cap check (every 30s)
    if (!_budgetStopped.has(instanceId)) {
      const now = Date.now()
      const last = _lastCostCheckAt.get(instanceId) ?? 0
      if (now - last >= 30_000) {
        _lastCostCheckAt.set(instanceId, now)
        const cap = _costCapResolver?.(instanceId) ?? (parseFloat(getSettingSync('sessionCostCapUsd')) || undefined)
        if (cap != null) {
          router.getInstance(instanceId).then(inst => {
            if (!inst || _budgetStopped.has(instanceId)) return
            const cost = inst.tokenUsage?.cost ?? 0
            if (cost >= cap) {
              _budgetStopped.add(instanceId)
              console.log(`[instance-manager] budget exceeded for ${inst.name}: $${cost.toFixed(2)} >= $${cap.toFixed(2)} — stopping`)
              router.killInstance(instanceId).catch(() => {})
              broadcast('instance:budgetExceeded', { id: instanceId, cost, cap })
              notify(
                `Colony: ${inst.name} stopped`,
                `Cost limit reached ($${cost.toFixed(2)} / $${cap.toFixed(2)})`,
                { type: 'session', id: instanceId }, 'session'
              )
              appendActivity({
                source: 'persona',
                name: inst.name.replace('Persona: ', ''),
                summary: `Budget exceeded — session stopped ($${cost.toFixed(2)} / $${cap.toFixed(2)})`,
                level: 'warn',
                sessionId: instanceId,
                project: basename(inst.workingDirectory || '') || undefined,
              }).catch(() => {})
            }
          }).catch(() => {})
        }
      }
    }
  })

  // Forward activity changes + notify when Claude finishes processing
  router.on('activity', async (instanceId: string, activity: string) => {
    broadcast('instance:activity', { id: instanceId, activity })
    updateDockBadge()

    // When an instance transitions to 'waiting', Claude finished its task
    if (activity === 'waiting') {
      const soundEnabled = await getSetting('soundOnFinish') !== 'false'

      // Only notify if the app window is not focused (user is elsewhere)
      const win = BrowserWindow.getAllWindows()[0]
      const appFocused = win && !win.isDestroyed() && win.isFocused()

      if (soundEnabled && !appFocused) {
        exec('afplay /System/Library/Sounds/Glass.aiff', (err) => {
          if (err) shell.beep()
        })
      }

      // Show native notification if app is not focused
      if (!appFocused) {
        notify('Colony: Claude is waiting', 'A session finished and needs your attention.',
          { type: 'session', id: instanceId }, 'session')
      }
    }
  })

  // Forward tool-deferred events + desktop notification
  router.on('tool-deferred', async (instanceId: string, sessionId: string, toolName?: string) => {
    broadcast('instance:tool-deferred', { id: instanceId, sessionId, toolName })
    const inst = await router.getInstance(instanceId).catch(() => null)
    const name = inst?.name || 'Session'
    notify(
      'Tool Deferred',
      `${name}: ${toolName || 'A tool'} needs approval`,
      { type: 'session', id: instanceId }, 'session'
    )
  })

  // Rate limit detection — pause Colony crons
  router.on('rateLimitDetected', (_instanceId: string, retryAfterSecs: number | null, rawMessage: string) => {
    console.warn(`[instance-manager] rate limit detected: ${rawMessage.slice(0, 100)}`)
    setRateLimited(retryAfterSecs, rawMessage)
  })

  // Forward exit events + handle auto-cleanup + track session closure
  router.on('exited', async (instanceId: string, exitCode: number) => {
    // Capture ticket + playbook BEFORE clearing maps
    const exitTicket = _instanceTickets.get(instanceId)
    const exitPlaybook = _instancePlaybooks.get(instanceId)
    broadcast('instance:exited', { id: instanceId, exitCode })
    updateDockBadge()
    trackClosed(instanceId, 'exited')
    _lastOutputAt.delete(instanceId)
    _staleNotified.delete(instanceId)
    _lastCostCheckAt.delete(instanceId)
    _budgetStopped.delete(instanceId)
    _outputAlerts.delete(instanceId)
    _outputBuffers.delete(instanceId)
    _instanceTickets.delete(instanceId)
    _instanceTriggeredBy.delete(instanceId)
    _fanOutParent.delete(instanceId)
    _instancePlaybooks.delete(instanceId)
    onSessionExitCallback?.(instanceId)

    // Scan output for MEMORY: lines from playbook sessions and persist them
    if (exitPlaybook) {
      router.getInstanceBuffer(instanceId).then(async buffer => {
        if (!buffer) return
        const lines = buffer.split('\n')
        const last50 = lines.slice(-50)
        const memoryLines = last50
          .map(l => l.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').trim())
          .filter(l => l.startsWith('MEMORY:'))
          .map(l => l.slice('MEMORY:'.length).trim())
          .filter(l => l.length > 0)
        if (memoryLines.length > 0) {
          appendPlaybookMemory(exitPlaybook, memoryLines).catch(() => {})
        }
      }).catch(() => {})
    }

    // Parse error summary from PTY buffer on non-zero exit
    if (exitCode !== 0) {
      router.getInstanceBuffer(instanceId).then(buffer => {
        if (!buffer) return
        const errorSummary = parseErrorSummary(buffer)
        if (errorSummary) {
          broadcast('instance:errorSummary', { id: instanceId, errorSummary })
        }
      }).catch(() => {})
    }

    // Single getInstance call — shared by activity log + commit attribution
    router.getInstance(instanceId).then(inst => {
      if (!inst) return

      // Auto-tag session on exit — broadcast to renderer for sidebar localStorage
      const autoTags = computeSessionTags(inst, exitCode)
      if (autoTags.length > 0) {
        broadcast('instance:autoTags', { id: instanceId, tags: autoTags })
      }

      // Write proof-of-work bundle (fire-and-forget — never block exit flow)
      writeProofBundle(instanceId, exitCode, new Date(inst.createdAt).getTime()).catch(() => {})

      appendActivity({
        source: 'session',
        name: inst.name,
        summary: exitCode === 0
          ? 'Session exited normally'
          : `Session exited with code ${exitCode}`,
        level: exitCode === 0 ? 'info' : 'warn',
        sessionId: instanceId,
        project: basename(inst.workingDirectory || '') || undefined,
      }).catch(() => {})

      if (exitCode !== 0 && !inst.name.startsWith('Persona: ')) {
        notify(
          'Colony: Session error',
          `"${inst.name}" exited with code ${exitCode}`,
          { type: 'session', id: instanceId },
          'session'
        )
      }

      if (inst.workingDirectory) {
        const personaName = inst.name.startsWith('Persona: ')
          ? inst.name.slice('Persona: '.length)
          : undefined
        scanNewCommits(
          instanceId,
          inst.name,
          inst.workingDirectory,
          new Date(inst.createdAt).getTime(),
          personaName,
          inst.tokenUsage?.cost
        ).catch(() => {})
      }

      // Post session-end comment to Jira if ticket attached and setting enabled
      if (exitTicket?.key && inst.workingDirectory) {
        getSetting('jiraSessionEndComment').then(async enabled => {
          if (enabled !== 'true') return
          try {
            const stdout = await new Promise<string>((resolve, reject) =>
              execFile('git', [
                'log', `--since=${new Date(inst.createdAt).toISOString()}`,
                '--pretty=format:%h %s', '--no-merges', '--max-count=50',
              ], { cwd: inst.workingDirectory }, (err, out) => err ? reject(err) : resolve(out))
            )
            const lines = stdout.trim().split('\n').filter(Boolean)
            if (lines.length === 0) return
            const display = lines.slice(0, 20)
            const extra = lines.length > 20 ? `\n... and ${lines.length - 20} more` : ''
            const durationMins = Math.round((Date.now() - new Date(inst.createdAt).getTime()) / 60000)
            const envLabel = inst.gitRepo ?? 'local'
            const body = [
              `Colony session "${inst.name}" completed.`,
              '',
              `Commits (${lines.length}):`,
              ...display.map(l => `- ${l}`),
              ...(extra ? [extra] : []),
              '',
              `Duration: ${durationMins}m | Env: ${envLabel}`,
            ].join('\n')
            await addComment(exitTicket.key, body)
          } catch { /* swallow — never block exit flow */ }
        }).catch(() => {})
      }
    }).catch(() => {})
    const mcpPath = _mcpConfigPaths.get(instanceId)
    if (mcpPath) {
      cleanMcpConfigFile(mcpPath).catch(() => {})
      _mcpConfigPaths.delete(instanceId)
    }

    // Auto-cleanup (skip persona sessions — they're kept for review)
    const cleanupMins = parseInt(await getSetting('autoCleanupMinutes') || '5', 10)
    if (cleanupMins > 0) {
      setTimeout(async () => {
        try {
          const inst = await router.getInstance(instanceId)
          if (inst && inst.status === 'exited' && !inst.name.startsWith('Persona: ')) {
            await router.removeInstance(instanceId)
          }
        } catch { /* daemon may be gone */ }
      }, cleanupMins * 60 * 1000)
    }
  })

  // Forward list changes
  router.on('list-changed', (instances: ClaudeInstance[]) => {
    broadcast('instance:list', applyTickets(instances))
    onInstanceListChanged?.()
  })

  // Forward comments push
  router.on('comments', (instanceId: string, comments: ColonyComment[]) => {
    broadcast('session:comments', { instanceId, comments })
  })

  router.on('disconnected', () => {
    console.log('[instance-manager] daemon disconnected')
  })

  router.on('connection-failed', () => {
    console.error('[instance-manager] daemon reconnect exhausted — notifying renderer')
    broadcast('daemon:connection-failed', { error: 'Daemon reconnect failed after multiple attempts' })
  })

  router.on('connected', () => {
    console.log('[instance-manager] daemon connected')
    updateDockBadge()
  })

  router.on('version-mismatch', (info: { running: number; expected: number }) => {
    console.warn(`[instance-manager] daemon version mismatch: running=${info.running} expected=${info.expected}`)
    broadcast('daemon:version-mismatch', info)
  })

  router.on('daemon-unresponsive', () => {
    console.error('[instance-manager] daemon unresponsive — force-killed, auto-reconnecting')
    broadcast('daemon:unresponsive', {})
  })

  // Rolling upgrade events
  router.on('upgrade-started', () => {
    broadcast('daemon:upgrade-started', {})
  })

  router.on('upgrade-draining', (info: { remaining: number }) => {
    broadcast('daemon:upgrade-draining', info)
  })

  router.on('upgrade-complete', () => {
    broadcast('daemon:upgrade-complete', {})
  })

  router.on('instance-migrated', (info: { oldId: string; newId: string }) => {
    broadcast('daemon:instance-migrated', info)
  })

  setInterval(checkStaleNotifications, 60_000)

  // Write a proof-of-work bundle markdown file for a completed session
  async function writeProofBundle(instanceId: string, exitCode: number, startedAt: number): Promise<void> {
    const durationMs = Date.now() - startedAt
    if (durationMs < 5_000) return // skip very short sessions
    const inst = await router.getInstance(instanceId).catch(() => null)
    if (!inst) return
    const buffer = await router.getInstanceBuffer(instanceId).catch(() => '')
    const lastLines = buffer
      ? stripAnsi(buffer).split('\n').filter(Boolean).slice(-30).join('\n')
      : ''
    const ts = Date.now()
    const date = new Date(ts).toISOString().slice(0, 10)
    const slug = slugify(inst.name) || 'session'
    const proofPath = colonyPaths.proofFile(date, slug, ts)
    await fsp.mkdir(colonyPaths.proofs + '/' + date, { recursive: true })

    let commits = ''
    let diffStats = ''
    if (inst.workingDirectory) {
      try {
        const since = new Date(startedAt).toISOString()
        commits = await new Promise<string>((resolve, reject) =>
          execFile('git', ['log', `--since=${since}`, '--pretty=format:%h %s', '--no-merges', '--max-count=20'],
            { cwd: inst.workingDirectory }, (err, out) => err ? reject(err) : resolve(out.trim())))
        diffStats = await new Promise<string>((resolve, reject) =>
          execFile('git', ['diff', '--stat', `HEAD@{1}`, 'HEAD'],
            { cwd: inst.workingDirectory }, (err, out) => err ? reject(err) : resolve(out.trim())))
      } catch { /* no git or no commits — skip */ }
    }

    const durationSecs = Math.round(durationMs / 1000)
    const cost = inst.tokenUsage?.cost ?? 0
    const branch = inst.gitBranch ?? ''
    const commitCount = commits ? commits.split('\n').filter(Boolean).length : 0

    const lines: string[] = [
      `---`,
      `session: "${inst.name}"`,
      `date: "${date}"`,
      `exitCode: ${exitCode}`,
      `cost: ${cost.toFixed(4)}`,
      `duration: ${durationSecs}s`,
      `commits: ${commitCount}`,
      `---`,
      '',
      `# Session: ${inst.name}`,
      `- **Exit code:** ${exitCode}`,
      `- **Duration:** ${durationSecs}s`,
      `- **Cost:** $${cost.toFixed(4)}`,
      ...(branch ? [`- **Branch:** ${branch}`] : []),
      ...(commitCount > 0 ? [`- **Commits:** ${commitCount}`] : []),
      ...(inst.workingDirectory ? [`- **Directory:** ${inst.workingDirectory}`] : []),
      '',
      `## Last 30 lines of output`,
      '```',
      lastLines,
      '```',
      ...(commits ? ['', `## Commits`, '```', commits, '```'] : []),
      ...(diffStats ? ['', `## Files changed`, '```', diffStats, '```'] : []),
      ...(exitCode !== 0 ? ['', `## Error`, `Session exited with code ${exitCode}.`] : []),
    ]
    await fsp.writeFile(proofPath, lines.join('\n'), 'utf8')
    broadcast('instance:proof', { id: instanceId, path: proofPath })
  }

  // Prune proof bundles older than 14 days
  async function pruneOldProofs(): Promise<void> {
    const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000
    try {
      const days = await fsp.readdir(colonyPaths.proofs).catch(() => [] as string[])
      for (const day of days) {
        const dayDir = colonyPaths.proofs + '/' + day
        const mtime = await fsp.stat(dayDir).then(s => s.mtimeMs).catch(() => 0)
        if (mtime < cutoff) {
          const files = await fsp.readdir(dayDir).catch(() => [] as string[])
          for (const f of files) await fsp.unlink(dayDir + '/' + f).catch(() => {})
          await fsp.rmdir(dayDir).catch(() => {})
        }
      }
    } catch { /* ignore */ }
  }
  setTimeout(pruneOldProofs, 60_000)

  // Scan notes dir on startup to populate _noteIds
  fsp.readdir(colonyPaths.notes).then(files => {
    for (const f of files) {
      if (f.endsWith('.md')) _noteIds.add(f.slice(0, -3))
    }
  }).catch(() => {})

  // Prune note files older than 14 days
  async function pruneOldNotes(): Promise<void> {
    const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000
    try {
      const files = await fsp.readdir(colonyPaths.notes).catch(() => [] as string[])
      for (const f of files) {
        if (!f.endsWith('.md')) continue
        const filePath = colonyPaths.notes + '/' + f
        const mtime = await fsp.stat(filePath).then(s => s.mtimeMs).catch(() => 0)
        if (mtime < cutoff) {
          await fsp.unlink(filePath).catch(() => {})
          _noteIds.delete(f.slice(0, -3))
        }
      }
    } catch { /* ignore */ }
  }
  setTimeout(pruneOldNotes, 90_000)

  // Age-based retention: remove old stopped sessions on startup and every 6h
  async function runRetentionCheck(): Promise<void> {
    const days = parseInt(await getSetting('sessionRetentionDays') || '7', 10)
    if (days <= 0) return
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
    const instances = await router.getAllInstances()
    const toRemove = instances.filter((i: ClaudeInstance) =>
      i.status === 'exited' &&
      !i.name.startsWith('Persona: ') &&
      !i.pinned &&
      (i.exitedAt ?? new Date(i.createdAt).getTime()) < cutoff
    )
    for (const inst of toRemove) {
      await router.removeInstance(inst.id).catch(() => {})
    }
    if (toRemove.length > 0) {
      notify(
        'Session cleanup',
        `Removed ${toRemove.length} session${toRemove.length > 1 ? 's' : ''} older than ${days} day${days > 1 ? 's' : ''}`
      )
    }
  }
  setTimeout(runRetentionCheck, 30_000)
  setInterval(runRetentionCheck, 6 * 60 * 60 * 1000)
}

// ---- Public API (same signatures as before) ----

export async function createInstance(opts: {
  name?: string
  workingDirectory?: string
  color?: string
  args?: string[]
  parentId?: string
  cliBackend?: CliBackend
  mcpServers?: string[]
  model?: string
  permissionMode?: 'autonomous' | 'supervised' | 'auto'
  env?: Record<string, string>
  pipelineName?: string
  pipelineRunId?: string
  ticket?: { source: 'jira'; key: string; summary: string }
  triggeredBy?: string
  playbook?: string
  fanOutParentId?: string
}): Promise<ClaudeInstance> {
  const defaultArgs = await getDefaultArgs()
  const home = app.getPath('home')
  const cwd = resolveWorkingDirectory(opts.workingDirectory, home)
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
    throw new Error(`Working directory is missing or not a folder: ${cwd}`)
  }
  const cliBackend = opts.cliBackend ?? await getDefaultCliBackend()

  // Build MCP config file if servers are requested
  let mcpConfigPath: string | null = null
  const baseArgs = opts.args ?? []
  let finalArgs = baseArgs
  if (opts.mcpServers && opts.mcpServers.length > 0) {
    const configId = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    mcpConfigPath = await buildMcpConfig(opts.mcpServers, configId)
    if (mcpConfigPath) {
      finalArgs = [...baseArgs, '--mcp-config', mcpConfigPath]
    }
  }

  // Inject project brief if one exists for this working directory
  const briefPath = getProjectBriefPath(cwd)
  if (briefPath) {
    finalArgs = ['--append-system-prompt-file', briefPath, ...finalArgs]
  }

  const inst = await getDaemonRouter().createInstance({
    ...opts,
    args: finalArgs,
    workingDirectory: cwd,
    defaultArgs,
    cliBackend,
  })

  if (mcpConfigPath) {
    _mcpConfigPaths.set(inst.id, mcpConfigPath)
  }
  if (opts.triggeredBy) {
    _instanceTriggeredBy.set(inst.id, opts.triggeredBy)
  }
  if (opts.fanOutParentId) {
    _fanOutParent.set(inst.id, opts.fanOutParentId)
  }
  if (opts.ticket) {
    _instanceTickets.set(inst.id, opts.ticket)
    getSetting('jiraSessionStartTransition').then(name => {
      const trimmed = name.trim()
      if (!trimmed) return
      transitionTicket(opts.ticket!.key, trimmed)
        .catch(err => console.warn('[instance] session-start transition failed:', err))
    }).catch(() => {})
  }
  _lastOutputAt.set(inst.id, Date.now())
  if (opts.playbook) _instancePlaybooks.set(inst.id, opts.playbook)
  if (cwd) recordStartHead(inst.id, cwd)

  markChecklistItem('createdSession')

  appendActivity({
    source: 'session',
    name: inst.name,
    summary: `Session started in ${(cwd || '').split('/').pop() || cwd}`,
    level: 'info',
    sessionId: inst.id,
    project: basename(cwd || '') || undefined,
  }).catch(() => {})

  // Track in recent sessions
  const allArgs = inst.args || []
  const resumeIdx = allArgs.indexOf('--resume')
  const sessionIdFromArgs = resumeIdx >= 0 ? allArgs[resumeIdx + 1] : null
  trackOpened({
    instanceName: inst.name,
    instanceId: inst.id,
    sessionId: sessionIdFromArgs,
    workingDirectory: cwd,
    color: inst.color,
    args: allArgs,
    cliBackend: inst.cliBackend,
    pid: inst.pid ?? null,
    ticket: opts.ticket,
  })

  const extra: Record<string, unknown> = {}
  if (opts.ticket) extra.ticket = opts.ticket
  if (opts.triggeredBy) extra.triggeredBy = opts.triggeredBy
  return Object.keys(extra).length > 0 ? { ...inst, ...extra } : inst
}

export async function killInstance(id: string): Promise<boolean> {
  const result = await getDaemonRouter().killInstance(id)
  trackClosed(id, 'killed')
  return result
}

export async function restartInstance(id: string): Promise<ClaudeInstance | null> {
  const defaultArgs = await getDefaultArgs()
  return getDaemonRouter().restartInstance(id, defaultArgs)
}

export async function getAllInstances(): Promise<ClaudeInstance[]> {
  try {
    return applyTickets(await getDaemonRouter().getAllInstances())
  } catch {
    return []
  }
}

/**
 * No longer kills instances — the daemon keeps them alive.
 * Only disconnects the client.
 */
export function disconnectDaemon(): void {
  getDaemonRouter().disconnect()
}

/**
 * Fully shut down the daemon (kills all instances).
 * Use only when the user explicitly quits.
 */
export async function shutdownDaemon(): Promise<void> {
  await getDaemonRouter().shutdownDaemon()
}

export async function getDaemonVersion(): Promise<{ running: number; expected: number }> {
  try {
    const res = await getDaemonRouter().request({ type: 'version', reqId: `v-${Date.now()}` }) as { version?: number } | undefined
    return { running: res?.version ?? 0, expected: DAEMON_VERSION }
  } catch {
    return { running: 0, expected: DAEMON_VERSION }
  }
}

/**
 * Restart the daemon — kills all instances, shuts down, then reconnects.
 * For backward compat; prefer startDaemonUpgrade() for zero-downtime upgrades.
 */
export async function restartDaemon(): Promise<void> {
  console.log('[instance-manager] restarting daemon...')
  try {
    await getDaemonRouter().shutdownDaemon()
  } catch { /* daemon may already be gone */ }
  getDaemonRouter().disconnect()
  await new Promise((r) => setTimeout(r, 500))
  await getDaemonRouter().connect()
  console.log('[instance-manager] daemon restarted')
}

/** Start a rolling upgrade — spawn new daemon, drain old, promote when empty. */
export async function startDaemonUpgrade(): Promise<void> {
  return getDaemonRouter().startUpgrade()
}

/** Migrate a specific instance from old daemon to new during an upgrade. */
export async function migrateInstance(instanceId: string): Promise<ClaudeInstance | null> {
  return getDaemonRouter().migrateInstance(instanceId)
}

/** Migrate all running instances from old daemon to new. */
export async function migrateAllInstances(): Promise<void> {
  return getDaemonRouter().migrateAll()
}

/** Get the current upgrade state. */
export function getUpgradeState(): { state: UpgradeState; remaining: number } {
  return getDaemonRouter().getUpgradeStatus()
}

/**
 * Connect to the daemon and wire up events.
 * Call this once during app startup. Retries up to 3 times with a stale-daemon
 * kill between attempts so a hung daemon doesn't permanently block the app.
 */
export async function initDaemon(): Promise<void> {
  wireDaemonEvents()
  const router = getDaemonRouter()
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await router.connect()
      return
    } catch (err) {
      console.error(`[instance-manager] daemon connect attempt ${attempt}/3 failed:`, err)
      if (attempt < 3) {
        router.killDaemonProcess()
        await new Promise((r) => setTimeout(r, 2000))
      }
    }
  }
  throw new Error('daemon init failed after 3 attempts')
}

export function addOutputAlert(instanceId: string, alert: Omit<OutputAlert, '_regex'>): void {
  const alerts = _outputAlerts.get(instanceId) ?? []
  const entry: OutputAlert = { ...alert }
  if (entry.isRegex) {
    try { entry._regex = new RegExp(entry.pattern, 'i') } catch { entry.isRegex = false }
  }
  _outputAlerts.set(instanceId, [...alerts, entry])
  broadcast('session:alertsChanged', { instanceId, alerts: _outputAlerts.get(instanceId) ?? [] })
}

export function removeOutputAlert(instanceId: string, alertId: string): void {
  const alerts = _outputAlerts.get(instanceId)
  if (alerts) _outputAlerts.set(instanceId, alerts.filter(a => a.id !== alertId))
  broadcast('session:alertsChanged', { instanceId, alerts: _outputAlerts.get(instanceId) ?? [] })
}

export function getOutputAlerts(instanceId: string): OutputAlert[] {
  return _outputAlerts.get(instanceId) ?? []
}
