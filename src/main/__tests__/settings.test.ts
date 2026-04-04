/**
 * Tests for src/main/settings.ts
 *
 * The module has a module-level `_cache` variable. We use vi.resetModules()
 * + vi.doMock() + dynamic imports in beforeEach to get a fresh module per test.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const MOCK_SETTINGS_PATH = '/mock/.claude-colony/settings.json'
const MOCK_COLONY_ROOT = '/mock/.claude-colony'

// Shared mock state controlled per-test
const mockFs = {
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn().mockReturnValue('{}'),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}

const mockExecSync = vi.fn()

describe('settings module', () => {
  let mod: typeof import('../settings')

  beforeEach(async () => {
    vi.resetModules()

    // Reset mock state
    mockFs.existsSync.mockReset().mockReturnValue(false)
    mockFs.readFileSync.mockReset().mockReturnValue('{}')
    mockFs.writeFileSync.mockReset()
    mockFs.mkdirSync.mockReset()
    mockExecSync.mockReset()

    // Set up module mocks before dynamic import
    vi.doMock('electron', () => ({
      app: { getPath: vi.fn().mockReturnValue('/mock/home') },
    }))

    vi.doMock('../../shared/colony-paths', () => ({
      colonyPaths: {
        root: MOCK_COLONY_ROOT,
        settingsJson: MOCK_SETTINGS_PATH,
      },
    }))

    vi.doMock('fs', () => ({
      existsSync: mockFs.existsSync,
      readFileSync: mockFs.readFileSync,
      writeFileSync: mockFs.writeFileSync,
      mkdirSync: mockFs.mkdirSync,
    }))

    vi.doMock('child_process', () => ({
      execSync: mockExecSync,
    }))

    mod = await import('../settings')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('getSettings', () => {
    it('returns defaults when settings file does not exist', () => {
      mockFs.existsSync.mockReturnValue(false)
      const settings = mod.getSettings()
      expect(settings).toEqual({ defaultArgs: '' })
    })

    it('returns defaults when settings file exists but colony dir needs creating', () => {
      mockFs.existsSync.mockReturnValue(false)
      const settings = mod.getSettings()
      expect(settings.defaultArgs).toBe('')
    })

    it('reads and parses the settings file when it exists', () => {
      mockFs.existsSync.mockReturnValue(true)
      mockFs.readFileSync.mockReturnValue(JSON.stringify({ defaultArgs: '--verbose', theme: 'dark' }))
      const settings = mod.getSettings()
      expect(settings.defaultArgs).toBe('--verbose')
      expect(settings.theme).toBe('dark')
    })

    it('returns defaults when file is corrupted JSON', () => {
      mockFs.existsSync.mockReturnValue(true)
      mockFs.readFileSync.mockReturnValue('invalid json {{{')
      const settings = mod.getSettings()
      expect(settings).toEqual({ defaultArgs: '' })
    })

    it('caches the result on second call', () => {
      mockFs.existsSync.mockReturnValue(true)
      mockFs.readFileSync.mockReturnValue(JSON.stringify({ defaultArgs: '--model sonnet' }))
      mod.getSettings()
      mod.getSettings() // second call
      // readFileSync should only be called once (cache hit on second call)
      expect(mockFs.readFileSync).toHaveBeenCalledTimes(1)
    })
  })

  describe('getSetting', () => {
    it('returns the value for an existing key', () => {
      mockFs.existsSync.mockReturnValue(true)
      mockFs.readFileSync.mockReturnValue(JSON.stringify({ theme: 'dark' }))
      expect(mod.getSetting('theme')).toBe('dark')
    })

    it('returns empty string for a missing key', () => {
      mockFs.existsSync.mockReturnValue(false)
      expect(mod.getSetting('nonexistent')).toBe('')
    })
  })

  describe('setSetting', () => {
    it('writes updated settings to file', () => {
      mockFs.existsSync.mockReturnValue(false)
      mod.setSetting('theme', 'light')
      expect(mockFs.writeFileSync).toHaveBeenCalledWith(
        MOCK_SETTINGS_PATH,
        expect.stringContaining('"theme": "light"'),
        'utf-8'
      )
    })

    it('preserves existing settings when adding a new key', () => {
      mockFs.existsSync.mockReturnValue(true)
      mockFs.readFileSync.mockReturnValue(JSON.stringify({ defaultArgs: '--verbose' }))
      mod.setSetting('theme', 'dark')
      const written = mockFs.writeFileSync.mock.calls[0][1] as string
      const parsed = JSON.parse(written)
      expect(parsed.defaultArgs).toBe('--verbose')
      expect(parsed.theme).toBe('dark')
    })

    it('updates existing setting value', () => {
      mockFs.existsSync.mockReturnValue(true)
      mockFs.readFileSync.mockReturnValue(JSON.stringify({ defaultArgs: '--verbose' }))
      mod.setSetting('defaultArgs', '--model opus')
      const written = mockFs.writeFileSync.mock.calls[0][1] as string
      const parsed = JSON.parse(written)
      expect(parsed.defaultArgs).toBe('--model opus')
    })
  })

  describe('gitRemoteUrl', () => {
    it('returns SSH URL by default', () => {
      mockFs.existsSync.mockReturnValue(false) // no settings file → no gitProtocol set
      const url = mod.gitRemoteUrl('myorg', 'myrepo')
      expect(url).toBe('git@github.com:myorg/myrepo.git')
    })

    it('returns SSH URL when gitProtocol=ssh', () => {
      mockFs.existsSync.mockReturnValue(true)
      mockFs.readFileSync.mockReturnValue(JSON.stringify({ gitProtocol: 'ssh' }))
      const url = mod.gitRemoteUrl('acme', 'widget')
      expect(url).toBe('git@github.com:acme/widget.git')
    })

    it('returns HTTPS URL when gitProtocol=https', () => {
      mockFs.existsSync.mockReturnValue(true)
      mockFs.readFileSync.mockReturnValue(JSON.stringify({ gitProtocol: 'https' }))
      const url = mod.gitRemoteUrl('acme', 'widget')
      expect(url).toBe('https://github.com/acme/widget.git')
    })
  })

  describe('detectGitProtocol', () => {
    it('returns ssh when GitHub greets with "Hi"', () => {
      mockExecSync.mockReturnValue('Hi username! You have successfully authenticated')
      expect(mod.detectGitProtocol()).toBe('ssh')
    })

    it('returns ssh when output includes "successfully authenticated"', () => {
      mockExecSync.mockReturnValue('You have successfully authenticated, but GitHub does not provide shell access.')
      expect(mod.detectGitProtocol()).toBe('ssh')
    })

    it('returns https when output does not indicate SSH success', () => {
      mockExecSync.mockReturnValue('Permission denied (publickey).')
      expect(mod.detectGitProtocol()).toBe('https')
    })

    it('returns https when execSync throws', () => {
      mockExecSync.mockImplementation(() => { throw new Error('command failed') })
      expect(mod.detectGitProtocol()).toBe('https')
    })
  })

  describe('getDefaultArgs', () => {
    it('returns empty array when defaultArgs is not set', () => {
      mockFs.existsSync.mockReturnValue(false)
      expect(mod.getDefaultArgs()).toEqual([])
    })

    it('splits whitespace-separated args', () => {
      mockFs.existsSync.mockReturnValue(true)
      mockFs.readFileSync.mockReturnValue(JSON.stringify({ defaultArgs: '--model sonnet --verbose' }))
      expect(mod.getDefaultArgs()).toEqual(['--model', 'sonnet', '--verbose'])
    })

    it('handles multiple spaces and tabs', () => {
      mockFs.existsSync.mockReturnValue(true)
      mockFs.readFileSync.mockReturnValue(JSON.stringify({ defaultArgs: '  --foo   --bar  ' }))
      expect(mod.getDefaultArgs()).toEqual(['--foo', '--bar'])
    })

    it('returns empty array for whitespace-only defaultArgs', () => {
      mockFs.existsSync.mockReturnValue(true)
      mockFs.readFileSync.mockReturnValue(JSON.stringify({ defaultArgs: '   ' }))
      expect(mod.getDefaultArgs()).toEqual([])
    })
  })

  describe('getDefaultCliBackend', () => {
    it('returns "claude" when setting is missing', () => {
      mockFs.existsSync.mockReturnValue(false)
      expect(mod.getDefaultCliBackend()).toBe('claude')
    })

    it('returns "cursor-agent" when setting is cursor-agent', () => {
      mockFs.existsSync.mockReturnValue(true)
      mockFs.readFileSync.mockReturnValue(JSON.stringify({ defaultCliBackend: 'cursor-agent' }))
      expect(mod.getDefaultCliBackend()).toBe('cursor-agent')
    })

    it('returns "claude" for an unknown backend value', () => {
      mockFs.existsSync.mockReturnValue(true)
      mockFs.readFileSync.mockReturnValue(JSON.stringify({ defaultCliBackend: 'unknown-backend' }))
      expect(mod.getDefaultCliBackend()).toBe('claude')
    })

    it('returns "claude" for empty string', () => {
      mockFs.existsSync.mockReturnValue(true)
      mockFs.readFileSync.mockReturnValue(JSON.stringify({ defaultCliBackend: '' }))
      expect(mod.getDefaultCliBackend()).toBe('claude')
    })
  })
})
