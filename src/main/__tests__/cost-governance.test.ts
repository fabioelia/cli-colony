import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock electron (required by colony-paths transitive import)
vi.mock('electron', () => ({
  app: { getPath: vi.fn().mockReturnValue('/mock/home') },
}))

// Mock colony-paths to control file paths
vi.mock('../../shared/colony-paths', () => ({
  colonyPaths: {
    costQuotasJson: '/mock/governance/cost-quotas.json',
    costAuditLog: '/mock/governance/cost-audit.jsonl',
  },
}))

// Mock fs
const mockFs = vi.hoisted(() => ({
  existsSync: vi.fn(),
  statSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  appendFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}))
vi.mock('fs', () => mockFs)

// We need fresh module state for each test (module-level cache)
let mod: typeof import('../cost-governance')

beforeEach(async () => {
  vi.resetModules()
  vi.resetAllMocks()

  // Re-mock after resetModules
  vi.doMock('electron', () => ({
    app: { getPath: vi.fn().mockReturnValue('/mock/home') },
  }))
  vi.doMock('../../shared/colony-paths', () => ({
    colonyPaths: {
      costQuotasJson: '/mock/governance/cost-quotas.json',
      costAuditLog: '/mock/governance/cost-audit.jsonl',
    },
  }))
  vi.doMock('fs', () => mockFs)

  mod = await import('../cost-governance')
})

// --- Helpers ---

function makeQuotas(quotas: Array<{ teamId: string; projectId: string; agentId?: string; hardLimitUsd: number; warnThresholdUsd: number }>) {
  return {
    quotas,
    metadata: { lastUpdated: '2026-01-01T00:00:00Z', version: '1.0' },
  }
}

function makeAuditEntry(overrides: Partial<{
  timestamp: string
  teamId: string
  projectId: string
  agentId: string
  sessionId: string
  costUsd: number
  status: string
  reason: string
}> = {}) {
  return {
    timestamp: overrides.timestamp ?? '2026-04-01T12:00:00Z',
    teamId: overrides.teamId ?? 'team-a',
    projectId: overrides.projectId ?? 'proj-1',
    agentId: overrides.agentId,
    sessionId: overrides.sessionId ?? 'sess-001',
    costUsd: overrides.costUsd ?? 0.50,
    status: overrides.status ?? 'OK',
    reason: overrides.reason,
  }
}

function setupAuditLogFile(entries: ReturnType<typeof makeAuditEntry>[]) {
  const content = entries.map(e => JSON.stringify(e)).join('\n') + '\n'
  mockFs.existsSync.mockImplementation((p: string) =>
    p === '/mock/governance/cost-audit.jsonl' ? true : false
  )
  mockFs.readFileSync.mockReturnValue(content)
}

// ===================== loadQuotas =====================

