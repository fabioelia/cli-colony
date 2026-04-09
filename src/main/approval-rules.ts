/**
 * Scoped Approval Gate Builder — rules engine for graduated trust approval.
 * Evaluates pipeline actions against rules to auto-approve, require approval, or escalate.
 */

import { promises as fsp } from 'fs'
import * as path from 'path'
import { v4 as uuid } from 'uuid'
import { ApprovalRule } from '../shared/types'
import { colonyPaths } from '../shared/colony-paths'

// Risk level mapping: action type → risk level
const RISK_LEVEL_MAP: Record<string, 'low' | 'medium' | 'high'> = {
  'wait_for_session': 'low',
  'plan': 'low',
  'launch-session': 'medium',
  'diff_review': 'medium',
  'maker-checker': 'medium',
  'parallel': 'medium',
  'route-to-session': 'medium',
}

// Action cost estimates (USD)
const ACTION_COST_ESTIMATE: Record<string, number> = {
  'wait_for_session': 0,
  'plan': 0.01,
  'diff_review': 0.02,
  'maker-checker': 0.05,
  'parallel': 0.03,
  'launch-session': 0.02,
  'route-to-session': 0.02,
}

let _cache: ApprovalRule[] | null = null

/**
 * Load approval rules from storage.
 */
export async function loadApprovalRules(): Promise<ApprovalRule[]> {
  if (_cache !== null) return _cache
  try {
    const rulesPath = colonyPaths.approvalRulesJson
    const content = await fsp.readFile(rulesPath, 'utf-8')
    _cache = JSON.parse(content) as ApprovalRule[]
    return _cache
  } catch (error: any) {
    if (error?.code !== 'ENOENT') console.error('[approval-rules] Failed to load rules:', error)
    _cache = []
    return []
  }
}

/**
 * Save approval rules to storage.
 */
export async function saveApprovalRules(rules: ApprovalRule[]): Promise<void> {
  try {
    await fsp.mkdir(colonyPaths.governance, { recursive: true })
    const rulesPath = colonyPaths.approvalRulesJson
    await fsp.writeFile(rulesPath, JSON.stringify(rules, null, 2), 'utf-8')
    _cache = rules
  } catch (error) {
    console.error('[approval-rules] Failed to save rules:', error)
    throw error
  }
}

/**
 * Create a new approval rule.
 */
export async function createRule(
  name: string,
  type: 'file_pattern' | 'cost_threshold' | 'risk_level',
  condition: string,
  action: 'auto_approve' | 'require_approval' | 'require_escalation'
): Promise<ApprovalRule> {
  const rules = await loadApprovalRules()
  const newRule: ApprovalRule = {
    id: uuid(),
    name,
    type,
    condition,
    action,
    enabled: true,
    createdAt: new Date().toISOString(),
  }
  rules.push(newRule)
  await saveApprovalRules(rules)
  return newRule
}

/**
 * Update an approval rule by ID.
 */
export async function updateRule(id: string, updates: Partial<ApprovalRule>): Promise<boolean> {
  const rules = await loadApprovalRules()
  const idx = rules.findIndex((r) => r.id === id)
  if (idx === -1) return false
  rules[idx] = { ...rules[idx], ...updates }
  await saveApprovalRules(rules)
  return true
}

/**
 * Delete an approval rule by ID.
 */
export async function deleteRule(id: string): Promise<boolean> {
  const rules = await loadApprovalRules()
  const filtered = rules.filter((r) => r.id !== id)
  if (filtered.length === rules.length) return false
  await saveApprovalRules(filtered)
  return true
}

/**
 * Estimate cost for a given action type.
 */
export function estimateActionCost(actionType: string): number {
  return ACTION_COST_ESTIMATE[actionType] ?? 0.02
}

/**
 * Convert a simple glob pattern to a regex-like matcher.
 * Converts * → .*, ? → .
 */
function globToMatcher(pattern: string): (str: string) => boolean {
  const regexStr = pattern
    .replace(/\./g, '\\.')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  const regex = new RegExp(`^${regexStr}$`)
  return (str: string) => regex.test(str)
}

/**
 * Match an action against approval rules.
 * Returns the first enabled rule that matches, or null if none match.
 */
export async function matchRules(
  actionType: string,
  estimatedCostUsd: number,
  diffFiles: string[] = []
): Promise<ApprovalRule | null> {
  const rules = await loadApprovalRules()

  for (const rule of rules) {
    if (!rule.enabled) continue

    if (rule.type === 'file_pattern') {
      // Condition: comma-separated glob patterns
      const patterns = rule.condition
        .split(',')
        .map((p) => p.trim())
        .filter((p) => p.length > 0)
      const matches = patterns.some((pattern) => {
        const matcher = globToMatcher(pattern)
        return diffFiles.some((file) => matcher(file))
      })
      if (matches) return rule
    } else if (rule.type === 'cost_threshold') {
      // Condition: comparison operator + threshold (e.g., "< 0.10")
      const match = rule.condition.match(/^([<>=]+)\s*([\d.]+)$/)
      if (match) {
        const [, op, thresholdStr] = match
        const threshold = parseFloat(thresholdStr)
        let matches = false
        if (op === '<') matches = estimatedCostUsd < threshold
        else if (op === '<=') matches = estimatedCostUsd <= threshold
        else if (op === '>') matches = estimatedCostUsd > threshold
        else if (op === '>=') matches = estimatedCostUsd >= threshold
        else if (op === '=') matches = estimatedCostUsd === threshold
        if (matches) return rule
      }
    } else if (rule.type === 'risk_level') {
      // Condition: pipe-separated risk levels (e.g., "low|medium")
      const riskLevels = rule.condition
        .split('|')
        .map((r) => r.trim())
        .filter((r) => r.length > 0)
      const actionRisk = RISK_LEVEL_MAP[actionType] ?? 'medium'
      if (riskLevels.includes(actionRisk)) return rule
    }
  }

  return null
}

/**
 * Clear the cache (for testing).
 */
export function clearCache(): void {
  _cache = null
}
