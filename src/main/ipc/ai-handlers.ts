import { ipcMain } from 'electron'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { resolveCommand } from '../resolve-command'
import { getDaemonRouter } from '../daemon-router'
import { stripAnsi } from '../../shared/utils'
import { getCachedRecap, setCachedRecap } from '../session-recaps'

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

  ipcMain.handle('ai:sessionRecap', async (_e, instanceId: string, force = false): Promise<{ recap: string; generatedAt: string } | null> => {
    if (!instanceId) return null
    if (!force) {
      const cached = getCachedRecap(instanceId)
      if (cached) return cached
    }
    const router = getDaemonRouter()
    let inst = await router.getInstance(instanceId).catch(() => null)
    if (!inst) return null
    let buffer = ''
    try { buffer = await router.getInstanceBuffer(instanceId) } catch { /* buffer unavailable */ }
    const lines = stripAnsi(buffer).split('\n').filter(l => l.trim()).slice(-200).join('\n')
    if (!lines) return null
    const dir = inst.workingDirectory
    let gitLog = ''
    let gitStat = ''
    try {
      const since = inst.createdAt
      const [logOut, statOut] = await Promise.all([
        execFileAsync(resolveCommand('git'), ['log', `--since=${since}`, '--pretty=format:%h %s'], { cwd: dir, timeout: 5000, encoding: 'utf-8' }).catch(() => ({ stdout: '' })),
        execFileAsync(resolveCommand('git'), ['diff', '--stat', 'HEAD~1', 'HEAD'], { cwd: dir, timeout: 5000, encoding: 'utf-8' }).catch(() => ({ stdout: '' })),
      ])
      gitLog = logOut.stdout.trim()
      gitStat = statOut.stdout.trim()
    } catch { /* git context optional */ }
    const isRunning = inst.status === 'running'
    const cost = inst.tokenUsage.cost != null ? `$${inst.tokenUsage.cost.toFixed(4)}` : 'unknown'
    const duration = Math.floor((Date.now() - new Date(inst.createdAt).getTime()) / 1000)
    const durStr = duration < 60 ? `${duration}s` : `${Math.floor(duration / 60)}m${duration % 60}s`
    const prompt = [
      `Summarize this coding session${isRunning ? ' (session still running)' : ''}. Return 3-5 bullet points covering:`,
      `1. What was accomplished`,
      `2. Files/commits made`,
      `3. Errors encountered (if any)`,
      `4. Key decisions`,
      `Be concise. Use markdown bullet points.`,
      ``,
      `Session: ${inst.name} | Model: ${inst.args?.find((_a, i, arr) => arr[i - 1] === '--model') ?? 'claude'} | Duration: ${durStr} | Cost: ${cost}${inst.exitCode != null ? ` | Exit: ${inst.exitCode}` : ''}`,
      gitLog ? `\nCommits:\n${gitLog}` : '',
      gitStat ? `\nDiff stat:\n${gitStat}` : '',
      `\nOutput (last 200 lines):\n${lines.slice(0, 8000)}`,
    ].filter(Boolean).join('\n')
    try {
      const { stdout } = await execFileAsync(
        resolveCommand('claude'),
        ['-p', prompt, '--model', 'claude-sonnet-4-5'],
        { timeout: 60000, encoding: 'utf-8', env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'colony-session-recap' } }
      )
      const recap = stdout.trim()
      if (!recap) return null
      const entry = { recap, generatedAt: new Date().toISOString() }
      setCachedRecap(instanceId, entry)
      return entry
    } catch {
      return null
    }
  })

  ipcMain.handle('ai:decomposeTasks', async (_e, task: string, count: number): Promise<Array<{ title: string; prompt: string }> | null> => {
    if (!task?.trim() || count < 2 || count > 6) return null
    const prompt = `Break this task into ${count} independent, non-overlapping sub-tasks. Return ONLY valid JSON: an array of ${count} objects with "title" (short, under 50 chars) and "prompt" (full task description for a coding agent) fields. No explanation.\n\nTask: ${task.trim()}`
    try {
      const { stdout } = await execFileAsync(
        resolveCommand('claude'),
        ['-p', prompt],
        { timeout: 30000, encoding: 'utf-8', env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'colony-fanout-decompose' } }
      )
      const raw = stdout.trim()
      const jsonMatch = raw.match(/\[[\s\S]*\]/)
      if (!jsonMatch) return null
      const parsed = JSON.parse(jsonMatch[0]) as Array<{ title: string; prompt: string }>
      if (!Array.isArray(parsed) || parsed.length === 0) return null
      return parsed.slice(0, count)
    } catch {
      return null
    }
  })
}
