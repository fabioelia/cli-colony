/**
 * Tests for src/main/mcp-catalog.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as path from 'path'

const CATALOG_PATH = '/mock/.claude-colony/mcp-catalog.json'
const CONFIGS_DIR = '/mock/.claude-colony/mcp-configs'

function buildFsMock(catalogContents: object | null = null) {
  const files: Record<string, string> = {}
  if (catalogContents !== null) {
    files[CATALOG_PATH] = JSON.stringify(catalogContents)
  }
  return {
    existsSync: vi.fn().mockImplementation((p: string) => p in files),
    readFileSync: vi.fn().mockImplementation((p: string, _enc?: string) => {
      if (p in files) return files[p]
      throw new Error(`Unexpected readFileSync: ${p}`)
    }),
    writeFileSync: vi.fn().mockImplementation((p: string, data: string) => {
      files[p] = data
    }),
    unlinkSync: vi.fn(),
    mkdirSync: vi.fn(),
    _files: files,
  }
}

async function loadModule(fsMock: ReturnType<typeof buildFsMock>) {
  vi.resetModules()
  vi.doMock('fs', () => fsMock)
  vi.doMock('../../shared/colony-paths', () => ({
    colonyPaths: {
      mcpCatalog: CATALOG_PATH,
      mcpConfigs: CONFIGS_DIR,
    },
  }))
  return await import('../mcp-catalog')
}

describe('readCatalog', () => {
  beforeEach(() => vi.resetModules())

  it('returns empty array when catalog file does not exist', async () => {
    const fs = buildFsMock(null)
    const mod = await loadModule(fs)
    expect(mod.readCatalog()).toEqual([])
  })

  it('returns parsed servers when file exists', async () => {
    const servers = [{ name: 'filesystem', command: 'npx', args: ['-y', '@mcp/fs'] }]
    const fs = buildFsMock(servers)
    const mod = await loadModule(fs)
    expect(mod.readCatalog()).toEqual(servers)
  })

  it('returns empty array on parse error', async () => {
    const fs = buildFsMock(null)
    fs.existsSync.mockReturnValue(true)
    fs.readFileSync.mockReturnValue('not-json')
    const mod = await loadModule(fs)
    expect(mod.readCatalog()).toEqual([])
  })
})

describe('writeCatalog', () => {
  beforeEach(() => vi.resetModules())

  it('writes JSON to the catalog path', async () => {
    const fs = buildFsMock(null)
    const mod = await loadModule(fs)
    const servers = [{ name: 'github', url: 'http://localhost:8080/sse' }]
    mod.writeCatalog(servers)
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      CATALOG_PATH,
      JSON.stringify(servers, null, 2),
      'utf-8'
    )
  })

  it('creates parent directory before writing', async () => {
    const fs = buildFsMock(null)
    const mod = await loadModule(fs)
    mod.writeCatalog([])
    expect(fs.mkdirSync).toHaveBeenCalledWith(
      path.dirname(CATALOG_PATH),
      { recursive: true }
    )
  })
})

describe('buildMcpConfig', () => {
  beforeEach(() => vi.resetModules())

  it('returns null when no servers match', async () => {
    const fs = buildFsMock([{ name: 'other', command: 'node', args: [] }])
    const mod = await loadModule(fs)
    expect(mod.buildMcpConfig(['missing'], 'sess-1')).toBeNull()
  })

  it('returns null when catalog is empty', async () => {
    const fs = buildFsMock([])
    const mod = await loadModule(fs)
    expect(mod.buildMcpConfig(['any'], 'sess-1')).toBeNull()
  })

  it('writes a valid mcp config and returns its path for command server', async () => {
    const fs = buildFsMock([
      { name: 'filesystem', command: 'npx', args: ['-y', '@mcp/fs', '/tmp'] },
    ])
    const mod = await loadModule(fs)
    const result = mod.buildMcpConfig(['filesystem'], 'sess-abc')
    expect(result).toBe(`${CONFIGS_DIR}/sess-abc.json`)
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      `${CONFIGS_DIR}/sess-abc.json`,
      expect.stringContaining('"filesystem"'),
      'utf-8'
    )
    const written = JSON.parse(fs.writeFileSync.mock.calls.at(-1)![1])
    expect(written.mcpServers.filesystem).toEqual({ command: 'npx', args: ['-y', '@mcp/fs', '/tmp'] })
  })

  it('writes sse type config for url-based server', async () => {
    const fs = buildFsMock([
      { name: 'remote', url: 'http://localhost:3000/sse' },
    ])
    const mod = await loadModule(fs)
    mod.buildMcpConfig(['remote'], 'sess-xyz')
    const written = JSON.parse(fs.writeFileSync.mock.calls.at(-1)![1])
    expect(written.mcpServers.remote).toEqual({ type: 'sse', url: 'http://localhost:3000/sse' })
  })

  it('only includes requested servers', async () => {
    const fs = buildFsMock([
      { name: 'a', command: 'node', args: [] },
      { name: 'b', command: 'deno', args: [] },
    ])
    const mod = await loadModule(fs)
    mod.buildMcpConfig(['a'], 'sess-1')
    const written = JSON.parse(fs.writeFileSync.mock.calls.at(-1)![1])
    expect(Object.keys(written.mcpServers)).toEqual(['a'])
  })

  it('skips servers with neither command nor url', async () => {
    const fs = buildFsMock([{ name: 'empty' }])
    const mod = await loadModule(fs)
    expect(mod.buildMcpConfig(['empty'], 'sess-1')).toBeNull()
  })
})

describe('cleanMcpConfigFile', () => {
  beforeEach(() => vi.resetModules())

  it('unlinks the file if it exists', async () => {
    const fs = buildFsMock(null)
    fs.existsSync.mockReturnValue(true)
    const mod = await loadModule(fs)
    mod.cleanMcpConfigFile('/some/path.json')
    expect(fs.unlinkSync).toHaveBeenCalledWith('/some/path.json')
  })

  it('does nothing if file does not exist', async () => {
    const fs = buildFsMock(null)
    fs.existsSync.mockReturnValue(false)
    const mod = await loadModule(fs)
    mod.cleanMcpConfigFile('/missing.json')
    expect(fs.unlinkSync).not.toHaveBeenCalled()
  })

  it('silently ignores errors', async () => {
    const fs = buildFsMock(null)
    fs.existsSync.mockReturnValue(true)
    fs.unlinkSync.mockImplementation(() => { throw new Error('no perms') })
    const mod = await loadModule(fs)
    expect(() => mod.cleanMcpConfigFile('/file.json')).not.toThrow()
  })
})
