/**
 * GitHub integration — uses the `gh` CLI to fetch PR data.
 * Persists repo list and custom prompts to ~/.claude-colony/github.json.
 */

import { execFile, execSync } from 'child_process'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { JsonFile } from '../shared/json-file'
import { join } from 'path'
import { app } from 'electron'
import type { PRComment, GitHubPR, FeedbackFile, QuickPrompt, GitHubRepo } from '../shared/types'
import { resolveMustacheTemplate, parseFrontmatter } from '../shared/utils'

interface GitHubConfig {
  repos: GitHubRepo[]
  prompts: QuickPrompt[]
}

const DEFAULT_PROMPTS: QuickPrompt[] = [
  {
    id: 'summarize',
    label: 'Summarize PR',
    prompt: 'Summarize the changes in PR #{{pr.number}} ({{pr.title}}) on branch {{pr.branch}}. Give me a brief overview of what this PR does and its impact.',
    scope: 'pr',
  },
  {
    id: 'checkout',
    label: 'Checkout & Test',
    prompt: 'Checkout the branch {{pr.branch}} from PR #{{pr.number}} and run the test suite. Report any failures.',
    scope: 'pr',
  },
  {
    id: 'my-prs',
    label: 'My open PRs',
    prompt: 'Which PRs am I the author of? List them with their status and review state.',
    scope: 'global',
  },
  {
    id: 'needs-review',
    label: 'Needs my review',
    prompt: 'Which PRs need my review? Show ones where I am a requested reviewer.',
    scope: 'global',
  },
  {
    id: 'stale-prs',
    label: 'Stale PRs',
    prompt: 'Which PRs haven\'t been updated in over a week? List them sorted by last update.',
    scope: 'global',
  },
]

import { colonyPaths } from '../shared/colony-paths'
import { ensureBareRepo as ensureBareRepoWorktree } from '../shared/git-worktree'
import { getAllRepoConfigs, getRepoConfig } from './repo-config-loader'
import { gitRemoteUrl } from './settings'

const configFile = new JsonFile<GitHubConfig>(colonyPaths.githubJson, { repos: [], prompts: DEFAULT_PROMPTS })

function loadConfig(): GitHubConfig {
  const data = configFile.read()
  return {
    repos: data.repos || [],
    prompts: data.prompts || DEFAULT_PROMPTS,
  }
}

function saveConfig(config: GitHubConfig): void {
  configFile.write(config)
}

// ---- gh CLI wrapper ----

export function gh(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('gh', args, { timeout: 15000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr || err.message))
      } else {
        resolve(stdout)
      }
    })
  })
}

export async function checkGhAuth(): Promise<boolean> {
  try {
    await gh(['auth', 'status'])
    return true
  } catch {
    return false
  }
}

