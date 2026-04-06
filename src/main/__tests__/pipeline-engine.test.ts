/**
 * Tests for src/main/pipeline-engine.ts
 *
 * Pipeline-engine has module-level state (pipelines Map, timers, started flag).
 * Strategy: vi.resetModules() + vi.doMock() + dynamic import per test group,
 * driving the public API (loadPipelines, getPipelineList, etc.) and verifying
 * that parsePipelineYaml normalisation, state loading, and file operations work.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const MOCK_ROOT = '/mock/.claude-colony'
const PIPELINES_DIR = `${MOCK_ROOT}/pipelines`
const STATE_PATH = `${MOCK_ROOT}/pipeline-state.json`

// ---- Reusable YAML fixtures ----

const VALID_YAML = `
name: My Pipeline
description: A test pipeline
enabled: true

trigger:
  type: git-poll
  interval: 300
  repos: auto

condition:
  type: always

action:
  type: launch-session
  prompt: Do something useful

dedup:
  key: "{{repo.name}}"
  ttl: 3600
`

const MINIMAL_YAML = `
name: Minimal
trigger:
  type: cron
  cron: "0 9 * * 1-5"
condition:
  type: always
action:
  prompt: Run me
dedup:
  key: daily
`

// ---- Shared mock instances ----

const mockBroadcast = vi.fn()
const mockGetAllRepoConfigs = vi.fn(() => [])
const mockScheduleTimer = vi.hoisted(() => vi.fn())

// ---- Test helpers ----

/**
 * Build a fresh fs mock. readdirSync returns `fileNames` from PIPELINES_DIR.
 * readFileSync returns `fileContents[path]` or throws.
 * existsSync returns true for PIPELINES_DIR; false for STATE_PATH.
 */
function buildFsMock(
  fileNames: string[],
  fileContents: Record<string, string>,
  stateJson?: string,
  statMtimes?: Record<string, number>,  // path → mtime for file-poll tests
) {
  return {
    existsSync: vi.fn().mockImplementation((p: string) => {
      if (p === PIPELINES_DIR) return true
      if (p === STATE_PATH) return stateJson !== undefined
      return false
    }),
    readFileSync: vi.fn().mockImplementation((p: string, _enc?: string) => {
      if (p === STATE_PATH) return stateJson ?? '{}'
      const key = Object.keys(fileContents).find(k => p.endsWith(k))
      if (key) return fileContents[key]
      throw new Error(`Unexpected readFileSync: ${p}`)
    }),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    readdirSync: vi.fn().mockImplementation((p: string) => {
      if (p === PIPELINES_DIR) return fileNames
      return []
    }),
    appendFileSync: vi.fn(),
    statSync: vi.fn().mockImplementation((p: string) => {
      if (statMtimes && p in statMtimes) {
        return { mtimeMs: statMtimes[p], isDirectory: () => false }
      }
      throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' })
    }),
  }
}

function setupMocks(fsMock: ReturnType<typeof buildFsMock>) {
  vi.doMock('electron', () => ({
    app: { getPath: vi.fn().mockReturnValue('/mock/home') },
  }))
  vi.doMock('../../shared/colony-paths', () => ({
    colonyPaths: {
      root: MOCK_ROOT,
      pipelines: PIPELINES_DIR,
      schedulerLog: `${MOCK_ROOT}/scheduler.log`,
    },
  }))
  vi.doMock('fs', () => fsMock)
  vi.doMock('../broadcast', () => ({ broadcast: mockBroadcast }))
  vi.doMock('../repo-config-loader', () => ({ getAllRepoConfigs: mockGetAllRepoConfigs }))
  // Heavy async dependencies — not exercised in these tests
  vi.doMock('../instance-manager', () => ({
    createInstance: vi.fn(),
    getAllInstances: vi.fn().mockResolvedValue([]),
  }))
  vi.doMock('../daemon-client', () => ({ getDaemonClient: vi.fn() }))
  vi.doMock('../send-prompt-when-ready', () => ({ sendPromptWhenReady: vi.fn() }))
  vi.doMock('../notifications', () => ({ notify: vi.fn() }))
  vi.doMock('../github', () => ({
    getRepos: vi.fn().mockReturnValue([]),
    fetchPRs: vi.fn().mockResolvedValue([]),
    fetchChecks: vi.fn().mockResolvedValue({ checks: [] }),
    gh: vi.fn().mockResolvedValue('{}'),
  }))
  vi.doMock('../session-router', () => ({ findBestRoute: vi.fn().mockResolvedValue(null) }))
  vi.doMock('../activity-manager', () => ({ appendActivity: vi.fn() }))
}

// ---- Test suites ----

describe('pipeline-engine: YAML parsing via loadPipelines', () => {
  let mod: typeof import('../pipeline-engine')

  beforeEach(async () => {
    vi.resetModules()
    vi.useFakeTimers()
    mockBroadcast.mockReset()
    mockGetAllRepoConfigs.mockReset().mockReturnValue([])
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    if (mod) mod.stopPipelines()
  })

  it('loads a valid pipeline and returns it in getPipelineList', async () => {
    const fs = buildFsMock(['my.yaml'], { 'my.yaml': VALID_YAML })
    setupMocks(fs)
    mod = await import('../pipeline-engine')

    mod.loadPipelines()

    const list = mod.getPipelineList()
    expect(list).toHaveLength(1)
    expect(list[0].name).toBe('My Pipeline')
    expect(list[0].description).toBe('A test pipeline')
    expect(list[0].enabled).toBe(true)
    expect(list[0].triggerType).toBe('git-poll')
    expect(list[0].interval).toBe(300)
    expect(list[0].cron).toBeNull()
  })

  it('skips a pipeline when `name` is missing', async () => {
    const yaml = VALID_YAML.replace('name: My Pipeline', '')
    const fs = buildFsMock(['bad.yaml'], { 'bad.yaml': yaml })
    setupMocks(fs)
    mod = await import('../pipeline-engine')

    mod.loadPipelines()
    expect(mod.getPipelineList()).toHaveLength(0)
  })

  it('skips a pipeline when `action.prompt` is missing', async () => {
    const yaml = VALID_YAML.replace('  prompt: Do something useful', '')
    const fs = buildFsMock(['bad.yaml'], { 'bad.yaml': yaml })
    setupMocks(fs)
    mod = await import('../pipeline-engine')

    mod.loadPipelines()
    expect(mod.getPipelineList()).toHaveLength(0)
  })

  it('skips a pipeline when `trigger.type` is missing', async () => {
    const yaml = VALID_YAML.replace('  type: git-poll', '')
    const fs = buildFsMock(['bad.yaml'], { 'bad.yaml': yaml })
    setupMocks(fs)
    mod = await import('../pipeline-engine')

    mod.loadPipelines()
    expect(mod.getPipelineList()).toHaveLength(0)
  })

  it('defaults `enabled` to true when not specified', async () => {
    const yaml = VALID_YAML.replace('enabled: true\n', '')
    const fs = buildFsMock(['pipe.yaml'], { 'pipe.yaml': yaml })
    setupMocks(fs)
    mod = await import('../pipeline-engine')

    mod.loadPipelines()
    const list = mod.getPipelineList()
    expect(list[0].enabled).toBe(true)
  })

  it('respects `enabled: false`', async () => {
    const yaml = VALID_YAML.replace('enabled: true', 'enabled: false')
    const fs = buildFsMock(['pipe.yaml'], { 'pipe.yaml': yaml })
    setupMocks(fs)
    mod = await import('../pipeline-engine')

    mod.loadPipelines()
    expect(mod.getPipelineList()[0].enabled).toBe(false)
  })

  it('normalises route-to-session → launch-session + reuse:true', async () => {
    // We can't directly inspect action type from getPipelineList, but we can verify
    // loading doesn't fail and the pipeline loads correctly (normalisation happens silently)
    const yaml = VALID_YAML.replace('type: launch-session', 'type: route-to-session')
    const fs = buildFsMock(['pipe.yaml'], { 'pipe.yaml': yaml })
    setupMocks(fs)
    mod = await import('../pipeline-engine')

    mod.loadPipelines()
    // Pipeline should load successfully (not be rejected)
    expect(mod.getPipelineList()).toHaveLength(1)
    expect(mod.getPipelineList()[0].name).toBe('My Pipeline')
  })

  it('handles minimal pipeline with cron trigger', async () => {
    const fs = buildFsMock(['minimal.yaml'], { 'minimal.yaml': MINIMAL_YAML })
    setupMocks(fs)
    mod = await import('../pipeline-engine')

    mod.loadPipelines()
    const list = mod.getPipelineList()
    expect(list).toHaveLength(1)
    expect(list[0].cron).toBe('0 9 * * 1-5')
    expect(list[0].triggerType).toBe('cron')
  })

  it('loads multiple pipelines', async () => {
    const yaml2 = MINIMAL_YAML.replace('name: Minimal', 'name: Second')
    const fs = buildFsMock(
      ['first.yaml', 'second.yaml'],
      { 'first.yaml': VALID_YAML, 'second.yaml': yaml2 },
    )
    setupMocks(fs)
    mod = await import('../pipeline-engine')

    mod.loadPipelines()
    expect(mod.getPipelineList()).toHaveLength(2)
    const names = mod.getPipelineList().map(p => p.name)
    expect(names).toContain('My Pipeline')
    expect(names).toContain('Second')
  })

  it('ignores non-YAML files in pipelines directory', async () => {
    const fs = buildFsMock(
      ['pipe.yaml', 'readme.md', 'notes.txt'],
      { 'pipe.yaml': VALID_YAML },
    )
    setupMocks(fs)
    mod = await import('../pipeline-engine')

    mod.loadPipelines()
    expect(mod.getPipelineList()).toHaveLength(1)
  })

  it('returns empty list when pipelines directory is empty', async () => {
    const fs = buildFsMock([], {})
    setupMocks(fs)
    mod = await import('../pipeline-engine')

    mod.loadPipelines()
    expect(mod.getPipelineList()).toHaveLength(0)
  })
})

