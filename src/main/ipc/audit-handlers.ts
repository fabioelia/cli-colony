import { ipcMain } from 'electron'
import { execFileSync } from 'child_process'
import * as fs from 'fs'
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

function loadAuditHistory(): AuditHistory {
  try {
    if (fs.existsSync(AUDIT_HISTORY_PATH)) {
      return JSON.parse(fs.readFileSync(AUDIT_HISTORY_PATH, 'utf-8'))
    }
  } catch { /* ignore */ }
  return {}
}

function appendAuditHistory(panel: string, results: AuditResult[]): void {
  try {
    const history = loadAuditHistory()
    if (!history[panel]) history[panel] = []
    history[panel].push({ ts: Date.now(), issueCount: results.length, findings: results })
    // Keep ring buffer of last MAX_AUDIT_HISTORY_PER_PANEL entries
    if (history[panel].length > MAX_AUDIT_HISTORY_PER_PANEL) {
      history[panel] = history[panel].slice(-MAX_AUDIT_HISTORY_PER_PANEL)
    }
    fs.writeFileSync(AUDIT_HISTORY_PATH, JSON.stringify(history, null, 2), 'utf-8')
  } catch { /* ignore */ }
}

function getLastAuditRun(panel: string): { ts: number; issueCount: number } | null {
  const history = loadAuditHistory()
  const entries = history[panel]
  if (!entries || entries.length === 0) return null
  const last = entries[entries.length - 1]
  return { ts: last.ts, issueCount: last.issueCount }
}

interface AuditContext {
  pipelines?: Array<{ name: string; enabled: boolean; fileName: string; yaml: string; lastError: string | null; fireCount: number }>
}

function runAuditPrompt(panelName: string, context: AuditContext): AuditResult[] {
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

  try {
    const output = execFileSync('claude', ['-p', prompt, '--model', AUDIT_MODEL], {
      encoding: 'utf-8',
      timeout: 30000,
      env: { ...process.env },
    })

    const trimmed = output.trim()
    // Strip any accidental markdown fences
    const jsonStr = trimmed.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim()
    const parsed = JSON.parse(jsonStr)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (r: any) =>
        typeof r === 'object' &&
        typeof r.severity === 'string' &&
        typeof r.item === 'string' &&
        typeof r.issue === 'string',
    ) as AuditResult[]
  } catch (err: any) {
    console.error('[audit] runAuditPrompt failed:', err.message)
    return []
  }
}

export function registerAuditHandlers(): void {
  ipcMain.handle('audit:runPanel', async (_e, panelName: string, context: AuditContext): Promise<AuditResult[]> => {
    // For pipelines: enrich context with YAML content from disk
    if (panelName === 'pipelines' && context.pipelines) {
      const enriched = context.pipelines.map((p) => {
        if (p.yaml) return p
        try {
          const yamlPath = join(colonyPaths.pipelines, p.fileName)
          const yaml = fs.existsSync(yamlPath) ? fs.readFileSync(yamlPath, 'utf-8') : ''
          return { ...p, yaml }
        } catch {
          return { ...p, yaml: '' }
        }
      })
      const results = runAuditPrompt(panelName, { ...context, pipelines: enriched })
      appendAuditHistory(panelName, results)
      return results
    }
    const results = runAuditPrompt(panelName, context)
    appendAuditHistory(panelName, results)
    return results
  })

  ipcMain.handle('audit:getLastRun', (_e, panel: string): { ts: number; issueCount: number } | null => {
    return getLastAuditRun(panel)
  })
}