export async function fetchPRs(repo: GitHubRepo): Promise<GitHubPR[]> {
  const repoSlug = `${repo.owner}/${repo.name}`
  const json = await gh([
    'pr', 'list',
    '--repo', repoSlug,
    '--state', 'open',
    '--json', 'number,title,body,author,assignees,reviewRequests,headRefName,headRefOid,baseRefName,state,isDraft,url,createdAt,updatedAt,additions,deletions,reviewDecision,labels,comments',
    '--limit', '200',
  ])
  const raw = JSON.parse(json) as Array<{
    number: number
    title: string
    body: string
    author: { login: string }
    assignees: Array<{ login: string }>
    reviewRequests: Array<{ login: string } | { name: string }>
    headRefName: string
    headRefOid: string
    baseRefName: string
    state: string
    isDraft: boolean
    url: string
    createdAt: string
    updatedAt: string
    additions: number
    deletions: number
    reviewDecision: string
    labels: Array<{ name: string }>
    comments: Array<{ author: { login: string }; body: string; createdAt: string }>
  }>
  const prs: GitHubPR[] = raw.map((pr) => ({
    number: pr.number,
    title: pr.title,
    body: pr.body || '',
    author: pr.author.login,
    assignees: (pr.assignees || []).map((a) => a.login),
    reviewers: (pr.reviewRequests || []).map((r) => 'login' in r ? r.login : r.name),
    branch: pr.headRefName,
    headSha: pr.headRefOid || '',
    baseBranch: pr.baseRefName,
    state: pr.state,
    draft: pr.isDraft,
    url: pr.url,
    createdAt: pr.createdAt,
    updatedAt: pr.updatedAt,
    additions: pr.additions,
    deletions: pr.deletions,
    reviewDecision: pr.reviewDecision,
    labels: pr.labels.map((l) => l.name),
    comments: (pr.comments || []).map((c) => ({
      author: c.author.login,
      body: c.body,
      createdAt: c.createdAt,
    })),
  }))

  // Fetch review comments (file-level) in parallel for PRs that have any activity
  await Promise.allSettled(
    prs.map(async (pr) => {
      try {
        const reviewJson = await gh([
          'api', `repos/${repoSlug}/pulls/${pr.number}/comments`,
          '--jq', '.[].{author: .user.login, body: .body, createdAt: .created_at, path: .path}',
        ])
        if (!reviewJson.trim()) return
        const reviewComments: PRComment[] = reviewJson.trim().split('\n')
          .filter((l) => l.trim())
          .map((l) => {
            try {
              const c = JSON.parse(l)
              return { author: c.author, body: c.body, createdAt: c.createdAt, path: c.path }
            } catch { return null }
          })
          .filter(Boolean) as PRComment[]
        if (reviewComments.length > 0) {
          pr.comments.push(...reviewComments)
        }
      } catch { /* skip if API fails */ }
    })
  )

  // Also refresh the bare repo + .colony/ config for this repo (non-blocking)
  refreshBareRepoConfig(repo.owner, repo.name).catch(() => {})

  return prs
}

/**
 * Fetch the bare repo for a given owner/name and refresh its .colony/ config.
 * Called as a side effect of PR refresh so new templates are discovered.
 */
async function refreshBareRepoConfig(owner: string, name: string): Promise<void> {
  const bareDir = colonyPaths.bareRepoDir(owner, name)
  if (!existsSync(bareDir)) return
  try {
    execSync('git fetch origin --prune', { cwd: bareDir, timeout: 15000, stdio: 'ignore' })
  } catch { /* non-fatal */ }
  const config = getRepoConfig(bareDir, `${owner}/${name}`)
  if (config) {
    console.log(`[github] refreshed .colony/ for ${owner}/${name}: ${config.templates.length} templates`)
  }
}

// ---- GitHub User ----

let _cachedUser: string | null = null

/** Get the authenticated GitHub user's login. Cached after first call. */
export async function getGitHubUser(): Promise<string | null> {
  if (_cachedUser) return _cachedUser
  try {
    const json = await gh(['api', 'user', '--jq', '.login'])
    _cachedUser = json.trim() || null
    return _cachedUser
  } catch {
    return null
  }
}

// ---- Colony Feedback ----

/**
 * Fetch feedback files from the colony-feedback branch for a given PR.
 * Returns empty array if the branch or directory doesn't exist.
 */
export async function fetchFeedbackFiles(repo: GitHubRepo, prNumber: number): Promise<FeedbackFile[]> {
  const repoSlug = `${repo.owner}/${repo.name}`
  try {
    // List files in reviews/{prNumber}/ on the colony-feedback branch
    const listJson = await gh([
      'api', `repos/${repoSlug}/contents/reviews/${prNumber}`,
      '--jq', '.[].path',
      '-H', 'Accept: application/vnd.github.v3+json',
      '--method', 'GET',
      '-f', 'ref=colony-feedback',
    ])
    const paths = listJson.trim().split('\n').filter((p: string) => p.endsWith('.md'))
    if (paths.length === 0) return []

    const files: FeedbackFile[] = []
    for (const filePath of paths) {
      try {
        const contentJson = await gh([
          'api', `repos/${repoSlug}/contents/${filePath}`,
          '-H', 'Accept: application/vnd.github.v3+json',
          '-f', 'ref=colony-feedback',
        ])
        const parsed = JSON.parse(contentJson)
        const content = Buffer.from(parsed.content || '', 'base64').toString('utf-8')

        const frontmatter = parseFrontmatter(content)

        files.push({
          pr: prNumber,
          reviewer: frontmatter.reviewer || 'unknown',
          createdAt: frontmatter.createdAt || frontmatter.created || '',
          headSha: frontmatter.headSha || '',
          repo: repoSlug,
          branch: frontmatter.branch || '',
          content,
          path: filePath,
        })
      } catch { /* skip individual file errors */ }
    }
    return files
  } catch {
    // 404 = branch or directory doesn't exist, which is normal
    return []
  }
}

