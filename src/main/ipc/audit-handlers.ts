import { ipcMain } from 'electron'
import { execFile } from 'child_process'
import { promises as fsp } from 'fs'
import { join } from 'path'
import { colonyPaths } from '../../shared/colony-paths'
import type { AuditResult } from '../../shared/types'

const AUDIT_MODEL = 'claude-haiku-4-5-20251001'
const AUDIT_HISTORY_PATH = join(colonyPaths.root, 'audit-history.json')
const MAX_AUDIT_HISTORY_PER_PANEL = 5

interface AuditHistoryEntry {
  ts: number
  issueCount: number
  findings: AuditResult[]
}
interface AuditHistory {
  [panel: string]: AuditHistoryEntry[]
}

async function loadAuditHistory(): Promise<AuditHistory> {
  try {
    return JSON.parse(await fsp.readFile(AUDIT_HISTORY_PATH, 'utf-8'))
  } catch { /* ignore */ }
  return {}
}

async function appendAuditHistory(panel: string, results: AuditResult[]): Promise<void> {
  try {
    const history = await loadAuditHistory()
    if (!history[panel]) history[panel] = []
    history[panel].push({ ts: Date.now(), issueCount: results.length, findings: results })
    // Keep ring buffer of last MAX_AUDIT_HISTORY_PER_PANEL entries
    if (history[panel].length > MAX_AUDIT_HISTORY_PER_PANEL) {
      history[panel] = history[panel].slice(-MAX_AUDIT_HISTORY_PER_PANEL)
    }
    await fsp.writeFile(AUDIT_HISTORY_PATH, JSON.stringify(history, null, 2), 'utf-8')
  } catch { /* ignore */ }
}

async function getLastAuditRun(panel: string): Promise<{ ts: number; issueCount: number } | null> {
  const history = await loadAuditHistory()
  const entries = history[panel]
  if (!entries || entries.length === 0) return null
  const last = entries[entries.length - 1]
  return { ts: last.ts, issueCount: last.issueCount }
}

interface AuditContext {
  pipelines?: Array<{ name: string; enabled: boolean; fileName: string; yaml: string; lastError: string | null; fireCount: number }>
}

function runAuditPrompt(panelName: string, context: AuditContext): Promise<AuditResult[]> {
  let contextText = ''

  if (panelName === 'pipelines' && context.pipelines) {
    contextText = context.pipelines.map((p) => {
      const status = p.enabled ? 'enabled' : 'disabled'
      const errLine = p.lastError ? `\nLast error: ${p.lastError}` : ''
      const fireLine = `\nFire count: ${p.fireCount}`
      return `=== Pipeline: ${p.name} (${status}) ===\n${p.yaml}${errLine}${fireLine}`
    }).join('\n\n')
  }

  const prompt = `Review this Colony ${panelName} configuration. Identify ONLY concrete, actionable issues (not style suggestions). Return a JSON array only — no prose, no markdown fences:

[{"severity":"HIGH"|"MEDIUM"|"LOW","panel":"${panelName}","item":"<name>","issue":"<one sentence>","fixAction":"<optional: open-yaml:<fileName> or toggle-disable:<fileName>"}]

Rules:
- severity HIGH = broken/non-functional; MEDIUM = likely misconfigured; LOW = minor improvement
- item = the specific pipeline/persona/environment name
- fixAction is optional; only set when there is a clear automated fix
- Return [] if no issues found
- Do NOT suggest adding descriptions, renaming, or style changes

Configuration to audit:

${contextText || '(empty — no items configured)'}`

  return new Promise((resolve) => {
    execFile('claude', ['-p', prompt, '--model', AUDIT_MODEL], {
      encoding: 'utf-8',
      timeout: 30000,
      env: { ...process.env },
    }, (err, stdout) => {
      if (err || !stdout) {
        console.error('[audit] runAuditPrompt failed:', err?.message)
        resolve([])
        return
      }
      try {
        const trimmed = stdout.trim()
        // Strip any accidental markdown fences
        const jsonStr = trimmed.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim()
        const parsed = JSON.parse(jsonStr)
        if (!Array.isArray(parsed)) { resolve([]); return }
        resolve(parsed.filter(
          (r: any) =>
            typeof r === 'object' &&
            typeof r.severity === 'string' &&
            typeof r.item === 'string' &&
            typeof r.issue === 'string',
        ) as AuditResult[])
      } catch {
        resolve([])
      }
    })
  })
}

export function registerAuditHandlers(): void {
  ipcMain.handle('audit:runPanel', async (_e, panelName: string, context: AuditContext): Promise<AuditResult[]> => {
    // For pipelines: enrich context with YAML content from disk
    if (panelName === 'pipelines' && context.pipelines) {
      const enriched = await Promise.all(context.pipelines.map(async (p) => {
        if (p.yaml) return p
        try {
          const yamlPath = join(colonyPaths.pipelines, p.fileName)
          const yaml = await fsp.readFile(yamlPath, 'utf-8')
          return { ...p, yaml }
        } catch {
          return { ...p, yaml: '' }
        }
      }))
      const results = await runAuditPrompt(panelName, { ...context, pipelines: enriched })
      await appendAuditHistory(panelName, results)
      return results
    }
    const results = await runAuditPrompt(panelName, context)
    await appendAuditHistory(panelName, results)
    return results
  })

  ipcMain.handle('audit:getLastRun', (_e, panel: string) => getLastAuditRun(panel))
}