describe('loadQuotas', () => {
  it('returns default quotas when file does not exist', () => {
    mockFs.existsSync.mockReturnValue(false)

    const result = mod.loadQuotas()

    expect(result.quotas).toHaveLength(1)
    expect(result.quotas[0]).toMatchObject({
      teamId: 'default',
      projectId: 'ungoverned',
      hardLimitUsd: 1000,
      warnThresholdUsd: 800,
    })
    expect(result.metadata.version).toBe('1.0')
  })

  it('reads quotas from disk on first call', () => {
    const quotas = makeQuotas([
      { teamId: 'acme', projectId: 'widget', hardLimitUsd: 500, warnThresholdUsd: 400 },
    ])
    mockFs.existsSync.mockReturnValue(true)
    mockFs.statSync.mockReturnValue({ mtimeMs: 100 })
    mockFs.readFileSync.mockReturnValue(JSON.stringify(quotas))

    const result = mod.loadQuotas()

    expect(result.quotas[0].teamId).toBe('acme')
    expect(mockFs.readFileSync).toHaveBeenCalledWith('/mock/governance/cost-quotas.json', 'utf-8')
  })

  it('returns cached quotas when mtime has not changed', () => {
    const quotas = makeQuotas([
      { teamId: 'acme', projectId: 'widget', hardLimitUsd: 500, warnThresholdUsd: 400 },
    ])
    mockFs.existsSync.mockReturnValue(true)
    mockFs.statSync.mockReturnValue({ mtimeMs: 100 })
    mockFs.readFileSync.mockReturnValue(JSON.stringify(quotas))

    mod.loadQuotas() // populates cache
    mockFs.readFileSync.mockClear()

    const result = mod.loadQuotas() // should use cache
    expect(mockFs.readFileSync).not.toHaveBeenCalled()
    expect(result.quotas[0].teamId).toBe('acme')
  })

  it('re-reads from disk when mtime changes', () => {
    const quotas1 = makeQuotas([
      { teamId: 'acme', projectId: 'v1', hardLimitUsd: 100, warnThresholdUsd: 80 },
    ])
    const quotas2 = makeQuotas([
      { teamId: 'acme', projectId: 'v2', hardLimitUsd: 200, warnThresholdUsd: 160 },
    ])

    mockFs.existsSync.mockReturnValue(true)
    mockFs.statSync.mockReturnValue({ mtimeMs: 100 })
    mockFs.readFileSync.mockReturnValue(JSON.stringify(quotas1))
    mod.loadQuotas()

    // File updated — new mtime
    mockFs.statSync.mockReturnValue({ mtimeMs: 200 })
    mockFs.readFileSync.mockReturnValue(JSON.stringify(quotas2))

    const result = mod.loadQuotas()
    expect(result.quotas[0].projectId).toBe('v2')
  })

  it('returns defaults on parse error', () => {
    mockFs.existsSync.mockReturnValue(true)
    mockFs.statSync.mockReturnValue({ mtimeMs: 100 })
    mockFs.readFileSync.mockReturnValue('{ broken json')

    const result = mod.loadQuotas()
    expect(result.quotas[0].teamId).toBe('default')
  })
})

// ===================== saveQuotas =====================

describe('saveQuotas', () => {
  it('writes quotas to disk as formatted JSON', () => {
    mockFs.existsSync.mockReturnValue(true)
    mockFs.statSync.mockReturnValue({ mtimeMs: 300 })

    const quotas = makeQuotas([
      { teamId: 'acme', projectId: 'proj', hardLimitUsd: 100, warnThresholdUsd: 80 },
    ])

    mod.saveQuotas(quotas)

    expect(mockFs.writeFileSync).toHaveBeenCalledWith(
      '/mock/governance/cost-quotas.json',
      expect.stringContaining('"acme"')
    )
    // Verify it's formatted (2-space indent)
    const written = mockFs.writeFileSync.mock.calls[0][1] as string
    expect(written).toContain('\n  ')
  })

  it('creates directory if it does not exist', () => {
    mockFs.existsSync.mockReturnValue(false)
    mockFs.statSync.mockReturnValue({ mtimeMs: 300 })

    mod.saveQuotas(makeQuotas([]))

    expect(mockFs.mkdirSync).toHaveBeenCalledWith('/mock/governance', { recursive: true })
  })

  it('sets lastUpdated timestamp on save', () => {
    mockFs.existsSync.mockReturnValue(true)
    mockFs.statSync.mockReturnValue({ mtimeMs: 300 })

    const quotas = makeQuotas([])
    quotas.metadata.lastUpdated = 'old-value'

    mod.saveQuotas(quotas)

    const written = JSON.parse(mockFs.writeFileSync.mock.calls[0][1] as string)
    expect(written.metadata.lastUpdated).not.toBe('old-value')
    // Should be a valid ISO date
    expect(new Date(written.metadata.lastUpdated).getTime()).toBeGreaterThan(0)
  })

  it('updates cache after saving', () => {
    mockFs.existsSync.mockReturnValue(true)
    mockFs.statSync.mockReturnValue({ mtimeMs: 400 })

    const quotas = makeQuotas([
      { teamId: 'cached', projectId: 'proj', hardLimitUsd: 100, warnThresholdUsd: 80 },
    ])
    mod.saveQuotas(quotas)

    // loadQuotas should return cache (same mtime)
    mockFs.readFileSync.mockClear()
    const loaded = mod.loadQuotas()
    expect(mockFs.readFileSync).not.toHaveBeenCalled()
    expect(loaded.quotas[0].teamId).toBe('cached')
  })

  it('throws on write failure', () => {
    mockFs.existsSync.mockReturnValue(true)
    mockFs.writeFileSync.mockImplementation(() => {
      throw new Error('disk full')
    })

    expect(() => mod.saveQuotas(makeQuotas([]))).toThrow('disk full')
  })
})

