import { ipcMain, app } from 'electron'
import { promises as fsp } from 'fs'
import { join } from 'path'
import type { McpAuditEntry } from '../../shared/types'

const AUDIT_PATH = join(app.getPath('home'), '.claude-colony', 'mcp-audit.json')
const MAX_ENTRIES = 500
const DISPLAY_LIMIT = 100

async function readEntries(): Promise<McpAuditEntry[]> {
  try {
    const raw = await fsp.readFile(AUDIT_PATH, 'utf-8')
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
export async function appendAuditEntry(entry: Omit<McpAuditEntry, 'ts'>): Promise<void> {
  try {
    const entries = await readEntries()
    const newEntry: McpAuditEntry = { ts: Date.now(), ...entry }
    entries.push(newEntry)
    // Trim to ring buffer size
    const trimmed = entries.length > MAX_ENTRIES ? entries.slice(entries.length - MAX_ENTRIES) : entries
    const dir = join(app.getPath('home'), '.claude-colony')
    await fsp.mkdir(dir, { recursive: true })
    await fsp.writeFile(AUDIT_PATH, JSON.stringify(trimmed, null, 2), 'utf-8')
  } catch (err) {
    console.error('[mcp-audit] appendAuditEntry failed:', err)
  }
}

/**
 * Return the last 100 entries, newest first.
 */
export async function getAuditLog(): Promise<McpAuditEntry[]> {
  const entries = await readEntries()
  return entries.slice(-DISPLAY_LIMIT).reverse()
}

/**
 * Clear the audit log by deleting the file.
 */
export async function clearAuditLog(): Promise<void> {
  try {
    await fsp.unlink(AUDIT_PATH)
  } catch (err: any) {
    if (err.code !== 'ENOENT') console.error('[mcp-audit] clearAuditLog failed:', err)
  }
}

export function registerMcpAuditHandlers(): void {
  ipcMain.handle('mcp:getAuditLog', () => getAuditLog())
  ipcMain.handle('mcp:clearAuditLog', () => clearAuditLog())
}
