import { ipcMain } from 'electron'
import { execFile } from 'child_process'
import { promises as fsp } from 'fs'
import path from 'path'
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

  ipcMain.handle('git:commit', async (_e, cwd: string, message: string, amend?: boolean): Promise<string> => {
    await assertGitRepo(cwd)
    const args = ['commit', '-m', message]
    if (amend) args.push('--amend')
    const { stdout } = await execFileAsync(resolveCommand('git'), args, {
      cwd,
      timeout: 30000,
      encoding: 'utf-8',
    })
    // Extract commit hash from output (e.g. "[main abc1234] message")
    const match = stdout.match(/\[[\w/.-]+ ([0-9a-f]+)\]/)
    return match ? match[1] : ''
  })

  ipcMain.handle('git:lastCommitMessage', async (_e, cwd: string): Promise<string | null> => {
    try {
      const { stdout } = await execFileAsync(resolveCommand('git'), ['log', '-1', '--format=%B'], {
        cwd, timeout: 5000, encoding: 'utf-8',
      })
      return stdout.trim() || null
    } catch { return null }
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

  ipcMain.handle('git:log', async (_e, cwd: string, limit: number = 20, skip: number = 0): Promise<Array<{ hash: string; subject: string; author: string; date: string }>> => {
    await assertGitRepo(cwd)
    try {
      const { stdout } = await execFileAsync(resolveCommand('git'), [
        'log', `--max-count=${limit}`, `--skip=${skip}`, '--format=%H%x00%s%x00%an%x00%ar',
      ], { cwd, timeout: 10000, encoding: 'utf-8' })
      if (!stdout.trim()) return []
      return stdout.trim().split('\n').map(line => {
        const [hash, subject, author, date] = line.split('\0')
        return { hash, subject, author, date }
      })
    } catch { return [] }
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

  ipcMain.handle('git:listBranches', async (_e, cwd: string, includeRemote?: boolean): Promise<Array<{ name: string; current: boolean; remote: boolean }>> => {
    await assertGitRepo(cwd)
    const args = ['branch', '--format=%(refname:short)|%(HEAD)']
    if (includeRemote) args.push('-a')
    const { stdout } = await execFileAsync(resolveCommand('git'), args, {
      cwd, timeout: 5000, encoding: 'utf-8',
    })
    if (!stdout.trim()) return []
    return stdout.trim().split('\n').map(line => {
      const [name, head] = line.split('|')
      const trimName = name.trim()
      const isRemote = trimName.startsWith('remotes/')
      return {
        name: isRemote ? trimName.replace(/^remotes\/origin\//, '') : trimName,
        current: head.trim() === '*',
        remote: isRemote,
      }
    }).filter(b => !b.name.includes('HEAD'))
  })

  ipcMain.handle('git:deleteBranch', async (_e, cwd: string, branch: string, force?: boolean): Promise<{ success: boolean; error?: string }> => {
    await assertGitRepo(cwd)
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(branch)) {
      return { success: false, error: 'Invalid branch name' }
    }
    try {
      await execFileAsync(resolveCommand('git'), ['branch', force ? '-D' : '-d', branch], { cwd, timeout: 5000 })
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.stderr || err.message }
    }
  })

  ipcMain.handle('git:pruneRemote', async (_e, cwd: string): Promise<void> => {
    await assertGitRepo(cwd)
    await execFileAsync(resolveCommand('git'), ['remote', 'prune', 'origin'], { cwd, timeout: 15000 })
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

  ipcMain.handle('git:createPR', async (_e, cwd: string, title: string, body: string, baseBranch?: string, draft?: boolean): Promise<{ url: string }> => {
    await assertGitRepo(cwd)
    const args = ['pr', 'create', '--title', title, '--body', body]
    if (baseBranch) args.push('--base', baseBranch)
    if (draft) args.push('--draft')
    const { stdout } = await execFileAsync(resolveCommand('gh'), args, {
      cwd, timeout: 30000, encoding: 'utf-8',
    })
    return { url: stdout.trim() }
  })

  ipcMain.handle('git:prTemplate', async (_e, cwd: string): Promise<string | null> => {
    const candidates = [
      '.github/pull_request_template.md',
      '.github/PULL_REQUEST_TEMPLATE.md',
      'pull_request_template.md',
      'PULL_REQUEST_TEMPLATE.md',
      'docs/pull_request_template.md',
    ]
    for (const candidate of candidates) {
      try {
        return await fsp.readFile(path.join(cwd, candidate), 'utf-8')
      } catch { /* try next */ }
    }
    return null
  })

  ipcMain.handle('git:defaultBranch', async (_e, cwd: string): Promise<string> => {
    try {
      const { stdout } = await execFileAsync(resolveCommand('gh'), [
        'repo', 'view', '--json', 'defaultBranchRef', '-q', '.defaultBranchRef.name',
      ], { cwd, timeout: 10000, encoding: 'utf-8' })
      return stdout.trim() || 'main'
    } catch { return 'main' }
  })

  ipcMain.handle('git:fileDiff', async (_e, cwd: string, file: string): Promise<string> => {
    await assertGitRepo(cwd)
    const { stdout: staged } = await execFileAsync(resolveCommand('git'), ['diff', '--cached', '--', file], {
      cwd, timeout: 10000, encoding: 'utf-8', maxBuffer: 2 * 1024 * 1024,
    })
    if (staged.trim()) return staged
    const { stdout: unstaged } = await execFileAsync(resolveCommand('git'), ['diff', '--', file], {
      cwd, timeout: 10000, encoding: 'utf-8', maxBuffer: 2 * 1024 * 1024,
    })
    return unstaged
  })

  ipcMain.handle('git:undoLastCommit', async (_e, cwd: string): Promise<void> => {
    await assertGitRepo(cwd)
    await execFileAsync(resolveCommand('git'), ['reset', '--soft', 'HEAD~1'], { cwd, timeout: 10000 })
  })

  ipcMain.handle('git:stashPush', async (_e, cwd: string, message?: string): Promise<void> => {
    await assertGitRepo(cwd)
    const args = ['stash', 'push', '--include-untracked']
    if (message) args.push('-m', message)
    await execFileAsync(resolveCommand('git'), args, { cwd, timeout: 15000 })
  })

  ipcMain.handle('git:stashList', async (_e, cwd: string): Promise<Array<{ index: number; message: string; date: string }>> => {
    await assertGitRepo(cwd)
    try {
      const { stdout } = await execFileAsync(resolveCommand('git'), [
        'stash', 'list', '--format=%gd|%s|%ar',
      ], { cwd, timeout: 5000, encoding: 'utf-8' })
      if (!stdout.trim()) return []
      return stdout.trim().split('\n').map(line => {
        const [ref, message, date] = line.split('|')
        const index = parseInt(ref.replace('stash@{', '').replace('}', ''), 10)
        return { index, message, date }
      })
    } catch { return [] }
  })

  ipcMain.handle('git:stashApply', async (_e, cwd: string, index: number): Promise<void> => {
    await assertGitRepo(cwd)
    await execFileAsync(resolveCommand('git'), ['stash', 'apply', `stash@{${index}}`], { cwd, timeout: 15000 })
  })

  ipcMain.handle('git:stashPop', async (_e, cwd: string, index: number): Promise<void> => {
    await assertGitRepo(cwd)
    await execFileAsync(resolveCommand('git'), ['stash', 'pop', `stash@{${index}}`], { cwd, timeout: 15000 })
  })

  ipcMain.handle('git:stashDrop', async (_e, cwd: string, index: number): Promise<void> => {
    await assertGitRepo(cwd)
    await execFileAsync(resolveCommand('git'), ['stash', 'drop', `stash@{${index}}`], { cwd, timeout: 5000 })
  })

  ipcMain.handle('git:stashShow', async (_e, cwd: string, index: number): Promise<{ stat: string; diff: string }> => {
    await assertGitRepo(cwd)
    if (!Number.isInteger(index) || index < 0) throw new Error('Invalid stash index')
    const [statResult, diffResult] = await Promise.all([
      execFileAsync(resolveCommand('git'), ['stash', 'show', `stash@{${index}}`], { cwd, timeout: 10000, encoding: 'utf-8' }),
      execFileAsync(resolveCommand('git'), ['stash', 'show', '-p', `stash@{${index}}`], { cwd, timeout: 10000, encoding: 'utf-8', maxBuffer: 5 * 1024 * 1024 }),
    ])
    return { stat: statResult.stdout, diff: diffResult.stdout }
  })

  ipcMain.handle('git:fileLog', async (_e, cwd: string, filePath: string, limit: number = 20, skip: number = 0): Promise<Array<{ hash: string; subject: string; author: string; date: string }>> => {
    await assertGitRepo(cwd)
    if (/[;&|`$]/.test(filePath)) throw new Error('Invalid file path')
    try {
      const { stdout } = await execFileAsync(resolveCommand('git'), [
        'log', '--follow', `--max-count=${limit}`, `--skip=${skip}`, '--format=%H%x00%s%x00%an%x00%ar', '--', filePath,
      ], { cwd, timeout: 10000, encoding: 'utf-8' })
      if (!stdout.trim()) return []
      return stdout.trim().split('\n').map(line => {
        const [hash, subject, author, date] = line.split('\0')
        return { hash, subject, author, date }
      })
    } catch { return [] }
  })

  ipcMain.handle('git:fileCommitDiff', async (_e, cwd: string, hash: string, filePath: string): Promise<string> => {
    await assertGitRepo(cwd)
    if (!/^[0-9a-f]{7,40}$/i.test(hash)) throw new Error('Invalid commit hash')
    if (/[;&|`$]/.test(filePath)) throw new Error('Invalid file path')
    try {
      const { stdout } = await execFileAsync(resolveCommand('git'), [
        'diff', `${hash}~1`, hash, '--', filePath,
      ], { cwd, timeout: 10000, encoding: 'utf-8', maxBuffer: 5 * 1024 * 1024 })
      return stdout
    } catch {
      // First commit has no parent — use git show
      const { stdout } = await execFileAsync(resolveCommand('git'), [
        'show', hash, '--', filePath,
      ], { cwd, timeout: 10000, encoding: 'utf-8', maxBuffer: 5 * 1024 * 1024 })
      return stdout
    }
  })

  ipcMain.handle('git:blame', async (_e, cwd: string, filePath: string): Promise<Array<{
    hash: string; author: string; date: string; lineNumber: number; content: string
  }>> => {
    await assertGitRepo(cwd)
    if (/[;&|`$]/.test(filePath)) throw new Error('Invalid file path')
    const { stdout } = await execFileAsync(resolveCommand('git'), [
      'blame', '--porcelain', '--', filePath,
    ], { cwd, timeout: 15000, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 })
    return parsePorcelainBlame(stdout)
  })

  ipcMain.handle('git:cherryPick', async (_e, cwd: string, hash: string): Promise<{ success: boolean; error?: string }> => {
    await assertGitRepo(cwd)
    if (!/^[0-9a-f]{7,40}$/i.test(hash)) throw new Error('Invalid commit hash')
    try {
      await execFileAsync(resolveCommand('git'), ['cherry-pick', hash], { cwd, timeout: 30000 })
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.stderr || err.message }
    }
  })

  ipcMain.handle('git:cherryPickAbort', async (_e, cwd: string): Promise<void> => {
    await assertGitRepo(cwd)
    await execFileAsync(resolveCommand('git'), ['cherry-pick', '--abort'], { cwd, timeout: 5000 })
  })

  ipcMain.handle('git:merge', async (_e, cwd: string, branch: string, noFf?: boolean): Promise<{ success: boolean; error?: string; conflicts?: string[] }> => {
    await assertGitRepo(cwd)
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(branch)) {
      return { success: false, error: 'Invalid branch name' }
    }
    try {
      const args = ['merge', branch]
      if (noFf) args.splice(1, 0, '--no-ff')
      await execFileAsync(resolveCommand('git'), args, { cwd, timeout: 60000 })
      return { success: true }
    } catch (err: any) {
      const stderr: string = err.stderr || err.message
      const conflicts = (stderr.match(/CONFLICT \(content\): Merge conflict in (.+)/g) ?? [])
        .map((line: string) => line.replace('CONFLICT (content): Merge conflict in ', ''))
      return { success: false, error: stderr, conflicts }
    }
  })

  ipcMain.handle('git:mergeAbort', async (_e, cwd: string): Promise<void> => {
    await assertGitRepo(cwd)
    await execFileAsync(resolveCommand('git'), ['merge', '--abort'], { cwd, timeout: 5000 })
  })
}

function parsePorcelainBlame(output: string): Array<{
  hash: string; author: string; date: string; lineNumber: number; content: string
}> {
  const lines = output.split('\n')
  const result: Array<{ hash: string; author: string; date: string; lineNumber: number; content: string }> = []
  const commitInfo = new Map<string, { author: string; date: string }>()
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line) { i++; continue }
    const hashMatch = line.match(/^([0-9a-f]{40}) \d+ (\d+)/)
    if (!hashMatch) { i++; continue }
    const hash = hashMatch[1]
    const lineNumber = parseInt(hashMatch[2], 10)
    i++
    let author = ''
    let date = ''
    while (i < lines.length && !lines[i].startsWith('\t')) {
      const hdr = lines[i]
      if (hdr.startsWith('author ') && !hdr.startsWith('author-')) author = hdr.slice(7)
      else if (hdr.startsWith('author-time ')) {
        const ts = parseInt(hdr.slice(12), 10)
        if (!isNaN(ts)) date = new Date(ts * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
      }
      i++
    }
    const content = i < lines.length ? lines[i].slice(1) : ''
    i++
    if (author) commitInfo.set(hash, { author, date })
    const info = commitInfo.get(hash) ?? { author: 'Unknown', date: '' }
    result.push({ hash, author: info.author, date: info.date, lineNumber, content })
  }
  return result
}
