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
import { colonyPaths } from '../shared/colony-paths'
import type { SessionArtifact, SessionArtifactCommit, GitDiffEntry } from '../shared/types'
import { getDaemonClient } from './daemon-client'

const execFileAsync = promisify(execFile)
const MAX_ARTIFACTS = 200

// ---- Persistence ----

async function readArtifacts(): Promise<SessionArtifact[]> {
  try {
    const raw = await fsp.readFile(colonyPaths.sessionArtifacts, 'utf-8')
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

async function writeArtifacts(artifacts: SessionArtifact[]): Promise<void> {
  await fsp.mkdir(dirname(colonyPaths.sessionArtifacts), { recursive: true })
  await fsp.writeFile(colonyPaths.sessionArtifacts, JSON.stringify(artifacts, null, 2), 'utf-8')
}

// ---- Git helpers ----

async function getGitChanges(cwd: string): Promise<GitDiffEntry[]> {
  try {
    const [numStat, nameStat] = await Promise.all([
      execFileAsync('git', ['diff', '--numstat', 'HEAD'], { encoding: 'utf-8', timeout: 5000, cwd }),
      execFileAsync('git', ['diff', '--name-status', 'HEAD'], { encoding: 'utf-8', timeout: 5000, cwd }),
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
    const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, encoding: 'utf-8', timeout: 3000 })
    return stdout.trim() || null
  } catch {
    return null
  }
}

async function getGitRemote(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['remote', 'get-url', 'origin'], { cwd, encoding: 'utf-8', timeout: 3000 })
    return stdout.trim() || null
  } catch {
    return null
  }
}

async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['rev-parse', '--git-dir'], { cwd, timeout: 3000 })
    return true
  } catch {
    return false
  }
}

// ---- Public API ----

/**
 * Collect an artifact bundle for a session that just exited.
 * Fire-and-forget — silently returns on any error.
 */
export async function collectSessionArtifact(instanceId: string): Promise<SessionArtifact | null> {
  const client = getDaemonClient()
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

  // Persist to index
  const existing = await readArtifacts()
  existing.push(artifact)
  const trimmed = existing.length > MAX_ARTIFACTS ? existing.slice(existing.length - MAX_ARTIFACTS) : existing
  await writeArtifacts(trimmed)

  console.log(`[session-artifacts] collected artifact for "${inst.name}" (${commits.length} commits, ${changes.length} changes)`)
  return artifact
}

/** List all artifacts, newest first. */
export async function listArtifacts(): Promise<SessionArtifact[]> {
  const artifacts = await readArtifacts()
  return artifacts.slice().reverse()
}

/** Get a single artifact by session ID. Returns the most recent if multiple exist. */
export async function getArtifact(sessionId: string): Promise<SessionArtifact | null> {
  const artifacts = await readArtifacts()
  // Search from end (newest) to find most recent for this session
  for (let i = artifacts.length - 1; i >= 0; i--) {
    if (artifacts[i].sessionId === sessionId) return artifacts[i]
  }
  return null
}

/** Delete all artifacts. */
export async function clearArtifacts(): Promise<void> {
  await writeArtifacts([])
}

/** Tag an existing artifact with a pipeline run ID. */
export async function tagArtifactPipeline(sessionId: string, pipelineRunId: string): Promise<boolean> {
  const artifacts = await readArtifacts()
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