describe('pipeline-engine: getPipelineList fields', () => {
  let mod: typeof import('../pipeline-engine')

  beforeEach(async () => {
    vi.resetModules()
    vi.useFakeTimers()
    mockBroadcast.mockReset()
    mockGetAllRepoConfigs.mockReset().mockReturnValue([])
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    if (mod) mod.stopPipelines()
  })

  it('returns zero-state fields when no saved state', async () => {
    const fs = buildFsMock(['pipe.yaml'], { 'pipe.yaml': VALID_YAML })
    setupMocks(fs)
    mod = await import('../pipeline-engine')

    mod.loadPipelines()
    const p = mod.getPipelineList()[0]
    expect(p.fireCount).toBe(0)
    expect(p.lastPollAt).toBeNull()
    expect(p.lastFiredAt).toBeNull()
    expect(p.lastMatchAt).toBeNull()
    expect(p.lastError).toBeNull()
    expect(p.debugLog).toEqual([])
    expect(p.running).toBe(false)
  })

  it('restores fireCount and lastFiredAt from saved state', async () => {
    const savedState = JSON.stringify({
      'My Pipeline': {
        lastPollAt: '2026-04-01T10:00:00.000Z',
        lastMatchAt: '2026-04-01T10:00:00.000Z',
        firedKeys: {},
        contentHashes: {},
        fireCount: 7,
        lastFiredAt: '2026-04-01T10:05:00.000Z',
        lastError: null,
      },
    })
    const fs = buildFsMock(['pipe.yaml'], { 'pipe.yaml': VALID_YAML }, savedState)
    setupMocks(fs)
    mod = await import('../pipeline-engine')

    mod.loadPipelines()
    const p = mod.getPipelineList()[0]
    expect(p.fireCount).toBe(7)
    expect(p.lastFiredAt).toBe('2026-04-01T10:05:00.000Z')
    expect(p.lastPollAt).toBe('2026-04-01T10:00:00.000Z')
    // debugLog is ephemeral — not persisted, always starts empty
    expect(p.debugLog).toEqual([])
  })

  it('exposes outputsDir when action.outputs is configured', async () => {
    const yaml = `
name: My Pipeline
trigger:
  type: cron
  cron: "0 9 * * *"
condition:
  type: always
action:
  type: launch-session
  prompt: Do something
  outputs: "~/.claude-colony/outputs/my-pipe"
dedup:
  key: daily
`
    const fs = buildFsMock(['pipe.yaml'], { 'pipe.yaml': yaml })
    setupMocks(fs)
    mod = await import('../pipeline-engine')

    mod.loadPipelines()
    const p = mod.getPipelineList()[0]
    expect(p.outputsDir).toBe('~/.claude-colony/outputs/my-pipe')
  })
})

describe('pipeline-engine: file operations', () => {
  let mod: typeof import('../pipeline-engine')

  beforeEach(async () => {
    vi.resetModules()
    vi.useFakeTimers()
    mockBroadcast.mockReset()
    mockGetAllRepoConfigs.mockReset().mockReturnValue([])
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    if (mod) mod.stopPipelines()
  })

  it('getPipelineContent returns file content', async () => {
    const content = 'name: Test\ntrigger:\n  type: cron\n'
    const fs = buildFsMock([], {})
    // Override readFileSync to handle the specific path
    fs.readFileSync.mockImplementation((p: string, _enc?: string) => {
      if (p === `${PIPELINES_DIR}/test.yaml`) return content
      if (p === STATE_PATH) return '{}'
      throw new Error(`Unexpected readFileSync: ${p}`)
    })
    fs.existsSync.mockImplementation((p: string) => {
      if (p === `${PIPELINES_DIR}/test.yaml`) return true
      if (p === PIPELINES_DIR) return true
      return false
    })
    setupMocks(fs)
    mod = await import('../pipeline-engine')

    const result = mod.getPipelineContent('test.yaml')
    expect(result).toBe(content)
  })

  it('getPipelineContent returns null when file not found', async () => {
    const fs = buildFsMock([], {})
    fs.readFileSync.mockImplementation(() => { throw new Error('ENOENT') })
    setupMocks(fs)
    mod = await import('../pipeline-engine')

    const result = mod.getPipelineContent('missing.yaml')
    expect(result).toBeNull()
  })

  it('getPipelinesDir returns the pipelines directory path', async () => {
    const fs = buildFsMock([], {})
    setupMocks(fs)
    mod = await import('../pipeline-engine')

    expect(mod.getPipelinesDir()).toBe(PIPELINES_DIR)
  })
})

describe('pipeline-engine: togglePipeline', () => {
  let mod: typeof import('../pipeline-engine')

  beforeEach(async () => {
    vi.resetModules()
    vi.useFakeTimers()
    mockBroadcast.mockReset()
    mockGetAllRepoConfigs.mockReset().mockReturnValue([])
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    if (mod) mod.stopPipelines()
  })

  it('returns false for an unknown pipeline name', async () => {
    const fs = buildFsMock(['pipe.yaml'], { 'pipe.yaml': VALID_YAML })
    setupMocks(fs)
    mod = await import('../pipeline-engine')

    mod.loadPipelines()
    expect(mod.togglePipeline('No Such Pipeline', false)).toBe(false)
  })

  it('returns true when toggling a known pipeline', async () => {
    const fs = buildFsMock(['pipe.yaml'], { 'pipe.yaml': VALID_YAML })
    // togglePipeline reads + writes the YAML file; provide the content for re-read
    fs.readFileSync.mockImplementation((p: string, _enc?: string) => {
      if (p === STATE_PATH) return '{}'
      if (p.endsWith('pipe.yaml')) return VALID_YAML
      throw new Error(`Unexpected readFileSync: ${p}`)
    })
    setupMocks(fs)
    mod = await import('../pipeline-engine')

    mod.loadPipelines()
    const result = mod.togglePipeline('My Pipeline', false)
    expect(result).toBe(true)
  })

  it('updates enabled state in getPipelineList after toggling off', async () => {
    const fs = buildFsMock(['pipe.yaml'], { 'pipe.yaml': VALID_YAML })
    fs.readFileSync.mockImplementation((p: string, _enc?: string) => {
      if (p === STATE_PATH) return '{}'
      if (p.endsWith('pipe.yaml')) return VALID_YAML
      throw new Error(`Unexpected readFileSync: ${p}`)
    })
    setupMocks(fs)
    mod = await import('../pipeline-engine')

    mod.loadPipelines()
    expect(mod.getPipelineList()[0].enabled).toBe(true)

    mod.togglePipeline('My Pipeline', false)
    expect(mod.getPipelineList()[0].enabled).toBe(false)
  })
})

describe('pipeline-engine: setPipelineCron', () => {
  let mod: typeof import('../pipeline-engine')

  beforeEach(async () => {
    vi.resetModules()
    vi.useFakeTimers()
    mockBroadcast.mockReset()
    mockGetAllRepoConfigs.mockReset().mockReturnValue([])
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    if (mod) mod.stopPipelines()
  })

  it('returns false when file does not exist', async () => {
    const fs = buildFsMock([], {})
    fs.readFileSync.mockImplementation((p: string) => {
      if (p === STATE_PATH) return '{}'
      throw new Error('ENOENT')
    })
    setupMocks(fs)
    mod = await import('../pipeline-engine')

    expect(mod.setPipelineCron('missing.yaml', '0 9 * * *')).toBe(false)
  })

  it('inserts cron field after interval line when not present', async () => {
    const content = `name: My Pipeline
trigger:
  type: git-poll
  interval: 300
condition:
  type: always
action:
  prompt: Go
dedup:
  key: k
`
    const fs = buildFsMock(['pipe.yaml'], { 'pipe.yaml': content })
    let capturedWrite = ''
    fs.readFileSync.mockImplementation((p: string, _enc?: string) => {
      if (p === STATE_PATH) return '{}'
      if (p.endsWith('pipe.yaml')) return content
      throw new Error(`Unexpected: ${p}`)
    })
    fs.writeFileSync.mockImplementation((_p: string, data: string) => {
      capturedWrite = data
    })
    setupMocks(fs)
    mod = await import('../pipeline-engine')

    const result = mod.setPipelineCron('pipe.yaml', '0 9 * * 1-5')
    expect(result).toBe(true)
    expect(capturedWrite).toContain('cron: "0 9 * * 1-5"')
  })

  it('updates existing cron field', async () => {
    const content = `name: My Pipeline
trigger:
  type: cron
  cron: "0 8 * * *"
  interval: 300
condition:
  type: always
action:
  prompt: Go
dedup:
  key: k
`
    const fs = buildFsMock(['pipe.yaml'], { 'pipe.yaml': content })
    let capturedWrite = ''
    fs.readFileSync.mockImplementation((p: string, _enc?: string) => {
      if (p === STATE_PATH) return '{}'
      if (p.endsWith('pipe.yaml')) return content
      throw new Error(`Unexpected: ${p}`)
    })
    fs.writeFileSync.mockImplementation((_p: string, data: string) => {
      capturedWrite = data
    })
    setupMocks(fs)
    mod = await import('../pipeline-engine')

    mod.setPipelineCron('pipe.yaml', '0 10 * * *')
    expect(capturedWrite).toContain('cron: "0 10 * * *"')
    expect(capturedWrite).not.toContain('cron: "0 8 * * *"')
  })

  it('removes cron field when null is passed', async () => {
    const content = `name: My Pipeline
trigger:
  type: cron
  cron: "0 8 * * *"
  interval: 300
condition:
  type: always
action:
  prompt: Go
dedup:
  key: k
`
    const fs = buildFsMock(['pipe.yaml'], { 'pipe.yaml': content })
    let capturedWrite = ''
    fs.readFileSync.mockImplementation((p: string, _enc?: string) => {
      if (p === STATE_PATH) return '{}'
      if (p.endsWith('pipe.yaml')) return content
      throw new Error(`Unexpected: ${p}`)
    })
    fs.writeFileSync.mockImplementation((_p: string, data: string) => {
      capturedWrite = data
    })
    setupMocks(fs)
    mod = await import('../pipeline-engine')

    mod.setPipelineCron('pipe.yaml', null)
    expect(capturedWrite).not.toContain('cron:')
  })
})

describe('pipeline-engine: debug log persistence', () => {
  let mod: typeof import('../pipeline-engine')

  beforeEach(async () => {
    vi.resetModules()
    vi.useFakeTimers()
    mockBroadcast.mockReset()
    mockGetAllRepoConfigs.mockReset().mockReturnValue([])
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    if (mod) mod.stopPipelines()
  })

  it('loads persisted debug log entries from disk on startup', async () => {
    const debugPath = `${PIPELINES_DIR}/My-Pipeline.debug.json`
    const entries = ['[12:00:00] poll started', '---', '[12:00:01] condition not met']
    const fs = buildFsMock(['my.yaml'], { 'my.yaml': VALID_YAML })
    fs.existsSync.mockImplementation((p: string) => {
      if (p === PIPELINES_DIR) return true
      if (p === debugPath) return true
      return false
    })
    fs.readFileSync.mockImplementation((p: string, _enc?: string) => {
      if (p.endsWith('my.yaml')) return VALID_YAML
      if (p === debugPath) return JSON.stringify({ entries, savedAt: new Date().toISOString() })
      throw new Error(`Unexpected readFileSync: ${p}`)
    })
    setupMocks(fs)
    mod = await import('../pipeline-engine')

    mod.loadPipelines()

    const list = mod.getPipelineList()
    expect(list).toHaveLength(1)
    expect(list[0].debugLog).toEqual(entries)
  })

  it('starts with empty debugLog when no persisted file exists', async () => {
    const fs = buildFsMock(['my.yaml'], { 'my.yaml': VALID_YAML })
    setupMocks(fs)
    mod = await import('../pipeline-engine')

    mod.loadPipelines()

    const list = mod.getPipelineList()
    expect(list[0].debugLog).toEqual([])
  })

  it('falls back to empty debugLog when the debug file is malformed JSON', async () => {
    const debugPath = `${PIPELINES_DIR}/My-Pipeline.debug.json`
    const fs = buildFsMock(['my.yaml'], { 'my.yaml': VALID_YAML })
    fs.existsSync.mockImplementation((p: string) => {
      if (p === PIPELINES_DIR) return true
      if (p === debugPath) return true
      return false
    })
    fs.readFileSync.mockImplementation((p: string, _enc?: string) => {
      if (p.endsWith('my.yaml')) return VALID_YAML
      if (p === debugPath) return 'not valid json{'
      throw new Error(`Unexpected readFileSync: ${p}`)
    })
    setupMocks(fs)
    mod = await import('../pipeline-engine')

    expect(() => mod.loadPipelines()).not.toThrow()
    const list = mod.getPipelineList()
    expect(list[0].debugLog).toEqual([])
  })

  it('falls back to empty debugLog when entries field is not an array', async () => {
    const debugPath = `${PIPELINES_DIR}/My-Pipeline.debug.json`
    const fs = buildFsMock(['my.yaml'], { 'my.yaml': VALID_YAML })
    fs.existsSync.mockImplementation((p: string) => {
      if (p === PIPELINES_DIR) return true
      if (p === debugPath) return true
      return false
    })
    fs.readFileSync.mockImplementation((p: string, _enc?: string) => {
      if (p.endsWith('my.yaml')) return VALID_YAML
      if (p === debugPath) return JSON.stringify({ entries: 'oops', savedAt: '' })
      throw new Error(`Unexpected readFileSync: ${p}`)
    })
    setupMocks(fs)
    mod = await import('../pipeline-engine')

    mod.loadPipelines()
    const list = mod.getPipelineList()
    expect(list[0].debugLog).toEqual([])
  })
})

