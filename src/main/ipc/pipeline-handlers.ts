import { ipcMain, app, dialog } from 'electron'
import { promises as fsp, createWriteStream, createReadStream } from 'fs'
import { join, basename } from 'path'
import { spawn } from 'child_process'
import { resolveCommand } from '../resolve-command'
import archiver from 'archiver'
import * as unzipper from 'unzipper'
import { colonyPaths } from '../../shared/colony-paths'
import {
  getPipelineList, togglePipeline, triggerPollNow, getPipelinesDir,
  getPipelineContent, savePipelineContent, loadPipelines, setPipelineCron,
  previewPipeline, listApprovals, approveAction, dismissAction, getHistory, searchAllHistory,
} from '../pipeline-engine'
import { getPipelineNotes, addPipelineNote, deletePipelineNote, updatePipelineNote } from '../pipeline-notes'

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
  ipcMain.handle('pipeline:triggerNow', (_e, name: string, overrides?: string | { prompt?: string; model?: string; workingDirectory?: string; maxBudget?: number }) => triggerPollNow(name, overrides))
  ipcMain.handle('pipeline:getDir', () => getPipelinesDir())
  ipcMain.handle('pipeline:delete', async (_e, fileName: string) => {
    if (!fileName || fileName.includes('..') || fileName.includes('/') || fileName.includes('\\')) return false
    const dir = await getPipelinesDir()
    const base = fileName.replace(/\.(yaml|yml)$/, '')
    const targets = [
      join(dir, fileName),
      join(dir, `${base}.memory.md`),
      join(dir, `${base}.readme.md`),
      join(dir, `${base}.debug.json`),
      join(dir, `${base}.state.json`),
      join(dir, `${base}.notes.json`),
    ]
    for (const f of targets) {
      try { await fsp.unlink(f) } catch { /* ignore missing */ }
    }
    await loadPipelines()
    return true
  })
  ipcMain.handle('pipeline:getContent', (_e, fileName: string) => {
    if (!fileName || fileName.includes('..') || fileName.includes('/') || fileName.includes('\\')) return null
    return getPipelineContent(fileName)
  })
  ipcMain.handle('pipeline:saveContent', (_e, fileName: string, content: string) => {
    if (!fileName || fileName.includes('..') || fileName.includes('/') || fileName.includes('\\')) return false
    return savePipelineContent(fileName, content)
  })
  ipcMain.handle('pipeline:reload', async () => { await loadPipelines(); return getPipelineList() })
  ipcMain.handle('pipeline:setCron', (_e, fileName: string, cron: string | null) => {
    if (!fileName || fileName.includes('..') || fileName.includes('/') || fileName.includes('\\')) return false
    return setPipelineCron(fileName, cron)
  })
  ipcMain.handle('pipeline:preview', (_e, fileName: string) => {
    if (!fileName || fileName.includes('..') || fileName.includes('/') || fileName.includes('\\')) return null
    return previewPipeline(fileName)
  })
  ipcMain.handle('pipeline:listApprovals', () => listApprovals())
  ipcMain.handle('pipeline:approve', (_e, id: string) => approveAction(id))
  ipcMain.handle('pipeline:dismiss', (_e, id: string) => dismissAction(id))
  ipcMain.handle('pipeline:getHistory', (_e, name: string) => getHistory(name))
  ipcMain.handle('pipeline:searchHistory', (_e, query: string) => searchAllHistory(query))

  ipcMain.handle('pipeline:export', async (_e, fileNames: string[]) => {
    const result = await dialog.showSaveDialog({
      defaultPath: 'pipelines.zip',
      filters: [{ name: 'ZIP', extensions: ['zip'] }],
    })
    if (result.canceled || !result.filePath) return false
    const dir = await getPipelinesDir()
    return new Promise<boolean>((resolve) => {
      const output = createWriteStream(result.filePath!)
      const archive = archiver('zip', { zlib: { level: 9 } })
      archive.pipe(output)
      for (const fn of fileNames) {
        const base = fn.replace(/\.(yaml|yml)$/, '')
        archive.file(join(dir, fn), { name: fn })
        for (const ext of ['.memory.md', '.readme.md', '.notes.json']) {
          try { archive.file(join(dir, base + ext), { name: base + ext }) } catch { /* skip */ }
        }
      }
      output.on('close', () => resolve(true))
      archive.on('error', () => resolve(false))
      archive.finalize()
    })
  })

  ipcMain.handle('pipeline:import', async () => {
    const result = await dialog.showOpenDialog({
      filters: [{ name: 'ZIP', extensions: ['zip'] }],
      properties: ['openFile'],
    })
    if (result.canceled || result.filePaths.length === 0) return 0
    const dir = await getPipelinesDir()
    await fsp.mkdir(dir, { recursive: true })
    return new Promise<number>((resolve) => {
      let count = 0
      createReadStream(result.filePaths[0])
        .pipe(unzipper.Parse())
        .on('entry', (entry: any) => {
          const name = basename(entry.path)
          if ((name.endsWith('.yaml') || name.endsWith('.yml') || name.endsWith('.md')) && !name.startsWith('.')) {
            count++
            entry.pipe(createWriteStream(join(dir, name)))
          } else {
            entry.autodrain()
          }
        })
        .on('close', async () => { await loadPipelines(); resolve(count) })
        .on('error', () => resolve(count))
    })
  })

  // Pipeline outputs
  ipcMain.handle('pipeline:listOutputs', async (_e, outputDir: string) => {
    const resolved = outputDir.replace(/^~/, app.getPath('home'))
    try {
      const MAX_DEPTH = 4
      const MAX_FILES = 500
      let totalFiles = 0
      const scanDir = async (dir: string, prefix = '', depth = 0): Promise<Array<{ name: string; path: string; size: number; modified: number }>> => {
        if (depth > MAX_DEPTH || totalFiles >= MAX_FILES) return []
        const results: Array<{ name: string; path: string; size: number; modified: number }> = []
        let entries: string[]
        try { entries = await fsp.readdir(dir) } catch { return results }
        for (const entry of entries) {
          if (totalFiles >= MAX_FILES) break
          const full = join(dir, entry)
          try {
            const stat = await fsp.stat(full)
            if (stat.isDirectory()) {
              results.push(...await scanDir(full, prefix ? `${prefix}/${entry}` : entry, depth + 1))
            } else {
              totalFiles++
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
      return (await scanDir(resolved)).sort((a, b) => b.modified - a.modified)
    } catch { return [] }
  })

  // Pipeline memory
  const PIPELINES_DIR_MEM = colonyPaths.pipelines
  ipcMain.handle('pipeline:getMemory', async (_e, fileName: string) => {
    if (!fileName || fileName.includes('..') || fileName.includes('/') || fileName.includes('\\')) return ''
    const memPath = join(PIPELINES_DIR_MEM, `${fileName.replace(/\.(yaml|yml)$/, '')}.memory.md`)
    try { return await fsp.readFile(memPath, 'utf-8') } catch { return '' }
  })
  ipcMain.handle('pipeline:saveMemory', async (_e, fileName: string, content: string) => {
    if (!fileName || fileName.includes('..') || fileName.includes('/') || fileName.includes('\\')) return false
    await fsp.mkdir(PIPELINES_DIR_MEM, { recursive: true })
    const memPath = join(PIPELINES_DIR_MEM, `${fileName.replace(/\.(yaml|yml)$/, '')}.memory.md`)
    await fsp.writeFile(memPath, content, 'utf-8')
    return true
  })

  // Pipeline notes (one-shot per-run steering)
  ipcMain.handle('pipeline:getNotes', (_e, fileName: string) => {
    if (!fileName || fileName.includes('..') || fileName.includes('/') || fileName.includes('\\')) return []
    return getPipelineNotes(fileName)
  })
  ipcMain.handle('pipeline:addNote', (_e, fileName: string, text: string) => {
    if (!fileName || fileName.includes('..') || fileName.includes('/') || fileName.includes('\\')) return false
    return addPipelineNote(fileName, text)
  })
  ipcMain.handle('pipeline:deleteNote', (_e, fileName: string, index: number) => {
    if (!fileName || fileName.includes('..') || fileName.includes('/') || fileName.includes('\\')) return false
    return deletePipelineNote(fileName, index)
  })
  ipcMain.handle('pipeline:updateNote', (_e, fileName: string, index: number, newText: string) => {
    if (!fileName || fileName.includes('..') || fileName.includes('/') || fileName.includes('\\')) return false
    return updatePipelineNote(fileName, index, newText)
  })

  ipcMain.handle('pipeline:listArtifacts', async (): Promise<Array<{ name: string; size: number; modifiedAt: string }>> => {
    try {
      const entries = await fsp.readdir(colonyPaths.artifacts)
      const results = await Promise.all(
        entries
          .filter(e => !e.startsWith('.'))
          .map(async (entry) => {
            const st = await fsp.stat(join(colonyPaths.artifacts, entry))
            return { name: entry, size: st.size, modifiedAt: st.mtime.toISOString() }
          })
      )
      return results.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
    } catch {
      return []
    }
  })

  ipcMain.handle('pipeline:readArtifact', async (_e, name: string): Promise<string | null> => {
    if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) return null
    try {
      const filePath = join(colonyPaths.artifacts, name)
      const buf = await fsp.readFile(filePath)
      const MAX = 50 * 1024
      if (buf.length > MAX) return buf.slice(0, MAX).toString('utf-8') + '\n\n[File truncated at 50KB]'
      return buf.toString('utf-8')
    } catch {
      return null
    }
  })

  // Create a pipeline from generated YAML (Automation Wizard)
  ipcMain.handle('pipeline:createFromTemplate', async (_e, yaml: string, slug: string): Promise<boolean> => {
    if (!yaml || typeof yaml !== 'string' || yaml.trim().length === 0) return false
    if (!slug || typeof slug !== 'string') return false
    // Reject path traversal
    if (slug.includes('/') || slug.includes('\\') || slug.includes('..')) return false
    const pipelinesDir = colonyPaths.pipelines
    await fsp.mkdir(pipelinesDir, { recursive: true })
    // Find non-colliding filename
    let candidate = `${slug}.yaml`
    let suffix = 2
    const existing = new Set(await fsp.readdir(pipelinesDir))
    while (existing.has(candidate)) {
      candidate = `${slug}-${suffix}.yaml`
      suffix++
    }
    await fsp.writeFile(join(pipelinesDir, candidate), yaml, 'utf-8')
    await loadPipelines()
    return true
  })

  // Generate pipeline YAML from a natural language description using claude-haiku
  ipcMain.handle('pipeline:generate', (_e, description: string): Promise<string> => {
    if (!description || typeof description !== 'string' || !description.trim()) {
      return Promise.resolve('')
    }
    const fullPrompt = PIPELINE_SCHEMA_PROMPT + description.trim()
    return new Promise((resolve) => {
      const proc = spawn(resolveCommand('claude'), ['-p', fullPrompt, '--model', 'claude-haiku-4-5-20251001'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
      })
      let out = ''
      let killed = false
      const killTimer = setTimeout(() => {
        killed = true
        proc.kill('SIGTERM')
      }, 30_000)
      proc.stdout.on('data', (chunk: Buffer) => { out += chunk.toString() })
      proc.on('close', () => {
        clearTimeout(killTimer)
        if (killed) {
          resolve('')
          return
        }
        const raw = out.trim()
        // Strip markdown fences if the model added them
        const cleaned = raw.replace(/^```(?:yaml)?\s*/i, '').replace(/\s*```$/, '').trim()
        resolve(cleaned || raw)
      })
      proc.on('error', () => { clearTimeout(killTimer); resolve('') })
    })
  })
}
