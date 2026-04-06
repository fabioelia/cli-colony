/**
 * Session Router — scoring and routing logic for finding the best existing
 * session to route a pipeline prompt to.
 *
 * Extracted from pipeline-engine.ts to isolate the routing heuristics from
 * the pipeline execution logic.
 */

import { join } from 'path'
import { readdirSync, statSync } from 'fs'
import { execFileSync } from 'child_process'
import { getRepos } from './github'
import { scanSessions } from './session-scanner'
import { getAllInstances } from './instance-manager'
import type { ClaudeInstance } from '../daemon/protocol'

// ---- Types ----

export type RouteResult = {
  type: 'running'
  instance: ClaudeInstance
  score: number
} | {
  type: 'resume'
  sessionId: string
  project: string
  name: string
  score: number
  messageCount: number
}

export interface RouteMatch {
  gitBranch?: string
  workingDirectory?: string
  repoName?: string
  prNumber?: number
  role?: string // match by agent role tag (+20 score bonus)
}

// ---- Branch Detection ----

/** Check the live git branch for a directory (not the stale metadata). */
export function getLiveBranch(dir: string): string | null {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: dir, timeout: 3000, encoding: 'utf-8',
    }).trim() || null
  } catch { return null }
}

/** Check branch in a subdirectory matching the repo name (for monorepo/workspace parents). */
export function getLiveBranchInSubdir(dir: string, repoName: string): string | null {
  if (!repoName) return null
  try {
    const entries = readdirSync(dir)
    for (const entry of entries) {
      if (entry.toLowerCase() === repoName.toLowerCase()) {
        const sub = join(dir, entry)
        try { if (!statSync(sub).isDirectory()) continue } catch { continue }
        return getLiveBranch(sub)
      }
    }
  } catch { /* ignore */ }
  return null
}

// ---- Name Matching ----

/** Check if a session name partially matches a branch name. */
export function nameMatchesBranch(sessionName: string, branch: string): boolean {
  if (!sessionName || !branch || sessionName.length < 4) return false
  const nameLower = sessionName.toLowerCase().trim()
  const branchLower = branch.toLowerCase()
  if (nameLower.length < 4) return false
  // Exact substring (name in branch or branch in name)
  if (branchLower.includes(nameLower)) return true
  if (nameLower.includes(branchLower)) return true
  // Word-level: split name into words, check all significant words appear in branch
  const nameWords = nameLower.split(/[\s\-_\/]+/).filter(w => w.length > 2)
  return nameWords.length > 0 && nameWords.every(w => branchLower.includes(w))
}

// ---- Scoring ----

/** Score how well a session directory matches the desired route criteria. */
export function scoreSessionDir(
  dir: string,
  sessionName: string,
  metadataBranch: string | null,
  match: RouteMatch
): number {
  let score = 0

  // 1. Git branch check -- check live branch first, then subdirectory, then metadata
  if (match.gitBranch) {
    const liveBranch = getLiveBranch(dir)
    if (liveBranch === match.gitBranch) {
      score += 15
    } else if (match.repoName) {
      // If dir is a parent workspace, check for repo subdirectory
      // But only if the dir seems related (contains repo as direct child, not a generic parent)
      const subBranch = getLiveBranchInSubdir(dir, match.repoName)
      if (subBranch === match.gitBranch) {
        // Only give full points if the dir seems repo-specific (not e.g. ~/projects)
        const dirDepth = dir.split('/').length
        const homeDepth = (process.env.HOME || '').split('/').length
        if (dirDepth > homeDepth + 1) {
          score += 12
        } else {
          score += 3 // generic parent -- weak signal
        }
      }
    }
    // Stale metadata branch
    if (score === 0 && metadataBranch === match.gitBranch) {
      score += 10
    }
  }

  // 2. Working directory match
  if (match.workingDirectory) {
    if (dir === match.workingDirectory) score += 5
    else if (dir.startsWith(match.workingDirectory + '/')) score += 3
  }

  // 3. Repo name in directory path (direct child or in path)
  if (match.repoName && !match.workingDirectory) {
    const dirLower = dir.toLowerCase()
    const repoLower = match.repoName.toLowerCase()
    if (dirLower.endsWith('/' + repoLower) || dirLower.includes('/' + repoLower + '/')) {
      score += 4
    } else {
      // Check if repo exists as subdirectory (workspace parent containing multiple repos)
      try {
        const sub = join(dir, match.repoName)
        if (statSync(sub).isDirectory()) score += 3
      } catch { /* ignore */ }
    }
  }

  // 4. Session name matches PR number
  if (match.prNumber && sessionName) {
    const nameLower = sessionName.toLowerCase()
    if (nameLower.includes(`#${match.prNumber}`) || nameLower.includes(`pr ${match.prNumber}`)) {
      score += 8
    }
  }

  // 5. Session name matches branch (exact or partial)
  if (match.gitBranch && sessionName) {
    if (sessionName.toLowerCase().includes(match.gitBranch.toLowerCase())) {
      score += 6
    } else if (nameMatchesBranch(sessionName, match.gitBranch)) {
      score += 5
    }
  }

  // 6. Penalty: if directory is clearly inside a DIFFERENT repo
  //    e.g. session in .../repo-a/... should not match repo=repo-b
  if (match.repoName && score > 0) {
    const dirLower = dir.toLowerCase()
    const repoLower = match.repoName.toLowerCase()
    // Get all configured repos to detect siblings
    const allRepos = getRepos()
    for (const r of allRepos) {
      const otherLower = r.name.toLowerCase()
      if (otherLower === repoLower) continue // same repo, no penalty
      // If the dir path contains this other repo name as a segment
      if (dirLower.includes('/' + otherLower + '/') || dirLower.endsWith('/' + otherLower)) {
        score = Math.max(0, score - 10) // strong penalty for wrong repo
        break
      }
    }
  }

  return score
}

