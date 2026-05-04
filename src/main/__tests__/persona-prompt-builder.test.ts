/**
 * Tests for src/main/persona-prompt-builder.ts
 *
 * Tests fmtDuration, buildKickoff, readKnowledgeBase, and buildLastRunSection
 * (via buildPlanningPrompt since buildLastRunSection is not exported).
 *
 * Strategy: vi.resetModules() + vi.doMock() + dynamic import per describe block
 * to isolate module-level state and fs interactions.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const MOCK_ROOT = '/mock/.claude-colony'
const KNOWLEDGE_PATH = `${MOCK_ROOT}/KNOWLEDGE.md`

// ---- Helpers ----

function buildFsMock(fileMap: Record<string, string> = {}) {
  const store: Record<string, string> = { ...fileMap }
  return {
    readFileSync: vi.fn().mockImplementation((p: string) => {
      if (p in store) return store[p]
      const e = Object.assign(new Error(`ENOENT: no such file or directory, open '${p}'`), { code: 'ENOENT' })
      throw e
    }),
    existsSync: vi.fn().mockImplementation((p: string) => p in store),
    store,
  }
}

function setupMocks(fsMock: ReturnType<typeof buildFsMock>, runHistory: any[] = []) {
  vi.doMock('electron', () => ({ app: { getPath: vi.fn().mockReturnValue('/mock/home') } }))
  vi.doMock('../../shared/colony-paths', () => ({
    colonyPaths: {
      root: MOCK_ROOT,
      knowledgeBase: KNOWLEDGE_PATH,
      colonyContext: `${MOCK_ROOT}/colony-context.md`,
      taskBoard: `${MOCK_ROOT}/colony-tasks.json`,
      personas: `${MOCK_ROOT}/personas`,
      coordination: `${MOCK_ROOT}/coordination`,
    },
  }))
  vi.doMock('fs', () => fsMock)
  vi.doMock('../colony-context', () => ({ updateColonyContext: vi.fn().mockResolvedValue(undefined) }))
  vi.doMock('../persona-run-history', () => ({
    getRunHistory: vi.fn().mockReturnValue(runHistory),
  }))
}

// ---- fmtDuration ----
// fmtDuration is not exported, so we test it indirectly via buildPlanningPrompt
// which calls buildLastRunSection which calls fmtDuration. We drive it through
// run history entries with known durationMs values and verify the formatted output.

describe('fmtDuration — via buildPlanningPrompt run section', () => {
  let mod: typeof import('../persona-prompt-builder')
  let fsMock: ReturnType<typeof buildFsMock>

  const baseFm = {
    name: 'Test Agent',
    can_push: false,
    can_merge: false,
    can_create_sessions: false,
    can_invoke: [] as string[],
    working_directory: '/work',
    model: 'sonnet',
  }

  const baseState = { runCount: 0 }

  async function getLastRunSection(durationMs: number, success = true): Promise<string> {
    vi.resetModules()
    fsMock = buildFsMock({})
    setupMocks(fsMock, [
      {
        personaId: 'test-agent',
        timestamp: new Date().toISOString(),
        durationMs,
        success,
        costUsd: 0.05,
        exitCode: success ? 0 : 1,
        commitCount: 0,
      },
    ])
    mod = await import('../persona-prompt-builder')
    const prompt = await mod.buildPlanningPrompt(baseFm as any, baseState as any, '/work/test-agent.md', [])
    const idx = prompt.indexOf('## Last Run')
    return prompt.slice(idx)
  }

  afterEach(() => vi.restoreAllMocks())

  it('formats sub-second duration as "0s"', async () => {
    // Math.round(499 / 1000) = 0, so 499ms → "0s"
    const section = await getLastRunSection(499)
    expect(section).toContain('Duration: 0s')
  })

  it('formats exactly 1 second as "1s"', async () => {
    const section = await getLastRunSection(1000)
    expect(section).toContain('Duration: 1s')
  })

  it('formats 45 seconds as "45s"', async () => {
    const section = await getLastRunSection(45_000)
    expect(section).toContain('Duration: 45s')
  })

  it('formats 90 seconds (1m 30s) with minutes format', async () => {
    const section = await getLastRunSection(90_000)
    expect(section).toContain('Duration: 1m 30s')
  })

  it('formats exactly 5 minutes as "5m 0s"', async () => {
    const section = await getLastRunSection(300_000)
    expect(section).toContain('Duration: 5m 0s')
  })

  it('formats 1 hour 30 minutes as "1h 30m"', async () => {
    const section = await getLastRunSection(5_400_000) // 1.5h = 5400s
    expect(section).toContain('Duration: 1h 30m')
  })

  it('formats exactly 2 hours as "2h 0m"', async () => {
    const section = await getLastRunSection(7_200_000)
    expect(section).toContain('Duration: 2h 0m')
  })
})

// ---- buildLastRunSection (via buildPlanningPrompt) ----

describe('buildLastRunSection — no history', () => {
  let mod: typeof import('../persona-prompt-builder')

  beforeEach(async () => {
    vi.resetModules()
    setupMocks(buildFsMock({}), []) // empty run history
    mod = await import('../persona-prompt-builder')
  })

  afterEach(() => vi.restoreAllMocks())

  it('shows "First run — no history" when run history is empty', async () => {
    const fm = {
      name: 'Fresh Agent',
      can_push: false,
      can_merge: false,
      can_create_sessions: false,
      can_invoke: [] as string[],
      working_directory: '/work',
      model: 'sonnet',
    }
    const prompt = await mod.buildPlanningPrompt(fm as any, { runCount: 0 } as any, '/work/fresh-agent.md', [])
    expect(prompt).toContain('First run — no history')
  })
})

describe('buildLastRunSection — with history', () => {
  let mod: typeof import('../persona-prompt-builder')

  const makeEntry = (overrides: Partial<{
    durationMs: number
    success: boolean
    exitCode: number
    costUsd: number
    commitCount: number
  }> = {}) => ({
    personaId: 'test-agent',
    timestamp: new Date().toISOString(),
    durationMs: 60_000,
    success: true,
    costUsd: 0.10,
    exitCode: 0,
    commitCount: 2,
    ...overrides,
  })

  const baseFm = {
    name: 'Test Agent',
    can_push: false,
    can_merge: false,
    can_create_sessions: false,
    can_invoke: [] as string[],
    working_directory: '/work',
    model: 'sonnet',
  }

  afterEach(() => vi.restoreAllMocks())

  it('shows exit code 0 labeled as "success"', async () => {
    vi.resetModules()
    setupMocks(buildFsMock({}), [makeEntry({ exitCode: 0, success: true })])
    mod = await import('../persona-prompt-builder')
    const prompt = await mod.buildPlanningPrompt(baseFm as any, { runCount: 3 } as any, '/work/test-agent.md', [])
    expect(prompt).toContain('Exit code: 0 (success)')
  })

  it('shows exit code 129 labeled as "killed"', async () => {
    vi.resetModules()
    setupMocks(buildFsMock({}), [makeEntry({ exitCode: 129, success: false })])
    mod = await import('../persona-prompt-builder')
    const prompt = await mod.buildPlanningPrompt(baseFm as any, { runCount: 1 } as any, '/work/test-agent.md', [])
    expect(prompt).toContain('Exit code: 129 (killed)')
  })

  it('shows non-zero non-129 exit code labeled as "error"', async () => {
    vi.resetModules()
    setupMocks(buildFsMock({}), [makeEntry({ exitCode: 1, success: false })])
    mod = await import('../persona-prompt-builder')
    const prompt = await mod.buildPlanningPrompt(baseFm as any, { runCount: 1 } as any, '/work/test-agent.md', [])
    expect(prompt).toContain('Exit code: 1 (error)')
  })

  it('shows cost formatted to 2 decimal places', async () => {
    vi.resetModules()
    setupMocks(buildFsMock({}), [makeEntry({ costUsd: 0.1234 })])
    mod = await import('../persona-prompt-builder')
    const prompt = await mod.buildPlanningPrompt(baseFm as any, { runCount: 1 } as any, '/work/test-agent.md', [])
    expect(prompt).toContain('Cost: $0.12')
  })

  it('shows commit count', async () => {
    vi.resetModules()
    setupMocks(buildFsMock({}), [makeEntry({ commitCount: 7 })])
    mod = await import('../persona-prompt-builder')
    const prompt = await mod.buildPlanningPrompt(baseFm as any, { runCount: 1 } as any, '/work/test-agent.md', [])
    expect(prompt).toContain('Commits: 7')
  })

  it('includes fail note when last run was not successful', async () => {
    vi.resetModules()
    setupMocks(buildFsMock({}), [makeEntry({ success: false, exitCode: 1 })])
    mod = await import('../persona-prompt-builder')
    const prompt = await mod.buildPlanningPrompt(baseFm as any, { runCount: 1 } as any, '/work/test-agent.md', [])
    expect(prompt).toContain('Your last session FAILED')
  })

  it('does not include fail note when last run was successful', async () => {
    vi.resetModules()
    setupMocks(buildFsMock({}), [makeEntry({ success: true, exitCode: 0 })])
    mod = await import('../persona-prompt-builder')
    const prompt = await mod.buildPlanningPrompt(baseFm as any, { runCount: 1 } as any, '/work/test-agent.md', [])
    expect(prompt).not.toContain('Your last session FAILED')
  })

  it('computes 100% success rate when all runs succeeded', async () => {
    vi.resetModules()
    const runs = [makeEntry({ success: true }), makeEntry({ success: true }), makeEntry({ success: true })]
    setupMocks(buildFsMock({}), runs)
    mod = await import('../persona-prompt-builder')
    const prompt = await mod.buildPlanningPrompt(baseFm as any, { runCount: 3 } as any, '/work/test-agent.md', [])
    expect(prompt).toContain('100% success rate')
  })

  it('computes correct success rate with mixed results', async () => {
    vi.resetModules()
    const runs = [makeEntry({ success: true }), makeEntry({ success: false }), makeEntry({ success: true }), makeEntry({ success: false })]
    setupMocks(buildFsMock({}), runs)
    mod = await import('../persona-prompt-builder')
    const prompt = await mod.buildPlanningPrompt(baseFm as any, { runCount: 4 } as any, '/work/test-agent.md', [])
    expect(prompt).toContain('50% success rate')
  })

  it('counts consecutive failures from the front of history', async () => {
    vi.resetModules()
    // History is newest-first: 2 failures then a success
    const runs = [makeEntry({ success: false }), makeEntry({ success: false }), makeEntry({ success: true })]
    setupMocks(buildFsMock({}), runs)
    mod = await import('../persona-prompt-builder')
    const prompt = await mod.buildPlanningPrompt(baseFm as any, { runCount: 3 } as any, '/work/test-agent.md', [])
    expect(prompt).toContain('2 consecutive failures')
  })

  it('uses singular "failure" when count is 1', async () => {
    vi.resetModules()
    const runs = [makeEntry({ success: false }), makeEntry({ success: true })]
    setupMocks(buildFsMock({}), runs)
    mod = await import('../persona-prompt-builder')
    const prompt = await mod.buildPlanningPrompt(baseFm as any, { runCount: 2 } as any, '/work/test-agent.md', [])
    expect(prompt).toContain('1 consecutive failure')
    expect(prompt).not.toContain('1 consecutive failures')
  })
})

// ---- readKnowledgeBase ----

describe('readKnowledgeBase', () => {
  let mod: typeof import('../persona-prompt-builder')

  afterEach(() => vi.restoreAllMocks())

  it('returns empty string when KNOWLEDGE.md does not exist', async () => {
    vi.resetModules()
    setupMocks(buildFsMock({}))
    mod = await import('../persona-prompt-builder')
    expect(mod.readKnowledgeBase()).toBe('')
  })

  it('returns only lines starting with "- [" from the knowledge base', async () => {
    vi.resetModules()
    const content = [
      '# Colony Knowledge',
      '',
      '- [2026-01-01] Learned about pipelines',
      '- [2026-01-02] Improved PR reviews',
      'Some random prose that should be excluded',
      '  - [2026-01-03] Indented entry is also included',
    ].join('\n')
    setupMocks(buildFsMock({ [KNOWLEDGE_PATH]: content }))
    mod = await import('../persona-prompt-builder')
    const result = mod.readKnowledgeBase()
    expect(result).toContain('- [2026-01-01] Learned about pipelines')
    expect(result).toContain('- [2026-01-02] Improved PR reviews')
    expect(result).not.toContain('# Colony Knowledge')
    expect(result).not.toContain('Some random prose')
  })

  it('caps result at most recent 60 entries', async () => {
    vi.resetModules()
    const lines = Array.from({ length: 80 }, (_, i) => `- [entry-${i}] Knowledge item ${i}`)
    setupMocks(buildFsMock({ [KNOWLEDGE_PATH]: lines.join('\n') }))
    mod = await import('../persona-prompt-builder')
    const result = mod.readKnowledgeBase()
    const resultLines = result.split('\n').filter(Boolean)
    expect(resultLines).toHaveLength(60)
    // Should contain the most recent 60 (last 60 of 80, i.e. indices 20–79)
    expect(result).toContain('entry-79')
    expect(result).not.toContain('entry-19')
  })

  it('returns empty string when KNOWLEDGE.md has no "- [" lines', async () => {
    vi.resetModules()
    setupMocks(buildFsMock({ [KNOWLEDGE_PATH]: '# Header\nSome content\nAnother line\n' }))
    mod = await import('../persona-prompt-builder')
    expect(mod.readKnowledgeBase()).toBe('')
  })

  it('returns empty string on read error', async () => {
    vi.resetModules()
    const fsMock = buildFsMock({})
    // existsSync says file exists but readFileSync throws
    fsMock.existsSync = vi.fn().mockReturnValue(true)
    fsMock.readFileSync = vi.fn().mockImplementation(() => { throw new Error('Permission denied') })
    setupMocks(fsMock)
    mod = await import('../persona-prompt-builder')
    expect(mod.readKnowledgeBase()).toBe('')
  })
})

// ---- buildKickoff ----

describe('buildKickoff', () => {
  let mod: typeof import('../persona-prompt-builder')

  beforeEach(async () => {
    vi.resetModules()
    setupMocks(buildFsMock({}))
    mod = await import('../persona-prompt-builder')
  })

  afterEach(() => vi.restoreAllMocks())

  it('returns custom message with identity file reference when customMessage is provided', () => {
    const result = mod.buildKickoff('/work/agent.md', { type: 'manual' }, 'Please focus on auth.')
    expect(result).toContain('Please focus on auth.')
    expect(result).toContain('/work/agent.md')
  })

  it('manual trigger produces "manually triggered" message', () => {
    const result = mod.buildKickoff('/work/agent.md', { type: 'manual' })
    expect(result).toContain("manually triggered")
    expect(result).toContain('/work/agent.md')
  })

  it('cron trigger includes the schedule in the message', () => {
    const result = mod.buildKickoff('/work/agent.md', { type: 'cron', schedule: '0 9 * * 1-5' })
    expect(result).toContain('0 9 * * 1-5')
    expect(result).toContain('/work/agent.md')
  })

  it('handoff trigger names the triggering persona', () => {
    const result = mod.buildKickoff('/work/agent.md', { type: 'handoff', from: 'colony-architect' })
    expect(result).toContain('colony-architect')
    expect(result).toContain('/work/agent.md')
  })

  it('handoff trigger with chainId includes coordination file path', () => {
    const result = mod.buildKickoff('/work/agent.md', { type: 'handoff', from: 'colony-architect', chainId: 'chain-abc' })
    expect(result).toContain('chain-abc')
    expect(result).toContain('Coordination file')
  })

  it('handoff trigger without chainId does not mention coordination file', () => {
    const result = mod.buildKickoff('/work/agent.md', { type: 'handoff', from: 'colony-architect' })
    expect(result).not.toContain('Coordination file')
  })

  it('customMessage overrides trigger-specific content', () => {
    const result = mod.buildKickoff('/work/agent.md', { type: 'cron', schedule: '0 9 * * 1-5' }, 'Override msg')
    expect(result).toContain('Override msg')
    expect(result).not.toContain('scheduled run')
  })
})
