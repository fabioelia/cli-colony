/**
 * Fork Manager — orchestrates session fork/explore mode.
 *
 * Creates parallel git worktrees and Claude sessions so the user can
 * explore multiple solution approaches simultaneously. After reviewing,
 * the user picks a winner; losing worktrees are discarded.
 */

import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'
import { colonyPaths } from '../shared/colony-paths'
import type { ForkGroup, ForkEntry } from '../shared/types'
import { getGitRoot, addWorktree, removeWorktree } from './git-worktree'
import { createInstance } from './instance-manager'
import { sendPromptWhenReady } from './send-prompt-when-ready'
import { getDaemonRouter } from './daemon-router'
import { broadcast } from './broadcast'

// ---- Persistence helpers ----

function readGroups(): ForkGroup[] {
  try {
    if (!fs.existsSync(colonyPaths.forkGroups)) return []
    const raw = fs.readFileSync(colonyPaths.forkGroups, 'utf-8')
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as ForkGroup[]) : []
  } catch {
    return []
  }
}

function writeGroups(groups: ForkGroup[]): void {
  const dir = path.dirname(colonyPaths.forkGroups)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(colonyPaths.forkGroups, JSON.stringify(groups, null, 2), 'utf-8')
}

function broadcastGroups(): void {
  broadcast('fork:groups', readGroups())
}

// ---- Public API ----

export function getForkGroups(): ForkGroup[] {
  return readGroups()
}

export interface ForkOpts {
  /** Label for the group (e.g. "Explore sorting strategies") */
  label: string
  /** Last few lines of PTY output used as task summary hint */
  taskSummary: string
  forks: Array<{
    label: string
    directive: string
  }>
}

/**
 * Create a fork group from a running parent session.
 * Throws if the parent dir is not a git repo, or if more than 3 forks requested.
 */
export async function createForkGroup(parentId: string, opts: ForkOpts): Promise<ForkGroup> {
  if (opts.forks.length > 3) {
    throw new Error('Maximum 3 forks allowed per group')
  }
  if (opts.forks.length === 0) {
    throw new Error('At least 1 fork is required')
  }

  // Get parent instance info
  const client = getDaemonRouter()
  const parent = await client.getInstance(parentId)
  if (!parent) throw new Error(`Parent session ${parentId} not found`)

  // Resolve git root
  let gitRoot: string
  try {
    gitRoot = await getGitRoot(parent.workingDirectory)
  } catch {
    throw new Error(`Parent session directory is not a git repository: ${parent.workingDirectory}`)
  }

  const groupId = `fork-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const home = app.getPath('home')

  // Build ForkGroup structure (entries filled in as we create them)
  const forkEntries: ForkEntry[] = []

  // Create each fork
  for (let i = 0; i < opts.forks.length; i++) {
    const forkDef = opts.forks[i]
    const forkId = `f${i + 1}`
    const branchName = `colony-fork-${groupId}-${forkId}`
    const worktreePath = path.join(colonyPaths.forks, groupId, forkId)
    const contextFilePath = path.join(home, '.claude-colony', `fork-context-${groupId}-${forkId}.md`)

    // Create worktree
    fs.mkdirSync(path.dirname(worktreePath), { recursive: true })
    await addWorktree(gitRoot, branchName, worktreePath)

    // Write context file
    const contextContent = [
      `# Fork Context`,
      ``,
      `**Task Summary:**`,
      opts.taskSummary,
      ``,
      `**Fork:** ${i + 1} of ${opts.forks.length}`,
      `**Label:** ${forkDef.label}`,
      `**Directive:** You are fork ${i + 1} of ${opts.forks.length}. Explore approach: ${forkDef.directive}`,
      ``,
      `Please implement your approach thoroughly. When done, summarize what you built.`,
    ].join('\n')
    fs.writeFileSync(contextFilePath, contextContent, 'utf-8')

    // Register the listener BEFORE creating the instance to avoid race condition
    const directive = forkDef.directive

    // Create Claude session in the worktree
    const inst = await createInstance({
      name: `Fork: ${forkDef.label}`,
      workingDirectory: worktreePath,
      args: ['--append-system-prompt-file', contextFilePath],
      parentId,
    })

    // Send the directive prompt once the session is ready
    sendPromptWhenReady(inst.id, {
      prompt: directive,
      forceTimeout: 5000,
      abandonTimeout: 30000,
    }).catch(() => {/* best-effort */})

    forkEntries.push({
      id: forkId,
      sessionId: inst.id,
      sessionName: inst.name,
      branch: branchName,
      worktreePath,
      contextFilePath,
      label: forkDef.label,
      directive: forkDef.directive,
      status: 'running',
    })
  }

  // Whisper to parent session
  try {
    const forkLabels = opts.forks.map((f, i) => `Fork ${i + 1}: ${f.label}`).join(', ')
    const whisper = `\r\n[Colony] Forks launched: ${forkLabels}. Please wait for winner selection before continuing.\r\n`
    await getDaemonRouter().writeToInstance(parentId, whisper + '\r')
  } catch {/* best-effort */}

  const group: ForkGroup = {
    id: groupId,
    parentId,
    parentName: parent.name,
    label: opts.label,
    created: new Date().toISOString(),
    status: 'active',
    forks: forkEntries,
  }

  const groups = readGroups()
  groups.push(group)
  writeGroups(groups)
  broadcastGroups()

  return group
}

