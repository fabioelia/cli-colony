import { describe, it, expect, vi, beforeEach } from 'vitest'

const MOCK_PIPELINES = '/mock/.claude-colony/pipelines'

function buildFsMock(content?: string, existsResult = false) {
  return {
    readFileSync: vi.fn().mockImplementation(() => {
      if (content !== undefined) return content
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    }),
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
    existsSync: vi.fn().mockReturnValue(existsResult),
  }
}

function setupMocks(fsMock: ReturnType<typeof buildFsMock>) {
  vi.doMock('electron', () => ({
    app: { getPath: vi.fn().mockReturnValue('/mock/home') },
  }))
  vi.doMock('fs', () => ({ ...fsMock, default: fsMock }))
  vi.doMock('../../shared/colony-paths', () => ({
    colonyPaths: { pipelines: MOCK_PIPELINES },
  }))
}

describe('pipeline-notes: getPipelineNotes', () => {
  let mod: typeof import('../pipeline-notes')

  beforeEach(() => { vi.resetModules() })

  it('returns [] when notes file does not exist', async () => {
    const fsMock = buildFsMock(undefined, false)
    setupMocks(fsMock)
    mod = await import('../pipeline-notes')
    expect(mod.getPipelineNotes('my-pipe.yaml')).toEqual([])
    expect(fsMock.readFileSync).not.toHaveBeenCalled()
  })

  it('returns parsed notes when file exists', async () => {
    const notes = [{ createdAt: '2026-01-01T00:00:00.000Z', text: 'hello' }]
    const fsMock = buildFsMock(JSON.stringify(notes), true)
    setupMocks(fsMock)
    mod = await import('../pipeline-notes')
    expect(mod.getPipelineNotes('my-pipe.yaml')).toEqual(notes)
  })

  it('returns [] when file contains invalid JSON', async () => {
    const fsMock = buildFsMock('not json at all', true)
    setupMocks(fsMock)
    mod = await import('../pipeline-notes')
    expect(mod.getPipelineNotes('my-pipe.yaml')).toEqual([])
  })

  it('strips .yml extension when building path', async () => {
    const notes = [{ createdAt: '2026-01-01T00:00:00.000Z', text: 'note' }]
    const fsMock = buildFsMock(JSON.stringify(notes), true)
    setupMocks(fsMock)
    mod = await import('../pipeline-notes')
    mod.getPipelineNotes('my-pipe.yml')
    const [path] = fsMock.readFileSync.mock.calls[0] as [string]
    expect(path).toBe(`${MOCK_PIPELINES}/my-pipe.notes.json`)
  })
})

