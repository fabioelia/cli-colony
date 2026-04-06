import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync } from 'fs'
import * as os from 'os'
import * as path from 'path'

// --- Mock electron so colony-paths can initialise ---
vi.mock('electron', () => ({ app: { getPath: vi.fn().mockReturnValue('/mock/home') } }))

// --- tmpRoot must be defined before vi.mock factories run (vi.hoisted) ---
const { tmpRoot } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const p = require('path') as typeof import('path')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const o = require('os') as typeof import('os')
  return { tmpRoot: p.join(o.tmpdir(), `colony-triggers-test-${process.pid}`) }
})

// --- Redirect colonyPaths to the temp dir ---
vi.mock('../../shared/colony-paths', () => ({
  colonyPaths: {
    root: tmpRoot,
    triggers: path.join(tmpRoot, 'triggers'),
    bin: path.join(tmpRoot, 'bin'),
    personas: path.join(tmpRoot, 'personas'),
  },
}))

import { getCanInvoke, validateTrigger, type TriggerPayload } from '../persona-triggers'

// ---- helpers ----

function writePersona(id: string, canInvoke: string[]): void {
  const dir = path.join(tmpRoot, 'personas')
  mkdirSync(dir, { recursive: true })
  const list = canInvoke.length > 0 ? `["${canInvoke.join('", "')}"]` : '[]'
  writeFileSync(
    path.join(dir, `${id}.md`),
    `---\nname: "${id}"\ncan_invoke: ${list}\n---\n\n## Role\n`,
  )
}

// ---- getCanInvoke ----

describe('getCanInvoke', () => {
  beforeEach(() => mkdirSync(path.join(tmpRoot, 'personas'), { recursive: true }))
  afterEach(() => { try { require('fs').rmSync(tmpRoot, { recursive: true, force: true }) } catch { /* */ } })

  it('returns can_invoke list from persona frontmatter', () => {
    writePersona('arch-auditor', ['colony-developer', 'colony-qa'])
    expect(getCanInvoke('arch-auditor')).toEqual(['colony-developer', 'colony-qa'])
  })

  it('returns [] for persona with empty can_invoke', () => {
    writePersona('colony-qa', [])
    expect(getCanInvoke('colony-qa')).toEqual([])
  })

  it('returns [] for non-existent persona', () => {
    expect(getCanInvoke('no-such-persona')).toEqual([])
  })
})

// ---- validateTrigger ----

describe('validateTrigger', () => {
  const base: TriggerPayload = { from: 'arch-auditor', to: 'colony-developer', note: 'done' }

  it('returns ok when all conditions met', () => {
    const result = validateTrigger(base, ['colony-developer'], null, true)
    expect(result.ok).toBe(true)
  })

  it('rejects when from is missing', () => {
    const result = validateTrigger({ ...base, from: '' }, ['colony-developer'], null, true)
    expect(result.ok).toBe(false)
    expect((result as { ok: false; reason: string }).reason).toMatch(/missing from\/to/)
  })

  it('rejects when to is missing', () => {
    const result = validateTrigger({ ...base, to: '' }, ['colony-developer'], null, true)
    expect(result.ok).toBe(false)
  })

  it('rejects when target not in can_invoke', () => {
    const result = validateTrigger(base, ['colony-qa'], null, true)
    expect(result.ok).toBe(false)
    expect(result.ok === false && !result.busy).toBe(true)
    expect((result as { ok: false; busy: false; reason: string }).reason).toMatch(/may not invoke/)
  })

  it('rejects when target is disabled', () => {
    const result = validateTrigger(base, ['colony-developer'], null, false)
    expect(result.ok).toBe(false)
    expect(result.ok === false && !result.busy).toBe(true)
  })

  it('returns busy=true when target already has a running session', () => {
    const result = validateTrigger(base, ['colony-developer'], 'session-abc', true)
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.busy).toBe(true)
    expect((result as { ok: false; busy: true; reason: string }).reason).toMatch(/already has a running session/)
  })

  it('allows trigger without a note', () => {
    const result = validateTrigger({ from: 'arch-auditor', to: 'colony-developer' }, ['colony-developer'], null, true)
    expect(result.ok).toBe(true)
  })
})
