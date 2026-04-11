/**
 * Pipeline Stage Runners — execution logic for each pipeline action type.
 * Extracted from pipeline-engine.ts to separate stage execution from the core engine.
 */

import { promises as fsp } from 'fs'
import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'
import { join } from 'path'
import { app } from 'electron'
import { createInstance, getAllInstances, killInstance } from './instance-manager'
import { getDaemonClient } from './daemon-client'
import { sendPromptWhenReady } from './send-prompt-when-ready'
import { appendActivity } from './activity-manager'
import { broadcast } from './broadcast'
import { notify } from './notifications'
import { createWorktree, removeWorktree } from './worktree-manager'
import { readArenaStats, writeArenaStats } from './arena-stats'
import { waitForSessionCompletion } from './session-completion'
import { tagArtifactPipeline } from './session-artifacts'
import { colonyPaths } from '../shared/colony-paths'
import type { ApprovalRequest } from '../shared/types'
import {
  plog,
  log,
  resolveTemplate,
  writePromptFile,
  pathExists,
  APPROVAL_DEFAULT_TTL_HOURS,
  pendingApprovals,
  pendingApprovalKeys,
  pipelines,
  PIPELINES_DIR,
} from './pipeline-engine'
import type { TriggerContext, ActionDef, PendingApproval, PipelineStageTrace } from './pipeline-engine'

const execFileAsync = promisify(execFileCb)

const COLONY_DIR = colonyPaths.root

const MAX_DIFF_BYTES = 8 * 1024

/** Run artifact capture commands and save stdout to the shared artifacts directory. Never throws. */
export async function captureArtifacts(outputs: Array<{ name: string; cmd: string }>, cwd: string | undefined): Promise<void> {
  const artifactsDir = join(COLONY_DIR, 'artifacts')
  await fsp.mkdir(artifactsDir, { recursive: true })
  for (const { name, cmd } of outputs) {
    try {
      const { stdout } = await execFileAsync('sh', ['-c', cmd], { cwd, timeout: 30_000, maxBuffer: 1024 * 1024 })
      const result = stdout.trim()
      await fsp.writeFile(join(artifactsDir, `${name}.txt`), result, 'utf-8')
      log(`[artifacts] captured "${name}": ${result.length} bytes`)
    } catch (err: any) {
      log(`[artifacts] warn: capture failed for "${name}" (cmd: ${cmd}): ${err?.message ?? err}`)
    }
  }
}

/** Read artifact files and build a preamble block to prepend to the prompt. */
export async function loadArtifactPreamble(inputs: string[]): Promise<string> {
  const artifactsDir = join(COLONY_DIR, 'artifacts')
  const sections: string[] = []
  for (const name of inputs) {
    const filePath = join(artifactsDir, `${name}.txt`)
    if (await pathExists(filePath)) {
      const content = (await fsp.readFile(filePath, 'utf-8')).trim()
      sections.push(`--- Artifact: ${name} ---\n${content}`)
    } else {
      log(`[artifacts] input "${name}" not found at ${filePath} — skipping`)
    }
  }
  return sections.length > 0 ? sections.join('\n\n') + '\n\n' : ''
}

/**
 * Read artifact files and build a structured handoff block with narrative framing.
 * Used for passing decision metadata and constraints between pipeline stages.
 */
export async function loadHandoffPreamble(inputs: string[]): Promise<string> {
  const artifactsDir = join(COLONY_DIR, 'artifacts')
  const sections: string[] = []
  for (const name of inputs) {
    const filePath = join(artifactsDir, `${name}.txt`)
    if (await pathExists(filePath)) {
      const content = (await fsp.readFile(filePath, 'utf-8')).trim()
      sections.push(
        `--- Stage Handoff from Prior Stage ---\n` +
        `The previous pipeline stage completed and left this structured briefing. Read it carefully before starting. ` +
        `Respect all "Decisions Made" constraints — do not re-litigate them. Use "Focus for Next Stage" to prioritize your work.\n\n` +
        `${content}\n\n` +
        `--- End of Stage Handoff ---`
      )
    } else {
      log(`[handoff] input "${name}" not found at ${filePath} — skipping`)
    }
  }
  return sections.length > 0 ? sections.join('\n\n') + '\n\n' : ''
}

/** Check if a reviewer response signals approval (APPROVED or LGTM, case-insensitive). */
export function isApproved(text: string): boolean {
  const lower = text.toLowerCase()
  return lower.includes('approved') || lower.includes('lgtm')
}

/**
 * Execute a maker-checker loop: maker produces output, checker reviews it.
 * Iterates up to maxIterations times. Completes when checker says APPROVED
 * or iterations are exhausted.
 */
