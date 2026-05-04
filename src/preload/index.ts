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
  PersonaAttentionRequest,
  PlaybookDef,
  ProofEntry,
} from '../shared/types'
import type { InstanceManifest } from '../daemon/env-protocol'

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
  PersonaAttentionRequest,
  PlaybookDef,
  ProofEntry,
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
      permissionMode?: 'autonomous' | 'supervised' | 'auto'
      env?: Record<string, string>
      ticket?: { source: 'jira'; key: string; summary: string; url?: string }
      playbook?: string
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
    onAutoTags: (callback: (data: { id: string; tags: string[] }) => void) => () => void
    onProof: (callback: (data: { id: string; path: string }) => void) => () => void
    clearToolDeferred: (id: string) => Promise<boolean>
    fileOverlaps: () => Promise<Record<string, { file: string; otherSessions: { id: string; name: string }[] }[]>>
    stopChildren: (parentId: string) => Promise<number>
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
    launchReview: (sessionId: string, model: string) => Promise<string>
  }
  daemon: {
    restart: () => Promise<void>
    getVersion: () => Promise<{ running: number; expected: number }>
    startUpgrade: () => Promise<void>
    migrateInstance: (id: string) => Promise<unknown>
    migrateAll: () => Promise<void>
    getUpgradeState: () => Promise<{ state: string; remaining: number }>
    onVersionMismatch: (cb: (info: { running: number; expected: number }) => void) => () => void
    onConnectionFailed: (cb: (info: { error: string }) => void) => () => void
    onDaemonUnresponsive: (cb: () => void) => () => void
    onUpgradeStarted: (cb: () => void) => () => void
    onUpgradeDraining: (cb: (info: { remaining: number }) => void) => () => void
    onUpgradeComplete: (cb: () => void) => () => void
    onInstanceMigrated: (cb: (info: { oldId: string; newId: string }) => void) => () => void
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
    openPath: (filePath: string) => Promise<string>
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
    onQuickCompare: (cb: () => void) => () => void
    onNavigate: (cb: (route: string | Record<string, unknown>) => void) => () => void
  }
  fs: {
    listDir: (dirPath: string, depth?: number) => Promise<any[]>
    readFile: (filePath: string) => Promise<{ content?: string; error?: string }>
    readBinary: (filePath: string) => Promise<{ dataUrl?: string; error?: string }>
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
    createReviewComment: (repo: GitHubRepo, prNumber: number, body: string, commitId: string, path: string, line: number, side: 'LEFT' | 'RIGHT') => Promise<import('../shared/types').PRComment>
    replyToComment: (repo: GitHubRepo, prNumber: number, commentId: number, body: string) => Promise<import('../shared/types').PRComment>
    requestReviewers: (repo: GitHubRepo, prNumber: number, usernames: string[]) => Promise<void>
    closePR: (repo: GitHubRepo, prNumber: number, deleteBranch: boolean) => Promise<void>
    updatePR: (repo: GitHubRepo, prNumber: number, fields: { title?: string; body?: string }) => Promise<void>
    markPRReady: (repo: GitHubRepo, prNumber: number) => Promise<void>
  }
  jira: {
    fetchTicket: (key: string) => Promise<{ ok: true; ticket: import('../shared/types').JiraTicket } | { ok: false; error: string }>
    myTickets: () => Promise<{ ok: true; tickets: import('../shared/types').JiraTicketSummary[] } | { ok: false; error: string }>
    transitionTicket: (key: string) => Promise<{ ok: true; transitionName: string } | { ok: false; error: string }>
    addComment: (key: string, body: string) => Promise<{ ok: boolean; error?: string }>
  }
  colony: {
    updateContext: () => Promise<string>
    getContextPath: () => Promise<string>
    getContextInstruction: () => Promise<string>
    writePromptFile: (content: string) => Promise<string>
    rateLimitStatus: () => Promise<{ paused: boolean; resetAt: number | null; lastError: string; detectedAt: number | null; utilization: number | null; rateLimitType: string | null; status: string | null; source: string | null }>
    resumeCrons: () => Promise<void>
    probeRateLimit: () => Promise<{ status: string; utilization?: number; resetsAt?: number; rateLimitType?: string } | null>
    onRateLimitChange: (cb: (state: { paused: boolean; resetAt: number | null; lastError: string; detectedAt: number | null; utilization: number | null; rateLimitType: string | null; status: string | null; source: string | null }) => void) => () => void
    listSpecs: () => Promise<Array<{ name: string; title: string; status: string; updatedAt: string }>>
    readSpec: (name: string) => Promise<string | null>
    archiveSpec: (name: string) => Promise<boolean>
    getUsageSummary: () => Promise<{ todayCost: number; budget: number | null; rateLimited: boolean; resetAt: number | null }>
    onUsageUpdate: (cb: (summary: { todayCost: number; budget: number | null; rateLimited: boolean; resetAt: number | null }) => void) => () => void
    setCronsPaused: (paused: boolean) => Promise<void>
    getCronsPaused: () => Promise<boolean>
    onCronsPauseChange: (cb: (paused: boolean) => void) => () => void
    readKnowledge: () => Promise<Array<{ id: number; date: string; source: string; text: string; raw: string }>>
    appendKnowledge: (text: string) => Promise<void>
    deleteKnowledge: (rawLine: string) => Promise<void>
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
      lastMatchAt: string | null
      lastFiredAt: string | null
      lastError: string | null
      fireCount: number
      debugLog: string[]
    }>>
    toggle: (name: string, enabled: boolean) => Promise<boolean>
    pause: (name: string, durationMs: number | null) => Promise<boolean>
    resume: (name: string) => Promise<boolean>
    triggerNow: (name: string, overrides?: string | { prompt?: string; model?: string; workingDirectory?: string; maxBudget?: number; templateVarOverrides?: Record<string, string> }) => Promise<boolean>
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
    getHistory: (name: string) => Promise<Array<{ ts: string; trigger: string; actionExecuted: boolean; success: boolean; durationMs: number; totalCost?: number; stages?: Array<{ index: number; actionType: string; sessionName?: string; durationMs: number; success: boolean; error?: string }> }>>
    searchHistory: (query: string) => Promise<Array<{ pipelineName: string; entry: { ts: string; trigger: string; actionExecuted: boolean; success: boolean; durationMs: number; totalCost?: number }; matchField: string }>>
    getDebugLog: (name: string) => Promise<string[]>
    createFromTemplate: (yaml: string, slug: string) => Promise<boolean>
    generate: (description: string) => Promise<string>
    delete: (fileName: string) => Promise<boolean>
    export: (fileNames: string[]) => Promise<boolean>
    import: () => Promise<number>
    getNotes: (fileName: string) => Promise<Array<{ createdAt: string; text: string }>>
    addNote: (fileName: string, text: string) => Promise<boolean>
    deleteNote: (fileName: string, index: number) => Promise<boolean>
    updateNote: (fileName: string, index: number, newText: string) => Promise<boolean>
    listArtifacts: () => Promise<Array<{ name: string; size: number; modifiedAt: string }>>
    readArtifact: (name: string) => Promise<string | null>
    getReviewRules: () => Promise<Array<{ id: string; pattern: string; severity: string; repo: string; createdAt: string; source: string }>>
    deleteReviewRule: (id: string) => Promise<boolean>
  }
  persona: {
    list: () => Promise<PersonaInfo[]>
    getContent: (fileName: string) => Promise<{ content: string | null; mtime: number | null }>
    saveContent: (fileName: string, content: string) => Promise<boolean>
    create: (name: string) => Promise<{ fileName: string } | null>
    delete: (fileName: string) => Promise<boolean>
    duplicate: (personaId: string) => Promise<string | null>
    run: (fileName: string) => Promise<string>
    runWithOptions: (fileName: string, overrides: { model?: string; maxCostUsd?: number; promptPrefix?: string }) => Promise<string>
    stop: (fileName: string) => Promise<boolean>
    toggle: (fileName: string, enabled: boolean) => Promise<boolean>
    drain: (fileName: string) => Promise<boolean>
    getDir: () => Promise<string>
    setSchedule: (fileName: string, schedule: string) => Promise<boolean>
    whisper: (fileName: string, text: string) => Promise<boolean>
    deleteNote: (fileName: string, index: number) => Promise<boolean>
    updateNote: (fileName: string, index: number, newText: string) => Promise<boolean>
    updateMeta: (fileName: string, updates: Record<string, string | boolean | number | string[]>) => Promise<boolean>
    getArtifacts: (personaId: string) => Promise<PersonaArtifact[]>
    readArtifact: (personaId: string, filename: string) => Promise<string | null>
    briefDiff: (personaId: string) => Promise<string | null>
    briefHistory: (id: string) => Promise<Array<{ index: number; timestamp: string; preview: string }>>
    briefAt: (id: string, index: number) => Promise<string | null>
    ask: (query: string) => Promise<string>
    getRunHistory: (personaId: string) => Promise<PersonaRunEntry[]>
    getAnalytics: (personaId: string) => Promise<PersonaAnalytics>
    getColonyCostTrend: () => Promise<{ date: string; cost: number }[]>
    healthSummary: () => Promise<PersonaHealthEntry[]>
    getAllAttention: () => Promise<PersonaAttentionRequest[]>
    resolveAttention: (personaId: string, attnId: string, response?: string) => Promise<boolean>
    dismissAttention: (personaId: string, attnId: string) => Promise<boolean>
    getTemplates: () => Promise<{ id: string; name: string; description: string; builtIn: boolean }[]>
    createFromTemplate: (templateId: string) => Promise<{ fileName: string } | null>
    compareConfig: (idA: string, idB: string) => Promise<{ a: { name: string; content: string }; b: { name: string; content: string } } | null>
    searchLearnings: (query: string) => Promise<Array<{ personaId: string; personaName: string; type: string; text: string; matchIndex: number }>>
    previewPrompt: (fileName: string) => Promise<string>
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
    toggleDebug: (envId: string, enabled: boolean, service?: string) => Promise<void>
    setRestartPolicy: (envId: string, policy: 'manual' | 'on-crash') => Promise<void>
    setPurposeTag: (envId: string, tag: 'interactive' | 'background' | 'nightly' | null) => Promise<void>
    listTemplates: () => Promise<any[]>
    getTemplate: (id: string) => Promise<any>
    saveTemplate: (template: any) => Promise<boolean>
    deleteTemplate: (id: string) => Promise<boolean>
    /** Re-scan all repos for .colony/ configs and return merged template list. */
    refreshTemplates: () => Promise<any[]>
    /** Detect whether this env's template has changed since it was created. */
    getDriftStatus: (envId: string) => Promise<'clean' | 'drifted' | 'unknown'>
    /** Accept the current template as the new baseline — clears the drift badge. */
    acceptDriftBaseline: (envId: string) => Promise<{ ok: boolean; baseline?: string; reason?: string }>
    /** Return which top-level template fields changed (e.g. ['services', 'ports']). Empty when clean or snapshot missing. */
    getDriftFields: (envId: string) => Promise<string[]>
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
    readClaudeMd: (envId: string, target: 'root' | 'worktree') => Promise<{ exists: boolean; content: string; path: string }>
    regenerateClaudeMd: (envId: string) => Promise<{ writtenPaths: string[] }>
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
    list: () => Promise<Array<{ name: string; command?: string; args?: string[]; url?: string; description?: string; env?: Record<string, string>; source?: 'manual' | 'gh-skill' }>>
    save: (server: { name: string; command?: string; args?: string[]; url?: string; description?: string; env?: Record<string, string> }, originalName?: string) => Promise<Array<{ name: string; command?: string; args?: string[]; url?: string; description?: string; env?: Record<string, string>; source?: 'manual' | 'gh-skill' }>>
    delete: (name: string) => Promise<Array<{ name: string; command?: string; args?: string[]; url?: string; description?: string; env?: Record<string, string>; source?: 'manual' | 'gh-skill' }>>
    getAuditLog: () => Promise<McpAuditEntry[]>
    clearAuditLog: () => Promise<void>
    test: (server: { name: string; command?: string; args?: string[]; url?: string; env?: Record<string, string> }) => Promise<{ ok: boolean; message: string }>
    refreshSkills: () => Promise<Array<{ name: string; command?: string; args?: string[]; url?: string; description?: string; env?: Record<string, string>; source?: 'manual' | 'gh-skill' }>>
    ignoreGhSkill: (name: string) => Promise<Array<{ name: string; command?: string; args?: string[]; url?: string; description?: string; env?: Record<string, string>; source?: 'manual' | 'gh-skill' }>>
  }
  session: {
    sendMessage: (targetName: string, text: string) => Promise<boolean>
    steer: (instanceId: string, message: string) => Promise<boolean>
    getAttributedCommits: (dir?: string) => Promise<CommitAttribution[]>
    clearCommitAttributions: () => Promise<void>
    gitChanges: (dir: string) => Promise<GitDiffEntry[]>
    getFileDiff: (dir: string, filePath: string, fileStatus?: string, ignoreWhitespace?: boolean) => Promise<string>
    gitRevert: (dir: string, file: string) => Promise<boolean>
    scoreOutput: (instanceId: string, dir: string) => Promise<ScoreCard>
    getDiffHash: (dir: string) => Promise<string | null>
    getCachedScoreCard: (instanceId: string, diffHash: string) => Promise<ScoreCard | null>
    clearScoreCard: (instanceId: string) => Promise<void>
    getComments: (instanceId: string) => Promise<ColonyComment[]>
    onComments: (callback: (data: { instanceId: string; comments: ColonyComment[] }) => void) => () => void
    getCoordinatorTeam: (sessionId: string) => Promise<CoordinatorTeam | null>
    getContextUsage: (sessionId: string) => Promise<ContextUsage | null>
    getAllContextUsage: () => Promise<ContextUsage[]>
    tokenizeApproximate: (text: string) => Promise<number>
    exportMarkdown: (instanceId: string) => Promise<string>
    exportMarkdownToFile: (instanceId: string) => Promise<boolean>
    addOutputAlert: (instanceId: string, alert: { id: string; pattern: string; isRegex: boolean; oneShot: boolean }) => Promise<void>
    removeOutputAlert: (instanceId: string, alertId: string) => Promise<void>
    getOutputAlerts: (instanceId: string) => Promise<Array<{ id: string; pattern: string; isRegex: boolean; oneShot: boolean }>>
    onAlertsChanged: (callback: (data: { instanceId: string; alerts: Array<{ id: string; pattern: string; isRegex: boolean; oneShot: boolean }> }) => void) => () => void
    onAlertMatched: (callback: (data: { instanceId: string; alertId: string }) => void) => () => void
  }
  git: {
    stage: (cwd: string, files: string[]) => Promise<void>
    unstage: (cwd: string, files: string[]) => Promise<void>
    commit: (cwd: string, message: string, amend?: boolean) => Promise<string>
    lastCommitMessage: (cwd: string) => Promise<string | null>
    push: (cwd: string) => Promise<void>
    branchInfo: (cwd: string) => Promise<{ branch: string; remote: string | null; ahead: number }>
    unpushedCommits: (cwd: string) => Promise<Array<{ hash: string; subject: string; author: string; date: string }>>
    log: (cwd: string, limit?: number, skip?: number, author?: string) => Promise<Array<{ hash: string; subject: string; author: string; date: string; filesChanged?: number; insertions?: number; deletions?: number; parents?: string[]; refs?: string[] }>>
    commitFiles: (cwd: string, hash: string) => Promise<Array<{ file: string; status: string; insertions: number; deletions: number }>>
    commitDiff: (cwd: string, hash: string) => Promise<string>
    createBranch: (cwd: string, name: string, startPoint?: string) => Promise<string>
    fetch: (cwd: string) => Promise<{ success: boolean; error?: string }>
    fetchRemote: (cwd: string, remote: string) => Promise<{ success: boolean; error?: string }>
    pull: (cwd: string) => Promise<{ success: boolean; error?: string }>
    behindCount: (cwd: string) => Promise<number>
    listBranches: (cwd: string, includeRemote?: boolean) => Promise<Array<{ name: string; current: boolean; remote: boolean }>>
    switchBranch: (cwd: string, branch: string) => Promise<{ success: boolean; error?: string }>
    createTag: (cwd: string, tagName: string) => Promise<void>
    listTags: (cwd: string, prefix: string) => Promise<Array<{ tag: string; date: string; hash: string }>>
    deleteTag: (cwd: string, tagName: string) => Promise<void>
    deleteTags: (cwd: string, prefix: string) => Promise<number>
    listAllTags: (cwd: string) => Promise<Array<{ tag: string; date: string; hash: string }>>
    createGeneralTag: (cwd: string, tagName: string, message?: string) => Promise<void>
    deleteGeneralTag: (cwd: string, tagName: string) => Promise<void>
    pushTag: (cwd: string, tagName: string) => Promise<void>
    diffRange: (cwd: string, from: string, to?: string, ignoreWhitespace?: boolean) => Promise<{ stat: string; diff: string }>
    diffRangeFile: (cwd: string, from: string, to: string, file: string) => Promise<string>
    createPR: (cwd: string, title: string, body: string, baseBranch?: string, draft?: boolean) => Promise<{ url: string }>
    prTemplate: (cwd: string) => Promise<string | null>
    defaultBranch: (cwd: string) => Promise<string>
    fileDiff: (cwd: string, file: string) => Promise<string>
    undoLastCommit: (cwd: string) => Promise<void>
    resetSoft: (cwd: string, targetHash: string) => Promise<void>
    reflog: (cwd: string, limit?: number, skip?: number) => Promise<Array<{ hash: string; ref: string; action: string; relativeTime: string }>>
    resetHard: (cwd: string, hash: string) => Promise<void>
    remoteList: (cwd: string) => Promise<Array<{ name: string; fetchUrl: string; pushUrl: string }>>
    remoteAdd: (cwd: string, name: string, url: string) => Promise<{ success: boolean; error?: string }>
    remoteRemove: (cwd: string, name: string) => Promise<{ success: boolean; error?: string }>
    stashPush: (cwd: string, message?: string, files?: string[]) => Promise<void>
    stashList: (cwd: string) => Promise<Array<{ index: number; message: string; date: string }>>
    stashApply: (cwd: string, index: number) => Promise<void>
    stashPop: (cwd: string, index: number) => Promise<void>
    stashDrop: (cwd: string, index: number) => Promise<void>
    stashShow: (cwd: string, index: number) => Promise<{ stat: string; diff: string }>
    stashFileDiff: (cwd: string, index: number, file: string) => Promise<string>
    branchAheadBehind: (cwd: string, branches: string[]) => Promise<Record<string, { ahead: number; behind: number }>>
    deleteBranch: (cwd: string, branch: string, force?: boolean) => Promise<{ success: boolean; error?: string }>
    renameBranch: (cwd: string, newName: string) => Promise<{ success: boolean; error?: string; hasUpstream: boolean }>
    pruneRemote: (cwd: string) => Promise<void>
    fileLog: (cwd: string, filePath: string, limit?: number, skip?: number) => Promise<Array<{ hash: string; subject: string; author: string; date: string; filesChanged?: number; insertions?: number; deletions?: number }>>
    fileCommitDiff: (cwd: string, hash: string, filePath: string) => Promise<string>
    blame: (cwd: string, filePath: string) => Promise<Array<{ hash: string; author: string; date: string; lineNumber: number; content: string }>>
    cherryPick: (cwd: string, hash: string) => Promise<{ success: boolean; error?: string }>
    cherryPickAbort: (cwd: string) => Promise<void>
    merge: (cwd: string, branch: string, noFf?: boolean) => Promise<{ success: boolean; error?: string; conflicts?: string[] }>
    mergePreview: (cwd: string, branch: string) => Promise<{ files: Array<{ file: string; insertions: number; deletions: number }>; totalInsertions: number; totalDeletions: number; fastForward: boolean }>
    mergeAbort: (cwd: string) => Promise<void>
    revert: (cwd: string, hash: string) => Promise<{ success: boolean; error?: string }>
    revertAbort: (cwd: string) => Promise<void>
    conflictState: (cwd: string) => Promise<{ state: 'none' | 'merge' | 'cherry-pick' | 'revert' | 'rebase'; conflictedFiles: string[] }>
    resolveConflict: (cwd: string, file: string, strategy: 'ours' | 'theirs') => Promise<void>
    markResolved: (cwd: string, file: string) => Promise<void>
    completeConflictOp: (cwd: string) => Promise<{ success: boolean; error?: string }>
    rebase: (cwd: string, ontoBranch: string) => Promise<{ success: boolean; error?: string; conflicts?: string[] }>
    rebaseAbort: (cwd: string) => Promise<void>
    rebaseContinue: (cwd: string) => Promise<{ success: boolean; error?: string }>
    rebaseInteractive: (cwd: string, base: string, todoItems: Array<{ action: 'pick' | 'reword' | 'squash' | 'fixup' | 'drop'; hash: string; subject: string; message?: string }>) => Promise<{ success: boolean; error?: string; conflicts?: string[] }>
    searchCommits: (cwd: string, query: string, limit?: number, author?: string) => Promise<Array<{ hash: string; subject: string; author: string; date: string; filesChanged?: number; insertions?: number; deletions?: number; parents?: string[]; refs?: string[] }>>
    stageHunk: (cwd: string, patch: string) => Promise<{ success: boolean; error?: string }>
    discardHunk: (cwd: string, patch: string) => Promise<{ success: boolean; error?: string }>
    addToGitignore: (cwd: string, filePath: string, tracked: boolean) => Promise<{ success: boolean; error?: string }>
    bisectStart: (cwd: string, badHash: string, goodHash: string) => Promise<{ success: boolean; current?: string; remaining?: number; error?: string }>
    bisectMark: (cwd: string, verdict: 'good' | 'bad') => Promise<{ done: boolean; current?: string; remaining?: number; firstBad?: string; firstBadSubject?: string }>
    bisectReset: (cwd: string) => Promise<void>
    bisectLog: (cwd: string) => Promise<string>
    dirtyFileCount: (cwd: string) => Promise<{ count: number }>
    diffShortstat: (cwd: string) => Promise<{ insertions: number; deletions: number }>
    changedFiles: (cwd: string) => Promise<Array<{ file: string; status: string; staged: boolean }>>
    aheadBehindCommits: (cwd: string, branch: string) => Promise<{ ahead: Array<{ hash: string; subject: string }>; behind: Array<{ hash: string; subject: string }> }>
    exportPatch: (cwd: string, mode: 'working' | 'base' | 'commit', options?: { baseBranch?: string; hash?: string; file?: string }) => Promise<string>
    savePatch: (content: string, defaultFilename: string) => Promise<{ saved: boolean; path?: string }>
  }
  ai: {
    suggestPRDescription: (dir: string) => Promise<{ title: string; body: string } | null>
    suggestCommitMessage: (dir: string, files: string[]) => Promise<string | null>
  }
  review: {
    groupChanges: (files: string[], diffSummary: string) => Promise<Array<{ label: string; files: string[] }>>
  }
  audit: {
    runPanel: (panel: string, context: object) => Promise<AuditResult[]>
    getLastRun: (panel: string) => Promise<{ ts: number; issueCount: number } | null>
  }
  arena: {
    recordWinner: (winnerKey: string, loserKey: string | string[], matchCtx?: { prompt?: string; judgeType?: 'manual' | 'command' | 'llm'; models?: (string | null)[]; reason?: string }) => Promise<boolean>
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
    promoteWinner: (opts: {
      winnerWorktreeId: string
      loserWorktreeIds: string[]
      sourceBranch: string
    }) => Promise<{ success: boolean; commitCount?: number; promotedBranch?: string; error?: string; conflictFiles?: string[] }>
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
    create: (owner: string, name: string, branch: string, repoAlias: string, remoteUrl?: string, displayName?: string) => Promise<WorktreeInfo>
    mount: (worktreeId: string, envId: string) => Promise<WorktreeInfo>
    unmount: (worktreeId: string) => Promise<WorktreeInfo>
    remove: (worktreeId: string) => Promise<boolean>
    forEnv: (envId: string) => Promise<WorktreeInfo[]>
    swap: (envId: string, worktreeId: string) => Promise<InstanceManifest>
    onChanged: (cb: () => void) => () => void
    pull: (worktreeId: string) => Promise<
      | { ok: true; before: string; after: string; commitsPulled: number }
      | { ok: false; reason: 'dirty' | 'diverged' | 'detached' | 'not-found' | 'fetch-failed' | 'no-upstream'; message: string }
    >
    status: (worktreeId: string) => Promise<{
      behind: number; ahead: number; dirty: boolean; upToDate: boolean; upstream: string | null; error?: string
    }>
    fetch: (worktreeId: string) => Promise<{ ok: true } | { ok: false; message: string }>
    size: (worktreeId: string) => Promise<{ bytes: number; computedAt: string }>
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
  playbooks: {
    list: () => Promise<PlaybookDef[]>
    get: (name: string) => Promise<PlaybookDef | null>
    getDir: () => Promise<string>
    getMemory: (name: string) => Promise<string>
    getMemoryLineCount: (name: string) => Promise<number>
    appendMemory: (name: string, lines: string[]) => Promise<void>
    clearMemory: (name: string) => Promise<void>
  }
  proofs: {
    list: (dateFrom: string, dateTo: string) => Promise<ProofEntry[]>
    read: (path: string) => Promise<string>
    onNewProof: (cb: (entry: { id: string; path: string }) => void) => () => void
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
    onAutoTags: (callback) => {
      const listener = (_e: any, data: { id: string; tags: string[] }) => callback(data)
      ipcRenderer.on('instance:autoTags', listener)
      return () => ipcRenderer.removeListener('instance:autoTags', listener)
    },
    onProof: (callback) => {
      const listener = (_e: any, data: { id: string; path: string }) => callback(data)
      ipcRenderer.on('instance:proof', listener)
      return () => ipcRenderer.removeListener('instance:proof', listener)
    },
    clearToolDeferred: (id) => ipcRenderer.invoke('instance:clearToolDeferred', id),
    fileOverlaps: () => ipcRenderer.invoke('instances:fileOverlaps'),
    stopChildren: (parentId) => ipcRenderer.invoke('instance:stopChildren', parentId),
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
    launchReview: (sessionId: string, model: string) => ipcRenderer.invoke('sessions:launchReview', sessionId, model) as Promise<string>,
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
    startUpgrade: () => ipcRenderer.invoke('daemon:startUpgrade'),
    migrateInstance: (id: string) => ipcRenderer.invoke('daemon:migrateInstance', id),
    migrateAll: () => ipcRenderer.invoke('daemon:migrateAll'),
    getUpgradeState: () => ipcRenderer.invoke('daemon:upgradeState'),
    onUpgradeStarted: (cb) => {
      const handler = () => cb()
      ipcRenderer.on('daemon:upgrade-started', handler)
      return () => ipcRenderer.removeListener('daemon:upgrade-started', handler)
    },
    onUpgradeDraining: (cb) => {
      const handler = (_e: any, info: { remaining: number }) => cb(info)
      ipcRenderer.on('daemon:upgrade-draining', handler)
      return () => ipcRenderer.removeListener('daemon:upgrade-draining', handler)
    },
    onUpgradeComplete: (cb) => {
      const handler = () => cb()
      ipcRenderer.on('daemon:upgrade-complete', handler)
      return () => ipcRenderer.removeListener('daemon:upgrade-complete', handler)
    },
    onInstanceMigrated: (cb) => {
      const handler = (_e: any, info: { oldId: string; newId: string }) => cb(info)
      ipcRenderer.on('daemon:instance-migrated', handler)
      return () => ipcRenderer.removeListener('daemon:instance-migrated', handler)
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
    openPath: (filePath) => ipcRenderer.invoke('shell:openPath', filePath),
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
    onQuickCompare: (cb) => { const l = () => cb(); ipcRenderer.on('shortcut:quick-compare', l); return () => ipcRenderer.removeListener('shortcut:quick-compare', l) },
    onNavigate: (cb) => { const l = (_e: any, route: string | Record<string, unknown>) => cb(route); ipcRenderer.on('app:navigate', l); return () => ipcRenderer.removeListener('app:navigate', l) },
  },
  fs: {
    listDir: (dirPath, depth) => ipcRenderer.invoke('fs:listDir', dirPath, depth),
    readFile: (filePath) => ipcRenderer.invoke('fs:readFile', filePath),
    readBinary: (filePath) => ipcRenderer.invoke('fs:readBinary', filePath),
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
    createReviewComment: (repo, prNumber, body, commitId, path, line, side) => ipcRenderer.invoke('github:createReviewComment', repo, prNumber, body, commitId, path, line, side),
    replyToComment: (repo, prNumber, commentId, body) => ipcRenderer.invoke('github:replyToComment', repo, prNumber, commentId, body),
    requestReviewers: (repo, prNumber, usernames) => ipcRenderer.invoke('github:requestReviewers', repo, prNumber, usernames),
    closePR: (repo, prNumber, deleteBranch) => ipcRenderer.invoke('github:closePR', repo, prNumber, deleteBranch),
    updatePR: (repo, prNumber, fields) => ipcRenderer.invoke('github:updatePR', repo, prNumber, fields),
    markPRReady: (repo, prNumber) => ipcRenderer.invoke('github:markPRReady', repo, prNumber),
  },
  jira: {
    fetchTicket: (key) => ipcRenderer.invoke('jira:fetchTicket', key),
    myTickets: () => ipcRenderer.invoke('jira:myTickets'),
    transitionTicket: (key) => ipcRenderer.invoke('jira:transitionTicket', key),
    addComment: (key, body) => ipcRenderer.invoke('jira:addComment', key, body),
  },
  colony: {
    updateContext: () => ipcRenderer.invoke('colony:updateContext'),
    getContextPath: () => ipcRenderer.invoke('colony:getContextPath'),
    getContextInstruction: () => ipcRenderer.invoke('colony:getContextInstruction'),
    writePromptFile: (content) => ipcRenderer.invoke('colony:writePromptFile', content),
    rateLimitStatus: () => ipcRenderer.invoke('colony:rateLimitStatus'),
    resumeCrons: () => ipcRenderer.invoke('colony:resumeCrons'),
    probeRateLimit: () => ipcRenderer.invoke('colony:probeRateLimit'),
    onRateLimitChange: (cb) => {
      const listener = (_e: any, state: any) => cb(state)
      ipcRenderer.on('colony:rateLimitChange', listener)
      return () => ipcRenderer.removeListener('colony:rateLimitChange', listener)
    },
    listSpecs: () => ipcRenderer.invoke('colony:listSpecs'),
    readSpec: (name) => ipcRenderer.invoke('colony:readSpec', name),
    archiveSpec: (name) => ipcRenderer.invoke('colony:archiveSpec', name),
    getUsageSummary: () => ipcRenderer.invoke('colony:getUsageSummary'),
    onUsageUpdate: (cb) => {
      const listener = (_e: any, summary: any) => cb(summary)
      ipcRenderer.on('colony:usageUpdate', listener)
      return () => ipcRenderer.removeListener('colony:usageUpdate', listener)
    },
    setCronsPaused: (paused) => ipcRenderer.invoke('colony:setCronsPaused', paused),
    getCronsPaused: () => ipcRenderer.invoke('colony:getCronsPaused'),
    onCronsPauseChange: (cb) => {
      const listener = (_e: any, paused: boolean) => cb(paused)
      ipcRenderer.on('colony:cronsPauseChange', listener)
      return () => ipcRenderer.removeListener('colony:cronsPauseChange', listener)
    },
    readKnowledge: () => ipcRenderer.invoke('colony:readKnowledge'),
    appendKnowledge: (text) => ipcRenderer.invoke('colony:appendKnowledge', text),
    deleteKnowledge: (rawLine) => ipcRenderer.invoke('colony:deleteKnowledge', rawLine),
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
    pause: (name: string, durationMs: number | null) => ipcRenderer.invoke('pipeline:pause', name, durationMs),
    resume: (name: string) => ipcRenderer.invoke('pipeline:resume', name),
    triggerNow: (name, overrides) => ipcRenderer.invoke('pipeline:triggerNow', name, overrides),
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
    searchHistory: (query) => ipcRenderer.invoke('pipeline:searchHistory', query),
    getDebugLog: (name) => ipcRenderer.invoke('pipeline:getDebugLog', name),
    createFromTemplate: (yaml, slug) => ipcRenderer.invoke('pipeline:createFromTemplate', yaml, slug),
    generate: (description) => ipcRenderer.invoke('pipeline:generate', description),
    delete: (fileName) => ipcRenderer.invoke('pipeline:delete', fileName),
    export: (fileNames) => ipcRenderer.invoke('pipeline:export', fileNames),
    import: () => ipcRenderer.invoke('pipeline:import'),
    getNotes: (fileName) => ipcRenderer.invoke('pipeline:getNotes', fileName),
    addNote: (fileName, text) => ipcRenderer.invoke('pipeline:addNote', fileName, text),
    deleteNote: (fileName, index) => ipcRenderer.invoke('pipeline:deleteNote', fileName, index),
    updateNote: (fileName, index, newText) => ipcRenderer.invoke('pipeline:updateNote', fileName, index, newText),
    listArtifacts: () => ipcRenderer.invoke('pipeline:listArtifacts'),
    readArtifact: (name) => ipcRenderer.invoke('pipeline:readArtifact', name),
    getReviewRules: () => ipcRenderer.invoke('pipeline:getReviewRules'),
    deleteReviewRule: (id) => ipcRenderer.invoke('pipeline:deleteReviewRule', id),
  },
  persona: {
    list: () => ipcRenderer.invoke('persona:list'),
    getContent: (fileName) => ipcRenderer.invoke('persona:getContent', fileName),
    saveContent: (fileName, content) => ipcRenderer.invoke('persona:saveContent', fileName, content),
    create: (name) => ipcRenderer.invoke('persona:create', name),
    delete: (fileName) => ipcRenderer.invoke('persona:delete', fileName),
    duplicate: (personaId) => ipcRenderer.invoke('persona:duplicate', personaId) as Promise<string | null>,
    run: (fileName) => ipcRenderer.invoke('persona:run', fileName),
    runWithOptions: (fileName, overrides) => ipcRenderer.invoke('persona:runWithOptions', fileName, overrides) as Promise<string>,
    stop: (fileName) => ipcRenderer.invoke('persona:stop', fileName),
    toggle: (fileName, enabled) => ipcRenderer.invoke('persona:toggle', fileName, enabled),
    drain: (fileName) => ipcRenderer.invoke('persona:drain', fileName),
    getDir: () => ipcRenderer.invoke('persona:getDir'),
    setSchedule: (fileName, schedule) => ipcRenderer.invoke('persona:setSchedule', fileName, schedule),
    whisper: (fileName, text) => ipcRenderer.invoke('persona:whisper', fileName, text),
    deleteNote: (fileName, index) => ipcRenderer.invoke('persona:deleteNote', fileName, index),
    updateNote: (fileName, index, newText) => ipcRenderer.invoke('persona:updateNote', fileName, index, newText),
    updateMeta: (fileName, updates) => ipcRenderer.invoke('persona:updateMeta', fileName, updates),
    getArtifacts: (personaId) => ipcRenderer.invoke('persona:getArtifacts', personaId),
    readArtifact: (personaId, filename) => ipcRenderer.invoke('persona:readArtifact', personaId, filename),
    briefDiff: (personaId) => ipcRenderer.invoke('persona:briefDiff', personaId),
    briefHistory: (id) => ipcRenderer.invoke('persona:briefHistory', id),
    briefAt: (id, index) => ipcRenderer.invoke('persona:briefAt', id, index),
    ask: (query) => ipcRenderer.invoke('persona:ask', query),
    getRunHistory: (personaId) => ipcRenderer.invoke('persona:getRunHistory', personaId),
    getAnalytics: (personaId) => ipcRenderer.invoke('persona:analytics', personaId),
    getColonyCostTrend: () => ipcRenderer.invoke('persona:analytics:colony'),
    healthSummary: () => ipcRenderer.invoke('persona:healthSummary'),
    getAllAttention: () => ipcRenderer.invoke('persona:getAllAttention'),
    resolveAttention: (personaId, attnId, response?) => ipcRenderer.invoke('persona:resolveAttention', personaId, attnId, response),
    dismissAttention: (personaId, attnId) => ipcRenderer.invoke('persona:dismissAttention', personaId, attnId),
    getTemplates: () => ipcRenderer.invoke('persona:getTemplates'),
    createFromTemplate: (templateId) => ipcRenderer.invoke('persona:createFromTemplate', templateId),
    compareConfig: (idA, idB) => ipcRenderer.invoke('persona:compareConfig', idA, idB),
    searchLearnings: (query) => ipcRenderer.invoke('persona:searchLearnings', query),
    previewPrompt: (fileName) => ipcRenderer.invoke('persona:previewPrompt', fileName),
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
    toggleDebug: (envId: string, enabled: boolean, service?: string) => ipcRenderer.invoke('env:toggleDebug', envId, enabled, service),
    setRestartPolicy: (envId: string, policy: 'manual' | 'on-crash') => ipcRenderer.invoke('env:setRestartPolicy', envId, policy),
    setPurposeTag: (envId: string, tag: 'interactive' | 'background' | 'nightly' | null) => ipcRenderer.invoke('env:setPurposeTag', envId, tag),
    listTemplates: () => ipcRenderer.invoke('env:listTemplates'),
    getTemplate: (id: string) => ipcRenderer.invoke('env:getTemplate', id),
    saveTemplate: (template: any) => ipcRenderer.invoke('env:saveTemplate', template),
    deleteTemplate: (id: string) => ipcRenderer.invoke('env:deleteTemplate', id),
    refreshTemplates: () => ipcRenderer.invoke('env:refreshTemplates'),
    getDriftStatus: (envId: string) => ipcRenderer.invoke('env:getDriftStatus', envId),
    acceptDriftBaseline: (envId: string) => ipcRenderer.invoke('env:acceptDriftBaseline', envId),
    getDriftFields: (envId: string) => ipcRenderer.invoke('env:getDriftFields', envId),
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
    readClaudeMd: (envId: string, target: 'root' | 'worktree') => ipcRenderer.invoke('env:readClaudeMd', envId, target),
    regenerateClaudeMd: (envId: string) => ipcRenderer.invoke('env:regenerateClaudeMd', envId),
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
    refreshSkills: () => ipcRenderer.invoke('mcp:refreshSkills'),
    ignoreGhSkill: (name) => ipcRenderer.invoke('mcp:ignoreGhSkill', name),
  },
  session: {
    sendMessage: (targetName, text) => ipcRenderer.invoke('session:sendMessage', targetName, text),
    steer: (instanceId, message) => ipcRenderer.invoke('session:steer', instanceId, message),
    getAttributedCommits: (dir) => ipcRenderer.invoke('session:getAttributedCommits', dir),
    clearCommitAttributions: () => ipcRenderer.invoke('session:clearCommitAttributions'),
    gitChanges: (dir) => ipcRenderer.invoke('session:gitChanges', dir),
    getFileDiff: (dir, filePath, fileStatus, ignoreWhitespace) => ipcRenderer.invoke('session:getFileDiff', dir, filePath, fileStatus, ignoreWhitespace),
    gitRevert: (dir, file) => ipcRenderer.invoke('session:gitRevert', dir, file),
    scoreOutput: (instanceId, dir) => ipcRenderer.invoke('session:scoreOutput', instanceId, dir),
    getDiffHash: (dir) => ipcRenderer.invoke('session:getDiffHash', dir),
    getCachedScoreCard: (instanceId, diffHash) => ipcRenderer.invoke('session:getCachedScoreCard', instanceId, diffHash),
    clearScoreCard: (instanceId) => ipcRenderer.invoke('session:clearScoreCard', instanceId),
    getComments: (instanceId) => ipcRenderer.invoke('session:getComments', instanceId),
    onComments: (callback) => {
      const listener = (_e: any, data: { instanceId: string; comments: ColonyComment[] }) => callback(data)
      ipcRenderer.on('session:comments', listener)
      return () => ipcRenderer.removeListener('session:comments', listener)
    },
    getCoordinatorTeam: (sessionId) => ipcRenderer.invoke('session:getCoordinatorTeam', sessionId) as Promise<CoordinatorTeam | null>,
    getContextUsage: (sessionId) => ipcRenderer.invoke('session:getContextUsage', sessionId),
    getAllContextUsage: () => ipcRenderer.invoke('session:getAllContextUsage'),
    tokenizeApproximate: (text) => ipcRenderer.invoke('session:tokenizeApproximate', text),
    exportMarkdown: (instanceId) => ipcRenderer.invoke('session:exportMarkdown', instanceId),
    exportMarkdownToFile: (instanceId) => ipcRenderer.invoke('session:exportMarkdownToFile', instanceId),
    addOutputAlert: (instanceId, alert) => ipcRenderer.invoke('session:addOutputAlert', instanceId, alert),
    removeOutputAlert: (instanceId, alertId) => ipcRenderer.invoke('session:removeOutputAlert', instanceId, alertId),
    getOutputAlerts: (instanceId) => ipcRenderer.invoke('session:getOutputAlerts', instanceId),
    onAlertsChanged: (callback) => {
      const listener = (_e: any, data: { instanceId: string; alerts: Array<{ id: string; pattern: string; isRegex: boolean; oneShot: boolean }> }) => callback(data)
      ipcRenderer.on('session:alertsChanged', listener)
      return () => ipcRenderer.removeListener('session:alertsChanged', listener)
    },
    onAlertMatched: (callback) => {
      const listener = (_e: any, data: { instanceId: string; alertId: string }) => callback(data)
      ipcRenderer.on('session:alertMatched', listener)
      return () => ipcRenderer.removeListener('session:alertMatched', listener)
    },
  },
  audit: {
    runPanel: (panel, context) => ipcRenderer.invoke('audit:runPanel', panel, context),
    getLastRun: (panel) => ipcRenderer.invoke('audit:getLastRun', panel),
  },
  git: {
    stage: (cwd, files) => ipcRenderer.invoke('git:stage', cwd, files),
    unstage: (cwd, files) => ipcRenderer.invoke('git:unstage', cwd, files),
    commit: (cwd, message, amend) => ipcRenderer.invoke('git:commit', cwd, message, amend),
    lastCommitMessage: (cwd) => ipcRenderer.invoke('git:lastCommitMessage', cwd) as Promise<string | null>,
    push: (cwd) => ipcRenderer.invoke('git:push', cwd),
    branchInfo: (cwd) => ipcRenderer.invoke('git:branchInfo', cwd),
    unpushedCommits: (cwd) => ipcRenderer.invoke('git:unpushedCommits', cwd),
    log: (cwd, limit, skip, author) => ipcRenderer.invoke('git:log', cwd, limit, skip, author),
    commitFiles: (cwd, hash) => ipcRenderer.invoke('git:commitFiles', cwd, hash) as Promise<Array<{ file: string; status: string; insertions: number; deletions: number }>>,
    commitDiff: (cwd, hash) => ipcRenderer.invoke('git:commitDiff', cwd, hash),
    createBranch: (cwd, name, startPoint) => ipcRenderer.invoke('git:createBranch', cwd, name, startPoint),
    fetch: (cwd) => ipcRenderer.invoke('git:fetch', cwd),
    fetchRemote: (cwd, remote) => ipcRenderer.invoke('git:fetchRemote', cwd, remote) as Promise<{ success: boolean; error?: string }>,
    pull: (cwd) => ipcRenderer.invoke('git:pull', cwd),
    behindCount: (cwd) => ipcRenderer.invoke('git:behindCount', cwd),
    listBranches: (cwd, includeRemote) => ipcRenderer.invoke('git:listBranches', cwd, includeRemote),
    switchBranch: (cwd, branch) => ipcRenderer.invoke('git:switchBranch', cwd, branch),
    createTag: (cwd, tagName) => ipcRenderer.invoke('git:createTag', cwd, tagName),
    listTags: (cwd, prefix) => ipcRenderer.invoke('git:listTags', cwd, prefix),
    deleteTag: (cwd, tagName) => ipcRenderer.invoke('git:deleteTag', cwd, tagName),
    deleteTags: (cwd, prefix) => ipcRenderer.invoke('git:deleteTags', cwd, prefix),
    listAllTags: (cwd) => ipcRenderer.invoke('git:listAllTags', cwd),
    createGeneralTag: (cwd, tagName, message) => ipcRenderer.invoke('git:createGeneralTag', cwd, tagName, message),
    deleteGeneralTag: (cwd, tagName) => ipcRenderer.invoke('git:deleteGeneralTag', cwd, tagName),
    pushTag: (cwd, tagName) => ipcRenderer.invoke('git:pushTag', cwd, tagName),
    diffRange: (cwd, from, to, ignoreWhitespace) => ipcRenderer.invoke('git:diffRange', cwd, from, to, ignoreWhitespace),
    diffRangeFile: (cwd, from, to, file) => ipcRenderer.invoke('git:diffRangeFile', cwd, from, to, file) as Promise<string>,
    createPR: (cwd, title, body, baseBranch, draft) => ipcRenderer.invoke('git:createPR', cwd, title, body, baseBranch, draft),
    prTemplate: (cwd) => ipcRenderer.invoke('git:prTemplate', cwd) as Promise<string | null>,
    defaultBranch: (cwd) => ipcRenderer.invoke('git:defaultBranch', cwd),
    fileDiff: (cwd, file) => ipcRenderer.invoke('git:fileDiff', cwd, file) as Promise<string>,
    undoLastCommit: (cwd) => ipcRenderer.invoke('git:undoLastCommit', cwd) as Promise<void>,
    resetSoft: (cwd, targetHash) => ipcRenderer.invoke('git:resetSoft', cwd, targetHash) as Promise<void>,
    reflog: (cwd, limit, skip) => ipcRenderer.invoke('git:reflog', cwd, limit, skip) as Promise<Array<{ hash: string; ref: string; action: string; relativeTime: string }>>,
    resetHard: (cwd, hash) => ipcRenderer.invoke('git:resetHard', cwd, hash) as Promise<void>,
    remoteList: (cwd) => ipcRenderer.invoke('git:remoteList', cwd) as Promise<Array<{ name: string; fetchUrl: string; pushUrl: string }>>,
    remoteAdd: (cwd, name, url) => ipcRenderer.invoke('git:remoteAdd', cwd, name, url) as Promise<{ success: boolean; error?: string }>,
    remoteRemove: (cwd, name) => ipcRenderer.invoke('git:remoteRemove', cwd, name) as Promise<{ success: boolean; error?: string }>,
    stashPush: (cwd, message, files) => ipcRenderer.invoke('git:stashPush', cwd, message, files) as Promise<void>,
    stashList: (cwd) => ipcRenderer.invoke('git:stashList', cwd) as Promise<Array<{ index: number; message: string; date: string }>>,
    stashApply: (cwd, index) => ipcRenderer.invoke('git:stashApply', cwd, index) as Promise<void>,
    stashPop: (cwd, index) => ipcRenderer.invoke('git:stashPop', cwd, index) as Promise<void>,
    stashDrop: (cwd, index) => ipcRenderer.invoke('git:stashDrop', cwd, index) as Promise<void>,
    stashShow: (cwd, index) => ipcRenderer.invoke('git:stashShow', cwd, index) as Promise<{ stat: string; diff: string }>,
    stashFileDiff: (cwd, index, file) => ipcRenderer.invoke('git:stashFileDiff', cwd, index, file) as Promise<string>,
    branchAheadBehind: (cwd, branches) => ipcRenderer.invoke('git:branchAheadBehind', cwd, branches) as Promise<Record<string, { ahead: number; behind: number }>>,
    deleteBranch: (cwd, branch, force) => ipcRenderer.invoke('git:deleteBranch', cwd, branch, force) as Promise<{ success: boolean; error?: string }>,
    renameBranch: (cwd, newName) => ipcRenderer.invoke('git:renameBranch', cwd, newName) as Promise<{ success: boolean; error?: string; hasUpstream: boolean }>,
    pruneRemote: (cwd) => ipcRenderer.invoke('git:pruneRemote', cwd) as Promise<void>,
    fileLog: (cwd, filePath, limit, skip) => ipcRenderer.invoke('git:fileLog', cwd, filePath, limit, skip),
    fileCommitDiff: (cwd, hash, filePath) => ipcRenderer.invoke('git:fileCommitDiff', cwd, hash, filePath) as Promise<string>,
    blame: (cwd, filePath) => ipcRenderer.invoke('git:blame', cwd, filePath),
    cherryPick: (cwd, hash) => ipcRenderer.invoke('git:cherryPick', cwd, hash) as Promise<{ success: boolean; error?: string }>,
    cherryPickAbort: (cwd) => ipcRenderer.invoke('git:cherryPickAbort', cwd) as Promise<void>,
    merge: (cwd, branch, noFf) => ipcRenderer.invoke('git:merge', cwd, branch, noFf) as Promise<{ success: boolean; error?: string; conflicts?: string[] }>,
    mergePreview: (cwd, branch) => ipcRenderer.invoke('git:mergePreview', cwd, branch) as Promise<{ files: Array<{ file: string; insertions: number; deletions: number }>; totalInsertions: number; totalDeletions: number; fastForward: boolean }>,
    mergeAbort: (cwd) => ipcRenderer.invoke('git:mergeAbort', cwd) as Promise<void>,
    revert: (cwd, hash) => ipcRenderer.invoke('git:revert', cwd, hash) as Promise<{ success: boolean; error?: string }>,
    revertAbort: (cwd) => ipcRenderer.invoke('git:revertAbort', cwd) as Promise<void>,
    conflictState: (cwd) => ipcRenderer.invoke('git:conflictState', cwd) as Promise<{ state: 'none' | 'merge' | 'cherry-pick' | 'revert' | 'rebase'; conflictedFiles: string[] }>,
    resolveConflict: (cwd, file, strategy) => ipcRenderer.invoke('git:resolveConflict', cwd, file, strategy) as Promise<void>,
    markResolved: (cwd, file) => ipcRenderer.invoke('git:markResolved', cwd, file) as Promise<void>,
    completeConflictOp: (cwd) => ipcRenderer.invoke('git:completeConflictOp', cwd) as Promise<{ success: boolean; error?: string }>,
    rebase: (cwd, ontoBranch) => ipcRenderer.invoke('git:rebase', cwd, ontoBranch) as Promise<{ success: boolean; error?: string; conflicts?: string[] }>,
    rebaseAbort: (cwd) => ipcRenderer.invoke('git:rebaseAbort', cwd) as Promise<void>,
    rebaseContinue: (cwd) => ipcRenderer.invoke('git:rebaseContinue', cwd) as Promise<{ success: boolean; error?: string }>,
    rebaseInteractive: (cwd, base, todoItems) => ipcRenderer.invoke('git:rebaseInteractive', cwd, base, todoItems) as Promise<{ success: boolean; error?: string; conflicts?: string[] }>,
    searchCommits: (cwd, query, limit, author) => ipcRenderer.invoke('git:searchCommits', cwd, query, limit, author) as Promise<Array<{ hash: string; subject: string; author: string; date: string; filesChanged?: number; insertions?: number; deletions?: number; parents?: string[]; refs?: string[] }>>,
    stageHunk: (cwd, patch) => ipcRenderer.invoke('git:stageHunk', cwd, patch) as Promise<{ success: boolean; error?: string }>,
    discardHunk: (cwd, patch) => ipcRenderer.invoke('git:discardHunk', cwd, patch) as Promise<{ success: boolean; error?: string }>,
    addToGitignore: (cwd, filePath, tracked) => ipcRenderer.invoke('git:addToGitignore', cwd, filePath, tracked) as Promise<{ success: boolean; error?: string }>,
    bisectStart: (cwd, badHash, goodHash) => ipcRenderer.invoke('git:bisectStart', cwd, badHash, goodHash) as Promise<{ success: boolean; current?: string; remaining?: number; error?: string }>,
    bisectMark: (cwd, verdict) => ipcRenderer.invoke('git:bisectMark', cwd, verdict) as Promise<{ done: boolean; current?: string; remaining?: number; firstBad?: string; firstBadSubject?: string }>,
    bisectReset: (cwd) => ipcRenderer.invoke('git:bisectReset', cwd) as Promise<void>,
    bisectLog: (cwd) => ipcRenderer.invoke('git:bisectLog', cwd) as Promise<string>,
    dirtyFileCount: (cwd) => ipcRenderer.invoke('git:dirtyFileCount', cwd) as Promise<{ count: number }>,
    diffShortstat: (cwd) => ipcRenderer.invoke('git:diffShortstat', cwd) as Promise<{ insertions: number; deletions: number }>,
    changedFiles: (cwd) => ipcRenderer.invoke('git:changedFiles', cwd) as Promise<Array<{ file: string; status: string; staged: boolean }>>,
    aheadBehindCommits: (cwd, branch) => ipcRenderer.invoke('git:aheadBehindCommits', cwd, branch) as Promise<{ ahead: Array<{ hash: string; subject: string }>; behind: Array<{ hash: string; subject: string }> }>,
    exportPatch: (cwd, mode, options) => ipcRenderer.invoke('git:exportPatch', cwd, mode, options) as Promise<string>,
    savePatch: (content, defaultFilename) => ipcRenderer.invoke('git:savePatch', content, defaultFilename) as Promise<{ saved: boolean; path?: string }>,
  },
  ai: {
    suggestPRDescription: (dir) => ipcRenderer.invoke('ai:suggestPRDescription', dir) as Promise<{ title: string; body: string } | null>,
    suggestCommitMessage: (dir: string, files: string[]) => ipcRenderer.invoke('ai:suggestCommitMessage', dir, files) as Promise<string | null>,
  },
  review: {
    groupChanges: (files: string[], diffSummary: string) => ipcRenderer.invoke('review:groupChanges', files, diffSummary) as Promise<Array<{ label: string; files: string[] }>>,
  },
  arena: {
    recordWinner: (winnerKey, loserKey, matchCtx) => ipcRenderer.invoke('arena:recordWinner', winnerKey, loserKey, matchCtx),
    getStats: () => ipcRenderer.invoke('arena:getStats'),
    getMatchHistory: () => ipcRenderer.invoke('arena:getMatchHistory'),
    clearStats: () => ipcRenderer.invoke('arena:clearStats'),
    launchWithWorktrees: (opts) => ipcRenderer.invoke('arena:launchWithWorktrees', opts),
    cleanupWorktrees: (ids) => ipcRenderer.invoke('arena:cleanupWorktrees', ids),
    autoJudge: (opts) => ipcRenderer.invoke('arena:autoJudge', opts),
    promoteWinner: (opts) => ipcRenderer.invoke('arena:promoteWinner', opts),
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
    create: (owner, name, branch, repoAlias, remoteUrl, displayName) => ipcRenderer.invoke('worktree:create', owner, name, branch, repoAlias, remoteUrl, displayName),
    mount: (worktreeId, envId) => ipcRenderer.invoke('worktree:mount', worktreeId, envId),
    unmount: (worktreeId) => ipcRenderer.invoke('worktree:unmount', worktreeId),
    remove: (worktreeId) => ipcRenderer.invoke('worktree:remove', worktreeId),
    forEnv: (envId) => ipcRenderer.invoke('worktree:forEnv', envId),
    swap: (envId, worktreeId) => ipcRenderer.invoke('worktree:swap', envId, worktreeId),
    onChanged: (cb) => {
      const l = () => cb()
      ipcRenderer.on('worktree:changed', l)
      return () => ipcRenderer.removeListener('worktree:changed', l)
    },
    pull: (worktreeId) => ipcRenderer.invoke('worktree:pull', worktreeId),
    status: (worktreeId) => ipcRenderer.invoke('worktree:status', worktreeId),
    fetch: (worktreeId) => ipcRenderer.invoke('worktree:fetch', worktreeId),
    size: (worktreeId) => ipcRenderer.invoke('worktree:size', worktreeId),
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
  playbooks: {
    list: () => ipcRenderer.invoke('playbooks:list'),
    get: (name) => ipcRenderer.invoke('playbooks:get', name),
    getDir: () => ipcRenderer.invoke('playbooks:getDir'),
    getMemory: (name) => ipcRenderer.invoke('playbooks:getMemory', name),
    getMemoryLineCount: (name) => ipcRenderer.invoke('playbooks:getMemoryLineCount', name),
    appendMemory: (name, lines) => ipcRenderer.invoke('playbooks:appendMemory', name, lines),
    clearMemory: (name) => ipcRenderer.invoke('playbooks:clearMemory', name),
  },
  proofs: {
    list: (dateFrom, dateTo) => ipcRenderer.invoke('proofs:list', dateFrom, dateTo),
    read: (path) => ipcRenderer.invoke('proofs:read', path),
    onNewProof: (cb) => {
      const listener = (_e: any, data: { id: string; path: string }) => cb(data)
      ipcRenderer.on('instance:proof', listener)
      return () => ipcRenderer.removeListener('instance:proof', listener)
    },
  },
}

contextBridge.exposeInMainWorld('api', api)
