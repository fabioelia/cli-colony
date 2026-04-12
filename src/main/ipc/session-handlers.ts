import { ipcMain, dialog } from 'electron'
import { execFile } from 'child_process'
import { resolveCommand } from '../resolve-command'
import { promisify } from 'util'
import { promises as fsp } from 'fs'
import {
  scanSessions, scanExternalSessions, readSessionMessages,
  searchSessions, takeoverSession,
} from '../session-scanner'
import { getRestorableSessions, clearRestorable, getRecentSessions } from '../recent-sessions'
import { getAllInstances, getIdleInfo } from '../instance-manager'
import { getContextUsage, tokenizeApproximate } from '../context-counter'
import { getArtifact } from '../session-artifacts'
import { getDaemonRouter } from '../daemon-router'
import { stripAnsi } from '../../shared/utils'
import type { CoordinatorTeam, ContextUsage, GitDiffEntry } from '../../shared/types'
import { getLiveChanges } from '../git-utils'

const execFileAsync = promisify(execFile)

export function registerSessionHandlers(): void {
  ipcMain.handle('sessions:list', (_e, limit?: number) => scanSessions(limit))

  ipcMain.handle('sessions:external', () => scanExternalSessions())

  ipcMain.handle('sessions:messages', (_e, sessionId: string, limit: number = 50) =>
    readSessionMessages(sessionId, limit)
  )

  ipcMain.handle('sessions:takeover', (_e, opts: { pid: number; sessionId: string | null; name: string; cwd: string }) =>
    takeoverSession(opts)
  )

  ipcMain.handle('sessions:search', (_e, query: string) => searchSessions(query))

  ipcMain.handle('sessions:restorable', async () => {
    const instances = await getAllInstances()
    const alreadyRunning = new Set<string>()
    for (const inst of instances) {
      const resumeIdx = inst.args?.indexOf('--resume')
      if (resumeIdx !== undefined && resumeIdx >= 0 && inst.args?.[resumeIdx + 1]) {
        alreadyRunning.add(inst.args[resumeIdx + 1])
      }
    }
    return getRestorableSessions(alreadyRunning)
  })
  ipcMain.handle('sessions:clearRestorable', () => { clearRestorable(); return true })
  ipcMain.handle('sessions:recent', () => getRecentSessions())

  ipcMain.handle('session:getCoordinatorTeam', async (_e, sessionId: string): Promise<CoordinatorTeam | null> => {
    const instances = await getAllInstances()
    const coordinator = instances.find(i => i.id === sessionId)

    if (!coordinator || coordinator.roleTag !== 'Coordinator') {
      return null
    }

    // Find all Worker sessions
    const workers = instances
      .filter(i => i.roleTag === 'Worker')
      .map(w => ({
        id: w.id,
        name: w.name,
        status: w.status,
        activity: w.activity,
        costUsd: w.tokenUsage?.cost,
        uptime: w.status === 'running' ? Date.now() - new Date(w.createdAt).getTime() : undefined,
      }))

    return {
      coordinatorId: sessionId,
      workers,
    }
  })

  ipcMain.handle('session:getContextUsage', (_e, sessionId: string): ContextUsage | null => {
    return getContextUsage(sessionId)
  })

  ipcMain.handle('session:tokenizeApproximate', (_e, text: string): number => {
    return tokenizeApproximate(text)
  })

  ipcMain.handle('sessions:searchOutput', async (_e, query: string) => {
    return searchSessionOutput(query)
  })

  ipcMain.handle('sessions:idleInfo', () => getIdleInfo())

  ipcMain.handle('session:exportMarkdown', async (_e, instanceId: string): Promise<string> => {
    return buildExportMarkdown(instanceId)
  })

  ipcMain.handle('session:exportMarkdownToFile', async (_e, instanceId: string): Promise<boolean> => {
    const md = await buildExportMarkdown(instanceId)
    const result = await dialog.showSaveDialog({
      defaultPath: 'session-export.md',
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    })
    if (result.canceled || !result.filePath) return false
    await fsp.writeFile(result.filePath, md, 'utf-8')
    return true
  })
}

// ---- Export Markdown helpers ----

async function getFileDiff(dir: string, filePath: string, fileStatus: string): Promise<string> {
  try {
    if (fileStatus === 'A' || fileStatus === '?') {
      const { stdout } = await execFileAsync(resolveCommand('cat'), [filePath], { encoding: 'utf-8', timeout: 5000, cwd: dir })
      return stdout.split('\n').map(l => '+' + l).join('\n')
    }
    const { stdout: staged } = await execFileAsync(resolveCommand('git'), ['diff', '--cached', '--', filePath], { encoding: 'utf-8', timeout: 5000, cwd: dir })
    if (staged.trim()) return staged
    const { stdout } = await execFileAsync(resolveCommand('git'), ['diff', 'HEAD', '--', filePath], { encoding: 'utf-8', timeout: 5000, cwd: dir })
    return stdout
  } catch {
    return ''
  }
}

async function getLiveCommits(dir: string, afterIso: string): Promise<Array<{ hash: string; shortMsg: string }>> {
  try {
    const { stdout } = await execFileAsync(resolveCommand('git'), ['log', '--format=%H|%s', `--after=${afterIso}`], { cwd: dir, encoding: 'utf-8', timeout: 5000 })
    if (!stdout.trim()) return []
    return stdout.trim().split('\n').map(line => {
      const idx = line.indexOf('|')
      return idx === -1 ? null : { hash: line.slice(0, idx).trim(), shortMsg: line.slice(idx + 1).trim() }
    }).filter(Boolean) as Array<{ hash: string; shortMsg: string }>
  } catch {
    return []
  }
}

