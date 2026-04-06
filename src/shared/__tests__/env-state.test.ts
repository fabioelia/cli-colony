import { describe, it, expect } from 'vitest'
import { emptyState, stateFilePath } from '../env-state'

describe('stateFilePath', () => {
  it('appends state.json to the env directory', () => {
    expect(stateFilePath('/envs/my-feature')).toBe('/envs/my-feature/state.json')
  })

  it('handles trailing slash in env directory', () => {
    // path.join normalises the trailing slash
    expect(stateFilePath('/envs/my-feature/')).toBe('/envs/my-feature/state.json')
  })
})

describe('emptyState', () => {
  it('sets envId correctly', () => {
    const state = emptyState('env-abc', ['backend'])
    expect(state.envId).toBe('env-abc')
  })

  it('creates a stopped entry for each service name', () => {
    const state = emptyState('env-abc', ['backend', 'frontend', 'worker'])
    expect(Object.keys(state.services)).toEqual(['backend', 'frontend', 'worker'])
    for (const svc of Object.values(state.services)) {
      expect(svc.status).toBe('stopped')
      expect(svc.pid).toBeNull()
      expect(svc.port).toBeNull()
      expect(svc.startedAt).toBeNull()
      expect(svc.restarts).toBe(0)
    }
  })

  it('returns empty services object for empty service list', () => {
    const state = emptyState('env-abc', [])
    expect(state.services).toEqual({})
  })

  it('sets shouldBeRunning to false', () => {
    const state = emptyState('env-abc', ['backend'])
    expect(state.shouldBeRunning).toBe(false)
  })

  it('sets updatedAt to a valid ISO timestamp', () => {
    const before = Date.now()
    const state = emptyState('env-abc', [])
    const after = Date.now()
    const ts = new Date(state.updatedAt).getTime()
    expect(ts).toBeGreaterThanOrEqual(before)
    expect(ts).toBeLessThanOrEqual(after)
  })
})