// ---- CI/CD Check Runs ----

export interface CheckRun {
  name: string
  status: string       // 'completed' | 'in_progress' | 'queued'
  conclusion: string | null  // 'success' | 'failure' | 'cancelled' | 'skipped' | 'neutral' | 'timed_out' | null
  url: string
}

export interface PRChecks {
  overall: 'success' | 'failure' | 'pending' | 'none'
  checks: CheckRun[]
}

export async function fetchChecks(repo: GitHubRepo, prNumber: number): Promise<PRChecks> {
  const repoSlug = `${repo.owner}/${repo.name}`
  try {
    const json = await gh([
      'pr', 'checks', String(prNumber),
      '--repo', repoSlug,
      '--json', 'name,state,link',
    ])
    const raw = JSON.parse(json) as Array<{
      name: string
      state: string
      link: string
    }>
    // state is directly: SUCCESS, FAILURE, PENDING, SKIPPED, CANCELLED, NEUTRAL, STARTUP_FAILURE
    const checks: CheckRun[] = raw.map((c) => {
      const s = c.state.toUpperCase()
      const done = s === 'SUCCESS' || s === 'FAILURE' || s === 'SKIPPED' || s === 'CANCELLED' || s === 'NEUTRAL' || s === 'STARTUP_FAILURE'
      return {
        name: c.name,
        status: done ? 'completed' : 'in_progress',
        conclusion: s === 'SUCCESS' ? 'success'
          : s === 'FAILURE' || s === 'STARTUP_FAILURE' ? 'failure'
          : s === 'SKIPPED' ? 'skipped'
          : s === 'CANCELLED' ? 'cancelled'
          : s === 'NEUTRAL' ? 'neutral'
          : null,
        url: c.link || '',
      }
    })
    if (checks.length === 0) return { overall: 'none', checks: [] }
    const hasFailed = checks.some((c) => c.conclusion === 'failure')
    const hasPending = checks.some((c) => c.status !== 'completed')
    const overall = hasFailed ? 'failure' : hasPending ? 'pending' : 'success'
    return { overall, checks }
  } catch {
    return { overall: 'none', checks: [] }
  }
}

export async function fetchCheckLogs(repo: GitHubRepo, prNumber: number, checkName: string): Promise<string> {
  const repoSlug = `${repo.owner}/${repo.name}`
  try {
    // Get the run ID for the failed check by looking at the PR's head SHA
    const prJson = await gh(['pr', 'view', String(prNumber), '--repo', repoSlug, '--json', 'headRefOid'])
    const { headRefOid } = JSON.parse(prJson) as { headRefOid: string }

    // List runs for the commit
    const runsJson = await gh([
      'api', `repos/${repoSlug}/commits/${headRefOid}/check-runs`,
      '--jq', `.check_runs[] | select(.name == "${checkName.replace(/"/g, '\\"')}") | {id: .id, details_url: .details_url}`,
    ])
    if (!runsJson.trim()) return `No logs found for check "${checkName}"`
    const run = JSON.parse(runsJson.trim().split('\n')[0])

    // Try to get the log via the Actions run -- this works for GitHub Actions specifically
    const logJson = await gh([
      'api', `repos/${repoSlug}/check-runs/${run.id}/annotations`,
      '--jq', '.[].message',
    ])
    if (logJson.trim()) {
      return `Check: ${checkName}\nAnnotations:\n${logJson.trim()}`
    }
    return `Check: ${checkName}\nStatus: Failed\nDetails: ${run.details_url || 'No details URL available'}\n\nNo annotation logs available. View full logs at the details URL above.`
  } catch (err: any) {
    return `Failed to fetch logs for "${checkName}": ${err.message}`
  }
}

