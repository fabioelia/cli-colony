/**
 * Prerequisites — first-run checks that surface missing external deps to the
 * Welcome modal. Each check is isolated, fast (≤3s), and never throws. Results
 * are advisory — the modal uses them to guide users, not to hard-block features.
 */

import { spawn } from 'child_process'
import { promises as fsp } from 'fs'
import { join } from 'path'
import * as os from 'os'
import type {
  PrerequisiteCheck,
  PrerequisitesStatus,
  PrerequisiteKey,
} from '../shared/types'
import { setPrerequisiteSnapshot } from './onboarding-state'

const SPAWN_TIMEOUT_MS = 3000

/**
 * Run a command with a hard timeout and return { code, stdout, stderr }. The
 * returned promise NEVER rejects — timeout or spawn errors surface as a
 * non-zero code + stderr. This keeps the prerequisite checks easy to compose.
 */
function runCommand(
  cmd: string,
  args: string[],
  timeoutMs: number = SPAWN_TIMEOUT_MS,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let settled = false
    const finalize = (r: { code: number; stdout: string; stderr: string }): void => {
      if (settled) return
      settled = true
      resolve(r)
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(cmd, args, { shell: false })
    } catch (err) {
      finalize({ code: -1, stdout: '', stderr: err instanceof Error ? err.message : String(err) })
      return
    }
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    child.stdout?.on('data', (c: Buffer) => stdoutChunks.push(c))
    child.stderr?.on('data', (c: Buffer) => stderrChunks.push(c))
    const killTimer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* noop */ }
      finalize({ code: -1, stdout: '', stderr: `timeout after ${timeoutMs}ms` })
    }, timeoutMs)
    child.on('error', (err) => {
      clearTimeout(killTimer)
      finalize({ code: -1, stdout: '', stderr: err.message })
    })
    child.on('exit', (code) => {
      clearTimeout(killTimer)
      finalize({
        code: code ?? -1,
        stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
        stderr: Buffer.concat(stderrChunks).toString('utf-8'),
      })
    })
  })
}

/**
 * Check that the `claude` CLI is on PATH and responds to `--version`. Uses a
 * 3s timeout so a broken PATH shim can never hang the modal.
 */
export async function checkClaudeCli(): Promise<PrerequisiteCheck> {
  const result = await runCommand('claude', ['--version'])
  if (result.code === 0 && result.stdout.trim()) {
    return { ok: true, detail: result.stdout.trim() }
  }
  if (result.stderr.includes('ENOENT') || result.stderr.includes('not found')) {
    return {
      ok: false,
      error: 'Not found — install with: brew install anthropic/tap/claude',
    }
  }
  if (result.stderr.includes('timeout')) {
    return {
      ok: false,
      error: 'claude --version timed out — check your PATH for a broken shim',
    }
  }
  return {
    ok: false,
    error: result.stderr.trim() || `Exited with code ${result.code}`,
  }
}

/**
 * Check that the user is authenticated with the Claude CLI by running
 * `claude auth status`, which outputs JSON with a `loggedIn` boolean.
 * Falls back gracefully if the CLI is too old to support this subcommand.
 */
export async function checkAnthropicAuth(): Promise<PrerequisiteCheck> {
  const result = await runCommand('claude', ['auth', 'status'])
  if (result.code === 0 && result.stdout.trim()) {
    try {
      const parsed = JSON.parse(result.stdout.trim())
      if (parsed.loggedIn) {
        return { ok: true, detail: parsed.email || 'authenticated' }
      }
      return { ok: false, error: 'Claude CLI installed but not signed in — run `claude` and follow the login prompt' }
    } catch {
      // Non-JSON output but exit code 0 — treat as ok
      return { ok: true, detail: result.stdout.trim().split('\n')[0] }
    }
  }
  // claude command failed entirely — CLI might be too old or missing
  if (result.stderr.includes('ENOENT') || result.stderr.includes('not found')) {
    return { ok: false, error: 'Claude CLI not found — install first (see above)' }
  }
  if (result.stderr.includes('timeout')) {
    return { ok: false, error: 'Auth check timed out — run `claude auth status` manually' }
  }
  return { ok: false, error: 'Could not check auth — run `claude auth status` manually' }
}

/**
 * Check that git is installed and `user.email` is set globally. Both are
 * required for any commit Colony makes on the user's behalf.
 */
export async function checkGitConfig(): Promise<PrerequisiteCheck> {
  const versionResult = await runCommand('git', ['--version'])
  if (versionResult.code !== 0) {
    return { ok: false, error: 'git not found — install Xcode Command Line Tools or brew install git' }
  }
  const emailResult = await runCommand('git', ['config', '--global', 'user.email'])
  const email = emailResult.stdout.trim()
  if (emailResult.code !== 0 || !email) {
    return { ok: false, error: 'git user.email not set — run: git config --global user.email "you@example.com"' }
  }
  return { ok: true, detail: email }
}

/**
 * Check for a GitHub token — either via `gh auth status` or a
 * ~/.claude/github-token.txt file. GitHub is optional, so this returns ok:false
 * with a gentle "connect later" message rather than an error.
 */
export async function checkGitHubToken(): Promise<PrerequisiteCheck> {
  const tokenFile = join(os.homedir(), '.claude', 'github-token.txt')
  try {
    const contents = (await fsp.readFile(tokenFile, 'utf-8')).trim()
    if (contents) {
      return { ok: true, detail: tokenFile }
    }
  } catch { /* fall through to gh check */ }
  const ghResult = await runCommand('gh', ['auth', 'status'])
  // `gh auth status` exits 0 when authed, non-zero when not.
  if (ghResult.code === 0) {
    // gh auth writes its status to stderr by convention.
    const firstLine = (ghResult.stderr || ghResult.stdout).split('\n').find((l) => l.trim()) || 'gh authenticated'
    return { ok: true, detail: firstLine.trim() }
  }
  return {
    ok: false,
    error: 'No GitHub token — optional. Add later in Settings > GitHub.',
  }
}

/**
 * Run every prerequisite check in parallel and write the boolean snapshot to
 * the onboarding state store. `ready` is true when the three hard requirements
 * (claude, auth, git) are all satisfied; github is optional.
 */
export async function checkAllPrerequisites(): Promise<PrerequisitesStatus> {
  const [claude, auth, git, github] = await Promise.all([
    checkClaudeCli(),
    checkAnthropicAuth(),
    checkGitConfig(),
    checkGitHubToken(),
  ])
  const status: PrerequisitesStatus = {
    claude,
    auth,
    git,
    github,
    ready: claude.ok && auth.ok && git.ok,
    checkedAt: Date.now(),
  }
  const snapshot: Record<PrerequisiteKey, boolean> = {
    claude: claude.ok,
    auth: auth.ok,
    git: git.ok,
    github: github.ok,
  }
  await setPrerequisiteSnapshot(snapshot)
  return status
}

/** @internal Test hook — exported so tests can exercise the command runner. */
export const __test = { runCommand }
