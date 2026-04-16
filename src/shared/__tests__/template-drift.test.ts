import { describe, it, expect } from 'vitest'
import { computeDriftHash, getDriftSubset, hasDrift } from '../template-drift'
import type { EnvironmentTemplate } from '../types'

function makeTemplate(overrides: Partial<EnvironmentTemplate> = {}): EnvironmentTemplate {
  return {
    id: 'tpl-001',
    name: 'Newton',
    description: 'Newton stack',
    createdAt: '2026-01-01T00:00:00.000Z',
    projectType: 'django',
    repos: [{ owner: 'org', name: 'server', as: 'backend' }],
    services: { backend: { command: 'python manage.py runserver' } },
    ports: ['backend'],
    hooks: {},
    branches: { default: 'develop' },
    ...overrides,
  }
}

describe('computeDriftHash', () => {
  it('produces the same hash for identical templates', () => {
    const t1 = makeTemplate()
    const t2 = makeTemplate()
    expect(computeDriftHash(t1)).toBe(computeDriftHash(t2))
  })

  it('produces a different hash when services change', () => {
    const t1 = makeTemplate()
    const t2 = makeTemplate({ services: { backend: { command: 'uvicorn app:main' } } })
    expect(computeDriftHash(t1)).not.toBe(computeDriftHash(t2))
  })

  it('produces a different hash when repos change', () => {
    const t1 = makeTemplate()
    const t2 = makeTemplate({ repos: [{ owner: 'org', name: 'new-server', as: 'backend' }] })
    expect(computeDriftHash(t1)).not.toBe(computeDriftHash(t2))
  })

  it('produces the same hash when only identity/metadata fields change', () => {
    const t1 = makeTemplate()
    // id, name, description, createdAt are all excluded from drift subset
    const t2 = makeTemplate({ id: 'tpl-999', name: 'Newton (renamed)', description: 'Updated', createdAt: '2026-06-01T00:00:00.000Z' })
    expect(computeDriftHash(t1)).toBe(computeDriftHash(t2))
  })

  it('excludes machine-specific repo fields (localPath, remoteUrl)', () => {
    const t1 = makeTemplate({ repos: [{ owner: 'org', name: 'server', as: 'backend', localPath: '/old/path', remoteUrl: 'git@old' }] })
    const t2 = makeTemplate({ repos: [{ owner: 'org', name: 'server', as: 'backend', localPath: '/new/path', remoteUrl: 'git@new' }] })
    expect(computeDriftHash(t1)).toBe(computeDriftHash(t2))
  })
})

describe('hasDrift', () => {
  it('returns false when hashes match', () => {
    expect(hasDrift('abc123', 'abc123')).toBe(false)
  })

  it('returns true when hashes differ', () => {
    expect(hasDrift('abc123', 'def456')).toBe(true)
  })
})

describe('getDriftSubset', () => {
  it('excludes identity and metadata fields', () => {
    const t = makeTemplate()
    const subset = getDriftSubset(t)
    expect(subset).not.toHaveProperty('id')
    expect(subset).not.toHaveProperty('name')
    expect(subset).not.toHaveProperty('description')
    expect(subset).not.toHaveProperty('createdAt')
    expect(subset).toHaveProperty('projectType')
    expect(subset).toHaveProperty('services')
    expect(subset).toHaveProperty('repos')
  })
})
