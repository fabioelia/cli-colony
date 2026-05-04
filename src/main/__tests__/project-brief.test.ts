import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ProjectBriefEntry } from '../project-brief'

const MOCK_ROOT = '/mock/.claude-colony'
const BRIEFS_DIR = `${MOCK_ROOT}/project-briefs`

const baseEntry: ProjectBriefEntry = {
  timestamp: '2026-05-04T12:00:00.000Z',
  sessionName: 'Colony Developer',
  exitCode: 0,
  durationMinutes: 10,
  commits: ['feat: add thing', 'fix: edge case'],
  filesChanged: 5,
}

function buildFsMock(existingContent?: string) {
  return {
    promises: {
      mkdir: vi.fn().mockResolvedValue(undefined),
      readFile: vi.fn().mockImplementation(async () => {
        if (existingContent !== undefined) return existingContent
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      }),
      writeFile: vi.fn().mockResolvedValue(undefined),
    },
  }
}

function setupMocks(fsMock: ReturnType<typeof buildFsMock>, existsResult = false) {
  vi.doMock('electron', () => ({
    app: { getPath: vi.fn().mockReturnValue('/mock/home') },
  }))
  vi.doMock('fs', () => ({
    ...fsMock,
    existsSync: vi.fn().mockReturnValue(existsResult),
  }))
  vi.doMock('../../shared/colony-paths', () => ({
    colonyPaths: {
      root: MOCK_ROOT,
      projectBriefs: BRIEFS_DIR,
      projectBrief: (slug: string) => `${BRIEFS_DIR}/${slug}.md`,
    },
  }))
}

