export interface ClaudeInstance {
  id: string
  name: string
  color: string
  status: 'running' | 'exited'
  activity: 'busy' | 'waiting'
  workingDirectory: string
  createdAt: string
  exitCode: number | null
  pid: number | null
  args: string[]
  gitBranch: string | null
  tokenUsage: { input: number; output: number; cost: number }
  pinned: boolean
  mcpServers: string[]
}

export interface AgentDef {
  id: string
  name: string
  description: string
  tools: string[]
  model?: string
  color?: string
  filePath: string
  scope: 'personal' | 'project'
  projectName?: string
}

export interface CliSession {
  sessionId: string
  name: string | null
  display: string
  lastMessage: string | null
  messageCount: number
  project: string
  timestamp: number
  projectName: string
  recentlyOpened: boolean
}

export interface RecentSession {
  instanceName: string
  sessionId: string | null
  workingDirectory: string
  color: string
  args: string[]
  openedAt: string
  closedAt: string | null
  exitType: 'running' | 'exited' | 'killed'
}

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
  prompt: string
}

export interface GitHubRepo {
  owner: string
  name: string
  localPath?: string
}

declare global {
  interface Window {
    api: import('../../../preload/index').ClaudeManagerAPI
  }
}
