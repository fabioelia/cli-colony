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
const mockExecSync = vi.hoisted(() => vi.fn())
const mockAppendActivity = vi.hoisted(() => vi.fn())

// ---- fs mock builder ----

const KNOWLEDGE_PATH = `${MOCK_ROOT}/KNOWLEDGE.md`

function buildFsMock(options: {
  personaFiles?: string[]
  personaContents?: Record<string, string>  // filename → content
  stateJson?: string
  workingDirs?: string[]  // extra paths existsSync returns true for
  knowledgeContent?: string  // content for KNOWLEDGE.md; undefined = file absent
} = {}) {
  const { personaFiles = [], personaContents = {}, stateJson, workingDirs = [], knowledgeContent } = options

  return {
    existsSync: vi.fn().mockImplementation((p: string) => {
      if (p === PERSONAS_DIR) return true
      if (p === STATE_PATH) return stateJson !== undefined
      if (p === KNOWLEDGE_PATH) return knowledgeContent !== undefined
      if (workingDirs.includes(p)) return true
      for (const filename of Object.keys(personaContents)) {
        if (p === `${PERSONAS_DIR}/${filename}`) return true
      }
      return false
    }),
    readFileSync: vi.fn().mockImplementation((p: string, _enc?: string) => {
      if (p === STATE_PATH) return stateJson ?? '{}'
      if (p === KNOWLEDGE_PATH) return knowledgeContent ?? ''
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
      knowledgeBase: KNOWLEDGE_PATH,
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
  vi.doMock('child_process', () => ({ execSync: mockExecSync }))
  vi.doMock('../activity-manager', () => ({ appendActivity: mockAppendActivity }))
  vi.doMock('../notifications', () => ({ notify: vi.fn() }))
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
    mockExecSync.mockReset()
    mockAppendActivity.mockReset()
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

// ----------------------------------------------------------------

describe('persona-manager: onSessionExit outcome stats', () => {
  let mod: typeof import('../persona-manager')
  const WORK_DIR = '/mock/projects/test'
  const STARTED_AT = new Date(Date.now() - 120_000).toISOString() // 2 minutes ago

  beforeEach(async () => {
    vi.resetModules()
    mockBroadcast.mockReset()
    mockGetDaemonClient.mockReset()
    mockExecSync.mockReset()
    mockAppendActivity.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    if (mod) mod.stopScheduler()
  })

  it('emits session-outcome details with commits and files when git succeeds', async () => {
    const stateJson = JSON.stringify({
      'Test Persona': {
        lastRunAt: STARTED_AT,
        runCount: 1,
        activeSessionId: 'sess-abc',
        enabled: true,
        lastRunOutput: null,
        sessionStartedAt: STARTED_AT,
        sessionWorkingDir: WORK_DIR,
      },
    })
    const fs = buildFsMock({
      personaFiles: ['test-persona.md'],
      personaContents: { 'test-persona.md': FULL_PERSONA_MD },
      stateJson,
      workingDirs: [WORK_DIR],
    })
    mockGetDaemonClient.mockReturnValue({ getInstanceBuffer: vi.fn().mockResolvedValue(null) })
    // First execSync call: git log → 3 commits
    // Second execSync call: git log --name-only → 4 unique files
    mockExecSync
      .mockReturnValueOnce('abc1234 feat: add foo\ndef5678 fix: bar\n9990000 chore: update')
      .mockReturnValueOnce('src/foo.ts\nsrc/bar.ts\nsrc/foo.ts\nsrc/baz.ts')
    setupMocks(fs)
    mod = await import('../persona-manager')
    mod.loadPersonas()

    await mod.onSessionExit('sess-abc')

    expect(mockAppendActivity).toHaveBeenCalledOnce()
    const call = mockAppendActivity.mock.calls[0][0]
    expect(call.source).toBe('persona')
    expect(call.details?.type).toBe('session-outcome')
    expect(call.details?.commitsCount).toBe(3)
    expect(call.details?.filesChanged).toBe(3) // 3 unique: foo.ts, bar.ts, baz.ts
    expect(typeof call.details?.duration).toBe('number')
    expect(call.details?.duration as number).toBeGreaterThan(0)
    expect(call.summary).toContain('3 commits')
  })

  it('emits session-outcome with duration=null when sessionStartedAt is missing', async () => {
    const stateJson = JSON.stringify({
      'Test Persona': {
        lastRunAt: null,
        runCount: 1,
        activeSessionId: 'sess-nostart',
        enabled: true,
        lastRunOutput: null,
        sessionStartedAt: null,
        sessionWorkingDir: null,
      },
    })
    const fs = buildFsMock({
      personaFiles: ['test-persona.md'],
      personaContents: { 'test-persona.md': FULL_PERSONA_MD },
      stateJson,
    })
    mockGetDaemonClient.mockReturnValue({ getInstanceBuffer: vi.fn().mockResolvedValue(null) })
    setupMocks(fs)
    mod = await import('../persona-manager')
    mod.loadPersonas()

    await mod.onSessionExit('sess-nostart')

    expect(mockAppendActivity).toHaveBeenCalledOnce()
    const call = mockAppendActivity.mock.calls[0][0]
    expect(call.details?.type).toBe('session-outcome')
    expect(call.details?.duration).toBeNull()
    expect(call.details?.commitsCount).toBe(0)
    expect(call.details?.filesChanged).toBe(0)
    // Git commands not attempted when no startedAt/workingDir
    expect(mockExecSync).not.toHaveBeenCalled()
  })

  it('handles git failure gracefully — still emits outcome with zeroed stats', async () => {
    const stateJson = JSON.stringify({
      'Test Persona': {
        lastRunAt: STARTED_AT,
        runCount: 2,
        activeSessionId: 'sess-gitfail',
        enabled: true,
        lastRunOutput: null,
        sessionStartedAt: STARTED_AT,
        sessionWorkingDir: WORK_DIR,
      },
    })
    const fs = buildFsMock({
      personaFiles: ['test-persona.md'],
      personaContents: { 'test-persona.md': FULL_PERSONA_MD },
      stateJson,
      workingDirs: [WORK_DIR],
    })
    mockGetDaemonClient.mockReturnValue({ getInstanceBuffer: vi.fn().mockResolvedValue(null) })
    mockExecSync.mockImplementation(() => { throw new Error('not a git repository') })
    setupMocks(fs)
    mod = await import('../persona-manager')
    mod.loadPersonas()

    await mod.onSessionExit('sess-gitfail')

    expect(mockAppendActivity).toHaveBeenCalledOnce()
    const call = mockAppendActivity.mock.calls[0][0]
    expect(call.details?.commitsCount).toBe(0)
    expect(call.details?.filesChanged).toBe(0)
    // Summary should not contain "commits" when count is 0
    expect(call.summary).not.toContain('commit')
  })

  it('skips files stat when commit count is zero', async () => {
    const stateJson = JSON.stringify({
      'Test Persona': {
        lastRunAt: STARTED_AT,
        runCount: 1,
        activeSessionId: 'sess-nocommits',
        enabled: true,
        lastRunOutput: null,
        sessionStartedAt: STARTED_AT,
        sessionWorkingDir: WORK_DIR,
      },
    })
    const fs = buildFsMock({
      personaFiles: ['test-persona.md'],
      personaContents: { 'test-persona.md': FULL_PERSONA_MD },
      stateJson,
      workingDirs: [WORK_DIR],
    })
    mockGetDaemonClient.mockReturnValue({ getInstanceBuffer: vi.fn().mockResolvedValue(null) })
    // git log returns empty string → 0 commits
    mockExecSync.mockReturnValueOnce('')
    setupMocks(fs)
    mod = await import('../persona-manager')
    mod.loadPersonas()

    await mod.onSessionExit('sess-nocommits')

    // Only one execSync call (git log), not two (no files query)
    expect(mockExecSync).toHaveBeenCalledOnce()
    const call = mockAppendActivity.mock.calls[0][0]
    expect(call.details?.commitsCount).toBe(0)
    expect(call.details?.filesChanged).toBe(0)
  })
})

// ----------------------------------------------------------------

describe('persona-manager: parseWhispers (via getPersonaList)', () => {
  let mod: typeof import('../persona-manager')

  beforeEach(async () => {
    vi.resetModules()
    mockBroadcast.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    if (mod) mod.stopScheduler()
  })

  it('returns empty whispers array when no Whispers section', async () => {
    const fs = buildFsMock({
      personaFiles: ['test-persona.md'],
      personaContents: { 'test-persona.md': FULL_PERSONA_MD },
    })
    setupMocks(fs)
    mod = await import('../persona-manager')

    const list = mod.getPersonaList()
    expect(list[0].whispers).toEqual([])
  })

  it('returns empty whispers array when Whispers section is empty', async () => {
    const content = FULL_PERSONA_MD.trimEnd() + '\n\n## Whispers\n'
    const fs = buildFsMock({
      personaFiles: ['test-persona.md'],
      personaContents: { 'test-persona.md': content },
    })
    setupMocks(fs)
    mod = await import('../persona-manager')

    const list = mod.getPersonaList()
    expect(list[0].whispers).toEqual([])
  })

  it('parses a single whisper entry correctly', async () => {
    const content = FULL_PERSONA_MD.trimEnd() +
      '\n\n## Whispers\n- [2026-04-05T10:00:00.000Z] Check the pipeline logs\n'
    const fs = buildFsMock({
      personaFiles: ['test-persona.md'],
      personaContents: { 'test-persona.md': content },
    })
    setupMocks(fs)
    mod = await import('../persona-manager')

    const list = mod.getPersonaList()
    expect(list[0].whispers).toHaveLength(1)
    expect(list[0].whispers[0]).toEqual({
      createdAt: '2026-04-05T10:00:00.000Z',
      text: 'Check the pipeline logs',
    })
  })

  it('parses multiple whisper entries', async () => {
    const content = FULL_PERSONA_MD.trimEnd() +
      '\n\n## Whispers\n' +
      '- [2026-04-05T10:00:00.000Z] First whisper\n' +
      '- [2026-04-05T11:00:00.000Z] Second whisper\n'
    const fs = buildFsMock({
      personaFiles: ['test-persona.md'],
      personaContents: { 'test-persona.md': content },
    })
    setupMocks(fs)
    mod = await import('../persona-manager')

    const list = mod.getPersonaList()
    expect(list[0].whispers).toHaveLength(2)
    expect(list[0].whispers[0].text).toBe('First whisper')
    expect(list[0].whispers[1].text).toBe('Second whisper')
  })

  it('skips malformed lines (no timestamp bracket)', async () => {
    const content = FULL_PERSONA_MD.trimEnd() +
      '\n\n## Whispers\n' +
      '- [2026-04-05T10:00:00.000Z] Valid whisper\n' +
      '- plain text without brackets\n' +
      '  indented line\n' +
      '- [2026-04-05T12:00:00.000Z] Another valid one\n'
    const fs = buildFsMock({
      personaFiles: ['test-persona.md'],
      personaContents: { 'test-persona.md': content },
    })
    setupMocks(fs)
    mod = await import('../persona-manager')

    const list = mod.getPersonaList()
    // plain text and indented lines don't start with "- [" so they're skipped
    expect(list[0].whispers).toHaveLength(2)
    expect(list[0].whispers[0].text).toBe('Valid whisper')
    expect(list[0].whispers[1].text).toBe('Another valid one')
  })
})

// ----------------------------------------------------------------

describe('persona-manager: addWhisper', () => {
  let mod: typeof import('../persona-manager')

  beforeEach(async () => {
    vi.resetModules()
    mockBroadcast.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    if (mod) mod.stopScheduler()
  })

  it('returns false when persona file does not exist', async () => {
    const fs = buildFsMock({ personaContents: {} })
    setupMocks(fs)
    mod = await import('../persona-manager')

    expect(mod.addWhisper('ghost', 'hello')).toBe(false)
    expect(fs.writeFileSync).not.toHaveBeenCalled()
  })

  it('creates ## Notes section when absent and returns true', async () => {
    const fs = buildFsMock({
      personaContents: { 'test-persona.md': FULL_PERSONA_MD },
    })
    setupMocks(fs)
    mod = await import('../persona-manager')

    const result = mod.addWhisper('test-persona', 'Do the thing')
    expect(result).toBe(true)
    expect(fs.writeFileSync).toHaveBeenCalledOnce()
    const [, written] = fs.writeFileSync.mock.calls[0] as [string, string, string]
    expect(written).toContain('## Notes\n')
    expect(written).toContain('Do the thing')
  })

  it('appends to existing ## Notes section', async () => {
    const existingContent = FULL_PERSONA_MD.trimEnd() +
      '\n\n## Notes\n- [2026-04-01T00:00:00.000Z] Old note\n'
    const fs = buildFsMock({
      personaContents: { 'test-persona.md': existingContent },
    })
    setupMocks(fs)
    mod = await import('../persona-manager')

    mod.addWhisper('test-persona', 'New note')
    const [, written] = fs.writeFileSync.mock.calls[0] as [string, string, string]
    // New note injected right after the section header
    expect(written).toMatch(/## Notes\n- \[.+\] New note\n- \[2026-04-01/)
    // Old note still present
    expect(written).toContain('Old note')
  })

  it('appends to legacy ## Whispers section (backward compat)', async () => {
    const existingContent = FULL_PERSONA_MD.trimEnd() +
      '\n\n## Whispers\n- [2026-04-01T00:00:00.000Z] Old whisper\n'
    const fs = buildFsMock({
      personaContents: { 'test-persona.md': existingContent },
    })
    setupMocks(fs)
    mod = await import('../persona-manager')

    mod.addWhisper('test-persona', 'New note')
    const [, written] = fs.writeFileSync.mock.calls[0] as [string, string, string]
    expect(written).toContain('New note')
    expect(written).toContain('Old whisper')
  })

  it('trims whitespace from text', async () => {
    const fs = buildFsMock({
      personaContents: { 'test-persona.md': FULL_PERSONA_MD },
    })
    setupMocks(fs)
    mod = await import('../persona-manager')

    mod.addWhisper('test-persona', '   padded text   ')
    const [, written] = fs.writeFileSync.mock.calls[0] as [string, string, string]
    expect(written).toContain('padded text')
    expect(written).not.toContain('   padded text   ')
  })

  it('broadcasts status after successful write', async () => {
    const fs = buildFsMock({
      personaFiles: ['test-persona.md'],
      personaContents: { 'test-persona.md': FULL_PERSONA_MD },
    })
    setupMocks(fs)
    mod = await import('../persona-manager')

    mod.addWhisper('test-persona', 'hello')
    expect(mockBroadcast).toHaveBeenCalledWith('persona:status', expect.any(Array))
  })

  it('accepts fileName with .md extension', async () => {
    const fs = buildFsMock({
      personaContents: { 'test-persona.md': FULL_PERSONA_MD },
    })
    setupMocks(fs)
    mod = await import('../persona-manager')

    expect(mod.addWhisper('test-persona.md', 'test')).toBe(true)
    expect(fs.writeFileSync).toHaveBeenCalledOnce()
  })
})

// ----------------------------------------------------------------

describe('persona-manager: on_complete_run (completion triggers)', () => {
  let mod: typeof import('../persona-manager')

  beforeEach(async () => {
    vi.resetModules()
    mockBroadcast.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    if (mod) mod.stopScheduler()
  })

  it('returns empty onCompleteRun when field is absent', async () => {
    const fs = buildFsMock({
      personaFiles: ['test-persona.md'],
      personaContents: { 'test-persona.md': FULL_PERSONA_MD },
    })
    setupMocks(fs)
    mod = await import('../persona-manager')

    const list = mod.getPersonaList()
    expect(list[0].onCompleteRun).toEqual([])
  })

  it('parses inline array with quoted strings', async () => {
    const content = FULL_PERSONA_MD.replace(
      'color: "#34d399"',
      'color: "#34d399"\non_complete_run: ["colony-qa", "colony-product"]'
    )
    const fs = buildFsMock({
      personaFiles: ['test-persona.md'],
      personaContents: { 'test-persona.md': content },
    })
    setupMocks(fs)
    mod = await import('../persona-manager')

    const list = mod.getPersonaList()
    expect(list[0].onCompleteRun).toEqual(['colony-qa', 'colony-product'])
  })

  it('parses inline array without quotes', async () => {
    const content = FULL_PERSONA_MD.replace(
      'color: "#34d399"',
      'color: "#34d399"\non_complete_run: [colony-qa, colony-product]'
    )
    const fs = buildFsMock({
      personaFiles: ['test-persona.md'],
      personaContents: { 'test-persona.md': content },
    })
    setupMocks(fs)
    mod = await import('../persona-manager')

    const list = mod.getPersonaList()
    expect(list[0].onCompleteRun).toEqual(['colony-qa', 'colony-product'])
  })

  it('parses single-item array', async () => {
    const content = FULL_PERSONA_MD.replace(
      'color: "#34d399"',
      'color: "#34d399"\non_complete_run: ["colony-qa"]'
    )
    const fs = buildFsMock({
      personaFiles: ['test-persona.md'],
      personaContents: { 'test-persona.md': content },
    })
    setupMocks(fs)
    mod = await import('../persona-manager')

    const list = mod.getPersonaList()
    expect(list[0].onCompleteRun).toEqual(['colony-qa'])
  })

  it('returns empty array for empty brackets', async () => {
    const content = FULL_PERSONA_MD.replace(
      'color: "#34d399"',
      'color: "#34d399"\non_complete_run: []'
    )
    const fs = buildFsMock({
      personaFiles: ['test-persona.md'],
      personaContents: { 'test-persona.md': content },
    })
    setupMocks(fs)
    mod = await import('../persona-manager')

    const list = mod.getPersonaList()
    expect(list[0].onCompleteRun).toEqual([])
  })
})

// ----------------------------------------------------------------

describe('persona-manager: Colony Knowledge Base injection', () => {
  let mod: typeof import('../persona-manager')

  const MOCK_INSTANCE = {
    id: 'inst-kb-1', name: 'Persona: Test Persona', status: 'running',
    activity: 'waiting', workingDirectory: '/mock/projects/test',
    color: '#34d399', args: [], createdAt: Date.now(), pinned: false,
    cliBackend: 'claude', gitBranch: null, gitRepo: null,
    tokenUsage: { inputTokens: 0, outputTokens: 0, cost: 0 },
    roleTag: null,
  }

  beforeEach(async () => {
    vi.resetModules()
    mockBroadcast.mockReset()
    mockCreateInstance.mockReset().mockResolvedValue(MOCK_INSTANCE)
    mockGetAllInstances.mockReset().mockResolvedValue([])
    mockUpdateColonyContext.mockReset().mockResolvedValue(undefined)
    mockSendPromptWhenReady.mockReset()
    mockGetDaemonClient.mockReset().mockReturnValue({ on: vi.fn(), removeListener: vi.fn() })
    mockAppendActivity.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    if (mod) mod.stopScheduler()
  })

  it('omits Colony Knowledge section when KNOWLEDGE.md does not exist', async () => {
    const fs = buildFsMock({
      personaFiles: ['test-persona.md'],
      personaContents: { 'test-persona.md': FULL_PERSONA_MD },
      // knowledgeContent absent → file does not exist
    })
    setupMocks(fs)
    mod = await import('../persona-manager')
    mod.loadPersonas()

    await mod.runPersona('test-persona.md')

    const writeCalls = fs.writeFileSync.mock.calls
    const promptWrite = writeCalls.find((c: unknown[]) => String(c[0]).includes('persona-'))
    expect(promptWrite).toBeDefined()
    const promptContent = String(promptWrite![1])
    expect(promptContent).not.toContain('## Colony Knowledge')
  })

  it('injects Colony Knowledge section when KNOWLEDGE.md has entries', async () => {
    const knowledge = '# Colony Knowledge\n\n- [2026-04-05 | Developer] The test framework uses vitest\n- [2026-04-05 | QA] Always run tsc before committing\n'
    const fs = buildFsMock({
      personaFiles: ['test-persona.md'],
      personaContents: { 'test-persona.md': FULL_PERSONA_MD },
      knowledgeContent: knowledge,
    })
    setupMocks(fs)
    mod = await import('../persona-manager')
    mod.loadPersonas()

    await mod.runPersona('test-persona.md')

    const writeCalls = fs.writeFileSync.mock.calls
    const promptWrite = writeCalls.find((c: unknown[]) => String(c[0]).includes('persona-'))
    expect(promptWrite).toBeDefined()
    const promptContent = String(promptWrite![1])
    expect(promptContent).toContain('## Colony Knowledge')
    expect(promptContent).toContain('The test framework uses vitest')
    expect(promptContent).toContain('Always run tsc before committing')
  })

  it('caps knowledge injection at 60 most recent entries', async () => {
    const entries = Array.from({ length: 80 }, (_, i) =>
      `- [2026-04-05 | Persona] Entry number ${i + 1}`
    )
    const knowledge = entries.join('\n') + '\n'
    const fs = buildFsMock({
      personaFiles: ['test-persona.md'],
      personaContents: { 'test-persona.md': FULL_PERSONA_MD },
      knowledgeContent: knowledge,
    })
    setupMocks(fs)
    mod = await import('../persona-manager')
    mod.loadPersonas()

    await mod.runPersona('test-persona.md')

    const writeCalls = fs.writeFileSync.mock.calls
    const promptWrite = writeCalls.find((c: unknown[]) => String(c[0]).includes('persona-'))
    const promptContent = String(promptWrite![1])
    // Should include last 60 entries (21-80), not first 20
    expect(promptContent).toContain('Entry number 80')
    expect(promptContent).toContain('Entry number 21')
    expect(promptContent).not.toContain('Entry number 1\n')
    expect(promptContent).not.toContain('Entry number 20\n')
  })

  it('omits Colony Knowledge section when KNOWLEDGE.md has no entries (header only)', async () => {
    const knowledge = '# Colony Knowledge\n\nShared knowledge.\n\n'
    const fs = buildFsMock({
      personaFiles: ['test-persona.md'],
      personaContents: { 'test-persona.md': FULL_PERSONA_MD },
      knowledgeContent: knowledge,
    })
    setupMocks(fs)
    mod = await import('../persona-manager')
    mod.loadPersonas()

    await mod.runPersona('test-persona.md')

    const writeCalls = fs.writeFileSync.mock.calls
    const promptWrite = writeCalls.find((c: unknown[]) => String(c[0]).includes('persona-'))
    const promptContent = String(promptWrite![1])
    expect(promptContent).not.toContain('## Colony Knowledge')
  })
})

// ----------------------------------------------------------------

describe('persona-manager: onSessionExit — completion trigger dispatch', () => {
  let mod: typeof import('../persona-manager')

  // Persona that exits and has on_complete_run triggers
  const TRIGGER_PERSONA_MD = `---
name: "Trigger Persona"
schedule: "*/30 * * * *"
model: sonnet
on_complete_run: ["target-persona"]
---

## Role

Fires other personas when done.
`

  // Target persona that should be launched when Trigger Persona exits
  const TARGET_PERSONA_MD = `---
name: "Target Persona"
schedule: "*/30 * * * *"
model: sonnet
---

## Role

Gets launched by triggers.
`

  const MOCK_INSTANCE = {
    id: 'inst-target-1', name: 'Persona: Target Persona', status: 'running',
    activity: 'waiting', workingDirectory: '/mock/.claude-colony',
    color: '#a78bfa', args: [], createdAt: Date.now(), pinned: false,
    cliBackend: 'claude', gitBranch: null, gitRepo: null,
    tokenUsage: { inputTokens: 0, outputTokens: 0, cost: 0 },
    roleTag: null,
  }

  beforeEach(async () => {
    vi.resetModules()
    mockBroadcast.mockReset()
    mockCreateInstance.mockReset().mockResolvedValue(MOCK_INSTANCE)
    mockGetAllInstances.mockReset().mockResolvedValue([])
    mockUpdateColonyContext.mockReset().mockResolvedValue(undefined)
    mockSendPromptWhenReady.mockReset()
    mockGetDaemonClient.mockReset().mockReturnValue({ getInstanceBuffer: vi.fn().mockResolvedValue(null) })
    mockExecSync.mockReset()
    mockAppendActivity.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    if (mod) mod.stopScheduler()
  })

  it('launches target persona when on_complete_run matches an enabled, idle persona', async () => {
    const stateJson = JSON.stringify({
      'Trigger Persona': { lastRunAt: null, runCount: 1, activeSessionId: 'sess-trigger', enabled: true, lastRunOutput: null, sessionStartedAt: null, sessionWorkingDir: null },
      'Target Persona': { lastRunAt: null, runCount: 0, activeSessionId: null, enabled: true, lastRunOutput: null, sessionStartedAt: null, sessionWorkingDir: null },
    })
    const fs = buildFsMock({
      personaFiles: ['trigger-persona.md', 'target-persona.md'],
      personaContents: {
        'trigger-persona.md': TRIGGER_PERSONA_MD,
        'target-persona.md': TARGET_PERSONA_MD,
      },
      stateJson,
    })
    setupMocks(fs)
    mod = await import('../persona-manager')
    mod.loadPersonas()

    await mod.onSessionExit('sess-trigger')
    // Drain the microtask queue so the fire-and-forget runPersona() chain completes
    await new Promise(resolve => setImmediate(resolve))

    expect(mockCreateInstance).toHaveBeenCalledOnce()
    const callArg = mockCreateInstance.mock.calls[0][0]
    expect(callArg.name).toBe('Persona: Target Persona')
  })

  it('skips trigger when target persona ID is not found', async () => {
    const UNKNOWN_TRIGGER_MD = TRIGGER_PERSONA_MD.replace(
      'on_complete_run: ["target-persona"]',
      'on_complete_run: ["nonexistent-persona"]'
    )
    const stateJson = JSON.stringify({
      'Trigger Persona': { lastRunAt: null, runCount: 1, activeSessionId: 'sess-trigger', enabled: true, lastRunOutput: null, sessionStartedAt: null, sessionWorkingDir: null },
    })
    const fs = buildFsMock({
      personaFiles: ['trigger-persona.md'],
      personaContents: { 'trigger-persona.md': UNKNOWN_TRIGGER_MD },
      stateJson,
    })
    setupMocks(fs)
    mod = await import('../persona-manager')
    mod.loadPersonas()

    await mod.onSessionExit('sess-trigger')
    await new Promise(resolve => setImmediate(resolve))

    expect(mockCreateInstance).not.toHaveBeenCalled()
  })

  it('skips trigger when target persona is disabled', async () => {
    const stateJson = JSON.stringify({
      'Trigger Persona': { lastRunAt: null, runCount: 1, activeSessionId: 'sess-trigger', enabled: true, lastRunOutput: null, sessionStartedAt: null, sessionWorkingDir: null },
      'Target Persona': { lastRunAt: null, runCount: 0, activeSessionId: null, enabled: false, lastRunOutput: null, sessionStartedAt: null, sessionWorkingDir: null },
    })
    const fs = buildFsMock({
      personaFiles: ['trigger-persona.md', 'target-persona.md'],
      personaContents: {
        'trigger-persona.md': TRIGGER_PERSONA_MD,
        'target-persona.md': TARGET_PERSONA_MD,
      },
      stateJson,
    })
    setupMocks(fs)
    mod = await import('../persona-manager')
    mod.loadPersonas()

    await mod.onSessionExit('sess-trigger')
    await new Promise(resolve => setImmediate(resolve))

    expect(mockCreateInstance).not.toHaveBeenCalled()
  })

  it('skips trigger when target persona already has a running session', async () => {
    const stateJson = JSON.stringify({
      'Trigger Persona': { lastRunAt: null, runCount: 1, activeSessionId: 'sess-trigger', enabled: true, lastRunOutput: null, sessionStartedAt: null, sessionWorkingDir: null },
      'Target Persona': { lastRunAt: null, runCount: 1, activeSessionId: 'sess-target-already', enabled: true, lastRunOutput: null, sessionStartedAt: null, sessionWorkingDir: null },
    })
    const fs = buildFsMock({
      personaFiles: ['trigger-persona.md', 'target-persona.md'],
      personaContents: {
        'trigger-persona.md': TRIGGER_PERSONA_MD,
        'target-persona.md': TARGET_PERSONA_MD,
      },
      stateJson,
    })
    setupMocks(fs)
    mod = await import('../persona-manager')
    mod.loadPersonas()

    await mod.onSessionExit('sess-trigger')
    await new Promise(resolve => setImmediate(resolve))

    expect(mockCreateInstance).not.toHaveBeenCalled()
  })

  it('fires no triggers when on_complete_run is empty', async () => {
    const stateJson = JSON.stringify({
      'Test Persona': { lastRunAt: null, runCount: 1, activeSessionId: 'sess-abc', enabled: true, lastRunOutput: null, sessionStartedAt: null, sessionWorkingDir: null },
    })
    const fs = buildFsMock({
      personaFiles: ['test-persona.md'],
      personaContents: { 'test-persona.md': FULL_PERSONA_MD },
      stateJson,
    })
    setupMocks(fs)
    mod = await import('../persona-manager')
    mod.loadPersonas()

    await mod.onSessionExit('sess-abc')
    await new Promise(resolve => setImmediate(resolve))

    expect(mockCreateInstance).not.toHaveBeenCalled()
  })
})
