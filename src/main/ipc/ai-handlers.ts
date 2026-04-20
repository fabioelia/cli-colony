import { ipcMain } from 'electron'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { resolveCommand } from '../resolve-command'

const execFileAsync = promisify(execFile)

export function registerAiHandlers(): void {
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
