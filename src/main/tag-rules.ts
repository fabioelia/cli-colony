import { watch } from 'fs'
import { promises as fsp } from 'fs'
import { colonyPaths } from '../shared/colony-paths'
import type { TagRule, TagConditionType } from '../shared/types'
import type { ClaudeInstance } from '../shared/types'

const MAX_RULES = 20

let _cachedRules: TagRule[] | null = null
let _watcher: ReturnType<typeof watch> | null = null

async function readRules(): Promise<TagRule[]> {
  try {
    const raw = await fsp.readFile(colonyPaths.tagRulesJson, 'utf8')
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

async function loadAndCache(): Promise<void> {
  _cachedRules = await readRules()
}

export function getCachedRules(): TagRule[] {
  return _cachedRules ?? []
}

export function initTagRulesWatcher(): void {
  void loadAndCache()
  try {
    _watcher = watch(colonyPaths.tagRulesJson, () => {
      void loadAndCache()
    })
    _watcher.on('error', () => {})
  } catch {
    // file may not exist yet — that's fine, rules default to []
  }
}

export async function getTagRules(): Promise<TagRule[]> {
  return readRules()
}

function slugifyTag(name: string): string {
  return name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-_]/g, '')
}

export async function saveTagRules(rules: TagRule[]): Promise<void> {
  const capped = rules.slice(0, MAX_RULES).map(r => ({
    name: slugifyTag(r.name) || 'custom',
    condition: r.condition,
  }))
  await fsp.writeFile(colonyPaths.tagRulesJson, JSON.stringify(capped, null, 2), 'utf8')
  _cachedRules = capped
}

export function evaluateCustomTags(
  inst: ClaudeInstance,
  exitCode: number,
  rules: TagRule[],
): string[] {
  if (rules.length === 0) return []
  const cost = inst.tokenUsage?.cost ?? 0
  const durationMs = Date.now() - new Date(inst.createdAt).getTime()
  const durationSec = durationMs / 1000

  const tags: string[] = []
  for (const rule of rules.slice(0, MAX_RULES)) {
    try {
      if (matchesCondition(rule.condition.type, rule.condition.value, {
        cost, durationSec, exitCode, dir: inst.workingDirectory ?? '', name: inst.name,
      })) {
        tags.push(rule.name)
      }
    } catch {
      // skip invalid rule
    }
  }
  return tags
}

function matchesCondition(
  type: TagConditionType,
  value: string | number,
  ctx: { cost: number; durationSec: number; exitCode: number; dir: string; name: string },
): boolean {
  switch (type) {
    case 'cost-gt': return ctx.cost > Number(value)
    case 'cost-lt': return ctx.cost < Number(value)
    case 'duration-gt': return ctx.durationSec > Number(value)
    case 'duration-lt': return ctx.durationSec < Number(value)
    case 'exit-code': return ctx.exitCode === Number(value)
    case 'dir-contains': return ctx.dir.includes(String(value))
    case 'name-contains': return ctx.name.toLowerCase().includes(String(value).toLowerCase())
    case 'name-regex': return new RegExp(String(value), 'i').test(ctx.name)
    default: return false
  }
}