describe('pipeline-notes: addPipelineNote', () => {
  let mod: typeof import('../pipeline-notes')

  beforeEach(() => { vi.resetModules() })

  it('returns false for empty text', async () => {
    const fsMock = buildFsMock(undefined, false)
    setupMocks(fsMock)
    mod = await import('../pipeline-notes')
    expect(mod.addPipelineNote('pipe.yaml', '   ')).toBe(false)
    expect(fsMock.writeFileSync).not.toHaveBeenCalled()
  })

  it('creates new notes file with trimmed text', async () => {
    const fsMock = buildFsMock(undefined, false)
    setupMocks(fsMock)
    mod = await import('../pipeline-notes')
    const result = mod.addPipelineNote('pipe.yaml', '  hello world  ')
    expect(result).toBe(true)
    const [, raw] = fsMock.writeFileSync.mock.calls[0] as [string, string]
    const written = JSON.parse(raw) as Array<{ text: string; createdAt: string }>
    expect(written).toHaveLength(1)
    expect(written[0].text).toBe('hello world')
    expect(written[0].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('appends to existing notes', async () => {
    const existing = [{ createdAt: '2026-01-01T00:00:00.000Z', text: 'first' }]
    const fsMock = buildFsMock(JSON.stringify(existing), true)
    setupMocks(fsMock)
    mod = await import('../pipeline-notes')
    mod.addPipelineNote('pipe.yaml', 'second')
    const [, raw] = fsMock.writeFileSync.mock.calls[0] as [string, string]
    const written = JSON.parse(raw) as Array<{ text: string }>
    expect(written).toHaveLength(2)
    expect(written[1].text).toBe('second')
  })
})

describe('pipeline-notes: deletePipelineNote', () => {
  let mod: typeof import('../pipeline-notes')

  beforeEach(() => { vi.resetModules() })

  it('returns false for negative index', async () => {
    const notes = [{ createdAt: '2026-01-01T00:00:00.000Z', text: 'a' }]
    const fsMock = buildFsMock(JSON.stringify(notes), true)
    setupMocks(fsMock)
    mod = await import('../pipeline-notes')
    expect(mod.deletePipelineNote('pipe.yaml', -1)).toBe(false)
    expect(fsMock.writeFileSync).not.toHaveBeenCalled()
  })

  it('returns false for index >= length', async () => {
    const notes = [{ createdAt: '2026-01-01T00:00:00.000Z', text: 'a' }]
    const fsMock = buildFsMock(JSON.stringify(notes), true)
    setupMocks(fsMock)
    mod = await import('../pipeline-notes')
    expect(mod.deletePipelineNote('pipe.yaml', 1)).toBe(false)
  })

  it('removes note and writes back when more remain', async () => {
    const notes = [
      { createdAt: '2026-01-01T00:00:00.000Z', text: 'keep' },
      { createdAt: '2026-01-02T00:00:00.000Z', text: 'delete me' },
    ]
    const fsMock = buildFsMock(JSON.stringify(notes), true)
    setupMocks(fsMock)
    mod = await import('../pipeline-notes')
    const result = mod.deletePipelineNote('pipe.yaml', 1)
    expect(result).toBe(true)
    const [, raw] = fsMock.writeFileSync.mock.calls[0] as [string, string]
    const written = JSON.parse(raw) as Array<{ text: string }>
    expect(written).toHaveLength(1)
    expect(written[0].text).toBe('keep')
  })

  it('deletes file when last note removed', async () => {
    const notes = [{ createdAt: '2026-01-01T00:00:00.000Z', text: 'only' }]
    const fsMock = buildFsMock(JSON.stringify(notes), true)
    setupMocks(fsMock)
    mod = await import('../pipeline-notes')
    const result = mod.deletePipelineNote('pipe.yaml', 0)
    expect(result).toBe(true)
    expect(fsMock.unlinkSync).toHaveBeenCalled()
    expect(fsMock.writeFileSync).not.toHaveBeenCalled()
  })
})

describe('pipeline-notes: updatePipelineNote', () => {
  let mod: typeof import('../pipeline-notes')

  beforeEach(() => { vi.resetModules() })

  it('returns false for empty new text', async () => {
    const notes = [{ createdAt: '2026-01-01T00:00:00.000Z', text: 'old' }]
    const fsMock = buildFsMock(JSON.stringify(notes), true)
    setupMocks(fsMock)
    mod = await import('../pipeline-notes')
    expect(mod.updatePipelineNote('pipe.yaml', 0, '  ')).toBe(false)
  })

  it('returns false for out-of-bounds index', async () => {
    const notes = [{ createdAt: '2026-01-01T00:00:00.000Z', text: 'old' }]
    const fsMock = buildFsMock(JSON.stringify(notes), true)
    setupMocks(fsMock)
    mod = await import('../pipeline-notes')
    expect(mod.updatePipelineNote('pipe.yaml', 5, 'new')).toBe(false)
  })

  it('updates note text and writes back', async () => {
    const notes = [{ createdAt: '2026-01-01T00:00:00.000Z', text: 'old' }]
    const fsMock = buildFsMock(JSON.stringify(notes), true)
    setupMocks(fsMock)
    mod = await import('../pipeline-notes')
    const result = mod.updatePipelineNote('pipe.yaml', 0, '  updated  ')
    expect(result).toBe(true)
    const [, raw] = fsMock.writeFileSync.mock.calls[0] as [string, string]
    const written = JSON.parse(raw) as Array<{ text: string; createdAt: string }>
    expect(written[0].text).toBe('updated')
    expect(written[0].createdAt).toBe('2026-01-01T00:00:00.000Z')
  })
})

describe('pipeline-notes: clearPipelineNotes', () => {
  let mod: typeof import('../pipeline-notes')

  beforeEach(() => { vi.resetModules() })

  it('deletes the notes file', async () => {
    const fsMock = buildFsMock('[]', true)
    setupMocks(fsMock)
    mod = await import('../pipeline-notes')
    mod.clearPipelineNotes('pipe.yaml')
    expect(fsMock.unlinkSync).toHaveBeenCalledWith(`${MOCK_PIPELINES}/pipe.notes.json`)
  })

  it('does not throw if file does not exist', async () => {
    const fsMock = buildFsMock(undefined, false)
    fsMock.unlinkSync = vi.fn().mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
    setupMocks(fsMock)
    mod = await import('../pipeline-notes')
    expect(() => mod.clearPipelineNotes('pipe.yaml')).not.toThrow()
  })
})