// ===================== ensureQuotasExist =====================

describe('ensureQuotasExist', () => {
  it('creates default quotas file when missing', () => {
    mockFs.existsSync.mockReturnValue(false)
    mockFs.statSync.mockReturnValue({ mtimeMs: 500 })

    mod.ensureQuotasExist()

    expect(mockFs.mkdirSync).toHaveBeenCalled()
    expect(mockFs.writeFileSync).toHaveBeenCalled()
    const written = JSON.parse(mockFs.writeFileSync.mock.calls[0][1] as string)
    expect(written.quotas[0].teamId).toBe('default')
  })

  it('does nothing when file already exists', () => {
    mockFs.existsSync.mockReturnValue(true)

    mod.ensureQuotasExist()

    expect(mockFs.writeFileSync).not.toHaveBeenCalled()
  })
})

// ===================== auditLog =====================

describe('auditLog', () => {
  it('appends JSONL entry to audit log', () => {
    mockFs.existsSync.mockReturnValue(true)

    const entry = makeAuditEntry({ costUsd: 1.23 })
    mod.auditLog(entry as any)

    expect(mockFs.appendFileSync).toHaveBeenCalledWith(
      '/mock/governance/cost-audit.jsonl',
      expect.stringContaining('"costUsd":1.23')
    )
    // Should end with newline
    const written = mockFs.appendFileSync.mock.calls[0][1] as string
    expect(written.endsWith('\n')).toBe(true)
  })

  it('creates directory if missing', () => {
    mockFs.existsSync.mockReturnValue(false)

    mod.auditLog(makeAuditEntry() as any)

    expect(mockFs.mkdirSync).toHaveBeenCalledWith('/mock/governance', { recursive: true })
  })

  it('does not throw on write failure', () => {
    mockFs.existsSync.mockReturnValue(true)
    mockFs.appendFileSync.mockImplementation(() => {
      throw new Error('disk full')
    })

    // Should not throw — just log to console
    expect(() => mod.auditLog(makeAuditEntry() as any)).not.toThrow()
  })
})

// ===================== readAuditLog =====================

