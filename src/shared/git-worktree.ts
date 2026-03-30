/**
 * Git worktree utilities for the Colony environment system.
 *
 * Environments share a single bare repo per GitHub repository. Each environment
 * gets a lightweight worktree instead of a full clone. This saves ~250-400 MB
 * per additional environment per repo.
 *
 * Disk layout:
 *   ~/.claude-colony/repos/<owner>/<name>.git   — bare repo (shared object store)
 *   ~/.claude-colony/environments/<env>/        — worktrees pointing to bare repos
 *
 * Branch naming: env/<env-slug>/<branch> — each worktree gets its own local
 * tracking branch to avoid git's "branch already checked out" conflict.
 */

import * as fs from 'fs'
import * as path from 'path'
import { execSync } from 'child_process'
import { colonyPaths } from './colony-paths'

// Use the user's shell environment when available (main process sets this up),
// fall back to process.env for the daemon process.
let cachedShellEnv: Record<string, string> | null = null

function getEnv(): Record<string, string> {
  if (cachedShellEnv) return cachedShellEnv
  try {
    // Try to load shell env (available in main process)
    const { loadShellEnv } = require('../main/shell-env')
    cachedShellEnv = loadShellEnv()
  } catch {
    cachedShellEnv = process.env as Record<string, string>
  }
  return cachedShellEnv!
}

