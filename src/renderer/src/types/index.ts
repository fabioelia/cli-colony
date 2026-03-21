export interface ClaudeInstance {
  id: string
  name: string
  color: string
  status: 'running' | 'idle' | 'exited'
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

declare global {
  interface Window {
    api: import('../../../preload/index').ClaudeManagerAPI
  }
}
