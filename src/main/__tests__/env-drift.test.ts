/**
 * Tests for env-drift.ts — getEnvDriftStatus with lazy baseline migration.
 *
 * Mocks: env-manager (getManifest, getTemplate), template-drift (computeDriftHash),
 *        fs (fsp.writeFile for lazy migration writes).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---- Hoisted mocks ----
const mockGetManifest = vi.hoisted(() => vi.fn())
const mockGetTemplate = vi.hoisted(() => vi.fn())
const mockComputeDriftHash = vi.hoisted(() => vi.fn())
const mockWriteFile = vi.hoisted(() => vi.fn(async () => undefined))

vi.mock('../env-manager', () => ({
  getManifest: mockGetManifest,
  getTemplate: mockGetTemplate,
}))

vi.mock('../../shared/template-drift', () => ({
  computeDriftHash: mockComputeDriftHash,
  hasDrift: (a: string, b: string) => a !== b,
}))

vi.mock('fs', () => ({
  promises: { writeFile: mockWriteFile },
}))

import { getEnvDriftStatus } from '../env-drift'

const TEMPLATE = { id: 'tpl-1', name: 'Newton', projectType: 'django', services: {}, repos: [], createdAt: '2026-01-01' }

function makeManifest(metaOverrides: Record<string, unknown> = {}) {
  return {
    id: 'env-1',
    name: 'my-env',
    services: {},
    ports: {},
    paths: { root: '/envs/my-env' },
    meta: { templateId: 'tpl-1', templateName: 'Newton', ...metaOverrides },
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  mockComputeDriftHash.mockReturnValue('hash-abc123')
})

describe('getEnvDriftStatus', () => {
  it('returns unknown when manifest not found', async () => {
    mockGetManifest.mockResolvedValue(null)
    expect(await getEnvDriftStatus('env-1')).toBe('unknown')
  })

  it('returns unknown when env has no templateId', async () => {
    mockGetManifest.mockResolvedValue({ ...makeManifest(), meta: {} })
    expect(await getEnvDriftStatus('env-1')).toBe('unknown')
  })

  it('returns unknown when template not found', async () => {
    mockGetManifest.mockResolvedValue(makeManifest())
    mockGetTemplate.mockResolvedValue(null)
    expect(await getEnvDriftStatus('env-1')).toBe('unknown')
  })

  it('returns clean when baseline matches current hash', async () => {
    mockGetManifest.mockResolvedValue(makeManifest({ templateBaseline: 'hash-abc123' }))
    mockGetTemplate.mockResolvedValue(TEMPLATE)
    expect(await getEnvDriftStatus('env-1')).toBe('clean')
  })

  it('returns drifted when baseline differs from current hash', async () => {
    mockGetManifest.mockResolvedValue(makeManifest({ templateBaseline: 'old-hash-999' }))
    mockGetTemplate.mockResolvedValue(TEMPLATE)
    expect(await getEnvDriftStatus('env-1')).toBe('drifted')
  })

  it('lazy migration: writes baseline and returns clean when baseline missing', async () => {
    // No templateBaseline in meta
    mockGetManifest.mockResolvedValue(makeManifest())
    mockGetTemplate.mockResolvedValue(TEMPLATE)

    const status = await getEnvDriftStatus('env-1')
    expect(status).toBe('clean')

    // Should have written the manifest with the new baseline
    expect(mockWriteFile).toHaveBeenCalledOnce()
    const writtenContent = JSON.parse(mockWriteFile.mock.calls[0][1] as string)
    expect(writtenContent.meta.templateBaseline).toBe('hash-abc123')
  })
})
