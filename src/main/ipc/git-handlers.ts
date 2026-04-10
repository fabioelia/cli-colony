import { ipcMain } from 'electron'
import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

export interface BranchInfo {
  branch: string
  remote: string | null
  ahead: number
}

/** Validate that cwd is a real git repo before running any commands. */
async function assertGitRepo(cwd: string): Promise<void> {
  await execFileAsync('git', ['rev-parse', '--git-dir'], { cwd, timeout: 5000 })
}

export function registerGitHandlers(): void {
  ipcMain.handle('git:stage', async (_e, cwd: string, files: string[]): Promise<void> => {
    await assertGitRepo(cwd)
    // Stage files in batches to avoid arg-length limits
    const batchSize = 50
    for (let i = 0; i < files.length; i += batchSize) {
      const batch = files.slice(i, i + batchSize)
      await execFileAsync('git', ['add', '--', ...batch], { cwd, timeout: 15000 })
    }
  })

  ipcMain.handle('git:commit', async (_e, cwd: string, message: string): Promise<string> => {
    await assertGitRepo(cwd)
    const { stdout } = await execFileAsync('git', ['commit', '-m', message], {
      cwd,
      timeout: 30000,
      encoding: 'utf-8',
    })
    // Extract commit hash from output (e.g. "[main abc1234] message")
    const match = stdout.match(/\[[\w/.-]+ ([0-9a-f]+)\]/)
    return match ? match[1] : ''
  })

  ipcMain.handle('git:push', async (_e, cwd: string): Promise<void> => {
    await assertGitRepo(cwd)
    await execFileAsync('git', ['push'], { cwd, timeout: 60000 })
  })

  ipcMain.handle('git:branchInfo', async (_e, cwd: string): Promise<BranchInfo> => {
    await assertGitRepo(cwd)

    let branch = 'HEAD'
    try {
      const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd, timeout: 5000, encoding: 'utf-8',
      })
      branch = stdout.trim()
    } catch { /* detached HEAD — keep 'HEAD' */ }

    let remote: string | null = null
    try {
      const { stdout } = await execFileAsync('git', ['remote', 'get-url', 'origin'], {
        cwd, timeout: 5000, encoding: 'utf-8',
      })
      remote = stdout.trim() || null
    } catch { /* no remote */ }

    let ahead = 0
    try {
      const { stdout } = await execFileAsync('git', ['rev-list', '--count', '@{u}..HEAD'], {
        cwd, timeout: 5000, encoding: 'utf-8',
      })
      ahead = parseInt(stdout.trim(), 10) || 0
    } catch { /* no upstream */ }

    return { branch, remote, ahead }
  })
}