function gitExec(cmd: string, opts?: { cwd?: string; timeout?: number }): string {
  return execSync(cmd, {
    env: getEnv(),
    encoding: 'utf-8',
    cwd: opts?.cwd,
    timeout: opts?.timeout || 120000,
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as string
}

async function gitExecAsync(cmd: string, opts?: { cwd?: string; timeout?: number }): Promise<string> {
  return new Promise((resolve, reject) => {
    const { exec } = require('child_process') as typeof import('child_process')
    exec(cmd, {
      env: getEnv(),
      encoding: 'utf-8',
      cwd: opts?.cwd,
      timeout: opts?.timeout || 120000,
      maxBuffer: 10 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      if (err) {
        const enriched = Object.assign(err, { stderr: stderr || '' })
        reject(enriched)
      } else {
        resolve(stdout)
      }
    })
  })
}

/**
 * Ensure a bare repo exists for the given owner/name. If it doesn't exist,
 * clone it from the remote. If it does, fetch the latest refs.
 *
 * Returns the path to the bare repo directory.
 */
export async function ensureBareRepo(
  owner: string,
  name: string,
  remoteUrl: string,
): Promise<string> {
  const bareDir = colonyPaths.bareRepoDir(owner, name)

  if (fs.existsSync(bareDir)) {
    // Bare repo exists — verify it's valid, then fetch
    try {
      const isBare = gitExec('git rev-parse --is-bare-repository', { cwd: bareDir }).trim()
      if (isBare !== 'true') {
        throw new Error(
          `${bareDir} exists but is not a bare repository. ` +
          `Remove it and retry: rm -rf "${bareDir}"`
        )
      }
      // Fetch latest refs from origin
      await gitExecAsync(`git fetch origin --prune`, { cwd: bareDir, timeout: 120000 })
    } catch (fetchErr: any) {
      // If fetch fails, the bare repo might be okay but network is down.
      // Log and continue — worktree creation will still work with existing refs.
      if (fetchErr.message?.includes('not a bare repository')) {
        throw fetchErr // re-throw structural errors
      }
      console.warn(`[git-worktree] fetch failed for ${owner}/${name} (continuing with existing refs): ${fetchErr.message}`)
    }
    return bareDir
  }

  // Create parent directory
  const parentDir = path.dirname(bareDir)
  if (!fs.existsSync(parentDir)) {
    fs.mkdirSync(parentDir, { recursive: true })
  }

  // Clone bare — try SSH first, fall back to HTTPS
  try {
    await gitExecAsync(`git clone --bare "${remoteUrl}" "${bareDir}"`, { timeout: 300000 })
  } catch (sshErr: any) {
    // Try HTTPS fallback
    const httpsUrl = `https://github.com/${owner}/${name}.git`
    try {
      await gitExecAsync(`git clone --bare "${httpsUrl}" "${bareDir}"`, { timeout: 300000 })
    } catch (httpsErr: any) {
      throw new Error(
        `Failed to create bare repo for ${owner}/${name}.\n` +
        `SSH error: ${sshErr.message}\n` +
        `HTTPS error: ${httpsErr.message}\n` +
        `Check your network connection and git credentials.`
      )
    }
  }

  // Configure the bare repo to fetch all branches (bare clones sometimes have
  // a restrictive refspec)
  try {
    gitExec(
      `git config remote.origin.fetch "+refs/heads/*:refs/remotes/origin/*"`,
      { cwd: bareDir },
    )
    // Fetch to populate remote tracking branches with the corrected refspec
    await gitExecAsync(`git fetch origin --prune`, { cwd: bareDir, timeout: 120000 })
  } catch {
    // Non-fatal — the initial clone should have the branches we need
  }

  return bareDir
}

/**
 * Create a worktree from a bare repo for an environment.
 *
 * Creates a per-environment tracking branch: env/<envSlug>/<branch>
 * that tracks origin/<branch>. This avoids git's restriction on two
 * worktrees checking out the same branch.
 *
 * @param bareRepoDir - Path to the bare repo (.git directory)
 * @param worktreePath - Where to create the worktree (the env repo dir)
 * @param branch - The remote branch to track (e.g. "develop")
 * @param envSlug - The environment slug for branch naming
 */
export async function addWorktree(
  bareRepoDir: string,
  worktreePath: string,
  branch: string,
  envSlug: string,
): Promise<void> {
  const localBranch = `env/${envSlug}/${branch}`

  // Ensure the remote branch exists
  try {
    gitExec(`git rev-parse --verify "origin/${branch}"`, { cwd: bareRepoDir })
  } catch {
    // Try fetching the specific branch
    try {
      await gitExecAsync(`git fetch origin "${branch}"`, { cwd: bareRepoDir, timeout: 60000 })
    } catch (fetchErr: any) {
      throw new Error(
        `Branch "${branch}" not found in remote. ` +
        `Fetch error: ${fetchErr.message}\n` +
        `Available remote branches: ${listRemoteBranches(bareRepoDir).join(', ')}`
      )
    }
  }

  // Clean up any stale worktree entry for this path
  try {
    gitExec(`git worktree prune`, { cwd: bareRepoDir })
  } catch { /* non-fatal */ }

  // Remove the local branch if it exists from a previous environment with the same slug
  try {
    gitExec(`git branch -D "${localBranch}"`, { cwd: bareRepoDir })
  } catch { /* branch didn't exist — fine */ }

  // Create the worktree with a per-env tracking branch
  try {
    await gitExecAsync(
      `git worktree add -b "${localBranch}" "${worktreePath}" "origin/${branch}"`,
      { cwd: bareRepoDir, timeout: 60000 },
    )
  } catch (err: any) {
    throw new Error(
      `Failed to create worktree at "${worktreePath}" for branch "${branch}".\n` +
      `Error: ${err.message}\n` +
      `Bare repo: ${bareRepoDir}\n` +
      `Local branch: ${localBranch}\n` +
      `If this environment was partially created, clean up with:\n` +
      `  git -C "${bareRepoDir}" worktree prune\n` +
      `  git -C "${bareRepoDir}" branch -D "${localBranch}"`
    )
  }

  // Configure the worktree's local branch to track the remote
  try {
    gitExec(
      `git branch --set-upstream-to="origin/${branch}" "${localBranch}"`,
      { cwd: worktreePath },
    )
  } catch { /* non-fatal — tracking may already be set */ }
}

/**
 * Remove a worktree cleanly. Removes the worktree entry from the bare repo
 * and deletes the per-environment tracking branch.
 *
 * @param bareRepoDir - Path to the bare repo
 * @param worktreePath - Path to the worktree to remove
 * @param envSlug - The environment slug (for branch cleanup)
 */
export async function removeWorktree(
  bareRepoDir: string,
  worktreePath: string,
  envSlug?: string,
): Promise<void> {
  // Remove the worktree registration
  try {
    gitExec(`git worktree remove "${worktreePath}" --force`, { cwd: bareRepoDir, timeout: 30000 })
  } catch {
    // If the directory is already gone, just prune
    try {
      gitExec(`git worktree prune`, { cwd: bareRepoDir })
    } catch { /* non-fatal */ }
  }

  // Clean up the per-env tracking branch
  if (envSlug) {
    try {
      // Find and delete all branches matching env/<slug>/*
      const branches = gitExec(`git branch --list "env/${envSlug}/*"`, { cwd: bareRepoDir })
        .trim()
        .split('\n')
        .map(b => b.trim().replace(/^\* /, ''))
        .filter(b => b.length > 0)
      for (const branch of branches) {
        try {
          gitExec(`git branch -D "${branch}"`, { cwd: bareRepoDir })
        } catch { /* non-fatal */ }
      }
    } catch { /* non-fatal */ }
  }
}

/**
 * Check if a directory is a git worktree (as opposed to a full clone).
 * Worktrees have a `.git` FILE (containing `gitdir: ...`), not a `.git` DIRECTORY.
 */
export function isWorktree(dir: string): boolean {
  const gitPath = path.join(dir, '.git')
  try {
    const stat = fs.statSync(gitPath)
    return stat.isFile() // worktree: .git is a file; full clone: .git is a directory
  } catch {
    return false
  }
}

/**
 * Prune stale worktree entries from a bare repo.
 * Safe to call at any time — only removes entries whose directories no longer exist.
 */
export function pruneWorktrees(bareRepoDir: string): void {
  try {
    gitExec(`git worktree prune`, { cwd: bareRepoDir })
  } catch (err: any) {
    console.warn(`[git-worktree] prune failed for ${bareRepoDir}: ${err.message}`)
  }
}

/**
 * Prune all known bare repos. Call on daemon startup to clean up
 * orphaned worktree entries from unclean shutdowns.
 */
export function pruneAllBareRepos(): void {
  const reposDir = colonyPaths.repos
  if (!fs.existsSync(reposDir)) return

  try {
    const owners = fs.readdirSync(reposDir)
    for (const owner of owners) {
      const ownerDir = path.join(reposDir, owner)
      if (!fs.statSync(ownerDir).isDirectory()) continue
      const entries = fs.readdirSync(ownerDir)
      for (const entry of entries) {
        if (!entry.endsWith('.git')) continue
        const bareDir = path.join(ownerDir, entry)
        try {
          const isBare = gitExec('git rev-parse --is-bare-repository', { cwd: bareDir }).trim()
          if (isBare === 'true') {
            pruneWorktrees(bareDir)
          }
        } catch { /* not a valid bare repo — skip */ }
      }
    }
  } catch (err: any) {
    console.warn(`[git-worktree] pruneAllBareRepos failed: ${err.message}`)
  }
}

/**
 * List remote branches available in a bare repo.
 */
function listRemoteBranches(bareRepoDir: string): string[] {
  try {
    const output = gitExec('git branch -r', { cwd: bareRepoDir })
    return output.trim().split('\n')
      .map(b => b.trim())
      .filter(b => b && !b.includes('->'))
      .map(b => b.replace(/^origin\//, ''))
  } catch {
    return []
  }
}

/**
 * Get the bare repo directory for a worktree, by reading its .git file.
 * Returns null if the directory is not a worktree or the bare repo can't be resolved.
 */
export function getBareRepoForWorktree(worktreeDir: string): string | null {
  const gitPath = path.join(worktreeDir, '.git')
  try {
    const stat = fs.statSync(gitPath)
    if (!stat.isFile()) return null
    // .git file contains: gitdir: /path/to/bare.git/worktrees/<name>
    const content = fs.readFileSync(gitPath, 'utf-8').trim()
    const match = content.match(/^gitdir:\s*(.+)$/)
    if (!match) return null
    const worktreeGitDir = match[1]
    // Walk up from .../bare.git/worktrees/<name> to .../bare.git
    const bareDir = path.resolve(worktreeDir, worktreeGitDir, '..', '..')
    // Verify it's actually a bare repo
    const isBare = gitExec('git rev-parse --is-bare-repository', { cwd: bareDir }).trim()
    return isBare === 'true' ? bareDir : null
  } catch {
    return null
  }
}

/**
 * Migrate existing shallow/regular clones in repos/ to bare repos.
 * Scans for directories without .git suffix and converts them.
 * This is a one-time migration on startup.
 */
export async function migrateReposToBare(): Promise<void> {
  const reposDir = colonyPaths.repos
  if (!fs.existsSync(reposDir)) return

  try {
    const owners = fs.readdirSync(reposDir)
    for (const owner of owners) {
      const ownerDir = path.join(reposDir, owner)
      try {
        if (!fs.statSync(ownerDir).isDirectory()) continue
      } catch { continue }

      const entries = fs.readdirSync(ownerDir)
      for (const entry of entries) {
        // Skip entries that are already bare repos (.git suffix)
        if (entry.endsWith('.git')) continue

        const repoDir = path.join(ownerDir, entry)
        const bareDir = repoDir + '.git'

        // Skip if this isn't a git repo
        const gitDir = path.join(repoDir, '.git')
        if (!fs.existsSync(gitDir)) continue

        // Skip if bare repo already exists
        if (fs.existsSync(bareDir)) continue

        try {
          // Get the remote URL from the existing clone
          const remoteUrl = gitExec('git remote get-url origin', { cwd: repoDir }).trim()
          if (!remoteUrl) continue

          console.log(`[git-worktree] migrating ${owner}/${entry} to bare repo`)
          // Create bare clone from the remote (not from the shallow clone, which may lack history)
          await gitExecAsync(`git clone --bare "${remoteUrl}" "${bareDir}"`, { timeout: 300000 })

          // Configure fetch refspec
          gitExec(
            `git config remote.origin.fetch "+refs/heads/*:refs/remotes/origin/*"`,
            { cwd: bareDir },
          )
          await gitExecAsync(`git fetch origin --prune`, { cwd: bareDir, timeout: 120000 })

          console.log(`[git-worktree] migrated: ${owner}/${entry} -> ${entry}.git`)

          // NOTE: We keep the old shallow clone around — the GitHub panel still uses it.
          // It can be cleaned up separately if desired.
        } catch (err: any) {
          console.warn(`[git-worktree] migration failed for ${owner}/${entry}: ${err.message}`)
          // Clean up partial bare repo if creation failed
          if (fs.existsSync(bareDir)) {
            try { fs.rmSync(bareDir, { recursive: true, force: true }) } catch { /* */ }
          }
        }
      }
    }
  } catch (err: any) {
    console.warn(`[git-worktree] repo migration scan failed: ${err.message}`)
  }
}