describe('project-brief: appendBriefEntry', () => {
  let mod: typeof import('../project-brief')

  beforeEach(() => {
    vi.resetModules()
  })

  it('creates a new brief when none exists', async () => {
    const fsMock = buildFsMock(undefined)
    setupMocks(fsMock)
    mod = await import('../project-brief')

    await mod.appendBriefEntry('/projects/my-app', baseEntry)

    expect(fsMock.promises.mkdir).toHaveBeenCalledWith(BRIEFS_DIR, { recursive: true })
    const [, content] = fsMock.promises.writeFile.mock.calls[0] as [string, string]
    expect(content).toContain('# Project Brief: my-app')
    expect(content).toContain('Colony Developer')
    expect(content).toContain('feat: add thing, fix: edge case')
  })

  it('appends entry to existing brief', async () => {
    const existing = `# Project Brief: my-app\n## Recent Sessions\n- [2026-05-01T10:00:00.000Z] **Old Session** (exit 0, 5m) — 2 files changed\n`
    const fsMock = buildFsMock(existing)
    setupMocks(fsMock)
    mod = await import('../project-brief')

    await mod.appendBriefEntry('/projects/my-app', baseEntry)

    const [, content] = fsMock.promises.writeFile.mock.calls[0] as [string, string]
    expect(content).toContain('Old Session')
    expect(content).toContain('Colony Developer')
  })

  it('shows up to 3 commits then +N more', async () => {
    const fsMock = buildFsMock(undefined)
    setupMocks(fsMock)
    mod = await import('../project-brief')

    const entry = { ...baseEntry, commits: ['c1', 'c2', 'c3', 'c4', 'c5'] }
    await mod.appendBriefEntry('/projects/my-app', entry)

    const [, content] = fsMock.promises.writeFile.mock.calls[0] as [string, string]
    expect(content).toContain('c1, c2, c3 +2 more')
  })

  it('shows exactly 3 commits without +N suffix', async () => {
    const fsMock = buildFsMock(undefined)
    setupMocks(fsMock)
    mod = await import('../project-brief')

    const entry = { ...baseEntry, commits: ['a', 'b', 'c'] }
    await mod.appendBriefEntry('/projects/my-app', entry)

    const [, content] = fsMock.promises.writeFile.mock.calls[0] as [string, string]
    expect(content).toContain('a, b, c')
    expect(content).not.toContain('+')
  })

  it('uses filesChanged when no commits', async () => {
    const fsMock = buildFsMock(undefined)
    setupMocks(fsMock)
    mod = await import('../project-brief')

    const entry = { ...baseEntry, commits: [], filesChanged: 3 }
    await mod.appendBriefEntry('/projects/my-app', entry)

    const [, content] = fsMock.promises.writeFile.mock.calls[0] as [string, string]
    expect(content).toContain('3 files changed')
  })

  it('uses singular "file changed" when filesChanged is 1', async () => {
    const fsMock = buildFsMock(undefined)
    setupMocks(fsMock)
    mod = await import('../project-brief')

    const entry = { ...baseEntry, commits: [], filesChanged: 1 }
    await mod.appendBriefEntry('/projects/my-app', entry)

    const [, content] = fsMock.promises.writeFile.mock.calls[0] as [string, string]
    expect(content).toContain('1 file changed')
    expect(content).not.toContain('1 files')
  })

  it('includes cost in formatted entry when provided', async () => {
    const fsMock = buildFsMock(undefined)
    setupMocks(fsMock)
    mod = await import('../project-brief')

    const entry = { ...baseEntry, cost: 1.234 }
    await mod.appendBriefEntry('/projects/my-app', entry)

    const [, content] = fsMock.promises.writeFile.mock.calls[0] as [string, string]
    expect(content).toContain('$1.23')
  })

  it('omits cost when not provided', async () => {
    const fsMock = buildFsMock(undefined)
    setupMocks(fsMock)
    mod = await import('../project-brief')

    const entry = { ...baseEntry, cost: undefined }
    await mod.appendBriefEntry('/projects/my-app', entry)

    const [, content] = fsMock.promises.writeFile.mock.calls[0] as [string, string]
    expect(content).not.toContain('$')
  })

  it('prunes to last 30 entries when cap exceeded', async () => {
    const oldLines = Array.from({ length: 30 }, (_, i) =>
      `- [2026-0${(i % 9) + 1}-01T00:00:00.000Z] **Session ${i}** (exit 0, 1m) — 1 file changed`
    ).join('\n')
    const existing = `# Project Brief\n## Recent Sessions\n${oldLines}\n`
    const fsMock = buildFsMock(existing)
    setupMocks(fsMock)
    mod = await import('../project-brief')

    await mod.appendBriefEntry('/projects/my-app', baseEntry)

    const [, content] = fsMock.promises.writeFile.mock.calls[0] as [string, string]
    const lines = content.split('\n').filter((l: string) => l.startsWith('- ['))
    expect(lines).toHaveLength(30)
    expect(lines[lines.length - 1]).toContain('Colony Developer')
    expect(lines[0]).not.toContain('Session 0')
  })

  it('slugifies cwd basename for file path', async () => {
    const fsMock = buildFsMock(undefined)
    setupMocks(fsMock)
    mod = await import('../project-brief')

    await mod.appendBriefEntry('/projects/My Cool App', baseEntry)

    const [filePath] = fsMock.promises.writeFile.mock.calls[0] as [string]
    expect(filePath).toContain('my-cool-app')
  })
})

describe('project-brief: getProjectBriefPath', () => {
  let mod: typeof import('../project-brief')

  beforeEach(() => {
    vi.resetModules()
  })

  it('returns path when brief file exists', async () => {
    setupMocks(buildFsMock(), true)
    mod = await import('../project-brief')

    const result = mod.getProjectBriefPath('/projects/my-app')
    expect(result).toBe(`${BRIEFS_DIR}/my-app.md`)
  })

  it('returns null when brief file does not exist', async () => {
    setupMocks(buildFsMock(), false)
    mod = await import('../project-brief')

    const result = mod.getProjectBriefPath('/projects/my-app')
    expect(result).toBeNull()
  })
})