export async function runMakerChecker(action: ActionDef, ctx: TriggerContext, pipelineName: string): Promise<{ cost: number; sessionId?: string }> {
  const { makerPrompt, checkerPrompt, approvedKeyword = 'APPROVED', maxIterations = 3 } = action
  if (!makerPrompt || !checkerPrompt) {
    log(`maker-checker: missing makerPrompt or checkerPrompt for "${pipelineName}"`)
    return { cost: 0 }
  }

  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const safeName = pipelineName.replace(/[^a-zA-Z0-9]/g, '-')
  const runDir = join(COLONY_DIR, 'maker-checker', safeName, runId)
  await fsp.mkdir(runDir, { recursive: true })

  const makerOutputFile = join(runDir, 'maker-output.md')
  const verdictFile = join(runDir, 'checker-verdict.md')
  const cwd = resolveTemplate(action.workingDirectory || '', ctx) || undefined
  const baseName = resolveTemplate(action.name || pipelineName, ctx)

  let prevFeedback = ''
  let accumulatedCost = 0
  let lastMakerSessionId: string | undefined

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    plog(pipelineName, `maker-checker: iteration ${iteration}/${maxIterations}`)

    // ---- Maker ----
    let makerFullPrompt = resolveTemplate(makerPrompt, ctx)
    if (prevFeedback) {
      makerFullPrompt += `\n\n--- Checker Feedback (iteration ${iteration - 1}) ---\n${prevFeedback}\n\nPlease address this feedback in your implementation.`
    }
    makerFullPrompt += `\n\n--- Required Output Step ---\nWhen you are done, write a comprehensive summary of what you did (including relevant file paths, test results, and key decisions) to:\n${makerOutputFile}\nThis MUST be written before you finish — the checker agent depends on it.`

    // Inject pipeline memory
    const p = [...pipelines.values()].find(pp => pp.def.name === pipelineName)
    if (p) {
      const memPath = join(PIPELINES_DIR, `${p.fileName.replace(/\.(yaml|yml)$/, '')}.memory.md`)
      if (await pathExists(memPath)) {
        const memory = (await fsp.readFile(memPath, 'utf-8')).trim()
        if (memory) {
          makerFullPrompt += `\n\n--- Pipeline Memory ---\n${memory}`
        }
      }
    }

    const makerPromptFile = await writePromptFile(makerFullPrompt)
    const makerInst = await createInstance({
      name: `${baseName} [Maker ${iteration}]`,
      workingDirectory: cwd,
      color: action.color,
      args: ['--append-system-prompt-file', makerPromptFile],
      model: action.model,
    })
    lastMakerSessionId = makerInst.id

    const completionPromise = waitForSessionCompletion(makerInst.id)
    await sendPromptWhenReady(makerInst.id, { prompt: 'Execute the instructions in your system prompt. Begin now.' })
    const makerDone = await completionPromise

    if (!makerDone) {
      plog(pipelineName, `maker-checker: maker timed out on iteration ${iteration}`)
      appendActivity({ source: 'pipeline', name: pipelineName, summary: `Maker-checker "${pipelineName}" maker timed out (iteration ${iteration})`, level: 'error' })
      return { cost: accumulatedCost, sessionId: lastMakerSessionId }
    }

    const makerFinalState = await getDaemonClient().getInstance(makerInst.id)
    accumulatedCost += makerFinalState?.tokenUsage.cost ?? 0
    tagArtifactPipeline(makerInst.id, runId).catch(() => {})

    // Read maker output file
    let makerOutput = ''
    try {
      makerOutput = await pathExists(makerOutputFile) ? await fsp.readFile(makerOutputFile, 'utf-8') : '(maker did not write output file)'
    } catch { makerOutput = '(error reading maker output)' }
    plog(pipelineName, `maker-checker: maker output: ${makerOutput.slice(0, 120)}${makerOutput.length > 120 ? '...' : ''}`)

    // ---- Checker ----
    let checkerFullPrompt = `--- Maker Output (iteration ${iteration}) ---\n${makerOutput}\n\n--- End Maker Output ---\n\n`
    checkerFullPrompt += resolveTemplate(checkerPrompt, ctx)
    checkerFullPrompt += `\n\n--- Required Verdict Step ---\nAfter your evaluation, write one of the following to:\n${verdictFile}\n\n- Work is complete and acceptable → write exactly: APPROVED\n- Changes needed → write: NEEDS REVISION: <your specific feedback>\n\nThis file MUST be written before you finish.`

    // Clear any previous verdict
    try { await fsp.writeFile(verdictFile, '', 'utf-8') } catch {}

    const checkerPromptFile = await writePromptFile(checkerFullPrompt)
    const checkerInst = await createInstance({
      name: `${baseName} [Checker ${iteration}]`,
      workingDirectory: cwd,
      color: action.color,
      args: ['--append-system-prompt-file', checkerPromptFile],
      model: action.model,
    })

    const checkerCompletionPromise = waitForSessionCompletion(checkerInst.id)
    await sendPromptWhenReady(checkerInst.id, { prompt: 'Execute the instructions in your system prompt. Begin now.' })
    const checkerDone = await checkerCompletionPromise

    if (!checkerDone) {
      plog(pipelineName, `maker-checker: checker timed out on iteration ${iteration}`)
      appendActivity({ source: 'pipeline', name: pipelineName, summary: `Maker-checker "${pipelineName}" checker timed out (iteration ${iteration})`, level: 'error' })
      return { cost: accumulatedCost, sessionId: lastMakerSessionId }
    }

    const checkerFinalState = await getDaemonClient().getInstance(checkerInst.id)
    accumulatedCost += checkerFinalState?.tokenUsage.cost ?? 0
    tagArtifactPipeline(checkerInst.id, runId).catch(() => {})

    // Read verdict
    let verdict = ''
    try { verdict = await pathExists(verdictFile) ? (await fsp.readFile(verdictFile, 'utf-8')).trim() : '' } catch {}
    plog(pipelineName, `maker-checker: checker verdict: ${verdict.slice(0, 120)}`)

    if (isApproved(verdict) || verdict.includes(approvedKeyword)) {
      plog(pipelineName, `maker-checker: APPROVED after ${iteration} iteration(s)`)
      appendActivity({ source: 'pipeline', name: pipelineName, summary: `Maker-checker "${pipelineName}" APPROVED after ${iteration} iteration(s)`, level: 'info' })
      return { cost: accumulatedCost, sessionId: lastMakerSessionId }
    }

    prevFeedback = verdict || 'Checker did not write a verdict — please review your work carefully.'
    plog(pipelineName, `maker-checker: not approved (${maxIterations - iteration} retries left)`)
  }

  plog(pipelineName, `maker-checker: exhausted ${maxIterations} iterations without approval`)
  appendActivity({ source: 'pipeline', name: pipelineName, summary: `Maker-checker "${pipelineName}" exhausted ${maxIterations} iterations without approval`, level: 'warn' })
  return { cost: accumulatedCost, sessionId: lastMakerSessionId }
}

