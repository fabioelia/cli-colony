import { execFile } from 'child_process'
import { promisify } from 'util'
import type { GitDiffEntry } from '../shared/types'

const execFileAsync = promisify(execFile)

export async function getLiveChanges(dir: string): Promise<GitDiffEntry[]> {
  try {
    const [numStat, nameStat] = await Promise.all([
      execFileAsync('git', ['diff', '--numstat', 'HEAD'], { encoding: 'utf-8', timeout: 5000, cwd: dir }),
      execFileAsync('git', ['diff', '--name-status', 'HEAD'], { encoding: 'utf-8', timeout: 5000, cwd: dir }),
    ])
    const statusMap = new Map<string, string>()
    for (const line of nameStat.stdout.split('\n')) {
      const parts = line.split('\t')
      if (parts.length >= 2) statusMap.set(parts[parts.length - 1].trim(), parts[0].trim().charAt(0))
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
