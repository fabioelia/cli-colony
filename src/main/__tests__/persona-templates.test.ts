import { describe, it, expect, vi, beforeEach } from 'vitest'

const MOCK_PERSONAS = '/mock/.claude-colony/personas'
const MOCK_TEMPLATES = '/mock/.claude-colony/persona-templates'

function buildFspMock(opts: {
  readdirResult?: string[]
  readdirError?: Error
  readFileResult?: Record<string, string>
  mkdirOk?: boolean
  writeFileOk?: boolean
}) {
  return {
    readdir: vi.fn().mockImplementation(async () => {
      if (opts.readdirError) throw opts.readdirError
      return opts.readdirResult ?? []
    }),
    readFile: vi.fn().mockImplementation(async (path: string) => {
      const map = opts.readFileResult ?? {}
      if (path in map) return map[path]
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    }),
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
  }
}

function setupMocks(fspMock: ReturnType<typeof buildFspMock>) {
  vi.doMock('electron', () => ({
    app: { getPath: vi.fn().mockReturnValue('/mock/home') },
  }))
  vi.doMock('fs', () => ({
    promises: fspMock,
    default: { promises: fspMock },
  }))
  vi.doMock('../../shared/colony-paths', () => ({
    colonyPaths: {
      personas: MOCK_PERSONAS,
      personaTemplates: MOCK_TEMPLATES,
    },
  }))
}

describe('persona-templates: getBuiltInTemplates', () => {
  let mod: typeof import('../persona-templates')

  beforeEach(() => { vi.resetModules() })

  it('returns exactly the verifier template', async () => {
    setupMocks(buildFspMock({}))
    mod = await import('../persona-templates')
    const result = await mod.getBuiltInTemplates()
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('verifier')
    expect(result[0].builtIn).toBe(true)
  })

  it('verifier template has name and description', async () => {
    setupMocks(buildFspMock({}))
    mod = await import('../persona-templates')
    const [verifier] = await mod.getBuiltInTemplates()
    expect(verifier.name).toBeTruthy()
    expect(verifier.description).toBeTruthy()
  })
})

describe('persona-templates: getUserTemplates', () => {
  let mod: typeof import('../persona-templates')

  beforeEach(() => { vi.resetModules() })

  it('returns [] when templates dir does not exist', async () => {
    setupMocks(buildFspMock({ readdirError: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) }))
    mod = await import('../persona-templates')
    expect(await mod.getUserTemplates()).toEqual([])
  })

  it('returns [] for empty directory', async () => {
    setupMocks(buildFspMock({ readdirResult: [] }))
    mod = await import('../persona-templates')
    expect(await mod.getUserTemplates()).toEqual([])
  })

  it('skips non-YAML files', async () => {
    setupMocks(buildFspMock({ readdirResult: ['readme.md', 'template.json', '.DS_Store'] }))
    mod = await import('../persona-templates')
    expect(await mod.getUserTemplates()).toEqual([])
  })

  it('parses name and description from YAML file', async () => {
    const yaml = `name: "My Template"\ndescription: "Does things"\nprompt: hi\n`
    setupMocks(buildFspMock({
      readdirResult: ['my-template.yaml'],
      readFileResult: { [`${MOCK_TEMPLATES}/my-template.yaml`]: yaml },
    }))
    mod = await import('../persona-templates')
    const result = await mod.getUserTemplates()
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('my-template')
    expect(result[0].name).toBe('My Template')
    expect(result[0].description).toBe('Does things')
    expect(result[0].builtIn).toBe(false)
  })

  it('uses filename as id and name when name field missing', async () => {
    const yaml = `prompt: hello\n`
    setupMocks(buildFspMock({
      readdirResult: ['fallback.yaml'],
      readFileResult: { [`${MOCK_TEMPLATES}/fallback.yaml`]: yaml },
    }))
    mod = await import('../persona-templates')
    const [t] = await mod.getUserTemplates()
    expect(t.id).toBe('fallback')
    expect(t.name).toBe('fallback')
  })

  it('skips files that cannot be read', async () => {
    setupMocks(buildFspMock({
      readdirResult: ['bad.yaml'],
      readFileResult: {},
    }))
    mod = await import('../persona-templates')
    expect(await mod.getUserTemplates()).toEqual([])
  })

  it('handles both .yaml and .yml extensions', async () => {
    const yaml = `name: "YML Template"\n`
    setupMocks(buildFspMock({
      readdirResult: ['thing.yml'],
      readFileResult: { [`${MOCK_TEMPLATES}/thing.yml`]: yaml },
    }))
    mod = await import('../persona-templates')
    const result = await mod.getUserTemplates()
    expect(result[0].id).toBe('thing')
  })
})