/**
 * Run a diff-review stage: fetch git diff, dispatch to a reviewer session, check for
 * APPROVED/LGTM. If not approved and auto_fix is set, launch a fixer session and retry.
 * On final failure, creates an approval gate with the review text.
 */
export async function runDiffReview(action: ActionDef, ctx: TriggerContext, pipelineName: string): Promise<{ cost: number; responseSnippet?: string; sessionId?: string }> {
  const {
    diffBase = 'HEAD~1',
    prompt = 'Review this diff for issues. Reply APPROVED if clean, or list issues.',
    autoFix = false,
    autoFixMaxIterations = 2,
  } = action
  const cwd = (resolveTemplate(action.workingDirectory || '', ctx) || undefined)?.replace(/^~/, app.getPath('home'))

  if (!cwd) {
    throw new Error(`diff-review: workingDirectory is required for git diff`)
  }

  // Validate diff_base ref
  try {
    await execFileAsync('git', ['rev-parse', '--verify', diffBase], { cwd, timeout: 10_000 })
  } catch (err: any) {
    throw new Error(`diff-review: invalid diff_base ref "${diffBase}": ${err?.stderr?.trim() || 'not found'}`)
  }

  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const runDir = join(COLONY_DIR, 'diff-reviews', runId)
  await fsp.mkdir(runDir, { recursive: true })
  const verdictFile = join(runDir, 'review-verdict.md')
  const baseName = resolveTemplate(action.name || pipelineName, ctx)
  let accumulatedCost = 0
  let lastResponseSnippet: string | undefined
  let firstReviewerSessionId: string | undefined

  const maxIterations = autoFix ? autoFixMaxIterations : 0

  for (let iteration = 0; iteration <= maxIterations; iteration++) {
    // Get diff
    let diff = ''
    try {
      const diffResult = await execFileAsync('git', ['diff', diffBase], { cwd, timeout: 30_000, maxBuffer: 10 * 1024 * 1024 })
      diff = diffResult.stdout || ''
    } catch { /* empty diff */ }
    if (Buffer.byteLength(diff, 'utf-8') > MAX_DIFF_BYTES) {
      const truncBytes = Buffer.from(diff).slice(0, MAX_DIFF_BYTES).toString('utf-8')
      const totalLines = diff.split('\n').length
      const keptLines = truncBytes.split('\n').length
      diff = truncBytes + `\n[... ${totalLines - keptLines} lines truncated]`
    }

    if (!diff.trim()) {
      plog(pipelineName, `diff-review: no diff found against "${diffBase}" — nothing to review`)
      return { cost: accumulatedCost, responseSnippet: 'No changes', sessionId: firstReviewerSessionId }
    }

    const resolvedPrompt = resolveTemplate(prompt, ctx)
    const fullPrompt =
      `--- Git Diff (${diffBase}) ---\n\`\`\`diff\n${diff}\n\`\`\`\n--- End Diff ---\n\n` +
      `${resolvedPrompt}\n\n` +
      `--- Required Output ---\nWrite your verdict to:\n${verdictFile}\n\n` +
      `If the diff looks clean, write exactly: APPROVED\n` +
      `If there are issues, write: NEEDS REVISION: <your specific feedback>\n\n` +
      `This file MUST be written before you finish.`

    try { await fsp.writeFile(verdictFile, '', 'utf-8') } catch { /* ignore */ }

    const reviewerName = iteration === 0 ? `${baseName} [Diff Review]` : `${baseName} [Diff Review ${iteration + 1}]`
    plog(pipelineName, `diff-review: launching reviewer "${reviewerName}" (iteration ${iteration + 1}/${maxIterations + 1})`)

    const promptFile = await writePromptFile(fullPrompt)
    const reviewerInst = await createInstance({
      name: reviewerName,
      workingDirectory: cwd,
      color: action.color,
      args: ['--append-system-prompt-file', promptFile],
      model: action.model,
    })
    if (!firstReviewerSessionId) firstReviewerSessionId = reviewerInst.id

    const completionPromise = waitForSessionCompletion(reviewerInst.id)
    await sendPromptWhenReady(reviewerInst.id, { prompt: 'Execute the instructions in your system prompt. Begin now.' })
    const reviewDone = await completionPromise

    if (!reviewDone) {
      plog(pipelineName, `diff-review: reviewer timed out`)
      appendActivity({ source: 'pipeline', name: pipelineName, summary: `Diff review "${pipelineName}" reviewer timed out`, level: 'error' })
      return { cost: accumulatedCost, sessionId: firstReviewerSessionId }
    }

    const reviewerState = await getDaemonClient().getInstance(reviewerInst.id)
    accumulatedCost += reviewerState?.tokenUsage.cost ?? 0
    tagArtifactPipeline(reviewerInst.id, runId).catch(() => {})

    let verdict = ''
    try { verdict = await pathExists(verdictFile) ? (await fsp.readFile(verdictFile, 'utf-8')).trim() : '' } catch { /* ignore */ }
    plog(pipelineName, `diff-review: verdict: ${verdict.slice(0, 120)}`)
    lastResponseSnippet = verdict.slice(0, 120)

    if (isApproved(verdict)) {
      plog(pipelineName, `diff-review: APPROVED`)
      appendActivity({ source: 'pipeline', name: pipelineName, summary: `Diff review "${pipelineName}" approved`, level: 'info' })
      return { cost: accumulatedCost, responseSnippet: lastResponseSnippet, sessionId: firstReviewerSessionId }
    }

    // Not approved — auto_fix: launch fixer and loop
    if (iteration < maxIterations) {
      plog(pipelineName, `diff-review: not approved — auto_fix ${iteration + 1}/${maxIterations}`)
      const fixPrompt =
        `The following code diff was reviewed and needs changes:\n\n\`\`\`diff\n${diff}\n\`\`\`\n\n` +
        `Reviewer feedback:\n${verdict}\n\n` +
        `Please address the feedback and make the necessary changes.`
      const fixerPromptFile = await writePromptFile(fixPrompt)
      const fixerInst = await createInstance({
        name: `${baseName} [Auto-fix ${iteration + 1}]`,
        workingDirectory: cwd,
        color: action.color,
        args: ['--append-system-prompt-file', fixerPromptFile],
        model: action.model,
      })
      const fixerCompletion = waitForSessionCompletion(fixerInst.id)
      await sendPromptWhenReady(fixerInst.id, { prompt: 'Execute the instructions in your system prompt. Begin now.' })
      const fixerDone = await fixerCompletion
      if (!fixerDone) {
        plog(pipelineName, `diff-review: fixer timed out on iteration ${iteration + 1}`)
        break
      }
      const fixerState = await getDaemonClient().getInstance(fixerInst.id)
      accumulatedCost += fixerState?.tokenUsage.cost ?? 0
      continue
    }
  }

  // Failed — create an approval gate with the review text
  plog(pipelineName, `diff-review: not approved — creating approval gate`)
  const reviewText = lastResponseSnippet || 'Review failed'
  const approvalId = `diff-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const summary = `Diff review failed — "${pipelineName}": ${reviewText.slice(0, 100)}`
  const expiresAt = new Date(Date.now() + APPROVAL_DEFAULT_TTL_HOURS * 3600 * 1000).toISOString()
  const request: ApprovalRequest = {
    id: approvalId,
    pipelineName,
    summary,
    resolvedVars: { diffBase, reviewText: reviewText.slice(0, 500) },
    createdAt: new Date().toISOString(),
    expiresAt,
  }
  pendingApprovals.set(approvalId, { request, action, ctx, dedupKey: approvalId })
  pendingApprovalKeys.add(approvalId)
  broadcast('pipeline:approval:new', request)
  appendActivity({ source: 'pipeline', name: pipelineName, summary: `Diff review "${pipelineName}" needs attention: ${reviewText.slice(0, 100)}`, level: 'warn' })
  notify(`Colony: Diff Review — ${pipelineName}`, summary, 'pipelines')

  return { cost: accumulatedCost, responseSnippet: lastResponseSnippet, sessionId: firstReviewerSessionId }
}

/**
 * Run a pre-execution planning stage: dispatch to an agent session, collect its plan output,
 * then gate on human approval (by default) before the pipeline continues.
 * Writes the plan to an artifact file so subsequent stages can consume it via handoffInputs.
 */
export async function runPlanStage(action: ActionDef, ctx: TriggerContext, pipelineName: string): Promise<{ cost: number; responseSnippet?: string; sessionId?: string }> {
  const planKeyword = action.plan_keyword ?? 'PLAN_READY'
  const requireApproval = action.require_approval !== false // default true
  const rawPrompt = resolveTemplate(action.prompt || '', ctx)
  const cwd = resolveTemplate(action.workingDirectory || '', ctx) || undefined
  const resolvedCwd = cwd?.replace(/^~/, app.getPath('home'))

  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const safePipelineName = pipelineName.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase()
  const planDir = join(COLONY_DIR, 'plan-stages', safePipelineName, runId)
  await fsp.mkdir(planDir, { recursive: true })
  const planOutputFile = join(planDir, 'plan-output.md')

  const artifactsDir = join(COLONY_DIR, 'artifacts')
  await fsp.mkdir(artifactsDir, { recursive: true })
  const artifactName = `${safePipelineName}-${runId}-implementation-plan`
  const artifactPath = join(artifactsDir, `${artifactName}.txt`)

  const fullPrompt =
    `${rawPrompt}\n\n` +
    `--- Output Instructions ---\n` +
    `Write your complete plan to:\n${planOutputFile}\n\n` +
    `When your plan is fully written to that file, output the keyword: ${planKeyword}\n\n` +
    `The plan file MUST be written before you finish.`

  const baseName = resolveTemplate(action.name || pipelineName, ctx)
  const plannerName = `Pipe (${baseName}) [Plan]`
  plog(pipelineName, `plan-stage: launching planner "${plannerName}"`)

  const promptFile = await writePromptFile(fullPrompt)
  const plannerInst = await createInstance({
    name: plannerName,
    workingDirectory: resolvedCwd,
    color: action.color,
    args: ['--append-system-prompt-file', promptFile],
    mcpServers: action.mcpServers,
    model: action.model,
  })

  const completionPromise = waitForSessionCompletion(plannerInst.id, 5 * 60 * 1000)
  await sendPromptWhenReady(plannerInst.id, { prompt: 'Execute the instructions in your system prompt. Begin now.' })
  const plannerDone = await completionPromise

  const plannerFinalState = await getDaemonClient().getInstance(plannerInst.id)
  const cost = plannerFinalState?.tokenUsage.cost ?? 0
  tagArtifactPipeline(plannerInst.id, runId).catch(() => {})

  let planContent = ''
  if (plannerDone) {
    try {
      planContent = await pathExists(planOutputFile) ? (await fsp.readFile(planOutputFile, 'utf-8')).trim() : ''
    } catch { planContent = '' }
  }

  if (!planContent) {
    const reason = !plannerDone ? 'timed out after 5 minutes' : 'did not write output file'
    planContent = `(Planning session ${reason})`
    plog(pipelineName, `plan-stage: warning — ${reason}`)
    appendActivity({ source: 'pipeline', name: pipelineName, summary: `Pipeline "${pipelineName}" plan stage: ${reason}`, level: 'warn' })
  }

  await fsp.writeFile(artifactPath, planContent, 'utf-8')
  plog(pipelineName, `plan-stage: artifact written: ${artifactName}`)

  const snippetRaw = planContent.slice(0, 120)
  const responseSnippet = planContent.length > 120 ? snippetRaw + '…' : snippetRaw

  if (!requireApproval) {
    plog(pipelineName, `plan-stage: require_approval=false — proceeding automatically`)
    appendActivity({ source: 'pipeline', name: pipelineName, summary: `Pipeline "${pipelineName}" plan complete — proceeding automatically`, level: 'info' })
    return { cost, responseSnippet, sessionId: plannerInst.id }
  }

  // Create a blocking approval gate — resolves when approved, rejects when dismissed/expired
  const approvalId = `plan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const truncatedPlan = planContent.length > 2000 ? planContent.slice(0, 2000) + '\n[...truncated]' : planContent

  const request: ApprovalRequest = {
    id: approvalId,
    pipelineName,
    summary: `Implementation plan ready — approve to continue`,
    resolvedVars: {
      'plan.content': truncatedPlan,
      'plan.artifact': artifactName,
    },
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + APPROVAL_DEFAULT_TTL_HOURS * 3600 * 1000).toISOString(),
  }

  return new Promise((resolve, rejectPromise) => {
    pendingApprovals.set(approvalId, {
      request,
      action,
      ctx,
      dedupKey: approvalId,
      resolve: () => resolve({ cost, responseSnippet, sessionId: plannerInst.id }),
      reject: (reason: string) => rejectPromise(new Error(reason)),
    })
    pendingApprovalKeys.add(approvalId)
    broadcast('pipeline:approval:new', request)
    plog(pipelineName, `plan-stage: awaiting approval ${approvalId}`)
    appendActivity({ source: 'pipeline', name: pipelineName, summary: `Pipeline "${pipelineName}" waiting for plan approval`, level: 'warn' })
    notify(`Colony: Plan approval needed`, `Pipeline "${pipelineName}" — Approve plan to proceed?`, 'pipelines')
  })
}