// ---- Route Finding ----

/**
 * Find the best session (running or historical) to route a prompt to.
 * Returns null if no suitable candidate meets the minimum score threshold.
 */
export async function findBestRoute(
  match: RouteMatch,
  log: (msg: string) => void = console.log
): Promise<RouteResult | null> {
  const candidates: RouteResult[] = []

  // ---- 1. Score running instances ----
  const all = await getAllInstances()
  const running = all.filter(i => i.status === 'running')

  for (const inst of running) {
    let score = scoreSessionDir(inst.workingDirectory, inst.name || '', inst.gitBranch, match)

    // Role tag matching: strong +20 bonus when role matches
    if (match.role && (inst as any).roleTag === match.role) {
      score += 20
    }

    if (score > 0) {
      const adjusted = inst.activity === 'waiting' ? score + 1 : score
      candidates.push({ type: 'running', instance: inst, score: adjusted })
    }
  }

  // ---- 2. Score CLI history sessions (for --resume) ----
  // Only consider if no strong running match found
  const bestRunning = candidates.length > 0 ? Math.max(...candidates.map(c => c.score)) : 0

  if (bestRunning < 10) {
    try {
      const history = scanSessions(100)
      // Exclude sessions that are already running in Colony
      const runningArgs = all.flatMap(i => i.args || [])

      for (const session of history) {
        if (runningArgs.includes(session.sessionId)) continue

        const sessionName = session.name || session.display || ''
        const score = scoreSessionDir(session.project, sessionName, null, match)

        if (score > 0) {
          candidates.push({
            type: 'resume',
            sessionId: session.sessionId,
            project: session.project,
            name: session.name || session.display.slice(0, 40),
            score: score - 2,
            messageCount: session.messageCount,
          })
        }
      }
    } catch (err) {
      log(`Failed to scan session history: ${err}`)
    }
  }

  // Require a minimum score to avoid false-positive routing.
  // Score reference: direct branch match=15, metadata branch=10, repo-specific subdir=12,
  // working dir exact=5, name matches PR#=8, name matches branch=5-6.
  // Generic-parent subdir branch match=3, which is too weak to route on.
  const MIN_ROUTE_SCORE = 5
  const strong = candidates.filter(c => c.score >= MIN_ROUTE_SCORE)
  if (strong.length === 0) {
    if (candidates.length > 0) {
      log(`Routing: ${candidates.length} weak candidate(s) below threshold (best score=${Math.max(...candidates.map(c => c.score))}), ignoring`)
    }
    return null
  }

  // Sort by score descending, then prefer running over resume, then most messages (deeper context)
  strong.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    if (a.type !== b.type) return a.type === 'running' ? -1 : 1
    // Among resume candidates, prefer more messages (deeper context)
    const aMsgs = a.type === 'resume' ? a.messageCount : 0
    const bMsgs = b.type === 'resume' ? b.messageCount : 0
    return bMsgs - aMsgs
  })

  const best = strong[0]
  if (best.type === 'running') {
    log(`Routing: best match is running session "${best.instance.name}" score=${best.score}`)
  } else {
    log(`Routing: best match is history session "${best.name}" (${best.sessionId}) score=${best.score} -- will resume`)
  }
  return best
}