// ---- Config CRUD ----

const REPOS_DIR = colonyPaths.repos

/**
 * Resolve repo directory — checks bare repo (.git suffix) first, then legacy paths.
 * For the GitHub panel's `localPath` reference — returns whichever exists.
 */
function resolveCloneDir(owner: string, name: string): string {
  const bareDir = colonyPaths.bareRepoDir(owner, name)
  if (existsSync(bareDir)) return bareDir
  const newPath = colonyPaths.repoDir(owner, name)
  if (existsSync(newPath)) return newPath
  const legacyPath = join(REPOS_DIR, `${owner}-${name}`)
  if (existsSync(legacyPath)) return legacyPath
  return bareDir // default to bare repo format for new repos
}

export function getRepos(): GitHubRepo[] {
  const config = loadConfig()
  let updated = false
  for (const repo of config.repos) {
    const cloneDir = resolveCloneDir(repo.owner, repo.name)
    if (!repo.localPath || !existsSync(repo.localPath)) {
      repo.localPath = cloneDir
      updated = true
    }
    ;(repo as any).cloned = existsSync(cloneDir)
  }
  if (updated) saveConfig(config)
  return config.repos
}

/**
 * Ensure all tracked repos have bare clones — call on startup.
 * Replaces the old shallow clone approach. Bare repos serve as both
 * the shared object store for worktree-based environments AND the
 * GitHub panel's reference repo.
 */
export function ensureRepoClones(): void {
  const repos = getRepos()
  for (const repo of repos) {
    const bareDir = colonyPaths.bareRepoDir(repo.owner, repo.name)
    if (!existsSync(bareDir)) {
      const remoteUrl = gitRemoteUrl(repo.owner, repo.name)
      ensureBareRepoWorktree(repo.owner, repo.name, remoteUrl).catch(err => {
        console.error(`[github] bare clone failed for ${repo.owner}/${repo.name}:`, err)
      })
    }
  }
}

export function addRepo(repo: GitHubRepo): GitHubRepo[] {
  const config = loadConfig()
  const exists = config.repos.some((r) => r.owner === repo.owner && r.name === repo.name)
  if (!exists) {
    const bareDir = colonyPaths.bareRepoDir(repo.owner, repo.name)
    repo.localPath = repo.localPath || bareDir
    config.repos.push(repo)
    saveConfig(config)

    // Create bare repo in background (don't block)
    const remoteUrl = `git@github.com:${repo.owner}/${repo.name}.git`
    ensureBareRepoWorktree(repo.owner, repo.name, remoteUrl).catch(err => {
      console.error(`[github] bare clone failed for ${repo.owner}/${repo.name}:`, err)
    })
  }
  return config.repos
}

/**
 * Ensure a bare repo exists for the given repo, creating it if needed.
 * This is the unified entry point — all repo cloning goes through bare repos now.
 */
export async function shallowCloneRepo(repo: GitHubRepo): Promise<void> {
  const remoteUrl = gitRemoteUrl(repo.owner, repo.name)
  await ensureBareRepoWorktree(repo.owner, repo.name, remoteUrl)
}

export function removeRepo(owner: string, name: string): GitHubRepo[] {
  const config = loadConfig()
  config.repos = config.repos.filter((r) => !(r.owner === owner && r.name === name))
  saveConfig(config)
  return config.repos
}

export function updateRepoPath(owner: string, name: string, localPath: string): GitHubRepo[] {
  const config = loadConfig()
  const repo = config.repos.find((r) => r.owner === owner && r.name === name)
  if (repo) {
    repo.localPath = localPath
    saveConfig(config)
  }
  return config.repos
}

