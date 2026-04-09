import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const mockFs = vi.hoisted(() => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => ''),
}))

const mockSpawn = vi.hoisted(() => vi.fn())

vi.mock('fs', () => mockFs)
vi.mock('child_process', () => ({
  spawn: mockSpawn,
}))
vi.mock('../../shared/colony-paths', () => ({
  colonyPaths: {
    onboardingStateJson: '/mock/.claude-colony/onboarding-state.json',
  },
}))
vi.mock('../broadcast', () => ({
  broadcast: vi.fn(),
}))

// Helper: create a fake ChildProcess
function fakeChild(code: number, stdout: string, stderr: string) {
  const handlers: Record<string, Function> = {}
  const child = {
    stdout: {
      on: vi.fn((_ev: string, cb: Function) => { if (stdout) cb(Buffer.from(stdout)) }),
    },
    stderr: {
      on: vi.fn((_ev: string, cb: Function) => { if (stderr) cb(Buffer.from(stderr)) }),
    },
    on: vi.fn((event: string, cb: Function) => { handlers[event] = cb }),
    kill: vi.fn(),
  }
  // Simulate exit
  setTimeout(() => handlers.exit?.(code), 0)
  return child
}

async function loadModule() {
  vi.resetModules()
  return await import('../prerequisites')
}

