/**
 * Tests for src/shared/env-index.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

let tmpDir: string
let mod: typeof import('../env-index')

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-index-test-'))
  vi.resetModules()
  vi.doMock('../colony-paths', () => ({
    colonyPaths: {
      envIndex: path.join(tmpDir, 'environments.json'),
    },
  }))
  mod = await import('../env-index')
})

afterEach(() => {
  vi.resetModules()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('readIndex', () => {
  it('returns empty object when file does not exist', () => {
    expect(mod.readIndex()).toEqual({})
  })

  it('returns stored index when file exists', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'environments.json'),
      JSON.stringify({ 'env-1': '/path/to/env-1' }),
      'utf-8',
    )
    expect(mod.readIndex()).toEqual({ 'env-1': '/path/to/env-1' })
  })
})

describe('writeIndex', () => {
  it('persists index to disk', () => {
    mod.writeIndex({ 'env-1': '/a', 'env-2': '/b' })
    const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, 'environments.json'), 'utf-8'))
    expect(raw).toEqual({ 'env-1': '/a', 'env-2': '/b' })
  })

  it('overwrites existing data', () => {
    mod.writeIndex({ 'env-1': '/a' })
    mod.writeIndex({ 'env-2': '/b' })
    expect(mod.readIndex()).toEqual({ 'env-2': '/b' })
  })
})

describe('addToIndex', () => {
  it('adds a new entry to an empty index', () => {
    mod.addToIndex('env-1', '/path/env-1')
    expect(mod.readIndex()).toEqual({ 'env-1': '/path/env-1' })
  })

  it('appends to existing entries without clobbering', () => {
    mod.addToIndex('env-1', '/path/env-1')
    mod.addToIndex('env-2', '/path/env-2')
    expect(mod.readIndex()).toEqual({
      'env-1': '/path/env-1',
      'env-2': '/path/env-2',
    })
  })

  it('overwrites an entry if the same id is added twice', () => {
    mod.addToIndex('env-1', '/old')
    mod.addToIndex('env-1', '/new')
    expect(mod.readIndex()['env-1']).toBe('/new')
  })
})

describe('removeFromIndex', () => {
  it('removes an existing entry', () => {
    mod.addToIndex('env-1', '/path/env-1')
    mod.removeFromIndex('env-1')
    expect(mod.readIndex()).toEqual({})
  })

  it('is a no-op when id does not exist', () => {
    mod.addToIndex('env-1', '/path/env-1')
    mod.removeFromIndex('non-existent')
    expect(mod.readIndex()).toEqual({ 'env-1': '/path/env-1' })
  })

  it('only removes the targeted entry', () => {
    mod.addToIndex('env-1', '/a')
    mod.addToIndex('env-2', '/b')
    mod.removeFromIndex('env-1')
    expect(mod.readIndex()).toEqual({ 'env-2': '/b' })
  })
})

describe('allEnvDirs', () => {
  it('returns empty array when index is empty', () => {
    expect(mod.allEnvDirs()).toEqual([])
  })

  it('returns entries whose directories exist on disk', () => {
    const existingDir = path.join(tmpDir, 'real-env')
    fs.mkdirSync(existingDir)
    mod.addToIndex('env-real', existingDir)
    const result = mod.allEnvDirs()
    expect(result).toEqual([{ id: 'env-real', dir: existingDir }])
  })

  it('excludes entries whose directories do not exist', () => {
    mod.addToIndex('env-ghost', '/does/not/exist')
    expect(mod.allEnvDirs()).toEqual([])
  })

  it('returns only existing dirs from a mixed index', () => {
    const existingDir = path.join(tmpDir, 'live-env')
    fs.mkdirSync(existingDir)
    mod.addToIndex('env-live', existingDir)
    mod.addToIndex('env-dead', '/also/missing')
    const result = mod.allEnvDirs()
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('env-live')
  })

  it('returns multiple existing entries', () => {
    const dir1 = path.join(tmpDir, 'env-a')
    const dir2 = path.join(tmpDir, 'env-b')
    fs.mkdirSync(dir1)
    fs.mkdirSync(dir2)
    mod.addToIndex('env-a', dir1)
    mod.addToIndex('env-b', dir2)
    const result = mod.allEnvDirs()
    expect(result).toHaveLength(2)
    const ids = result.map((r) => r.id).sort()
    expect(ids).toEqual(['env-a', 'env-b'])
  })
})
