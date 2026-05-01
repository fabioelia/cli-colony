import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const PLAYBOOKS_DIR = '/mock/.claude-colony/playbooks'

const mockBroadcast = vi.fn()

// ---- fs mock builder ----

function buildFsMock(fileMap: Record<string, string> = {}) {
  const store: Record<string, string> = { ...fileMap }
  return {
    promises: {
      mkdir: vi.fn().mockResolvedValue(undefined),
      readdir: vi.fn().mockImplementation(async (dir: string) => {
        const prefix = dir.endsWith('/') ? dir : dir + '/'
        return Object.keys(store)
          .filter(k => k.startsWith(prefix) && k.slice(prefix.length).indexOf('/') === -1)
          .map(k => k.slice(prefix.length))
      }),
      readFile: vi.fn().mockImplementation(async (p: string) => {
        if (p in store) return store[p]
        const e = Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' })
        throw e
      }),
      writeFile: vi.fn().mockImplementation(async (p: string, data: string) => {
        store[p] = data
      }),
      unlink: vi.fn().mockImplementation(async (p: string) => {
        if (!(p in store)) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' })
        delete store[p]
      }),
    },
    watch: vi.fn().mockReturnValue({ close: vi.fn() }),
    store,
  }
}

type FsMock = ReturnType<typeof buildFsMock>

function setupMocks(fsMock: FsMock) {
  vi.doMock('electron', () => ({
    app: { getPath: vi.fn().mockReturnValue('/mock/home') },
  }))
  vi.doMock('../../shared/colony-paths', () => ({
    colonyPaths: { playbooks: PLAYBOOKS_DIR },
  }))
  vi.doMock('fs', () => fsMock)
  vi.doMock('../broadcast', () => ({ broadcast: mockBroadcast }))
}

// ---- parsePlaybook (via loadPlaybooks) ----

describe('loadPlaybooks: parsePlaybook', () => {
  let mod: typeof import('../playbook-manager')
  let fsMock: FsMock

  beforeEach(async () => {
    vi.resetModules()
    mockBroadcast.mockReset()
    fsMock = buildFsMock({
      [`${PLAYBOOKS_DIR}/hello.yaml`]: `name: Hello World\ndescription: A test playbook\nmodel: sonnet\n`,
    })
    setupMocks(fsMock)
    mod = await import('../playbook-manager')
  })

  afterEach(() => vi.restoreAllMocks())

  it('loads a valid playbook and returns it via getPlaybooks()', async () => {
    await mod.loadPlaybooks()
    const pbs = mod.getPlaybooks()
    expect(pbs).toHaveLength(1)
    expect(pbs[0].name).toBe('Hello World')
    expect(pbs[0].description).toBe('A test playbook')
    expect(pbs[0].model).toBe('sonnet')
  })

  it('skips playbook missing required name field', async () => {
    vi.resetModules()
    fsMock = buildFsMock({ [`${PLAYBOOKS_DIR}/bad.yaml`]: `description: No name here\n` })
    setupMocks(fsMock)
    mod = await import('../playbook-manager')
    await mod.loadPlaybooks()
    expect(mod.getPlaybooks()).toHaveLength(0)
  })

  it('skips non-yaml files', async () => {
    vi.resetModules()
    fsMock = buildFsMock({
      [`${PLAYBOOKS_DIR}/readme.md`]: `name: Not a playbook`,
      [`${PLAYBOOKS_DIR}/real.yaml`]: `name: Real\n`,
    })
    setupMocks(fsMock)
    mod = await import('../playbook-manager')
    await mod.loadPlaybooks()
    expect(mod.getPlaybooks()).toHaveLength(1)
    expect(mod.getPlaybooks()[0].name).toBe('Real')
  })

  it('parses permissionMode only for valid values', async () => {
    vi.resetModules()
    fsMock = buildFsMock({
      [`${PLAYBOOKS_DIR}/a.yaml`]: `name: A\npermissionMode: autonomous\n`,
      [`${PLAYBOOKS_DIR}/b.yaml`]: `name: B\npermissionMode: invalid\n`,
    })
    setupMocks(fsMock)
    mod = await import('../playbook-manager')
    await mod.loadPlaybooks()
    const pbs = mod.getPlaybooks()
    const a = pbs.find(p => p.name === 'A')!
    const b = pbs.find(p => p.name === 'B')!
    expect(a.permissionMode).toBe('autonomous')
    expect(b.permissionMode).toBeUndefined()
  })

  it('parses inputs array with name/type/label fields', async () => {
    vi.resetModules()
    fsMock = buildFsMock({
      [`${PLAYBOOKS_DIR}/inputs.yaml`]: [
        'name: With Inputs',
        'inputs:',
        '  - name: env',
        '    label: Environment',
        '    type: select',
        '  - name: debug',
        '    type: boolean',
        '    default: "false"',
      ].join('\n'),
    })
    setupMocks(fsMock)
    mod = await import('../playbook-manager')
    await mod.loadPlaybooks()
    const pb = mod.getPlaybooks()[0]
    expect(pb.inputs).toHaveLength(2)
    expect(pb.inputs![0]).toMatchObject({ name: 'env', type: 'select', label: 'Environment' })
    expect(pb.inputs![1]).toMatchObject({ name: 'debug', type: 'boolean', default: 'false' })
  })

  it('filters out inputs with empty name', async () => {
    vi.resetModules()
    fsMock = buildFsMock({
      [`${PLAYBOOKS_DIR}/bad-input.yaml`]: 'name: Bad\ninputs:\n  - type: string\n',
    })
    setupMocks(fsMock)
    mod = await import('../playbook-manager')
    await mod.loadPlaybooks()
    const pb = mod.getPlaybooks()[0]
    expect(pb.inputs).toHaveLength(0)
  })
})

