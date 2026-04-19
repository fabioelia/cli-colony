import { ipcMain } from 'electron'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { resolveCommand } from '../resolve-command'

const execFileAsync = promisify(execFile)

export interface BranchInfo {
  branch: string
  remote: string | null
  ahead: number
}

export interface UnpushedCommit {
  hash: string
  subject: string
  author: string
  date: string
}

/** Validate that cwd is a real git repo before running any commands. */
async function assertGitRepo(cwd: string): Promise<void> {
  await execFileAsync(resolveCommand('git'), ['rev-parse', '--git-dir'], { cwd, timeout: 5000 })
}

export function registerGitHandlers(): void {
  ipcMain.handle('git:stage', async (_e, cwd: string, files: string[]): Promise<void> => {
    await assertGitRepo(cwd)
    // Stage files in batches to avoid arg-length limits
    const batchSize = 50
    for (let i = 0; i < files.length; i += batchSize) {
      const batch = files.slice(i, i + batchSize)
      await execFileAsync(resolveCommand('git'), ['add', '--', ...batch], { cwd, timeout: 15000 })
    }
  })

  ipcMain.handle('git:commit', async (_e, cwd: string, message: string): Promise<string> => {
    await assertGitRepo(cwd)
    const { stdout } = await execFileAsync(resolveCommand('git'), ['commit', '-m', message], {
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
    try {
      await execFileAsync(resolveCommand('git'), ['push'], { cwd, timeout: 60000 })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('no upstream branch') || msg.includes('has no upstream') || msg.includes('--set-upstream')) {
        const { stdout } = await execFileAsync(resolveCommand('git'), ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, timeout: 5000, encoding: 'utf-8' })
        const branch = stdout.trim()
        await execFileAsync(resolveCommand('git'), ['push', '-u', 'origin', branch], { cwd, timeout: 60000 })
      } else {
        throw err
      }
    }
  })

  ipcMain.handle('git:branchInfo', async (_e, cwd: string): Promise<BranchInfo> => {
    await assertGitRepo(cwd)

    let branch = 'HEAD'
    try {
      const { stdout } = await execFileAsync(resolveCommand('git'), ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd, timeout: 5000, encoding: 'utf-8',
      })
      branch = stdout.trim()
    } catch { /* detached HEAD — keep 'HEAD' */ }

    let remote: string | null = null
    try {
      const { stdout } = await execFileAsync(resolveCommand('git'), ['remote', 'get-url', 'origin'], {
        cwd, timeout: 5000, encoding: 'utf-8',
      })
      remote = stdout.trim() || null
    } catch { /* no remote */ }

    let ahead = 0
    try {
      const { stdout } = await execFileAsync(resolveCommand('git'), ['rev-list', '--count', '@{u}..HEAD'], {
        cwd, timeout: 5000, encoding: 'utf-8',
      })
      ahead = parseInt(stdout.trim(), 10) || 0
    } catch { /* no upstream */ }

    return { branch, remote, ahead }
  })

  ipcMain.handle('git:unpushedCommits', async (_e, cwd: string): Promise<UnpushedCommit[]> => {
    await assertGitRepo(cwd)
    try {
      const { stdout } = await execFileAsync(resolveCommand('git'), [
        'log', '@{u}..HEAD', '--format=%H|%s|%an|%ar',
      ], { cwd, timeout: 10000, encoding: 'utf-8' })
      if (!stdout.trim()) return []
      return stdout.trim().split('\n').map(line => {
        const [hash, subject, author, date] = line.split('|')
        return { hash, subject, author, date }
      })
    } catch {
      // No upstream or no commits ahead
      return []
    }
  })

  ipcMain.handle('git:createBranch', async (_e, cwd: string, name: string, startPoint?: string): Promise<string> => {
    await assertGitRepo(cwd)
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(name)) {
      throw new Error('Invalid branch name. Use letters, numbers, hyphens, dots, or slashes.')
    }
    const args = ['checkout', '-b', name]
    if (startPoint) {
      if (!/^[a-zA-Z0-9_./:Z-]+$/.test(startPoint)) throw new Error('Invalid start point ref')
      args.push(startPoint)
    }
    await execFileAsync(resolveCommand('git'), args, { cwd, timeout: 10000 })
    return name
  })

  ipcMain.handle('git:fetch', async (_e, cwd: string): Promise<{ success: boolean; error?: string }> => {
    await assertGitRepo(cwd)
    try {
      await execFileAsync(resolveCommand('git'), ['fetch'], { cwd, timeout: 30000 })
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.stderr || err.message }
    }
  })

  ipcMain.handle('git:pull', async (_e, cwd: string): Promise<{ success: boolean; error?: string }> => {
    await assertGitRepo(cwd)
    try {
      await execFileAsync(resolveCommand('git'), ['pull', '--ff-only'], { cwd, timeout: 60000 })
      return { success: true }
    } catch (err: any) {
      const msg = err.stderr || err.message || ''
      return { success: false, error: msg }
    }
  })

  ipcMain.handle('git:behindCount', async (_e, cwd: string): Promise<number> => {
    await assertGitRepo(cwd)
    try {
      const { stdout } = await execFileAsync(resolveCommand('git'), ['rev-list', '--count', 'HEAD..@{u}'], {
        cwd, timeout: 5000, encoding: 'utf-8',
      })
      return parseInt(stdout.trim(), 10) || 0
    } catch {
      return 0
    }
  })

  ipcMain.handle('git:listBranches', async (_e, cwd: string): Promise<Array<{ name: string; current: boolean }>> => {
    await assertGitRepo(cwd)
    const { stdout } = await execFileAsync(resolveCommand('git'), ['branch', '--format=%(refname:short)|%(HEAD)'], {
      cwd, timeout: 5000, encoding: 'utf-8',
    })
    if (!stdout.trim()) return []
    return stdout.trim().split('\n').map(line => {
      const [name, head] = line.split('|')
      return { name: name.trim(), current: head.trim() === '*' }
    })
  })

  ipcMain.handle('git:switchBranch', async (_e, cwd: string, branch: string): Promise<{ success: boolean; error?: string }> => {
    await assertGitRepo(cwd)
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(branch)) {
      return { success: false, error: 'Invalid branch name' }
    }
    try {
      await execFileAsync(resolveCommand('git'), ['checkout', branch], { cwd, timeout: 15000 })
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.stderr || err.message }
    }
  })

  ipcMain.handle('git:commitDiff', async (_e, cwd: string, hash: string): Promise<string> => {
    await assertGitRepo(cwd)
    // Validate hash is hex-only to prevent injection
    if (!/^[0-9a-f]{7,40}$/i.test(hash)) throw new Error('Invalid commit hash')
    const { stdout } = await execFileAsync(resolveCommand('git'), [
      'diff-tree', '-p', '--no-commit-id', hash,
    ], { cwd, timeout: 15000, encoding: 'utf-8', maxBuffer: 5 * 1024 * 1024 })
    return stdout
  })

  // --- Checkpoint tag operations ---

  ipcMain.handle('git:createTag', async (_e, cwd: string, tagName: string): Promise<void> => {
    await assertGitRepo(cwd)
    if (!/^colony-cp\/[a-zA-Z0-9_-]+\/[0-9T:.Z-]+$/.test(tagName)) {
      throw new Error('Invalid checkpoint tag name. Must match colony-cp/<session-id>/<timestamp>')
    }
    await execFileAsync(resolveCommand('git'), ['tag', tagName], { cwd, timeout: 5000 })
  })

  ipcMain.handle('git:listTags', async (_e, cwd: string, prefix: string): Promise<Array<{ tag: string; date: string; hash: string }>> => {
    await assertGitRepo(cwd)
    if (!/^colony-cp\//.test(prefix)) {
      throw new Error('Tag prefix must start with colony-cp/')
    }
    try {
      const { stdout } = await execFileAsync(resolveCommand('git'), [
        'tag', '-l', `${prefix}*`, '--sort=-creatordate',
        '--format=%(refname:short)|%(creatordate:iso)|%(objectname:short)',
      ], { cwd, timeout: 5000, encoding: 'utf-8' })
      if (!stdout.trim()) return []
      return stdout.trim().split('\n').map(line => {
        const [tag, date, hash] = line.split('|')
        return { tag, date, hash }
      })
    } catch {
      return []
    }
  })

  ipcMain.handle('git:deleteTag', async (_e, cwd: string, tagName: string): Promise<void> => {
    await assertGitRepo(cwd)
    if (!tagName.startsWith('colony-cp/')) {
      throw new Error('Can only delete colony checkpoint tags (colony-cp/ prefix)')
    }
    await execFileAsync(resolveCommand('git'), ['tag', '-d', tagName], { cwd, timeout: 5000 })
  })

  ipcMain.handle('git:deleteTags', async (_e, cwd: string, prefix: string): Promise<number> => {
    await assertGitRepo(cwd)
    if (!prefix.startsWith('colony-cp/')) {
      throw new Error('Can only delete colony checkpoint tags (colony-cp/ prefix)')
    }
    try {
      const { stdout } = await execFileAsync(resolveCommand('git'), [
        'tag', '-l', `${prefix}*`,
      ], { cwd, timeout: 5000, encoding: 'utf-8' })
      if (!stdout.trim()) return 0
      const tags = stdout.trim().split('\n')
      for (const tag of tags) {
        await execFileAsync(resolveCommand('git'), ['tag', '-d', tag], { cwd, timeout: 5000 })
      }
      return tags.length
    } catch {
      return 0
    }
  })

  ipcMain.handle('git:diffRange', async (_e, cwd: string, from: string, to?: string): Promise<{ stat: string; diff: string }> => {
    await assertGitRepo(cwd)
    // Validate refs — allow tag-like paths and hex hashes
    const refPattern = /^[a-zA-Z0-9_./:Z-]+$/
    if (!refPattern.test(from)) throw new Error('Invalid "from" ref')
    if (to && !refPattern.test(to)) throw new Error('Invalid "to" ref')
    const range = to ? `${from}..${to}` : `${from}..HEAD`
    const [statResult, diffResult] = await Promise.all([
      execFileAsync(resolveCommand('git'), ['diff', range, '--stat'], {
        cwd, timeout: 15000, encoding: 'utf-8', maxBuffer: 5 * 1024 * 1024,
      }),
      execFileAsync(resolveCommand('git'), ['diff', range], {
        cwd, timeout: 15000, encoding: 'utf-8', maxBuffer: 5 * 1024 * 1024,
      }),
    ])
    return { stat: statResult.stdout, diff: diffResult.stdout }
  })
}
