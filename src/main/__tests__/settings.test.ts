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
const mockFsp = {
  readFile: vi.fn().mockResolvedValue('{}'),
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
}

const mockExecFile = vi.fn()

describe('settings module', () => {
  let mod: typeof import('../settings')

  beforeEach(async () => {
    vi.resetModules()

    // Reset mock state
    mockFsp.readFile.mockReset().mockResolvedValue('{}')
    mockFsp.writeFile.mockReset().mockResolvedValue(undefined)
    mockFsp.mkdir.mockReset().mockResolvedValue(undefined)
    mockExecFile.mockReset()

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
      promises: mockFsp,
    }))

    vi.doMock('child_process', () => ({
      execFile: mockExecFile,
    }))

    mod = await import('../settings')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('getSettings', () => {
    it('returns defaults when settings file does not exist', async () => {
      mockFsp.readFile.mockRejectedValue(new Error('ENOENT'))
      const settings = await mod.getSettings()
      expect(settings).toEqual({ defaultArgs: '' })
    })

    it('returns defaults when settings file exists but colony dir needs creating', async () => {
      mockFsp.readFile.mockRejectedValue(new Error('ENOENT'))
      const settings = await mod.getSettings()
      expect(settings.defaultArgs).toBe('')
    })

    it('reads and parses the settings file when it exists', async () => {
      mockFsp.readFile.mockResolvedValue(JSON.stringify({ defaultArgs: '--verbose', theme: 'dark' }))
      const settings = await mod.getSettings()
      expect(settings.defaultArgs).toBe('--verbose')
      expect(settings.theme).toBe('dark')
    })

    it('returns defaults when file is corrupted JSON', async () => {
      mockFsp.readFile.mockResolvedValue('invalid json {{{')
      const settings = await mod.getSettings()
      expect(settings).toEqual({ defaultArgs: '' })
    })

    it('caches the result on second call', async () => {
      mockFsp.readFile.mockResolvedValue(JSON.stringify({ defaultArgs: '--model sonnet' }))
      await mod.getSettings()
      await mod.getSettings() // second call
      // readFile should only be called once (cache hit on second call)
      expect(mockFsp.readFile).toHaveBeenCalledTimes(1)
    })
  })

  describe('getSetting', () => {
    it('returns the value for an existing key', async () => {
      mockFsp.readFile.mockResolvedValue(JSON.stringify({ theme: 'dark' }))
      expect(await mod.getSetting('theme')).toBe('dark')
    })

    it('returns empty string for a missing key', async () => {
      mockFsp.readFile.mockRejectedValue(new Error('ENOENT'))
      expect(await mod.getSetting('nonexistent')).toBe('')
    })
  })

  describe('setSetting', () => {
    it('writes updated settings to file', async () => {
      mockFsp.readFile.mockRejectedValue(new Error('ENOENT'))
      await mod.setSetting('theme', 'light')
      expect(mockFsp.writeFile).toHaveBeenCalledWith(
        MOCK_SETTINGS_PATH,
        expect.stringContaining('"theme": "light"'),
        'utf-8'
      )
    })

    it('preserves existing settings when adding a new key', async () => {
      mockFsp.readFile.mockResolvedValue(JSON.stringify({ defaultArgs: '--verbose' }))
      await mod.setSetting('theme', 'dark')
      const written = mockFsp.writeFile.mock.calls[0][1] as string
      const parsed = JSON.parse(written)
      expect(parsed.defaultArgs).toBe('--verbose')
      expect(parsed.theme).toBe('dark')
    })

    it('updates existing setting value', async () => {
      mockFsp.readFile.mockResolvedValue(JSON.stringify({ defaultArgs: '--verbose' }))
      await mod.setSetting('defaultArgs', '--model opus')
      const written = mockFsp.writeFile.mock.calls[0][1] as string
      const parsed = JSON.parse(written)
      expect(parsed.defaultArgs).toBe('--model opus')
    })
  })

  describe('gitRemoteUrl', () => {
    it('returns SSH URL by default', async () => {
      mockFsp.readFile.mockRejectedValue(new Error('ENOENT')) // no settings file → no gitProtocol set
      const url = await mod.gitRemoteUrl('myorg', 'myrepo')
      expect(url).toBe('git@github.com:myorg/myrepo.git')
    })

    it('returns SSH URL when gitProtocol=ssh', async () => {
      mockFsp.readFile.mockResolvedValue(JSON.stringify({ gitProtocol: 'ssh' }))
      const url = await mod.gitRemoteUrl('acme', 'widget')
      expect(url).toBe('git@github.com:acme/widget.git')
    })

    it('returns HTTPS URL when gitProtocol=https', async () => {
      mockFsp.readFile.mockResolvedValue(JSON.stringify({ gitProtocol: 'https' }))
      const url = await mod.gitRemoteUrl('acme', 'widget')
      expect(url).toBe('https://github.com/acme/widget.git')
    })
  })

  describe('detectGitProtocol', () => {
    it('returns ssh when GitHub greets with "Hi"', async () => {
      mockExecFile.mockImplementation((cmd: string, args: string[], opts: any, cb: Function) => {
        cb(null, 'Hi username! You have successfully authenticated', '')
      })
      expect(await mod.detectGitProtocol()).toBe('ssh')
    })

    it('returns ssh when output includes "successfully authenticated"', async () => {
      mockExecFile.mockImplementation((cmd: string, args: string[], opts: any, cb: Function) => {
        cb(null, '', 'You have successfully authenticated, but GitHub does not provide shell access.')
      })
      expect(await mod.detectGitProtocol()).toBe('ssh')
    })

    it('returns https when output does not indicate SSH success', async () => {
      mockExecFile.mockImplementation((cmd: string, args: string[], opts: any, cb: Function) => {
        cb(null, 'Permission denied (publickey).', '')
      })
      expect(await mod.detectGitProtocol()).toBe('https')
    })

    it('returns https when execFile throws', async () => {
      mockExecFile.mockImplementation((cmd: string, args: string[], opts: any, cb: Function) => {
        cb(new Error('command failed'), '', '')
      })
      expect(await mod.detectGitProtocol()).toBe('https')
    })
  })

  describe('getDefaultArgs', () => {
    it('returns empty array when defaultArgs is not set', async () => {
      mockFsp.readFile.mockRejectedValue(new Error('ENOENT'))
      expect(await mod.getDefaultArgs()).toEqual([])
    })

    it('splits whitespace-separated args', async () => {
      mockFsp.readFile.mockResolvedValue(JSON.stringify({ defaultArgs: '--model sonnet --verbose' }))
      expect(await mod.getDefaultArgs()).toEqual(['--model', 'sonnet', '--verbose'])
    })

    it('handles multiple spaces and tabs', async () => {
      mockFsp.readFile.mockResolvedValue(JSON.stringify({ defaultArgs: '  --foo   --bar  ' }))
      expect(await mod.getDefaultArgs()).toEqual(['--foo', '--bar'])
    })

    it('returns empty array for whitespace-only defaultArgs', async () => {
      mockFsp.readFile.mockResolvedValue(JSON.stringify({ defaultArgs: '   ' }))
      expect(await mod.getDefaultArgs()).toEqual([])
    })
  })

  describe('getDefaultCliBackend', () => {
    it('returns "claude" when setting is missing', async () => {
      mockFsp.readFile.mockRejectedValue(new Error('ENOENT'))
      expect(await mod.getDefaultCliBackend()).toBe('claude')
    })

    it('returns "cursor-agent" when setting is cursor-agent', async () => {
      mockFsp.readFile.mockResolvedValue(JSON.stringify({ defaultCliBackend: 'cursor-agent' }))
      expect(await mod.getDefaultCliBackend()).toBe('cursor-agent')
    })

    it('returns "claude" for an unknown backend value', async () => {
      mockFsp.readFile.mockResolvedValue(JSON.stringify({ defaultCliBackend: 'unknown-backend' }))
      expect(await mod.getDefaultCliBackend()).toBe('claude')
    })

    it('returns "claude" for empty string', async () => {
      mockFsp.readFile.mockResolvedValue(JSON.stringify({ defaultCliBackend: '' }))
      expect(await mod.getDefaultCliBackend()).toBe('claude')
    })
  })
})
