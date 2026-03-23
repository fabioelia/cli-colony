import { contextBridge, ipcRenderer, webUtils } from 'electron'

export type CliBackend = 'claude' | 'cursor-agent'

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
  cliBackend: CliBackend
  gitBranch: string | null
  tokenUsage: { input: number; output: number; cost: number }
  pinned: boolean
  mcpServers: string[]
  parentId: string | null
  childIds: string[]
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

export interface CheckRun {
  name: string
  status: string
  conclusion: string | null
  url: string
}

export interface PRChecks {
  overall: 'success' | 'failure' | 'pending' | 'none'
  checks: CheckRun[]
}

export interface PRComment {
  author: string
  body: string
  createdAt: string
  path?: string
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
  prompt: string
  scope: 'pr' | 'global'
}

export interface GitHubRepo {
  owner: string
  name: string
  localPath?: string
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
    onOutput: (callback: (data: { id: string; data: string }) => void) => () => void
    onExited: (callback: (data: { id: string; exitCode: number }) => void) => () => void
    onListUpdate: (callback: (instances: ClaudeInstance[]) => void) => () => void
    onFocus: (callback: (data: { id: string }) => void) => () => void
    onActivity: (callback: (data: { id: string; activity: 'busy' | 'waiting' }) => void) => () => void
  }
  sessions: {
    list: (limit?: number) => Promise<CliSession[]>
    restorable: () => Promise<any[]>
    clearRestorable: () => Promise<boolean>
    recent: () => Promise<any[]>
  }
  daemon: {
    restart: () => Promise<void>
  }
  settings: {
    getAll: () => Promise<Record<string, string>>
    set: (key: string, value: string) => Promise<boolean>
    getShells: () => Promise<string[]>
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
    removeRepo: (owner: string, name: string) => Promise<GitHubRepo[]>
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
  }
  colony: {
    updateContext: () => Promise<string>
    getContextPath: () => Promise<string>
    getContextInstruction: () => Promise<string>
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
  }
  resources: {
    getUsage: () => Promise<{
      perInstance: Record<string, { cpu: number; memory: number }>
      total: { cpu: number; memory: number }
    }>
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
  sessions: {
    list: (limit) => ipcRenderer.invoke('sessions:list', limit),
    restorable: () => ipcRenderer.invoke('sessions:restorable'),
    clearRestorable: () => ipcRenderer.invoke('sessions:clearRestorable'),
    recent: () => ipcRenderer.invoke('sessions:recent'),
  },
  daemon: {
    restart: () => ipcRenderer.invoke('daemon:restart'),
  },
  settings: {
    getAll: () => ipcRenderer.invoke('settings:getAll'),
    set: (key, value) => ipcRenderer.invoke('settings:set', key, value),
    getShells: () => ipcRenderer.invoke('settings:getShells'),
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
    removeRepo: (owner, name) => ipcRenderer.invoke('github:removeRepo', owner, name),
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
  },
  colony: {
    updateContext: () => ipcRenderer.invoke('colony:updateContext'),
    getContextPath: () => ipcRenderer.invoke('colony:getContextPath'),
    getContextInstruction: () => ipcRenderer.invoke('colony:getContextInstruction'),
  },
  taskQueue: {
    list: () => ipcRenderer.invoke('taskQueue:list'),
    save: (name, content) => ipcRenderer.invoke('taskQueue:save', name, content),
    delete: (name) => ipcRenderer.invoke('taskQueue:delete', name),
    getWorkspacePath: () => ipcRenderer.invoke('taskQueue:getWorkspacePath'),
    createTaskDir: (queueName, taskName) => ipcRenderer.invoke('taskQueue:createTaskDir', queueName, taskName),
    listRuns: () => ipcRenderer.invoke('taskQueue:listRuns'),
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
  },
}

contextBridge.exposeInMainWorld('api', api)
