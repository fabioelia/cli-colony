/**
 * Tests for src/main/session-wake.ts
 *
 * processWakeFile is not exported, so we test it indirectly by driving
 * startWakeWatcher() and then simulating the fs.watch callback or by
 * spying on the internal behaviour through observable side-effects
 * (createInstance calls, fsp.unlink calls, timer scheduling).
 *
 * For timer-based fire logic we expose processWakeFile via the watcher
 * callback pathway and use vi.useFakeTimers() to advance time.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const MOCK_ROOT = '/mock/.claude-colony'
const WAKE_DIR = `${MOCK_ROOT}/wake`

/** Flush pending promise chains without advancing fake timers.
 * Each await flushes one "tick" of the micro-task queue.
 * processWakeFile chains: readFile → (parse/validate) → unlink — 3 awaits covers it.
 */
async function flushPromises() {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

// ---- Shared mock state ----

const mockCreateInstance = vi.fn().mockResolvedValue('instance-123')
let watchCallback: ((event: string, filename: string | null) => void) | null = null

function buildFsMock(fileMap: Record<string, string> = {}) {
  const store: Record<string, string> = { ...fileMap }
  const statStore: Record<string, { mtimeMs: number }> = {}
  for (const p of Object.keys(fileMap)) {
    statStore[p] = { mtimeMs: Date.now() }
  }

  return {
    promises: {
      mkdir: vi.fn().mockResolvedValue(undefined),
      readdir: vi.fn().mockImplementation(async (dir: string) => {
        const prefix = dir.endsWith('/') ? dir : dir + '/'
        return Object.keys(store)
          .filter(k => k.startsWith(prefix) && !k.slice(prefix.length).includes('/'))
          .map(k => k.slice(prefix.length))
      }),
      readFile: vi.fn().mockImplementation(async (p: string) => {
        if (p in store) return store[p]
        const e = Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' })
        throw e
      }),
      unlink: vi.fn().mockImplementation(async (p: string) => {
        delete store[p]
      }),
      stat: vi.fn().mockImplementation(async (p: string) => {
        if (p in statStore) return statStore[p]
        const e = Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' })
        throw e
      }),
    },
    watch: vi.fn().mockImplementation((_dir: string, _opts: unknown, cb: typeof watchCallback) => {
      watchCallback = cb
      return { close: vi.fn() }
    }),
    existsSync: vi.fn().mockImplementation((p: string) => p in store),
    store,
    statStore,
  }
}

type FsMock = ReturnType<typeof buildFsMock>

function setupMocks(fsMock: FsMock) {
  vi.doMock('electron', () => ({ app: { getPath: vi.fn().mockReturnValue('/mock/home') } }))
  vi.doMock('../../shared/colony-paths', () => ({
    colonyPaths: { wake: WAKE_DIR },
  }))
  vi.doMock('fs', () => fsMock)
  vi.doMock('../instance-manager', () => ({ createInstance: mockCreateInstance }))
}

function makeWakeJson(overrides: Partial<{
  delay: number
  prompt: string
  workingDirectory: string
  model: string
  note: string
}> = {}): string {
  return JSON.stringify({
    delay: 120,
    prompt: 'Run the daily check',
    workingDirectory: '/work/project',
    ...overrides,
  })
}

// ---- processWakeFile — validation ----

describe('processWakeFile — validation via watcher callback', () => {
  let mod: typeof import('../session-wake')
  let fsMock: FsMock

  beforeEach(async () => {
    vi.resetModules()
    watchCallback = null
    mockCreateInstance.mockClear()
    vi.useFakeTimers()
    fsMock = buildFsMock({})
    setupMocks(fsMock)
    mod = await import('../session-wake')
    await mod.startWakeWatcher()
  })

  afterEach(async () => {
    mod.stopWakeWatcher()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('ignores non-JSON files in the watcher callback', async () => {
    const filePath = `${WAKE_DIR}/instance-abc.txt`
    fsMock.store[filePath] = makeWakeJson()
    fsMock.existsSync = vi.fn().mockReturnValue(true)

    watchCallback?.('rename', 'instance-abc.txt')
    // The watcher guard checks the extension — no async work needed
    await Promise.resolve()
    expect(mockCreateInstance).not.toHaveBeenCalled()
  })

  it('processes a valid wake file and schedules a timer', async () => {
    const filePath = `${WAKE_DIR}/instance-abc.json`
    fsMock.store[filePath] = makeWakeJson({ delay: 120 })
    fsMock.existsSync = vi.fn().mockReturnValue(true)

    watchCallback?.('rename', 'instance-abc.json')
    // Timer should not have fired yet
    expect(mockCreateInstance).not.toHaveBeenCalled()
  })

  it('fires createInstance after the specified delay elapses', async () => {
    const filePath = `${WAKE_DIR}/instance-fire.json`
    fsMock.store[filePath] = makeWakeJson({ delay: 120, prompt: 'Check health', workingDirectory: '/work/repo' })
    fsMock.existsSync = vi.fn().mockReturnValue(true)

    watchCallback?.('rename', 'instance-fire.json')
    expect(mockCreateInstance).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(120_000)
    expect(mockCreateInstance).toHaveBeenCalledOnce()
    expect(mockCreateInstance).toHaveBeenCalledWith(expect.objectContaining({
      workingDirectory: '/work/repo',
      args: expect.arrayContaining(['Check health']),
    }))
  })

  it('deletes the wake file after firing', async () => {
    const filePath = `${WAKE_DIR}/instance-del.json`
    fsMock.store[filePath] = makeWakeJson({ delay: 60 })
    fsMock.existsSync = vi.fn().mockReturnValue(true)

    watchCallback?.('rename', 'instance-del.json')
    await vi.advanceTimersByTimeAsync(60_000)

    expect(fsMock.promises.unlink).toHaveBeenCalledWith(filePath)
  })

  it('rejects delay < 60 and deletes the file', async () => {
    const filePath = `${WAKE_DIR}/instance-low.json`
    fsMock.store[filePath] = makeWakeJson({ delay: 30 })
    fsMock.existsSync = vi.fn().mockReturnValue(true)

    watchCallback?.('rename', 'instance-low.json')
    await flushPromises()

    expect(mockCreateInstance).not.toHaveBeenCalled()
    expect(fsMock.promises.unlink).toHaveBeenCalledWith(filePath)
  })

  it('rejects delay > MAX_DELAY_S (86400) and deletes the file', async () => {
    const filePath = `${WAKE_DIR}/instance-huge.json`
    fsMock.store[filePath] = makeWakeJson({ delay: 86401 })
    fsMock.existsSync = vi.fn().mockReturnValue(true)

    watchCallback?.('rename', 'instance-huge.json')
    await flushPromises()

    expect(mockCreateInstance).not.toHaveBeenCalled()
    expect(fsMock.promises.unlink).toHaveBeenCalledWith(filePath)
  })

  it('rejects missing prompt and deletes the file', async () => {
    const filePath = `${WAKE_DIR}/instance-noprompt.json`
    fsMock.store[filePath] = JSON.stringify({ delay: 120, workingDirectory: '/work' })
    fsMock.existsSync = vi.fn().mockReturnValue(true)

    watchCallback?.('rename', 'instance-noprompt.json')
    await flushPromises()

    expect(mockCreateInstance).not.toHaveBeenCalled()
    expect(fsMock.promises.unlink).toHaveBeenCalledWith(filePath)
  })

  it('rejects blank prompt and deletes the file', async () => {
    const filePath = `${WAKE_DIR}/instance-blank.json`
    fsMock.store[filePath] = makeWakeJson({ prompt: '   ' })
    fsMock.existsSync = vi.fn().mockReturnValue(true)

    watchCallback?.('rename', 'instance-blank.json')
    await flushPromises()

    expect(mockCreateInstance).not.toHaveBeenCalled()
    expect(fsMock.promises.unlink).toHaveBeenCalledWith(filePath)
  })

  it('rejects missing workingDirectory and deletes the file', async () => {
    const filePath = `${WAKE_DIR}/instance-nodir.json`
    fsMock.store[filePath] = JSON.stringify({ delay: 120, prompt: 'Check status' })
    fsMock.existsSync = vi.fn().mockReturnValue(true)

    watchCallback?.('rename', 'instance-nodir.json')
    await flushPromises()

    expect(mockCreateInstance).not.toHaveBeenCalled()
    expect(fsMock.promises.unlink).toHaveBeenCalledWith(filePath)
  })

  it('rejects blank workingDirectory and deletes the file', async () => {
    const filePath = `${WAKE_DIR}/instance-blankdir.json`
    fsMock.store[filePath] = makeWakeJson({ workingDirectory: '  ' })
    fsMock.existsSync = vi.fn().mockReturnValue(true)

    watchCallback?.('rename', 'instance-blankdir.json')
    await flushPromises()

    expect(mockCreateInstance).not.toHaveBeenCalled()
    expect(fsMock.promises.unlink).toHaveBeenCalledWith(filePath)
  })

  it('deletes file and skips on malformed JSON', async () => {
    const filePath = `${WAKE_DIR}/instance-badjson.json`
    fsMock.store[filePath] = 'not valid json { '
    fsMock.existsSync = vi.fn().mockReturnValue(true)

    watchCallback?.('rename', 'instance-badjson.json')
    await flushPromises()

    expect(mockCreateInstance).not.toHaveBeenCalled()
    expect(fsMock.promises.unlink).toHaveBeenCalledWith(filePath)
  })

  it('does nothing when file does not exist at callback time', async () => {
    // File is not added to store — existsSync returns false via real logic
    fsMock.existsSync = vi.fn().mockReturnValue(false)

    watchCallback?.('rename', 'ghost.json')
    await Promise.resolve()
    expect(mockCreateInstance).not.toHaveBeenCalled()
  })
})

// ---- MAX_PER_SESSION limit ----

describe('MAX_PER_SESSION limit', () => {
  let mod: typeof import('../session-wake')
  let fsMock: FsMock

  beforeEach(async () => {
    vi.resetModules()
    watchCallback = null
    mockCreateInstance.mockClear()
    vi.useFakeTimers()
    fsMock = buildFsMock({})
    setupMocks(fsMock)
    mod = await import('../session-wake')
    await mod.startWakeWatcher()
  })

  afterEach(() => {
    mod.stopWakeWatcher()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('allows up to 5 pending wakes for the same instanceId', async () => {
    fsMock.existsSync = vi.fn().mockReturnValue(true)

    for (let i = 0; i < 5; i++) {
      const filePath = `${WAKE_DIR}/instance-multi.json`
      fsMock.store[filePath] = makeWakeJson({ delay: 120 })
      watchCallback?.('rename', 'instance-multi.json')
      // Drain micro tasks between scheduling
      await Promise.resolve()
    }
    // 5th one should have been accepted — unlink should only have been called for over-limit ones
    const unlinkCallsForMulti = fsMock.promises.unlink.mock.calls.filter(
      c => (c[0] as string).includes('instance-multi')
    )
    expect(unlinkCallsForMulti).toHaveLength(0)
  })

  it('rejects the 6th wake for the same instanceId and deletes the file', async () => {
    fsMock.existsSync = vi.fn().mockReturnValue(true)
    const filePath = `${WAKE_DIR}/instance-overflow.json`

    for (let i = 0; i < 6; i++) {
      fsMock.store[filePath] = makeWakeJson({ delay: 120 })
      watchCallback?.('rename', 'instance-overflow.json')
      await Promise.resolve()
    }

    // The 6th attempt should trigger an unlink
    const unlinkCalls = fsMock.promises.unlink.mock.calls.filter(
      c => (c[0] as string).includes('instance-overflow')
    )
    expect(unlinkCalls.length).toBeGreaterThanOrEqual(1)
  })
})

// ---- note field ----

describe('note field in createInstance name', () => {
  let mod: typeof import('../session-wake')
  let fsMock: FsMock

  beforeEach(async () => {
    vi.resetModules()
    watchCallback = null
    mockCreateInstance.mockClear()
    vi.useFakeTimers()
    fsMock = buildFsMock({})
    setupMocks(fsMock)
    mod = await import('../session-wake')
    await mod.startWakeWatcher()
  })

  afterEach(() => {
    mod.stopWakeWatcher()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('uses "Wake: <note>" as session name when note is present', async () => {
    const filePath = `${WAKE_DIR}/instance-noted.json`
    fsMock.store[filePath] = makeWakeJson({ delay: 60, note: 'morning-checkin' })
    fsMock.existsSync = vi.fn().mockReturnValue(true)

    watchCallback?.('rename', 'instance-noted.json')
    await vi.advanceTimersByTimeAsync(60_000)

    expect(mockCreateInstance).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Wake: morning-checkin',
    }))
  })

  it('uses "Session Self-Wake" as name when no note is present', async () => {
    const filePath = `${WAKE_DIR}/instance-nonote.json`
    fsMock.store[filePath] = makeWakeJson({ delay: 60 })
    fsMock.existsSync = vi.fn().mockReturnValue(true)

    watchCallback?.('rename', 'instance-nonote.json')
    await vi.advanceTimersByTimeAsync(60_000)

    expect(mockCreateInstance).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Session Self-Wake',
    }))
  })
})

// ---- stopWakeWatcher ----

describe('stopWakeWatcher', () => {
  let mod: typeof import('../session-wake')
  let fsMock: FsMock

  beforeEach(async () => {
    vi.resetModules()
    watchCallback = null
    mockCreateInstance.mockClear()
    vi.useFakeTimers()
    fsMock = buildFsMock({})
    setupMocks(fsMock)
    mod = await import('../session-wake')
    await mod.startWakeWatcher()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('cancels pending timers so createInstance is never called after stop', async () => {
    const filePath = `${WAKE_DIR}/instance-stop.json`
    fsMock.store[filePath] = makeWakeJson({ delay: 300 })
    fsMock.existsSync = vi.fn().mockReturnValue(true)

    watchCallback?.('rename', 'instance-stop.json')
    await Promise.resolve()

    mod.stopWakeWatcher()

    await vi.advanceTimersByTimeAsync(300_000)
    expect(mockCreateInstance).not.toHaveBeenCalled()
  })

  it('can be called multiple times without throwing', () => {
    expect(() => {
      mod.stopWakeWatcher()
      mod.stopWakeWatcher()
    }).not.toThrow()
  })
})
