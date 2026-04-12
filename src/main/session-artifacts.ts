/**
 * Session Artifacts — auto-generates structured artifact bundles on session exit.
 *
 * Collects: git diff entries, commit list, token/cost metadata, timing info.
 * Stored as a single JSON array in ~/.claude-colony/session-artifacts.json (cap 200).
 */

import { promises as fsp } from 'fs'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { dirname } from 'path'
import { resolveCommand } from './resolve-command'
import { colonyPaths } from '../shared/colony-paths'
import type { SessionArtifact, SessionArtifactCommit, GitDiffEntry } from '../shared/types'
import { getDaemonRouter } from './daemon-router'

const execFileAsync = promisify(execFile)
const MAX_ARTIFACTS = 200

// ---- Persistence (in-memory cache to prevent concurrent write races) ----

let _artifacts: SessionArtifact[] | null = null

async function getArtifacts(): Promise<SessionArtifact[]> {
  if (_artifacts === null) {
    try {
      const raw = await fsp.readFile(colonyPaths.sessionArtifacts, 'utf-8')
      const parsed = JSON.parse(raw)
      _artifacts = Array.isArray(parsed) ? parsed : []
    } catch {
      _artifacts = []
    }
  }
  return _artifacts
}

async function writeArtifacts(artifacts: SessionArtifact[]): Promise<void> {
  await fsp.mkdir(dirname(colonyPaths.sessionArtifacts), { recursive: true })
  await fsp.writeFile(colonyPaths.sessionArtifacts, JSON.stringify(artifacts, null, 2), 'utf-8')
}

// ---- Git helpers ----

async function getGitChanges(cwd: string): Promise<GitDiffEntry[]> {
  try {
    const [numStat, nameStat] = await Promise.all([
      execFileAsync(resolveCommand('git'), ['diff', '--numstat', 'HEAD'], { encoding: 'utf-8', timeout: 5000, cwd }),
      execFileAsync(resolveCommand('git'), ['diff', '--name-status', 'HEAD'], { encoding: 'utf-8', timeout: 5000, cwd }),
    ])

    const statusMap = new Map<string, string>()
    for (const line of nameStat.stdout.split('\n')) {
      const parts = line.split('\t')
      if (parts.length >= 2) {
        const statusChar = parts[0].trim().charAt(0)
        const file = parts[parts.length - 1].trim()
        if (file) statusMap.set(file, statusChar)
      }
    }

    const entries: GitDiffEntry[] = []
    for (const line of numStat.stdout.split('\n')) {
      const parts = line.split('\t')
      if (parts.length < 3) continue
      const file = parts[2].trim()
      if (!file) continue
      const ins = parts[0] === '-' ? 0 : parseInt(parts[0], 10)
      const del = parts[1] === '-' ? 0 : parseInt(parts[1], 10)
      const rawStatus = statusMap.get(file) ?? 'M'
      const status = (['M', 'A', 'D', 'R'].includes(rawStatus) ? rawStatus : 'M') as GitDiffEntry['status']
      entries.push({ file, insertions: ins, deletions: del, status })
    }
    return entries
  } catch {
    return []
  }
}

async function getRecentCommits(cwd: string, afterIso: string): Promise<SessionArtifactCommit[]> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['log', '--format=%H|%s', `--after=${afterIso}`],
      { cwd, encoding: 'utf-8', timeout: 5000 }
    )
    if (!stdout.trim()) return []
    const commits: SessionArtifactCommit[] = []
    for (const line of stdout.trim().split('\n')) {
      const pipeIdx = line.indexOf('|')
      if (pipeIdx === -1) continue
      const hash = line.slice(0, pipeIdx).trim()
      const shortMsg = line.slice(pipeIdx + 1).trim()
      if (hash) commits.push({ hash, shortMsg })
    }
    return commits
  } catch {
    return []
  }
}

async function getGitBranch(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(resolveCommand('git'), ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, encoding: 'utf-8', timeout: 3000 })
    return stdout.trim() || null
  } catch {
    return null
  }
}

async function getGitRemote(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(resolveCommand('git'), ['remote', 'get-url', 'origin'], { cwd, encoding: 'utf-8', timeout: 3000 })
    return stdout.trim() || null
  } catch {
    return null
  }
}

async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    await execFileAsync(resolveCommand('git'), ['rev-parse', '--git-dir'], { cwd, timeout: 3000 })
    return true
  } catch {
    return false
  }
}

// ---- Auto-naming ----