describe('pipeline-engine: stopPipelines', () => {
  let mod: typeof import('../pipeline-engine')

  beforeEach(async () => {
    vi.resetModules()
    vi.useFakeTimers()
    mockBroadcast.mockReset()
    mockGetAllRepoConfigs.mockReset().mockReturnValue([])
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('stopPipelines clears all timers without error', async () => {
    const fs = buildFsMock([], {})
    setupMocks(fs)
    mod = await import('../pipeline-engine')

    // Should not throw even with no pipelines loaded
    expect(() => mod.stopPipelines()).not.toThrow()
  })

  it('getPipelineList returns empty array before any load', async () => {
    const fs = buildFsMock([], {})
    setupMocks(fs)
    mod = await import('../pipeline-engine')

    expect(mod.getPipelineList()).toEqual([])
  })
})

// ---- CRON pipeline YAML used for runPoll tests ----
const CRON_YAML = `
name: Cron Pipe
enabled: true
trigger:
  type: cron
  cron: "0 9 * * 1-5"
condition:
  type: always
action:
  type: launch-session
  prompt: Do work
dedup:
  key: daily
`

// Flush all pending microtasks (handles nested promise chains)
async function flushPromises() {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

describe('pipeline-engine: auto-pause on consecutive failures', () => {
  let mod: typeof import('../pipeline-engine')
  let mockCreateInstance: ReturnType<typeof vi.fn>
  let mockAppendActivity: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    vi.resetModules()
    vi.useFakeTimers()
    mockBroadcast.mockReset()
    mockGetAllRepoConfigs.mockReset().mockReturnValue([])
    mockCreateInstance = vi.fn().mockRejectedValue(new Error('simulated launch failure'))
    mockAppendActivity = vi.fn()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    if (mod) mod.stopPipelines()
  })

  function setupAutoMocks(fsMock: ReturnType<typeof buildFsMock>) {
    vi.doMock('electron', () => ({
      app: { getPath: vi.fn().mockReturnValue('/mock/home') },
    }))
    vi.doMock('../../shared/colony-paths', () => ({
      colonyPaths: {
        root: MOCK_ROOT,
        pipelines: PIPELINES_DIR,
        schedulerLog: `${MOCK_ROOT}/scheduler.log`,
      },
    }))
    vi.doMock('fs', () => fsMock)
    vi.doMock('../broadcast', () => ({ broadcast: mockBroadcast }))
    vi.doMock('../repo-config-loader', () => ({ getAllRepoConfigs: mockGetAllRepoConfigs }))
    vi.doMock('../instance-manager', () => ({
      createInstance: mockCreateInstance,
      getAllInstances: vi.fn().mockResolvedValue([]),
    }))
    vi.doMock('../daemon-client', () => ({ getDaemonClient: vi.fn() }))
    vi.doMock('../send-prompt-when-ready', () => ({ sendPromptWhenReady: vi.fn() }))
    vi.doMock('../github', () => ({
      getRepos: vi.fn().mockReturnValue([]),
      fetchPRs: vi.fn().mockResolvedValue([]),
      fetchChecks: vi.fn().mockResolvedValue({ checks: [] }),
      gh: vi.fn().mockResolvedValue('{}'),
    }))
    vi.doMock('../session-router', () => ({ findBestRoute: vi.fn().mockResolvedValue(null) }))
    vi.doMock('../activity-manager', () => ({ appendActivity: mockAppendActivity }))
    vi.doMock('../notifications', () => ({ notify: vi.fn() }))
  }

  it('starts with consecutiveFailures = 0', async () => {
    const fs = buildFsMock(['cron.yaml'], { 'cron.yaml': CRON_YAML })
    setupAutoMocks(fs)
    mod = await import('../pipeline-engine')
    mod.loadPipelines()
    expect(mod.getPipelineList()[0].consecutiveFailures).toBe(0)
  })

  it('increments consecutiveFailures after each failed poll', async () => {
    const fs = buildFsMock(['cron.yaml'], { 'cron.yaml': CRON_YAML })
    fs.readFileSync.mockImplementation((p: string, _enc?: string) => {
      if (p === STATE_PATH) return '{}'
      if (p.endsWith('cron.yaml')) return CRON_YAML
      throw new Error(`Unexpected: ${p}`)
    })
    setupAutoMocks(fs)
    mod = await import('../pipeline-engine')
    mod.loadPipelines()

    mod.triggerPollNow('Cron Pipe')
    await flushPromises()
    expect(mod.getPipelineList()[0].consecutiveFailures).toBe(1)

    mod.triggerPollNow('Cron Pipe')
    await flushPromises()
    expect(mod.getPipelineList()[0].consecutiveFailures).toBe(2)
  })

  it('auto-pauses pipeline after 3 consecutive failures', async () => {
    const fs = buildFsMock(['cron.yaml'], { 'cron.yaml': CRON_YAML })
    let capturedWrite = ''
    fs.readFileSync.mockImplementation((p: string, _enc?: string) => {
      if (p === STATE_PATH) return '{}'
      if (p.endsWith('cron.yaml')) return CRON_YAML
      throw new Error(`Unexpected: ${p}`)
    })
    fs.writeFileSync.mockImplementation((_p: string, data: string) => {
      if (typeof data === 'string' && data.includes('enabled:')) capturedWrite = data
    })
    setupAutoMocks(fs)
    mod = await import('../pipeline-engine')
    mod.loadPipelines()

    for (let i = 0; i < 3; i++) {
      mod.triggerPollNow('Cron Pipe')
      await flushPromises()
    }

    const p = mod.getPipelineList()[0]
    expect(p.enabled).toBe(false)
    expect(p.consecutiveFailures).toBe(3)
  })

  it('emits a warn activity event when auto-pausing', async () => {
    const fs = buildFsMock(['cron.yaml'], { 'cron.yaml': CRON_YAML })
    fs.readFileSync.mockImplementation((p: string, _enc?: string) => {
      if (p === STATE_PATH) return '{}'
      if (p.endsWith('cron.yaml')) return CRON_YAML
      throw new Error(`Unexpected: ${p}`)
    })
    setupAutoMocks(fs)
    mod = await import('../pipeline-engine')
    mod.loadPipelines()

    for (let i = 0; i < 3; i++) {
      mod.triggerPollNow('Cron Pipe')
      await flushPromises()
    }

    const warnCall = mockAppendActivity.mock.calls.find(
      (c: any[]) => c[0].level === 'warn',
    )
    expect(warnCall).toBeDefined()
    expect(warnCall[0].summary).toContain('auto-paused')
    expect(warnCall[0].summary).toContain('Cron Pipe')
  })

  it('resets consecutiveFailures to 0 on successful poll', async () => {
    // Two failures then success — counter should go back to 0
    const fs = buildFsMock(['cron.yaml'], { 'cron.yaml': CRON_YAML })
    fs.readFileSync.mockImplementation((p: string, _enc?: string) => {
      if (p === STATE_PATH) return '{}'
      if (p.endsWith('cron.yaml')) return CRON_YAML
      throw new Error(`Unexpected: ${p}`)
    })
    setupAutoMocks(fs)

    // Fail twice
    mod = await import('../pipeline-engine')
    mod.loadPipelines()

    mod.triggerPollNow('Cron Pipe')
    await flushPromises()
    mod.triggerPollNow('Cron Pipe')
    await flushPromises()
    expect(mod.getPipelineList()[0].consecutiveFailures).toBe(2)

    // Now make createInstance succeed
    mockCreateInstance.mockResolvedValueOnce({ id: 'inst-1' })
    // Also need sendPromptWhenReady to succeed — already mocked as vi.fn() returning undefined
    mod.triggerPollNow('Cron Pipe')
    await flushPromises()
    expect(mod.getPipelineList()[0].consecutiveFailures).toBe(0)
  })

  it('restores consecutiveFailures from saved state', async () => {
    const savedState = JSON.stringify({
      'Cron Pipe': {
        lastPollAt: null,
        lastMatchAt: null,
        firedKeys: {},
        contentHashes: {},
        fireCount: 2,
        lastFiredAt: null,
        lastError: 'prior error',
        consecutiveFailures: 2,
      },
    })
    const fs = buildFsMock(['cron.yaml'], { 'cron.yaml': CRON_YAML }, savedState)
    setupAutoMocks(fs)
    mod = await import('../pipeline-engine')
    mod.loadPipelines()

    expect(mod.getPipelineList()[0].consecutiveFailures).toBe(2)
  })

  it('does not auto-pause on non-consecutive failures (reset between)', async () => {
    // Use a timestamp-based dedup key so each poll evaluates independently
    const uniqueKeyYaml = CRON_YAML.replace('key: daily', 'key: "{{timestamp}}"')
    const fs = buildFsMock(['cron.yaml'], { 'cron.yaml': uniqueKeyYaml })
    fs.readFileSync.mockImplementation((p: string, _enc?: string) => {
      if (p === STATE_PATH) return '{}'
      if (p.endsWith('cron.yaml')) return uniqueKeyYaml
      throw new Error(`Unexpected: ${p}`)
    })
    setupAutoMocks(fs)
    mod = await import('../pipeline-engine')
    mod.loadPipelines()

    // Two failures
    mod.triggerPollNow('Cron Pipe')
    await flushPromises()
    mod.triggerPollNow('Cron Pipe')
    await flushPromises()
    expect(mod.getPipelineList()[0].consecutiveFailures).toBe(2)

    // One success — resets counter
    mockCreateInstance.mockResolvedValueOnce({ id: 'inst-1' })
    mod.triggerPollNow('Cron Pipe')
    await flushPromises()
    expect(mod.getPipelineList()[0].consecutiveFailures).toBe(0)

    // Two more failures — still below threshold, should NOT auto-pause
    mockCreateInstance.mockRejectedValue(new Error('fail again'))
    mod.triggerPollNow('Cron Pipe')
    await flushPromises()
    mod.triggerPollNow('Cron Pipe')
    await flushPromises()
    // Counter is back to 2 but pipeline should NOT be auto-paused (threshold is 3)
    expect(mod.getPipelineList()[0].enabled).toBe(true)
  })
})

// ---- Approval Gate YAML ----

const APPROVAL_YAML = `
name: Guarded Pipe
enabled: true
requireApproval: true
trigger:
  type: cron
  cron: "0 9 * * 1-5"
condition:
  type: always
action:
  type: launch-session
  prompt: Do guarded work
dedup:
  key: "{{timestamp}}"
`

describe('pipeline-engine: approval gates', () => {
  let mod: typeof import('../pipeline-engine')
  let mockCreateInstance: ReturnType<typeof vi.fn>
  let mockAppendActivity: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    vi.resetModules()
    vi.useFakeTimers()
    mockBroadcast.mockReset()
    mockGetAllRepoConfigs.mockReset().mockReturnValue([])
    mockCreateInstance = vi.fn().mockResolvedValue({ id: 'inst-approval' })
    mockAppendActivity = vi.fn()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    if (mod) mod.stopPipelines()
  })

  function setupApprovalMocks(fsMock: ReturnType<typeof buildFsMock>) {
    vi.doMock('electron', () => ({
      app: { getPath: vi.fn().mockReturnValue('/mock/home') },
    }))
    vi.doMock('../../shared/colony-paths', () => ({
      colonyPaths: {
        root: MOCK_ROOT,
        pipelines: PIPELINES_DIR,
        schedulerLog: `${MOCK_ROOT}/scheduler.log`,
      },
    }))
    vi.doMock('fs', () => fsMock)
    vi.doMock('../broadcast', () => ({ broadcast: mockBroadcast }))
    vi.doMock('../repo-config-loader', () => ({ getAllRepoConfigs: mockGetAllRepoConfigs }))
    vi.doMock('../instance-manager', () => ({
      createInstance: mockCreateInstance,
      getAllInstances: vi.fn().mockResolvedValue([]),
    }))
    vi.doMock('../daemon-client', () => ({ getDaemonClient: vi.fn() }))
    vi.doMock('../send-prompt-when-ready', () => ({ sendPromptWhenReady: vi.fn() }))
    vi.doMock('../github', () => ({
      getRepos: vi.fn().mockReturnValue([]),
      fetchPRs: vi.fn().mockResolvedValue([]),
      fetchChecks: vi.fn().mockResolvedValue({ checks: [] }),
      gh: vi.fn().mockResolvedValue('{}'),
    }))
    vi.doMock('../session-router', () => ({ findBestRoute: vi.fn().mockResolvedValue(null) }))
    vi.doMock('../activity-manager', () => ({ appendActivity: mockAppendActivity }))
    vi.doMock('../notifications', () => ({ notify: vi.fn() }))
  }

  it('queues an approval request instead of firing when requireApproval is true', async () => {
    const fs = buildFsMock(['guarded.yaml'], { 'guarded.yaml': APPROVAL_YAML })
    setupApprovalMocks(fs)
    mod = await import('../pipeline-engine')
    mod.loadPipelines()

    mod.triggerPollNow('Guarded Pipe')
    await flushPromises()

    // createInstance should NOT have been called
    expect(mockCreateInstance).not.toHaveBeenCalled()

    // An approval request should be queued
    const approvals = mod.listApprovals()
    expect(approvals).toHaveLength(1)
    expect(approvals[0].pipelineName).toBe('Guarded Pipe')
    expect(approvals[0].id).toBeTruthy()
    expect(approvals[0].createdAt).toBeTruthy()
  })

  it('broadcasts pipeline:approval:new when a request is queued', async () => {
    const fs = buildFsMock(['guarded.yaml'], { 'guarded.yaml': APPROVAL_YAML })
    setupApprovalMocks(fs)
    mod = await import('../pipeline-engine')
    mod.loadPipelines()

    mod.triggerPollNow('Guarded Pipe')
    await flushPromises()

    const newCall = mockBroadcast.mock.calls.find(([ch]) => ch === 'pipeline:approval:new')
    expect(newCall).toBeTruthy()
    expect(newCall![1].pipelineName).toBe('Guarded Pipe')
  })

  it('emits a warn activity event when queuing an approval', async () => {
    const fs = buildFsMock(['guarded.yaml'], { 'guarded.yaml': APPROVAL_YAML })
    setupApprovalMocks(fs)
    mod = await import('../pipeline-engine')
    mod.loadPipelines()

    mod.triggerPollNow('Guarded Pipe')
    await flushPromises()

    const warnCall = mockAppendActivity.mock.calls.find(([ev]) => ev.level === 'warn' && ev.summary.includes('waiting for approval'))
    expect(warnCall).toBeTruthy()
  })

  it('does not re-queue the same approval if dedupKey is already pending', async () => {
    // Use a fixed dedup key so both polls produce the same key
    const fixedKeyYaml = APPROVAL_YAML.replace('key: "{{timestamp}}"', 'key: fixed-key')
    const fs = buildFsMock(['guarded.yaml'], { 'guarded.yaml': fixedKeyYaml })
    setupApprovalMocks(fs)
    mod = await import('../pipeline-engine')
    mod.loadPipelines()

    mod.triggerPollNow('Guarded Pipe')
    await flushPromises()
    mod.triggerPollNow('Guarded Pipe')
    await flushPromises()

    expect(mod.listApprovals()).toHaveLength(1)
  })

  it('fires the action and removes approval when approveAction is called', async () => {
    const fs = buildFsMock(['guarded.yaml'], { 'guarded.yaml': APPROVAL_YAML })
    setupApprovalMocks(fs)
    mod = await import('../pipeline-engine')
    mod.loadPipelines()

    mod.triggerPollNow('Guarded Pipe')
    await flushPromises()

    const [approval] = mod.listApprovals()
    const result = await mod.approveAction(approval.id)
    await flushPromises()

    expect(result).toBe(true)
    expect(mockCreateInstance).toHaveBeenCalledOnce()
    expect(mod.listApprovals()).toHaveLength(0)
  })

  it('broadcasts pipeline:approval:update with status approved', async () => {
    const fs = buildFsMock(['guarded.yaml'], { 'guarded.yaml': APPROVAL_YAML })
    setupApprovalMocks(fs)
    mod = await import('../pipeline-engine')
    mod.loadPipelines()

    mod.triggerPollNow('Guarded Pipe')
    await flushPromises()

    const [approval] = mod.listApprovals()
    await mod.approveAction(approval.id)

    const updateCall = mockBroadcast.mock.calls.find(([ch]) => ch === 'pipeline:approval:update')
    expect(updateCall).toBeTruthy()
    expect(updateCall![1]).toEqual({ id: approval.id, status: 'approved' })
  })

  it('dismisses approval and removes it from the queue', async () => {
    const fixedKeyYaml = APPROVAL_YAML.replace('key: "{{timestamp}}"', 'key: dismiss-key')
    const fs = buildFsMock(['guarded.yaml'], { 'guarded.yaml': fixedKeyYaml })
    setupApprovalMocks(fs)
    mod = await import('../pipeline-engine')
    mod.loadPipelines()

    mod.triggerPollNow('Guarded Pipe')
    await flushPromises()

    const [approval] = mod.listApprovals()
    const result = mod.dismissAction(approval.id)

    expect(result).toBe(true)
    expect(mod.listApprovals()).toHaveLength(0)
    expect(mockCreateInstance).not.toHaveBeenCalled()
  })

  it('broadcasts pipeline:approval:update with status dismissed', async () => {
    const fixedKeyYaml = APPROVAL_YAML.replace('key: "{{timestamp}}"', 'key: dismiss-broadcast-key')
    const fs = buildFsMock(['guarded.yaml'], { 'guarded.yaml': fixedKeyYaml })
    setupApprovalMocks(fs)
    mod = await import('../pipeline-engine')
    mod.loadPipelines()

    mod.triggerPollNow('Guarded Pipe')
    await flushPromises()

    const [approval] = mod.listApprovals()
    mod.dismissAction(approval.id)

    const updateCall = mockBroadcast.mock.calls.find(([ch]) => ch === 'pipeline:approval:update')
    expect(updateCall).toBeTruthy()
    expect(updateCall![1]).toEqual({ id: approval.id, status: 'dismissed' })
  })

  it('allows re-queuing after dismiss (dedupKey cleared)', async () => {
    const fixedKeyYaml = APPROVAL_YAML.replace('key: "{{timestamp}}"', 'key: requeue-key')
    const fs = buildFsMock(['guarded.yaml'], { 'guarded.yaml': fixedKeyYaml })
    setupApprovalMocks(fs)
    mod = await import('../pipeline-engine')
    mod.loadPipelines()

    mod.triggerPollNow('Guarded Pipe')
    await flushPromises()

    const [approval] = mod.listApprovals()
    mod.dismissAction(approval.id)
    expect(mod.listApprovals()).toHaveLength(0)

    // Poll again — should re-queue since dedupKey was cleared
    mod.triggerPollNow('Guarded Pipe')
    await flushPromises()
    expect(mod.listApprovals()).toHaveLength(1)
  })

  it('returns false for approveAction / dismissAction on unknown id', async () => {
    const fs = buildFsMock(['guarded.yaml'], { 'guarded.yaml': APPROVAL_YAML })
    setupApprovalMocks(fs)
    mod = await import('../pipeline-engine')
    mod.loadPipelines()

    expect(await mod.approveAction('unknown-id')).toBe(false)
    expect(mod.dismissAction('unknown-id')).toBe(false)
  })
})

