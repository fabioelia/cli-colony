import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { InstanceManifest } from '../../daemon/env-protocol'

const mockFsp = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFile: vi.fn().mockResolvedValue(undefined),
}))

const mockGetManifest = vi.hoisted(() => vi.fn())

function setupMocks(): void {
  vi.doMock('fs', () => ({ promises: mockFsp }))
  vi.doMock('../../shared/colony-paths', () => ({
    colonyPaths: { worktreeDir: (id: string) => `/mock/worktrees/${id}` },
  }))
  vi.doMock('../env-manager', () => ({
    getManifest: mockGetManifest,
  }))
}

function makeManifest(overrides: Partial<InstanceManifest> = {}): InstanceManifest {
  return {
    version: 2,
    id: 'env-1',
    name: 'test-env',
    displayName: 'Test Env',
    projectType: 'generic',
    createdAt: '2026-01-01T00:00:00.000Z',
    paths: { root: '/mock/root' },
    services: {},
    ports: {},
    ...overrides,
  } as InstanceManifest
}

describe('readEnvClaudeMd', () => {
  let readEnvClaudeMd: (manifest: InstanceManifest, target: 'root' | 'worktree') => Promise<{ exists: boolean; content: string; path: string }>

  beforeEach(async () => {
    vi.resetModules()
    vi.resetAllMocks()
    setupMocks()
    mockFsp.writeFile.mockResolvedValue(undefined)
    const mod = await import('../env-claudemd')
    readEnvClaudeMd = mod.readEnvClaudeMd
  })

  it('returns exists=true with content when file is present', async () => {
    mockFsp.readFile.mockResolvedValue('# Test content')
    const result = await readEnvClaudeMd(makeManifest(), 'root')
    expect(result.exists).toBe(true)
    expect(result.content).toBe('# Test content')
    expect(result.path).toBe('/mock/root/CLAUDE.md')
  })

  it('returns exists=false on ENOENT without throwing', async () => {
    mockFsp.readFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
    const result = await readEnvClaudeMd(makeManifest(), 'root')
    expect(result.exists).toBe(false)
    expect(result.content).toBe('')
    expect(result.path).toBe('/mock/root/CLAUDE.md')
  })

  it('reads from worktree bundle dir when target=worktree', async () => {
    mockFsp.readFile.mockResolvedValue('# Worktree content')
    const manifest = makeManifest({ activeWorktreeId: 'wt-42' })
    const result = await readEnvClaudeMd(manifest, 'worktree')
    expect(result.exists).toBe(true)
    expect(result.path).toBe('/mock/worktrees/wt-42/CLAUDE.md')
  })
})

describe('regenerateEnvClaudeMdStrict', () => {
  let regenerateEnvClaudeMdStrict: (manifest: InstanceManifest) => Promise<{ writtenPaths: string[] }>

  beforeEach(async () => {
    vi.resetModules()
    vi.resetAllMocks()
    setupMocks()
    mockFsp.writeFile.mockResolvedValue(undefined)
    const mod = await import('../env-claudemd')
    regenerateEnvClaudeMdStrict = mod.regenerateEnvClaudeMdStrict
  })

  it('writes to root and worktree dirs and returns both paths', async () => {
    mockFsp.readFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
    const manifest = makeManifest({ activeWorktreeId: 'wt-99' })
    const { writtenPaths } = await regenerateEnvClaudeMdStrict(manifest)
    expect(writtenPaths).toContain('/mock/root/CLAUDE.md')
    expect(writtenPaths).toContain('/mock/worktrees/wt-99/CLAUDE.md')
    expect(mockFsp.writeFile).toHaveBeenCalledTimes(2)
  })

  it('surfaces write errors instead of swallowing them', async () => {
    mockFsp.readFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
    mockFsp.writeFile.mockRejectedValue(new Error('ENOSPC'))
    await expect(regenerateEnvClaudeMdStrict(makeManifest())).rejects.toThrow('ENOSPC')
  })

  it('returns only root path when no worktree is set', async () => {
    mockFsp.readFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
    const { writtenPaths } = await regenerateEnvClaudeMdStrict(makeManifest())
    expect(writtenPaths).toEqual(['/mock/root/CLAUDE.md'])
    expect(mockFsp.writeFile).toHaveBeenCalledTimes(1)
  })
})
