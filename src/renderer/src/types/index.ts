// Re-export shared types — single source of truth in src/shared/types.ts
export type {
  CliBackend, ClaudeInstance, AgentDef, CliSession,
  CheckRun, PRChecks, PRComment, GitHubPR, QuickPrompt, GitHubRepo,
  FeedbackFile, PersonaInfo, EnvServiceStatus, EnvStatus,
  TaskBoardItem, TaskStatus, TaskPriority, ArenaStats,
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

declare global {
  interface Window {
    api: import('../../../preload/index').ClaudeManagerAPI
  }
}
