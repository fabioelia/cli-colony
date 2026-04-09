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
import * as path from 'path'
import { colonyPaths } from '../shared/colony-paths'
import { genId } from '../shared/utils'
import { ensureBareRepo, addWorktree as gitAddWorktree, removeWorktree as gitRemoveWorktree } from '../shared/git-worktree'
import { gitRemoteUrl } from './settings'
import { broadcast } from './broadcast'
import type { WorktreeInfo } from '../shared/types'

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
 */
export async function createWorktree(
  owner: string,
  name: string,
  branch: string,
  repoAlias: string,
  remoteUrl?: string,
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

  const info: WorktreeInfo = {
    id,
    repo: { owner, name },
    branch,
    path: repoDir,
    bareRepoPath: bareDir,
    createdAt: new Date().toISOString(),
    mountedEnvId: null,
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
      results.push(JSON.parse(raw))
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
    return JSON.parse(await fsp.readFile(manifestPath, 'utf-8'))
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

// ---- Internal ----

async function saveWorktreeManifest(info: WorktreeInfo): Promise<void> {
  const manifestPath = path.join(colonyPaths.worktreeDir(info.id), 'worktree.json')
  await fsp.writeFile(manifestPath, JSON.stringify(info, null, 2), 'utf-8')
}