describe('prerequisites', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    mockFs.existsSync.mockReturnValue(false)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('checkClaudeCli', () => {
    it('returns ok:true when claude --version succeeds', async () => {
      mockSpawn.mockReturnValueOnce(fakeChild(0, 'claude v1.2.3', ''))
      const mod = await loadModule()
      const p = mod.checkClaudeCli()
      await vi.advanceTimersByTimeAsync(10)
      const result = await p
      expect(result.ok).toBe(true)
      expect(result.detail).toBe('claude v1.2.3')
    })

    it('returns not-found error when ENOENT in stderr', async () => {
      mockSpawn.mockReturnValueOnce(fakeChild(127, '', 'ENOENT'))
      const mod = await loadModule()
      const p = mod.checkClaudeCli()
      await vi.advanceTimersByTimeAsync(10)
      const result = await p
      expect(result.ok).toBe(false)
      expect(result.error).toContain('Not found')
    })

    it('returns timeout error when command exceeds 3s', async () => {
      // No exit — let the timer fire
      const handlers: Record<string, Function> = {}
      const child = {
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn((event: string, cb: Function) => { handlers[event] = cb }),
        kill: vi.fn(),
      }
      mockSpawn.mockReturnValueOnce(child)
      const mod = await loadModule()
      const p = mod.checkClaudeCli()
      await vi.advanceTimersByTimeAsync(3100)
      const result = await p
      expect(result.ok).toBe(false)
      expect(result.error).toContain('timed out')
    })

    it('returns not-found error when spawn throws ENOENT', async () => {
      mockSpawn.mockImplementationOnce(() => { throw new Error('spawn ENOENT') })
      const mod = await loadModule()
      const result = await mod.checkClaudeCli()
      expect(result.ok).toBe(false)
      // ENOENT is caught by runCommand → stderr contains "spawn ENOENT" →
      // checkClaudeCli maps it to the user-friendly install hint
      expect(result.error).toContain('Not found')
    })
  })

  describe('checkAnthropicAuth', () => {
    it('returns ok:true when ~/.claude/config.json exists and parses', async () => {
      mockFs.existsSync.mockImplementation((p: string) =>
        typeof p === 'string' && p.includes('config.json'))
      mockFs.readFileSync.mockReturnValue('{"key":"value"}')
      const mod = await loadModule()
      const result = mod.checkAnthropicAuth()
      expect(result.ok).toBe(true)
      expect(result.detail).toContain('config.json')
    })

    it('returns ok:true with warning when config exists but is unparseable', async () => {
      mockFs.existsSync.mockImplementation((p: string) =>
        typeof p === 'string' && p.includes('config.json'))
      mockFs.readFileSync.mockReturnValue('{broken json')
      const mod = await loadModule()
      const result = mod.checkAnthropicAuth()
      expect(result.ok).toBe(true)
      expect(result.detail).toContain('unparseable')
    })

    it('falls back to .credentials.json', async () => {
      mockFs.existsSync.mockImplementation((p: string) =>
        typeof p === 'string' && p.includes('.credentials.json'))
      mockFs.readFileSync.mockReturnValue('{"cred":true}')
      const mod = await loadModule()
      const result = mod.checkAnthropicAuth()
      expect(result.ok).toBe(true)
      expect(result.detail).toContain('.credentials.json')
    })

    it('returns ok:false when no config file exists', async () => {
      const mod = await loadModule()
      const result = mod.checkAnthropicAuth()
      expect(result.ok).toBe(false)
      expect(result.error).toContain('No Claude config')
    })
  })

  describe('checkGitConfig', () => {
    it('returns ok:true with email when git is installed and user.email is set', async () => {
      mockSpawn
        .mockReturnValueOnce(fakeChild(0, 'git version 2.40.0', ''))
        .mockReturnValueOnce(fakeChild(0, 'user@example.com\n', ''))
      const mod = await loadModule()
      const p = mod.checkGitConfig()
      await vi.advanceTimersByTimeAsync(10)
      const result = await p
      expect(result.ok).toBe(true)
      expect(result.detail).toBe('user@example.com')
    })

    it('returns error when git is not installed', async () => {
      mockSpawn.mockReturnValueOnce(fakeChild(127, '', 'ENOENT'))
      const mod = await loadModule()
      const p = mod.checkGitConfig()
      await vi.advanceTimersByTimeAsync(10)
      const result = await p
      expect(result.ok).toBe(false)
      expect(result.error).toContain('git not found')
    })

    it('returns error when user.email is not set', async () => {
      mockSpawn
        .mockReturnValueOnce(fakeChild(0, 'git version 2.40.0', ''))
        .mockReturnValueOnce(fakeChild(1, '', ''))
      const mod = await loadModule()
      const p = mod.checkGitConfig()
      await vi.advanceTimersByTimeAsync(10)
      const result = await p
      expect(result.ok).toBe(false)
      expect(result.error).toContain('user.email not set')
    })
  })

  describe('checkGitHubToken', () => {
    it('returns ok:true when github-token.txt exists with content', async () => {
      mockFs.existsSync.mockImplementation((p: string) =>
        typeof p === 'string' && p.includes('github-token.txt'))
      mockFs.readFileSync.mockReturnValue('ghp_abc123')
      const mod = await loadModule()
      const p = mod.checkGitHubToken()
      await vi.advanceTimersByTimeAsync(10)
      const result = await p
      expect(result.ok).toBe(true)
    })

    it('falls back to gh auth status', async () => {
      mockSpawn.mockReturnValueOnce(fakeChild(0, '', 'Logged in to github.com'))
      const mod = await loadModule()
      const p = mod.checkGitHubToken()
      await vi.advanceTimersByTimeAsync(10)
      const result = await p
      expect(result.ok).toBe(true)
      expect(result.detail).toContain('Logged in')
    })

    it('returns ok:false with gentle message when neither exists', async () => {
      mockSpawn.mockReturnValueOnce(fakeChild(1, '', 'not logged in'))
      const mod = await loadModule()
      const p = mod.checkGitHubToken()
      await vi.advanceTimersByTimeAsync(10)
      const result = await p
      expect(result.ok).toBe(false)
      expect(result.error).toContain('optional')
    })
  })

  describe('checkAllPrerequisites', () => {
    it('returns ready:true when claude + auth + git all pass', async () => {
      // claude --version
      mockSpawn.mockReturnValueOnce(fakeChild(0, 'claude v1.0', ''))
      // git --version
      mockSpawn.mockReturnValueOnce(fakeChild(0, 'git version 2.40.0', ''))
      // gh auth status (github check)
      mockSpawn.mockReturnValueOnce(fakeChild(0, '', 'Logged in'))
      // git config user.email
      mockSpawn.mockReturnValueOnce(fakeChild(0, 'user@example.com', ''))
      // Auth is sync (file check)
      mockFs.existsSync.mockImplementation((p: string) =>
        typeof p === 'string' && p.includes('config.json'))
      mockFs.readFileSync.mockReturnValue('{}')

      const mod = await loadModule()
      const p = mod.checkAllPrerequisites()
      await vi.advanceTimersByTimeAsync(10)
      const result = await p
      expect(result.ready).toBe(true)
      expect(result.claude.ok).toBe(true)
      expect(result.auth.ok).toBe(true)
      expect(result.git.ok).toBe(true)
      expect(result.checkedAt).toBeGreaterThan(0)
    })

    it('returns ready:false when claude CLI is missing', async () => {
      mockSpawn
        .mockReturnValueOnce(fakeChild(127, '', 'ENOENT'))
        .mockReturnValueOnce(fakeChild(0, 'git version 2.40.0', ''))
        .mockReturnValueOnce(fakeChild(1, '', ''))
        .mockReturnValueOnce(fakeChild(0, 'user@example.com', ''))
      mockFs.existsSync.mockImplementation((p: string) =>
        typeof p === 'string' && p.includes('config.json'))
      mockFs.readFileSync.mockReturnValue('{}')

      const mod = await loadModule()
      const p = mod.checkAllPrerequisites()
      await vi.advanceTimersByTimeAsync(10)
      const result = await p
      expect(result.ready).toBe(false)
      expect(result.claude.ok).toBe(false)
    })

    it('ready:true even when github is missing (it is optional)', async () => {
      mockSpawn
        .mockReturnValueOnce(fakeChild(0, 'claude v1.0', ''))
        .mockReturnValueOnce(fakeChild(0, 'git version 2.40.0', ''))
        .mockReturnValueOnce(fakeChild(1, '', 'not logged in'))
        .mockReturnValueOnce(fakeChild(0, 'user@example.com', ''))
      mockFs.existsSync.mockImplementation((p: string) =>
        typeof p === 'string' && p.includes('config.json'))
      mockFs.readFileSync.mockReturnValue('{}')

      const mod = await loadModule()
      const p = mod.checkAllPrerequisites()
      await vi.advanceTimersByTimeAsync(10)
      const result = await p
      expect(result.ready).toBe(true)
      expect(result.github.ok).toBe(false)
    })
  })
})