const COLONY_REVIEW_PROMPT: QuickPrompt = {
  id: 'colony-review',
  label: 'Colony Feedback Review',
  prompt: `Review PR #{{pr.number}} ({{pr.title}}) on branch {{pr.branch}} in {{repo.owner}}/{{repo.name}}.

PR Description:
{{pr.description}}

Check the diff for bugs, security issues, code quality, and correctness.

When done, push your feedback to the colony-feedback branch so the author's Colony instance picks it up automatically. Follow these steps exactly:

1. Create a temp directory and clone into it:
   TMPDIR=$(mktemp -d)
   git clone --depth 1 --single-branch --branch colony-feedback {{repo.remoteUrl}} "$TMPDIR" 2>/dev/null || \\
     (git clone --depth 1 {{repo.remoteUrl}} "$TMPDIR" && cd "$TMPDIR" && git checkout -b colony-feedback)
   cd "$TMPDIR"

2. Create the feedback file with YAML frontmatter:
   mkdir -p reviews/{{pr.number}}
   Write to reviews/{{pr.number}}/review-{{reviewer}}-$(date +%Y%m%d%H%M%S).md:

   ---
   headSha: {{pr.headSha}}
   reviewer: {{reviewer}}
   createdAt: $(date -u +%Y-%m-%dT%H:%M:%SZ)
   repo: {{repo.owner}}/{{repo.name}}
   branch: {{pr.branch}}
   ---

   ## Critical
   Blocking issues (security, bugs, correctness). Use - [ ] checkboxes.

   ## Suggestions
   Improvements and best practices. Use - [ ] checkboxes.

   ## Questions
   Things that need clarification.

3. Commit and push:
   git add reviews/ && git commit -m "Colony review: PR #{{pr.number}} by {{reviewer}}" && git push origin colony-feedback

4. Clean up:
   cd - && rm -rf "$TMPDIR"`,
  scope: 'pr',
}

const BASIC_REVIEW_PROMPT: QuickPrompt = {
  id: 'review',
  label: 'Review PR',
  prompt: 'Review PR #{{pr.number}} on branch {{pr.branch}}. Check the diff for bugs, security issues, and code quality. Provide a concise summary of changes and any issues found.',
  scope: 'pr',
}

export function getPrompts(): QuickPrompt[] {
  const prompts = loadConfig().prompts

  // If user already has a review prompt (custom or saved), don't inject
  if (prompts.some(p => p.id === 'review' || p.id === 'colony-review')) {
    return prompts
  }

  // Check if Colony Feedback pipeline is enabled
  try {
    const pipelinesDir = colonyPaths.pipelines
    const feedbackFile = join(pipelinesDir, 'colony-feedback.yaml')
    if (existsSync(feedbackFile)) {
      const content = readFileSync(feedbackFile, 'utf-8')
      if (/^enabled:\s*true/m.test(content)) {
        return [COLONY_REVIEW_PROMPT, ...prompts]
      }
    }
  } catch { /* ignore */ }

  // Pipeline not enabled — use basic review prompt
  const combined = [BASIC_REVIEW_PROMPT, ...prompts]

  // Merge repo-defined prompts (from .colony/prompts/)
  try {
    const userIds = new Set(combined.map(p => p.id))
    for (const repoConfig of getAllRepoConfigs()) {
      for (const p of repoConfig.prompts) {
        if (!userIds.has(p.id)) {
          combined.push(p)
          userIds.add(p.id)
        }
      }
    }
  } catch { /* repo config loader not available */ }

  return combined
}

export function savePrompts(prompts: QuickPrompt[]): QuickPrompt[] {
  const config = loadConfig()
  config.prompts = prompts
  saveConfig(config)
  return config.prompts
}

/**
 * Writes all loaded PR data to the pr-workspace directory
 * so CLI instances can reference it via system prompt.
 */
