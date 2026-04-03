/**
 * Environment Setup Pipeline — clones repos as worktrees, runs hooks in order.
 *
 * Extracted from env-manager.ts to isolate the complex setup pipeline from
 * environment CRUD operations.
 */

import * as fs from 'fs'
import * as path from 'path'
import { exec as nodeExec } from 'child_process'
import { ipcMain } from 'electron'
import { getEnvDaemonClient } from './env-daemon-client'
import { ensureBareRepo, addWorktree } from '../shared/git-worktree'
import { broadcast } from './broadcast'
import { gitRemoteUrl } from './settings'
import { loadShellEnv } from '../shared/shell-env'
import type { InstanceManifest, EnvironmentTemplate } from '../daemon/env-protocol'

const shellEnv = loadShellEnv()

// Helper: async exec that doesn't block the event loop
function execAsync(cmd: string, opts?: { cwd?: string; timeout?: number; stdio?: any; env?: Record<string, string> }): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = opts?.env ? { ...shellEnv, ...opts.env } : shellEnv
    nodeExec(cmd, { env, encoding: 'utf-8', cwd: opts?.cwd, timeout: opts?.timeout || 60000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const enriched = Object.assign(err, { stderr: stderr || '' })
        reject(enriched)
      } else resolve(stdout)
    })
  })
}

/**
 * Run the setup pipeline for a newly created environment.
 * Template-driven -- clones repos from template, runs hooks in order.
 *
 * @param envDir - Resolved directory for the environment
 * @param getTemplate - Function to look up a template by ID (avoids circular import with env-manager)
 */
