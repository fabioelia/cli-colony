import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { InstanceManifest } from '../../daemon/env-protocol'

const mockFsp = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFile: vi.fn().mockResolvedValue(undefined),
}))

function setupMocks(): void {
  vi.doMock('fs', () => ({ promises: mockFsp }))
  vi.doMock('../../shared/colony-paths', () => ({
    colonyPaths: { worktreeDir: (id: string) => `/mock/worktrees/${id}` },
  }))
}

function makeManifest(overrides: Partial<InstanceManifest> = {}): InstanceManifest {
  return {
    version: 2,
    id: 'test-id',
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

describe('generateEnvClaudeMd', () => {
  let generateEnvClaudeMd: (manifest: InstanceManifest) => Promise<void>

  beforeEach(async () => {
    vi.resetModules()
    vi.resetAllMocks()
    setupMocks()
    mockFsp.writeFile.mockResolvedValue(undefined)
    const mod = await import('../env-claudemd')
    generateEnvClaudeMd = mod.generateEnvClaudeMd
  })

  it('writes generated content with markers when no file exists', async () => {
    mockFsp.readFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))

    await generateEnvClaudeMd(makeManifest())

    expect(mockFsp.writeFile).toHaveBeenCalledTimes(1)
    const [, written] = mockFsp.writeFile.mock.calls[0]
    expect(written).toContain('COLONY:AUTO-START')
    expect(written).toContain('COLONY:AUTO-END')
    expect(written).toContain('# Environment: Test Env')
  })

  it('replaces auto block without touching content outside markers', async () => {
    // Capture the generated format (with real marker strings) via a fresh write
    mockFsp.readFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
    await generateEnvClaudeMd(makeManifest({ displayName: 'Old Env' }))
    const oldGenerated = mockFsp.writeFile.mock.calls[0][1] as string
    vi.clearAllMocks()
    mockFsp.writeFile.mockResolvedValue(undefined)

    // Surround the auto block with user-edited content
    const existing = `my prefix\n\n${oldGenerated}\n\nmy suffix`
    mockFsp.readFile.mockResolvedValue(existing)

    await generateEnvClaudeMd(makeManifest({ displayName: 'New Env' }))

    const [, written] = mockFsp.writeFile.mock.calls[0]
    expect(written).toContain('my prefix')
    expect(written).toContain('my suffix')
    expect(written).not.toContain('# Environment: Old Env')
    expect(written).toContain('# Environment: New Env')
  })

  it('prepends block above existing content when file has no markers', async () => {
    mockFsp.readFile.mockResolvedValue('# Existing Docs\n\nsome user content')

    await generateEnvClaudeMd(makeManifest())

    const [, written] = mockFsp.writeFile.mock.calls[0]
    expect(written).toContain('COLONY:AUTO-START')
    expect(written).toContain('# Existing Docs')
    // Auto block must come before the existing content
    expect(written.indexOf('COLONY:AUTO-START')).toBeLessThan(written.indexOf('# Existing Docs'))
  })

  it('skips write when content is unchanged (idempotent)', async () => {
    // First call: no file → write
    mockFsp.readFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
    await generateEnvClaudeMd(makeManifest())
    const firstWritten = mockFsp.writeFile.mock.calls[0][1] as string

    vi.clearAllMocks()
    mockFsp.writeFile.mockResolvedValue(undefined)

    // Second call: file already has identical content → no write
    mockFsp.readFile.mockResolvedValue(firstWritten)
    await generateEnvClaudeMd(makeManifest())
    expect(mockFsp.writeFile).not.toHaveBeenCalled()
  })
})
