import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  CliBackend, ClaudeInstance, AgentDef, CliSession,
  CheckRun, PRChecks, PRComment, GitHubPR, GitHubIssue, QuickPrompt, GitHubRepo,
  FeedbackFile, PersonaInfo, EnvServiceStatus, EnvStatus, ActivityEvent, ApprovalRequest,
  TaskBoardItem, AuditResult, McpAuditEntry, CommitAttribution, ArenaStats, ArenaMatchRecord,
  ForkGroup, GitDiffEntry, PersonaArtifact, SessionTemplate, ColonyComment, OutputEntry,
  PersonaRunEntry, ScoreCard, ApprovalRule, ApprovalRuleType, ApprovalRuleAction,
  CoordinatorTeam, BatchConfig, BatchRun, TeamMetrics, WorkerStats, TeamMetricsEntry, ContextUsage,
  PendingLaunchRecord, UpdateStatus, UpdateInfo,
  OnboardingState, OnboardingChecklistKey, PrerequisitesStatus,
  WorktreeInfo,
  PersonaMemory, PersonaMemorySituation, PersonaMemoryLearning, PersonaMemoryLogEntry,
  SessionArtifact, SessionArtifactCommit, PersonaAnalytics,
  NotificationEntry,
  ErrorSummary,
  PersonaHealthEntry,
} from '../shared/types'

// Re-export shared types so existing imports from this module continue to work
export type {
  CliBackend, ClaudeInstance, AgentDef, CliSession,
  CheckRun, PRChecks, PRComment, GitHubPR, GitHubIssue, QuickPrompt, GitHubRepo,
  FeedbackFile, PersonaInfo, EnvServiceStatus, EnvStatus, ActivityEvent, ApprovalRequest,
  TaskBoardItem, AuditResult, McpAuditEntry, CommitAttribution, ArenaStats, ArenaMatchRecord,
  ForkGroup, GitDiffEntry, PersonaArtifact, SessionTemplate, ColonyComment, OutputEntry,
  PersonaRunEntry, ScoreCard, ApprovalRule, ApprovalRuleType, ApprovalRuleAction,
  CoordinatorTeam, BatchConfig, BatchRun, TeamMetrics, WorkerStats, TeamMetricsEntry, ContextUsage,
  PendingLaunchRecord, UpdateStatus, UpdateInfo,
  OnboardingState, OnboardingChecklistKey, PrerequisitesStatus,
  WorktreeInfo,
  PersonaMemory, PersonaMemorySituation, PersonaMemoryLearning, PersonaMemoryLogEntry,
  SessionArtifact, SessionArtifactCommit, PersonaAnalytics,
  NotificationEntry,
  ErrorSummary,
  PersonaHealthEntry,
}