export async function runSetup(
  envDir: string,
  getTemplate: (id: string) => EnvironmentTemplate | null,
): Promise<void> {
  const manifestPath = path.join(envDir, 'instance.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as InstanceManifest
  const envId = manifest.id

  let hasStepError = false

  const updateStep = (stepName: string, status: 'running' | 'done' | 'error' | 'skipped', error?: string, opts?: { continueOnError?: boolean }) => {
    if (manifest.setup?.steps) {
      const step = manifest.setup.steps.find(s => s.name === stepName)
      if (step) {
        step.status = status
        if (error) step.error = error
      }
    }
    if (status === 'error' && !opts?.continueOnError) {
      hasStepError = true
      manifest.setup!.status = 'error'
      manifest.setup!.error = error || 'A setup step failed'
    }
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8')
    getEnvDaemonClient().register(manifest).catch(() => {})
  }

  // Setup log file -- also broadcast lines so the UI can show them in real time
  const setupLogPath = path.join(envDir, 'logs', 'setup.log')
  const logSetup = (msg: string) => {
    const line = `[${new Date().toISOString()}] ${msg}\n`
    fs.appendFileSync(setupLogPath, line, 'utf-8')
    console.log(`[env-setup] ${manifest.name}: ${msg}`)
    // Broadcast as service-output so EnvironmentLogViewer can show it live
    broadcast('env:service-output', { envId, service: 'setup', data: line })
  }
  logSetup('Starting environment setup')

  // Load the template to get repo info
  const templateId = (manifest.meta as any)?.templateId
  const template = templateId ? getTemplate(templateId) : null
  const branch = manifest.git?.branch || 'develop'
  logSetup(`Template: ${template?.name || 'none'}, Branch: ${branch}`)

  try {
    // Phase 1: Create worktrees from bare repos (replaces git clone)
    updateStep('Clone repos', 'running')
    if (template?.repos) {
      for (const repo of template.repos) {
        const targetDir = manifest.paths[repo.as] || path.join(envDir, repo.name)
        if (fs.existsSync(targetDir)) continue // already set up

        const remoteUrl = repo.remoteUrl || gitRemoteUrl(repo.owner, repo.name)

        logSetup(`Setting up ${repo.owner}/${repo.name} as worktree...`)

        // 1. Ensure bare repo exists (shared object store)
        const bareDir = await ensureBareRepo(repo.owner, repo.name, remoteUrl)
        logSetup(`  Bare repo ready: ${bareDir}`)

        // 2. Fetch the target branch
        try {
          await execAsync(`git fetch origin "${branch}"`, { cwd: bareDir, timeout: 60000 })
        } catch (fetchErr: any) {
          logSetup(`  Warning: fetch of branch "${branch}" failed: ${fetchErr.message}`)
          // Continue -- the branch may already be available from the initial clone
        }

        // 3. Create worktree with per-env tracking branch
        await addWorktree(bareDir, targetDir, branch, manifest.name)
        logSetup(`  Worktree created: ${targetDir} (branch: env/${manifest.name}/${branch})`)

        // 4. Set remote URL in the worktree (ensures push/pull work correctly)
        try {
          await execAsync(`git remote set-url origin "${remoteUrl}"`, { cwd: targetDir, timeout: 5000 })
        } catch { /* ignore -- bare repo already has the correct remote */ }
      }
    }
    updateStep('Clone repos', 'done')

    // Hook runner -- captures stdout from each hook as ${output.<hookName>}.
    // Consecutive hooks with `parallel: true` run concurrently via Promise.all.
    // A sequential hook (no parallel flag) acts as a barrier.
    const hookOutputs: Record<string, string> = {}

    // Check if a step was already completed in a previous run (for retry)
    function isStepDone(stepName: string): boolean {
      const step = manifest.setup?.steps?.find(s => s.name === stepName)
      return step?.status === 'done'
    }

    async function runOneHook(hook: any): Promise<void> {
      // Skip steps already completed in a previous run (smart retry)
      if (isStepDone(hook.name)) {
        logSetup(`  Skipping: ${hook.name} (already done)`)
        return
      }
      // Handle prompt-type hooks (e.g. file picker)
      if (hook.type === 'prompt') {
        return runPromptHook(hook)
      }
      if (!hook.command) {
        logSetup(`  Skipped: ${hook.name} (no command)`)
        return
      }
      let cmd = hook.command as string
      cmd = cmd.replace(/\$\{output\.([a-zA-Z0-9_-]+)\}/g, (_: string, ref: string) => {
        const key = ref.replace(/-/g, '_')
        return hookOutputs[key] || hookOutputs[ref] || ''
      })
      logSetup(`  Hook: ${hook.name} -- ${cmd.slice(0, 80)}`)
      updateStep(hook.name, 'running')
      try {
        const output = await execAsync(cmd, { cwd: hook.cwd || envDir, timeout: 300000 })
        const trimmed = output?.trim() || ''
        if (trimmed) logSetup(`  Output: ${trimmed.slice(0, 500)}`)
        const lastLine = trimmed.split('\n').pop()?.trim() || ''
        if (lastLine) {
          const key = (hook.name as string).replace(/-/g, '_')
          hookOutputs[key] = lastLine
          hookOutputs[hook.name] = lastLine
        }
        updateStep(hook.name, 'done')
        logSetup(`  Done: ${hook.name}`)
      } catch (err: any) {
        const stderr = err.stderr ? `\nStderr: ${err.stderr.slice(0, 500)}` : ''
        logSetup(`  FAILED: ${hook.name} -- ${String(err).slice(0, 300)}${stderr}`)
        updateStep(hook.name, 'error', String(err).slice(0, 300), { continueOnError: !!hook.continueOnError })
        if (hook.continueOnError) {
          logSetup(`  (continueOnError: proceeding despite failure)`)
        }
      }
    }

    async function runPromptHook(hook: any): Promise<void> {
      logSetup(`  Prompt: ${hook.name} -- ${hook.prompt || 'User input required'}`)
      updateStep(hook.name, 'running')
      try {
        const requestId = `${envId}:${hook.name}:${Date.now()}`

        // Helper: send prompt request to renderer and wait for response
        const waitForResponse = () => new Promise<{ filePath?: string; selectedValue?: string; cancelled?: boolean }>((resolve) => {
          const onResponse = (_event: any, data: any) => {
            if (data.requestId === requestId) {
              ipcMain.removeListener('env:prompt-response', onResponse)
              resolve(data)
            }
          }
          ipcMain.on('env:prompt-response', onResponse)
        })

        if (hook.promptType === 'file') {
          let selectedFile: string

          // If defaultPath exists and alwaysPrompt is not set, use it automatically
          if (hook.defaultPath && fs.existsSync(hook.defaultPath) && !hook.alwaysPrompt) {
            selectedFile = hook.defaultPath
            logSetup(`  Auto-selected: ${selectedFile} (found at default path)`)
          } else {
            logSetup(`  Waiting for user to select file...`)
            const responsePromise = waitForResponse()
            broadcast('env:prompt-request', {
              requestId, envId, hookName: hook.name,
              prompt: hook.prompt, promptType: 'file', defaultPath: hook.defaultPath,
            })
            const response = await responsePromise
            if (response.cancelled || !response.filePath) {
              throw new Error(`User cancelled file selection for: ${hook.name}`)
            }
            selectedFile = response.filePath
            logSetup(`  User selected: ${selectedFile}`)
          }

          // Copy to target if specified
          if (hook.target) {
            const targetDir = path.dirname(hook.target)
            if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true })
            fs.copyFileSync(selectedFile, hook.target)
            logSetup(`  Copied to: ${hook.target}`)
          }

          const key = (hook.name as string).replace(/-/g, '_')
          hookOutputs[key] = selectedFile
          hookOutputs[hook.name] = selectedFile

        } else if (hook.promptType === 'select') {
          // Run optionsCommand to get the list of choices
          let options: string[] = []
          if (hook.optionsCommand) {
            logSetup(`  Running options command: ${hook.optionsCommand.slice(0, 80)}`)
            const output = await execAsync(hook.optionsCommand, { cwd: hook.cwd || envDir, timeout: 30000 })
            options = (output || '').trim().split('\n').filter((l: string) => l.trim())
          }

          logSetup(`  Waiting for user to select from ${options.length} options...`)
          const responsePromise = waitForResponse()
          broadcast('env:prompt-request', {
            requestId, envId, hookName: hook.name,
            prompt: hook.prompt, promptType: 'select', options,
          })
          const response = await responsePromise
          if (response.cancelled || !response.selectedValue) {
            throw new Error(`User cancelled selection for: ${hook.name}`)
          }
          logSetup(`  User selected: ${response.selectedValue}`)

          const key = (hook.name as string).replace(/-/g, '_')
          hookOutputs[key] = response.selectedValue
          hookOutputs[hook.name] = response.selectedValue

        } else {
          logSetup(`  Skipped: ${hook.name} (unsupported promptType: ${hook.promptType})`)
          return
        }

        updateStep(hook.name, 'done')
        logSetup(`  Done: ${hook.name}`)
      } catch (err: any) {
        logSetup(`  FAILED: ${hook.name} -- ${String(err).slice(0, 300)}`)
        updateStep(hook.name, 'error', String(err).slice(0, 300), { continueOnError: !!hook.continueOnError })
        if (hook.continueOnError) {
          logSetup(`  (continueOnError: proceeding despite failure)`)
        }
      }
    }

    async function runHooks(phase: string, hooks: any[]): Promise<void> {
      logSetup(`Running ${hooks.length} ${phase} hooks`)

      // Group into batches: consecutive parallel hooks form a batch, sequential hooks are solo
      const batches: any[][] = []
      for (const hook of hooks) {
        if (hook.parallel) {
          // Add to current parallel batch, or start a new one
          const last = batches[batches.length - 1]
          if (last && last[0]?.parallel) {
            last.push(hook)
          } else {
            batches.push([hook])
          }
        } else {
          batches.push([hook])
        }
      }

      for (const batch of batches) {
        // If a previous hook in this phase failed, skip the rest
        if (hasStepError) {
          for (const hook of batch) {
            logSetup(`  Skipped: ${hook.name} (previous step failed)`)
            updateStep(hook.name, 'skipped')
          }
          continue
        }
        if (batch.length === 1) {
          await runOneHook(batch[0])
        } else {
          logSetup(`  Running ${batch.length} hooks in parallel: ${batch.map((h: any) => h.name).join(', ')}`)
          await Promise.all(batch.map(h => runOneHook(h)))
        }
      }
    }

    // Phase 2: Run postClone hooks
    if (manifest.hooks?.postClone) {
      await runHooks('postClone', manifest.hooks.postClone)
    }

    // Phase 3: Run postCreate hooks
    if (manifest.hooks?.postCreate) {
      await runHooks('postCreate', manifest.hooks.postCreate)
    }

    if (hasStepError) {
      logSetup('Setup finished with errors')
      // Status is already 'error' from updateStep -- just persist
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8')
      await getEnvDaemonClient().register(manifest).catch(() => {})
    } else {
      logSetup('Setup complete')
      manifest.setup!.status = 'ready'
      manifest.setup!.error = null
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8')
      await getEnvDaemonClient().register(manifest)

      // Auto-start services after successful setup
      logSetup('Starting services...')
      try {
        await getEnvDaemonClient().start(manifest.id)
        logSetup('Services started')
      } catch (startErr) {
        logSetup(`Auto-start failed (start manually): ${String(startErr).slice(0, 200)}`)
      }
    }

  } catch (err) {
    logSetup(`Setup crashed: ${String(err).slice(0, 300)}`)
    manifest.setup!.status = 'error'
    manifest.setup!.error = String(err)
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8')
    await getEnvDaemonClient().register(manifest).catch(() => {})
    throw err
  }
}
