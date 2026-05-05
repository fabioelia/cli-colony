import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SessionPreset } from '../../shared/types'

const MOCK_ROOT = '/mock/.claude-colony'
const PRESETS_PATH = `${MOCK_ROOT}/session-presets.json`

const basePreset: SessionPreset = {
  name: 'My Preset',
  workingDirectory: '/projects/app',
  model: 'claude-sonnet-4-6',
  extraArgs: '',
  agent: '',
  permissionMode: 'auto',
  effort: 'normal',
}

function buildFsMock(existingContent?: string) {
  return {
    promises: {
      readFile: vi.fn().mockImplementation(async () => {
        if (existingContent !== undefined) return existingContent
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      }),
      writeFile: vi.fn().mockResolvedValue(undefined),
    },
  }
}

function setupMocks(fsMock: ReturnType<typeof buildFsMock>) {
  vi.doMock('electron', () => ({
    app: { getPath: vi.fn().mockReturnValue('/mock/home') },
  }))
  vi.doMock('fs', () => fsMock)
  vi.doMock('../../shared/colony-paths', () => ({
    colonyPaths: { sessionPresetsJson: PRESETS_PATH },
  }))
}

async function importMod() {
  return import('../session-presets')
}

describe('session-presets: getSessionPresets', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('returns empty array when file does not exist', async () => {
    const fsMock = buildFsMock(undefined)
    setupMocks(fsMock)
    const mod = await importMod()

    const result = await mod.getSessionPresets()
    expect(result).toEqual([])
  })

  it('returns parsed presets from JSON file', async () => {
    const fsMock = buildFsMock(JSON.stringify([basePreset]))
    setupMocks(fsMock)
    const mod = await importMod()

    const result = await mod.getSessionPresets()
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('My Preset')
  })

  it('returns empty array when file contains non-array JSON', async () => {
    const fsMock = buildFsMock(JSON.stringify({ name: 'not an array' }))
    setupMocks(fsMock)
    const mod = await importMod()

    const result = await mod.getSessionPresets()
    expect(result).toEqual([])
  })

  it('returns empty array on invalid JSON', async () => {
    const fsMock = buildFsMock('not-json{{{')
    setupMocks(fsMock)
    const mod = await importMod()

    const result = await mod.getSessionPresets()
    expect(result).toEqual([])
  })

  it('returns multiple presets', async () => {
    const p2 = { ...basePreset, name: 'Second' }
    const fsMock = buildFsMock(JSON.stringify([basePreset, p2]))
    setupMocks(fsMock)
    const mod = await importMod()

    const result = await mod.getSessionPresets()
    expect(result).toHaveLength(2)
    expect(result[1].name).toBe('Second')
  })
})

describe('session-presets: saveSessionPreset', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('adds a new preset and returns true', async () => {
    const fsMock = buildFsMock(JSON.stringify([]))
    setupMocks(fsMock)
    const mod = await importMod()

    const ok = await mod.saveSessionPreset(basePreset)
    expect(ok).toBe(true)

    const [path, content] = fsMock.promises.writeFile.mock.calls[0] as [string, string]
    expect(path).toBe(PRESETS_PATH)
    const written = JSON.parse(content) as SessionPreset[]
    expect(written).toHaveLength(1)
    expect(written[0].name).toBe('My Preset')
  })

  it('saves to correct path', async () => {
    const fsMock = buildFsMock(undefined)
    setupMocks(fsMock)
    const mod = await importMod()

    await mod.saveSessionPreset(basePreset)
    expect(fsMock.promises.writeFile.mock.calls[0][0]).toBe(PRESETS_PATH)
  })

  it('overwrites existing preset with same name', async () => {
    const existing = { ...basePreset, model: 'claude-opus-4-6' }
    const fsMock = buildFsMock(JSON.stringify([existing]))
    setupMocks(fsMock)
    const mod = await importMod()

    const updated = { ...basePreset, model: 'claude-haiku-4-5-20251001' }
    await mod.saveSessionPreset(updated)

    const [, content] = fsMock.promises.writeFile.mock.calls[0] as [string, string]
    const written = JSON.parse(content) as SessionPreset[]
    expect(written).toHaveLength(1)
    expect(written[0].model).toBe('claude-haiku-4-5-20251001')
  })

  it('appends when name is unique', async () => {
    const fsMock = buildFsMock(JSON.stringify([basePreset]))
    setupMocks(fsMock)
    const mod = await importMod()

    const second = { ...basePreset, name: 'Second' }
    await mod.saveSessionPreset(second)

    const [, content] = fsMock.promises.writeFile.mock.calls[0] as [string, string]
    const written = JSON.parse(content) as SessionPreset[]
    expect(written).toHaveLength(2)
  })

  it('preserves optional fields (color, prompt, maxBudget)', async () => {
    const fsMock = buildFsMock(JSON.stringify([]))
    setupMocks(fsMock)
    const mod = await importMod()

    const rich = { ...basePreset, color: '#ff0000', prompt: 'hello', maxBudget: 5 }
    await mod.saveSessionPreset(rich)

    const [, content] = fsMock.promises.writeFile.mock.calls[0] as [string, string]
    const written = JSON.parse(content) as SessionPreset[]
    expect(written[0].color).toBe('#ff0000')
    expect(written[0].prompt).toBe('hello')
    expect(written[0].maxBudget).toBe(5)
  })
})

describe('session-presets: deleteSessionPreset', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('deletes existing preset and returns true', async () => {
    const fsMock = buildFsMock(JSON.stringify([basePreset]))
    setupMocks(fsMock)
    const mod = await importMod()

    const ok = await mod.deleteSessionPreset('My Preset')
    expect(ok).toBe(true)

    const [, content] = fsMock.promises.writeFile.mock.calls[0] as [string, string]
    expect(JSON.parse(content)).toEqual([])
  })

  it('returns false when preset name not found', async () => {
    const fsMock = buildFsMock(JSON.stringify([basePreset]))
    setupMocks(fsMock)
    const mod = await importMod()

    const ok = await mod.deleteSessionPreset('nonexistent')
    expect(ok).toBe(false)
    expect(fsMock.promises.writeFile).not.toHaveBeenCalled()
  })

  it('returns false on empty presets list', async () => {
    const fsMock = buildFsMock(JSON.stringify([]))
    setupMocks(fsMock)
    const mod = await importMod()

    const ok = await mod.deleteSessionPreset('My Preset')
    expect(ok).toBe(false)
  })

  it('removes only the matching preset, keeps others', async () => {
    const p2 = { ...basePreset, name: 'Keep Me' }
    const fsMock = buildFsMock(JSON.stringify([basePreset, p2]))
    setupMocks(fsMock)
    const mod = await importMod()

    await mod.deleteSessionPreset('My Preset')

    const [, content] = fsMock.promises.writeFile.mock.calls[0] as [string, string]
    const written = JSON.parse(content) as SessionPreset[]
    expect(written).toHaveLength(1)
    expect(written[0].name).toBe('Keep Me')
  })

  it('returns false when file does not exist', async () => {
    const fsMock = buildFsMock(undefined)
    setupMocks(fsMock)
    const mod = await importMod()

    const ok = await mod.deleteSessionPreset('My Preset')
    expect(ok).toBe(false)
  })
})
