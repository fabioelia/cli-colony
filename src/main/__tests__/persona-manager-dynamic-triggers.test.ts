/**
 * Tests for dynamic persona completion triggers in persona-manager.ts
 *
 * Covers the trigger override file mechanism: reading, parsing, custom messages,
 * fallback to on_complete_run, malformed JSON handling, and cleanup after read.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const MOCK_ROOT = '/mock/.claude-colony'
const PERSONAS_DIR = `${MOCK_ROOT}/personas`
const STATE_PATH = `${MOCK_ROOT}/persona-state.json`
const SCHEDULER_LOG = `${MOCK_ROOT}/scheduler.log`
const KNOWLEDGE_PATH = `${MOCK_ROOT}/KNOWLEDGE.md`

// ---- YAML fixtures ----

const TRIGGER_PERSONA_MD = `---
name: "Trigger Persona"
schedule: "*/30 * * * *"
model: sonnet
on_complete_run: ["default-target"]
---

## Role

Fires other personas when done.
`

const TARGET_PERSONA_MD = `---
name: "Target Persona"
schedule: ""
model: sonnet
---

## Role

Gets launched by triggers.
`

const DEFAULT_TARGET_MD = `---
name: "Default Target"
schedule: ""
model: sonnet
---

## Role

Default target from on_complete_run.
`

// ---- Shared mock instances ----

const mockGetAllInstances = vi.hoisted(() => vi.fn())
const mockCreateInstance = vi.hoisted(() => vi.fn())
const mockKillInstance = vi.hoisted(() => vi.fn())
const mockGetDaemonClient = vi.hoisted(() => vi.fn())
const mockSendPromptWhenReady = vi.hoisted(() => vi.fn())
const mockUpdateColonyContext = vi.hoisted(() => vi.fn())
const mockBroadcast = vi.hoisted(() => vi.fn())
const mockCronMatches = vi.hoisted(() => vi.fn())
const mockExecFile = vi.hoisted(() => vi.fn().mockImplementation(
  (_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, result: { stdout: string; stderr: string }) => void) => {
    cb(null, { stdout: '', stderr: '' })
  }
))
const mockSpawn = vi.hoisted(() => vi.fn())
const mockAppendActivity = vi.hoisted(() => vi.fn())

const MOCK_INSTANCE = {
  id: 'inst-target-1', name: 'Persona: Target Persona', status: 'running',
  activity: 'waiting', workingDirectory: '/mock/.claude-colony',
  color: '#a78bfa', args: [], createdAt: Date.now(), pinned: false,
  cliBackend: 'claude', gitBranch: null, gitRepo: null,
  tokenUsage: { inputTokens: 0, outputTokens: 0, cost: 0 },
  roleTag: null,
}

// ---- fs mock builder ----

function buildFsMock(options: {
  personaFiles?: string[]
  personaContents?: Record<string, string>
  stateJson?: string
  workingDirs?: string[]
  triggerFiles?: Record<string, string>   // filename → JSON content (e.g. "trigger-persona.triggers.json")
} = {}) {
  const { personaFiles = [], personaContents = {}, stateJson, workingDirs = [], triggerFiles = {} } = options
  const deletedFiles = new Set<string>()

  return {
    existsSync: vi.fn().mockImplementation((p: string) => {
      if (deletedFiles.has(p)) return false
      if (p === PERSONAS_DIR) return true
      if (p === STATE_PATH) return stateJson !== undefined
      if (workingDirs.includes(p)) return true
      for (const filename of Object.keys(personaContents)) {
        if (p === `${PERSONAS_DIR}/${filename}`) return true
      }
      for (const filename of Object.keys(triggerFiles)) {
        if (p === `${PERSONAS_DIR}/${filename}`) return true
      }
      return false
    }),
    readFileSync: vi.fn().mockImplementation((p: string, _enc?: string) => {
      if (p === STATE_PATH) return stateJson ?? '{}'
      if (p === KNOWLEDGE_PATH) return ''
      for (const [filename, content] of Object.entries(triggerFiles)) {
        if (p === `${PERSONAS_DIR}/${filename}`) return content
      }
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
    unlinkSync: vi.fn().mockImplementation((p: string) => {
      deletedFiles.add(p)
    }),
    watch: vi.fn().mockReturnValue({ close: vi.fn() }),
    _deletedFiles: deletedFiles,
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
    wasBudgetStopped: vi.fn().mockReturnValue(false),
    setCostCapResolver: vi.fn(),
  }))
  vi.doMock('../daemon-client', () => ({ getDaemonClient: mockGetDaemonClient }))
  vi.doMock('../send-prompt-when-ready', () => ({ sendPromptWhenReady: mockSendPromptWhenReady }))
  vi.doMock('../colony-context', () => ({ updateColonyContext: mockUpdateColonyContext }))
  vi.doMock('../../shared/cron', () => ({ cronMatches: mockCronMatches }))
  vi.doMock('child_process', () => ({ execFile: mockExecFile, spawn: mockSpawn }))
  vi.doMock('../activity-manager', () => ({ appendActivity: mockAppendActivity }))
  vi.doMock('../notifications', () => ({ notify: vi.fn() }))
}

// ---- Test suites ----

describe('persona-manager: dynamic trigger override', () => {
  let mod: typeof import('../persona-manager')

  beforeEach(async () => {
    vi.resetModules()
    mockBroadcast.mockReset()
    mockCreateInstance.mockReset().mockResolvedValue(MOCK_INSTANCE)
    mockGetAllInstances.mockReset().mockResolvedValue([])
    mockUpdateColonyContext.mockReset().mockResolvedValue(undefined)
    mockSendPromptWhenReady.mockReset()
    mockGetDaemonClient.mockReset().mockReturnValue({ getInstanceBuffer: vi.fn().mockResolvedValue(null) })
    mockExecFile.mockReset().mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, result: { stdout: string; stderr: string }) => void) => {
        cb(null, { stdout: '', stderr: '' })
      }
    )
    mockAppendActivity.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('uses trigger file entries instead of on_complete_run when file is present', async () => {
    const triggerFileContent = JSON.stringify({
      triggers: [{ persona: 'target-persona' }],
    })
    const stateJson = JSON.stringify({
      'Trigger Persona': { lastRunAt: null, runCount: 1, activeSessionId: 'sess-trigger', enabled: true, lastRunOutput: null, sessionStartedAt: null, sessionWorkingDir: null, triggeredBy: null },
      'Target Persona': { lastRunAt: null, runCount: 0, activeSessionId: null, enabled: true, lastRunOutput: null, sessionStartedAt: null, sessionWorkingDir: null, triggeredBy: null },
      'Default Target': { lastRunAt: null, runCount: 0, activeSessionId: null, enabled: true, lastRunOutput: null, sessionStartedAt: null, sessionWorkingDir: null, triggeredBy: null },
    })
    const fs = buildFsMock({
      personaFiles: ['trigger-persona.md', 'target-persona.md', 'default-target.md'],
      personaContents: {
        'trigger-persona.md': TRIGGER_PERSONA_MD,
        'target-persona.md': TARGET_PERSONA_MD,
        'default-target.md': DEFAULT_TARGET_MD,
      },
      stateJson,
      triggerFiles: { 'trigger-persona.triggers.json': triggerFileContent },
    })
    setupMocks(fs)
    mod = await import('../persona-manager')
    mod.loadPersonas()

    await mod.onSessionExit('sess-trigger')
    await new Promise(resolve => setImmediate(resolve))

    // Should launch target-persona (from override), NOT default-target (from on_complete_run)
    expect(mockCreateInstance).toHaveBeenCalledOnce()
    const callArg = mockCreateInstance.mock.calls[0][0]
    expect(callArg.name).toBe('Persona: Target Persona')
  })

  it('suppresses all triggers when trigger file has empty array', async () => {
    const triggerFileContent = JSON.stringify({ triggers: [] })
    const stateJson = JSON.stringify({
      'Trigger Persona': { lastRunAt: null, runCount: 1, activeSessionId: 'sess-trigger', enabled: true, lastRunOutput: null, sessionStartedAt: null, sessionWorkingDir: null, triggeredBy: null },
      'Default Target': { lastRunAt: null, runCount: 0, activeSessionId: null, enabled: true, lastRunOutput: null, sessionStartedAt: null, sessionWorkingDir: null, triggeredBy: null },
    })
    const fs = buildFsMock({
      personaFiles: ['trigger-persona.md', 'default-target.md'],
      personaContents: {
        'trigger-persona.md': TRIGGER_PERSONA_MD,
        'default-target.md': DEFAULT_TARGET_MD,
      },
      stateJson,
      triggerFiles: { 'trigger-persona.triggers.json': triggerFileContent },
    })
    setupMocks(fs)
    mod = await import('../persona-manager')
    mod.loadPersonas()

    await mod.onSessionExit('sess-trigger')
    await new Promise(resolve => setImmediate(resolve))

    // Should NOT launch anything — empty triggers array suppresses all
    expect(mockCreateInstance).not.toHaveBeenCalled()
  })

  it('passes custom message through to buildKickoff when trigger file includes message', async () => {
    const customMsg = 'Colony Research found a ready implementation plan. Read the spec and implement it.'
    const triggerFileContent = JSON.stringify({
      triggers: [{ persona: 'target-persona', message: customMsg }],
    })
    const stateJson = JSON.stringify({
      'Trigger Persona': { lastRunAt: null, runCount: 1, activeSessionId: 'sess-trigger', enabled: true, lastRunOutput: null, sessionStartedAt: null, sessionWorkingDir: null, triggeredBy: null },
      'Target Persona': { lastRunAt: null, runCount: 0, activeSessionId: null, enabled: true, lastRunOutput: null, sessionStartedAt: null, sessionWorkingDir: null, triggeredBy: null },
    })
    const fs = buildFsMock({
      personaFiles: ['trigger-persona.md', 'target-persona.md'],
      personaContents: {
        'trigger-persona.md': TRIGGER_PERSONA_MD,
        'target-persona.md': TARGET_PERSONA_MD,
      },
      stateJson,
      triggerFiles: { 'trigger-persona.triggers.json': triggerFileContent },
    })
    setupMocks(fs)
    mod = await import('../persona-manager')
    mod.loadPersonas()

    await mod.onSessionExit('sess-trigger')
    await new Promise(resolve => setImmediate(resolve))

    expect(mockCreateInstance).toHaveBeenCalledOnce()
    // Verify the kickoff message sent via sendPromptWhenReady contains the custom message
    expect(mockSendPromptWhenReady).toHaveBeenCalledOnce()
    const sentPrompt = mockSendPromptWhenReady.mock.calls[0][1]
    expect(sentPrompt.prompt).toContain(customMsg)
    // It should NOT contain the generic handoff text since customMessage takes priority
    expect(sentPrompt.prompt).not.toContain('You\'ve been triggered by')
    // It should still contain the base instruction
    expect(sentPrompt.prompt).toContain('Read your identity file at')
  })

  it('falls back to on_complete_run when trigger file is absent', async () => {
    const stateJson = JSON.stringify({
      'Trigger Persona': { lastRunAt: null, runCount: 1, activeSessionId: 'sess-trigger', enabled: true, lastRunOutput: null, sessionStartedAt: null, sessionWorkingDir: null, triggeredBy: null },
      'Default Target': { lastRunAt: null, runCount: 0, activeSessionId: null, enabled: true, lastRunOutput: null, sessionStartedAt: null, sessionWorkingDir: null, triggeredBy: null },
    })
    const fs = buildFsMock({
      personaFiles: ['trigger-persona.md', 'default-target.md'],
      personaContents: {
        'trigger-persona.md': TRIGGER_PERSONA_MD,
        'default-target.md': DEFAULT_TARGET_MD,
      },
      stateJson,
      // No triggerFiles — file absent
    })
    setupMocks(fs)
    mod = await import('../persona-manager')
    mod.loadPersonas()

    await mod.onSessionExit('sess-trigger')
    await new Promise(resolve => setImmediate(resolve))

    // Should use on_complete_run and launch default-target
    expect(mockCreateInstance).toHaveBeenCalledOnce()
    const callArg = mockCreateInstance.mock.calls[0][0]
    expect(callArg.name).toBe('Persona: Default Target')
  })

  it('falls back to on_complete_run when trigger file has malformed JSON', async () => {
    const stateJson = JSON.stringify({
      'Trigger Persona': { lastRunAt: null, runCount: 1, activeSessionId: 'sess-trigger', enabled: true, lastRunOutput: null, sessionStartedAt: null, sessionWorkingDir: null, triggeredBy: null },
      'Default Target': { lastRunAt: null, runCount: 0, activeSessionId: null, enabled: true, lastRunOutput: null, sessionStartedAt: null, sessionWorkingDir: null, triggeredBy: null },
    })
    const fs = buildFsMock({
      personaFiles: ['trigger-persona.md', 'default-target.md'],
      personaContents: {
        'trigger-persona.md': TRIGGER_PERSONA_MD,
        'default-target.md': DEFAULT_TARGET_MD,
      },
      stateJson,
      triggerFiles: { 'trigger-persona.triggers.json': '{this is not valid json!!!' },
    })
    setupMocks(fs)
    mod = await import('../persona-manager')
    mod.loadPersonas()

    await mod.onSessionExit('sess-trigger')
    await new Promise(resolve => setImmediate(resolve))

    // Malformed JSON should fall through to on_complete_run, NOT crash
    expect(mockCreateInstance).toHaveBeenCalledOnce()
    const callArg = mockCreateInstance.mock.calls[0][0]
    expect(callArg.name).toBe('Persona: Default Target')
  })

  it('deletes trigger file after reading it', async () => {
    const triggerFileContent = JSON.stringify({
      triggers: [{ persona: 'target-persona' }],
    })
    const stateJson = JSON.stringify({
      'Trigger Persona': { lastRunAt: null, runCount: 1, activeSessionId: 'sess-trigger', enabled: true, lastRunOutput: null, sessionStartedAt: null, sessionWorkingDir: null, triggeredBy: null },
      'Target Persona': { lastRunAt: null, runCount: 0, activeSessionId: null, enabled: true, lastRunOutput: null, sessionStartedAt: null, sessionWorkingDir: null, triggeredBy: null },
    })
    const fs = buildFsMock({
      personaFiles: ['trigger-persona.md', 'target-persona.md'],
      personaContents: {
        'trigger-persona.md': TRIGGER_PERSONA_MD,
        'target-persona.md': TARGET_PERSONA_MD,
      },
      stateJson,
      triggerFiles: { 'trigger-persona.triggers.json': triggerFileContent },
    })
    setupMocks(fs)
    mod = await import('../persona-manager')
    mod.loadPersonas()

    await mod.onSessionExit('sess-trigger')

    // unlinkSync should have been called on the trigger file
    expect(fs.unlinkSync).toHaveBeenCalledWith(`${PERSONAS_DIR}/trigger-persona.triggers.json`)

    // After deletion, existsSync should return false for the trigger file
    expect(fs.existsSync(`${PERSONAS_DIR}/trigger-persona.triggers.json`)).toBe(false)
  })
})
