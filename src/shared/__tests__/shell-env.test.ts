/**
 * Tests for src/shared/shell-env.ts
 *
 * Tests: getShellCandidates (via loadShellEnv side-effects), env line parsing,
 * fallback chain (full env → PATH-only → process.env), and cache behavior.
 *
 * Uses vi.resetModules() + vi.doMock() + dynamic import per test to reset
 * the module-level _cachedEnv between test groups.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const MOCK_SETTINGS_PATH = '/mock/.claude-colony/settings.json'
const ORIG_SHELL = process.env.SHELL

const mockFs = {
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn().mockReturnValue('{}'),
}

const mockExecSync = vi.fn()

describe('shell-env', () => {
  let mod: typeof import('../shell-env')

  beforeEach(async () => {
    vi.resetModules()
    mockFs.existsSync.mockReset().mockReturnValue(false)
    mockFs.readFileSync.mockReset().mockReturnValue('{}')
    mockExecSync.mockReset()
    // Set deterministic value so tests don't depend on the CI environment
    process.env.SHELL = '/bin/bash'

    vi.doMock('fs', () => ({ ...mockFs }))
    vi.doMock('child_process', () => ({ execSync: mockExecSync }))
    vi.doMock('../colony-paths', () => ({
      colonyPaths: { settingsJson: MOCK_SETTINGS_PATH },
    }))

    mod = await import('../shell-env')
  })

  afterEach(() => {
    process.env.SHELL = ORIG_SHELL
  })

  // ---------------------------------------------------------------------------
  // Env line parsing
  // ---------------------------------------------------------------------------

  describe('env line parsing', () => {
    it('parses KEY=VALUE lines and returns merged env', () => {
      mockExecSync.mockReturnValue('PATH=/custom/bin:/usr/bin\nHOME=/home/user\n')

      const result = mod.loadShellEnv()

      expect(result.PATH).toBe('/custom/bin:/usr/bin')
      expect(result.HOME).toBe('/home/user')
    })

    it('preserves = signs inside values (e.g. URL with query params)', () => {
      mockExecSync.mockReturnValue('URL=https://example.com?foo=bar&baz=qux\n')

      const result = mod.loadShellEnv()

      expect(result.URL).toBe('https://example.com?foo=bar&baz=qux')
    })

    it('skips lines with no = sign', () => {
      mockExecSync.mockReturnValue('VALID=yes\nNO_EQUALS_HERE\n')

      const result = mod.loadShellEnv()

      expect(result.VALID).toBe('yes')
      expect('NO_EQUALS_HERE' in result).toBe(false)
    })

    it('skips lines starting with = (idx === 0 is not > 0)', () => {
      mockExecSync.mockReturnValue('GOOD=ok\n=SKIP\n')

      const result = mod.loadShellEnv()

      expect(result.GOOD).toBe('ok')
      expect(result['']).toBeUndefined()
    })

    it('skips empty lines', () => {
      mockExecSync.mockReturnValue('FOO=bar\n\n\nBAZ=qux\n')

      const result = mod.loadShellEnv()

      expect(result.FOO).toBe('bar')
      expect(result.BAZ).toBe('qux')
    })

    it('merges shell output on top of process.env', () => {
      process.env.EXISTING_VAR = 'original'
      mockExecSync.mockReturnValue('EXISTING_VAR=overridden\nNEW_VAR=new\n')

      const result = mod.loadShellEnv()

      expect(result.EXISTING_VAR).toBe('overridden')
      expect(result.NEW_VAR).toBe('new')

      delete process.env.EXISTING_VAR
    })
  })

  // ---------------------------------------------------------------------------
  // Fallback chain
  // ---------------------------------------------------------------------------

  describe('fallback chain', () => {
    it('uses full env dump from first shell when it succeeds', () => {
      mockExecSync.mockReturnValue('WINNER=full-env\n')

      const result = mod.loadShellEnv()

      expect(result.WINNER).toBe('full-env')
    })

    it('falls back to PATH-only when full env dump fails', () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes('"env"')) throw new Error('env failed')
        if (cmd.includes('echo $PATH')) return '/custom/bin:/usr/bin\n'
        throw new Error(`unexpected: ${cmd}`)
      })

      const result = mod.loadShellEnv()

      expect(result.PATH).toBe('/custom/bin:/usr/bin')
    })

    it('trims trailing newline in PATH fallback', () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes('"env"')) throw new Error('fail')
        if (cmd.includes('echo $PATH')) return '/usr/bin\n'
        throw new Error(`unexpected: ${cmd}`)
      })

      const result = mod.loadShellEnv()

      expect(result.PATH).toBe('/usr/bin')
    })

    it('falls back to process.env when all shells fail', () => {
      mockExecSync.mockImplementation(() => { throw new Error('all shells broken') })

      const result = mod.loadShellEnv()

      // Should still have process.env vars
      expect(result.SHELL).toBe('/bin/bash')
    })

    it('tries next shell when first shell fails entirely', () => {
      process.env.SHELL = '/usr/local/bin/fish'
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.startsWith('/usr/local/bin/fish')) throw new Error('fish failed')
        if (cmd.startsWith('/bin/zsh') && cmd.includes('"env"')) return 'ZSH_WIN=yes\n'
        throw new Error(`unexpected: ${cmd}`)
      })

      const result = mod.loadShellEnv()

      expect(result.ZSH_WIN).toBe('yes')
    })
  })

  // ---------------------------------------------------------------------------
  // Cache behavior
  // ---------------------------------------------------------------------------

  describe('cache', () => {
    it('returns same reference on second call', () => {
      mockExecSync.mockReturnValue('X=1\n')

      const first = mod.loadShellEnv()
      const second = mod.loadShellEnv()

      expect(first).toBe(second)
    })

    it('calls execSync only once when cached', () => {
      mockExecSync.mockReturnValue('X=1\n')

      mod.loadShellEnv()
      mod.loadShellEnv()
      mod.loadShellEnv()

      expect(mockExecSync).toHaveBeenCalledTimes(1)
    })
  })

  // ---------------------------------------------------------------------------
  // getShellCandidates via shellProfile settings
  // ---------------------------------------------------------------------------

  describe('shell candidate selection', () => {
    it('uses process.env.SHELL as first candidate by default', () => {
      process.env.SHELL = '/usr/local/bin/fish'
      const calls: string[] = []
      mockExecSync.mockImplementation((cmd: string) => {
        calls.push(cmd)
        if (cmd.startsWith('/usr/local/bin/fish') && cmd.includes('"env"')) return 'FISH=yes\n'
        throw new Error('unexpected')
      })

      const result = mod.loadShellEnv()

      expect(result.FISH).toBe('yes')
      expect(calls[0]).toContain('/usr/local/bin/fish')
    })

    it('uses /bin/zsh and /bin/bash when shellProfile is "login"', () => {
      mockFs.existsSync.mockReturnValue(true)
      mockFs.readFileSync.mockReturnValue(JSON.stringify({ shellProfile: 'login' }))
      const calls: string[] = []
      mockExecSync.mockImplementation((cmd: string) => {
        calls.push(cmd)
        if (cmd.startsWith('/bin/zsh') && cmd.includes('"env"')) return 'ZSH=yes\n'
        throw new Error('unexpected')
      })

      const result = mod.loadShellEnv()

      expect(result.ZSH).toBe('yes')
      expect(calls[0]).toContain('/bin/zsh')
      // Ensure process.env.SHELL (/bin/bash) was NOT tried first
      expect(calls[0]).not.toContain('/bin/bash')
    })

    it('uses custom shellProfile path as first candidate', () => {
      mockFs.existsSync.mockReturnValue(true)
      mockFs.readFileSync.mockReturnValue(JSON.stringify({ shellProfile: '/opt/homebrew/bin/zsh' }))
      const calls: string[] = []
      mockExecSync.mockImplementation((cmd: string) => {
        calls.push(cmd)
        if (cmd.startsWith('/opt/homebrew/bin/zsh') && cmd.includes('"env"')) return 'BREW=yes\n'
        throw new Error('unexpected')
      })

      const result = mod.loadShellEnv()

      expect(result.BREW).toBe('yes')
      expect(calls[0]).toContain('/opt/homebrew/bin/zsh')
    })

    it('deduplicates when process.env.SHELL is already /bin/zsh', () => {
      process.env.SHELL = '/bin/zsh'
      const envCalls: string[] = []
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes('"env"')) { envCalls.push(cmd); return 'DEDUP=yes\n' }
        throw new Error('unexpected')
      })

      mod.loadShellEnv()

      // /bin/zsh only tried once (not twice) due to dedup
      expect(envCalls.filter(c => c.startsWith('/bin/zsh'))).toHaveLength(1)
    })

    it('falls back to /bin/bash when /bin/zsh fails', () => {
      process.env.SHELL = '/bin/zsh'
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.startsWith('/bin/zsh')) throw new Error('zsh broken')
        if (cmd.startsWith('/bin/bash') && cmd.includes('"env"')) return 'BASH=yes\n'
        throw new Error('unexpected')
      })

      const result = mod.loadShellEnv()

      expect(result.BASH).toBe('yes')
    })

    it('handles missing settings file by using default shell', () => {
      mockFs.existsSync.mockReturnValue(false)
      mockExecSync.mockReturnValue('DEFAULT=yes\n')

      const result = mod.loadShellEnv()

      expect(result.DEFAULT).toBe('yes')
    })

    it('handles malformed settings JSON by using default shell', () => {
      mockFs.existsSync.mockReturnValue(true)
      mockFs.readFileSync.mockReturnValue('{ not valid json }')
      mockExecSync.mockReturnValue('MALFORMED_OK=yes\n')

      const result = mod.loadShellEnv()

      expect(result.MALFORMED_OK).toBe('yes')
    })
  })
})
