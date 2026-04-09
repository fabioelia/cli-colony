/**
 * Prerequisites — first-run checks that surface missing external deps to the
 * Welcome modal. Each check is isolated, fast (≤3s), and never throws. Results
 * are advisory — the modal uses them to guide users, not to hard-block features.
 */

import { spawn } from 'child_process'
import { existsSync, readFileSync } from 'fs'
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
 * Check that an Anthropic auth config exists. Claude CLI stores credentials in
 * ~/.claude/config.json (or ~/.claude/.credentials.json on newer builds). We
 * accept either as proof of auth setup — parsing the contents is deliberately
 * skipped because the shape is not public API.
 */
export function checkAnthropicAuth(): PrerequisiteCheck {
  const home = os.homedir()
  const candidates = [
    join(home, '.claude', 'config.json'),
    join(home, '.claude', '.credentials.json'),
  ]
  for (const p of candidates) {
    if (existsSync(p)) {
      try {
        JSON.parse(readFileSync(p, 'utf-8'))
        return { ok: true, detail: p }
      } catch {
        // File exists but isn't valid JSON — still treat as a signal the user
        // has started Claude CLI at least once, but surface a warning.
        return { ok: true, detail: `${p} (unparseable, may need refresh)` }
      }
    }
  }
  return {
    ok: false,
    error: 'No Claude config at ~/.claude/config.json — run `claude` once to sign in',
  }
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
  if (existsSync(tokenFile)) {
    try {
      const contents = readFileSync(tokenFile, 'utf-8').trim()
      if (contents) {
        return { ok: true, detail: tokenFile }
      }
    } catch { /* fall through to gh check */ }
  }
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
  const [claude, git, github] = await Promise.all([
    checkClaudeCli(),
    checkGitConfig(),
    checkGitHubToken(),
  ])
  const auth = checkAnthropicAuth()
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
  setPrerequisiteSnapshot(snapshot)
  return status
}

/** @internal Test hook — exported so tests can exercise the command runner. */
export const __test = { runCommand }
