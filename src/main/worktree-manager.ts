/**
 * Worktree Manager — decoupled worktree lifecycle management.
 *
 * Worktrees are standalone git worktrees stored in ~/.claude-colony/worktrees/<id>/.
 * They can be mounted to (and unmounted from) environments independently.
 * This decouples the git branch surface from the runtime environment lifecycle.
 *
 * Disk layout:
 *   ~/.claude-colony/worktrees/<id>/worktree.json   — metadata
 *   ~/.claude-colony/worktrees/<id>/<repo-name>/    — actual worktree checkout
 */

import { promises as fsp } from 'fs'
import { execFile } from 'child_process'
import { promisify } from 'util'
import * as path from 'path'
import { colonyPaths } from '../shared/colony-paths'
import { genId } from '../shared/utils'
import { loadShellEnv } from '../shared/shell-env'
import { ensureBareRepo, addWorktree as gitAddWorktree, removeWorktree as gitRemoveWorktree } from '../shared/git-worktree'
import { gitRemoteUrl } from './settings'
import { resolveCommand } from './resolve-command'
import { broadcast } from './broadcast'
import type { WorktreeInfo, WorktreeRepo } from '../shared/types'

const execFileAsync = promisify(execFile)

async function runGit(args: string[], cwd: string, timeout = 30000): Promise<string> {
  const { stdout } = await execFileAsync(
    resolveCommand('git'),
    args,
    { cwd, timeout, env: { ...loadShellEnv(), GIT_TERMINAL_PROMPT: '0' } }
  )
  return stdout.trim()
}

// ---- Pull / upstream status types ----

export type PullResult =
  | { ok: true; before: string; after: string; commitsPulled: number }
  | { ok: false; reason: 'dirty' | 'diverged' | 'detached' | 'not-found' | 'fetch-failed' | 'no-upstream'; message: string }

export type UpstreamStatus = {
  behind: number
  ahead: number
  dirty: boolean
  upToDate: boolean
  upstream: string | null
  error?: string
}

async function pathExists(p: string): Promise<boolean> {
  try { await fsp.access(p); return true } catch { return false }
}

const WORKTREES_DIR = colonyPaths.worktrees

/**
 * Create a new standalone worktree.
 *
 * @param owner - GitHub repo owner
 * @param name - GitHub repo name
 * @param branch - Remote branch to track (e.g. "develop")
 * @param repoAlias - Alias used in environment templates (e.g. "backend")
 * @param remoteUrl - Optional explicit remote URL (resolved from settings if omitted)
 * @param displayName - User-facing name (defaults to "<branch> (<id[:6]>)")
 */
export async function createWorktree(
  owner: string,
  name: string,
  branch: string,
  repoAlias: string,
  remoteUrl?: string,
  displayName?: string,
): Promise<WorktreeInfo> {
  const id = genId()
  const wtDir = colonyPaths.worktreeDir(id)
  const repoDir = path.join(wtDir, name)

  await fsp.mkdir(wtDir, { recursive: true })

  // Ensure bare repo exists (shared object store)
  const url = remoteUrl || await gitRemoteUrl(owner, name)
  const bareDir = await ensureBareRepo(owner, name, url)

  // Create the worktree with wt/<id>/<branch> naming
  await gitAddWorktree(bareDir, repoDir, branch, `wt-${id}`)

  const repoEntry: WorktreeRepo = {
    owner,
    name,
    alias: repoAlias,
    path: repoDir,
    bareRepoPath: bareDir,
  }

  const info: WorktreeInfo = {
    id,
    displayName: displayName || `${branch} (${id.slice(0, 6)})`,
    repos: [repoEntry],
    branch,
    createdAt: new Date().toISOString(),
    mountedEnvId: null,
    // Deprecated compat fields (derived from repos[0])
    repo: { owner, name },
    path: repoDir,
    bareRepoPath: bareDir,
    repoAlias,
  }

  // Write manifest
  await fsp.writeFile(
    path.join(wtDir, 'worktree.json'),
    JSON.stringify(info, null, 2),
    'utf-8',
  )

  broadcast('worktree:changed', null)
  return info
}

/**
 * List all worktrees.
 */
export async function listWorktrees(): Promise<WorktreeInfo[]> {
  if (!await pathExists(WORKTREES_DIR)) return []

  const entries = await fsp.readdir(WORKTREES_DIR)
  const results: WorktreeInfo[] = []

  for (const entry of entries) {
    const manifestPath = path.join(WORKTREES_DIR, entry, 'worktree.json')
    try {
      const raw = await fsp.readFile(manifestPath, 'utf-8')
      results.push(migrateWorktreeInfo(JSON.parse(raw)))
    } catch { /* skip invalid entries */ }
  }

  return results
}