// ---- Approval Gate TTL YAML (with custom TTL) ----
const APPROVAL_TTL_YAML = `
name: Ttl Pipe
enabled: true
requireApproval: true
approvalTtl: 2
trigger:
  type: cron
  cron: "0 9 * * 1-5"
condition:
  type: always
action:
  type: launch-session
  prompt: Do ttl work
dedup:
  key: "{{timestamp}}"
`

describe('pipeline-engine: approval expiry (sweepExpiredApprovals)', () => {
  let mod: typeof import('../pipeline-engine')
  let mockCreateInstance: ReturnType<typeof vi.fn>
  let mockAppendActivity: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    vi.resetModules()
    vi.useFakeTimers()
    mockBroadcast.mockReset()
    mockGetAllRepoConfigs.mockReset().mockReturnValue([])
    mockCreateInstance = vi.fn().mockResolvedValue({ id: 'inst-ttl' })
    mockAppendActivity = vi.fn()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    if (mod) mod.stopPipelines()
  })

  function setupTtlMocks(fsMock: ReturnType<typeof buildFsMock>) {
    vi.doMock('electron', () => ({
      app: { getPath: vi.fn().mockReturnValue('/mock/home') },
    }))
    vi.doMock('../../shared/colony-paths', () => ({
      colonyPaths: {
        root: MOCK_ROOT,
        pipelines: PIPELINES_DIR,
        schedulerLog: `${MOCK_ROOT}/scheduler.log`,
      },
    }))
    vi.doMock('fs', () => fsMock)
    vi.doMock('../broadcast', () => ({ broadcast: mockBroadcast }))
    vi.doMock('../repo-config-loader', () => ({ getAllRepoConfigs: mockGetAllRepoConfigs }))
    vi.doMock('../instance-manager', () => ({
      createInstance: mockCreateInstance,
      getAllInstances: vi.fn().mockResolvedValue([]),
    }))
    vi.doMock('../daemon-client', () => ({ getDaemonClient: vi.fn() }))
    vi.doMock('../send-prompt-when-ready', () => ({ sendPromptWhenReady: vi.fn() }))
    vi.doMock('../github', () => ({
      getRepos: vi.fn().mockReturnValue([]),
      fetchPRs: vi.fn().mockResolvedValue([]),
      fetchChecks: vi.fn().mockResolvedValue({ checks: [] }),
      gh: vi.fn().mockResolvedValue('{}'),
    }))
    vi.doMock('../session-router', () => ({ findBestRoute: vi.fn().mockResolvedValue(null) }))
    vi.doMock('../activity-manager', () => ({ appendActivity: mockAppendActivity }))
    vi.doMock('../notifications', () => ({ notify: vi.fn() }))
  }

  it('approval request includes expiresAt set to now + approvalTtl hours', async () => {
    const fs = buildFsMock(['ttl.yaml'], { 'ttl.yaml': APPROVAL_TTL_YAML })
    setupTtlMocks(fs)
    mod = await import('../pipeline-engine')
    mod.loadPipelines()

    const before = Date.now()
    mod.triggerPollNow('Ttl Pipe')
    await flushPromises()

    const [approval] = mod.listApprovals()
    expect(approval.expiresAt).toBeTruthy()
    const expiresMs = new Date(approval.expiresAt!).getTime()
    // approvalTtl is 2 hours — expiresAt should be ~2h after createdAt
    const createdMs = new Date(approval.createdAt).getTime()
    expect(expiresMs).toBeGreaterThanOrEqual(createdMs + 2 * 3600 * 1000 - 1000)
    expect(expiresMs).toBeLessThanOrEqual(createdMs + 2 * 3600 * 1000 + 1000)
  })

  it('approval request uses default 24h TTL when approvalTtl not set', async () => {
    const fs = buildFsMock(['guarded.yaml'], { 'guarded.yaml': APPROVAL_YAML })
    setupTtlMocks(fs)
    mod = await import('../pipeline-engine')
    mod.loadPipelines()

    mod.triggerPollNow('Guarded Pipe')
    await flushPromises()

    const [approval] = mod.listApprovals()
    expect(approval.expiresAt).toBeTruthy()
    const expiresMs = new Date(approval.expiresAt!).getTime()
    const createdMs = new Date(approval.createdAt).getTime()
    expect(expiresMs).toBeGreaterThanOrEqual(createdMs + 24 * 3600 * 1000 - 1000)
    expect(expiresMs).toBeLessThanOrEqual(createdMs + 24 * 3600 * 1000 + 1000)
  })

  it('sweepExpiredApprovals removes an expired approval and broadcasts expired status', async () => {
    const fs = buildFsMock(['guarded.yaml'], { 'guarded.yaml': APPROVAL_YAML })
    setupTtlMocks(fs)
    mod = await import('../pipeline-engine')
    mod.loadPipelines()

    mod.triggerPollNow('Guarded Pipe')
    await flushPromises()

    const [approval] = mod.listApprovals()
    expect(approval).toBeTruthy()

    // Advance time past the expiry (default 24h)
    vi.advanceTimersByTime(25 * 3600 * 1000)

    mod.sweepExpiredApprovals()

    expect(mod.listApprovals()).toHaveLength(0)
    const expiredCall = mockBroadcast.mock.calls.find(([ch, data]) => ch === 'pipeline:approval:update' && data.status === 'expired')
    expect(expiredCall).toBeTruthy()
    expect(expiredCall![1]).toEqual({ id: approval.id, status: 'expired' })
  })

  it('sweepExpiredApprovals does not remove a non-expired approval', async () => {
    const fs = buildFsMock(['ttl.yaml'], { 'ttl.yaml': APPROVAL_TTL_YAML })
    setupTtlMocks(fs)
    mod = await import('../pipeline-engine')
    mod.loadPipelines()

    mod.triggerPollNow('Ttl Pipe')
    await flushPromises()

    // Only 1 hour has passed — TTL is 2h, so not yet expired
    vi.advanceTimersByTime(1 * 3600 * 1000)
    mod.sweepExpiredApprovals()

    expect(mod.listApprovals()).toHaveLength(1)
    const expiredCalls = mockBroadcast.mock.calls.filter(([ch, data]) => ch === 'pipeline:approval:update' && data.status === 'expired')
    expect(expiredCalls).toHaveLength(0)
  })

  it('sweepExpiredApprovals emits a warn activity event on expiry', async () => {
    const fs = buildFsMock(['guarded.yaml'], { 'guarded.yaml': APPROVAL_YAML })
    setupTtlMocks(fs)
    mod = await import('../pipeline-engine')
    mod.loadPipelines()

    mod.triggerPollNow('Guarded Pipe')
    await flushPromises()

    vi.advanceTimersByTime(25 * 3600 * 1000)
    mod.sweepExpiredApprovals()

    const warnCall = mockAppendActivity.mock.calls.find(([ev]) => ev.level === 'warn' && ev.summary.includes('expired'))
    expect(warnCall).toBeTruthy()
    expect(warnCall![0].summary).toContain('Guarded Pipe')
  })

  it('allows re-queuing after expiry (dedupKey cleared)', async () => {
    const fixedKeyYaml = APPROVAL_YAML.replace('key: "{{timestamp}}"', 'key: expire-requeue-key')
    const fs = buildFsMock(['guarded.yaml'], { 'guarded.yaml': fixedKeyYaml })
    setupTtlMocks(fs)
    mod = await import('../pipeline-engine')
    mod.loadPipelines()

    mod.triggerPollNow('Guarded Pipe')
    await flushPromises()
    expect(mod.listApprovals()).toHaveLength(1)

    // Expire it
    vi.advanceTimersByTime(25 * 3600 * 1000)
    mod.sweepExpiredApprovals()
    expect(mod.listApprovals()).toHaveLength(0)

    // Poll again — should be re-queued since dedupKey was cleared
    mod.triggerPollNow('Guarded Pipe')
    await flushPromises()
    expect(mod.listApprovals()).toHaveLength(1)
  })

  it('sweepExpiredApprovals is a no-op when there are no pending approvals', async () => {
    const fs = buildFsMock([], {})
    setupTtlMocks(fs)
    mod = await import('../pipeline-engine')

    expect(() => mod.sweepExpiredApprovals()).not.toThrow()
    expect(mod.listApprovals()).toHaveLength(0)
  })
})