/**
 * Dispatch all sub-stages concurrently (Promise.allSettled or Promise.all).
 * Returns total cost + per-sub-stage trace for the history record.
 */
export async function runParallel(
  action: ActionDef,
  ctx: TriggerContext,
  pipelineName: string,
  fireAction: (action: ActionDef, ctx: TriggerContext, pipelineName: string) => Promise<{ cost: number; sessionId?: string }>,
): Promise<{ cost: number; subStages: PipelineStageTrace[] }> {
  const { stages = [], fail_fast = true } = action
  const baseName = resolveTemplate(action.name || pipelineName, ctx)
  plog(pipelineName, `parallel: dispatching ${stages.length} sub-stage(s)`)

  const subStages: PipelineStageTrace[] = new Array(stages.length)

  const tasks = stages.map((subAction, i) => async (): Promise<{ cost: number; i: number }> => {
    const start = Date.now()
    const sessionName = resolveTemplate(subAction.name || `${baseName} [${i + 1}]`, ctx)
    let stageError: string | undefined
    let stageCost = 0
    let stageSessionId: string | undefined
    try {
      const result = await fireAction(subAction, ctx, pipelineName)
      stageCost = result.cost
      stageSessionId = result.sessionId
    } catch (err) {
      stageError = String(err)
      throw err
    } finally {
      const end = Date.now()
      subStages[i] = {
        index: i,
        actionType: subAction.type,
        sessionName,
        sessionId: stageSessionId,
        durationMs: end - start,
        startedAt: start,
        completedAt: end,
        success: !stageError,
        error: stageError,
      }
    }
    return { cost: stageCost, i }
  })

  let totalCost = 0

  if (fail_fast) {
    // Promise.all semantics: abort on first failure
    const results = await Promise.all(tasks.map(t => t()))
    totalCost = results.reduce((sum, r) => sum + r.cost, 0)
  } else {
    // Promise.allSettled semantics: run all regardless of failures
    const settled = await Promise.allSettled(tasks.map(t => t()))
    for (const r of settled) {
      if (r.status === 'fulfilled') totalCost += r.value.cost
    }
  }

  return { cost: totalCost, subStages }
}

