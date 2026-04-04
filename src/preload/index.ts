import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  CliBackend, ClaudeInstance, AgentDef, CliSession,
  CheckRun, PRChecks, PRComment, GitHubPR, QuickPrompt, GitHubRepo,
  FeedbackFile, PersonaInfo, EnvServiceStatus, EnvStatus,
} from '../shared/types'

// Re-export shared types so existing imports from this module continue to work
export type {
  CliBackend, ClaudeInstance, AgentDef, CliSession,
  CheckRun, PRChecks, PRComment, GitHubPR, QuickPrompt, GitHubRepo,
  FeedbackFile, PersonaInfo, EnvServiceStatus, EnvStatus,
}


export interface ClaudeManagerAPI {
  agents: {
    list: () => Promise<AgentDef[]>
    read: (filePath: string) => Promise<string | null>
    write: (filePath: string, content: string) => Promise<boolean>
    create: (name: string, scope: string, projectPath?: string) => Promise<AgentDef | null>
    export: (agentPaths: string[]) => Promise<boolean>
    import: (targetDir: string) => Promise<number>
  }
  instance: {
    create: (opts?: {
      name?: string
      workingDirectory?: string
      color?: string
      args?: string[]
      parentId?: string
      cliBackend?: CliBackend
    }) => Promise<ClaudeInstance>
    write: (id: string, data: string) => Promise<boolean>
    resize: (id: string, cols: number, rows: number) => Promise<boolean>
    kill: (id: string) => Promise<boolean>
    remove: (id: string) => Promise<boolean>
    rename: (id: string, name: string) => Promise<boolean>
    recolor: (id: string, color: string) => Promise<boolean>
    restart: (id: string) => Promise<ClaudeInstance | null>
    pin: (id: string) => Promise<boolean>
    unpin: (id: string) => Promise<boolean>
    list: () => Promise<ClaudeInstance[]>
    get: (id: string) => Promise<ClaudeInstance | null>
    buffer: (id: string) => Promise<string>
    processes: (id: string) => Promise<Array<{ pid: number; name: string; command: string; cpu: string; mem: string }>>
    killProcess: (pid: number) => Promise<boolean>
    onOutput: (callback: (data: { id: string; data: string }) => void) => () => void
    onExited: (callback: (data: { id: string; exitCode: number }) => void) => () => void
    onListUpdate: (callback: (instances: ClaudeInstance[]) => void) => () => void
    onFocus: (callback: (data: { id: string }) => void) => () => void
    onActivity: (callback: (data: { id: string; activity: 'busy' | 'waiting' }) => void) => () => void
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
  }
  daemon: {
    restart: () => Promise<void>
    getVersion: () => Promise<{ running: number; expected: number }>
    onVersionMismatch: (cb: (info: { running: number; expected: number }) => void) => () => void
  }
  settings: {
    getAll: () => Promise<Record<string, string>>
    set: (key: string, value: string) => Promise<boolean>
    getShells: () => Promise<string[]>
    detectGitProtocol: () => Promise<'ssh' | 'https' | null>
  }
  logs: {
    get: () => Promise<string>
    clear: () => Promise<boolean>
  }
  shell: {
    openExternal: (url: string) => Promise<void>
  }
  shortcuts: {
    onNewInstance: (cb: () => void) => () => void
    onCloseInstance: (cb: () => void) => () => void
    onClearTerminal: (cb: () => void) => () => void
    onSearch: (cb: () => void) => () => void
    onSwitchInstance: (cb: (index: number) => void) => () => void
    onZoomIn: (cb: () => void) => () => void
    onZoomOut: (cb: () => void) => () => void
    onZoomReset: (cb: () => void) => () => void
    onToggleSplit: (cb: () => void) => () => void
    onCloseSplit: (cb: () => void) => () => void
    onFocusPane: (cb: (side: 'left' | 'right') => void) => () => void
    onCycleInstance: (cb: (direction: number) => void) => () => void
    onCommandPalette: (cb: () => void) => () => void
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
  }
  persona: {
    list: () => Promise<PersonaInfo[]>
    getContent: (fileName: string) => Promise<string | null>
    saveContent: (fileName: string, content: string) => Promise<boolean>
    create: (name: string) => Promise<{ fileName: string } | null>
    delete: (fileName: string) => Promise<boolean>
    run: (fileName: string) => Promise<string>
    stop: (fileName: string) => Promise<boolean>
    toggle: (fileName: string, enabled: boolean) => Promise<boolean>
    getDir: () => Promise<string>
    setSchedule: (fileName: string, schedule: string) => Promise<boolean>
    onStatus: (cb: (personas: PersonaInfo[]) => void) => () => void
    onRun: (cb: (data: { persona: string; instanceId: string }) => void) => () => void
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
    create: (opts: { name: string; branch?: string; baseBranch?: string; projectType?: string; target?: string }) => Promise<any>
    start: (envId: string, services?: string[]) => Promise<void>
    stop: (envId: string, services?: string[]) => Promise<void>
    teardown: (envId: string) => Promise<void>
    logs: (envId: string, service: string, lines?: number) => Promise<string>
    restartService: (envId: string, service: string) => Promise<void>
    manifest: (envId: string) => Promise<any>
    saveManifest: (envId: string, manifest: any) => Promise<void>
    retrySetup: (envId: string) => Promise<void>
    fix: (envId: string) => Promise<{ fixed: string[] }>
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
  },
  instance: {
    create: (opts) => ipcRenderer.invoke('instance:create', opts),
    write: (id, data) => ipcRenderer.invoke('instance:write', id, data),
    resize: (id, cols, rows) => ipcRenderer.invoke('instance:resize', id, cols, rows),
    kill: (id) => ipcRenderer.invoke('instance:kill', id),
    remove: (id) => ipcRenderer.invoke('instance:remove', id),
    rename: (id, name) => ipcRenderer.invoke('instance:rename', id, name),
    recolor: (id, color) => ipcRenderer.invoke('instance:recolor', id, color),
    restart: (id) => ipcRenderer.invoke('instance:restart', id),
    pin: (id) => ipcRenderer.invoke('instance:pin', id),
    unpin: (id) => ipcRenderer.invoke('instance:unpin', id),
    list: () => ipcRenderer.invoke('instance:list'),
    get: (id) => ipcRenderer.invoke('instance:get', id),
    buffer: (id) => ipcRenderer.invoke('instance:buffer', id),
    processes: (id) => ipcRenderer.invoke('instance:processes', id),
    killProcess: (pid) => ipcRenderer.invoke('instance:killProcess', pid),
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
  },
  shellPty: {
    create: (instanceId, cwd) => ipcRenderer.invoke('shell-pty:create', instanceId, cwd),
    write: (instanceId, data) => ipcRenderer.invoke('shell-pty:write', instanceId, data),
    resize: (instanceId, cols, rows) => ipcRenderer.invoke('shell-pty:resize', instanceId, cols, rows),
    kill: (instanceId) => ipcRenderer.invoke('shell-pty:kill', instanceId),
    onOutput: (callback) => {
      const listener = (_e: any, data: { instanceId: string; data: string }) => callback(data)
      ipcRenderer.on('shell-pty:output', listener)
      return () => ipcRenderer.removeListener('shell-pty:output', listener)
    },
    onExited: (callback) => {
      const listener = (_e: any, data: { instanceId: string }) => callback(data)
      ipcRenderer.on('shell-pty:exited', listener)
      return () => ipcRenderer.removeListener('shell-pty:exited', listener)
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
  },
  daemon: {
    restart: () => ipcRenderer.invoke('daemon:restart'),
    getVersion: () => ipcRenderer.invoke('daemon:version'),
    onVersionMismatch: (cb) => {
      const handler = (_e: any, info: { running: number; expected: number }) => cb(info)
      ipcRenderer.on('daemon:version-mismatch', handler)
      return () => ipcRenderer.removeListener('daemon:version-mismatch', handler)
    },
  },
  settings: {
    getAll: () => ipcRenderer.invoke('settings:getAll'),
    set: (key, value) => ipcRenderer.invoke('settings:set', key, value),
    getShells: () => ipcRenderer.invoke('settings:getShells'),
    detectGitProtocol: () => ipcRenderer.invoke('settings:detectGitProtocol'),
  },
  logs: {
    get: () => ipcRenderer.invoke('logs:get'),
    clear: () => ipcRenderer.invoke('logs:clear'),
  },
  shell: {
    openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  },
  shortcuts: {
    onNewInstance: (cb) => { const l = () => cb(); ipcRenderer.on('shortcut:new-instance', l); return () => ipcRenderer.removeListener('shortcut:new-instance', l) },
    onCloseInstance: (cb) => { const l = () => cb(); ipcRenderer.on('shortcut:close-instance', l); return () => ipcRenderer.removeListener('shortcut:close-instance', l) },
    onClearTerminal: (cb) => { const l = () => cb(); ipcRenderer.on('shortcut:clear-terminal', l); return () => ipcRenderer.removeListener('shortcut:clear-terminal', l) },
    onSearch: (cb) => { const l = () => cb(); ipcRenderer.on('shortcut:search', l); return () => ipcRenderer.removeListener('shortcut:search', l) },
    onSwitchInstance: (cb) => { const l = (_e: any, idx: number) => cb(idx); ipcRenderer.on('shortcut:switch-instance', l); return () => ipcRenderer.removeListener('shortcut:switch-instance', l) },
    onZoomIn: (cb) => { const l = () => cb(); ipcRenderer.on('shortcut:zoom-in', l); return () => ipcRenderer.removeListener('shortcut:zoom-in', l) },
    onZoomOut: (cb) => { const l = () => cb(); ipcRenderer.on('shortcut:zoom-out', l); return () => ipcRenderer.removeListener('shortcut:zoom-out', l) },
    onZoomReset: (cb) => { const l = () => cb(); ipcRenderer.on('shortcut:zoom-reset', l); return () => ipcRenderer.removeListener('shortcut:zoom-reset', l) },
    onToggleSplit: (cb) => { const l = () => cb(); ipcRenderer.on('shortcut:toggle-split', l); return () => ipcRenderer.removeListener('shortcut:toggle-split', l) },
    onCloseSplit: (cb) => { const l = () => cb(); ipcRenderer.on('shortcut:close-split', l); return () => ipcRenderer.removeListener('shortcut:close-split', l) },
    onFocusPane: (cb) => { const l = (_e: any, side: 'left' | 'right') => cb(side); ipcRenderer.on('shortcut:focus-pane', l); return () => ipcRenderer.removeListener('shortcut:focus-pane', l) },
    onCycleInstance: (cb) => { const l = (_e: any, dir: number) => cb(dir); ipcRenderer.on('shortcut:cycle-instance', l); return () => ipcRenderer.removeListener('shortcut:cycle-instance', l) },
    onCommandPalette: (cb) => { const l = () => cb(); ipcRenderer.on('shortcut:command-palette', l); return () => ipcRenderer.removeListener('shortcut:command-palette', l) },
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
  },
  colony: {
    updateContext: () => ipcRenderer.invoke('colony:updateContext'),
    getContextPath: () => ipcRenderer.invoke('colony:getContextPath'),
    getContextInstruction: () => ipcRenderer.invoke('colony:getContextInstruction'),
    writePromptFile: (content) => ipcRenderer.invoke('colony:writePromptFile', content),
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
    pickFile: (opts) => ipcRenderer.invoke('env:pick-file', opts),
  },
}

contextBridge.exposeInMainWorld('api', api)
