/**
 * Tests for src/shared/json-file.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { JsonFile } from '../json-file'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'json-file-test-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('JsonFile: read()', () => {
  it('returns defaults when file does not exist', () => {
    const jf = new JsonFile(path.join(tmpDir, 'missing.json'), { x: 1 })
    expect(jf.read()).toEqual({ x: 1 })
  })

  it('returns defaults when file contains invalid JSON', () => {
    const filePath = path.join(tmpDir, 'corrupt.json')
    fs.writeFileSync(filePath, 'not valid json!!!', 'utf-8')
    const jf = new JsonFile(filePath, { fallback: true })
    expect(jf.read()).toEqual({ fallback: true })
  })

  it('returns defaults when file is empty', () => {
    const filePath = path.join(tmpDir, 'empty.json')
    fs.writeFileSync(filePath, '', 'utf-8')
    const jf = new JsonFile(filePath, { empty: 'default' })
    expect(jf.read()).toEqual({ empty: 'default' })
  })

  it('returns parsed data from existing file', () => {
    const filePath = path.join(tmpDir, 'data.json')
    fs.writeFileSync(filePath, JSON.stringify({ name: 'test', count: 42 }), 'utf-8')
    const jf = new JsonFile(filePath, {})
    expect(jf.read()).toEqual({ name: 'test', count: 42 })
  })

  it('returns default array when file is missing and default is array', () => {
    const jf = new JsonFile(path.join(tmpDir, 'nope.json'), [] as string[])
    expect(jf.read()).toEqual([])
  })
})

describe('JsonFile: write()', () => {
  it('writes data as formatted JSON', () => {
    const filePath = path.join(tmpDir, 'output.json')
    const jf = new JsonFile(filePath, {})
    jf.write({ hello: 'world' })
    const raw = fs.readFileSync(filePath, 'utf-8')
    expect(JSON.parse(raw)).toEqual({ hello: 'world' })
  })

  it('formats JSON with 2-space indentation', () => {
    const filePath = path.join(tmpDir, 'pretty.json')
    const jf = new JsonFile(filePath, {})
    jf.write({ a: 1 })
    const raw = fs.readFileSync(filePath, 'utf-8')
    expect(raw).toContain('\n  ')
  })

  it('creates parent directories when they do not exist', () => {
    const filePath = path.join(tmpDir, 'nested', 'deep', 'file.json')
    const jf = new JsonFile(filePath, {})
    jf.write({ created: true })
    expect(fs.existsSync(filePath)).toBe(true)
  })

  it('overwrites an existing file', () => {
    const filePath = path.join(tmpDir, 'overwrite.json')
    fs.writeFileSync(filePath, JSON.stringify({ old: true }), 'utf-8')
    const jf = new JsonFile(filePath, {})
    jf.write({ new: true })
    expect(JSON.parse(fs.readFileSync(filePath, 'utf-8'))).toEqual({ new: true })
  })
})

describe('JsonFile: write() then read() round-trip', () => {
  it('round-trips a flat object', () => {
    const filePath = path.join(tmpDir, 'round-trip.json')
    const data = { key: 'value', num: 99 }
    const jf = new JsonFile(filePath, {})
    jf.write(data)
    expect(jf.read()).toEqual(data)
  })

  it('round-trips a nested object', () => {
    const filePath = path.join(tmpDir, 'nested.json')
    const data = { items: [1, 2, 3], nested: { flag: true, name: 'test' } }
    const jf = new JsonFile(filePath, {})
    jf.write(data)
    expect(jf.read()).toEqual(data)
  })

  it('round-trips an array', () => {
    const filePath = path.join(tmpDir, 'array.json')
    const data = ['a', 'b', 'c']
    const jf = new JsonFile<string[]>(filePath, [])
    jf.write(data)
    expect(jf.read()).toEqual(data)
  })
})
