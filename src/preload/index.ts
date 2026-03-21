import { contextBridge, ipcRenderer, webUtils } from 'electron'

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
}

export interface ClaudeManagerAPI {
  agents: {
    list: () => Promise<AgentDef[]>
    read: (filePath: string) => Promise<string | null>
    write: (filePath: string, content: string) => Promise<boolean>
  }
  instance: {
    create: (opts?: {
      name?: string
      workingDirectory?: string
      color?: string
      args?: string[]
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
  }
  sessions: {
    list: (limit?: number) => Promise<CliSession[]>
    restorable: () => Promise<any[]>
    clearRestorable: () => Promise<boolean>
    recent: () => Promise<any[]>
  }
  settings: {
    getAll: () => Promise<Record<string, string>>
    set: (key: string, value: string) => Promise<boolean>
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
  }
  getPathForFile: (file: File) => string
  dialog: {
    openDirectory: () => Promise<string | null>
  }
}

const api: ClaudeManagerAPI = {
  agents: {
    list: () => ipcRenderer.invoke('agents:list'),
    read: (filePath) => ipcRenderer.invoke('agents:read', filePath),
    write: (filePath, content) => ipcRenderer.invoke('agents:write', filePath, content),
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
  },
  sessions: {
    list: (limit) => ipcRenderer.invoke('sessions:list', limit),
    restorable: () => ipcRenderer.invoke('sessions:restorable'),
    clearRestorable: () => ipcRenderer.invoke('sessions:clearRestorable'),
    recent: () => ipcRenderer.invoke('sessions:recent'),
  },
  settings: {
    getAll: () => ipcRenderer.invoke('settings:getAll'),
    set: (key, value) => ipcRenderer.invoke('settings:set', key, value),
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
  },
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  dialog: {
    openDirectory: () => ipcRenderer.invoke('dialog:openDirectory'),
  },
}

contextBridge.exposeInMainWorld('api', api)