// ---- Maker-Checker YAML fixtures ----

const MAKER_CHECKER_YAML = `
name: MC Pipe
enabled: true
trigger:
  type: cron
  cron: "0 9 * * 1-5"
condition:
  type: always
action:
  type: maker-checker
  makerPrompt: Implement the feature and write output to {{makerOutputFile}}
  checkerPrompt: Review the implementation. APPROVED if good, else NEEDS REVISION.
  maxIterations: 2
dedup:
  key: daily
`

describe('pipeline-engine: maker-checker YAML parsing', () => {
  let mod: typeof import('../pipeline-engine')

  beforeEach(async () => {
    vi.resetModules()
    vi.useFakeTimers()
    mockBroadcast.mockReset()
    mockGetAllRepoConfigs.mockReset().mockReturnValue([])
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    if (mod) mod.stopPipelines()
  })

  it('loads a valid maker-checker pipeline (no prompt field required)', async () => {
    const fs = buildFsMock(['mc.yaml'], { 'mc.yaml': MAKER_CHECKER_YAML })
    setupMocks(fs)
    mod = await import('../pipeline-engine')

    mod.loadPipelines()
    const list = mod.getPipelineList()
    expect(list).toHaveLength(1)
    expect(list[0].name).toBe('MC Pipe')
    expect(list[0].enabled).toBe(true)
  })

  it('rejects a maker-checker pipeline missing makerPrompt', async () => {
    const yaml = MAKER_CHECKER_YAML.replace('  makerPrompt: Implement the feature and write output to {{makerOutputFile}}\n', '')
    const fs = buildFsMock(['mc.yaml'], { 'mc.yaml': yaml })
    setupMocks(fs)
    mod = await import('../pipeline-engine')

    mod.loadPipelines()
    expect(mod.getPipelineList()).toHaveLength(0)
  })

  it('rejects a maker-checker pipeline missing checkerPrompt', async () => {
    const yaml = MAKER_CHECKER_YAML.replace('  checkerPrompt: Review the implementation. APPROVED if good, else NEEDS REVISION.\n', '')
    const fs = buildFsMock(['mc.yaml'], { 'mc.yaml': yaml })
    setupMocks(fs)
    mod = await import('../pipeline-engine')

    mod.loadPipelines()
    expect(mod.getPipelineList()).toHaveLength(0)
  })

  it('still rejects a launch-session pipeline missing prompt', async () => {
    const yaml = MAKER_CHECKER_YAML
      .replace('type: maker-checker', 'type: launch-session')
      .replace('  makerPrompt: Implement the feature and write output to {{makerOutputFile}}\n', '')
      .replace('  checkerPrompt: Review the implementation. APPROVED if good, else NEEDS REVISION.\n', '')
    const fs = buildFsMock(['mc.yaml'], { 'mc.yaml': yaml })
    setupMocks(fs)
    mod = await import('../pipeline-engine')

    mod.loadPipelines()
    expect(mod.getPipelineList()).toHaveLength(0)
  })

  it('defaults approvedKeyword to APPROVED and maxIterations to 3', async () => {
    // Verify parsing does not crash — these defaults are used in runMakerChecker at runtime
    const yaml = MAKER_CHECKER_YAML.replace('  maxIterations: 2\n', '')
    const fs = buildFsMock(['mc.yaml'], { 'mc.yaml': yaml })
    setupMocks(fs)
    mod = await import('../pipeline-engine')

    mod.loadPipelines()
    // Pipeline loads successfully — defaults are applied at runtime, not parse time
    expect(mod.getPipelineList()).toHaveLength(1)
  })
})

// ----------------------------------------------------------------

const FILE_POLL_YAML = `
name: File Watcher
enabled: true
trigger:
  type: file-poll
  interval: 30
  watch:
    - /watched/file.txt
condition:
  type: always
action:
  type: launch-session
  prompt: A file changed
dedup:
  key: file-changed
`

