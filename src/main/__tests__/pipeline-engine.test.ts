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
  vi.doMock('../github', () => ({
    getRepos: vi.fn().mockReturnValue([]),
    fetchPRs: vi.fn().mockResolvedValue([]),
    fetchChecks: vi.fn().mockResolvedValue({ checks: [] }),
    gh: vi.fn().mockResolvedValue('{}'),
  }))
  vi.doMock('../session-router', () => ({ findBestRoute: vi.fn().mockResolvedValue(null) }))
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