async function getLiveBranch(dir: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(resolveCommand('git'), ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir, encoding: 'utf-8', timeout: 3000 })
    return stdout.trim() || null
  } catch {
    return null
  }
}

const MAX_DIFF_LINES = 200

async function buildExportMarkdown(instanceId: string): Promise<string> {
  const client = getDaemonRouter()
  const inst = await client.getInstance(instanceId).catch(() => null)
  const artifact = await getArtifact(instanceId)

  const name = inst?.name ?? artifact?.sessionName ?? 'Unknown session'
  const dir = inst?.workingDirectory ?? artifact?.workingDirectory ?? ''
  const startedAt = inst?.createdAt ?? artifact?.sessionStartedAt
  const cost = inst?.tokenUsage?.cost ?? artifact?.costUsd

  // Duration
  let durationStr = ''
  if (startedAt) {
    const ms = (artifact?.durationMs) ?? (Date.now() - new Date(startedAt).getTime())
    const mins = Math.round(ms / 60000)
    durationStr = mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h ${mins % 60}m`
  }

  // Branch
  const branch = artifact?.gitBranch ?? (dir ? await getLiveBranch(dir) : null)

  // First message (prompt)
  let prompt = ''
  // Try to find the CLI session ID from instance args (--resume <id>)
  const resumeIdx = inst?.args?.indexOf('--resume')
  const cliSessionId = resumeIdx !== undefined && resumeIdx >= 0 ? inst?.args?.[resumeIdx + 1] : null
  if (cliSessionId) {
    try {
      const { messages } = await readSessionMessages(cliSessionId, 5)
      const userMsg = messages.find(m => m.role === 'user')
      if (userMsg) prompt = userMsg.text
    } catch { /* ignore */ }
  }

  // Changes and commits
  let changes: GitDiffEntry[] = artifact?.changes ?? []
  let commits = artifact?.commits ?? []
  if (changes.length === 0 && dir) changes = await getLiveChanges(dir)
  if (commits.length === 0 && dir && startedAt) commits = await getLiveCommits(dir, new Date(startedAt).toISOString())

  // Build markdown
  const lines: string[] = []
  lines.push(`# Session: ${name}`)
  lines.push('')
  if (startedAt) lines.push(`**Date:** ${new Date(startedAt).toLocaleString()}`)
  if (durationStr) lines.push(`**Duration:** ${durationStr}`)
  if (cost !== undefined) lines.push(`**Cost:** $${cost.toFixed(4)}`)
  if (branch) lines.push(`**Branch:** \`${branch}\``)
  lines.push('')

  if (prompt) {
    lines.push('## Prompt')
    lines.push('')
    lines.push(prompt)
    lines.push('')
  }

  if (commits.length > 0) {
    lines.push('## Commits')
    lines.push('')
    for (const c of commits) {
      lines.push(`- \`${c.hash.slice(0, 7)}\` ${c.shortMsg}`)
    }
    lines.push('')
  }

  if (changes.length > 0) {
    const totalIns = changes.reduce((s, c) => s + c.insertions, 0)
    const totalDel = changes.reduce((s, c) => s + c.deletions, 0)
    lines.push(`## Changes (${changes.length} files, +${totalIns} −${totalDel})`)
    lines.push('')

    for (const change of changes) {
      lines.push(`### ${change.file} (+${change.insertions} −${change.deletions})`)
      lines.push('')

      // Binary files: skip diff
      const isBinary = change.insertions === 0 && change.deletions === 0 && change.status === 'M'
      if (isBinary) {
        lines.push('*Binary file changed*')
        lines.push('')
        continue
      }

      if (dir) {
        const diff = await getFileDiff(dir, change.file, change.status)
        if (diff) {
          const diffLines = diff.split('\n')
          if (diffLines.length > MAX_DIFF_LINES) {
            lines.push('```diff')
            lines.push(diffLines.slice(0, MAX_DIFF_LINES).join('\n'))
            lines.push('```')
            lines.push(`*... truncated, ${diffLines.length - MAX_DIFF_LINES} more lines*`)
          } else {
            lines.push('```diff')
            lines.push(diff)
            lines.push('```')
          }
          lines.push('')
        }
      }
    }
  }

  return lines.join('\n')
}

// ---- Global session output search ----

interface SearchOutputMatch {
  lineNum: number
  line: string
  contextBefore: string
  contextAfter: string
}

interface SearchOutputResult {
  instanceId: string
  name: string
  matches: SearchOutputMatch[]
}

const MAX_TOTAL_MATCHES = 100

async function searchSessionOutput(query: string): Promise<SearchOutputResult[]> {
  if (!query || query.length < 2) return []

  const client = getDaemonRouter()
  const instances = await client.getAllInstances()
  const q = query.toLowerCase()
  const results: SearchOutputResult[] = []
  let totalMatches = 0

  for (const inst of instances) {
    if (totalMatches >= MAX_TOTAL_MATCHES) break
    try {
      const raw = await client.getInstanceBuffer(inst.id)
      if (!raw) continue
      const clean = stripAnsi(raw)
      const lines = clean.split('\n')
      const matches: SearchOutputMatch[] = []

      for (let i = 0; i < lines.length; i++) {
        if (totalMatches >= MAX_TOTAL_MATCHES) break
        if (lines[i].toLowerCase().includes(q)) {
          matches.push({
            lineNum: i + 1,
            line: lines[i],
            contextBefore: i > 0 ? lines[i - 1] : '',
            contextAfter: i < lines.length - 1 ? lines[i + 1] : '',
          })
          totalMatches++
        }
      }

      if (matches.length > 0) {
        results.push({ instanceId: inst.id, name: inst.name, matches })
      }
    } catch {
      // Skip instances whose buffer can't be fetched
    }
  }

  return results
}