/**
 * Poll until a named session exits, optionally writing its exit reason to an artifact.
 * Tolerates "not found" for first 30s (session may not have launched yet).
 * Transient daemon disconnects are ignored — polling continues.
 */
export async function runWaitForSession(
  action: ActionDef,
  pipelineName: string
): Promise<{ cost: number; responseSnippet?: string }> {
  const sessionName = action.session_name || ''
  const timeoutMs = (action.timeout_minutes ?? 30) * 60_000
  const GRACE_MS = 30_000
  const POLL_INTERVAL_MS = 5_000
  const startedAt = Date.now()

  plog(pipelineName, `wait_for_session: waiting for "${sessionName}" (timeout ${action.timeout_minutes ?? 30}m)`)

  return new Promise((resolve, reject) => {
    let intervalId: ReturnType<typeof setInterval>

    const check = async () => {
      const elapsed = Date.now() - startedAt

      if (elapsed >= timeoutMs) {
        clearInterval(intervalId)
        reject(new Error(`wait_for_session: timeout after ${action.timeout_minutes ?? 30}m waiting for "${sessionName}"`))
        return
      }

      let instances: import('../shared/types').ClaudeInstance[] = []
      try {
        instances = await getAllInstances()
      } catch {
        return // transient daemon disconnect — keep polling
      }

      const target = instances.find(i => i.name === sessionName)

      if (!target) {
        if (elapsed < GRACE_MS) return // grace period — session may not have launched yet
        clearInterval(intervalId)
        reject(new Error(`wait_for_session: session "${sessionName}" not found after grace period`))
        return
      }

      if (target.status === 'exited') {
        clearInterval(intervalId)
        const exitNote = target.exitCode === 0 || target.exitCode === null
          ? 'exited cleanly'
          : `exited with code ${target.exitCode}`

        if (action.artifact_output) {
          try {
            const artifactsDir = join(COLONY_DIR, 'artifacts')
            await fsp.mkdir(artifactsDir, { recursive: true })
            await fsp.writeFile(join(artifactsDir, `${action.artifact_output}.txt`), exitNote, 'utf-8')
          } catch (err) {
            log(`wait_for_session: failed to write artifact: ${err}`)
          }
        }

        resolve({ cost: 0, responseSnippet: `"${sessionName}" ${exitNote}` })
      }
    }

    check() // immediate check before first interval tick
    intervalId = setInterval(check, POLL_INTERVAL_MS)
  })
}

