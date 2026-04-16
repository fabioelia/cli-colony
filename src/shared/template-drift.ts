/**
 * Template Drift Detection — pure utilities for comparing an environment's
 * template baseline against the current template state.
 *
 * V1: detection only (no apply / re-sync logic).
 * The drift-relevant subset excludes identity and metadata fields that don't
 * affect how an environment is structured: id, name, description, createdAt,
 * updatedAt, meta, source, agentHints, logs.
 */

import { createHash } from 'crypto'
import type { EnvironmentTemplate } from './types'

/** Fields that matter for drift detection. */
interface DriftSubset {
  projectType: string
  repos: Array<{ owner: string; name: string; as: string }>
  services: Record<string, unknown>
  resources?: Record<string, unknown>
  ports?: string[]
  hooks?: Record<string, unknown[]>
  branches?: { default?: string; alternatives?: string[]; sourceDb?: Record<string, string> }
}

export function getDriftSubset(template: EnvironmentTemplate): DriftSubset {
  return {
    projectType: template.projectType,
    // Machine-specific fields (localPath, remoteUrl) excluded — they're env-local.
    repos: (template.repos || []).map(r => ({ owner: r.owner, name: r.name, as: r.as })),
    services: template.services || {},
    resources: template.resources,
    ports: template.ports,
    hooks: template.hooks as Record<string, unknown[]> | undefined,
    branches: template.branches,
  }
}

/** Recursively sort object keys for stable serialization. */
function sortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedKeys)
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(value as object).sort()) {
      sorted[key] = sortedKeys((value as Record<string, unknown>)[key])
    }
    return sorted
  }
  return value
}

/**
 * Compute a short deterministic hash of the drift-relevant template fields.
 * Returns a 16-char hex string.
 */
export function computeDriftHash(template: EnvironmentTemplate): string {
  const subset = getDriftSubset(template)
  const canonical = JSON.stringify(sortedKeys(subset))
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16)
}

/** True if the current template hash differs from the stored baseline. */
export function hasDrift(baseline: string, current: string): boolean {
  return baseline !== current
}

/** The ordered list of fields tracked for per-field drift reporting. */
const DRIFT_FIELDS = ['projectType', 'repos', 'services', 'resources', 'ports', 'hooks', 'branches'] as const

/**
 * Return which top-level DriftSubset fields differ between baseline and current.
 * Comparison is by stable JSON serialization (sorted keys). Returns fields in
 * declaration order (not Object.keys order) for deterministic output.
 */
export function getFieldDrift(baseline: DriftSubset, current: DriftSubset): string[] {
  const changed: string[] = []
  for (const field of DRIFT_FIELDS) {
    const a = JSON.stringify(sortedKeys(baseline[field]))
    const b = JSON.stringify(sortedKeys(current[field]))
    if (a !== b) changed.push(field)
  }
  return changed
}
