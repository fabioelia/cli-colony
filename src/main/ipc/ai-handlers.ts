import { ipcMain } from 'electron'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { resolveCommand } from '../resolve-command'

const execFileAsync = promisify(execFile)

export function registerAiHandlers(): void {
  ipcMain.handle('ai:suggestPRDescription', async (_e, dir: string): Promise<{ title: string; body: string } | null> => {
    if (!dir) return null
    let commits = ''
    let diffStat = ''
    let diff = ''
    const base = '@{u}'
    const fallback = 'HEAD~5'
    const resolveBase = async (): Promise<string> => {
      try {
        await execFileAsync(resolveCommand('git'), ['rev-parse', base], { cwd: dir, timeout: 5000 })
        return base
      } catch {
        return fallback
      }
    }
    const ref = await resolveBase()
    try {
      const [c, s, d] = await Promise.all([
        execFileAsync(resolveCommand('git'), ['log', `${ref}..HEAD`, '--format=%s'], { cwd: dir, timeout: 10000, encoding: 'utf-8' }),
        execFileAsync(resolveCommand('git'), ['diff', `${ref}..HEAD`, '--stat'], { cwd: dir, timeout: 10000, encoding: 'utf-8' }),
        execFileAsync(resolveCommand('git'), ['diff', `${ref}..HEAD`], { cwd: dir, timeout: 15000, encoding: 'utf-8' }),
      ])
      commits = c.stdout.trim()
      diffStat = s.stdout.trim()
      diff = d.stdout.slice(0, 6000)
    } catch {
      return null
    }
    if (!commits && !diff.trim()) return null
    const prompt = `Generate a GitHub PR title and description for the following changes. Return ONLY valid JSON: {"title":"...","body":"..."}\nTitle: short, conventional (feat/fix/ux/perf prefix), under 70 chars.\nBody: markdown with ## Summary (bullet points) and ## Changes sections.\n\nCommits:\n${commits || '(none)'}\n\nDiff stat:\n${diffStat}\n\nDiff (truncated):\n${diff}`
    try {
      const { stdout } = await execFileAsync(
        resolveCommand('claude'),
        ['-p', prompt],
        { timeout: 30000, encoding: 'utf-8', env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'colony-pr-suggest' } }
      )
      const raw = stdout.trim()
      const jsonMatch = raw.match(/\{[\s\S]*\}/)
      if (!jsonMatch) return null
      const parsed = JSON.parse(jsonMatch[0]) as { title: string; body: string }
      if (!parsed.title || !parsed.body) return null
      return parsed
    } catch {
      return null
    }
  })

  ipcMain.handle('ai:suggestCommitMessage', async (_e, dir: string, files: string[]): Promise<string | null> => {
    if (!dir || !files.length) return null
    let diff = ''
    try {
      const { stdout } = await execFileAsync(
        resolveCommand('git'),
        ['diff', 'HEAD', '--', ...files],
        { cwd: dir, timeout: 10000, encoding: 'utf-8' }
      )
      diff = stdout
    } catch {
      return null
    }
    if (!diff.trim()) {
      try {
        const { stdout } = await execFileAsync(
          resolveCommand('git'),
          ['diff', '--staged', '--', ...files],
          { cwd: dir, timeout: 10000, encoding: 'utf-8' }
        )
        diff = stdout
      } catch {
        return null
      }
    }
    if (!diff.trim()) return null
    const truncatedDiff = diff.slice(0, 8000)
    const prompt = `Write a conventional commit message (feat/fix/ux/chore/refactor/test/docs/perf prefix) for this diff. Return ONLY the commit message, no explanation. First line under 72 chars. If multiple changes, use the most significant type.\n\n${truncatedDiff}`
    try {
      const { stdout } = await execFileAsync(
        resolveCommand('claude'),
        ['-p', prompt],
        { timeout: 30000, encoding: 'utf-8', env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'colony-commit-suggest' } }
      )
      return stdout.trim() || null
    } catch {
      return null
    }
  })
}
