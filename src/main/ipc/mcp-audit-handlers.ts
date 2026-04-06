import { ipcMain, app } from 'electron'
import * as fs from 'fs'
import { join } from 'path'
import type { McpAuditEntry } from '../../shared/types'

const AUDIT_PATH = join(app.getPath('home'), '.claude-colony', 'mcp-audit.json')
const MAX_ENTRIES = 500
const DISPLAY_LIMIT = 100

function readEntries(): McpAuditEntry[] {
  try {
    if (!fs.existsSync(AUDIT_PATH)) return []
    const raw = fs.readFileSync(AUDIT_PATH, 'utf-8')
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed as McpAuditEntry[]
  } catch {
    return []
  }
}

/**
 * Append an audit entry for an MCP tool call event.
 * Fire-and-forget — does not throw on write failure.
 * Exported so it can be called from tool approval IPC once that ships.
 */
export function appendAuditEntry(entry: Omit<McpAuditEntry, 'ts'>): void {
  try {
    const entries = readEntries()
    const newEntry: McpAuditEntry = { ts: Date.now(), ...entry }
    entries.push(newEntry)
    // Trim to ring buffer size
    const trimmed = entries.length > MAX_ENTRIES ? entries.slice(entries.length - MAX_ENTRIES) : entries
    const dir = join(app.getPath('home'), '.claude-colony')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(AUDIT_PATH, JSON.stringify(trimmed, null, 2), 'utf-8')
  } catch (err) {
    console.error('[mcp-audit] appendAuditEntry failed:', err)
  }
}

/**
 * Return the last 100 entries, newest first.
 */
export function getAuditLog(): McpAuditEntry[] {
  const entries = readEntries()
  return entries.slice(-DISPLAY_LIMIT).reverse()
}

/**
 * Clear the audit log by deleting the file.
 */
export function clearAuditLog(): void {
  try {
    if (fs.existsSync(AUDIT_PATH)) {
      fs.unlinkSync(AUDIT_PATH)
    }
  } catch (err) {
    console.error('[mcp-audit] clearAuditLog failed:', err)
  }
}

export function registerMcpAuditHandlers(): void {
  ipcMain.handle('mcp:getAuditLog', (): McpAuditEntry[] => getAuditLog())
  ipcMain.handle('mcp:clearAuditLog', (): void => clearAuditLog())
}