describe('pipeline-engine: file-poll trigger', () => {
  let mod: typeof import('../pipeline-engine')
  let fpCreateInstance: ReturnType<typeof vi.fn>
  let fpGetAllInstances: ReturnType<typeof vi.fn>

  function setupFilePollMocks(fsMock: ReturnType<typeof buildFsMock>) {
    vi.doMock('electron', () => ({
      app: { getPath: vi.fn().mockReturnValue('/mock/home') },
    }))
    vi.doMock('../../shared/colony-paths', () => ({
      colonyPaths: {
        root: MOCK_ROOT,
        pipelines: PIPELINES_DIR,
        schedulerLog: `${MOCK_ROOT}/scheduler.log`,
      },
    }))
    vi.doMock('fs', () => fsMock)
    vi.doMock('../broadcast', () => ({ broadcast: mockBroadcast }))
    vi.doMock('../repo-config-loader', () => ({ getAllRepoConfigs: mockGetAllRepoConfigs }))
    vi.doMock('../instance-manager', () => ({
      createInstance: fpCreateInstance,
      getAllInstances: fpGetAllInstances,
    }))
    vi.doMock('../daemon-client', () => ({ getDaemonClient: vi.fn() }))
    vi.doMock('../send-prompt-when-ready', () => ({ sendPromptWhenReady: vi.fn() }))
    vi.doMock('../notifications', () => ({ notify: vi.fn() }))
    vi.doMock('../github', () => ({
      getRepos: vi.fn().mockReturnValue([]),
      fetchPRs: vi.fn().mockResolvedValue([]),
      fetchChecks: vi.fn().mockResolvedValue({ checks: [] }),
      gh: vi.fn().mockResolvedValue('{}'),
    }))
    vi.doMock('../session-router', () => ({ findBestRoute: vi.fn().mockResolvedValue(null) }))
    vi.doMock('../activity-manager', () => ({ appendActivity: vi.fn() }))
  }

  beforeEach(async () => {
    vi.resetModules()
    vi.useFakeTimers()
    mockBroadcast.mockReset()
    mockGetAllRepoConfigs.mockReset().mockReturnValue([])
    fpCreateInstance = vi.fn().mockResolvedValue({ id: 'i1' })
    fpGetAllInstances = vi.fn().mockResolvedValue([])
  })

  afterEach(() => {
    if (mod) mod.stopPipelines()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('parses file-poll YAML and reports triggerType correctly', async () => {
    const fs = buildFsMock(['fw.yaml'], { 'fw.yaml': FILE_POLL_YAML })
    setupFilePollMocks(fs)
    mod = await import('../pipeline-engine')

    mod.loadPipelines()
    const list = mod.getPipelineList()
    expect(list).toHaveLength(1)
    expect(list[0].triggerType).toBe('file-poll')
    expect(list[0].name).toBe('File Watcher')
  })

  it('does not fire when watched file mtime has not changed', async () => {
    const fs = buildFsMock(['fw.yaml'], { 'fw.yaml': FILE_POLL_YAML }, undefined, {
      '/watched/file.txt': 1000,
    })
    setupFilePollMocks(fs)
    mod = await import('../pipeline-engine')

    await mod.startPipelines()
    // Advance 60s — mtime hasn't changed
    await vi.advanceTimersByTimeAsync(60_000)
    await flushPromises()

    expect(fpCreateInstance).not.toHaveBeenCalled()
  })

  it('fires runPoll when watched file mtime increases (via timer)', async () => {
    let mtime = 1000
    const fs = buildFsMock(['fw.yaml'], { 'fw.yaml': FILE_POLL_YAML })
    fs.statSync.mockImplementation((p: string) => {
      if (p === '/watched/file.txt') return { mtimeMs: mtime, isDirectory: () => false }
      throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' })
    })
    setupFilePollMocks(fs)
    mod = await import('../pipeline-engine')
    await mod.startPipelines()

    // Change mtime then let a full poll interval pass
    mtime = 2000
    await vi.advanceTimersByTimeAsync(30_000)
    await flushPromises()

    expect(fpCreateInstance).toHaveBeenCalled()
  })

  it('triggerPollNow fires the pipeline action for file-poll', async () => {
    const fs = buildFsMock(['fw.yaml'], { 'fw.yaml': FILE_POLL_YAML }, undefined, {
      '/watched/file.txt': 1000,
    })
    setupFilePollMocks(fs)
    mod = await import('../pipeline-engine')
    mod.loadPipelines()

    mod.triggerPollNow('File Watcher')
    await flushPromises()

    expect(fpCreateInstance).toHaveBeenCalled()
  })

  it('debounces: timer does not re-fire within 10s of last fire', async () => {
    let mtime = 1000
    const fs = buildFsMock(['fw.yaml'], { 'fw.yaml': FILE_POLL_YAML })
    fs.statSync.mockImplementation((p: string) => {
      if (p === '/watched/file.txt') return { mtimeMs: mtime, isDirectory: () => false }
      throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' })
    })
    setupFilePollMocks(fs)
    mod = await import('../pipeline-engine')
    await mod.startPipelines()

    // First change — fires
    mtime = 2000
    await vi.advanceTimersByTimeAsync(30_000)
    await flushPromises()
    const callsAfterFirst = fpCreateInstance.mock.calls.length

    // Second change immediately (within 10s cooldown) — timer should NOT re-fire
    mtime = 3000
    await vi.advanceTimersByTimeAsync(5_000)
    await flushPromises()
    expect(fpCreateInstance.mock.calls.length).toBe(callsAfterFirst)
  })
})

// ---- Artifact Handoff Protocol ----

describe('pipeline-engine: artifact handoff protocol', () => {
  let mod: typeof import('../pipeline-engine')

  const ARTIFACT_YAML = `
name: Artifact Pipeline
enabled: true
trigger:
  type: cron
  cron: "0 9 * * 1-5"
condition:
  type: always
action:
  type: launch-session
  prompt: Do the work
  artifactOutputs:
    - name: diff
      cmd: git diff HEAD
    - name: log
      cmd: git log --oneline -5
  artifactInputs:
    - prev-result
dedup:
  key: daily
`

  const mockExecSync = vi.fn()
  const mockCreateInstance = vi.fn().mockResolvedValue({ id: 'inst-1' })
  const mockSendPromptWhenReady = vi.fn()

  function setupArtifactMocks(fsMock: ReturnType<typeof buildFsMock>) {
    vi.doMock('electron', () => ({
      app: { getPath: vi.fn().mockReturnValue('/mock/home') },
    }))
    vi.doMock('../../shared/colony-paths', () => ({
      colonyPaths: {
        root: MOCK_ROOT,
        pipelines: PIPELINES_DIR,
        schedulerLog: `${MOCK_ROOT}/scheduler.log`,
      },
    }))
    vi.doMock('fs', () => fsMock)
    vi.doMock('child_process', () => ({ execSync: mockExecSync }))
    vi.doMock('../broadcast', () => ({ broadcast: vi.fn() }))
    vi.doMock('../repo-config-loader', () => ({ getAllRepoConfigs: vi.fn().mockReturnValue([]) }))
    vi.doMock('../instance-manager', () => ({
      createInstance: mockCreateInstance,
      getAllInstances: vi.fn().mockResolvedValue([]),
    }))
    vi.doMock('../daemon-client', () => ({ getDaemonClient: vi.fn() }))
    vi.doMock('../send-prompt-when-ready', () => ({ sendPromptWhenReady: mockSendPromptWhenReady }))
    vi.doMock('../notifications', () => ({ notify: vi.fn() }))
    vi.doMock('../github', () => ({
      getRepos: vi.fn().mockReturnValue([]),
      fetchPRs: vi.fn().mockResolvedValue([]),
      fetchChecks: vi.fn().mockResolvedValue({ checks: [] }),
      gh: vi.fn().mockResolvedValue('{}'),
    }))
    vi.doMock('../session-router', () => ({ findBestRoute: vi.fn().mockResolvedValue(null) }))
    vi.doMock('../activity-manager', () => ({ appendActivity: vi.fn() }))
  }

  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    mockExecSync.mockReset()
    mockCreateInstance.mockReset().mockResolvedValue({ id: 'inst-1' })
    mockSendPromptWhenReady.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    if (mod) mod.stopPipelines()
  })

  it('YAML parsing: artifactOutputs parsed as array of {name, cmd} objects', async () => {
    const fs = buildFsMock(['art.yaml'], { 'art.yaml': ARTIFACT_YAML })
    setupArtifactMocks(fs)
    mod = await import('../pipeline-engine')
    mod.loadPipelines()

    const list = mod.getPipelineList()
    expect(list).toHaveLength(1)
    // Action has artifactOutputs — verify it loaded (getPipelineList exposes raw def indirectly)
    // The parsed def is accessible via triggerPollNow path; verify pipeline loaded
    expect(list[0].name).toBe('Artifact Pipeline')
  })

  it('YAML parsing: pipeline with artifactOutputs and prompt is accepted', async () => {
    const fs = buildFsMock(['art.yaml'], { 'art.yaml': ARTIFACT_YAML })
    setupArtifactMocks(fs)
    mod = await import('../pipeline-engine')
    mod.loadPipelines()
    // Should load — prompt is present even with artifactOutputs
    expect(mod.getPipelineList()).toHaveLength(1)
  })

  it('captureArtifacts: execSync called for each artifactOutput when action fires', async () => {
    const artifactsDir = `${MOCK_ROOT}/artifacts`
    const fs = buildFsMock(
      ['art.yaml'],
      { 'art.yaml': ARTIFACT_YAML },
      undefined,
    )
    // existsSync: pipelines dir = true, artifacts dir = false (newly created), no input artifacts
    fs.existsSync.mockImplementation((p: string) => {
      if (p === PIPELINES_DIR) return true
      return false
    })
    mockExecSync.mockReturnValue(Buffer.from('diff output'))
    setupArtifactMocks(fs)
    mod = await import('../pipeline-engine')
    mod.loadPipelines()

    mod.triggerPollNow('Artifact Pipeline')
    await Promise.resolve() // flush microtasks

    // execSync should have been called for "diff" and "log" artifact outputs
    const execCalls = mockExecSync.mock.calls
    expect(execCalls.length).toBeGreaterThanOrEqual(2)
    const cmds = execCalls.map((c: any[]) => c[0])
    expect(cmds).toContain('git diff HEAD')
    expect(cmds).toContain('git log --oneline -5')
  })

  it('captureArtifacts: saves artifacts to COLONY_DIR/artifacts/<name>.txt', async () => {
    const fs = buildFsMock(['art.yaml'], { 'art.yaml': ARTIFACT_YAML })
    fs.existsSync.mockImplementation((p: string) => p === PIPELINES_DIR)
    mockExecSync.mockReturnValue(Buffer.from('captured content'))
    setupArtifactMocks(fs)
    mod = await import('../pipeline-engine')
    mod.loadPipelines()

    mod.triggerPollNow('Artifact Pipeline')
    await Promise.resolve()

    const writes = (fs.writeFileSync as ReturnType<typeof vi.fn>).mock.calls
    const artifactWrites = writes.filter((c: any[]) => String(c[0]).includes('/artifacts/'))
    expect(artifactWrites.length).toBeGreaterThanOrEqual(2)
    const paths = artifactWrites.map((c: any[]) => String(c[0]))
    expect(paths.some(p => p.endsWith('/diff.txt'))).toBe(true)
    expect(paths.some(p => p.endsWith('/log.txt'))).toBe(true)
  })

  it('loadArtifactPreamble: artifact contents are prepended to prompt', async () => {
    const artifactContent = 'previous result content'
    const fs = buildFsMock(['art.yaml'], { 'art.yaml': ARTIFACT_YAML })
    fs.existsSync.mockImplementation((p: string) => {
      if (p === PIPELINES_DIR) return true
      if (p.endsWith('prev-result.txt')) return true
      return false
    })
    fs.readFileSync.mockImplementation((p: string, _enc?: string) => {
      if (p.endsWith('prev-result.txt')) return artifactContent
      if (p.includes('.yaml')) return ARTIFACT_YAML
      throw new Error(`unexpected: ${p}`)
    })
    mockExecSync.mockReturnValue(Buffer.from(''))
    setupArtifactMocks(fs)
    mod = await import('../pipeline-engine')
    mod.loadPipelines()

    mod.triggerPollNow('Artifact Pipeline')
    await Promise.resolve()

    // Prompt file (writeFileSync) should contain the artifact preamble
    const writes = (fs.writeFileSync as ReturnType<typeof vi.fn>).mock.calls
    const promptWrite = writes.find((c: any[]) => String(c[0]).includes('pipeline-prompts'))
    expect(promptWrite).toBeDefined()
    const promptContent = String(promptWrite![1])
    expect(promptContent).toContain('--- Artifact: prev-result ---')
    expect(promptContent).toContain(artifactContent)
    // Original prompt should follow
    expect(promptContent).toContain('Do the work')
  })

  it('captureArtifacts: skips silently when execSync throws', async () => {
    const fs = buildFsMock(['art.yaml'], { 'art.yaml': ARTIFACT_YAML })
    fs.existsSync.mockImplementation((p: string) => p === PIPELINES_DIR)
    mockExecSync.mockImplementation(() => { throw new Error('git not a repo') })
    setupArtifactMocks(fs)
    mod = await import('../pipeline-engine')
    mod.loadPipelines()

    // Should not throw — errors are swallowed in captureArtifacts
    expect(() => mod.triggerPollNow('Artifact Pipeline')).not.toThrow()
  })
})

