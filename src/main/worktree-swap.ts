/**
 * Worktree Swap — atomic worktree swap for an environment.
 *
 * Orchestrates: unmount old → mount new → update manifest paths →
 * re-resolve services/hooks → write manifest → envd remount.
 *
 * The envd `remount` handler owns the stop → re-register → start cycle.
 * This module handles the worktree manager state and manifest updates.
 */

import * as fs from 'fs'
import * as path from 'path'
import { getManifest, getTemplate } from './env-manager'
import { getWorktree, getWorktreesForEnv, mountWorktree, unmountWorktree } from './worktree-manager'
import { getEnvDaemonClient } from './env-daemon-client'
import { broadcast } from './broadcast'
import { buildContext, resolveTemplate as resolveTemplateVars } from '../shared/template-resolver'
import type { InstanceManifest } from '../daemon/env-protocol'

/**
 * Swap the active worktree in a running environment.
 *
 * Steps:
 * 1. Validate: env exists, new worktree exists, new worktree is compatible
 * 2. Unmount all currently mounted worktrees for this env
 * 3. Mount the new worktree
 * 4. Update manifest paths, activeWorktreeId, services, hooks
 * 5. Write manifest to disk
 * 6. Send `remount` to envd (atomic stop → re-register → start)
 * 7. Broadcast worktree:changed + env:changed
 *
 * @returns The updated manifest after swap
 */
export async function swapWorktree(envId: string, newWorktreeId: string): Promise<InstanceManifest> {
  // 1. Load and validate
  const manifest = await getManifest(envId)
  if (!manifest) throw new Error(`Environment ${envId} not found`)

  const newWt = await getWorktree(newWorktreeId)
  if (!newWt) throw new Error(`Worktree ${newWorktreeId} not found`)
  if (newWt.mountedEnvId && newWt.mountedEnvId !== envId) {
    throw new Error(`Worktree ${newWorktreeId} is already mounted to environment ${newWt.mountedEnvId}`)
  }

  const templateId = (manifest.meta as any)?.templateId
  const template = templateId ? await getTemplate(templateId) : null

  // 2. Unmount all currently mounted worktrees for this env
  const currentlyMounted = await getWorktreesForEnv(envId)
  for (const wt of currentlyMounted) {
    await unmountWorktree(wt.id)
  }

  // 3. Mount the new worktree
  await mountWorktree(newWorktreeId, envId)

  // 4. Update manifest paths from new worktree's repos
  const mountedWorktrees: Record<string, string> = {} // repoAlias -> worktreeId
  for (const repo of newWt.repos) {
    manifest.paths[repo.alias] = repo.path
    mountedWorktrees[repo.alias] = newWorktreeId
  }
  manifest.meta = { ...manifest.meta, mountedWorktrees }
  manifest.activeWorktreeId = newWorktreeId

  // Set primaryRepo if not already set
  if (!manifest.primaryRepo && newWt.repos.length > 0) {
    manifest.primaryRepo = newWt.repos[0].alias
  }

  // 5. Re-resolve services/hooks with new paths (same logic as env-setup.ts)
  if (template) {
    const branch = manifest.git?.branch || 'develop'
    const repos: Record<string, any> = {}
    if (template.repos) {
      for (const repo of template.repos) repos[repo.as] = { ...repo }
    }
    const context = buildContext({
      name: manifest.name,
      ports: manifest.ports,
      paths: manifest.paths,
      resources: manifest.resources || {},
      repos,
      branch,
    })
    const resolved = resolveTemplateVars(
      { services: template.services, hooks: template.hooks, resources: template.resources },
      context,
      'worktree-swap:re-resolve',
    )
    manifest.services = resolved.services
    manifest.hooks = resolved.hooks
    manifest.resources = resolved.resources
  }

  // 6. Write manifest to disk
  const envDir = manifest.paths.root
  if (envDir) {
    const manifestPath = path.join(envDir, 'instance.json')
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8')
  }

  // 7. Send remount to envd (atomic stop → re-register → start)
  const envd = getEnvDaemonClient()
  await envd.remount(envId, manifest)

  // 8. Broadcast changes
  broadcast('worktree:changed', null)
  broadcast('env:changed', { envId })

  return manifest
}