describe('readAuditLog', () => {
  it('returns empty array when file does not exist', () => {
    mockFs.existsSync.mockReturnValue(false)

    const result = mod.readAuditLog()
    expect(result).toEqual([])
  })

  it('reads and parses JSONL entries', () => {
    const entries = [
      makeAuditEntry({ costUsd: 1.0 }),
      makeAuditEntry({ costUsd: 2.0 }),
    ]
    setupAuditLogFile(entries)

    const result = mod.readAuditLog()
    expect(result).toHaveLength(2)
  })

  it('sorts entries newest-first by default', () => {
    const entries = [
      makeAuditEntry({ timestamp: '2026-01-01T00:00:00Z', costUsd: 1.0 }),
      makeAuditEntry({ timestamp: '2026-06-01T00:00:00Z', costUsd: 2.0 }),
      makeAuditEntry({ timestamp: '2026-03-01T00:00:00Z', costUsd: 3.0 }),
    ]
    setupAuditLogFile(entries)

    const result = mod.readAuditLog()
    expect(result[0].costUsd).toBe(2.0) // June — newest
    expect(result[1].costUsd).toBe(3.0) // March
    expect(result[2].costUsd).toBe(1.0) // January — oldest
  })

  it('filters by startDate', () => {
    const entries = [
      makeAuditEntry({ timestamp: '2026-01-01T00:00:00Z' }),
      makeAuditEntry({ timestamp: '2026-06-01T00:00:00Z' }),
    ]
    setupAuditLogFile(entries)

    const result = mod.readAuditLog({ startDate: new Date('2026-03-01') })
    expect(result).toHaveLength(1)
    expect(result[0].timestamp).toBe('2026-06-01T00:00:00Z')
  })

  it('filters by endDate', () => {
    const entries = [
      makeAuditEntry({ timestamp: '2026-01-01T00:00:00Z' }),
      makeAuditEntry({ timestamp: '2026-06-01T00:00:00Z' }),
    ]
    setupAuditLogFile(entries)

    const result = mod.readAuditLog({ endDate: new Date('2026-03-01') })
    expect(result).toHaveLength(1)
    expect(result[0].timestamp).toBe('2026-01-01T00:00:00Z')
  })

  it('filters by teamId', () => {
    const entries = [
      makeAuditEntry({ teamId: 'team-a' }),
      makeAuditEntry({ teamId: 'team-b' }),
      makeAuditEntry({ teamId: 'team-a' }),
    ]
    setupAuditLogFile(entries)

    const result = mod.readAuditLog({ teamId: 'team-b' })
    expect(result).toHaveLength(1)
    expect(result[0].teamId).toBe('team-b')
  })

  it('filters by projectId', () => {
    const entries = [
      makeAuditEntry({ projectId: 'alpha' }),
      makeAuditEntry({ projectId: 'beta' }),
    ]
    setupAuditLogFile(entries)

    const result = mod.readAuditLog({ projectId: 'alpha' })
    expect(result).toHaveLength(1)
  })

  it('filters by status', () => {
    const entries = [
      makeAuditEntry({ status: 'OK' }),
      makeAuditEntry({ status: 'BLOCKED' }),
      makeAuditEntry({ status: 'WARNED' }),
    ]
    setupAuditLogFile(entries)

    const result = mod.readAuditLog({ status: 'BLOCKED' })
    expect(result).toHaveLength(1)
    expect(result[0].status).toBe('BLOCKED')
  })

  it('applies limit (defaults to 1000)', () => {
    const entries = Array.from({ length: 5 }, (_, i) =>
      makeAuditEntry({ costUsd: i, timestamp: `2026-01-0${i + 1}T00:00:00Z` })
    )
    setupAuditLogFile(entries)

    const result = mod.readAuditLog({ limit: 3 })
    expect(result).toHaveLength(3)
  })

  it('combines multiple filters', () => {
    const entries = [
      makeAuditEntry({ teamId: 'team-a', projectId: 'proj-1', timestamp: '2026-06-01T00:00:00Z' }),
      makeAuditEntry({ teamId: 'team-a', projectId: 'proj-2', timestamp: '2026-06-01T00:00:00Z' }),
      makeAuditEntry({ teamId: 'team-b', projectId: 'proj-1', timestamp: '2026-06-01T00:00:00Z' }),
      makeAuditEntry({ teamId: 'team-a', projectId: 'proj-1', timestamp: '2026-01-01T00:00:00Z' }),
    ]
    setupAuditLogFile(entries)

    const result = mod.readAuditLog({
      teamId: 'team-a',
      projectId: 'proj-1',
      startDate: new Date('2026-03-01'),
    })
    expect(result).toHaveLength(1)
    expect(result[0].timestamp).toBe('2026-06-01T00:00:00Z')
  })

  it('handles blank lines in JSONL', () => {
    mockFs.existsSync.mockImplementation((p: string) =>
      p === '/mock/governance/cost-audit.jsonl' ? true : false
    )
    const entry = makeAuditEntry()
    mockFs.readFileSync.mockReturnValue(
      JSON.stringify(entry) + '\n\n' + JSON.stringify(entry) + '\n'
    )

    const result = mod.readAuditLog()
    expect(result).toHaveLength(2)
  })

  it('returns empty array on parse error', () => {
    mockFs.existsSync.mockImplementation((p: string) =>
      p === '/mock/governance/cost-audit.jsonl' ? true : false
    )
    mockFs.readFileSync.mockReturnValue('not json\n')

    const result = mod.readAuditLog()
    expect(result).toEqual([])
  })
})

