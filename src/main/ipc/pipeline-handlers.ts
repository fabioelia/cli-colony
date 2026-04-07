import { ipcMain, app } from 'electron'
import * as fs from 'fs'
import { join } from 'path'
import { spawn } from 'child_process'
import { colonyPaths } from '../../shared/colony-paths'
import {
  getPipelineList, togglePipeline, triggerPollNow, getPipelinesDir,
  getPipelineContent, savePipelineContent, loadPipelines, setPipelineCron,
  previewPipeline, listApprovals, approveAction, dismissAction, getHistory,
} from '../pipeline-engine'

const PIPELINE_SCHEMA_PROMPT = `You are a pipeline YAML generator for Claude Colony.

Reply with ONLY the raw YAML pipeline file. No markdown fences. No explanations. Start with 'name:'.

Pipeline YAML schema summary:
- name: string (required) — human-readable name
- description: string — one-line description
- enabled: boolean (default true)
- trigger: (required)
    type: cron | webhook | file_watch | git-poll
    cron: "0 9 * * 1-5"  # for type: cron
    interval: 300         # for type: git-poll (seconds)
    repos: auto           # for type: git-poll
    path: "./src"         # for type: file_watch
- condition:
    type: always | pr_opened | pr_merged | new_commits
- action OR actions: (use 'action' for single stage, 'actions' list for multi-stage)
    type: session | plan | diff_review | maker_checker | parallel | wait_for_session
    name: string           # stage name
    prompt: |              # the prompt/instructions
      ...
    workingDirectory: "~/" # where to run
    model: claude-haiku-4-5-20251001  # optional model override
    artifacts: ["output.md"]  # files the stage should produce
    require_approval: true    # pause for human approval
    handoffInputs: ["stage1"] # inputs from previous stage artifacts
  # For type: plan — planning stage that produces a plan artifact and waits for approval
  # For type: diff_review — code review with auto_fix loop
  #   diff_base: HEAD~1, prompt: ..., auto_fix: true, max_iterations: 2
  # For type: maker_checker — two agents: maker produces, checker reviews
  #   maker_prompt, checker_prompt, verdict_file, auto_fix: true
  # For type: parallel — fan-out: sub-stages run concurrently
  #   fail_fast: true, stages: [{ name, type, prompt, ... }]
  # For type: wait_for_session — blocks until named session exits
  #   session_name: "Deploy Worker", timeout_minutes: 30, artifact_output: output.md
- budget:
    max_cost_usd: 0.50
    warn_at: 0.30

Example 1 — nightly cron session:
name: Nightly Dependency Audit
description: Check for outdated packages every night
enabled: true
trigger:
  type: cron
  cron: "0 2 * * *"
condition:
  type: always
action:
  type: session
  workingDirectory: "~/"
  prompt: |
    Check for outdated npm dependencies. Run npm outdated. Write a summary to ~/.claude-colony/outputs/dependency-audit.md.

Example 2 — PR review on webhook + diff_review:
name: PR Code Review
description: Auto-review PRs on open
enabled: true
trigger:
  type: webhook
condition:
  type: pr_opened
actions:
  - type: plan
    name: Plan review
    prompt: |
      Analyse the PR diff and write a structured review plan.
    workingDirectory: "~/"
    artifacts: ["plan.md"]
  - type: diff_review
    name: Review
    workingDirectory: "~/"
    diff_base: HEAD~1
    prompt: Review this diff for correctness, security, and code quality.
    auto_fix: false

Example 3 — maker-checker with git-poll:
name: Weekly Refactor Check
description: Weekly automated refactor + quality check
enabled: true
trigger:
  type: cron
  cron: "0 10 * * 1"
condition:
  type: always
actions:
  - type: maker_checker
    name: Refactor Review
    workingDirectory: "~/projects/myapp"
    maker_prompt: |
      Identify one small refactor opportunity in src/. Apply it.
    checker_prompt: |
      Review the refactor. Is it safe? Does it improve clarity?
    auto_fix: true

User description: `