// ---- getPlaybook ----

describe('getPlaybook', () => {
  let mod: typeof import('../playbook-manager')
  let fsMock: FsMock

  beforeEach(async () => {
    vi.resetModules()
    fsMock = buildFsMock({
      [`${PLAYBOOKS_DIR}/alpha.yaml`]: 'name: Alpha\n',
      [`${PLAYBOOKS_DIR}/beta.yaml`]: 'name: Beta\n',
    })
    setupMocks(fsMock)
    mod = await import('../playbook-manager')
    await mod.loadPlaybooks()
  })

  afterEach(() => vi.restoreAllMocks())

  it('returns matching playbook by name', () => {
    expect(mod.getPlaybook('Alpha')?.name).toBe('Alpha')
  })

  it('returns null for unknown name', () => {
    expect(mod.getPlaybook('Unknown')).toBeNull()
  })
})

// ---- memory functions ----

describe('playbook memory', () => {
  let mod: typeof import('../playbook-manager')
  let fsMock: FsMock

  beforeEach(async () => {
    vi.resetModules()
    fsMock = buildFsMock({})
    setupMocks(fsMock)
    mod = await import('../playbook-manager')
  })

  afterEach(() => vi.restoreAllMocks())

  it('getPlaybookMemory returns empty string when file absent', async () => {
    expect(await mod.getPlaybookMemory('My Playbook')).toBe('')
  })

  it('appendPlaybookMemory writes new lines', async () => {
    await mod.appendPlaybookMemory('My Playbook', ['line one', 'line two'])
    const written = fsMock.store[`${PLAYBOOKS_DIR}/my-playbook.memory.md`]
    expect(written).toContain('line one')
    expect(written).toContain('line two')
  })

  it('appendPlaybookMemory deduplicates existing lines', async () => {
    await mod.appendPlaybookMemory('My Playbook', ['line one'])
    await mod.appendPlaybookMemory('My Playbook', ['line one', 'line two'])
    const written = fsMock.store[`${PLAYBOOKS_DIR}/my-playbook.memory.md`]
    const lines = written.trim().split('\n').filter(Boolean)
    expect(lines.filter(l => l === 'line one')).toHaveLength(1)
    expect(lines).toContain('line two')
  })

  it('appendPlaybookMemory caps at MAX_MEMORY_LINES (50)', async () => {
    const lines = Array.from({ length: 60 }, (_, i) => `line ${i}`)
    await mod.appendPlaybookMemory('My Playbook', lines)
    const written = fsMock.store[`${PLAYBOOKS_DIR}/my-playbook.memory.md`]
    const count = written.trim().split('\n').filter(Boolean).length
    expect(count).toBe(50)
    expect(written).toContain('line 59')
    expect(written).not.toContain('line 9\n')
  })

  it('appendPlaybookMemory is no-op when all lines already present', async () => {
    await mod.appendPlaybookMemory('My Playbook', ['existing'])
    const writeCalls = fsMock.promises.writeFile.mock.calls.length
    await mod.appendPlaybookMemory('My Playbook', ['existing'])
    expect(fsMock.promises.writeFile.mock.calls.length).toBe(writeCalls)
  })

  it('getPlaybookMemoryLineCount returns correct count', async () => {
    await mod.appendPlaybookMemory('My Playbook', ['a', 'b', 'c'])
    expect(await mod.getPlaybookMemoryLineCount('My Playbook')).toBe(3)
  })

  it('getPlaybookMemoryLineCount returns 0 when memory empty', async () => {
    expect(await mod.getPlaybookMemoryLineCount('My Playbook')).toBe(0)
  })

  it('clearPlaybookMemory deletes the memory file', async () => {
    await mod.appendPlaybookMemory('My Playbook', ['something'])
    await mod.clearPlaybookMemory('My Playbook')
    expect(fsMock.store[`${PLAYBOOKS_DIR}/my-playbook.memory.md`]).toBeUndefined()
  })

  it('clearPlaybookMemory is a no-op when file absent', async () => {
    await expect(mod.clearPlaybookMemory('Ghost Playbook')).resolves.not.toThrow()
  })

  it('memoryPath slugifies name correctly', async () => {
    await mod.appendPlaybookMemory('  Hello WORLD! ', ['x'])
    const keys = Object.keys(fsMock.store)
    expect(keys.some(k => k.includes('hello-world'))).toBe(true)
  })
})

// ---- watchPlaybooks ----

describe('watchPlaybooks', () => {
  let mod: typeof import('../playbook-manager')
  let fsMock: FsMock

  beforeEach(async () => {
    vi.resetModules()
    fsMock = buildFsMock({
      [`${PLAYBOOKS_DIR}/x.yaml`]: 'name: X\n',
    })
    setupMocks(fsMock)
    mod = await import('../playbook-manager')
  })

  afterEach(() => vi.restoreAllMocks())

  it('watchPlaybooks calls loadPlaybooks and attaches a watcher', async () => {
    await mod.watchPlaybooks()
    expect(fsMock.promises.readdir).toHaveBeenCalled()
    expect(fsMock.watch).toHaveBeenCalledWith(PLAYBOOKS_DIR, { persistent: false }, expect.any(Function))
    expect(mod.getPlaybooks()).toHaveLength(1)
  })

  it('watchPlaybooks closes previous watcher before creating new one', async () => {
    await mod.watchPlaybooks()
    const firstWatcher = fsMock.watch.mock.results[0].value as { close: ReturnType<typeof vi.fn> }
    await mod.watchPlaybooks()
    expect(firstWatcher.close).toHaveBeenCalled()
  })
})
