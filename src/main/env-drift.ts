/**
 * Template Drift Check — main-process logic for detecting whether an environment
 * has drifted from its source template.
 *
 * V1: detection only. Returns one of:
 *   'clean'   — baseline matches current template
 *   'drifted' — template changed after this env was created
 *   'unknown' — env has no templateId, template not found, or no manifest
 *
 * Lazy migration: pre-feature envs (templateId set, but no templateBaseline)
 * get a clean baseline written on first call. No noise for existing envs.
 */

import * as path from 'path'
import { promises as fsp } from 'fs'
import { getManifest, getTemplate } from './env-manager'
import { computeDriftHash, hasDrift } from '../shared/template-drift'

export type DriftStatus = 'clean' | 'drifted' | 'unknown'

export type AcceptBaselineResult =
  | { ok: true; baseline: string }
  | { ok: false; reason: 'no-manifest' | 'no-template-id' | 'template-not-found' }

/**
 * Get the drift status for an environment.
 * Performs lazy baseline migration when templateBaseline is missing.
 */
export async function getEnvDriftStatus(envId: string): Promise<DriftStatus> {
  const manifest = await getManifest(envId)
  if (!manifest) return 'unknown'

  const templateId = (manifest.meta as any)?.templateId as string | undefined
  if (!templateId) return 'unknown'

  const template = await getTemplate(templateId)
  if (!template) return 'unknown'

  const currentHash = computeDriftHash(template)
  const storedBaseline = (manifest.meta as any)?.templateBaseline as string | undefined

  if (!storedBaseline) {
    // Lazy migration: first time we see this env — write baseline and report clean.
    await writeBaseline(manifest, currentHash)
    return 'clean'
  }

  return hasDrift(storedBaseline, currentHash) ? 'drifted' : 'clean'
}

/**
 * Accept the current template state as the new baseline for an environment.
 * Clears the "drifted" indicator without modifying services or config.
 */
export async function acceptDriftBaseline(envId: string): Promise<AcceptBaselineResult> {
  const manifest = await getManifest(envId)
  if (!manifest) return { ok: false, reason: 'no-manifest' }

  const templateId = (manifest.meta as any)?.templateId as string | undefined
  if (!templateId) return { ok: false, reason: 'no-template-id' }

  const template = await getTemplate(templateId)
  if (!template) return { ok: false, reason: 'template-not-found' }

  const newHash = computeDriftHash(template)
  await writeBaseline(manifest, newHash)
  return { ok: true, baseline: newHash }
}

/** Write templateBaseline into the manifest's meta without triggering envd re-register. */
async function writeBaseline(manifest: any, baseline: string): Promise<void> {
  try {
    const envDir = manifest.paths?.root as string | undefined
    if (!envDir) return
    const manifestPath = path.join(envDir, 'instance.json')
    const updated = {
      ...manifest,
      meta: { ...(manifest.meta || {}), templateBaseline: baseline },
    }
    await fsp.writeFile(manifestPath, JSON.stringify(updated, null, 2), 'utf-8')
  } catch {
    // Non-fatal — drift check still returns 'clean' even if write fails
  }
}