export function registerPipelineHandlers(): void {
  ipcMain.handle('pipeline:list', () => getPipelineList())
  ipcMain.handle('pipeline:toggle', (_e, name: string, enabled: boolean) => togglePipeline(name, enabled))
  ipcMain.handle('pipeline:triggerNow', (_e, name: string) => triggerPollNow(name))
  ipcMain.handle('pipeline:getDir', () => getPipelinesDir())
  ipcMain.handle('pipeline:getContent', (_e, fileName: string) => getPipelineContent(fileName))
  ipcMain.handle('pipeline:saveContent', (_e, fileName: string, content: string) => savePipelineContent(fileName, content))
  ipcMain.handle('pipeline:reload', () => { loadPipelines(); return getPipelineList() })
  ipcMain.handle('pipeline:setCron', (_e, fileName: string, cron: string | null) => setPipelineCron(fileName, cron))
  ipcMain.handle('pipeline:preview', (_e, fileName: string) => previewPipeline(fileName))
  ipcMain.handle('pipeline:listApprovals', () => listApprovals())
  ipcMain.handle('pipeline:approve', (_e, id: string) => approveAction(id))
  ipcMain.handle('pipeline:dismiss', (_e, id: string) => dismissAction(id))
  ipcMain.handle('pipeline:getHistory', (_e, name: string) => getHistory(name))

  // Pipeline outputs
  ipcMain.handle('pipeline:listOutputs', (_e, outputDir: string) => {
    const resolved = outputDir.replace(/^~/, app.getPath('home'))
    if (!fs.existsSync(resolved)) return []
    try {
      const scanDir = (dir: string, prefix = ''): Array<{ name: string; path: string; size: number; modified: number }> => {
        const results: Array<{ name: string; path: string; size: number; modified: number }> = []
        for (const entry of fs.readdirSync(dir)) {
          const full = join(dir, entry)
          try {
            const stat = fs.statSync(full)
            if (stat.isDirectory()) {
              results.push(...scanDir(full, prefix ? `${prefix}/${entry}` : entry))
            } else {
              results.push({
                name: prefix ? `${prefix}/${entry}` : entry,
                path: full,
                size: stat.size,
                modified: stat.mtimeMs,
              })
            }
          } catch { /* skip */ }
        }
        return results
      }
      return scanDir(resolved).sort((a, b) => b.modified - a.modified)
    } catch { return [] }
  })

  // Pipeline memory
  const PIPELINES_DIR_MEM = colonyPaths.pipelines
  ipcMain.handle('pipeline:getMemory', (_e, fileName: string) => {
    const memPath = join(PIPELINES_DIR_MEM, `${fileName.replace(/\.(yaml|yml)$/, '')}.memory.md`)
    return fs.existsSync(memPath) ? fs.readFileSync(memPath, 'utf-8') : ''
  })
  ipcMain.handle('pipeline:saveMemory', (_e, fileName: string, content: string) => {
    if (!fs.existsSync(PIPELINES_DIR_MEM)) fs.mkdirSync(PIPELINES_DIR_MEM, { recursive: true })
    const memPath = join(PIPELINES_DIR_MEM, `${fileName.replace(/\.(yaml|yml)$/, '')}.memory.md`)
    fs.writeFileSync(memPath, content, 'utf-8')
    return true
  })

  // Create a pipeline from generated YAML (Automation Wizard)
  ipcMain.handle('pipeline:createFromTemplate', (_e, yaml: string, slug: string): boolean => {
    if (!yaml || typeof yaml !== 'string' || yaml.trim().length === 0) return false
    if (!slug || typeof slug !== 'string') return false
    // Reject path traversal
    if (slug.includes('/') || slug.includes('\\') || slug.includes('..')) return false
    const pipelinesDir = colonyPaths.pipelines
    if (!fs.existsSync(pipelinesDir)) fs.mkdirSync(pipelinesDir, { recursive: true })
    // Find non-colliding filename
    let candidate = `${slug}.yaml`
    let suffix = 2
    while (fs.existsSync(join(pipelinesDir, candidate))) {
      candidate = `${slug}-${suffix}.yaml`
      suffix++
    }
    fs.writeFileSync(join(pipelinesDir, candidate), yaml, 'utf-8')
    loadPipelines()
    return true
  })

  // Generate pipeline YAML from a natural language description using claude-haiku
  ipcMain.handle('pipeline:generate', (_e, description: string): Promise<string> => {
    if (!description || typeof description !== 'string' || !description.trim()) {
      return Promise.resolve('')
    }
    const fullPrompt = PIPELINE_SCHEMA_PROMPT + description.trim()
    return new Promise((resolve) => {
      const proc = spawn('claude', ['-p', fullPrompt, '--model', 'claude-haiku-4-5-20251001'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
      })
      let out = ''
      proc.stdout.on('data', (chunk: Buffer) => { out += chunk.toString() })
      proc.on('close', () => {
        const raw = out.trim()
        // Strip markdown fences if the model added them
        const cleaned = raw.replace(/^```(?:yaml)?\s*/i, '').replace(/\s*```$/, '').trim()
        resolve(cleaned || raw)
      })
      proc.on('error', () => resolve(''))
    })
  })
}