/**
 * Pick a winner fork: removes all losing worktrees and context files,
 * marks the group as resolved. Sends a whisper to the parent session.
 */
export async function pickWinner(groupId: string, winnerId: string): Promise<void> {
  const groups = readGroups()
  const group = groups.find((g) => g.id === groupId)
  if (!group) throw new Error(`Fork group ${groupId} not found`)

  // Find git root from first available worktree (to run remove commands)
  const winnerEntry = group.forks.find((f) => f.id === winnerId)
  if (!winnerEntry) throw new Error(`Fork ${winnerId} not found in group ${groupId}`)

  let gitRoot: string | null = null
  try {
    gitRoot = await getGitRoot(winnerEntry.worktreePath)
  } catch { /* worktree may already be gone */ }

  // Process each fork
  for (const fork of group.forks) {
    if (fork.id === winnerId) {
      fork.status = 'winner'
    } else {
      // Remove losing worktree
      if (gitRoot) {
        try {
          await removeWorktree(gitRoot, fork.worktreePath)
        } catch { /* may already be removed */ }
      }
      // Delete context file
      try {
        if (fs.existsSync(fork.contextFilePath)) {
          fs.unlinkSync(fork.contextFilePath)
        }
      } catch { /* best-effort */ }
      fork.status = 'discarded'
    }
  }

  group.status = 'resolved'

  // Whisper to parent session
  try {
    const whisper = `\r\n[Colony] Fork winner selected: ${winnerEntry.label}. The winning branch is ${winnerEntry.branch}. You may now continue.\r\n`
    await getDaemonRouter().writeToInstance(group.parentId, whisper + '\r')
  } catch {/* best-effort */}

  writeGroups(groups)
  broadcastGroups()
}

/**
 * Discard a specific fork (e.g. when it crashes or the user gives up on it).
 * If all forks end up in terminal state, the group auto-resolves.
 */
export async function discardFork(groupId: string, forkId: string): Promise<void> {
  const groups = readGroups()
  const group = groups.find((g) => g.id === groupId)
  if (!group) throw new Error(`Fork group ${groupId} not found`)

  const fork = group.forks.find((f) => f.id === forkId)
  if (!fork) throw new Error(`Fork ${forkId} not found in group ${groupId}`)

  // Find git root
  let gitRoot: string | null = null
  try {
    gitRoot = await getGitRoot(fork.worktreePath)
  } catch { /* worktree may already be gone */ }

  // Remove worktree
  if (gitRoot) {
    try {
      await removeWorktree(gitRoot, fork.worktreePath)
    } catch { /* may already be removed */ }
  }

  // Delete context file
  try {
    if (fs.existsSync(fork.contextFilePath)) {
      fs.unlinkSync(fork.contextFilePath)
    }
  } catch { /* best-effort */ }

  fork.status = 'discarded'

  // Auto-close group if all forks are in terminal states
  const terminalStates: ForkEntry['status'][] = ['winner', 'discarded']
  const allDone = group.forks.every((f) => terminalStates.includes(f.status))
  if (allDone) {
    group.status = 'resolved'
  }

  writeGroups(groups)
  broadcastGroups()
}

/**
 * On app restart, clean up groups that have all forks in terminal states.
 * Removes their JSON entries to keep the file tidy.
 */
export function cleanupStaleForkGroups(): void {
  const groups = readGroups()
  const terminalStates: ForkEntry['status'][] = ['winner', 'discarded']

  const active = groups.filter((g) => {
    if (g.status === 'resolved') return false
    const allDone = g.forks.every((f) => terminalStates.includes(f.status))
    return !allDone
  })

  // Keep resolved groups for a bit (UI reference) but remove them after restart
  // Per spec: "entries with all forks in terminal state are cleaned up automatically"
  const kept = groups.filter((g) => {
    if (g.status !== 'resolved') return true
    // Keep resolved groups unless all forks are in terminal state
    const allDone = g.forks.every((f) => terminalStates.includes(f.status))
    return !allDone
  })

  // Only write if something changed
  if (kept.length !== groups.length) {
    writeGroups(kept)
  }

  // Also broadcast so UI starts with fresh state
  void active
  broadcastGroups()
}
