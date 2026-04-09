import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock localStorage
const storage = new Map<string, string>()
const mockLocalStorage = {
  getItem: vi.fn((key: string) => storage.get(key) ?? null),
  setItem: vi.fn((key: string, val: string) => storage.set(key, val)),
  removeItem: vi.fn((key: string) => storage.delete(key)),
  clear: vi.fn(() => storage.clear()),
  length: 0,
  key: vi.fn(() => null),
}
Object.defineProperty(globalThis, 'localStorage', { value: mockLocalStorage })

import { loadPresets } from '../WorkspacePresets'
import type { WorkspacePreset } from '../WorkspacePresets'

describe('WorkspacePresets', () => {
  beforeEach(() => {
    storage.clear()
    vi.clearAllMocks()
  })

  describe('loadPresets', () => {
    it('returns default presets when localStorage is empty', () => {
      const presets = loadPresets()
      expect(presets).toHaveLength(3)
      expect(presets[0].name).toBe('Monitor')
      expect(presets[1].name).toBe('Review')
      expect(presets[2].name).toBe('Compare')
    })

    it('returns default presets for each call (no shared reference)', () => {
      const a = loadPresets()
      const b = loadPresets()
      expect(a).not.toBe(b)
      expect(a).toEqual(b)
    })

    it('loads saved presets from localStorage', () => {
      const custom: WorkspacePreset[] = [
        { id: 'p1', name: 'Dev', view: 'instances', layout: 'single', sidebarWidth: 320 },
      ]
      storage.set('workspace-presets', JSON.stringify(custom))
      const presets = loadPresets()
      expect(presets).toHaveLength(1)
      expect(presets[0].name).toBe('Dev')
      expect(presets[0].sidebarWidth).toBe(320)
    })

    it('returns defaults for corrupted JSON', () => {
      storage.set('workspace-presets', 'not-valid-json')
      const presets = loadPresets()
      expect(presets).toHaveLength(3) // defaults
    })

    it('returns defaults when stored value is not an array', () => {
      storage.set('workspace-presets', JSON.stringify({ name: 'bad' }))
      const presets = loadPresets()
      expect(presets).toHaveLength(3) // defaults
    })

    it('default presets have correct layout values', () => {
      const presets = loadPresets()
      expect(presets[0]).toMatchObject({ view: 'personas', layout: 'single' })
      expect(presets[1]).toMatchObject({ view: 'review', layout: 'single' })
      expect(presets[2]).toMatchObject({ view: 'instances', layout: '4-up' })
    })

    it('preserves all fields from saved presets', () => {
      const custom: WorkspacePreset[] = [
        { id: 'x1', name: 'Wide', view: 'pipelines', layout: '2-up', sidebarWidth: 450 },
      ]
      storage.set('workspace-presets', JSON.stringify(custom))
      const presets = loadPresets()
      expect(presets[0]).toEqual(custom[0])
    })
  })
})