/**
 * Run a best-of-n action: spawn N sessions in separate worktrees, wait for all
 * to complete, then judge which output is best. Winner's worktree is preserved;
 * losers are cleaned up.
 */
export async function runBestOfN(
  action: ActionDef,
  ctx: TriggerContext,
  pipelineName: string,
): Promise<{ cost: number; subStages: PipelineStageTrace[] }> {
  const n = Math.max(2, Math.min(8, action.n ?? 3))
  const repo = action.repo
  if (!repo) throw new Error(`best-of-n: "repo" is required`)
  const branch = action.branch || 'main'
  const judge = action.judge
  if (!judge) throw new Error(`best-of-n: "judge" is required`)
  const keepWinner = action.keep_winner !== false
  const baseName = resolveTemplate(action.name || pipelineName, ctx)
  const prompt = resolveTemplate(action.prompt || '', ctx)

  plog(pipelineName, `best-of-n: spawning ${n} contestants on ${repo.owner}/${repo.name}:${branch}`)

  // 1. Create worktrees + sessions
  const contestants: Array<{ worktreeId: string; worktreePath: string; instanceId: string }> = []
  const subStages: PipelineStageTrace[] = new Array(n)

  for (let i = 0; i < n; i++) {
    const wt = await createWorktree(repo.owner, repo.name, branch, `bon-${i + 1}`)
    const model = action.models?.[i] ?? action.model ?? undefined
    const inst = await createInstance({
      name: `${baseName} [${i + 1}/${n}]`,
      workingDirectory: wt.path,
      ...(model ? { args: ['--model', model] } : {}),
    })
    contestants.push({ worktreeId: wt.id, worktreePath: wt.path, instanceId: inst.id })
  }

  // 2. Attach completion listeners BEFORE sending prompts (avoids race)
  const completionPromises = contestants.map((c, i) => {
    const start = Date.now()
    return waitForSessionCompletion(c.instanceId, (action.timeout_minutes ?? 30) * 60_000)
      .then(completed => {
        const end = Date.now()
        subStages[i] = {
          index: i,
          actionType: 'best-of-n',
          sessionName: `${baseName} [${i + 1}/${n}]`,
          sessionId: c.instanceId,
          model: action.models?.[i] ?? action.model,
          durationMs: end - start,
          startedAt: start,
          completedAt: end,
          success: completed,
          error: completed ? undefined : 'timeout',
        }
        return completed
      })
  })

  // 3. Send prompts
  for (const c of contestants) {
    sendPromptWhenReady(c.instanceId, { prompt })
  }

  // 4. Wait for all to finish
  await Promise.allSettled(completionPromises)
  plog(pipelineName, `best-of-n: all ${n} contestants finished`)

  // 5. Run judge
  let winnerIdx = 0
  if (judge.type === 'command' && judge.cmd) {
    // Command judge: run command in each worktree, winner = exit code 0 (first clean)
    const results: Array<{ exitCode: number; stdout: string }> = []
    for (let i = 0; i < n; i++) {
      try {
        const { stdout } = await execFileAsync('sh', ['-c', judge.cmd], {
          cwd: contestants[i].worktreePath,
          timeout: 300_000,
          maxBuffer: 2 * 1024 * 1024,
        })
        results.push({ exitCode: 0, stdout: stdout.trim() })
      } catch (err: any) {
        results.push({ exitCode: err?.code ?? 1, stdout: (err?.stdout || '').trim() })
      }
    }
    // Winner: first with exit code 0; if none, first with lowest exit code
    const cleanIdx = results.findIndex(r => r.exitCode === 0)
    if (cleanIdx >= 0) {
      winnerIdx = cleanIdx
    } else {
      winnerIdx = results.reduce((best, r, i) => r.exitCode < results[best].exitCode ? i : best, 0)
    }
    plog(pipelineName, `best-of-n: command judge picked slot ${winnerIdx + 1} (exit codes: ${results.map(r => r.exitCode).join(', ')})`)
  } else if (judge.type === 'llm' && judge.prompt) {
    // LLM judge: launch a judge session with all outputs as artifacts
    const artifactsDir = join(COLONY_DIR, 'artifacts')
    await fsp.mkdir(artifactsDir, { recursive: true })
    for (let i = 0; i < n; i++) {
      const summary = subStages[i]?.success
        ? `Contestant ${i + 1} completed successfully.`
        : `Contestant ${i + 1} timed out or failed.`
      await fsp.writeFile(join(artifactsDir, `bon-slot-${i + 1}.txt`), summary, 'utf-8')
    }

    const judgePromptFull = `You are judging a best-of-${n} competition.\n\n${resolveTemplate(judge.prompt, ctx)}\n\nAfter evaluating all contestants, respond with WINNER: <slot-number> (e.g., WINNER: 1).`
    const judgeInst = await createInstance({
      name: `${baseName} [Judge]`,
      workingDirectory: contestants[0].worktreePath,
    })

    const judgeReady = waitForSessionCompletion(judgeInst.id, 600_000)
    sendPromptWhenReady(judgeInst.id, { prompt: judgePromptFull })
    await judgeReady

    // Parse WINNER: N from judge output (best-effort via artifact)
    const verdictPath = join(COLONY_DIR, 'artifacts', `bon-judge-verdict.txt`)
    if (await pathExists(verdictPath)) {
      const verdict = await fsp.readFile(verdictPath, 'utf-8')
      const match = verdict.match(/WINNER:\s*(\d+)/i)
      if (match) {
        const parsed = parseInt(match[1], 10) - 1
        if (parsed >= 0 && parsed < n) winnerIdx = parsed
      }
    }
    plog(pipelineName, `best-of-n: llm judge picked slot ${winnerIdx + 1}`)
  }

  // 6. Record in arena-stats.json
  try {
    const stats = await readArenaStats()
    const winnerKey = action.models?.[winnerIdx] || action.model || 'default'
    if (!stats[winnerKey]) stats[winnerKey] = { wins: 0, losses: 0, totalRuns: 0 }
    stats[winnerKey].wins++
    stats[winnerKey].totalRuns++
    for (let i = 0; i < n; i++) {
      if (i === winnerIdx) continue
      const loserKey = action.models?.[i] || action.model || 'default'
      if (!stats[loserKey]) stats[loserKey] = { wins: 0, losses: 0, totalRuns: 0 }
      stats[loserKey].losses++
      stats[loserKey].totalRuns++
    }
    await writeArenaStats(stats)
  } catch (err) {
    log(`best-of-n: failed to update arena stats: ${err}`)
  }

  // 7. Clean up losing worktrees; preserve winner
  for (let i = 0; i < n; i++) {
    if (i === winnerIdx && keepWinner) continue
    try {
      await killInstance(contestants[i].instanceId)
    } catch { /* already gone */ }
    try {
      await removeWorktree(contestants[i].worktreeId)
    } catch (err) {
      log(`best-of-n: failed to remove worktree ${contestants[i].worktreeId}: ${err}`)
    }
  }

  // 8. Write winner artifact
  const artifactsDir = join(COLONY_DIR, 'artifacts')
  await fsp.mkdir(artifactsDir, { recursive: true })
  const safeName = pipelineName.replace(/[^a-zA-Z0-9]/g, '-')
  await fsp.writeFile(
    join(artifactsDir, `${safeName}-best-of-n-winner.txt`),
    `Winner: slot ${winnerIdx + 1}\nWorktree: ${contestants[winnerIdx].worktreePath}\nSession: ${contestants[winnerIdx].instanceId}`,
    'utf-8',
  )

  const totalCost = subStages.reduce((s, t) => s + (t ? 0 : 0), 0) // cost tracked externally per-session
  plog(pipelineName, `best-of-n: complete — winner slot ${winnerIdx + 1}, ${keepWinner ? 'preserved' : 'cleaned up'}`)
  return { cost: totalCost, subStages: subStages.filter(Boolean) }
}