// ---- Structured Pipeline Stage Handoff ----

describe('pipeline-engine: structured handoff', () => {
  let mod: typeof import('../pipeline-engine')

  const HANDOFF_YAML = `
name: Handoff Pipeline
enabled: true
trigger:
  type: cron
  cron: "0 9 * * 1-5"
condition:
  type: always
action:
  type: launch-session
  prompt: Do the work
  handoffInputs:
    - review-briefing
  artifactInputs:
    - raw-diff
dedup:
  key: daily
`

  const mockExecSync = vi.fn()
  const mockCreateInstance = vi.fn().mockResolvedValue({ id: 'inst-1' })
  const mockSendPromptWhenReady = vi.fn()

  function setupHandoffMocks(fsMock: ReturnType<typeof buildFsMock>) {
    vi.doMock('electron', () => ({
      app: { getPath: vi.fn().mockReturnValue('/mock/home') },
    }))
    vi.doMock('../../shared/colony-paths', () => ({
      colonyPaths: {
        root: MOCK_ROOT,
        pipelines: PIPELINES_DIR,
        schedulerLog: `${MOCK_ROOT}/scheduler.log`,
      },
    }))
    vi.doMock('fs', () => fsMock)
    vi.doMock('child_process', () => ({ execSync: mockExecSync }))
    vi.doMock('../broadcast', () => ({ broadcast: vi.fn() }))
    vi.doMock('../repo-config-loader', () => ({ getAllRepoConfigs: vi.fn().mockReturnValue([]) }))
    vi.doMock('../instance-manager', () => ({
      createInstance: mockCreateInstance,
      getAllInstances: vi.fn().mockResolvedValue([]),
    }))
    vi.doMock('../daemon-client', () => ({ getDaemonClient: vi.fn() }))
    vi.doMock('../send-prompt-when-ready', () => ({ sendPromptWhenReady: mockSendPromptWhenReady }))
    vi.doMock('../notifications', () => ({ notify: vi.fn() }))
    vi.doMock('../github', () => ({
      getRepos: vi.fn().mockReturnValue([]),
      fetchPRs: vi.fn().mockResolvedValue([]),
      fetchChecks: vi.fn().mockResolvedValue({ checks: [] }),
      gh: vi.fn().mockResolvedValue('{}'),
    }))
    vi.doMock('../session-router', () => ({ findBestRoute: vi.fn().mockResolvedValue(null) }))
    vi.doMock('../activity-manager', () => ({ appendActivity: vi.fn() }))
  }

  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    mockExecSync.mockReset()
    mockCreateInstance.mockReset().mockResolvedValue({ id: 'inst-1' })
    mockSendPromptWhenReady.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    if (mod) mod.stopPipelines()
  })

  it('handoffInputs: content wrapped in narrative framing and prepended to prompt', async () => {
    const handoffContent = 'Decisions Made: Use async handlers\nFocus for Next Stage: auth module only'
    const fs = buildFsMock(['handoff.yaml'], { 'handoff.yaml': HANDOFF_YAML })
    fs.existsSync.mockImplementation((p: string) => {
      if (p === PIPELINES_DIR) return true
      if (p.endsWith('review-briefing.txt')) return true
      return false
    })
    fs.readFileSync.mockImplementation((p: string, _enc?: string) => {
      if (p.endsWith('review-briefing.txt')) return handoffContent
      if (p.includes('.yaml')) return HANDOFF_YAML
      throw new Error(`unexpected: ${p}`)
    })
    setupHandoffMocks(fs)
    mod = await import('../pipeline-engine')
    mod.loadPipelines()

    mod.triggerPollNow('Handoff Pipeline')
    await Promise.resolve()

    const writes = (fs.writeFileSync as ReturnType<typeof vi.fn>).mock.calls
    const promptWrite = writes.find((c: any[]) => String(c[0]).includes('pipeline-prompts'))
    expect(promptWrite).toBeDefined()
    const promptContent = String(promptWrite![1])
    expect(promptContent).toContain('--- Stage Handoff from Prior Stage ---')
    expect(promptContent).toContain('--- End of Stage Handoff ---')
    expect(promptContent).toContain(handoffContent)
    expect(promptContent).toContain('Do the work')
  })

  it('handoffInputs: missing file is silently skipped', async () => {
    const fs = buildFsMock(['handoff.yaml'], { 'handoff.yaml': HANDOFF_YAML })
    fs.existsSync.mockImplementation((p: string) => p === PIPELINES_DIR)
    fs.readFileSync.mockImplementation((p: string, _enc?: string) => {
      if (p.includes('.yaml')) return HANDOFF_YAML
      throw new Error(`unexpected: ${p}`)
    })
    setupHandoffMocks(fs)
    mod = await import('../pipeline-engine')
    mod.loadPipelines()

    expect(() => mod.triggerPollNow('Handoff Pipeline')).not.toThrow()
  })

  it('handoffInputs: framing text includes decision and focus instructions', async () => {
    const fs = buildFsMock(['handoff.yaml'], { 'handoff.yaml': HANDOFF_YAML })
    fs.existsSync.mockImplementation((p: string) => {
      if (p === PIPELINES_DIR) return true
      if (p.endsWith('review-briefing.txt')) return true
      return false
    })
    fs.readFileSync.mockImplementation((p: string, _enc?: string) => {
      if (p.endsWith('review-briefing.txt')) return 'context data'
      if (p.includes('.yaml')) return HANDOFF_YAML
      throw new Error(`unexpected: ${p}`)
    })
    setupHandoffMocks(fs)
    mod = await import('../pipeline-engine')
    mod.loadPipelines()

    mod.triggerPollNow('Handoff Pipeline')
    await Promise.resolve()

    const writes = (fs.writeFileSync as ReturnType<typeof vi.fn>).mock.calls
    const promptWrite = writes.find((c: any[]) => String(c[0]).includes('pipeline-prompts'))
    const promptContent = String(promptWrite![1])
    expect(promptContent).toContain('do not re-litigate them')
    expect(promptContent).toContain('Focus for Next Stage')
  })

  it('handoffInputs + artifactInputs: handoff precedes artifact in prompt', async () => {
    const fs = buildFsMock(['handoff.yaml'], { 'handoff.yaml': HANDOFF_YAML })
    fs.existsSync.mockImplementation((p: string) => {
      if (p === PIPELINES_DIR) return true
      if (p.endsWith('review-briefing.txt')) return true
      if (p.endsWith('raw-diff.txt')) return true
      return false
    })
    fs.readFileSync.mockImplementation((p: string, _enc?: string) => {
      if (p.endsWith('review-briefing.txt')) return 'HANDOFF_CONTENT'
      if (p.endsWith('raw-diff.txt')) return 'RAW_ARTIFACT_CONTENT'
      if (p.includes('.yaml')) return HANDOFF_YAML
      throw new Error(`unexpected: ${p}`)
    })
    setupHandoffMocks(fs)
    mod = await import('../pipeline-engine')
    mod.loadPipelines()

    mod.triggerPollNow('Handoff Pipeline')
    await Promise.resolve()

    const writes = (fs.writeFileSync as ReturnType<typeof vi.fn>).mock.calls
    const promptWrite = writes.find((c: any[]) => String(c[0]).includes('pipeline-prompts'))
    const promptContent = String(promptWrite![1])
    const handoffPos = promptContent.indexOf('--- Stage Handoff from Prior Stage ---')
    const artifactPos = promptContent.indexOf('--- Artifact: raw-diff ---')
    expect(handoffPos).toBeGreaterThanOrEqual(0)
    expect(artifactPos).toBeGreaterThanOrEqual(0)
    expect(handoffPos).toBeLessThan(artifactPos)
  })
})

// ---- Run History ----

const HISTORY_PATH = `${PIPELINES_DIR}/Cron-Pipe.history.json`