/**
 * Get a single worktree by ID.
 */
export async function getWorktree(id: string): Promise<WorktreeInfo | null> {
  const manifestPath = path.join(colonyPaths.worktreeDir(id), 'worktree.json')
  try {
    return migrateWorktreeInfo(JSON.parse(await fsp.readFile(manifestPath, 'utf-8')))
  } catch {
    return null
  }
}

/**
 * Mount a worktree to an environment.
 * Updates the worktree manifest with the environment ID.
 * The caller is responsible for stopping services before mounting
 * and updating the environment manifest's paths.
 */
export async function mountWorktree(worktreeId: string, envId: string): Promise<WorktreeInfo> {
  const info = await getWorktree(worktreeId)
  if (!info) throw new Error(`Worktree ${worktreeId} not found`)
  if (info.mountedEnvId && info.mountedEnvId !== envId) {
    throw new Error(`Worktree ${worktreeId} is already mounted to environment ${info.mountedEnvId}`)
  }

  info.mountedEnvId = envId
  await saveWorktreeManifest(info)
  broadcast('worktree:changed', null)
  return info
}

/**
 * Unmount a worktree from its environment.
 * The caller is responsible for stopping services before unmounting
 * and reverting the environment manifest's paths.
 */
export async function unmountWorktree(worktreeId: string): Promise<WorktreeInfo> {
  const info = await getWorktree(worktreeId)
  if (!info) throw new Error(`Worktree ${worktreeId} not found`)

  info.mountedEnvId = null
  await saveWorktreeManifest(info)
  broadcast('worktree:changed', null)
  return info
}

/**
 * Remove a worktree. Fails if currently mounted to an environment.
 */
export async function removeWorktree(worktreeId: string): Promise<void> {
  const info = await getWorktree(worktreeId)
  if (!info) throw new Error(`Worktree ${worktreeId} not found`)
  if (info.mountedEnvId) {
    throw new Error(`Cannot remove worktree ${worktreeId} — it is mounted to environment ${info.mountedEnvId}`)
  }

  // Remove from git bare repo's worktree list + delete tracking branch
  try {
    await gitRemoveWorktree(info.bareRepoPath, info.path, `wt-${info.id}`)
  } catch (err) {
    console.warn(`[worktree-manager] git worktree cleanup failed (continuing):`, err)
  }

  // Delete the worktree directory
  const wtDir = colonyPaths.worktreeDir(worktreeId)
  try {
    await fsp.rm(wtDir, { recursive: true, force: true })
  } catch (err) {
    console.error(`[worktree-manager] failed to remove ${wtDir}:`, err)
  }

  broadcast('worktree:changed', null)
}

/**
 * Find worktrees mounted to a specific environment.
 */
export async function getWorktreesForEnv(envId: string): Promise<WorktreeInfo[]> {
  const all = await listWorktrees()
  return all.filter(wt => wt.mountedEnvId === envId)
}

/**
 * Unmount all worktrees from an environment.
 * Called during environment teardown to release worktrees without destroying them.
 */
export async function unmountAllForEnv(envId: string): Promise<void> {
  const mounted = await getWorktreesForEnv(envId)
  for (const wt of mounted) {
    wt.mountedEnvId = null
    await saveWorktreeManifest(wt)
  }
  if (mounted.length > 0) {
    broadcast('worktree:changed', null)
  }
}

/** Stale threshold: worktrees unmounted for >30 days. */
const STALE_DAYS = 30

export type WorktreeStatus = 'mounted' | 'unmounted' | 'orphaned' | 'stale'

/**
 * Get the lifecycle status of a worktree.
 * - mounted: currently attached to an environment
 * - unmounted: detached, recently created
 * - orphaned: references an environment that no longer exists
 * - stale: unmounted for >30 days
 */
export function getWorktreeStatus(wt: WorktreeInfo, envIds: Set<string>): WorktreeStatus {
  if (wt.mountedEnvId) {
    return envIds.has(wt.mountedEnvId) ? 'mounted' : 'orphaned'
  }
  const ageDays = (Date.now() - new Date(wt.createdAt).getTime()) / (1000 * 60 * 60 * 24)
  return ageDays > STALE_DAYS ? 'stale' : 'unmounted'
}

/**
 * Auto-unmount worktrees whose environment no longer exists.
 * Only unmounts — never deletes. Runs on startup after syncEnvironmentsFromDisk().
 */
