// Re-export shared types — single source of truth in src/shared/types.ts
export type {
  CliBackend, ClaudeInstance, AgentDef, CliSession,
  CheckRun, PRChecks, PRComment, GitHubPR, QuickPrompt, GitHubRepo,
  FeedbackFile, EnvServiceStatus, EnvStatus,
} from '../../../shared/types'

// Renderer-only types below

export interface RecentSession {
  instanceName: string
  sessionId: string | null
  workingDirectory: string
  color: string
  args: string[]
  cliBackend?: import('../../../shared/types').CliBackend
  openedAt: string
  closedAt: string | null
  exitType: 'running' | 'exited' | 'killed'
}

export interface SessionDependency {
  dependsOn: string
  action: 'auto-start' | 'notify'
}

export interface AgentChainStep {
  name: string
  prompt: string
  directory?: string
  dependsOnPrevious: boolean
}

export interface AgentChain {
  id: string
  name: string
  steps: AgentChainStep[]
}

declare global {
  interface Window {
    api: import('../../../preload/index').ClaudeManagerAPI
  }
}
