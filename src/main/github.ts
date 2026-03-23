/**
 * GitHub integration — uses the `gh` CLI to fetch PR data.
 * Persists repo list and custom prompts to ~/.claude-colony/github.json.
 */

import { execFile } from 'child_process'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'

export interface PRComment {
  author: string
  body: string
  createdAt: string
  path?: string  // file path for review comments, undefined for general comments
}

export interface GitHubPR {
  number: number
  title: string
  body: string
  author: string
  assignees: string[]
  reviewers: string[]
  branch: string
  baseBranch: string
  state: string
  draft: boolean
  url: string
  createdAt: string
  updatedAt: string
  additions: number
  deletions: number
  reviewDecision: string
  labels: string[]
  comments: PRComment[]
}

export interface QuickPrompt {
  id: string
  label: string
  prompt: string // {{pr.number}}, {{pr.branch}}, {{pr.title}}, {{pr.url}} are replaced
  scope: 'pr' | 'global' // pr = per-PR action, global = prefills ask bar
}

export interface GitHubRepo {
  owner: string
  name: string
  localPath?: string // optional local checkout path for working directory
}

interface GitHubConfig {
  repos: GitHubRepo[]
  prompts: QuickPrompt[]
}

const DEFAULT_PROMPTS: QuickPrompt[] = [
  {
    id: 'review',
    label: 'Review PR',
    prompt: 'Review PR #{{pr.number}} on branch {{pr.branch}}. Check the diff for bugs, security issues, and code quality. Provide a concise summary of changes and any issues found.',
    scope: 'pr',
  },
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

function configPath(): string {
  return join(app.getPath('home'), '.claude-colony', 'github.json')
}

function loadConfig(): GitHubConfig {
  const p = configPath()
  try {
    if (existsSync(p)) {
      const data = JSON.parse(readFileSync(p, 'utf-8'))
      return {
        repos: data.repos || [],
        prompts: data.prompts || DEFAULT_PROMPTS,
      }
    }
  } catch (err) {
    console.error('[github] failed to load config:', err)
  }
  return { repos: [], prompts: DEFAULT_PROMPTS }
}

function saveConfig(config: GitHubConfig): void {
  const p = configPath()
  writeFileSync(p, JSON.stringify(config, null, 2), 'utf-8')
}

// ---- gh CLI wrapper ----

function gh(args: string[]): Promise<string> {
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
    '--json', 'number,title,body,author,assignees,reviewRequests,headRefName,baseRefName,state,isDraft,url,createdAt,updatedAt,additions,deletions,reviewDecision,labels,comments',
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
  return raw.map((pr) => ({
    number: pr.number,
    title: pr.title,
    body: pr.body || '',
    author: pr.author.login,
    assignees: (pr.assignees || []).map((a) => a.login),
    reviewers: (pr.reviewRequests || []).map((r) => 'login' in r ? r.login : r.name),
    branch: pr.headRefName,
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
  const results = await Promise.allSettled(
    prs.map(async (pr) => {
      try {
        const reviewJson = await gh([
          'api', `repos/${repoSlug}/pulls/${pr.number}/comments`,
          '--jq', '.[].{author: .user.login, body: .body, createdAt: .created_at, path: .path}',
        ])
        if (!reviewJson.trim()) return
        // gh --jq outputs one JSON object per line
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

  return prs
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

export function getRepos(): GitHubRepo[] {
  return loadConfig().repos
}

export function addRepo(repo: GitHubRepo): GitHubRepo[] {
  const config = loadConfig()
  const exists = config.repos.some((r) => r.owner === repo.owner && r.name === repo.name)
  if (!exists) {
    config.repos.push(repo)
    saveConfig(config)
  }
  return config.repos
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

export function getPrompts(): QuickPrompt[] {
  return loadConfig().prompts
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

const PR_WORKSPACE = join(app.getPath('home'), '.claude-colony', 'pr-workspace')

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
  return prompt.prompt
    .replace(/\{\{pr\.number\}\}/g, String(pr.number))
    .replace(/\{\{pr\.branch\}\}/g, pr.branch)
    .replace(/\{\{pr\.baseBranch\}\}/g, pr.baseBranch)
    .replace(/\{\{pr\.title\}\}/g, pr.title)
    .replace(/\{\{pr\.url\}\}/g, pr.url)
    .replace(/\{\{pr\.author\}\}/g, pr.author)
    .replace(/\{\{pr\.draft\}\}/g, String(pr.draft))
    .replace(/\{\{pr\.status\}\}/g, pr.draft ? 'draft' : pr.state)
    .replace(/\{\{pr\.reviewDecision\}\}/g, pr.reviewDecision || 'none')
    .replace(/\{\{pr\.assignees\}\}/g, pr.assignees.join(', ') || 'none')
    .replace(/\{\{pr\.reviewers\}\}/g, pr.reviewers.join(', ') || 'none')
    .replace(/\{\{pr\.labels\}\}/g, pr.labels.join(', ') || 'none')
    .replace(/\{\{pr\.additions\}\}/g, String(pr.additions))
    .replace(/\{\{pr\.deletions\}\}/g, String(pr.deletions))
    .replace(/\{\{repo\.owner\}\}/g, repo.owner)
    .replace(/\{\{repo\.name\}\}/g, repo.name)
}