export async function cleanupOrphans(existingEnvIds: string[]): Promise<number> {
  const all = await listWorktrees()
  const envSet = new Set(existingEnvIds)
  let cleaned = 0

  for (const wt of all) {
    if (wt.mountedEnvId && !envSet.has(wt.mountedEnvId)) {
      console.log(`[worktree-manager] orphan cleanup: unmounting ${wt.id} (env ${wt.mountedEnvId} gone)`)
      wt.mountedEnvId = null
      await saveWorktreeManifest(wt)
      cleaned++
    }
  }

  if (cleaned > 0) {
    broadcast('worktree:changed', null)
    console.log(`[worktree-manager] cleaned ${cleaned} orphaned worktree${cleaned !== 1 ? 's' : ''}`)
  }
  return cleaned
}

// ---- Pull / upstream status ----

/**
 * Fast-forward a worktree to the latest origin/<branch>.
 * Fetches, checks cleanliness, validates fast-forward safety, then merges --ff-only.
 */
export async function pullWorktree(worktreeId: string): Promise<PullResult> {
  const info = await getWorktree(worktreeId)
  if (!info) return { ok: false, reason: 'not-found', message: `Worktree ${worktreeId} not found` }

  const repos = info.repos
  const failures: Array<{ repoAlias: string; reason: string; message: string }> = []
  let firstBefore = ''
  let firstAfter = ''
  let totalPulled = 0

  for (const repo of repos) {
    // Step 1: Fetch
    try {
      await runGit(['fetch', 'origin', info.branch], repo.bareRepoPath, 60000)
    } catch (err: any) {
      const msg = (err?.stderr as string | undefined)?.trim() || err?.message || 'Fetch failed'
      if (repos.length === 1) return { ok: false, reason: 'fetch-failed', message: msg }
      failures.push({ repoAlias: repo.alias, reason: 'fetch-failed', message: msg })
      continue
    }

    // Step 2: Cleanliness check
    let statusOut: string
    try {
      statusOut = await runGit(['status', '--porcelain'], repo.path)
    } catch (err: any) {
      const msg = err?.message || 'Failed to read status'
      if (repos.length === 1) return { ok: false, reason: 'fetch-failed', message: msg }
      failures.push({ repoAlias: repo.alias, reason: 'fetch-failed', message: msg })
      continue
    }
    if (statusOut.length > 0) {
      if (repos.length === 1) return { ok: false, reason: 'dirty', message: 'Working tree has uncommitted changes' }
      failures.push({ repoAlias: repo.alias, reason: 'dirty', message: 'Working tree has uncommitted changes' })
      continue
    }

    // Step 3: Upstream check (detached HEAD has no upstream)
    try {
      const upstream = await runGit(['rev-parse', '--abbrev-ref', 'HEAD@{u}'], repo.path)
      if (!upstream) throw new Error('empty')
    } catch {
      if (repos.length === 1) return { ok: false, reason: 'no-upstream', message: 'No upstream tracking branch configured' }
      failures.push({ repoAlias: repo.alias, reason: 'no-upstream', message: 'No upstream tracking branch configured' })
      continue
    }

    // Step 4: Ancestor check (fast-forward safety)
    const before = await runGit(['rev-parse', 'HEAD'], repo.path)
    if (!firstBefore) firstBefore = before
    try {
      await runGit(['merge-base', '--is-ancestor', 'HEAD', `origin/${info.branch}`], repo.path)
    } catch {
      const msg = `Local commits not in origin/${info.branch} — rebase manually`
      if (repos.length === 1) return { ok: false, reason: 'diverged', message: msg }
      failures.push({ repoAlias: repo.alias, reason: 'diverged', message: msg })
      continue
    }

    // Step 5: Count commits behind
    const countStr = await runGit(['rev-list', '--count', `HEAD..origin/${info.branch}`], repo.path)
    const commitsPulled = parseInt(countStr, 10) || 0
    totalPulled += commitsPulled

    if (commitsPulled > 0) {
      await runGit(['merge', '--ff-only', `origin/${info.branch}`], repo.path)
    }
    const after = await runGit(['rev-parse', 'HEAD'], repo.path)
    if (!firstAfter) firstAfter = after
  }

  if (failures.length > 0) {
    const first = failures[0]
    const detail = repos.length > 1
      ? ` (${failures.map(f => `${f.repoAlias}: ${f.reason}`).join(', ')})`
      : ''
    return { ok: false, reason: first.reason as 'dirty' | 'diverged' | 'detached' | 'not-found' | 'fetch-failed' | 'no-upstream', message: first.message + detail }
  }

  broadcast('worktree:changed', null)
  return { ok: true, before: firstBefore, after: firstAfter, commitsPulled: totalPulled }
}

