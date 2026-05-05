import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mockReadFile = vi.hoisted(() => vi.fn())
const mockWriteFile = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const mockWatch = vi.hoisted(() => vi.fn().mockReturnValue({ on: vi.fn() }))

vi.mock('electron', () => ({ app: { getPath: vi.fn().mockReturnValue('/mock/home') } }))
vi.mock('fs', () => ({
  watch: mockWatch,
  promises: {
    readFile: mockReadFile,
    writeFile: mockWriteFile,
  },
}))

import type { TagRule } from '../../shared/types'
import type { ClaudeInstance } from '../../shared/types'

let mod: typeof import('../tag-rules')

function makeInstance(overrides: Partial<ClaudeInstance> = {}): ClaudeInstance {
  return {
    id: 'inst-1',
    name: 'test-session',
    workingDirectory: '/home/user/projects/alpha',
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    tokenUsage: { cost: 1.5, input: 0, output: 0 },
    status: 'waiting',
    pid: 0,
    ...overrides,
  } as ClaudeInstance
}

beforeEach(async () => {
  vi.resetModules()
  mockReadFile.mockResolvedValue(JSON.stringify([]))
  mockWriteFile.mockResolvedValue(undefined)
  mod = await import('../tag-rules')
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('evaluateCustomTags', () => {
  it('returns [] when no rules', () => {
    expect(mod.evaluateCustomTags(makeInstance(), 0, [])).toEqual([])
  })

  it('cost-gt matches when cost exceeds threshold', () => {
    const inst = makeInstance({ tokenUsage: { cost: 3.0, input: 0, output: 0 } })
    const rules: TagRule[] = [{ name: 'expensive', condition: { type: 'cost-gt', value: '2.00' } }]
    expect(mod.evaluateCustomTags(inst, 0, rules)).toEqual(['expensive'])
  })

  it('cost-gt does not match when cost is below threshold', () => {
    const inst = makeInstance({ tokenUsage: { cost: 0.5, input: 0, output: 0 } })
    const rules: TagRule[] = [{ name: 'expensive', condition: { type: 'cost-gt', value: '2.00' } }]
    expect(mod.evaluateCustomTags(inst, 0, rules)).toEqual([])
  })

  it('cost-lt matches when cost is below threshold', () => {
    const inst = makeInstance({ tokenUsage: { cost: 0.1, input: 0, output: 0 } })
    const rules: TagRule[] = [{ name: 'cheap', condition: { type: 'cost-lt', value: '0.50' } }]
    expect(mod.evaluateCustomTags(inst, 0, rules)).toEqual(['cheap'])
  })

  it('duration-gt matches when session ran longer than threshold (seconds)', () => {
    const inst = makeInstance({ createdAt: new Date(Date.now() - 120_000).toISOString() })
    const rules: TagRule[] = [{ name: 'long', condition: { type: 'duration-gt', value: '60' } }]
    expect(mod.evaluateCustomTags(inst, 0, rules)).toEqual(['long'])
  })

  it('duration-lt matches when session ran shorter than threshold (seconds)', () => {
    const inst = makeInstance({ createdAt: new Date(Date.now() - 10_000).toISOString() })
    const rules: TagRule[] = [{ name: 'quick', condition: { type: 'duration-lt', value: '30' } }]
    expect(mod.evaluateCustomTags(inst, 0, rules)).toEqual(['quick'])
  })

  it('exit-code matches exact exit code', () => {
    const rules: TagRule[] = [{ name: 'killed', condition: { type: 'exit-code', value: '129' } }]
    expect(mod.evaluateCustomTags(makeInstance(), 129, rules)).toEqual(['killed'])
  })

  it('exit-code does not match different exit code', () => {
    const rules: TagRule[] = [{ name: 'killed', condition: { type: 'exit-code', value: '129' } }]
    expect(mod.evaluateCustomTags(makeInstance(), 0, rules)).toEqual([])
  })

  it('dir-contains matches substring in workingDirectory', () => {
    const inst = makeInstance({ workingDirectory: '/home/user/projects/alpha' })
    const rules: TagRule[] = [{ name: 'alpha-project', condition: { type: 'dir-contains', value: 'alpha' } }]
    expect(mod.evaluateCustomTags(inst, 0, rules)).toEqual(['alpha-project'])
  })

  it('dir-contains does not match missing substring', () => {
    const inst = makeInstance({ workingDirectory: '/home/user/projects/beta' })
    const rules: TagRule[] = [{ name: 'alpha-project', condition: { type: 'dir-contains', value: 'alpha' } }]
    expect(mod.evaluateCustomTags(inst, 0, rules)).toEqual([])
  })

  it('name-contains matches case-insensitively', () => {
    const inst = makeInstance({ name: 'My PR Review Session' })
    const rules: TagRule[] = [{ name: 'pr', condition: { type: 'name-contains', value: 'pr review' } }]
    expect(mod.evaluateCustomTags(inst, 0, rules)).toEqual(['pr'])
  })

  it('name-regex matches via case-insensitive regex', () => {
    const inst = makeInstance({ name: 'PR #123 review' })
    const rules: TagRule[] = [{ name: 'pr-numbered', condition: { type: 'name-regex', value: 'PR #\\d+' } }]
    expect(mod.evaluateCustomTags(inst, 0, rules)).toEqual(['pr-numbered'])
  })

  it('name-regex does not match when pattern fails', () => {
    const inst = makeInstance({ name: 'daily standup' })
    const rules: TagRule[] = [{ name: 'pr-numbered', condition: { type: 'name-regex', value: 'PR #\\d+' } }]
    expect(mod.evaluateCustomTags(inst, 0, rules)).toEqual([])
  })

  it('collects tags from multiple matching rules', () => {
    const inst = makeInstance({
      name: 'PR #42',
      workingDirectory: '/newton',
      tokenUsage: { cost: 5.0, input: 0, output: 0 },
    })
    const rules: TagRule[] = [
      { name: 'expensive', condition: { type: 'cost-gt', value: '2.00' } },
      { name: 'newton', condition: { type: 'dir-contains', value: 'newton' } },
      { name: 'pr', condition: { type: 'name-regex', value: 'PR #\\d+' } },
    ]
    expect(mod.evaluateCustomTags(inst, 0, rules)).toEqual(['expensive', 'newton', 'pr'])
  })

  it('skips rules beyond MAX_RULES (20)', () => {
    const inst = makeInstance({ tokenUsage: { cost: 100, input: 0, output: 0 } })
    const rules: TagRule[] = Array.from({ length: 25 }, (_, i) => ({
      name: `tag-${i}`,
      condition: { type: 'cost-gt' as const, value: '0' },
    }))
    const result = mod.evaluateCustomTags(inst, 0, rules)
    expect(result).toHaveLength(20)
    expect(result[0]).toBe('tag-0')
    expect(result[19]).toBe('tag-19')
  })

  it('skips invalid regex rule without throwing and still processes remaining rules', () => {
    const rules: TagRule[] = [
      { name: 'bad', condition: { type: 'name-regex', value: '[invalid(regex' } },
      { name: 'good', condition: { type: 'exit-code', value: '0' } },
    ]
    expect(() => mod.evaluateCustomTags(makeInstance(), 0, rules)).not.toThrow()
    expect(mod.evaluateCustomTags(makeInstance(), 0, rules)).toContain('good')
  })

  it('defaults cost to 0 when tokenUsage is missing', () => {
    const inst = makeInstance({ tokenUsage: undefined })
    const rules: TagRule[] = [{ name: 'zero-cost', condition: { type: 'cost-lt', value: '1' } }]
    expect(mod.evaluateCustomTags(inst, 0, rules)).toEqual(['zero-cost'])
  })
})

describe('saveTagRules / getCachedRules', () => {
  it('slugifies tag names on save', async () => {
    const rules: TagRule[] = [{ name: 'My Tag!', condition: { type: 'cost-gt', value: '1' } }]
    await mod.saveTagRules(rules)
    expect(mod.getCachedRules()[0].name).toBe('my-tag')
  })

  it('falls back to "custom" when name slugifies to empty string', async () => {
    const rules: TagRule[] = [{ name: '!!!', condition: { type: 'cost-gt', value: '1' } }]
    await mod.saveTagRules(rules)
    expect(mod.getCachedRules()[0].name).toBe('custom')
  })

  it('caps at 20 rules', async () => {
    const rules: TagRule[] = Array.from({ length: 25 }, (_, i) => ({
      name: `tag-${i}`,
      condition: { type: 'cost-gt' as const, value: '1' },
    }))
    await mod.saveTagRules(rules)
    expect(mod.getCachedRules()).toHaveLength(20)
  })

  it('getCachedRules returns array (defaults to [] before any load)', () => {
    expect(Array.isArray(mod.getCachedRules())).toBe(true)
  })

  it('writes JSON to file on save', async () => {
    const rules: TagRule[] = [{ name: 'tag-a', condition: { type: 'cost-gt', value: '1' } }]
    await mod.saveTagRules(rules)
    expect(mockWriteFile).toHaveBeenCalledOnce()
    const written = JSON.parse(mockWriteFile.mock.calls[0][1] as string)
    expect(written[0].name).toBe('tag-a')
  })
})

describe('getTagRules', () => {
  it('returns parsed array from file', async () => {
    const stored: TagRule[] = [{ name: 'my-tag', condition: { type: 'cost-gt', value: '1' } }]
    mockReadFile.mockResolvedValueOnce(JSON.stringify(stored))
    const result = await mod.getTagRules()
    expect(result).toEqual(stored)
  })

  it('returns [] when file does not exist', async () => {
    mockReadFile.mockRejectedValueOnce(new Error('ENOENT'))
    expect(await mod.getTagRules()).toEqual([])
  })

  it('returns [] when file contains invalid JSON', async () => {
    mockReadFile.mockResolvedValueOnce('not json')
    expect(await mod.getTagRules()).toEqual([])
  })

  it('returns [] when file contains non-array JSON', async () => {
    mockReadFile.mockResolvedValueOnce('{"key":"val"}')
    expect(await mod.getTagRules()).toEqual([])
  })
})