// ===================== exportAuditCsv =====================

describe('exportAuditCsv', () => {
  it('returns CSV with headers and data rows', () => {
    const entries = [
      makeAuditEntry({ teamId: 'acme', projectId: 'widget', costUsd: 1.2345, status: 'OK' }),
    ]
    setupAuditLogFile(entries)

    const csv = mod.exportAuditCsv()
    const lines = csv.split('\n')

    // Header row
    expect(lines[0]).toBe('Timestamp,Team,Project,Agent,Session,Cost (USD),Status,Reason')
    // Data row — quoted fields
    expect(lines[1]).toContain('"acme"')
    expect(lines[1]).toContain('"widget"')
    expect(lines[1]).toContain('"1.2345"')
    expect(lines[1]).toContain('"OK"')
  })

  it('returns only headers when audit log is empty', () => {
    mockFs.existsSync.mockReturnValue(false)

    const csv = mod.exportAuditCsv()
    const lines = csv.split('\n')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('Timestamp')
  })

  it('uses empty string for optional agentId and reason', () => {
    const entries = [
      makeAuditEntry({ agentId: undefined, reason: undefined }),
    ]
    setupAuditLogFile(entries)

    const csv = mod.exportAuditCsv()
    // Agent column should be empty-quoted
    expect(csv).toContain('""')
  })
})

// ===================== getTeamProjectSpend =====================

describe('getTeamProjectSpend', () => {
  it('sums costUsd for matching team+project within window', () => {
    const now = new Date()
    const recent = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000).toISOString() // 5 days ago

    const entries = [
      makeAuditEntry({ teamId: 'team-a', projectId: 'proj-1', costUsd: 10, timestamp: recent }),
      makeAuditEntry({ teamId: 'team-a', projectId: 'proj-1', costUsd: 20, timestamp: recent }),
      makeAuditEntry({ teamId: 'team-a', projectId: 'proj-2', costUsd: 100, timestamp: recent }), // different project
    ]
    setupAuditLogFile(entries)

    const spend = mod.getTeamProjectSpend('team-a', 'proj-1', 30)
    expect(spend).toBe(30)
  })

  it('excludes entries outside the time window', () => {
    const recent = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString()
    const old = '2020-01-01T00:00:00Z' // way outside 30-day window

    const entries = [
      makeAuditEntry({ teamId: 'team-a', projectId: 'proj-1', costUsd: 10, timestamp: recent }),
      makeAuditEntry({ teamId: 'team-a', projectId: 'proj-1', costUsd: 90, timestamp: old }),
    ]
    setupAuditLogFile(entries)

    const spend = mod.getTeamProjectSpend('team-a', 'proj-1', 30)
    expect(spend).toBe(10)
  })

  it('returns 0 when no matching entries', () => {
    mockFs.existsSync.mockReturnValue(false)

    const spend = mod.getTeamProjectSpend('nonexistent', 'proj', 30)
    expect(spend).toBe(0)
  })
})

// ===================== getTeamSpend =====================

