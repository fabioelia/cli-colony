import { ipcMain } from 'electron'
import { execFile } from 'child_process'
import { promises as fsp } from 'fs'
import path from 'path'
import os from 'os'
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

type CommitEntry = { hash: string; subject: string; author: string; date: string; filesChanged?: number; insertions?: number; deletions?: number; parents?: string[]; refs?: string[] }

/** Parse output from `git log --format=%H%x00%s%x00%an%x00%ar --shortstat`. */
function parseLogWithStats(stdout: string): CommitEntry[] {
  const results: CommitEntry[] = []
  for (const line of stdout.trim().split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (trimmed.includes('\0')) {
      const [hash, subject, author, date] = trimmed.split('\0')
      results.push({ hash, subject, author, date })
    } else if (results.length > 0 && /\d+ files? changed/.test(trimmed)) {
      const last = results[results.length - 1]
      const fc = trimmed.match(/(\d+) files? changed/)
      const ins = trimmed.match(/(\d+) insertion/)
      const del = trimmed.match(/(\d+) deletion/)
      if (fc) last.filesChanged = parseInt(fc[1])
      if (ins) last.insertions = parseInt(ins[1])
      if (del) last.deletions = parseInt(del[1])
    }
  }
  return results
}

/** Parse `git log --format=%H%x00%s%x00%an%x00%ar%x00%P%x00%D --shortstat` (with parents + refs). */
function parseLogWithDecorations(stdout: string): CommitEntry[] {
  const results: CommitEntry[] = []
  for (const line of stdout.trim().split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (trimmed.includes('\0')) {
      const parts = trimmed.split('\0')
      const [hash, subject, author, date, parentsRaw, refsRaw] = parts
      const parents = parentsRaw ? parentsRaw.trim().split(' ').filter(Boolean) : []
      const refs = refsRaw ? refsRaw.split(',').map(r => r.trim()).filter(Boolean) : []
      results.push({ hash, subject, author, date, parents, refs })
    } else if (results.length > 0 && /\d+ files? changed/.test(trimmed)) {
      const last = results[results.length - 1]
      const fc = trimmed.match(/(\d+) files? changed/)
      const ins = trimmed.match(/(\d+) insertion/)
      const del = trimmed.match(/(\d+) deletion/)
      if (fc) last.filesChanged = parseInt(fc[1])
      if (ins) last.insertions = parseInt(ins[1])
      if (del) last.deletions = parseInt(del[1])
    }
  }
  return results
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

  ipcMain.handle('git:unstage', async (_e, cwd: string, files: string[]): Promise<void> => {
    await assertGitRepo(cwd)
    const batchSize = 50
    for (let i = 0; i < files.length; i += batchSize) {
      const batch = files.slice(i, i + batchSize)
      await execFileAsync(resolveCommand('git'), ['restore', '--staged', '--', ...batch], { cwd, timeout: 15000 })
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

  ipcMain.handle('git:log', async (_e, cwd: string, limit: number = 20, skip: number = 0, author?: string): Promise<CommitEntry[]> => {
    await assertGitRepo(cwd)
    try {
      const args = ['log', `--max-count=${limit}`, `--skip=${skip}`, '--format=%H%x00%s%x00%an%x00%ar%x00%P%x00%D', '--shortstat']
      if (author) args.push(`--author=${author}`)
      const { stdout } = await execFileAsync(resolveCommand('git'), args, { cwd, timeout: 10000, encoding: 'utf-8' })
      if (!stdout.trim()) return []
      return parseLogWithDecorations(stdout)
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

  ipcMain.handle('git:fetchRemote', async (_e, cwd: string, remote: string): Promise<{ success: boolean; error?: string }> => {
    await assertGitRepo(cwd)
    if (!/^[a-zA-Z0-9_.-]+$/.test(remote)) return { success: false, error: 'Invalid remote name' }
    try {
      await execFileAsync(resolveCommand('git'), ['fetch', remote], { cwd, timeout: 30000 })
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

  ipcMain.handle('git:branchAheadBehind', async (_e, cwd: string, branchNames: string[]): Promise<Record<string, { ahead: number; behind: number }>> => {
    await assertGitRepo(cwd)
    const result: Record<string, { ahead: number; behind: number }> = {}
    await Promise.all(branchNames.slice(0, 20).map(async (branch) => {
      try {
        const { stdout } = await execFileAsync(resolveCommand('git'), ['rev-list', '--left-right', '--count', `HEAD...${branch}`], { cwd, timeout: 5000, encoding: 'utf-8' })
        const [left, right] = stdout.trim().split('\t').map(Number)
        if (!isNaN(left) && !isNaN(right)) result[branch] = { ahead: right, behind: left }
      } catch { result[branch] = { ahead: 0, behind: 0 } }
    }))
    return result
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

  ipcMain.handle('git:renameBranch', async (_e, cwd: string, newName: string): Promise<{ success: boolean; error?: string; hasUpstream: boolean }> => {
    await assertGitRepo(cwd)
    try {
      await execFileAsync(resolveCommand('git'), ['branch', '-m', newName], { cwd, timeout: 5000 })
      // Check if the old branch had a remote tracking branch
      let hasUpstream = false
      try {
        const { stdout } = await execFileAsync(resolveCommand('git'), ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { cwd, timeout: 3000 })
        hasUpstream = stdout.trim().length > 0
      } catch { /* no upstream */ }
      return { success: true, hasUpstream }
    } catch (err: any) {
      return { success: false, error: err.stderr || err.message, hasUpstream: false }
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

  // --- General tag operations ---

  ipcMain.handle('git:listAllTags', async (_e, cwd: string): Promise<Array<{ tag: string; date: string; hash: string }>> => {
    await assertGitRepo(cwd)
    try {
      const { stdout } = await execFileAsync(resolveCommand('git'), [
        'tag', '--sort=-creatordate',
        '--format=%(refname:short)|%(creatordate:iso-strict)|%(objectname:short)',
      ], { cwd, timeout: 5000, encoding: 'utf-8' })
      if (!stdout.trim()) return []
      return stdout.trim().split('\n').map(line => {
        const [tag, date, hash] = line.split('|')
        return { tag, date: date?.slice(0, 10) ?? '', hash: hash?.slice(0, 7) ?? '' }
      })
    } catch {
      return []
    }
  })

  ipcMain.handle('git:createGeneralTag', async (_e, cwd: string, tagName: string, message?: string): Promise<void> => {
    await assertGitRepo(cwd)
    if (!tagName.trim()) throw new Error('Tag name is required')
    const args = message?.trim()
      ? ['tag', '-a', tagName, '-m', message.trim()]
      : ['tag', tagName]
    await execFileAsync(resolveCommand('git'), args, { cwd, timeout: 5000 })
  })

  ipcMain.handle('git:deleteGeneralTag', async (_e, cwd: string, tagName: string): Promise<void> => {
    await assertGitRepo(cwd)
    if (!tagName.trim()) throw new Error('Tag name is required')
    await execFileAsync(resolveCommand('git'), ['tag', '-d', tagName], { cwd, timeout: 5000 })
  })

  ipcMain.handle('git:pushTag', async (_e, cwd: string, tagName: string): Promise<void> => {
    await assertGitRepo(cwd)
    if (!tagName.trim()) throw new Error('Tag name is required')
    await execFileAsync(resolveCommand('git'), ['push', 'origin', tagName], { cwd, timeout: 30000 })
  })

  ipcMain.handle('git:diffRange', async (_e, cwd: string, from: string, to?: string, ignoreWhitespace?: boolean): Promise<{ stat: string; diff: string }> => {
    await assertGitRepo(cwd)
    // Validate refs — allow tag-like paths and hex hashes
    const refPattern = /^[a-zA-Z0-9_./:Z-]+$/
    if (!refPattern.test(from)) throw new Error('Invalid "from" ref')
    if (to && !refPattern.test(to)) throw new Error('Invalid "to" ref')
    const range = to ? `${from}..${to}` : `${from}..HEAD`
    const wsFlag = ignoreWhitespace ? ['-w'] : []
    const [statResult, diffResult] = await Promise.all([
      execFileAsync(resolveCommand('git'), ['diff', range, '--stat'], {
        cwd, timeout: 15000, encoding: 'utf-8', maxBuffer: 5 * 1024 * 1024,
      }),
      execFileAsync(resolveCommand('git'), ['diff', range, ...wsFlag], {
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

  ipcMain.handle('git:diffRangeFile', async (_e, cwd: string, from: string, to: string, file: string): Promise<string> => {
    await assertGitRepo(cwd)
    const refPattern = /^[a-zA-Z0-9_./:Z^-]+$/
    if (!refPattern.test(from)) throw new Error('Invalid "from" ref')
    if (!refPattern.test(to)) throw new Error('Invalid "to" ref')
    const { stdout } = await execFileAsync(resolveCommand('git'), [
      'diff', `${from}..${to}`, '--', file,
    ], { cwd, timeout: 15000, encoding: 'utf-8', maxBuffer: 5 * 1024 * 1024 })
    return stdout
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

  ipcMain.handle('git:resetSoft', async (_e, cwd: string, targetHash: string): Promise<void> => {
    await assertGitRepo(cwd)
    if (!/^[0-9a-f]{4,40}$/i.test(targetHash)) throw new Error('Invalid commit hash')
    await execFileAsync(resolveCommand('git'), ['reset', '--soft', targetHash], { cwd, timeout: 10000 })
  })

  ipcMain.handle('git:reflog', async (_e, cwd: string, limit = 20, skip = 0): Promise<Array<{ hash: string; ref: string; action: string; relativeTime: string }>> => {
    await assertGitRepo(cwd)
    try {
      const { stdout } = await execFileAsync(resolveCommand('git'), [
        'reflog', `--format=%H\t%gd\t%gs\t%cr`, `-n`, String(limit), `--skip=${skip}`
      ], { cwd, timeout: 10000 })
      return stdout.trim().split('\n').filter(Boolean).map(line => {
        const parts = line.split('\t')
        return { hash: parts[0] ?? '', ref: parts[1] ?? '', action: parts[2] ?? '', relativeTime: parts[3] ?? '' }
      })
    } catch {
      return []
    }
  })

  ipcMain.handle('git:resetHard', async (_e, cwd: string, hash: string): Promise<void> => {
    await assertGitRepo(cwd)
    if (!/^[0-9a-f]{4,40}$/i.test(hash)) throw new Error('Invalid commit hash')
    await execFileAsync(resolveCommand('git'), ['reset', '--hard', hash], { cwd, timeout: 10000 })
  })

  ipcMain.handle('git:remoteList', async (_e, cwd: string): Promise<Array<{ name: string; fetchUrl: string; pushUrl: string }>> => {
    await assertGitRepo(cwd)
    try {
      const { stdout } = await execFileAsync(resolveCommand('git'), ['remote', '-v'], { cwd, timeout: 10000 })
      const map = new Map<string, { fetchUrl: string; pushUrl: string }>()
      for (const line of stdout.trim().split('\n').filter(Boolean)) {
        const m = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/)
        if (!m) continue
        const [, name, url, type] = m
        const entry = map.get(name) ?? { fetchUrl: '', pushUrl: '' }
        if (type === 'fetch') entry.fetchUrl = url; else entry.pushUrl = url
        map.set(name, entry)
      }
      return Array.from(map.entries()).map(([name, urls]) => ({ name, ...urls }))
    } catch {
      return []
    }
  })

  ipcMain.handle('git:remoteAdd', async (_e, cwd: string, name: string, url: string): Promise<{ success: boolean; error?: string }> => {
    await assertGitRepo(cwd)
    if (!/^[a-zA-Z0-9_.-]+$/.test(name)) return { success: false, error: 'Invalid remote name' }
    try {
      await execFileAsync(resolveCommand('git'), ['remote', 'add', name, url], { cwd, timeout: 10000 })
      try { await execFileAsync(resolveCommand('git'), ['fetch', name], { cwd, timeout: 30000 }) } catch {}
      return { success: true }
    } catch (e: any) {
      return { success: false, error: e.message?.split('\n')[0] ?? 'Failed to add remote' }
    }
  })

  ipcMain.handle('git:remoteRemove', async (_e, cwd: string, name: string): Promise<{ success: boolean; error?: string }> => {
    await assertGitRepo(cwd)
    if (!/^[a-zA-Z0-9_.-]+$/.test(name)) return { success: false, error: 'Invalid remote name' }
    try {
      await execFileAsync(resolveCommand('git'), ['remote', 'remove', name], { cwd, timeout: 10000 })
      return { success: true }
    } catch (e: any) {
      return { success: false, error: e.message?.split('\n')[0] ?? 'Failed to remove remote' }
    }
  })

  ipcMain.handle('git:stashPush', async (_e, cwd: string, message?: string, files?: string[]): Promise<void> => {
    await assertGitRepo(cwd)
    const args = ['stash', 'push']
    if (!files || files.length === 0) args.push('--include-untracked')
    if (message) args.push('-m', message)
    if (files && files.length > 0) args.push('--', ...files)
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

  ipcMain.handle('git:stashFileDiff', async (_e, cwd: string, index: number, file: string): Promise<string> => {
    await assertGitRepo(cwd)
    if (!Number.isInteger(index) || index < 0) throw new Error('Invalid stash index')
    if (/[;&|`$]/.test(file)) throw new Error('Invalid file path')
    try {
      const { stdout } = await execFileAsync(resolveCommand('git'), ['stash', 'show', '-p', `stash@{${index}}`, '--', file], { cwd, timeout: 10000, encoding: 'utf-8', maxBuffer: 5 * 1024 * 1024 })
      return stdout
    } catch { return '' }
  })

  ipcMain.handle('git:fileLog', async (_e, cwd: string, filePath: string, limit: number = 20, skip: number = 0): Promise<CommitEntry[]> => {
    await assertGitRepo(cwd)
    if (/[;&|`$]/.test(filePath)) throw new Error('Invalid file path')
    try {
      const { stdout } = await execFileAsync(resolveCommand('git'), [
        'log', '--follow', `--max-count=${limit}`, `--skip=${skip}`, '--format=%H%x00%s%x00%an%x00%ar', '--shortstat', '--', filePath,
      ], { cwd, timeout: 10000, encoding: 'utf-8' })
      if (!stdout.trim()) return []
      return parseLogWithStats(stdout)
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

  ipcMain.handle('git:mergePreview', async (_e, cwd: string, branch: string): Promise<{
    files: Array<{ file: string; insertions: number; deletions: number }>;
    totalInsertions: number;
    totalDeletions: number;
    fastForward: boolean;
  }> => {
    await assertGitRepo(cwd)
    try {
      // Fast-forward check
      let fastForward = false
      try {
        await execFileAsync(resolveCommand('git'), ['merge-base', '--is-ancestor', 'HEAD', branch], { cwd, timeout: 5000 })
        fastForward = true
      } catch { /* not FF */ }

      // Get diff stats
      const { stdout } = await execFileAsync(resolveCommand('git'), ['diff', '--stat', `HEAD...${branch}`], { cwd, timeout: 10000, encoding: 'utf-8' })
      const lines = stdout.split('\n').filter(Boolean)
      const files: Array<{ file: string; insertions: number; deletions: number }> = []
      let totalInsertions = 0
      let totalDeletions = 0

      for (const line of lines) {
        // Skip summary line like "3 files changed, 42 insertions(+), 18 deletions(-)"
        if (/\d+ files? changed/.test(line)) {
          const insM = line.match(/(\d+) insertion/)
          const delM = line.match(/(\d+) deletion/)
          if (insM) totalInsertions = parseInt(insM[1])
          if (delM) totalDeletions = parseInt(delM[1])
          continue
        }
        // File lines: " filename | N +++--"
        const m = line.match(/^\s+(.+?)\s+\|\s+(\d+)/)
        if (m) {
          const plusCount = (line.match(/\+/g) || []).length
          const minusCount = (line.match(/-/g) || []).length
          files.push({ file: m[1].trim(), insertions: plusCount, deletions: minusCount })
        }
      }
      return { files, totalInsertions, totalDeletions, fastForward }
    } catch { return { files: [], totalInsertions: 0, totalDeletions: 0, fastForward: false } }
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

  ipcMain.handle('git:revert', async (_e, cwd: string, hash: string): Promise<{ success: boolean; error?: string }> => {
    await assertGitRepo(cwd)
    if (!/^[0-9a-f]{7,40}$/i.test(hash)) throw new Error('Invalid commit hash')
    try {
      await execFileAsync(resolveCommand('git'), ['revert', '--no-edit', hash], { cwd, timeout: 30000 })
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.stderr || err.message }
    }
  })

  ipcMain.handle('git:revertAbort', async (_e, cwd: string): Promise<void> => {
    await assertGitRepo(cwd)
    await execFileAsync(resolveCommand('git'), ['revert', '--abort'], { cwd, timeout: 5000 })
  })

  ipcMain.handle('git:conflictState', async (_e, cwd: string): Promise<{
    state: 'none' | 'merge' | 'cherry-pick' | 'revert' | 'rebase'
    conflictedFiles: string[]
  }> => {
    await assertGitRepo(cwd)
    const { stdout: gitDir } = await execFileAsync(resolveCommand('git'), ['rev-parse', '--git-dir'], { cwd, timeout: 5000, encoding: 'utf-8' })
    const dir = gitDir.trim()
    const resolvedDir = path.isAbsolute(dir) ? dir : path.join(cwd, dir)
    // Check rebase first (rebase-merge or rebase-apply directories)
    let state: 'none' | 'merge' | 'cherry-pick' | 'revert' | 'rebase' = 'none'
    for (const rebDir of ['rebase-merge', 'rebase-apply']) {
      try {
        await fsp.access(path.join(resolvedDir, rebDir))
        state = 'rebase'
        break
      } catch { /* not found */ }
    }
    if (state === 'none') {
      for (const [file, label] of [['MERGE_HEAD', 'merge'], ['CHERRY_PICK_HEAD', 'cherry-pick'], ['REVERT_HEAD', 'revert']] as const) {
        try {
          await fsp.access(path.join(resolvedDir, file))
          state = label
          break
        } catch { /* not found */ }
      }
    }
    if (state === 'none') return { state: 'none', conflictedFiles: [] }
    const { stdout } = await execFileAsync(resolveCommand('git'), ['diff', '--name-only', '--diff-filter=U'], { cwd, timeout: 5000, encoding: 'utf-8' })
    const conflictedFiles = stdout.trim() ? stdout.trim().split('\n') : []
    return { state, conflictedFiles }
  })

  ipcMain.handle('git:rebase', async (_e, cwd: string, ontoBranch: string): Promise<{ success: boolean; error?: string; conflicts?: string[] }> => {
    await assertGitRepo(cwd)
    try {
      await execFileAsync(resolveCommand('git'), ['rebase', ontoBranch], { cwd, timeout: 30000, encoding: 'utf-8' })
      return { success: true }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      const conflictMatch = msg.match(/CONFLICT[^:]*:\s*(.+)/g)
      const conflicts = conflictMatch ? conflictMatch.map(l => l.replace(/CONFLICT[^:]*:\s*/, '').trim()) : undefined
      return { success: false, error: msg.split('\n')[0], conflicts }
    }
  })

  ipcMain.handle('git:rebaseAbort', async (_e, cwd: string): Promise<void> => {
    await assertGitRepo(cwd)
    await execFileAsync(resolveCommand('git'), ['rebase', '--abort'], { cwd, timeout: 10000 })
  })

  ipcMain.handle('git:rebaseContinue', async (_e, cwd: string): Promise<{ success: boolean; error?: string }> => {
    await assertGitRepo(cwd)
    try {
      await execFileAsync(resolveCommand('git'), ['rebase', '--continue'], { cwd, timeout: 30000, env: { ...process.env, GIT_EDITOR: 'true' } })
      return { success: true }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return { success: false, error: msg.split('\n')[0] }
    }
  })

  ipcMain.handle('git:rebaseInteractive', async (_e, cwd: string, base: string, todoItems: Array<{ action: 'pick' | 'reword' | 'squash' | 'fixup' | 'drop'; hash: string; subject: string; message?: string }>): Promise<{ success: boolean; error?: string; conflicts?: string[] }> => {
    await assertGitRepo(cwd)
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const tmpDir = os.tmpdir()
    const todoFile = path.join(tmpDir, `colony-rebase-todo-${id}`)
    const seqScript = path.join(tmpDir, `colony-seq-editor-${id}.sh`)
    const counterFile = path.join(tmpDir, `colony-reword-counter-${id}`)
    const msgFiles: string[] = []
    const cleanupFiles: string[] = [todoFile, seqScript, counterFile]

    try {
      const todoLines = todoItems.map(item => `${item.action} ${item.hash.slice(0, 7)} ${item.subject}`).join('\n')
      await fsp.writeFile(todoFile, todoLines + '\n', 'utf-8')
      await fsp.writeFile(seqScript, `#!/bin/sh\ncp "${todoFile}" "$1"\n`, 'utf-8')
      await fsp.chmod(seqScript, 0o755)

      const rewordItems = todoItems.filter(i => i.action === 'reword' && i.message)
      let editorScript: string | undefined
      if (rewordItems.length > 0) {
        for (let i = 0; i < rewordItems.length; i++) {
          const msgFile = path.join(tmpDir, `colony-reword-msg-${id}-${i}`)
          await fsp.writeFile(msgFile, rewordItems[i].message!, 'utf-8')
          msgFiles.push(msgFile)
          cleanupFiles.push(msgFile)
        }
        editorScript = path.join(tmpDir, `colony-editor-${id}.sh`)
        cleanupFiles.push(editorScript)
        await fsp.writeFile(editorScript, `#!/bin/sh\nN=$(cat "${counterFile}" 2>/dev/null || echo 0)\ncp "${path.join(tmpDir, `colony-reword-msg-${id}-`)}\${N}" "$1"\necho $((N+1)) > "${counterFile}"\n`, 'utf-8')
        await fsp.chmod(editorScript, 0o755)
      }

      const env: Record<string, string> = { ...process.env as Record<string, string>, GIT_SEQUENCE_EDITOR: seqScript }
      if (editorScript) env.GIT_EDITOR = editorScript

      await execFileAsync(resolveCommand('git'), ['rebase', '-i', base], { cwd, timeout: 60000, encoding: 'utf-8', env })
      return { success: true }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      const conflictMatch = msg.match(/CONFLICT[^:]*:\s*(.+)/g)
      const conflicts = conflictMatch ? conflictMatch.map(l => l.replace(/CONFLICT[^:]*:\s*/, '').trim()) : undefined
      return { success: false, error: msg.split('\n')[0], conflicts }
    } finally {
      await Promise.all(cleanupFiles.map(f => fsp.unlink(f).catch(() => {})))
    }
  })

  ipcMain.handle('git:resolveConflict', async (_e, cwd: string, file: string, strategy: 'ours' | 'theirs'): Promise<void> => {
    await assertGitRepo(cwd)
    await execFileAsync(resolveCommand('git'), ['checkout', `--${strategy}`, '--', file], { cwd, timeout: 10000 })
    await execFileAsync(resolveCommand('git'), ['add', '--', file], { cwd, timeout: 10000 })
  })

  ipcMain.handle('git:markResolved', async (_e, cwd: string, file: string): Promise<void> => {
    await assertGitRepo(cwd)
    await execFileAsync(resolveCommand('git'), ['add', '--', file], { cwd, timeout: 10000 })
  })

  ipcMain.handle('git:completeConflictOp', async (_e, cwd: string): Promise<{ success: boolean; error?: string }> => {
    await assertGitRepo(cwd)
    try {
      await execFileAsync(resolveCommand('git'), ['commit', '--no-edit'], { cwd, timeout: 30000 })
      return { success: true }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return { success: false, error: msg }
    }
  })

  ipcMain.handle('git:searchCommits', async (_e, cwd: string, query: string, limit: number = 20, author?: string): Promise<CommitEntry[]> => {
    await assertGitRepo(cwd)
    if (!query.trim() && !author) return []
    const args = ['log', '--all', `--max-count=${limit}`, '--format=%H%x00%s%x00%an%x00%ar', '--shortstat']
    if (query.trim()) args.push(`--grep=${query}`, '-i')
    if (author) args.push(`--author=${author}`)
    const { stdout } = await execFileAsync(resolveCommand('git'), args, { cwd, timeout: 10000, encoding: 'utf-8' })
    if (!stdout.trim()) return []
    return parseLogWithStats(stdout)
  })

  ipcMain.handle('git:commitFiles', async (_e, cwd: string, hash: string): Promise<Array<{ file: string; status: string; insertions: number; deletions: number }>> => {
    await assertGitRepo(cwd)
    if (!/^[a-f0-9]{4,40}$/.test(hash)) throw new Error('Invalid hash')
    try {
      const parentArg = hash + '^1'
      const [nameStatus, numStat] = await Promise.all([
        execFileAsync(resolveCommand('git'), ['diff', '--name-status', parentArg, hash], { cwd, timeout: 5000, encoding: 'utf-8' }).catch(() =>
          execFileAsync(resolveCommand('git'), ['diff-tree', '--root', '--no-commit-id', '-r', '--name-status', hash], { cwd, timeout: 5000, encoding: 'utf-8' })
        ),
        execFileAsync(resolveCommand('git'), ['diff', '--numstat', parentArg, hash], { cwd, timeout: 5000, encoding: 'utf-8' }).catch(() =>
          execFileAsync(resolveCommand('git'), ['diff-tree', '--root', '--no-commit-id', '-r', '--numstat', hash], { cwd, timeout: 5000, encoding: 'utf-8' })
        ),
      ])
      const statsMap = new Map<string, { ins: number; del: number }>()
      for (const line of numStat.stdout.split('\n')) {
        const parts = line.split('\t')
        if (parts.length >= 3) {
          const ins = parseInt(parts[0]) || 0
          const del = parseInt(parts[1]) || 0
          const file = parts[2].trim()
          if (file) statsMap.set(file, { ins, del })
        }
      }
      const result: Array<{ file: string; status: string; insertions: number; deletions: number }> = []
      for (const line of nameStatus.stdout.split('\n')) {
        if (!line.trim()) continue
        const parts = line.split('\t')
        const status = parts[0].charAt(0)
        const file = parts[parts.length - 1].trim()
        if (!file) continue
        const stats = statsMap.get(file) ?? { ins: 0, del: 0 }
        result.push({ file, status, insertions: stats.ins, deletions: stats.del })
      }
      return result
    } catch { return [] }
  })

  ipcMain.handle('git:addToGitignore', async (_e, cwd: string, filePath: string, tracked: boolean): Promise<{ success: boolean; error?: string }> => {
    await assertGitRepo(cwd)
    const gitignorePath = path.join(cwd, '.gitignore')
    let existing = ''
    try { existing = await fsp.readFile(gitignorePath, 'utf-8') } catch { /* file not found */ }
    const patterns = existing.split('\n').map(l => l.trim()).filter(Boolean)
    let pattern = filePath
    try {
      const stat = await fsp.stat(path.join(cwd, filePath))
      if (stat.isDirectory()) pattern = filePath + '/'
    } catch { /* file may not exist */ }
    if (patterns.includes(pattern) || patterns.includes(pattern.replace(/\/$/, ''))) {
      return { success: true }
    }
    try {
      if (tracked) {
        await execFileAsync(resolveCommand('git'), ['rm', '--cached', filePath], { cwd, timeout: 10000 })
      }
      const newContent = existing.endsWith('\n') || existing === ''
        ? existing + pattern + '\n'
        : existing + '\n' + pattern + '\n'
      await fsp.writeFile(gitignorePath, newContent, 'utf-8')
      return { success: true }
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('git:stageHunk', async (_e, cwd: string, patch: string): Promise<{ success: boolean; error?: string }> => {
    await assertGitRepo(cwd)
    const tmpFile = path.join(os.tmpdir(), `colony-hunk-${Date.now()}-${Math.random().toString(36).slice(2)}.patch`)
    try {
      await fsp.writeFile(tmpFile, patch, 'utf-8')
      await execFileAsync(resolveCommand('git'), ['apply', '--cached', tmpFile], { cwd, timeout: 10000 })
      return { success: true }
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    } finally {
      await fsp.unlink(tmpFile).catch(() => {})
    }
  })

  ipcMain.handle('git:discardHunk', async (_e, cwd: string, patch: string): Promise<{ success: boolean; error?: string }> => {
    await assertGitRepo(cwd)
    const tmpFile = path.join(os.tmpdir(), `colony-hunk-${Date.now()}-${Math.random().toString(36).slice(2)}.patch`)
    try {
      await fsp.writeFile(tmpFile, patch, 'utf-8')
      await execFileAsync(resolveCommand('git'), ['apply', '--reverse', tmpFile], { cwd, timeout: 10000 })
      return { success: true }
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    } finally {
      await fsp.unlink(tmpFile).catch(() => {})
    }
  })

  ipcMain.handle('git:bisectStart', async (_e, cwd: string, badHash: string, goodHash: string): Promise<{ success: boolean; current?: string; remaining?: number; error?: string }> => {
    await assertGitRepo(cwd)
    try {
      const { stdout } = await execFileAsync(resolveCommand('git'), ['bisect', 'start', badHash, goodHash], { cwd, timeout: 15000, encoding: 'utf-8' })
      const remaining = parseInt((stdout.match(/Bisecting:\s*(\d+)\s*revision/) ?? [])[1] ?? '0', 10)
      const { stdout: cur } = await execFileAsync(resolveCommand('git'), ['rev-parse', 'HEAD'], { cwd, timeout: 5000, encoding: 'utf-8' })
      return { success: true, current: cur.trim(), remaining }
    } catch (err: unknown) {
      await execFileAsync(resolveCommand('git'), ['bisect', 'reset'], { cwd, timeout: 5000 }).catch(() => {})
      return { success: false, error: err instanceof Error ? err.message.split('\n')[0] : String(err) }
    }
  })

  ipcMain.handle('git:bisectMark', async (_e, cwd: string, verdict: 'good' | 'bad'): Promise<{ done: boolean; current?: string; remaining?: number; firstBad?: string; firstBadSubject?: string }> => {
    await assertGitRepo(cwd)
    try {
      const { stdout } = await execFileAsync(resolveCommand('git'), ['bisect', verdict], { cwd, timeout: 15000, encoding: 'utf-8' })
      // Done if output contains "first bad commit"
      const firstBadMatch = stdout.match(/^([0-9a-f]{40})\s/m)
      if (firstBadMatch && stdout.includes('first bad commit')) {
        const firstBad = firstBadMatch[1]
        const { stdout: subj } = await execFileAsync(resolveCommand('git'), ['log', '-1', '--format=%s', firstBad], { cwd, timeout: 5000, encoding: 'utf-8' }).catch(() => ({ stdout: '' }))
        return { done: true, firstBad, firstBadSubject: subj.trim() }
      }
      const remaining = parseInt((stdout.match(/Bisecting:\s*(\d+)\s*revision/) ?? [])[1] ?? '0', 10)
      const { stdout: cur } = await execFileAsync(resolveCommand('git'), ['rev-parse', 'HEAD'], { cwd, timeout: 5000, encoding: 'utf-8' })
      return { done: false, current: cur.trim(), remaining }
    } catch (err: unknown) {
      return { done: false, remaining: 0, current: undefined }
    }
  })

  ipcMain.handle('git:bisectReset', async (_e, cwd: string): Promise<void> => {
    await assertGitRepo(cwd)
    await execFileAsync(resolveCommand('git'), ['bisect', 'reset'], { cwd, timeout: 10000 }).catch(() => {})
  })

  ipcMain.handle('git:bisectLog', async (_e, cwd: string): Promise<string> => {
    await assertGitRepo(cwd)
    try {
      const { stdout } = await execFileAsync(resolveCommand('git'), ['bisect', 'log'], { cwd, timeout: 5000, encoding: 'utf-8' })
      return stdout
    } catch { return '' }
  })

  ipcMain.handle('git:dirtyFileCount', async (_e, cwd: string): Promise<{ count: number }> => {
    try {
      await assertGitRepo(cwd)
      const { stdout } = await execFileAsync(resolveCommand('git'), ['status', '--porcelain', '-uno'], { cwd, timeout: 5000, encoding: 'utf-8' })
      const count = stdout.split('\n').filter(l => l.trim().length > 0).length
      return { count }
    } catch { return { count: 0 } }
  })

  ipcMain.handle('git:changedFiles', async (_e, cwd: string): Promise<Array<{ file: string; status: string; staged: boolean }>> => {
    try {
      await assertGitRepo(cwd)
      const { stdout } = await execFileAsync(resolveCommand('git'), ['status', '--porcelain'], { cwd, timeout: 5000, encoding: 'utf-8' })
      const files: Array<{ file: string; status: string; staged: boolean }> = []
      for (const line of stdout.split('\n')) {
        if (line.length < 3) continue
        const x = line[0]  // index status
        const y = line[1]  // worktree status
        let file = line.slice(3)
        // Handle renamed: "R100 old -> new" or "R old\tnew"
        if (x === 'R' || y === 'R') {
          const tabIdx = file.indexOf('\t')
          if (tabIdx >= 0) file = file.slice(tabIdx + 1) // use new name
        }
        if (x !== ' ' && x !== '?') {
          files.push({ file, status: x, staged: true })
        }
        if (y !== ' ' && y !== '?') {
          files.push({ file, status: y, staged: false })
        }
        if (x === '?' && y === '?') {
          files.push({ file, status: '?', staged: false })
        }
      }
      return files
    } catch { return [] }
  })

  ipcMain.handle('git:aheadBehindCommits', async (_e, cwd: string, branch: string): Promise<{ ahead: Array<{ hash: string; subject: string }>; behind: Array<{ hash: string; subject: string }> }> => {
    await assertGitRepo(cwd)
    const parseOneline = (stdout: string) => stdout.trim().split('\n').filter(Boolean).map(line => {
      const sp = line.indexOf(' ')
      return { hash: sp > 0 ? line.slice(0, sp) : line, subject: sp > 0 ? line.slice(sp + 1) : '' }
    })
    try {
      const [aheadOut, behindOut] = await Promise.all([
        execFileAsync(resolveCommand('git'), ['log', '--oneline', `--max-count=50`, `origin/${branch}..${branch}`], { cwd, timeout: 5000, encoding: 'utf-8' }).catch(() => ({ stdout: '' })),
        execFileAsync(resolveCommand('git'), ['log', '--oneline', `--max-count=50`, `${branch}..origin/${branch}`], { cwd, timeout: 5000, encoding: 'utf-8' }).catch(() => ({ stdout: '' })),
      ])
      return { ahead: parseOneline(aheadOut.stdout), behind: parseOneline(behindOut.stdout) }
    } catch { return { ahead: [], behind: [] } }
  })

  ipcMain.handle('git:exportPatch', async (_e, cwd: string, mode: 'working' | 'base' | 'commit', options?: { baseBranch?: string; hash?: string; file?: string }): Promise<string> => {
    await assertGitRepo(cwd)
    const fileArg = options?.file ? ['--', options.file] : []
    try {
      if (mode === 'commit' && options?.hash) {
        const { stdout } = await execFileAsync(resolveCommand('git'), ['format-patch', '-1', options.hash, '--stdout', ...fileArg], { cwd, timeout: 10000, encoding: 'utf-8' })
        return stdout
      } else if (mode === 'base' && options?.baseBranch) {
        const { stdout } = await execFileAsync(resolveCommand('git'), ['diff', `${options.baseBranch}...HEAD`, ...fileArg], { cwd, timeout: 10000, encoding: 'utf-8' })
        return stdout
      } else {
        const [staged, unstaged] = await Promise.all([
          execFileAsync(resolveCommand('git'), ['diff', '--cached', ...fileArg], { cwd, timeout: 10000, encoding: 'utf-8' }).catch(() => ({ stdout: '' })),
          execFileAsync(resolveCommand('git'), ['diff', ...fileArg], { cwd, timeout: 10000, encoding: 'utf-8' }).catch(() => ({ stdout: '' })),
        ])
        return staged.stdout + unstaged.stdout
      }
    } catch (err: any) { throw new Error(err?.message ?? 'Failed to export patch') }
  })

  ipcMain.handle('git:savePatch', async (_e, content: string, defaultFilename: string): Promise<{ saved: boolean; path?: string }> => {
    const { dialog } = await import('electron')
    const result = await dialog.showSaveDialog({
      defaultPath: defaultFilename,
      filters: [{ name: 'Patch files', extensions: ['patch'] }, { name: 'All files', extensions: ['*'] }],
    })
    if (result.canceled || !result.filePath) return { saved: false }
    await fsp.writeFile(result.filePath, content, 'utf-8')
    return { saved: true, path: result.filePath }
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