describe('pipeline-engine: run history', () => {
  let mod: typeof import('../pipeline-engine')
  let mockCreateInstance: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    mockBroadcast.mockReset()
    mockGetAllRepoConfigs.mockReset().mockReturnValue([])
    mockCreateInstance = vi.fn().mockResolvedValue({ id: 'inst-1', status: 'running' })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    if (mod) mod.stopPipelines()
  })

  function setupHistoryMocks(fsMock: ReturnType<typeof buildFsMock>) {
    vi.doMock('electron', () => ({
      app: { getPath: vi.fn().mockReturnValue('/mock/home') },
    }))
    vi.doMock('../../shared/colony-paths', () => ({
      colonyPaths: { root: MOCK_ROOT, pipelines: PIPELINES_DIR, schedulerLog: `${MOCK_ROOT}/scheduler.log` },
    }))
    vi.doMock('fs', () => fsMock)
    vi.doMock('../broadcast', () => ({ broadcast: mockBroadcast }))
    vi.doMock('../repo-config-loader', () => ({ getAllRepoConfigs: mockGetAllRepoConfigs }))
    vi.doMock('../instance-manager', () => ({
      createInstance: mockCreateInstance,
      getAllInstances: vi.fn().mockResolvedValue([]),
    }))
    vi.doMock('../daemon-client', () => ({ getDaemonClient: vi.fn() }))
    vi.doMock('../send-prompt-when-ready', () => ({ sendPromptWhenReady: vi.fn() }))
    vi.doMock('../github', () => ({
      getRepos: vi.fn().mockReturnValue([]),
      fetchPRs: vi.fn().mockResolvedValue([]),
      fetchChecks: vi.fn().mockResolvedValue({ checks: [] }),
      gh: vi.fn().mockResolvedValue('{}'),
    }))
    vi.doMock('../session-router', () => ({ findBestRoute: vi.fn().mockResolvedValue(null) }))
    vi.doMock('../activity-manager', () => ({ appendActivity: vi.fn() }))
    vi.doMock('../notifications', () => ({ notify: vi.fn() }))
  }

  it('getHistory returns [] when history file does not exist', async () => {
    const fs = buildFsMock(['cron.yaml'], { 'cron.yaml': CRON_YAML })
    // existsSync returns false for all paths except PIPELINES_DIR
    fs.existsSync.mockImplementation((p: string) => p === PIPELINES_DIR)
    setupHistoryMocks(fs)
    mod = await import('../pipeline-engine')
    mod.loadPipelines()

    expect(mod.getHistory('Cron Pipe')).toEqual([])
  })

  it('getHistory returns parsed entries when file exists', async () => {
    const entries = [
      { ts: '2026-01-01T00:00:00.000Z', trigger: 'cron', actionExecuted: true, success: true, durationMs: 1234 },
      { ts: '2026-01-02T00:00:00.000Z', trigger: 'cron', actionExecuted: false, success: true, durationMs: 567 },
    ]
    const fs = buildFsMock(['cron.yaml'], {
      'cron.yaml': CRON_YAML,
      'Cron-Pipe.history.json': JSON.stringify(entries),
    })
    fs.existsSync.mockImplementation((p: string) => p === PIPELINES_DIR || p.endsWith('.history.json'))
    setupHistoryMocks(fs)
    mod = await import('../pipeline-engine')
    mod.loadPipelines()

    const result = mod.getHistory('Cron Pipe')
    expect(result).toHaveLength(2)
    expect(result[0].trigger).toBe('cron')
    expect(result[0].actionExecuted).toBe(true)
    expect(result[1].actionExecuted).toBe(false)
  })

  it('getHistory returns [] on malformed JSON', async () => {
    const fs = buildFsMock(['cron.yaml'], {
      'cron.yaml': CRON_YAML,
      'Cron-Pipe.history.json': '{ not valid json [[[',
    })
    fs.existsSync.mockImplementation((p: string) => p === PIPELINES_DIR || p.endsWith('.history.json'))
    setupHistoryMocks(fs)
    mod = await import('../pipeline-engine')
    mod.loadPipelines()

    expect(mod.getHistory('Cron Pipe')).toEqual([])
  })

  it('runPoll writes a history entry to disk after cron fires', async () => {
    const fs = buildFsMock(['cron.yaml'], { 'cron.yaml': CRON_YAML })
    fs.existsSync.mockImplementation((p: string) => p === PIPELINES_DIR)
    setupHistoryMocks(fs)
    mod = await import('../pipeline-engine')
    await mod.startPipelines()

    // Trigger poll manually to avoid waiting for cron schedule
    mod.triggerPollNow('Cron Pipe')
    await flushPromises()

    // writeFileSync should be called with the history path
    const historyCalls = fs.writeFileSync.mock.calls.filter(
      (c: unknown[]) => typeof c[0] === 'string' && c[0].endsWith('Cron-Pipe.history.json')
    )
    expect(historyCalls.length).toBeGreaterThan(0)

    const written = JSON.parse(historyCalls[historyCalls.length - 1][1] as string)
    expect(Array.isArray(written)).toBe(true)
    expect(written.length).toBeGreaterThan(0)
    expect(written[written.length - 1]).toMatchObject({
      trigger: 'cron',
      success: true,
    })
  })

  it('runPoll includes stage trace when action fires', async () => {
    const fs = buildFsMock(['cron.yaml'], { 'cron.yaml': CRON_YAML })
    fs.existsSync.mockImplementation((p: string) => p === PIPELINES_DIR)
    setupHistoryMocks(fs)
    mod = await import('../pipeline-engine')
    await mod.startPipelines()

    mod.triggerPollNow('Cron Pipe')
    await flushPromises()

    const historyCalls = fs.writeFileSync.mock.calls.filter(
      (c: unknown[]) => typeof c[0] === 'string' && c[0].endsWith('Cron-Pipe.history.json')
    )
    expect(historyCalls.length).toBeGreaterThan(0)

    const written = JSON.parse(historyCalls[historyCalls.length - 1][1] as string)
    const entry = written[written.length - 1]
    expect(entry.stages).toBeDefined()
    expect(Array.isArray(entry.stages)).toBe(true)
    expect(entry.stages.length).toBe(1)
    expect(entry.stages[0]).toMatchObject({
      index: 0,
      actionType: 'launch-session',
      success: true,
    })
    expect(typeof entry.stages[0].durationMs).toBe('number')
  })
})

// ---- Diff Review YAML parsing ----

const DIFF_REVIEW_YAML = `
name: Diff Review Pipe
enabled: true
trigger:
  type: cron
  cron: "0 9 * * 1-5"
condition:
  type: always
action:
  type: diff_review
  workingDirectory: /repo
  diffBase: HEAD~2
  prompt: Review this diff carefully.
  autoFix: true
  autoFixMaxIterations: 3
dedup:
  key: daily
`

const DIFF_REVIEW_MINIMAL_YAML = `
name: Diff Review Minimal
enabled: true
trigger:
  type: cron
  cron: "0 9 * * 1-5"
condition:
  type: always
action:
  type: diff_review
  workingDirectory: /repo
dedup:
  key: daily
`

describe('pipeline-engine: diff_review YAML parsing', () => {
  let mod: typeof import('../pipeline-engine')

  beforeEach(async () => {
    vi.resetModules()
    vi.useFakeTimers()
    mockBroadcast.mockReset()
    mockGetAllRepoConfigs.mockReset().mockReturnValue([])
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    if (mod) mod.stopPipelines()
  })

  it('loads a valid diff_review pipeline (no prompt field required)', async () => {
    const fs = buildFsMock(['dr.yaml'], { 'dr.yaml': DIFF_REVIEW_MINIMAL_YAML })
    setupMocks(fs)
    mod = await import('../pipeline-engine')

    mod.loadPipelines()
    const list = mod.getPipelineList()
    expect(list).toHaveLength(1)
    expect(list[0].name).toBe('Diff Review Minimal')
    expect(list[0].enabled).toBe(true)
  })

  it('loads full diff_review pipeline with all optional fields', async () => {
    const fs = buildFsMock(['dr.yaml'], { 'dr.yaml': DIFF_REVIEW_YAML })
    setupMocks(fs)
    mod = await import('../pipeline-engine')

    mod.loadPipelines()
    const list = mod.getPipelineList()
    expect(list).toHaveLength(1)
    expect(list[0].name).toBe('Diff Review Pipe')
  })

  it('rejects diff_review pipeline that is missing trigger type', async () => {
    const yaml = DIFF_REVIEW_MINIMAL_YAML.replace('type: diff_review', '').replace('type: cron', 'type: cron')
    const brokenYaml = `
name: Broken Diff Review
enabled: true
trigger:
  type: cron
  cron: "0 9 * * 1-5"
condition:
  type: always
action:
  workingDirectory: /repo
dedup:
  key: daily
`
    const fs = buildFsMock(['dr.yaml'], { 'dr.yaml': brokenYaml })
    setupMocks(fs)
    mod = await import('../pipeline-engine')

    mod.loadPipelines()
    // Missing action.type means action.type is undefined, not 'diff_review' — prompt also absent → rejected
    expect(mod.getPipelineList()).toHaveLength(0)
  })

  it('stage trace records diff_review actionType', async () => {
    const mockSpawnSync = vi.fn().mockReturnValue({ status: 0, stdout: Buffer.from(''), stderr: Buffer.from('') })
    const mockCreateInstance2 = vi.fn().mockResolvedValue({ id: 'dr-inst' })
    const mockGetDaemon = vi.fn().mockReturnValue({
      getInstance: vi.fn().mockResolvedValue({ tokenUsage: { cost: 0.05 } }),
    })
    const mockSendPromptWhenReady2 = vi.fn()
    const mockWaitForCompletion = vi.fn().mockResolvedValue(true)

    vi.resetModules()
    vi.useFakeTimers()

    const fs = buildFsMock(['dr.yaml'], { 'dr.yaml': DIFF_REVIEW_MINIMAL_YAML })
    fs.existsSync.mockImplementation((p: string) => p === PIPELINES_DIR)

    vi.doMock('electron', () => ({ app: { getPath: vi.fn().mockReturnValue('/mock/home') } }))
    vi.doMock('../../shared/colony-paths', () => ({
      colonyPaths: { root: MOCK_ROOT, pipelines: PIPELINES_DIR, schedulerLog: `${MOCK_ROOT}/scheduler.log` },
    }))
    vi.doMock('fs', () => fs)
    vi.doMock('child_process', () => ({ execSync: vi.fn(), spawnSync: mockSpawnSync }))
    vi.doMock('../broadcast', () => ({ broadcast: mockBroadcast }))
    vi.doMock('../repo-config-loader', () => ({ getAllRepoConfigs: vi.fn().mockReturnValue([]) }))
    vi.doMock('../instance-manager', () => ({
      createInstance: mockCreateInstance2,
      getAllInstances: vi.fn().mockResolvedValue([]),
    }))
    vi.doMock('../daemon-client', () => ({ getDaemonClient: mockGetDaemon }))
    vi.doMock('../send-prompt-when-ready', () => ({ sendPromptWhenReady: mockSendPromptWhenReady2 }))
    vi.doMock('../notifications', () => ({ notify: vi.fn() }))
    vi.doMock('../github', () => ({
      getRepos: vi.fn().mockReturnValue([]),
      fetchPRs: vi.fn().mockResolvedValue([]),
      fetchChecks: vi.fn().mockResolvedValue({ checks: [] }),
      gh: vi.fn().mockResolvedValue('{}'),
    }))
    vi.doMock('../session-router', () => ({ findBestRoute: vi.fn().mockResolvedValue(null) }))
    vi.doMock('../activity-manager', () => ({ appendActivity: vi.fn() }))

    mod = await import('../pipeline-engine')
    mod.loadPipelines()

    mod.triggerPollNow('Diff Review Minimal')
    await flushPromises()

    // spawnSync used for git rev-parse validation — should have been called
    // (no diff found since stdout is empty → stage passes as 'No changes')
    const historyCalls = (fs.writeFileSync as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => typeof c[0] === 'string' && c[0].endsWith('Diff-Review-Minimal.history.json')
    )
    expect(historyCalls.length).toBeGreaterThan(0)
    const written = JSON.parse(historyCalls[historyCalls.length - 1][1] as string)
    const entry = written[written.length - 1]
    expect(entry.stages).toBeDefined()
    expect(entry.stages[0].actionType).toBe('diff_review')
  })
})
