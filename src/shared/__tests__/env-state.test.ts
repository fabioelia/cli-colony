/**
 * Tests for src/shared/env-state.ts
 *
 * Uses real temp directories for fs operations (no fs mocking needed).
 * Uses vi.spyOn(process, 'kill') to control isPidAlive behaviour.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  stateFilePath,
  readState,
  writeState,
  isPidAlive,
  emptyState,
  readAndReconcileState,
} from '../env-state'
import type { EnvState } from '../env-state'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-state-test-'))
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function makeState(overrides: Partial<EnvState> = {}): EnvState {
  return {
    envId: 'env-test',
    services: {},
    shouldBeRunning: false,
    updatedAt: new Date().toISOString(),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// stateFilePath
// ---------------------------------------------------------------------------

describe('stateFilePath', () => {
  it('appends state.json to the env directory', () => {
    expect(stateFilePath('/envs/my-feature')).toBe('/envs/my-feature/state.json')
  })

  it('handles trailing slash in env directory', () => {
    expect(stateFilePath('/envs/my-feature/')).toBe('/envs/my-feature/state.json')
  })

  it('works with a relative directory', () => {
    expect(stateFilePath('envs/abc')).toBe(path.join('envs/abc', 'state.json'))
  })
})

// ---------------------------------------------------------------------------
// readState
// ---------------------------------------------------------------------------

describe('readState', () => {
  it('returns null when the directory does not contain state.json', () => {
    expect(readState(tmpDir)).toBeNull()
  })

  it('returns parsed state when state.json is valid', () => {
    const state = makeState({ envId: 'env-read' })
    fs.writeFileSync(path.join(tmpDir, 'state.json'), JSON.stringify(state), 'utf-8')

    const result = readState(tmpDir)

    expect(result).not.toBeNull()
    expect(result!.envId).toBe('env-read')
  })

  it('returns null when state.json contains corrupt JSON', () => {
    fs.writeFileSync(path.join(tmpDir, 'state.json'), '{ not valid json !!!', 'utf-8')

    expect(readState(tmpDir)).toBeNull()
  })

  it('returns null when state.json is completely empty', () => {
    fs.writeFileSync(path.join(tmpDir, 'state.json'), '', 'utf-8')

    expect(readState(tmpDir)).toBeNull()
  })

  it('preserves all fields from the JSON file', () => {
    const state = makeState({
      envId: 'env-fields',
      shouldBeRunning: true,
      services: {
        backend: { status: 'running', pid: 1234, port: 8080, startedAt: 1000, restarts: 2 },
      },
    })
    fs.writeFileSync(path.join(tmpDir, 'state.json'), JSON.stringify(state), 'utf-8')

    const result = readState(tmpDir)!

    expect(result.envId).toBe('env-fields')
    expect(result.shouldBeRunning).toBe(true)
    expect(result.services.backend.status).toBe('running')
    expect(result.services.backend.pid).toBe(1234)
    expect(result.services.backend.restarts).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// writeState
// ---------------------------------------------------------------------------

describe('writeState', () => {
  it('writes a JSON file to the correct path', () => {
    const state = makeState({ envId: 'env-write' })

    writeState(tmpDir, state)

    const filePath = path.join(tmpDir, 'state.json')
    expect(fs.existsSync(filePath)).toBe(true)
  })

  it('writes valid JSON that can be read back', () => {
    const state = makeState({ envId: 'env-roundtrip' })

    writeState(tmpDir, state)

    const raw = fs.readFileSync(path.join(tmpDir, 'state.json'), 'utf-8')
    const parsed = JSON.parse(raw)
    expect(parsed.envId).toBe('env-roundtrip')
  })

  it('sets updatedAt to a recent ISO timestamp', () => {
    const before = Date.now()
    const state = makeState()

    writeState(tmpDir, state)

    const after = Date.now()
    const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, 'state.json'), 'utf-8'))
    const written = new Date(raw.updatedAt).getTime()
    expect(written).toBeGreaterThanOrEqual(before)
    expect(written).toBeLessThanOrEqual(after)
  })

  it('mutates updatedAt on the passed-in state object', () => {
    const state = makeState()
    // Freeze updatedAt to a known value in the past so the write is guaranteed to differ
    state.updatedAt = '1970-01-01T00:00:00.000Z'

    writeState(tmpDir, state)

    expect(state.updatedAt).not.toBe('1970-01-01T00:00:00.000Z')
    expect(new Date(state.updatedAt).getFullYear()).toBeGreaterThan(2020)
  })

  it('formats the JSON with 2-space indentation', () => {
    const state = makeState()

    writeState(tmpDir, state)

    const raw = fs.readFileSync(path.join(tmpDir, 'state.json'), 'utf-8')
    expect(raw).toContain('\n  ')
  })

  it('overwrites an existing state.json without error', () => {
    const state1 = makeState({ envId: 'env-first' })
    const state2 = makeState({ envId: 'env-second' })

    writeState(tmpDir, state1)
    writeState(tmpDir, state2)

    const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, 'state.json'), 'utf-8'))
    expect(raw.envId).toBe('env-second')
  })

  it('handles write errors gracefully without throwing', () => {
    // Point at a path where the parent directory does not exist
    const badDir = path.join(tmpDir, 'no-such-dir')
    const state = makeState()

    // Should not throw even though the directory is missing
    expect(() => writeState(badDir, state)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// isPidAlive
// ---------------------------------------------------------------------------

describe('isPidAlive', () => {
  it('returns true when process.kill(pid, 0) succeeds', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => true as never)

    expect(isPidAlive(1234)).toBe(true)
  })

  it('returns false when process.kill(pid, 0) throws', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('ESRCH')
    })

    expect(isPidAlive(9999)).toBe(false)
  })

  it('calls process.kill with the given pid and signal 0', () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true as never)

    isPidAlive(4242)

    expect(killSpy).toHaveBeenCalledWith(4242, 0)
  })
})

// ---------------------------------------------------------------------------
// emptyState
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// readAndReconcileState
// ---------------------------------------------------------------------------

describe('readAndReconcileState', () => {
  it('returns null when there is no state.json', () => {
    expect(readAndReconcileState(tmpDir)).toBeNull()
  })

  it('returns the state unchanged when all running services have live PIDs', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => true as never)

    const state = makeState({
      services: {
        backend: { status: 'running', pid: 100, port: 8080, startedAt: 1000, restarts: 0 },
      },
    })
    fs.writeFileSync(path.join(tmpDir, 'state.json'), JSON.stringify(state), 'utf-8')

    const result = readAndReconcileState(tmpDir)!

    expect(result.services.backend.status).toBe('running')
    expect(result.services.backend.pid).toBe(100)
  })

  it('does not rewrite state.json when nothing changed', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => true as never)

    const state = makeState({
      services: {
        backend: { status: 'running', pid: 100, port: 8080, startedAt: 1000, restarts: 0 },
      },
    })
    const filePath = path.join(tmpDir, 'state.json')
    fs.writeFileSync(filePath, JSON.stringify(state), 'utf-8')
    const mtimeBefore = fs.statSync(filePath).mtimeMs

    readAndReconcileState(tmpDir)

    // File should not have been touched
    const mtimeAfter = fs.statSync(filePath).mtimeMs
    expect(mtimeAfter).toBe(mtimeBefore)
  })

  it('marks a running service as crashed when its PID is dead', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('ESRCH')
    })

    const state = makeState({
      services: {
        backend: { status: 'running', pid: 999, port: 8080, startedAt: 1000, restarts: 0 },
      },
    })
    fs.writeFileSync(path.join(tmpDir, 'state.json'), JSON.stringify(state), 'utf-8')

    const result = readAndReconcileState(tmpDir)!

    expect(result.services.backend.status).toBe('crashed')
    expect(result.services.backend.pid).toBeNull()
  })

  it('writes the updated state back to disk when a crash is detected', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('ESRCH')
    })

    const state = makeState({
      services: {
        backend: { status: 'running', pid: 999, port: 8080, startedAt: 1000, restarts: 0 },
      },
    })
    fs.writeFileSync(path.join(tmpDir, 'state.json'), JSON.stringify(state), 'utf-8')

    readAndReconcileState(tmpDir)

    const onDisk = JSON.parse(fs.readFileSync(path.join(tmpDir, 'state.json'), 'utf-8'))
    expect(onDisk.services.backend.status).toBe('crashed')
    expect(onDisk.services.backend.pid).toBeNull()
  })

  it('handles multiple services — marks only the dead ones as crashed', () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid) => {
      if (pid === 200) throw new Error('ESRCH') // dead
      return true as never // alive
    })

    const state = makeState({
      services: {
        backend: { status: 'running', pid: 100, port: 8080, startedAt: 1000, restarts: 0 },
        worker: { status: 'running', pid: 200, port: null, startedAt: 1000, restarts: 1 },
      },
    })
    fs.writeFileSync(path.join(tmpDir, 'state.json'), JSON.stringify(state), 'utf-8')

    const result = readAndReconcileState(tmpDir)!

    expect(result.services.backend.status).toBe('running')
    expect(result.services.backend.pid).toBe(100)
    expect(result.services.worker.status).toBe('crashed')
    expect(result.services.worker.pid).toBeNull()

    void killSpy
  })

  it('does not reconcile services with status "stopped" even if they have a PID', () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true as never)

    const state = makeState({
      services: {
        backend: { status: 'stopped', pid: 500, port: null, startedAt: null, restarts: 0 },
      },
    })
    fs.writeFileSync(path.join(tmpDir, 'state.json'), JSON.stringify(state), 'utf-8')

    const result = readAndReconcileState(tmpDir)!

    // status should remain 'stopped', kill should not have been called
    expect(result.services.backend.status).toBe('stopped')
    expect(killSpy).not.toHaveBeenCalled()
  })

  it('does not reconcile services with status "starting" even if they have a PID', () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true as never)

    const state = makeState({
      services: {
        backend: { status: 'starting', pid: 501, port: null, startedAt: null, restarts: 0 },
      },
    })
    fs.writeFileSync(path.join(tmpDir, 'state.json'), JSON.stringify(state), 'utf-8')

    const result = readAndReconcileState(tmpDir)!

    expect(result.services.backend.status).toBe('starting')
    expect(killSpy).not.toHaveBeenCalled()
  })

  it('does not reconcile running services whose pid is null', () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true as never)

    const state = makeState({
      services: {
        backend: { status: 'running', pid: null, port: 8080, startedAt: 1000, restarts: 0 },
      },
    })
    fs.writeFileSync(path.join(tmpDir, 'state.json'), JSON.stringify(state), 'utf-8')

    const result = readAndReconcileState(tmpDir)!

    expect(result.services.backend.status).toBe('running')
    expect(killSpy).not.toHaveBeenCalled()
  })

  it('returns the full state including unchanged fields after reconciliation', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('ESRCH')
    })

    const state = makeState({
      envId: 'env-full',
      shouldBeRunning: true,
      services: {
        backend: { status: 'running', pid: 999, port: 9000, startedAt: 2000, restarts: 3 },
      },
    })
    fs.writeFileSync(path.join(tmpDir, 'state.json'), JSON.stringify(state), 'utf-8')

    const result = readAndReconcileState(tmpDir)!

    expect(result.envId).toBe('env-full')
    expect(result.shouldBeRunning).toBe(true)
    expect(result.services.backend.port).toBe(9000)
    expect(result.services.backend.startedAt).toBe(2000)
    expect(result.services.backend.restarts).toBe(3)
  })
})