/**
 * Read upstream status for a worktree without fetching (cheap, reads local refs only).
 */
export async function getWorktreeUpstreamStatus(worktreeId: string): Promise<UpstreamStatus> {
  const info = await getWorktree(worktreeId)
  if (!info) return { behind: 0, ahead: 0, dirty: false, upToDate: true, upstream: null, error: 'Not found' }

  const repo = info.repos[0]
  if (!repo) return { behind: 0, ahead: 0, dirty: false, upToDate: true, upstream: null, error: 'No repos' }

  try {
    const revListOut = await runGit(
      ['rev-list', '--left-right', '--count', `origin/${info.branch}...HEAD`],
      repo.path
    )
    const parts = revListOut.split(/\s+/)
    const behind = parseInt(parts[0], 10) || 0
    const ahead = parseInt(parts[1], 10) || 0

    const statusOut = await runGit(['status', '--porcelain'], repo.path)
    const dirty = statusOut.length > 0

    return {
      behind,
      ahead,
      dirty,
      upToDate: behind === 0 && ahead === 0 && !dirty,
      upstream: `origin/${info.branch}`,
    }
  } catch (err: any) {
    return { behind: 0, ahead: 0, dirty: false, upToDate: true, upstream: null, error: err?.message || 'Unknown error' }
  }
}

/**
 * Fetch latest refs for a worktree's branch from origin. Does not merge.
 */
export async function fetchWorktree(worktreeId: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const info = await getWorktree(worktreeId)
  if (!info) return { ok: false, message: `Worktree ${worktreeId} not found` }

  try {
    for (const repo of info.repos) {
      await runGit(['fetch', 'origin', info.branch], repo.bareRepoPath, 60000)
    }
    return { ok: true }
  } catch (err: any) {
    return { ok: false, message: (err?.stderr as string | undefined)?.trim() || err?.message || 'Fetch failed' }
  }
}

// ---- Disk size ----

export async function getWorktreeSize(worktreeId: string): Promise<{ bytes: number; computedAt: string }> {
  const info = await getWorktree(worktreeId)
  const computedAt = new Date().toISOString()
  if (!info || info.repos.length === 0) return { bytes: 0, computedAt }

  let totalBytes = 0
  for (const repo of info.repos) {
    try {
      const { stdout } = await execFileAsync('du', ['-sk', repo.path], { timeout: 30000 })
      const kb = parseInt(stdout.trim().split(/\s+/)[0], 10)
      if (!isNaN(kb)) totalBytes += kb * 1024
    } catch {
      // du unavailable (Windows) or path missing — fall back to JS recursive walk
      totalBytes += await jsWalkSize(repo.path)
    }
  }
  return { bytes: totalBytes, computedAt }
}

async function jsWalkSize(dirPath: string): Promise<number> {
  try {
    const entries = await fsp.readdir(dirPath, { withFileTypes: true })
    let size = 0
    await Promise.all(entries.map(async (entry) => {
      const full = path.join(dirPath, entry.name)
      if (entry.isSymbolicLink()) return
      if (entry.isDirectory()) {
        size += await jsWalkSize(full)
      } else {
        try {
          const stat = await fsp.stat(full)
          size += stat.size
        } catch { /* skip unreadable */ }
      }
    }))
    return size
  } catch {
    return 0
  }
}

// ---- Internal ----

/** Backfill displayName + repos[] for worktrees created before multi-repo support. */
function migrateWorktreeInfo(raw: any): WorktreeInfo {
  const info = raw as WorktreeInfo
  // Backfill repos[] from legacy single-repo fields
  if (!info.repos || info.repos.length === 0) {
    info.repos = [{
      owner: info.repo?.owner || '',
      name: info.repo?.name || '',
      alias: info.repoAlias || '',
      path: info.path || '',
      bareRepoPath: info.bareRepoPath || '',
    }]
  }
  // Backfill displayName
  if (!info.displayName) {
    info.displayName = `${info.branch || 'unknown'} (${info.id.slice(0, 6)})`
  }
  return info
}

async function saveWorktreeManifest(info: WorktreeInfo): Promise<void> {
  const manifestPath = path.join(colonyPaths.worktreeDir(info.id), 'worktree.json')
  await fsp.writeFile(manifestPath, JSON.stringify(info, null, 2), 'utf-8')
}