export interface ClaudeManagerAPI {
  agents: {
    list: () => Promise<AgentDef[]>
    read: (filePath: string) => Promise<string | null>
    write: (filePath: string, content: string) => Promise<boolean>
    create: (name: string, scope: string, projectPath?: string) => Promise<AgentDef | null>
    export: (agentPaths: string[]) => Promise<boolean>
    import: (targetDir: string) => Promise<number>
    delete: (filePath: string) => Promise<boolean>
  }
  instance: {
    create: (opts?: {
      name?: string
      workingDirectory?: string
      color?: string
      args?: string[]
      parentId?: string
      cliBackend?: CliBackend
      mcpServers?: string[]
      permissionMode?: 'autonomous' | 'supervised'
      env?: Record<string, string>
    }) => Promise<ClaudeInstance>
    write: (id: string, data: string) => void
    resize: (id: string, cols: number, rows: number) => Promise<boolean>
    kill: (id: string) => Promise<boolean>
    remove: (id: string) => Promise<boolean>
    rename: (id: string, name: string) => Promise<boolean>
    recolor: (id: string, color: string) => Promise<boolean>
    restart: (id: string) => Promise<ClaudeInstance | null>
    pin: (id: string) => Promise<boolean>
    unpin: (id: string) => Promise<boolean>
    setRole: (id: string, role: string | null) => Promise<boolean>
    setNote: (id: string, note: string) => Promise<boolean>
    list: () => Promise<ClaudeInstance[]>
    get: (id: string) => Promise<ClaudeInstance | null>
    buffer: (id: string) => Promise<string>
    summarize: (id: string) => Promise<string>
    processes: (id: string) => Promise<Array<{ pid: number; name: string; command: string; cpu: string; mem: string }>>
    killProcess: (pid: number) => Promise<boolean>
    gitLog: (cwd: string) => Promise<string>
    gitDiff: (cwd: string) => Promise<string>
    onOutput: (callback: (data: { id: string; data: string }) => void) => () => void
    onExited: (callback: (data: { id: string; exitCode: number }) => void) => () => void
    onListUpdate: (callback: (instances: ClaudeInstance[]) => void) => () => void
    onFocus: (callback: (data: { id: string }) => void) => () => void
    onActivity: (callback: (data: { id: string; activity: 'busy' | 'waiting' }) => void) => () => void
    onToolDeferred: (callback: (data: { id: string; sessionId: string; toolName?: string }) => void) => () => void
    onErrorSummary: (callback: (data: { id: string; errorSummary: ErrorSummary }) => void) => () => void
    onBudgetExceeded: (callback: (data: { id: string; cost: number; cap: number }) => void) => () => void
    clearToolDeferred: (id: string) => Promise<boolean>
    fileOverlaps: () => Promise<Record<string, { file: string; otherSessions: { id: string; name: string }[] }[]>>
  }
  shellPty: {
    create: (instanceId: string, cwd: string) => Promise<{ pid: number }>
    write: (instanceId: string, data: string) => Promise<boolean>
    resize: (instanceId: string, cols: number, rows: number) => Promise<boolean>
    kill: (instanceId: string) => Promise<boolean>
    onOutput: (callback: (data: { instanceId: string; data: string }) => void) => () => void
    onExited: (callback: (data: { instanceId: string }) => void) => () => void
  }
  sessions: {
    list: (limit?: number) => Promise<CliSession[]>
    search: (query: string) => Promise<Array<{ sessionId: string; name: string | null; project: string; match: string }>>
    external: () => Promise<Array<{ pid: number; name: string; cwd: string; sessionId: string | null; args: string }>>
    messages: (sessionId: string, limit?: number) => Promise<{
      messages: Array<{ role: string; text: string; timestamp?: string; type?: string }>
      project: string | null
    }>
    takeover: (opts: { pid: number; sessionId: string | null; name: string; cwd: string }) => Promise<{
      cwd: string; args: string[]; name: string
    }>
    restorable: () => Promise<any[]>
    clearRestorable: () => Promise<boolean>
    recent: () => Promise<any[]>
    searchOutput: (query: string) => Promise<Array<{
      instanceId: string
      name: string
      matches: Array<{ lineNum: number; line: string; contextBefore: string; contextAfter: string }>
    }>>
    idleInfo: () => Promise<Array<{ id: string; idleMs: number }>>
  }
  daemon: {
    restart: () => Promise<void>
    getVersion: () => Promise<{ running: number; expected: number }>
    onVersionMismatch: (cb: (info: { running: number; expected: number }) => void) => () => void
    onConnectionFailed: (cb: (info: { error: string }) => void) => () => void
    onDaemonUnresponsive: (cb: () => void) => () => void
  }
  settings: {
    getAll: () => Promise<Record<string, string>>
    set: (key: string, value: string) => Promise<boolean>
    getShells: () => Promise<string[]>
    detectGitProtocol: () => Promise<'ssh' | 'https' | null>
    reregisterHotkey: (hotkey: string) => Promise<{ success: boolean; error?: string }>
    export: () => Promise<boolean>
    import: () => Promise<{ settingsCount: number; mcpCount: number; templateCount: number; ruleCount: number } | null>
  }
  logs: {
    get: () => Promise<string>
    clear: () => Promise<boolean>
    getScheduler: () => Promise<string[]>
  }
  shell: {
    openExternal: (url: string) => Promise<void>
  }
  shortcuts: {
    onNewInstance: (cb: () => void) => () => void
    onCloseInstance: (cb: () => void) => () => void
    onClearTerminal: (cb: () => void) => () => void
    onSearch: (cb: () => void) => () => void
    onGlobalSearch: (cb: () => void) => () => void
    onSwitchInstance: (cb: (index: number) => void) => () => void
    onZoomIn: (cb: () => void) => () => void
    onZoomOut: (cb: () => void) => () => void
    onZoomReset: (cb: () => void) => () => void
    onToggleSplit: (cb: () => void) => () => void
    onCloseSplit: (cb: () => void) => () => void
    onFocusPane: (cb: (side: 'left' | 'right') => void) => () => void
    onCycleInstance: (cb: (direction: number) => void) => () => void
    onCommandPalette: (cb: () => void) => () => void
    onQuickPrompt: (cb: () => void) => () => void
    onNavigate: (cb: (route: string | Record<string, unknown>) => void) => () => void
  }
  fs: {
    listDir: (dirPath: string, depth?: number) => Promise<any[]>
    readFile: (filePath: string) => Promise<{ content?: string; error?: string }>
    searchContent: (dirPath: string, query: string, ignoreDirs?: string[]) => Promise<Array<{ file: string; matches: Array<{ line: number; text: string }> }>>
    saveClipboardImage: (base64Data: string) => Promise<string>
    pasteClipboardImage: () => Promise<string | null>
    writeTempFile: (prefix: string, content: string) => Promise<string>
  }
  getPathForFile: (file: File) => string
  dialog: {
    openDirectory: () => Promise<string | null>
  }
  window: {
    toggleFullScreen: () => Promise<boolean>
    onFullScreenChanged: (cb: (isFullScreen: boolean) => void) => () => void
  }
  github: {
    authStatus: () => Promise<boolean>
    fetchPRs: (repo: GitHubRepo) => Promise<GitHubPR[]>
    getRepos: () => Promise<GitHubRepo[]>
    addRepo: (repo: GitHubRepo) => Promise<GitHubRepo[]>
    cloneRepo: (repo: GitHubRepo) => Promise<boolean>
    removeRepo: (owner: string, name: string) => Promise<GitHubRepo[]>
    getRemovalImpact: (owner: string, name: string) => Promise<any>
    updateRepoPath: (owner: string, name: string, localPath: string) => Promise<GitHubRepo[]>
    getPrompts: () => Promise<QuickPrompt[]>
    savePrompts: (prompts: QuickPrompt[]) => Promise<QuickPrompt[]>
    resolvePrompt: (prompt: QuickPrompt, pr: GitHubPR, repo: GitHubRepo) => Promise<string>
    writePrContext: (prsByRepo: Record<string, GitHubPR[]>) => Promise<string>
    getPrMemory: () => Promise<string>
    savePrMemory: (content: string) => Promise<boolean>
    getPrMemoryPath: () => Promise<string>
    getPrWorkspacePath: () => Promise<string>
    getCommentsFile: (repoSlug: string, prNumber: number) => Promise<string | null>
    fetchChecks: (repo: GitHubRepo, prNumber: number) => Promise<PRChecks>
    fetchCheckLogs: (repo: GitHubRepo, prNumber: number, checkName: string) => Promise<string>
    getUser: () => Promise<string | null>
    fetchFeedback: (repo: GitHubRepo, prNumber: number) => Promise<FeedbackFile[]>
    fetchPRFiles: (repo: GitHubRepo, prNumber: number) => Promise<import('../shared/types').PRFile[]>
    postPRComment: (repo: GitHubRepo, prNumber: number, body: string) => Promise<import('../shared/types').PRComment>
    submitReview: (repo: GitHubRepo, prNumber: number, event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT', body?: string) => Promise<void>
    mergePR: (repo: GitHubRepo, prNumber: number, method: 'merge' | 'squash' | 'rebase') => Promise<void>
    fetchIssues: (repo: GitHubRepo) => Promise<GitHubIssue[]>
    createIssue: (repo: GitHubRepo, title: string, body: string, labels: string[]) => Promise<GitHubIssue>
  }
  colony: {
    updateContext: () => Promise<string>
    getContextPath: () => Promise<string>
    getContextInstruction: () => Promise<string>
    writePromptFile: (content: string) => Promise<string>
  }
  pipeline: {
    list: () => Promise<Array<{
      name: string
      description: string
      enabled: boolean
      fileName: string
      triggerType: string
      interval: number
      cron: string | null
      running: boolean
      outputsDir: string | null
      lastPollAt: string | null
      lastFiredAt: string | null
      lastError: string | null
      fireCount: number
    }>>
    toggle: (name: string, enabled: boolean) => Promise<boolean>
    triggerNow: (name: string) => Promise<boolean>
    getDir: () => Promise<string>
    getContent: (fileName: string) => Promise<string | null>
    saveContent: (fileName: string, content: string) => Promise<boolean>
    reload: () => Promise<any>
    onStatus: (cb: (pipelines: any[]) => void) => () => void
    onFired: (cb: (data: { pipeline: string; instanceId: string }) => void) => () => void
    listOutputs: (outputDir: string) => Promise<Array<{ name: string; path: string; size: number; modified: number }>>
    getMemory: (fileName: string) => Promise<string>
    saveMemory: (fileName: string, content: string) => Promise<boolean>
    setCron: (fileName: string, cron: string | null) => Promise<boolean>
    preview: (fileName: string) => Promise<{
      wouldFire: boolean
      matches: Array<{
        description: string
        resolvedVars: Record<string, string>
        wouldBeDeduped: boolean
      }>
      conditionLog: string[]
      error?: string
    }>
    listApprovals: () => Promise<ApprovalRequest[]>
    approve: (id: string) => Promise<boolean>
    dismiss: (id: string) => Promise<boolean>
    onApprovalNew: (cb: (request: ApprovalRequest) => void) => () => void
    onApprovalUpdate: (cb: (data: { id: string; status: 'approved' | 'dismissed' | 'expired' }) => void) => () => void
    getHistory: (name: string) => Promise<Array<{ ts: string; trigger: string; actionExecuted: boolean; success: boolean; durationMs: number; stages?: Array<{ index: number; actionType: string; sessionName?: string; durationMs: number; success: boolean; error?: string }> }>>
    createFromTemplate: (yaml: string, slug: string) => Promise<boolean>
    generate: (description: string) => Promise<string>
    delete: (fileName: string) => Promise<boolean>
    export: (fileNames: string[]) => Promise<boolean>
    import: () => Promise<number>
  }
  persona: {
    list: () => Promise<PersonaInfo[]>
    getContent: (fileName: string) => Promise<{ content: string | null; mtime: number | null }>
    saveContent: (fileName: string, content: string) => Promise<boolean>
    create: (name: string) => Promise<{ fileName: string } | null>
    delete: (fileName: string) => Promise<boolean>
    run: (fileName: string) => Promise<string>
    stop: (fileName: string) => Promise<boolean>
    toggle: (fileName: string, enabled: boolean) => Promise<boolean>
    getDir: () => Promise<string>
    setSchedule: (fileName: string, schedule: string) => Promise<boolean>
    whisper: (fileName: string, text: string) => Promise<boolean>
    deleteNote: (fileName: string, index: number) => Promise<boolean>
    updateMeta: (fileName: string, updates: Record<string, string | boolean | number | string[]>) => Promise<boolean>
    getArtifacts: (personaId: string) => Promise<PersonaArtifact[]>
    readArtifact: (personaId: string, filename: string) => Promise<string | null>
    ask: (query: string) => Promise<string>
    getRunHistory: (personaId: string) => Promise<PersonaRunEntry[]>
    getAnalytics: (personaId: string) => Promise<PersonaAnalytics>
    getColonyCostTrend: () => Promise<{ date: string; cost: number }[]>
    healthSummary: () => Promise<PersonaHealthEntry[]>
    onStatus: (cb: (personas: PersonaInfo[]) => void) => () => void
    onRun: (cb: (data: { persona: string; instanceId: string }) => void) => () => void
  }
  personaMemory: {
    get: (personaId: string) => Promise<PersonaMemory>
    migrate: (personaId: string) => Promise<boolean>
    setSituations: (personaId: string, situations: PersonaMemorySituation[]) => Promise<PersonaMemory>
    addSituation: (personaId: string, situation: PersonaMemorySituation) => Promise<PersonaMemory>
    updateSituation: (personaId: string, index: number, updates: Partial<PersonaMemorySituation>) => Promise<PersonaMemory>
    removeSituation: (personaId: string, index: number) => Promise<PersonaMemory>
    addLearning: (personaId: string, text: string) => Promise<PersonaMemory>
    removeLearning: (personaId: string, index: number) => Promise<PersonaMemory>
    setLearnings: (personaId: string, learnings: PersonaMemoryLearning[]) => Promise<PersonaMemory>
    addLogEntry: (personaId: string, summary: string) => Promise<PersonaMemory>
    setLog: (personaId: string, entries: PersonaMemoryLogEntry[]) => Promise<PersonaMemory>
  }
  tasksBoard: {
    list: () => Promise<TaskBoardItem[]>
    save: (item: TaskBoardItem) => Promise<void>
    delete: (id: string) => Promise<void>
    onUpdated: (cb: (items: TaskBoardItem[]) => void) => () => void
  }
  taskQueue: {
    list: () => Promise<Array<{ name: string; path: string; content: string }>>
    save: (name: string, content: string) => Promise<string>
    delete: (name: string) => Promise<boolean>
    getWorkspacePath: () => Promise<string>
    createTaskDir: (queueName: string, taskName: string) => Promise<string>
    listRuns: () => Promise<Array<{
      name: string
      path: string
      tasks: Array<{
        name: string
        path: string
        files: Array<{ name: string; path: string; size: number }>
      }>
    }>>
    listOutputRuns: (queueOutputDir: string) => Promise<Array<{
      name: string
      path: string
      files: Array<{ name: string; path: string; size: number }>
    }>>
    getMemory: (queueName: string) => Promise<string>
    saveMemory: (queueName: string, content: string) => Promise<boolean>
  }
  resources: {
    getUsage: () => Promise<{
      perInstance: Record<string, { cpu: number; memory: number }>
      total: { cpu: number; memory: number }
    }>
  }
  env: {
    list: () => Promise<EnvStatus[]>
    get: (envId: string) => Promise<EnvStatus | null>
    create: (opts: { name: string; branch?: string; baseBranch?: string; projectType?: string; target?: string; targetDir?: string; templateId?: string }) => Promise<any>
    start: (envId: string, services?: string[]) => Promise<void>
    stop: (envId: string, services?: string[]) => Promise<void>
    teardown: (envId: string) => Promise<void>
    logs: (envId: string, service: string, lines?: number) => Promise<string>
    restartService: (envId: string, service: string) => Promise<void>
    manifest: (envId: string) => Promise<any>
    saveManifest: (envId: string, manifest: any) => Promise<void>
    retrySetup: (envId: string) => Promise<void>
    fix: (envId: string) => Promise<{ fixed: string[] }>
    clone: (envId: string, newName: string) => Promise<any>
    setRestartPolicy: (envId: string, policy: 'manual' | 'on-crash') => Promise<void>
    setPurposeTag: (envId: string, tag: 'interactive' | 'background' | 'nightly' | null) => Promise<void>
    listTemplates: () => Promise<any[]>
    getTemplate: (id: string) => Promise<any>
    saveTemplate: (template: any) => Promise<boolean>
    deleteTemplate: (id: string) => Promise<boolean>
    /** Re-scan all repos for .colony/ configs and return merged template list. */
    refreshTemplates: () => Promise<any[]>
    onStatusUpdate: (cb: (environments: EnvStatus[]) => void) => () => void
    onServiceOutput: (cb: (data: { envId: string; service: string; data: string }) => void) => () => void
    onServiceCrashed: (cb: (data: { envId: string; service: string; exitCode: number }) => void) => () => void
    onTemplatesChanged: (cb: (templates: any[]) => void) => () => void
    onPromptRequest: (cb: (data: { requestId: string; envId: string; hookName: string; prompt: string; promptType: string; defaultPath?: string; options?: string[] }) => void) => () => void
    respondToPrompt: (data: { requestId: string; filePath?: string; selectedValue?: string; cancelled?: boolean }) => void
    pickFile: (opts: { title?: string; defaultPath?: string; message?: string }) => Promise<string | null>
    launchSessionWhenReady: (opts: {
      envId: string
      envName: string
      spawnOpts: { name?: string; workingDirectory?: string; color?: string; args?: string[]; parentId?: string }
      initialPrompt?: string
    }) => Promise<{ pendingId: string }>
    cancelPendingLaunch: (pendingId: string) => Promise<boolean>
    getPendingLaunches: (envId?: string) => Promise<PendingLaunchRecord[]>
    onPendingLaunchStatus: (cb: (record: PendingLaunchRecord) => void) => () => void
    onPendingLaunchSpawned: (cb: (data: { pendingId: string; envId: string; instanceId: string; autoHeal: boolean; timedOut?: boolean }) => void) => () => void
  }
  activity: {
    list: () => Promise<ActivityEvent[]>
    forDate: (date: string) => Promise<ActivityEvent[]>
    markRead: () => Promise<boolean>
    unreadCount: () => Promise<number>
    clear: () => Promise<boolean>
    onNew: (cb: (data: { event: ActivityEvent; unreadCount: number }) => void) => () => void
    onUnread: (cb: (data: { count: number }) => void) => () => void
  }
  mcp: {
    list: () => Promise<Array<{ name: string; command?: string; args?: string[]; url?: string; description?: string; env?: Record<string, string> }>>
    save: (server: { name: string; command?: string; args?: string[]; url?: string; description?: string; env?: Record<string, string> }, originalName?: string) => Promise<Array<{ name: string; command?: string; args?: string[]; url?: string; description?: string; env?: Record<string, string> }>>
    delete: (name: string) => Promise<Array<{ name: string; command?: string; args?: string[]; url?: string; description?: string; env?: Record<string, string> }>>
    getAuditLog: () => Promise<McpAuditEntry[]>
    clearAuditLog: () => Promise<void>
    test: (server: { name: string; command?: string; args?: string[]; url?: string; env?: Record<string, string> }) => Promise<{ ok: boolean; message: string }>
  }
  session: {
    sendMessage: (targetName: string, text: string) => Promise<boolean>
    steer: (instanceId: string, message: string) => Promise<boolean>
    getAttributedCommits: (dir?: string) => Promise<CommitAttribution[]>
    clearCommitAttributions: () => Promise<void>
    gitChanges: (dir: string) => Promise<GitDiffEntry[]>
    getFileDiff: (dir: string, filePath: string, fileStatus?: string) => Promise<string>
    gitRevert: (dir: string, file: string) => Promise<boolean>
    scoreOutput: (dir: string) => Promise<ScoreCard>
    getComments: (instanceId: string) => Promise<ColonyComment[]>
    onComments: (callback: (data: { instanceId: string; comments: ColonyComment[] }) => void) => () => void
    getCoordinatorTeam: (sessionId: string) => Promise<CoordinatorTeam | null>
    getContextUsage: (sessionId: string) => Promise<ContextUsage | null>
    tokenizeApproximate: (text: string) => Promise<number>
    exportMarkdown: (instanceId: string) => Promise<string>
    exportMarkdownToFile: (instanceId: string) => Promise<boolean>
  }
  git: {
    stage: (cwd: string, files: string[]) => Promise<void>
    commit: (cwd: string, message: string) => Promise<string>
    push: (cwd: string) => Promise<void>
    branchInfo: (cwd: string) => Promise<{ branch: string; remote: string | null; ahead: number }>
    unpushedCommits: (cwd: string) => Promise<Array<{ hash: string; subject: string; author: string; date: string }>>
    commitDiff: (cwd: string, hash: string) => Promise<string>
  }
  audit: {
    runPanel: (panel: string, context: object) => Promise<AuditResult[]>
    getLastRun: (panel: string) => Promise<{ ts: number; issueCount: number } | null>
  }
  arena: {
    recordWinner: (winnerKey: string, loserKey: string | string[], matchCtx?: { prompt?: string; judgeType?: 'manual' | 'command' | 'llm'; models?: (string | null)[] }) => Promise<boolean>
    getStats: () => Promise<ArenaStats>
    getMatchHistory: () => Promise<ArenaMatchRecord[]>
    clearStats: () => Promise<void>
    launchWithWorktrees: (opts: {
      owner: string
      repoName: string
      branch: string
      count: number
      prompt?: string
      models?: (string | null)[]
    }) => Promise<{ instances: string[]; worktrees: string[] }>
    cleanupWorktrees: (worktreeIds: string[]) => Promise<number>
    autoJudge: (opts: {
      instanceIds: string[]
      judgeConfig: { type: 'command'; cmd: string } | { type: 'llm'; prompt: string }
    }) => Promise<{ winnerId: string | null; results: Array<{ instanceId: string; exitCode: number; stdout: string }>; verdictText?: string | null }>
  }
  fork: {
    create: (parentId: string, opts: {
      label: string
      taskSummary: string
      forks: Array<{ label: string; directive: string }>
    }) => Promise<ForkGroup>
    getGroups: () => Promise<ForkGroup[]>
    pickWinner: (groupId: string, winnerId: string) => Promise<boolean>
    discard: (groupId: string, forkId: string) => Promise<boolean>
    onGroups: (cb: (groups: ForkGroup[]) => void) => () => void
  }
  sessionTemplates: {
    list: () => Promise<SessionTemplate[]>
    save: (template: SessionTemplate) => Promise<boolean>
    delete: (id: string) => Promise<boolean>
    launch: (id: string) => Promise<ClaudeInstance | null>
  }
  outputs: {
    list: () => Promise<OutputEntry[]>
    read: (filePath: string) => Promise<{ content: string } | { error: string }>
    search: (query: string) => Promise<import('../shared/types').OutputSearchResult[]>
    delete: (filePath: string) => Promise<{ success: boolean; error?: string }>
    revealInFinder: (filePath: string) => Promise<void>
    copyPath: (filePath: string) => Promise<void>
  }
  approvalRules: {
    list: () => Promise<ApprovalRule[]>
    create: (name: string, type: ApprovalRuleType, condition: string, action: ApprovalRuleAction) => Promise<ApprovalRule>
    update: (id: string, updates: Partial<ApprovalRule>) => Promise<boolean>
    delete: (id: string) => Promise<boolean>
  }
  batch: {
    getConfig: () => Promise<BatchConfig>
    setConfig: (config: BatchConfig) => Promise<boolean>
    getHistory: (limit?: number) => Promise<BatchRun[]>
    runNow: () => Promise<{ success: boolean; batchId?: string; error?: string }>
    onStarted: (cb: (data: { batchId: string; taskCount: number }) => void) => () => void
    onTaskComplete: (cb: (data: { batchId: string; task: any }) => void) => () => void
    onCompleted: (cb: (data: { batchId: string; run: any }) => void) => () => void
  }
  team: {
    getMetrics: (window?: '7d' | '30d') => Promise<TeamMetrics>
    getWorkerHistory: (workerId: string, limit?: number, status?: 'success' | 'failed') => Promise<TeamMetricsEntry[]>
    exportCsv: (window?: '7d' | '30d') => Promise<string>
  }
  appUpdate: {
    getStatus: () => Promise<UpdateStatus>
    checkNow: () => Promise<UpdateStatus>
    download: () => Promise<UpdateStatus>
    quitAndInstall: () => Promise<boolean>
    getAutoEnabled: () => Promise<boolean>
    setAutoEnabled: (enabled: boolean) => Promise<boolean>
    onStatus: (cb: (status: UpdateStatus) => void) => () => void
    onAvailable: (cb: (info: UpdateInfo) => void) => () => void
    onReady: (cb: (info: UpdateInfo) => void) => () => void
    onDownloadProgress: (cb: (progress: { percent: number; bytesPerSecond: number; total: number }) => void) => () => void
    onError: (cb: (err: { message: string }) => void) => () => void
  }
  onboarding: {
    getState: () => Promise<OnboardingState>
    markComplete: (key: OnboardingChecklistKey) => Promise<OnboardingState>
    skip: () => Promise<OnboardingState>
    replay: () => Promise<OnboardingState>
    reset: () => Promise<OnboardingState>
    onStateChanged: (cb: (state: OnboardingState) => void) => () => void
  }
  prerequisites: {
    check: () => Promise<PrerequisitesStatus>
  }
  worktree: {
    list: () => Promise<WorktreeInfo[]>
    get: (id: string) => Promise<WorktreeInfo | null>
    create: (owner: string, name: string, branch: string, repoAlias: string, remoteUrl?: string) => Promise<WorktreeInfo>
    mount: (worktreeId: string, envId: string) => Promise<WorktreeInfo>
    unmount: (worktreeId: string) => Promise<WorktreeInfo>
    remove: (worktreeId: string) => Promise<boolean>
    forEnv: (envId: string) => Promise<WorktreeInfo[]>
    onChanged: (cb: () => void) => () => void
  }
  artifacts: {
    list: () => Promise<SessionArtifact[]>
    get: (sessionId: string) => Promise<SessionArtifact | null>
    collect: (sessionId: string) => Promise<SessionArtifact | null>
    clear: () => Promise<boolean>
    tagPipeline: (sessionId: string, pipelineRunId: string) => Promise<boolean>
  }
  notifications: {
    history: () => Promise<NotificationEntry[]>
    markRead: (id: string) => Promise<void>
    markAllRead: () => Promise<void>
    clearAll: () => Promise<void>
    unreadCount: () => Promise<number>
    onNew: (cb: (entry: NotificationEntry) => void) => () => void
  }
}

const api: ClaudeManagerAPI = {
  agents: {
    list: () => ipcRenderer.invoke('agents:list'),
    read: (filePath) => ipcRenderer.invoke('agents:read', filePath),
    write: (filePath, content) => ipcRenderer.invoke('agents:write', filePath, content),
    create: (name, scope, projectPath) => ipcRenderer.invoke('agents:create', name, scope, projectPath),
    export: (agentPaths) => ipcRenderer.invoke('agents:export', agentPaths),
    import: (targetDir) => ipcRenderer.invoke('agents:import', targetDir),
    delete: (filePath) => ipcRenderer.invoke('agents:delete', filePath),
  },
  instance: {
    create: (opts) => ipcRenderer.invoke('instance:create', opts),
    write: (id, data) => ipcRenderer.send('instance:write', id, data),
    resize: (id, cols, rows) => ipcRenderer.invoke('instance:resize', id, cols, rows),
    kill: (id) => ipcRenderer.invoke('instance:kill', id),
    remove: (id) => ipcRenderer.invoke('instance:remove', id),
    rename: (id, name) => ipcRenderer.invoke('instance:rename', id, name),
    recolor: (id, color) => ipcRenderer.invoke('instance:recolor', id, color),
    restart: (id) => ipcRenderer.invoke('instance:restart', id),
    pin: (id) => ipcRenderer.invoke('instance:pin', id),
    unpin: (id) => ipcRenderer.invoke('instance:unpin', id),
    setRole: (id, role) => ipcRenderer.invoke('instance:setRole', id, role),
    setNote: (id, note) => ipcRenderer.invoke('instance:set-note', id, note),
    list: () => ipcRenderer.invoke('instance:list'),
    get: (id) => ipcRenderer.invoke('instance:get', id),
    buffer: (id) => ipcRenderer.invoke('instance:buffer', id),
    summarize: (id) => ipcRenderer.invoke('instance:summarize', id),
    processes: (id) => ipcRenderer.invoke('instance:processes', id),
    killProcess: (pid) => ipcRenderer.invoke('instance:killProcess', pid),
    gitLog: (cwd) => ipcRenderer.invoke('instance:gitLog', cwd),
    gitDiff: (cwd) => ipcRenderer.invoke('instance:gitDiff', cwd),
    onOutput: (callback) => {
      const listener = (_e: any, data: { id: string; data: string }) => callback(data)
      ipcRenderer.on('instance:output', listener)
      return () => ipcRenderer.removeListener('instance:output', listener)
    },
    onExited: (callback) => {
      const listener = (_e: any, data: { id: string; exitCode: number }) => callback(data)
      ipcRenderer.on('instance:exited', listener)
      return () => ipcRenderer.removeListener('instance:exited', listener)
    },
    onListUpdate: (callback) => {
      const listener = (_e: any, instances: ClaudeInstance[]) => callback(instances)
      ipcRenderer.on('instance:list', listener)
      return () => ipcRenderer.removeListener('instance:list', listener)
    },
    onFocus: (callback) => {
      const listener = (_e: any, data: { id: string }) => callback(data)
      ipcRenderer.on('instance:focus', listener)
      return () => ipcRenderer.removeListener('instance:focus', listener)
    },
    onActivity: (callback) => {
      const listener = (_e: any, data: { id: string; activity: 'busy' | 'waiting' }) => callback(data)
      ipcRenderer.on('instance:activity', listener)
      return () => ipcRenderer.removeListener('instance:activity', listener)
    },
    onToolDeferred: (callback) => {
      const listener = (_e: any, data: { id: string; sessionId: string; toolName?: string }) => callback(data)
      ipcRenderer.on('instance:tool-deferred', listener)
      return () => ipcRenderer.removeListener('instance:tool-deferred', listener)
    },
    onErrorSummary: (callback) => {
      const listener = (_e: any, data: { id: string; errorSummary: import('../shared/types').ErrorSummary }) => callback(data)
      ipcRenderer.on('instance:errorSummary', listener)
      return () => ipcRenderer.removeListener('instance:errorSummary', listener)
    },
    onBudgetExceeded: (callback) => {
      const listener = (_e: any, data: { id: string; cost: number; cap: number }) => callback(data)
      ipcRenderer.on('instance:budgetExceeded', listener)
      return () => ipcRenderer.removeListener('instance:budgetExceeded', listener)
    },
    clearToolDeferred: (id) => ipcRenderer.invoke('instance:clearToolDeferred', id),
    fileOverlaps: () => ipcRenderer.invoke('instances:fileOverlaps'),
  },
  shellPty: {
    create: (instanceId, cwd) => ipcRenderer.invoke('shellPty:create', instanceId, cwd),
    write: (instanceId, data) => ipcRenderer.invoke('shellPty:write', instanceId, data),
    resize: (instanceId, cols, rows) => ipcRenderer.invoke('shellPty:resize', instanceId, cols, rows),
    kill: (instanceId) => ipcRenderer.invoke('shellPty:kill', instanceId),
    onOutput: (callback) => {
      const listener = (_e: any, data: { instanceId: string; data: string }) => callback(data)
      ipcRenderer.on('shellPty:output', listener)
      return () => ipcRenderer.removeListener('shellPty:output', listener)
    },
    onExited: (callback) => {
      const listener = (_e: any, data: { instanceId: string }) => callback(data)
      ipcRenderer.on('shellPty:exited', listener)
      return () => ipcRenderer.removeListener('shellPty:exited', listener)
    },
  },
  sessions: {
    list: (limit) => ipcRenderer.invoke('sessions:list', limit),
    search: (query: string) => ipcRenderer.invoke('sessions:search', query),
    external: () => ipcRenderer.invoke('sessions:external'),
    messages: (sessionId: string, limit?: number) => ipcRenderer.invoke('sessions:messages', sessionId, limit),
    takeover: (opts) => ipcRenderer.invoke('sessions:takeover', opts),
    restorable: () => ipcRenderer.invoke('sessions:restorable'),
    clearRestorable: () => ipcRenderer.invoke('sessions:clearRestorable'),
    recent: () => ipcRenderer.invoke('sessions:recent'),
    searchOutput: (query) => ipcRenderer.invoke('sessions:searchOutput', query),
    idleInfo: () => ipcRenderer.invoke('sessions:idleInfo') as Promise<Array<{ id: string; idleMs: number }>>,
  },
  daemon: {
    restart: () => ipcRenderer.invoke('daemon:restart'),
    getVersion: () => ipcRenderer.invoke('daemon:version'),
    onVersionMismatch: (cb) => {
      const handler = (_e: any, info: { running: number; expected: number }) => cb(info)
      ipcRenderer.on('daemon:version-mismatch', handler)
      return () => ipcRenderer.removeListener('daemon:version-mismatch', handler)
    },
    onConnectionFailed: (cb) => {
      const handler = (_e: any, info: { error: string }) => cb(info)
      ipcRenderer.on('daemon:connection-failed', handler)
      return () => ipcRenderer.removeListener('daemon:connection-failed', handler)
    },
    onDaemonUnresponsive: (cb) => {
      const handler = () => cb()
      ipcRenderer.on('daemon:unresponsive', handler)
      return () => ipcRenderer.removeListener('daemon:unresponsive', handler)
    },
  },
  settings: {
    getAll: () => ipcRenderer.invoke('settings:getAll'),
    set: (key, value) => ipcRenderer.invoke('settings:set', key, value),
    getShells: () => ipcRenderer.invoke('settings:getShells'),
    detectGitProtocol: () => ipcRenderer.invoke('settings:detectGitProtocol'),
    reregisterHotkey: (hotkey) => ipcRenderer.invoke('settings:reregisterHotkey', hotkey),
    export: () => ipcRenderer.invoke('settings:export'),
    import: () => ipcRenderer.invoke('settings:import'),
  },
  logs: {
    get: () => ipcRenderer.invoke('logs:get'),
    clear: () => ipcRenderer.invoke('logs:clear'),
    getScheduler: () => ipcRenderer.invoke('logs:getScheduler'),
  },
  shell: {
    openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  },
  shortcuts: {
    onNewInstance: (cb) => { const l = () => cb(); ipcRenderer.on('shortcut:new-instance', l); return () => ipcRenderer.removeListener('shortcut:new-instance', l) },
    onCloseInstance: (cb) => { const l = () => cb(); ipcRenderer.on('shortcut:close-instance', l); return () => ipcRenderer.removeListener('shortcut:close-instance', l) },
    onClearTerminal: (cb) => { const l = () => cb(); ipcRenderer.on('shortcut:clear-terminal', l); return () => ipcRenderer.removeListener('shortcut:clear-terminal', l) },
    onSearch: (cb) => { const l = () => cb(); ipcRenderer.on('shortcut:search', l); return () => ipcRenderer.removeListener('shortcut:search', l) },
    onGlobalSearch: (cb: () => void) => { const l = () => cb(); ipcRenderer.on('shortcut:global-search', l); return () => ipcRenderer.removeListener('shortcut:global-search', l) },
    onSwitchInstance: (cb) => { const l = (_e: any, idx: number) => cb(idx); ipcRenderer.on('shortcut:switch-instance', l); return () => ipcRenderer.removeListener('shortcut:switch-instance', l) },
    onZoomIn: (cb) => { const l = () => cb(); ipcRenderer.on('shortcut:zoom-in', l); return () => ipcRenderer.removeListener('shortcut:zoom-in', l) },
    onZoomOut: (cb) => { const l = () => cb(); ipcRenderer.on('shortcut:zoom-out', l); return () => ipcRenderer.removeListener('shortcut:zoom-out', l) },
    onZoomReset: (cb) => { const l = () => cb(); ipcRenderer.on('shortcut:zoom-reset', l); return () => ipcRenderer.removeListener('shortcut:zoom-reset', l) },
    onToggleSplit: (cb) => { const l = () => cb(); ipcRenderer.on('shortcut:toggle-split', l); return () => ipcRenderer.removeListener('shortcut:toggle-split', l) },
    onCloseSplit: (cb) => { const l = () => cb(); ipcRenderer.on('shortcut:close-split', l); return () => ipcRenderer.removeListener('shortcut:close-split', l) },
    onFocusPane: (cb) => { const l = (_e: any, side: 'left' | 'right') => cb(side); ipcRenderer.on('shortcut:focus-pane', l); return () => ipcRenderer.removeListener('shortcut:focus-pane', l) },
    onCycleInstance: (cb) => { const l = (_e: any, dir: number) => cb(dir); ipcRenderer.on('shortcut:cycle-instance', l); return () => ipcRenderer.removeListener('shortcut:cycle-instance', l) },
    onCommandPalette: (cb) => { const l = () => cb(); ipcRenderer.on('shortcut:command-palette', l); return () => ipcRenderer.removeListener('shortcut:command-palette', l) },
    onQuickPrompt: (cb) => { const l = () => cb(); ipcRenderer.on('shortcut:quick-prompt', l); return () => ipcRenderer.removeListener('shortcut:quick-prompt', l) },
    onNavigate: (cb) => { const l = (_e: any, route: string | Record<string, unknown>) => cb(route); ipcRenderer.on('app:navigate', l); return () => ipcRenderer.removeListener('app:navigate', l) },
  },
  fs: {
    listDir: (dirPath, depth) => ipcRenderer.invoke('fs:listDir', dirPath, depth),
    readFile: (filePath) => ipcRenderer.invoke('fs:readFile', filePath),
    searchContent: (dirPath, query, ignoreDirs) => ipcRenderer.invoke('fs:searchContent', dirPath, query, ignoreDirs),
    saveClipboardImage: (base64Data) => ipcRenderer.invoke('fs:saveClipboardImage', base64Data),
    pasteClipboardImage: () => ipcRenderer.invoke('fs:pasteClipboardImage'),
    writeTempFile: (prefix, content) => ipcRenderer.invoke('fs:writeTempFile', prefix, content),
  },
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  dialog: {
    openDirectory: () => ipcRenderer.invoke('dialog:openDirectory'),
  },
  window: {
    toggleFullScreen: () => ipcRenderer.invoke('window:toggleFullScreen'),
    onFullScreenChanged: (cb) => { const l = (_e: any, isFS: boolean) => cb(isFS); ipcRenderer.on('window:fullscreen-changed', l); return () => ipcRenderer.removeListener('window:fullscreen-changed', l) },
  },
  github: {
    authStatus: () => ipcRenderer.invoke('github:authStatus'),
    fetchPRs: (repo) => ipcRenderer.invoke('github:fetchPRs', repo),
    getRepos: () => ipcRenderer.invoke('github:getRepos'),
    addRepo: (repo) => ipcRenderer.invoke('github:addRepo', repo),
    cloneRepo: (repo) => ipcRenderer.invoke('github:cloneRepo', repo),
    removeRepo: (owner, name) => ipcRenderer.invoke('github:removeRepo', owner, name),
    getRemovalImpact: (owner, name) => ipcRenderer.invoke('github:getRemovalImpact', owner, name),
    updateRepoPath: (owner, name, localPath) => ipcRenderer.invoke('github:updateRepoPath', owner, name, localPath),
    getPrompts: () => ipcRenderer.invoke('github:getPrompts'),
    savePrompts: (prompts) => ipcRenderer.invoke('github:savePrompts', prompts),
    resolvePrompt: (prompt, pr, repo) => ipcRenderer.invoke('github:resolvePrompt', prompt, pr, repo),
    writePrContext: (prsByRepo) => ipcRenderer.invoke('github:writePrContext', prsByRepo),
    getPrMemory: () => ipcRenderer.invoke('github:getPrMemory'),
    savePrMemory: (content) => ipcRenderer.invoke('github:savePrMemory', content),
    getPrMemoryPath: () => ipcRenderer.invoke('github:getPrMemoryPath'),
    getPrWorkspacePath: () => ipcRenderer.invoke('github:getPrWorkspacePath'),
    getCommentsFile: (repoSlug, prNumber) => ipcRenderer.invoke('github:getCommentsFile', repoSlug, prNumber),
    fetchChecks: (repo, prNumber) => ipcRenderer.invoke('github:fetchChecks', repo, prNumber),
    fetchCheckLogs: (repo, prNumber, checkName) => ipcRenderer.invoke('github:fetchCheckLogs', repo, prNumber, checkName),
    getUser: () => ipcRenderer.invoke('github:getUser'),
    fetchFeedback: (repo, prNumber) => ipcRenderer.invoke('github:fetchFeedback', repo, prNumber),
    fetchPRFiles: (repo, prNumber) => ipcRenderer.invoke('github:fetchPRFiles', repo, prNumber),
    postPRComment: (repo, prNumber, body) => ipcRenderer.invoke('github:postPRComment', repo, prNumber, body),
    submitReview: (repo, prNumber, event, body) => ipcRenderer.invoke('github:submitReview', repo, prNumber, event, body),
    mergePR: (repo, prNumber, method) => ipcRenderer.invoke('github:mergePR', repo, prNumber, method),
    fetchIssues: (repo) => ipcRenderer.invoke('github:fetchIssues', repo),
    createIssue: (repo, title, body, labels) => ipcRenderer.invoke('github:createIssue', repo, title, body, labels),
  },
  colony: {
    updateContext: () => ipcRenderer.invoke('colony:updateContext'),
    getContextPath: () => ipcRenderer.invoke('colony:getContextPath'),
    getContextInstruction: () => ipcRenderer.invoke('colony:getContextInstruction'),
    writePromptFile: (content) => ipcRenderer.invoke('colony:writePromptFile', content),
  },
  tasksBoard: {
    list: () => ipcRenderer.invoke('tasks:board:list'),
    save: (item) => ipcRenderer.invoke('tasks:board:save', item),
    delete: (id) => ipcRenderer.invoke('tasks:board:delete', id),
    onUpdated: (cb) => {
      const handler = (_e: Electron.IpcRendererEvent, items: TaskBoardItem[]) => cb(items)
      ipcRenderer.on('tasks:board:updated', handler)
      return () => ipcRenderer.removeListener('tasks:board:updated', handler)
    },
  },
  taskQueue: {
    list: () => ipcRenderer.invoke('taskQueue:list'),
    save: (name, content) => ipcRenderer.invoke('taskQueue:save', name, content),
    delete: (name) => ipcRenderer.invoke('taskQueue:delete', name),
    getWorkspacePath: () => ipcRenderer.invoke('taskQueue:getWorkspacePath'),
    createTaskDir: (queueName, taskName) => ipcRenderer.invoke('taskQueue:createTaskDir', queueName, taskName),
    listRuns: () => ipcRenderer.invoke('taskQueue:listRuns'),
    listOutputRuns: (queueOutputDir) => ipcRenderer.invoke('taskQueue:listOutputRuns', queueOutputDir),
    getMemory: (queueName) => ipcRenderer.invoke('taskQueue:getMemory', queueName),
    saveMemory: (queueName, content) => ipcRenderer.invoke('taskQueue:saveMemory', queueName, content),
  },
  resources: {
    getUsage: () => ipcRenderer.invoke('resources:getUsage'),
  },
  pipeline: {
    list: () => ipcRenderer.invoke('pipeline:list'),
    toggle: (name, enabled) => ipcRenderer.invoke('pipeline:toggle', name, enabled),
    triggerNow: (name) => ipcRenderer.invoke('pipeline:triggerNow', name),
    getDir: () => ipcRenderer.invoke('pipeline:getDir'),
    getContent: (fileName) => ipcRenderer.invoke('pipeline:getContent', fileName),
    saveContent: (fileName, content) => ipcRenderer.invoke('pipeline:saveContent', fileName, content),
    reload: () => ipcRenderer.invoke('pipeline:reload'),
    onStatus: (cb) => {
      const l = (_e: any, data: any[]) => cb(data)
      ipcRenderer.on('pipeline:status', l)
      return () => ipcRenderer.removeListener('pipeline:status', l)
    },
    onFired: (cb) => {
      const l = (_e: any, data: { pipeline: string; instanceId: string }) => cb(data)
      ipcRenderer.on('pipeline:fired', l)
      return () => ipcRenderer.removeListener('pipeline:fired', l)
    },
    listOutputs: (outputDir) => ipcRenderer.invoke('pipeline:listOutputs', outputDir),
    getMemory: (fileName) => ipcRenderer.invoke('pipeline:getMemory', fileName),
    saveMemory: (fileName, content) => ipcRenderer.invoke('pipeline:saveMemory', fileName, content),
    setCron: (fileName, cron) => ipcRenderer.invoke('pipeline:setCron', fileName, cron),
    preview: (fileName) => ipcRenderer.invoke('pipeline:preview', fileName),
    listApprovals: () => ipcRenderer.invoke('pipeline:listApprovals'),
    approve: (id) => ipcRenderer.invoke('pipeline:approve', id),
    dismiss: (id) => ipcRenderer.invoke('pipeline:dismiss', id),
    onApprovalNew: (cb) => {
      const l = (_e: any, data: ApprovalRequest) => cb(data)
      ipcRenderer.on('pipeline:approval:new', l)
      return () => ipcRenderer.removeListener('pipeline:approval:new', l)
    },
    onApprovalUpdate: (cb) => {
      const l = (_e: any, data: { id: string; status: 'approved' | 'dismissed' | 'expired' }) => cb(data)
      ipcRenderer.on('pipeline:approval:update', l)
      return () => ipcRenderer.removeListener('pipeline:approval:update', l)
    },
    getHistory: (name) => ipcRenderer.invoke('pipeline:getHistory', name),
    createFromTemplate: (yaml, slug) => ipcRenderer.invoke('pipeline:createFromTemplate', yaml, slug),
    generate: (description) => ipcRenderer.invoke('pipeline:generate', description),
    delete: (fileName) => ipcRenderer.invoke('pipeline:delete', fileName),
    export: (fileNames) => ipcRenderer.invoke('pipeline:export', fileNames),
    import: () => ipcRenderer.invoke('pipeline:import'),
  },
  persona: {
    list: () => ipcRenderer.invoke('persona:list'),
    getContent: (fileName) => ipcRenderer.invoke('persona:getContent', fileName),
    saveContent: (fileName, content) => ipcRenderer.invoke('persona:saveContent', fileName, content),
    create: (name) => ipcRenderer.invoke('persona:create', name),
    delete: (fileName) => ipcRenderer.invoke('persona:delete', fileName),
    run: (fileName) => ipcRenderer.invoke('persona:run', fileName),
    stop: (fileName) => ipcRenderer.invoke('persona:stop', fileName),
    toggle: (fileName, enabled) => ipcRenderer.invoke('persona:toggle', fileName, enabled),
    getDir: () => ipcRenderer.invoke('persona:getDir'),
    setSchedule: (fileName, schedule) => ipcRenderer.invoke('persona:setSchedule', fileName, schedule),
    whisper: (fileName, text) => ipcRenderer.invoke('persona:whisper', fileName, text),
    deleteNote: (fileName, index) => ipcRenderer.invoke('persona:deleteNote', fileName, index),
    updateMeta: (fileName, updates) => ipcRenderer.invoke('persona:updateMeta', fileName, updates),
    getArtifacts: (personaId) => ipcRenderer.invoke('persona:getArtifacts', personaId),
    readArtifact: (personaId, filename) => ipcRenderer.invoke('persona:readArtifact', personaId, filename),
    ask: (query) => ipcRenderer.invoke('persona:ask', query),
    getRunHistory: (personaId) => ipcRenderer.invoke('persona:getRunHistory', personaId),
    getAnalytics: (personaId) => ipcRenderer.invoke('persona:analytics', personaId),
    getColonyCostTrend: () => ipcRenderer.invoke('persona:analytics:colony'),
    healthSummary: () => ipcRenderer.invoke('persona:healthSummary'),
    onStatus: (cb) => {
      const l = (_e: any, data: PersonaInfo[]) => cb(data)
      ipcRenderer.on('persona:status', l)
      return () => ipcRenderer.removeListener('persona:status', l)
    },
    onRun: (cb) => {
      const l = (_e: any, data: { persona: string; instanceId: string }) => cb(data)
      ipcRenderer.on('persona:run', l)
      return () => ipcRenderer.removeListener('persona:run', l)
    },
  },
  personaMemory: {
    get: (personaId) => ipcRenderer.invoke('persona:memory:get', personaId),
    migrate: (personaId) => ipcRenderer.invoke('persona:memory:migrate', personaId),
    setSituations: (personaId, situations) => ipcRenderer.invoke('persona:memory:setSituations', personaId, situations),
    addSituation: (personaId, situation) => ipcRenderer.invoke('persona:memory:addSituation', personaId, situation),
    updateSituation: (personaId, index, updates) => ipcRenderer.invoke('persona:memory:updateSituation', personaId, index, updates),
    removeSituation: (personaId, index) => ipcRenderer.invoke('persona:memory:removeSituation', personaId, index),
    addLearning: (personaId, text) => ipcRenderer.invoke('persona:memory:addLearning', personaId, text),
    removeLearning: (personaId, index) => ipcRenderer.invoke('persona:memory:removeLearning', personaId, index),
    setLearnings: (personaId, learnings) => ipcRenderer.invoke('persona:memory:setLearnings', personaId, learnings),
    addLogEntry: (personaId, summary) => ipcRenderer.invoke('persona:memory:addLogEntry', personaId, summary),
    setLog: (personaId, entries) => ipcRenderer.invoke('persona:memory:setLog', personaId, entries),
  },
  env: {
    list: () => ipcRenderer.invoke('env:list'),
    get: (envId) => ipcRenderer.invoke('env:get', envId),
    create: (opts) => ipcRenderer.invoke('env:create', opts),
    start: (envId, services?) => ipcRenderer.invoke('env:start', envId, services),
    stop: (envId, services?) => ipcRenderer.invoke('env:stop', envId, services),
    teardown: (envId) => ipcRenderer.invoke('env:teardown', envId),
    logs: (envId, service, lines) => ipcRenderer.invoke('env:logs', envId, service, lines),
    restartService: (envId, service) => ipcRenderer.invoke('env:restartService', envId, service),
    manifest: (envId) => ipcRenderer.invoke('env:manifest', envId),
    saveManifest: (envId, manifest) => ipcRenderer.invoke('env:saveManifest', envId, manifest),
    retrySetup: (envId) => ipcRenderer.invoke('env:retrySetup', envId),
    fix: (envId) => ipcRenderer.invoke('env:fix', envId),
    clone: (envId, newName) => ipcRenderer.invoke('env:clone', envId, newName),
    setRestartPolicy: (envId: string, policy: 'manual' | 'on-crash') => ipcRenderer.invoke('env:setRestartPolicy', envId, policy),
    setPurposeTag: (envId: string, tag: 'interactive' | 'background' | 'nightly' | null) => ipcRenderer.invoke('env:setPurposeTag', envId, tag),
    listTemplates: () => ipcRenderer.invoke('env:listTemplates'),
    getTemplate: (id: string) => ipcRenderer.invoke('env:getTemplate', id),
    saveTemplate: (template: any) => ipcRenderer.invoke('env:saveTemplate', template),
    deleteTemplate: (id: string) => ipcRenderer.invoke('env:deleteTemplate', id),
    refreshTemplates: () => ipcRenderer.invoke('env:refreshTemplates'),
    onTemplatesChanged: (cb: (templates: any[]) => void) => {
      const l = (_e: any, templates: any[]) => cb(templates)
      ipcRenderer.on('env:templates-changed', l)
      return () => ipcRenderer.removeListener('env:templates-changed', l)
    },
    onStatusUpdate: (cb) => {
      const l = (_e: any, environments: any[]) => cb(environments)
      ipcRenderer.on('env:list', l)
      return () => ipcRenderer.removeListener('env:list', l)
    },
    onServiceOutput: (cb) => {
      const l = (_e: any, data: { envId: string; service: string; data: string }) => cb(data)
      ipcRenderer.on('env:service-output', l)
      return () => ipcRenderer.removeListener('env:service-output', l)
    },
    onServiceCrashed: (cb) => {
      const l = (_e: any, data: { envId: string; service: string; exitCode: number }) => cb(data)
      ipcRenderer.on('env:service-crashed', l)
      return () => ipcRenderer.removeListener('env:service-crashed', l)
    },
    onPromptRequest: (cb) => {
      const l = (_e: any, data: any) => cb(data)
      ipcRenderer.on('env:prompt-request', l)
      return () => ipcRenderer.removeListener('env:prompt-request', l)
    },
    respondToPrompt: (data) => { ipcRenderer.send('env:prompt-response', data) },
    pickFile: (opts) => ipcRenderer.invoke('env:pickFile', opts),
    launchSessionWhenReady: (opts) => ipcRenderer.invoke('env:launchSessionWhenReady', opts),
    cancelPendingLaunch: (pendingId: string) => ipcRenderer.invoke('env:cancelPendingLaunch', pendingId),
    getPendingLaunches: (envId?: string) => ipcRenderer.invoke('env:getPendingLaunches', envId),
    onPendingLaunchStatus: (cb) => {
      const l = (_e: any, record: PendingLaunchRecord) => cb(record)
      ipcRenderer.on('pendingLaunch:status', l)
      return () => ipcRenderer.removeListener('pendingLaunch:status', l)
    },
    onPendingLaunchSpawned: (cb) => {
      const l = (_e: any, data: { pendingId: string; envId: string; instanceId: string; autoHeal: boolean; timedOut?: boolean }) => cb(data)
      ipcRenderer.on('pendingLaunch:spawned', l)
      return () => ipcRenderer.removeListener('pendingLaunch:spawned', l)
    },
  },
  activity: {
    list: () => ipcRenderer.invoke('activity:list'),
    forDate: (date: string) => ipcRenderer.invoke('activity:forDate', date),
    markRead: () => ipcRenderer.invoke('activity:markRead'),
    unreadCount: () => ipcRenderer.invoke('activity:unreadCount'),
    clear: () => ipcRenderer.invoke('activity:clear'),
    onNew: (cb) => {
      const l = (_e: any, data: { event: ActivityEvent; unreadCount: number }) => cb(data)
      ipcRenderer.on('activity:new', l)
      return () => ipcRenderer.removeListener('activity:new', l)
    },
    onUnread: (cb) => {
      const l = (_e: any, data: { count: number }) => cb(data)
      ipcRenderer.on('activity:unread', l)
      return () => ipcRenderer.removeListener('activity:unread', l)
    },
  },
  mcp: {
    list: () => ipcRenderer.invoke('mcp:list'),
    save: (server, originalName) => ipcRenderer.invoke('mcp:save', server, originalName),
    delete: (name) => ipcRenderer.invoke('mcp:delete', name),
    getAuditLog: () => ipcRenderer.invoke('mcp:getAuditLog'),
    clearAuditLog: () => ipcRenderer.invoke('mcp:clearAuditLog'),
    test: (server) => ipcRenderer.invoke('mcp:test', server),
  },
  session: {
    sendMessage: (targetName, text) => ipcRenderer.invoke('session:sendMessage', targetName, text),
    steer: (instanceId, message) => ipcRenderer.invoke('session:steer', instanceId, message),
    getAttributedCommits: (dir) => ipcRenderer.invoke('session:getAttributedCommits', dir),
    clearCommitAttributions: () => ipcRenderer.invoke('session:clearCommitAttributions'),
    gitChanges: (dir) => ipcRenderer.invoke('session:gitChanges', dir),
    getFileDiff: (dir, filePath, fileStatus) => ipcRenderer.invoke('session:getFileDiff', dir, filePath, fileStatus),
    gitRevert: (dir, file) => ipcRenderer.invoke('session:gitRevert', dir, file),
    scoreOutput: (dir) => ipcRenderer.invoke('session:scoreOutput', dir),
    getComments: (instanceId) => ipcRenderer.invoke('session:getComments', instanceId),
    onComments: (callback) => {
      const listener = (_e: any, data: { instanceId: string; comments: ColonyComment[] }) => callback(data)
      ipcRenderer.on('session:comments', listener)
      return () => ipcRenderer.removeListener('session:comments', listener)
    },
    getCoordinatorTeam: (sessionId) => ipcRenderer.invoke('session:getCoordinatorTeam', sessionId) as Promise<CoordinatorTeam | null>,
    getContextUsage: (sessionId) => ipcRenderer.invoke('session:getContextUsage', sessionId),
    tokenizeApproximate: (text) => ipcRenderer.invoke('session:tokenizeApproximate', text),
    exportMarkdown: (instanceId) => ipcRenderer.invoke('session:exportMarkdown', instanceId),
    exportMarkdownToFile: (instanceId) => ipcRenderer.invoke('session:exportMarkdownToFile', instanceId),
  },
  audit: {
    runPanel: (panel, context) => ipcRenderer.invoke('audit:runPanel', panel, context),
    getLastRun: (panel) => ipcRenderer.invoke('audit:getLastRun', panel),
  },
  git: {
    stage: (cwd, files) => ipcRenderer.invoke('git:stage', cwd, files),
    commit: (cwd, message) => ipcRenderer.invoke('git:commit', cwd, message),
    push: (cwd) => ipcRenderer.invoke('git:push', cwd),
    branchInfo: (cwd) => ipcRenderer.invoke('git:branchInfo', cwd),
    unpushedCommits: (cwd) => ipcRenderer.invoke('git:unpushedCommits', cwd),
    commitDiff: (cwd, hash) => ipcRenderer.invoke('git:commitDiff', cwd, hash),
  },
  arena: {
    recordWinner: (winnerKey, loserKey, matchCtx) => ipcRenderer.invoke('arena:recordWinner', winnerKey, loserKey, matchCtx),
    getStats: () => ipcRenderer.invoke('arena:getStats'),
    getMatchHistory: () => ipcRenderer.invoke('arena:getMatchHistory'),
    clearStats: () => ipcRenderer.invoke('arena:clearStats'),
    launchWithWorktrees: (opts) => ipcRenderer.invoke('arena:launchWithWorktrees', opts),
    cleanupWorktrees: (ids) => ipcRenderer.invoke('arena:cleanupWorktrees', ids),
    autoJudge: (opts) => ipcRenderer.invoke('arena:autoJudge', opts),
  },
  fork: {
    create: (parentId, opts) => ipcRenderer.invoke('fork:create', parentId, opts),
    getGroups: () => ipcRenderer.invoke('fork:getGroups'),
    pickWinner: (groupId, winnerId) => ipcRenderer.invoke('fork:pickWinner', groupId, winnerId),
    discard: (groupId, forkId) => ipcRenderer.invoke('fork:discard', groupId, forkId),
    onGroups: (cb) => {
      const l = (_e: any, groups: ForkGroup[]) => cb(groups)
      ipcRenderer.on('fork:groups', l)
      return () => ipcRenderer.removeListener('fork:groups', l)
    },
  },
  sessionTemplates: {
    list: () => ipcRenderer.invoke('sessionTemplates:list'),
    save: (template) => ipcRenderer.invoke('sessionTemplates:save', template),
    delete: (id) => ipcRenderer.invoke('sessionTemplates:delete', id),
    launch: (id) => ipcRenderer.invoke('sessionTemplates:launch', id),
  },
  outputs: {
    list: () => ipcRenderer.invoke('outputs:list'),
    read: (filePath) => ipcRenderer.invoke('outputs:read', filePath),
    search: (query) => ipcRenderer.invoke('outputs:search', query),
    delete: (filePath) => ipcRenderer.invoke('outputs:delete', filePath),
    revealInFinder: (filePath) => ipcRenderer.invoke('outputs:revealInFinder', filePath),
    copyPath: (filePath) => ipcRenderer.invoke('outputs:copyPath', filePath),
  },
  approvalRules: {
    list: () => ipcRenderer.invoke('approvalRules:list'),
    create: (name, type, condition, action) =>
      ipcRenderer.invoke('approvalRules:create', name, type, condition, action),
    update: (id, updates) => ipcRenderer.invoke('approvalRules:update', id, updates),
    delete: (id) => ipcRenderer.invoke('approvalRules:delete', id),
  },
  batch: {
    getConfig: () => ipcRenderer.invoke('batch:getConfig'),
    setConfig: (config) => ipcRenderer.invoke('batch:setConfig', config),
    getHistory: (limit) => ipcRenderer.invoke('batch:getHistory', limit),
    runNow: () => ipcRenderer.invoke('batch:runNow'),
    onStarted: (cb) => { const h = (_: any, d: any) => cb(d); ipcRenderer.on('batch:started', h); return () => ipcRenderer.removeListener('batch:started', h) },
    onTaskComplete: (cb) => { const h = (_: any, d: any) => cb(d); ipcRenderer.on('batch:taskComplete', h); return () => ipcRenderer.removeListener('batch:taskComplete', h) },
    onCompleted: (cb) => { const h = (_: any, d: any) => cb(d); ipcRenderer.on('batch:completed', h); return () => ipcRenderer.removeListener('batch:completed', h) },
  },
  team: {
    getMetrics: (window) => ipcRenderer.invoke('team:getMetrics', window),
    getWorkerHistory: (workerId, limit, status) => ipcRenderer.invoke('team:getWorkerHistory', workerId, limit, status),
    exportCsv: (window) => ipcRenderer.invoke('team:exportCsv', window),
  },
  appUpdate: {
    getStatus: () => ipcRenderer.invoke('appUpdate:getStatus'),
    checkNow: () => ipcRenderer.invoke('appUpdate:checkNow'),
    download: () => ipcRenderer.invoke('appUpdate:download'),
    quitAndInstall: () => ipcRenderer.invoke('appUpdate:quitAndInstall'),
    getAutoEnabled: () => ipcRenderer.invoke('appUpdate:getAutoEnabled'),
    setAutoEnabled: (enabled) => ipcRenderer.invoke('appUpdate:setAutoEnabled', enabled),
    onStatus: (cb) => {
      const l = (_e: any, s: UpdateStatus) => cb(s)
      ipcRenderer.on('app:updateStatus', l)
      return () => ipcRenderer.removeListener('app:updateStatus', l)
    },
    onAvailable: (cb) => {
      const l = (_e: any, info: UpdateInfo) => cb(info)
      ipcRenderer.on('app:updateAvailable', l)
      return () => ipcRenderer.removeListener('app:updateAvailable', l)
    },
    onReady: (cb) => {
      const l = (_e: any, info: UpdateInfo) => cb(info)
      ipcRenderer.on('app:updateReady', l)
      return () => ipcRenderer.removeListener('app:updateReady', l)
    },
    onDownloadProgress: (cb) => {
      const l = (_e: any, p: { percent: number; bytesPerSecond: number; total: number }) => cb(p)
      ipcRenderer.on('app:updateDownloadProgress', l)
      return () => ipcRenderer.removeListener('app:updateDownloadProgress', l)
    },
    onError: (cb) => {
      const l = (_e: any, err: { message: string }) => cb(err)
      ipcRenderer.on('app:updateError', l)
      return () => ipcRenderer.removeListener('app:updateError', l)
    },
  },
  onboarding: {
    getState: () => ipcRenderer.invoke('onboarding:getState'),
    markComplete: (key) => ipcRenderer.invoke('onboarding:markComplete', key),
    skip: () => ipcRenderer.invoke('onboarding:skip'),
    replay: () => ipcRenderer.invoke('onboarding:replay'),
    reset: () => ipcRenderer.invoke('onboarding:reset'),
    onStateChanged: (cb) => {
      const l = (_e: any, s: OnboardingState) => cb(s)
      ipcRenderer.on('onboarding:stateChanged', l)
      return () => ipcRenderer.removeListener('onboarding:stateChanged', l)
    },
  },
  prerequisites: {
    check: () => ipcRenderer.invoke('prerequisites:check'),
  },
  worktree: {
    list: () => ipcRenderer.invoke('worktree:list'),
    get: (id) => ipcRenderer.invoke('worktree:get', id),
    create: (owner, name, branch, repoAlias, remoteUrl) => ipcRenderer.invoke('worktree:create', owner, name, branch, repoAlias, remoteUrl),
    mount: (worktreeId, envId) => ipcRenderer.invoke('worktree:mount', worktreeId, envId),
    unmount: (worktreeId) => ipcRenderer.invoke('worktree:unmount', worktreeId),
    remove: (worktreeId) => ipcRenderer.invoke('worktree:remove', worktreeId),
    forEnv: (envId) => ipcRenderer.invoke('worktree:forEnv', envId),
    onChanged: (cb) => {
      const l = () => cb()
      ipcRenderer.on('worktree:changed', l)
      return () => ipcRenderer.removeListener('worktree:changed', l)
    },
  },
  artifacts: {
    list: () => ipcRenderer.invoke('artifacts:list'),
    get: (sessionId) => ipcRenderer.invoke('artifacts:get', sessionId),
    collect: (sessionId) => ipcRenderer.invoke('artifacts:collect', sessionId),
    clear: () => ipcRenderer.invoke('artifacts:clear'),
    tagPipeline: (sessionId, pipelineRunId) => ipcRenderer.invoke('artifacts:tagPipeline', sessionId, pipelineRunId),
  },
  notifications: {
    history: () => ipcRenderer.invoke('notifications:history'),
    markRead: (id) => ipcRenderer.invoke('notifications:markRead', id),
    markAllRead: () => ipcRenderer.invoke('notifications:markAllRead'),
    clearAll: () => ipcRenderer.invoke('notifications:clearAll'),
    unreadCount: () => ipcRenderer.invoke('notifications:unreadCount'),
    onNew: (cb) => {
      const listener = (_e: any, entry: NotificationEntry) => cb(entry)
      ipcRenderer.on('notification:new', listener)
      return () => ipcRenderer.removeListener('notification:new', listener)
    },
  },
}

contextBridge.exposeInMainWorld('api', api)
