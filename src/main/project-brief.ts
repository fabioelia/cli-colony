import { promises as fsp } from 'fs'
import { existsSync } from 'fs'
import { basename } from 'path'
import { colonyPaths } from '../shared/colony-paths'
import { slugify } from '../shared/utils'

export interface ProjectBriefEntry {
  timestamp: string
  sessionName: string
  exitCode: number
  durationMinutes: number
  cost?: number
  commits: string[]
  filesChanged: number
}

const MAX_BRIEF_ENTRIES = 30

function formatEntry(entry: ProjectBriefEntry): string {
  const cost = entry.cost !== undefined ? `, $${entry.cost.toFixed(2)}` : ''
  const meta = `exit ${entry.exitCode}, ${Math.round(entry.durationMinutes)}m${cost}`
  const detail = entry.commits.length > 0
    ? entry.commits.slice(0, 3).join(', ') + (entry.commits.length > 3 ? ` +${entry.commits.length - 3} more` : '')
    : `${entry.filesChanged} file${entry.filesChanged !== 1 ? 's' : ''} changed`
  return `- [${entry.timestamp}] **${entry.sessionName}** (${meta}) — ${detail}`
}

export async function appendBriefEntry(cwd: string, entry: ProjectBriefEntry): Promise<void> {
  const slug = slugify(basename(cwd)) || 'unnamed'
  const briefPath = colonyPaths.projectBrief(slug)

  await fsp.mkdir(colonyPaths.projectBriefs, { recursive: true })

  let existing = ''
  try { existing = await fsp.readFile(briefPath, 'utf-8') } catch { /* first write */ }

  const header = `# Project Brief: ${slug}\n_Auto-updated by Colony. Recent session activity — injected into new sessions for context._\n_Last ${MAX_BRIEF_ENTRIES} sessions. Oldest entries pruned automatically._\n\n## Recent Sessions\n`

  // Extract existing entry lines
  const lines = existing
    .split('\n')
    .filter(l => l.startsWith('- ['))

  lines.push(formatEntry(entry))

  // Prune oldest entries beyond cap
  const pruned = lines.slice(-MAX_BRIEF_ENTRIES)

  await fsp.writeFile(briefPath, header + pruned.join('\n') + '\n', 'utf-8')
}

export function getProjectBriefPath(cwd: string): string | null {
  const slug = slugify(basename(cwd)) || 'unnamed'
  const briefPath = colonyPaths.projectBrief(slug)
  return existsSync(briefPath) ? briefPath : null
}