describe('persona-templates: getAllTemplates', () => {
  let mod: typeof import('../persona-templates')

  beforeEach(() => { vi.resetModules() })

  it('combines built-in and user templates', async () => {
    const yaml = `name: "Custom"\n`
    setupMocks(buildFspMock({
      readdirResult: ['custom.yaml'],
      readFileResult: { [`${MOCK_TEMPLATES}/custom.yaml`]: yaml },
    }))
    mod = await import('../persona-templates')
    const all = await mod.getAllTemplates()
    expect(all.some(t => t.builtIn)).toBe(true)
    expect(all.some(t => !t.builtIn && t.id === 'custom')).toBe(true)
  })
})

describe('persona-templates: createPersonaFromTemplate', () => {
  let mod: typeof import('../persona-templates')

  beforeEach(() => { vi.resetModules() })

  it('creates verifier persona and returns fileName', async () => {
    const fspMock = buildFspMock({})
    setupMocks(fspMock)
    mod = await import('../persona-templates')
    const result = await mod.createPersonaFromTemplate('verifier')
    expect(result).toEqual({ fileName: 'colony-verifier.md' })
    expect(fspMock.writeFile).toHaveBeenCalled()
    const [dest, content] = fspMock.writeFile.mock.calls[0] as [string, string]
    expect(dest).toBe(`${MOCK_PERSONAS}/colony-verifier.md`)
    expect(content).toContain('Colony Verifier')
    expect(content).toContain('---')
  })

  it('returns null when user template file not found', async () => {
    setupMocks(buildFspMock({ readFileResult: {} }))
    mod = await import('../persona-templates')
    const result = await mod.createPersonaFromTemplate('missing-template')
    expect(result).toBeNull()
  })

  it('returns null when user template has no prompt field', async () => {
    const yaml = `name: "No Prompt"\ndescription: "test"\n`
    setupMocks(buildFspMock({
      readFileResult: {
        [`${MOCK_TEMPLATES}/no-prompt.yaml`]: yaml,
        [`${MOCK_TEMPLATES}/no-prompt.yml`]: yaml,
      },
    }))
    mod = await import('../persona-templates')
    const result = await mod.createPersonaFromTemplate('no-prompt')
    expect(result).toBeNull()
  })

  it('creates persona from user template with slugified filename', async () => {
    // regex requires a lowercase-starting line after prompt body to anchor the lazy match
    const yaml = `name: "My Cool Template"\nprompt: |\n  You are helpful.\nmodel: sonnet\n`
    const fspMock = buildFspMock({
      readFileResult: { [`${MOCK_TEMPLATES}/my-cool-template.yaml`]: yaml },
    })
    setupMocks(fspMock)
    mod = await import('../persona-templates')
    const result = await mod.createPersonaFromTemplate('my-cool-template')
    expect(result).not.toBeNull()
    const [dest] = fspMock.writeFile.mock.calls[0] as [string]
    expect(dest).toContain('my-cool-template.md')
  })

  it('includes persona frontmatter with disabled and no-schedule defaults', async () => {
    const yaml = `name: "Test Persona"\nprompt: |\n  Do stuff.\nmodel: sonnet\n`
    const fspMock = buildFspMock({
      readFileResult: { [`${MOCK_TEMPLATES}/test-persona.yaml`]: yaml },
    })
    setupMocks(fspMock)
    mod = await import('../persona-templates')
    await mod.createPersonaFromTemplate('test-persona')
    const [, content] = fspMock.writeFile.mock.calls[0] as [string, string]
    expect(content).toContain('enabled: false')
    expect(content).toContain('schedule: null')
    expect(content).toContain('Test Persona')
  })
})
