/**
 * GitHub integration — uses the `gh` CLI to fetch PR data.
 * Persists repo list and custom prompts to ~/.claude-colony/github.json.
 */

import { execFile } from 'child_process'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'

export interface GitHubPR {
  number: number
  title: string
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
}

export interface QuickPrompt {
  id: string
  label: string
  prompt: string // {{pr.number}}, {{pr.branch}}, {{pr.title}}, {{pr.url}} are replaced
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
  },
  {
    id: 'summarize',
    label: 'Summarize PR',
    prompt: 'Summarize the changes in PR #{{pr.number}} ({{pr.title}}) on branch {{pr.branch}}. Give me a brief overview of what this PR does and its impact.',
  },
  {
    id: 'checkout',
    label: 'Checkout & Test',
    prompt: 'Checkout the branch {{pr.branch}} from PR #{{pr.number}} and run the test suite. Report any failures.',
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
    '--json', 'number,title,author,assignees,reviewRequests,headRefName,baseRefName,state,isDraft,url,createdAt,updatedAt,additions,deletions,reviewDecision,labels',
    '--limit', '200',
  ])
  const raw = JSON.parse(json) as Array<{
    number: number
    title: string
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
  }>
  return raw.map((pr) => ({
    number: pr.number,
    title: pr.title,
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
  }))
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
    .replace(/\{\{repo\.owner\}\}/g, repo.owner)
    .replace(/\{\{repo\.name\}\}/g, repo.name)
}