export function writePrContext(prsByRepo: Record<string, GitHubPR[]>): string {
  getPrWorkspacePath() // ensure directory exists
  const contextPath = join(PR_WORKSPACE, 'pr-context.md')
  const lines: string[] = ['# Open Pull Requests', '', `_Last synced: ${new Date().toISOString()}_`, '']

  for (const [slug, prs] of Object.entries(prsByRepo)) {
    if (prs.length === 0) continue
    lines.push(`## ${slug}`, '')
    for (const pr of prs) {
      lines.push(`### #${pr.number}: ${pr.title}`)
      lines.push(`- **Author:** ${pr.author}`)
      lines.push(`- **Assignees:** ${pr.assignees.length > 0 ? pr.assignees.join(', ') : 'none'}`)
      lines.push(`- **Reviewers:** ${pr.reviewers.length > 0 ? pr.reviewers.join(', ') : 'none'}`)
      lines.push(`- **Branch:** ${pr.branch} → ${pr.baseBranch}`)
      lines.push(`- **Status:** ${pr.draft ? 'DRAFT' : pr.state}`)
      lines.push(`- **Review:** ${pr.reviewDecision || 'none'}`)
      lines.push(`- **Changes:** +${pr.additions} / -${pr.deletions}`)
      if (pr.labels.length > 0) lines.push(`- **Labels:** ${pr.labels.join(', ')}`)
      lines.push(`- **Updated:** ${pr.updatedAt}`)
      lines.push(`- **URL:** ${pr.url}`)
      if (pr.body) {
        const cleanBody = pr.body.replace(/<[^>]+>/g, '').trim()
        if (cleanBody) {
          lines.push('')
          lines.push('**Description:**')
          lines.push(cleanBody)
        }
      }
      // Write comments to a separate file per PR
      const commentsDir = join(PR_WORKSPACE, 'comments')
      if (!existsSync(commentsDir)) mkdirSync(commentsDir, { recursive: true })
      const safeSlug = slug.replace(/\//g, '-')
      const commentFile = join(commentsDir, `${safeSlug}-${pr.number}.md`)
      if (pr.comments && pr.comments.length > 0) {
        const commentLines = [
          `# Comments on ${slug}#${pr.number}: ${pr.title}`,
          '',
          `PR: ${pr.url}`,
          '',
        ]
        for (const c of pr.comments) {
          const cleanComment = c.body.replace(/<[^>]+>/g, '').trim()
          const fileTag = c.path ? ` (file: ${c.path})` : ' (general)'
          commentLines.push(`## ${c.author}${fileTag} — ${c.createdAt}`, '', cleanComment, '')
        }
        writeFileSync(commentFile, commentLines.join('\n'), 'utf-8')
        lines.push(`- **Comments:** ${pr.comments.length} — to read full comments: \`cat ${commentFile}\``)
      } else {
        lines.push('- **Comments:** none')
      }
      lines.push('')
    }
  }

  writeFileSync(contextPath, lines.join('\n'), 'utf-8')
  return contextPath
}

// ---- PR Workspace ----

const PR_WORKSPACE = colonyPaths.prWorkspace

// ---- PR Memory ----

const MEMORY_PATH = join(PR_WORKSPACE, 'pr-memory.md')

export function getPrMemory(): string {
  try {
    if (existsSync(MEMORY_PATH)) {
      return readFileSync(MEMORY_PATH, 'utf-8')
    }
  } catch { /* */ }
  return ''
}

export function savePrMemory(content: string): boolean {
  try {
    writeFileSync(MEMORY_PATH, content, 'utf-8')
    return true
  } catch {
    return false
  }
}

export function getPrMemoryPath(): string {
  getPrWorkspacePath() // ensure directory exists
  if (!existsSync(MEMORY_PATH)) {
    writeFileSync(MEMORY_PATH, '# PR Memory\n\nThis file stores important context learned from PR reviews and discussions.\n', 'utf-8')
  }
  return MEMORY_PATH
}

export function getPrWorkspacePath(): string {
  if (!existsSync(PR_WORKSPACE)) {
    mkdirSync(PR_WORKSPACE, { recursive: true })
  }
  return PR_WORKSPACE
}

export function resolvePrompt(prompt: QuickPrompt, pr: GitHubPR, repo: GitHubRepo): string {
  return resolveMustacheTemplate(prompt.prompt, {
    pr: {
      ...pr,
      status: pr.draft ? 'draft' : pr.state,
      description: pr.body || '',
      assignees: pr.assignees.length > 0 ? pr.assignees.join(', ') : 'none',
      reviewers: pr.reviewers.length > 0 ? pr.reviewers.join(', ') : 'none',
      labels: pr.labels.length > 0 ? pr.labels.join(', ') : 'none',
      reviewDecision: pr.reviewDecision || 'none',
    },
    repo: {
      ...repo,
      remoteUrl: gitRemoteUrl(repo.owner, repo.name),
    },
    reviewer: _cachedUser || 'unknown',
  })
}
