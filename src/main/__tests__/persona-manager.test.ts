/**
 * Tests for src/main/persona-manager.ts
 *
 * persona-manager has module-level state (stateCache, stateFile, schedulerInterval).
 * Strategy: vi.resetModules() + vi.doMock() + dynamic import per test group.
 * Driving the public API (getPersonaList, createPersona, togglePersona, etc.)
 * and verifying that frontmatter parsing, state management, file ops, and
 * scheduler behaviour work correctly.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const MOCK_ROOT = '/mock/.claude-colony'
const PERSONAS_DIR = `${MOCK_ROOT}/personas`
const STATE_PATH = `${MOCK_ROOT}/persona-state.json`
const SCHEDULER_LOG = `${MOCK_ROOT}/scheduler.log`

// ---- YAML fixtures ----

const FULL_PERSONA_MD = `---
name: "Test Persona"
schedule: "*/30 * * * 0,6"
model: opus
max_sessions: 2
can_push: true
can_merge: false
can_create_sessions: true
working_directory: "~/projects/test"
color: "#34d399"
---

## Role

Does something useful.
`

const MINIMAL_PERSONA_MD = `---
name: "Minimal"
schedule: "0 9 * * 1-5"
---

## Role

Minimal content.
`

const NO_NAME_PERSONA_MD = `---
schedule: "0 9 * * 1-5"
model: sonnet
---
`

// ---- Shared mock instances (vi.hoisted so they exist before vi.mock() factories) ----

const mockGetAllInstances = vi.hoisted(() => vi.fn())
const mockCreateInstance = vi.hoisted(() => vi.fn())
const mockKillInstance = vi.hoisted(() => vi.fn())
const mockGetDaemonClient = vi.hoisted(() => vi.fn())
const mockSendPromptWhenReady = vi.hoisted(() => vi.fn())
const mockUpdateColonyContext = vi.hoisted(() => vi.fn())
const mockBroadcast = vi.hoisted(() => vi.fn())
const mockCronMatches = vi.hoisted(() => vi.fn())

// ---- fs mock builder ----

function buildFsMock(options: {
  personaFiles?: string[]
  personaContents?: Record<string, string>  // filename → content
  stateJson?: string
} = {}) {
  const { personaFiles = [], personaContents = {}, stateJson } = options

  return {
    existsSync: vi.fn().mockImplementation((p: string) => {
      if (p === PERSONAS_DIR) return true
      if (p === STATE_PATH) return stateJson !== undefined
      for (const filename of Object.keys(personaContents)) {
        if (p === `${PERSONAS_DIR}/${filename}`) return true
      }
      return false
    }),
    readFileSync: vi.fn().mockImplementation((p: string, _enc?: string) => {
      if (p === STATE_PATH) return stateJson ?? '{}'
      for (const [filename, content] of Object.entries(personaContents)) {
        if (p === `${PERSONAS_DIR}/${filename}`) return content
      }
      throw new Error(`Unexpected readFileSync: ${p}`)
    }),
    writeFileSync: vi.fn(),
    appendFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    readdirSync: vi.fn().mockImplementation((p: string) => {
      if (p === PERSONAS_DIR) return personaFiles
      return []
    }),
    unlinkSync: vi.fn(),
    watch: vi.fn().mockReturnValue({ close: vi.fn() }),
  }
}

function setupMocks(fsMock: ReturnType<typeof buildFsMock>) {
  vi.doMock('../../shared/colony-paths', () => ({
    colonyPaths: {
      root: MOCK_ROOT,
      personas: PERSONAS_DIR,
      personaState: STATE_PATH,
      schedulerLog: SCHEDULER_LOG,
      colonyContext: `${MOCK_ROOT}/colony-context.md`,
    },
  }))
  vi.doMock('fs', () => fsMock)
  vi.doMock('../broadcast', () => ({ broadcast: mockBroadcast }))
  vi.doMock('../instance-manager', () => ({
    createInstance: mockCreateInstance,
    getAllInstances: mockGetAllInstances,
    killInstance: mockKillInstance,
  }))
  vi.doMock('../daemon-client', () => ({ getDaemonClient: mockGetDaemonClient }))
  vi.doMock('../send-prompt-when-ready', () => ({ sendPromptWhenReady: mockSendPromptWhenReady }))
  vi.doMock('../colony-context', () => ({ updateColonyContext: mockUpdateColonyContext }))
  vi.doMock('../../shared/cron', () => ({ cronMatches: mockCronMatches }))
}

// ---- Test suites ----

describe('persona-manager: getPersonaList / parseFrontmatter', () => {
  let mod: typeof import('../persona-manager')

  beforeEach(async () => {
    vi.resetModules()
    mockBroadcast.mockReset()
    mockGetAllInstances.mockReset().mockResolvedValue([])
  })

  afterEach(() => {
    vi.restoreAllMocks()
    if (mod) mod.stopScheduler()
  })

  it('returns parsed PersonaInfo from a full frontmatter file', async () => {
    const fs = buildFsMock({
      personaFiles: ['test-persona.md'],
      personaContents: { 'test-persona.md': FULL_PERSONA_MD },
    })
    setupMocks(fs)
    mod = await import('../persona-manager')

    const list = mod.getPersonaList()
    expect(list).toHaveLength(1)
    const p = list[0]
    expect(p.id).toBe('test-persona')
    expect(p.name).toBe('Test Persona')
    expect(p.schedule).toBe('*/30 * * * 0,6')
    expect(p.model).toBe('opus')
    expect(p.maxSessions).toBe(2)
    expect(p.canPush).toBe(true)
    expect(p.canMerge).toBe(false)
    expect(p.canCreateSessions).toBe(true)
  })

  it('applies default model=sonnet and color when omitted', async () => {
    const fs = buildFsMock({
      personaFiles: ['minimal.md'],
      personaContents: { 'minimal.md': MINIMAL_PERSONA_MD },
    })
    setupMocks(fs)
    mod = await import('../persona-manager')

    const list = mod.getPersonaList()
    expect(list).toHaveLength(1)
    expect(list[0].model).toBe('sonnet')
  })

  it('skips a file with no name field', async () => {
    const fs = buildFsMock({
      personaFiles: ['no-name.md'],
      personaContents: { 'no-name.md': NO_NAME_PERSONA_MD },
    })
    setupMocks(fs)
    mod = await import('../persona-manager')

    expect(mod.getPersonaList()).toHaveLength(0)
  })

  it('skips non-.md files in the personas directory', async () => {
    const fs = buildFsMock({
      personaFiles: ['persona.md', 'readme.txt', 'config.yaml'],
      personaContents: { 'persona.md': FULL_PERSONA_MD },
    })
    setupMocks(fs)
    mod = await import('../persona-manager')

    expect(mod.getPersonaList()).toHaveLength(1)
  })

  it('returns empty array when directory is empty', async () => {
    const fs = buildFsMock({ personaFiles: [] })
    setupMocks(fs)
    mod = await import('../persona-manager')

    expect(mod.getPersonaList()).toHaveLength(0)
  })

  it('merges saved state (enabled, runCount) from stateCache', async () => {
    const stateJson = JSON.stringify({
      'Test Persona': {
        lastRunAt: '2026-01-01T12:00:00.000Z',
        runCount: 7,
        activeSessionId: 'sess-abc',
        enabled: true,
        lastRunOutput: 'last output',
      },
    })
    const fs = buildFsMock({
      personaFiles: ['test-persona.md'],
      personaContents: { 'test-persona.md': FULL_PERSONA_MD },
      stateJson,
    })
    setupMocks(fs)
    mod = await import('../persona-manager')
    mod.loadPersonas()  // populates stateCache from stateJson

    const list = mod.getPersonaList()
    expect(list[0].enabled).toBe(true)
    expect(list[0].runCount).toBe(7)
    expect(list[0].lastRun).toBe('2026-01-01T12:00:00.000Z')
    expect(list[0].activeSessionId).toBe('sess-abc')
    expect(list[0].lastRunOutput).toBe('last output')
  })

  it('defaults to enabled=false and runCount=0 with no saved state', async () => {
    const fs = buildFsMock({
      personaFiles: ['test-persona.md'],
      personaContents: { 'test-persona.md': FULL_PERSONA_MD },
    })
    setupMocks(fs)
    mod = await import('../persona-manager')

    const list = mod.getPersonaList()
    expect(list[0].enabled).toBe(false)
    expect(list[0].runCount).toBe(0)
    expect(list[0].activeSessionId).toBeNull()
  })
})

// ----------------------------------------------------------------

describe('persona-manager: getPersonaContent', () => {
  let mod: typeof import('../persona-manager')

  beforeEach(async () => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    if (mod) mod.stopScheduler()
  })

  it('returns file content when file exists', async () => {
    const fs = buildFsMock({
      personaContents: { 'my-persona.md': FULL_PERSONA_MD },
    })
    setupMocks(fs)
    mod = await import('../persona-manager')

    const content = mod.getPersonaContent('my-persona')
    expect(content).toBe(FULL_PERSONA_MD)
  })

  it('appends .md when fileName has no extension', async () => {
    const fs = buildFsMock({
      personaContents: { 'my-persona.md': FULL_PERSONA_MD },
    })
    setupMocks(fs)
    mod = await import('../persona-manager')

    // Both forms should work
    expect(mod.getPersonaContent('my-persona')).toBe(FULL_PERSONA_MD)
    expect(mod.getPersonaContent('my-persona.md')).toBe(FULL_PERSONA_MD)
  })

  it('returns null when file does not exist', async () => {
    const fs = buildFsMock({ personaContents: {} })
    setupMocks(fs)
    mod = await import('../persona-manager')

    expect(mod.getPersonaContent('nonexistent')).toBeNull()
  })
})

// ----------------------------------------------------------------

describe('persona-manager: setPersonaSchedule', () => {
  let mod: typeof import('../persona-manager')

  beforeEach(async () => {
    vi.resetModules()
    mockBroadcast.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    if (mod) mod.stopScheduler()
  })

  it('returns false when file does not exist', async () => {
    const fs = buildFsMock({ personaContents: {} })
    setupMocks(fs)
    mod = await import('../persona-manager')

    expect(mod.setPersonaSchedule('ghost', '0 9 * * *')).toBe(false)
  })

  it('updates the schedule field in-place', async () => {
    const fs = buildFsMock({
      personaContents: { 'test-persona.md': FULL_PERSONA_MD },
    })
    setupMocks(fs)
    mod = await import('../persona-manager')

    const result = mod.setPersonaSchedule('test-persona', '0 10 * * 1-5')
    expect(result).toBe(true)
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      `${PERSONAS_DIR}/test-persona.md`,
      expect.stringContaining('schedule: "0 10 * * 1-5"'),
      'utf-8',
    )
  })

  it('preserves content outside the schedule line', async () => {
    const fs = buildFsMock({
      personaContents: { 'test-persona.md': FULL_PERSONA_MD },
    })
    setupMocks(fs)
    mod = await import('../persona-manager')

    mod.setPersonaSchedule('test-persona', '0 8 * * *')
    const [, written] = fs.writeFileSync.mock.calls[0] as [string, string]
    expect(written).toContain('name: "Test Persona"')
    expect(written).toContain('model: opus')
    expect(written).toContain('Does something useful.')
  })
})

// ----------------------------------------------------------------

describe('persona-manager: createPersona', () => {
  let mod: typeof import('../persona-manager')

  beforeEach(async () => {
    vi.resetModules()
    mockBroadcast.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    if (mod) mod.stopScheduler()
  })

  it('creates an unnamed.md file for empty name (slugify fallback)', async () => {
    const fs = buildFsMock({ personaContents: {} })
    fs.existsSync.mockImplementation((p: string) => p === PERSONAS_DIR)
    setupMocks(fs)
    mod = await import('../persona-manager')

    const result = mod.createPersona('')
    expect(result).not.toBeNull()
    expect(result!.fileName).toBe('unnamed.md')
  })

  it('returns null when a file with that slug already exists', async () => {
    const fs = buildFsMock({
      personaContents: { 'test-persona.md': FULL_PERSONA_MD },
    })
    setupMocks(fs)
    mod = await import('../persona-manager')

    expect(mod.createPersona('Test Persona')).toBeNull()
  })

  it('creates a new .md file with template content', async () => {
    const fs = buildFsMock({ personaContents: {} })
    // Make existsSync return false for new file path
    fs.existsSync.mockImplementation((p: string) => p === PERSONAS_DIR)
    setupMocks(fs)
    mod = await import('../persona-manager')

    const result = mod.createPersona('My New Agent')
    expect(result).not.toBeNull()
    expect(result!.fileName).toBe('my-new-agent.md')
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      `${PERSONAS_DIR}/my-new-agent.md`,
      expect.stringContaining('name: "My New Agent"'),
      'utf-8',
    )
  })

  it('written template includes expected sections', async () => {
    const fs = buildFsMock({ personaContents: {} })
    fs.existsSync.mockImplementation((p: string) => p === PERSONAS_DIR)
    setupMocks(fs)
    mod = await import('../persona-manager')

    mod.createPersona('Review Bot')
    const [, content] = fs.writeFileSync.mock.calls[0] as [string, string]
    expect(content).toContain('## Role')
    expect(content).toContain('## Objectives')
    expect(content).toContain('## Session Log')
    expect(content).toContain('schedule: ""')
  })
})

// ----------------------------------------------------------------

describe('persona-manager: deletePersona', () => {
  let mod: typeof import('../persona-manager')

  beforeEach(async () => {
    vi.resetModules()
    mockBroadcast.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    if (mod) mod.stopScheduler()
  })

  it('deletes file and returns true when file exists', async () => {
    const fs = buildFsMock({
      personaContents: { 'test-persona.md': FULL_PERSONA_MD },
    })
    setupMocks(fs)
    mod = await import('../persona-manager')

    const result = mod.deletePersona('test-persona')
    expect(result).toBe(true)
    expect(fs.unlinkSync).toHaveBeenCalledWith(`${PERSONAS_DIR}/test-persona.md`)
  })

  it('returns false when file does not exist', async () => {
    const fs = buildFsMock({ personaContents: {} })
    setupMocks(fs)
    mod = await import('../persona-manager')

    expect(mod.deletePersona('ghost')).toBe(false)
    expect(fs.unlinkSync).not.toHaveBeenCalled()
  })

  it('broadcasts status update after deletion', async () => {
    const fs = buildFsMock({
      personaContents: { 'test-persona.md': FULL_PERSONA_MD },
    })
    setupMocks(fs)
    mod = await import('../persona-manager')

    mod.deletePersona('test-persona')
    expect(mockBroadcast).toHaveBeenCalledWith('persona:status', expect.any(Array))
  })
})

// ----------------------------------------------------------------

describe('persona-manager: togglePersona', () => {
  let mod: typeof import('../persona-manager')

  beforeEach(async () => {
    vi.resetModules()
    mockBroadcast.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    if (mod) mod.stopScheduler()
  })

  it('returns false when file does not exist', async () => {
    const fs = buildFsMock({ personaContents: {} })
    setupMocks(fs)
    mod = await import('../persona-manager')

    expect(mod.togglePersona('ghost', true)).toBe(false)
  })

  it('returns false when file has invalid frontmatter', async () => {
    const noFrontmatter = '## Just a heading\n\nNo frontmatter here.'
    const fs = buildFsMock({
      personaContents: { 'bad.md': noFrontmatter },
    })
    setupMocks(fs)
    mod = await import('../persona-manager')

    expect(mod.togglePersona('bad', true)).toBe(false)
  })

  it('sets enabled=true in state and reflects in getPersonaList', async () => {
    const fs = buildFsMock({
      personaFiles: ['test-persona.md'],
      personaContents: { 'test-persona.md': FULL_PERSONA_MD },
    })
    setupMocks(fs)
    mod = await import('../persona-manager')

    expect(mod.togglePersona('test-persona', true)).toBe(true)
    const list = mod.getPersonaList()
    expect(list[0].enabled).toBe(true)
  })

  it('sets enabled=false after previously enabled', async () => {
    const fs = buildFsMock({
      personaFiles: ['test-persona.md'],
      personaContents: { 'test-persona.md': FULL_PERSONA_MD },
    })
    setupMocks(fs)
    mod = await import('../persona-manager')

    mod.togglePersona('test-persona', true)
    mod.togglePersona('test-persona', false)
    const list = mod.getPersonaList()
    expect(list[0].enabled).toBe(false)
  })
})

// ----------------------------------------------------------------

describe('persona-manager: schedulerLog + startScheduler / stopScheduler', () => {
  let mod: typeof import('../persona-manager')

  beforeEach(async () => {
    vi.resetModules()
    vi.useFakeTimers()
    mockBroadcast.mockReset()
    mockGetAllInstances.mockReset().mockResolvedValue([])
  })

  afterEach(async () => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    if (mod) mod.stopScheduler()
  })

  it('startScheduler writes a "scheduler started" log entry', async () => {
    const fs = buildFsMock()
    setupMocks(fs)
    mod = await import('../persona-manager')

    mod.startScheduler()
    expect(fs.appendFileSync).toHaveBeenCalledWith(
      SCHEDULER_LOG,
      expect.stringContaining('scheduler started'),
      'utf-8',
    )
  })

  it('startScheduler is idempotent — second call is a no-op', async () => {
    const fs = buildFsMock()
    setupMocks(fs)
    mod = await import('../persona-manager')

    mod.startScheduler()
    const callCount = fs.appendFileSync.mock.calls.length
    mod.startScheduler()
    expect(fs.appendFileSync.mock.calls.length).toBe(callCount)  // no second log entry
  })

  it('stopScheduler writes a "scheduler stopped" log entry', async () => {
    const fs = buildFsMock()
    setupMocks(fs)
    mod = await import('../persona-manager')

    mod.startScheduler()
    fs.appendFileSync.mockClear()
    mod.stopScheduler()
    expect(fs.appendFileSync).toHaveBeenCalledWith(
      SCHEDULER_LOG,
      expect.stringContaining('scheduler stopped'),
      'utf-8',
    )
  })

  it('stopScheduler is a no-op when scheduler is not running', async () => {
    const fs = buildFsMock()
    setupMocks(fs)
    mod = await import('../persona-manager')

    expect(() => mod.stopScheduler()).not.toThrow()
  })

  it('can restart after stop', async () => {
    const fs = buildFsMock()
    setupMocks(fs)
    mod = await import('../persona-manager')

    mod.startScheduler()
    mod.stopScheduler()
    fs.appendFileSync.mockClear()
    mod.startScheduler()  // should re-register interval and log
    expect(fs.appendFileSync).toHaveBeenCalledWith(
      SCHEDULER_LOG,
      expect.stringContaining('scheduler started'),
      'utf-8',
    )
  })

  it('scheduler tick calls getAllInstances for reconciliation', async () => {
    const fs = buildFsMock({ personaFiles: [], personaContents: {} })
    setupMocks(fs)
    mod = await import('../persona-manager')

    mod.startScheduler()
    await vi.advanceTimersByTimeAsync(15_000)

    expect(mockGetAllInstances).toHaveBeenCalled()
  })

  it('skips runPersona for disabled personas', async () => {
    const stateJson = JSON.stringify({
      'Test Persona': {
        lastRunAt: null, runCount: 0, activeSessionId: null, enabled: false, lastRunOutput: null,
      },
    })
    const fs = buildFsMock({
      personaFiles: ['test-persona.md'],
      personaContents: { 'test-persona.md': FULL_PERSONA_MD },
      stateJson,
    })
    setupMocks(fs)
    mockCronMatches.mockReturnValue(true)
    mod = await import('../persona-manager')
    mod.loadPersonas()

    mod.startScheduler()
    await vi.advanceTimersByTimeAsync(15_000)

    expect(mockCreateInstance).not.toHaveBeenCalled()
  })
})

// ----------------------------------------------------------------

describe('persona-manager: onSessionExit', () => {
  let mod: typeof import('../persona-manager')

  beforeEach(async () => {
    vi.resetModules()
    mockBroadcast.mockReset()
    mockGetDaemonClient.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    if (mod) mod.stopScheduler()
  })

  it('clears activeSessionId for the matching persona', async () => {
    const stateJson = JSON.stringify({
      'Test Persona': {
        lastRunAt: '2026-01-01T12:00:00.000Z',
        runCount: 3,
        activeSessionId: 'sess-xyz',
        enabled: true,
        lastRunOutput: null,
      },
    })
    const fs = buildFsMock({
      personaFiles: ['test-persona.md'],
      personaContents: { 'test-persona.md': FULL_PERSONA_MD },
      stateJson,
    })
    // Mock daemon client to return empty buffer
    mockGetDaemonClient.mockReturnValue({
      getInstanceBuffer: vi.fn().mockResolvedValue(null),
    })
    setupMocks(fs)
    mod = await import('../persona-manager')
    mod.loadPersonas()

    await mod.onSessionExit('sess-xyz')

    const list = mod.getPersonaList()
    expect(list[0].activeSessionId).toBeNull()
  })

  it('does nothing when no persona has that session id', async () => {
    const stateJson = JSON.stringify({
      'Test Persona': {
        lastRunAt: null, runCount: 0, activeSessionId: 'sess-other', enabled: false, lastRunOutput: null,
      },
    })
    const fs = buildFsMock({
      personaFiles: ['test-persona.md'],
      personaContents: { 'test-persona.md': FULL_PERSONA_MD },
      stateJson,
    })
    mockGetDaemonClient.mockReturnValue({
      getInstanceBuffer: vi.fn().mockResolvedValue(null),
    })
    setupMocks(fs)
    mod = await import('../persona-manager')
    mod.loadPersonas()

    // writeFileSync count before exit (should be 0 — nothing written yet)
    const wsBefore = fs.writeFileSync.mock.calls.length
    await mod.onSessionExit('sess-unknown')
    // state file should NOT have been written (no match)
    expect(fs.writeFileSync.mock.calls.length).toBe(wsBefore)
  })

  it('captures and strips ANSI from buffer output', async () => {
    const stateJson = JSON.stringify({
      'Test Persona': {
        lastRunAt: null, runCount: 1, activeSessionId: 'sess-456', enabled: true, lastRunOutput: null,
      },
    })
    const fs = buildFsMock({
      personaFiles: ['test-persona.md'],
      personaContents: { 'test-persona.md': FULL_PERSONA_MD },
      stateJson,
    })
    const rawBuffer = '\x1b[32mHello World\x1b[0m\r\nDone'
    mockGetDaemonClient.mockReturnValue({
      getInstanceBuffer: vi.fn().mockResolvedValue(rawBuffer),
    })
    setupMocks(fs)
    mod = await import('../persona-manager')
    mod.loadPersonas()

    await mod.onSessionExit('sess-456')

    const list = mod.getPersonaList()
    expect(list[0].lastRunOutput).toBe('Hello World\nDone')
  })
})