describe('getTeamSpend', () => {
  it('sums all projects for a team within window', () => {
    const recent = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString()

    const entries = [
      makeAuditEntry({ teamId: 'team-a', projectId: 'proj-1', costUsd: 5, timestamp: recent }),
      makeAuditEntry({ teamId: 'team-a', projectId: 'proj-2', costUsd: 15, timestamp: recent }),
      makeAuditEntry({ teamId: 'team-b', projectId: 'proj-1', costUsd: 100, timestamp: recent }),
    ]
    setupAuditLogFile(entries)

    const spend = mod.getTeamSpend('team-a', 30)
    expect(spend).toBe(20)
  })
})

// ===================== checkQuotaStatus =====================

describe('checkQuotaStatus', () => {
  function setupQuotasAndSpend(
    quotas: Array<{ teamId: string; projectId: string; agentId?: string; hardLimitUsd: number; warnThresholdUsd: number }>,
    spendEntries: ReturnType<typeof makeAuditEntry>[]
  ) {
    const quotaData = makeQuotas(quotas)

    // Setup quota file reads
    mockFs.existsSync.mockImplementation((p: string) => {
      if (p === '/mock/governance/cost-quotas.json') return true
      if (p === '/mock/governance/cost-audit.jsonl') return spendEntries.length > 0
      return false
    })
    mockFs.statSync.mockReturnValue({ mtimeMs: Date.now() })
    mockFs.readFileSync.mockImplementation((p: string) => {
      if (typeof p === 'string' && p.endsWith('.json')) return JSON.stringify(quotaData)
      if (typeof p === 'string' && p.endsWith('.jsonl')) {
        return spendEntries.map(e => JSON.stringify(e)).join('\n') + '\n'
      }
      return ''
    })
  }

  it('returns OK with Infinity limit when no quota defined', () => {
    mockFs.existsSync.mockReturnValue(false)

    const result = mod.checkQuotaStatus('no-team', 'no-proj', undefined, 0, 0)

    expect(result.status).toBe('OK')
    expect(result.limitUsd).toBe(Infinity)
    expect(result.reason).toBe('No quota defined')
  })

  it('returns OK when spend is below warn threshold', () => {
    const recent = new Date(Date.now() - 1000).toISOString()
    setupQuotasAndSpend(
      [{ teamId: 'acme', projectId: 'proj', hardLimitUsd: 100, warnThresholdUsd: 80 }],
      [makeAuditEntry({ teamId: 'acme', projectId: 'proj', costUsd: 10, timestamp: recent })]
    )

    const result = mod.checkQuotaStatus('acme', 'proj', undefined, 0, 0)

    expect(result.status).toBe('OK')
    expect(result.currentSpend).toBe(10)
    expect(result.limitUsd).toBe(100)
    expect(result.reason).toContain('Within limits')
  })

  it('returns WARNED when spend exceeds warn threshold', () => {
    const recent = new Date(Date.now() - 1000).toISOString()
    setupQuotasAndSpend(
      [{ teamId: 'acme', projectId: 'proj', hardLimitUsd: 100, warnThresholdUsd: 80 }],
      [makeAuditEntry({ teamId: 'acme', projectId: 'proj', costUsd: 85, timestamp: recent })]
    )

    const result = mod.checkQuotaStatus('acme', 'proj', undefined, 0, 0)

    expect(result.status).toBe('WARNED')
    expect(result.reason).toContain('Approaching limit')
  })

  it('returns BLOCKED when spend exceeds hard limit', () => {
    const recent = new Date(Date.now() - 1000).toISOString()
    setupQuotasAndSpend(
      [{ teamId: 'acme', projectId: 'proj', hardLimitUsd: 100, warnThresholdUsd: 80 }],
      [makeAuditEntry({ teamId: 'acme', projectId: 'proj', costUsd: 105, timestamp: recent })]
    )

    const result = mod.checkQuotaStatus('acme', 'proj', undefined, 0, 0)

    expect(result.status).toBe('BLOCKED')
    expect(result.reason).toContain('Hard limit reached')
  })

  it('matches agent-level quota over project-level', () => {
    const recent = new Date(Date.now() - 1000).toISOString()
    setupQuotasAndSpend(
      [
        // Project-level: high limit
        { teamId: 'acme', projectId: 'proj', hardLimitUsd: 1000, warnThresholdUsd: 800 },
        // Agent-level: low limit
        { teamId: 'acme', projectId: 'proj', agentId: 'bot-1', hardLimitUsd: 50, warnThresholdUsd: 40 },
      ],
      [makeAuditEntry({ teamId: 'acme', projectId: 'proj', costUsd: 45, timestamp: recent })]
    )

    const result = mod.checkQuotaStatus('acme', 'proj', 'bot-1', 0, 0)

    // Agent quota limit should apply (50, not 1000)
    expect(result.limitUsd).toBe(50)
    expect(result.status).toBe('WARNED') // 45 >= 40 warn threshold
  })

  it('falls back to project-level when no agent quota exists', () => {
    const recent = new Date(Date.now() - 1000).toISOString()
    setupQuotasAndSpend(
      [{ teamId: 'acme', projectId: 'proj', hardLimitUsd: 200, warnThresholdUsd: 160 }],
      [makeAuditEntry({ teamId: 'acme', projectId: 'proj', costUsd: 50, timestamp: recent })]
    )

    const result = mod.checkQuotaStatus('acme', 'proj', 'unknown-agent', 0, 0)

    expect(result.limitUsd).toBe(200)
    expect(result.status).toBe('OK')
  })

  it('falls back to team-level (ungoverned) when no project quota exists', () => {
    const recent = new Date(Date.now() - 1000).toISOString()
    setupQuotasAndSpend(
      [{ teamId: 'acme', projectId: 'ungoverned', hardLimitUsd: 500, warnThresholdUsd: 400 }],
      [makeAuditEntry({ teamId: 'acme', projectId: 'unknown-proj', costUsd: 450, timestamp: recent })]
    )

    const result = mod.checkQuotaStatus('acme', 'unknown-proj', undefined, 0, 0)

    expect(result.limitUsd).toBe(500)
    expect(result.status).toBe('WARNED')
  })

  it('treats warnThresholdUsd <= 100 as percentage of hard limit', () => {
    const recent = new Date(Date.now() - 1000).toISOString()
    setupQuotasAndSpend(
      [{ teamId: 'acme', projectId: 'proj', hardLimitUsd: 1000, warnThresholdUsd: 80 }],
      // 80% of 1000 = 800. Spend of 810 should trigger WARNED.
      [makeAuditEntry({ teamId: 'acme', projectId: 'proj', costUsd: 810, timestamp: recent })]
    )

    const result = mod.checkQuotaStatus('acme', 'proj', undefined, 0, 0)

    expect(result.status).toBe('WARNED')
    expect(result.reason).toContain('800.00') // $800 warn threshold
  })

  it('treats warnThresholdUsd > 100 as absolute value', () => {
    const recent = new Date(Date.now() - 1000).toISOString()
    setupQuotasAndSpend(
      [{ teamId: 'acme', projectId: 'proj', hardLimitUsd: 1000, warnThresholdUsd: 500 }],
      [makeAuditEntry({ teamId: 'acme', projectId: 'proj', costUsd: 510, timestamp: recent })]
    )

    const result = mod.checkQuotaStatus('acme', 'proj', undefined, 0, 0)

    expect(result.status).toBe('WARNED')
    expect(result.reason).toContain('500.00') // $500 absolute threshold
  })

  it('returns BLOCKED at exact hard limit boundary', () => {
    const recent = new Date(Date.now() - 1000).toISOString()
    setupQuotasAndSpend(
      [{ teamId: 'acme', projectId: 'proj', hardLimitUsd: 100, warnThresholdUsd: 80 }],
      [makeAuditEntry({ teamId: 'acme', projectId: 'proj', costUsd: 100, timestamp: recent })]
    )

    const result = mod.checkQuotaStatus('acme', 'proj', undefined, 0, 0)

    expect(result.status).toBe('BLOCKED')
  })
})