function generateSessionName(artifact: SessionArtifact): string | null {
  // 1. Last commit message subject (most descriptive of overall work)
  if (artifact.commits.length > 0) {
    const msg = artifact.commits[artifact.commits.length - 1].shortMsg
    const clean = msg.replace(/^(feat|fix|refactor|chore|test|docs|ux|perf)(\(.*?\))?!?:\s*/, '')
    return clean.slice(0, 50)
  }
  // 2. Branch name, cleaned up
  if (artifact.gitBranch && artifact.gitBranch !== 'main' && artifact.gitBranch !== 'develop') {
    return artifact.gitBranch
      .replace(/^(feat|fix|chore|refactor)\//, '')
      .replace(/[-_]/g, ' ')
      .slice(0, 50)
  }
  // 3. File change summary
  if (artifact.changes.length > 0) {
    const dirs = [...new Set(artifact.changes.map(c => c.file.split('/').slice(0, 2).join('/')))]
    return `${artifact.changes.length} files in ${dirs[0]}${dirs.length > 1 ? ` +${dirs.length - 1}` : ''}`
  }
  return null
}

// ---- Public API ----

/**
 * Collect an artifact bundle for a session that just exited.
 * Fire-and-forget — silently returns on any error.
 */
export async function collectSessionArtifact(instanceId: string): Promise<SessionArtifact | null> {
  const client = getDaemonRouter()
  const inst = await client.getInstance(instanceId).catch(() => null)
  if (!inst?.workingDirectory) return null

  // Only collect if it's a git repo
  if (!(await isGitRepo(inst.workingDirectory))) return null

  const startedAtMs = new Date(inst.createdAt).getTime()
  const durationMs = Date.now() - startedAtMs
  const afterIso = new Date(startedAtMs).toISOString()

  // Collect git data in parallel
  const [changes, commits, branch, remote] = await Promise.all([
    getGitChanges(inst.workingDirectory),
    getRecentCommits(inst.workingDirectory, afterIso),
    getGitBranch(inst.workingDirectory),
    getGitRemote(inst.workingDirectory),
  ])

  // Skip if no changes and no commits — nothing interesting happened
  if (changes.length === 0 && commits.length === 0) return null

  const personaName = inst.name.startsWith('Persona: ')
    ? inst.name.slice('Persona: '.length)
    : undefined

  const artifact: SessionArtifact = {
    sessionId: instanceId,
    sessionName: inst.name,
    personaName,
    createdAt: new Date().toISOString(),
    sessionStartedAt: inst.createdAt,
    exitCode: inst.exitCode ?? 0,
    durationMs,
    workingDirectory: inst.workingDirectory,
    gitBranch: branch,
    gitRepo: remote,
    commits,
    changes,
    totalInsertions: changes.reduce((sum, e) => sum + e.insertions, 0),
    totalDeletions: changes.reduce((sum, e) => sum + e.deletions, 0),
    costUsd: inst.tokenUsage?.cost,
  }

  // Persist to index (in-memory canonical array — no re-read race)
  const artifacts = await getArtifacts()
  artifacts.push(artifact)
  if (artifacts.length > MAX_ARTIFACTS) artifacts.splice(0, artifacts.length - MAX_ARTIFACTS)
  await writeArtifacts(artifacts)

  // Auto-rename session based on artifacts (fire-and-forget)
  try {
    const autoName = generateSessionName(artifact)
    if (autoName) {
      const isDefaultName = /^(Claude|Cursor)\s\d+$/.test(inst.name)
      const isPersonaName = inst.name.startsWith('Persona: ')
      if (isDefaultName) {
        await client.renameInstance(instanceId, autoName)
      } else if (isPersonaName) {
        const prefix = inst.name.slice(0, inst.name.indexOf(':'))
        await client.renameInstance(instanceId, `${prefix}: ${autoName}`)
      }
    }
  } catch { /* auto-naming is best-effort */ }

  console.log(`[session-artifacts] collected artifact for "${inst.name}" (${commits.length} commits, ${changes.length} changes)`)
  return artifact
}

/** List all artifacts, newest first. */
export async function listArtifacts(): Promise<SessionArtifact[]> {
  const artifacts = await getArtifacts()
  return artifacts.slice().reverse()
}

/** Get a single artifact by session ID. Returns the most recent if multiple exist. */
export async function getArtifact(sessionId: string): Promise<SessionArtifact | null> {
  const artifacts = await getArtifacts()
  for (let i = artifacts.length - 1; i >= 0; i--) {
    if (artifacts[i].sessionId === sessionId) return artifacts[i]
  }
  return null
}

/** Delete all artifacts. */
export async function clearArtifacts(): Promise<void> {
  _artifacts = []
  await writeArtifacts([])
}

/** Tag an existing artifact with a pipeline run ID. */
export async function tagArtifactPipeline(sessionId: string, pipelineRunId: string): Promise<boolean> {
  const artifacts = await getArtifacts()
  let found = false
  for (let i = artifacts.length - 1; i >= 0; i--) {
    if (artifacts[i].sessionId === sessionId) {
      artifacts[i].pipelineRunId = pipelineRunId
      found = true
      break
    }
  }
  if (found) await writeArtifacts(artifacts)
  return found
}
