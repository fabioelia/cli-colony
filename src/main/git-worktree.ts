/**
 * Git worktree helpers for fork/explore mode.
 * Uses execFile (promisified) to avoid shell injection.
 */

import { execFile } from 'child_process'
import { promisify } from 'util'
import { resolveCommand } from './resolve-command'

const execFileAsync = promisify(execFile)

/**
 * Resolve the git root from any directory inside the repo.
 * Returns the absolute path to the repo root, or throws if not in a repo.
 */
export async function getGitRoot(cwd: string): Promise<string> {
  const { stdout } = await execFileAsync(resolveCommand('git'), ['rev-parse', '--show-toplevel'], { cwd })
  return stdout.trim()
}

/**
 * Create a new git worktree with a new branch.
 * @param gitRoot  Absolute path to the git repository root
 * @param branchName  Name for the new branch (must not already exist)
 * @param targetPath  Absolute path where the worktree will be created
 */
export async function addWorktree(
  gitRoot: string,
  branchName: string,
  targetPath: string
): Promise<void> {
  await execFileAsync(
    'git',
    ['worktree', 'add', '-b', branchName, targetPath],
    { cwd: gitRoot }
  )
}

/**
 * Remove a git worktree (force-removes even if dirty).
 * @param gitRoot  Absolute path to the git repository root
 * @param worktreePath  Absolute path to the worktree directory to remove
 */
export async function removeWorktree(
  gitRoot: string,
  worktreePath: string
): Promise<void> {
  await execFileAsync(
    'git',
    ['worktree', 'remove', '--force', worktreePath],
    { cwd: gitRoot }
  )
}
