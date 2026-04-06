/**
 * Replay Manager — collects tool call events from PTY output and persists them.
 *
 * Claude CLI outputs tool calls in this pattern:
 *   ● ToolName(args...)
 *   ⎿ output...
 *
 * The ● bullet indicates a tool invocation, ⎿ indicates the result/output.
 */

import * as fs from 'fs'
import * as path from 'path'
import { stripAnsi } from '../shared/utils'
import { colonyPaths } from '../shared/colony-paths'
import type { ReplayEvent } from '../shared/types'

const MAX_EVENTS = 200
const MAX_SUMMARY = 200

/** Parse a ● tool-call line and extract the tool name and input summary. */
export function parseToolLine(line: string): { tool: string; inputSummary: string } | null {
  // Match lines starting with ● (may have leading whitespace or ANSI)
  const match = line.match(/●\s+([A-Za-z][A-Za-z0-9_]*)\s*\(?(.*?)\)?$/)
  if (!match) return null
  const tool = match[1]
  const rawInput = match[2] ? match[2].replace(/\)$/, '').trim() : ''
  return {
    tool,
    inputSummary: rawInput.slice(0, MAX_SUMMARY),
  }
}

/** Parse a ⎿ output line and extract the output summary. */
export function parseOutputLine(line: string): string | null {
  const match = line.match(/⎿\s+(.*)$/)
  if (!match) return null
  return match[1].trim().slice(0, MAX_SUMMARY)
}

/** Read existing replay events for an instance (returns [] if file missing/corrupt). */
export function readReplay(instanceId: string): ReplayEvent[] {
  const filePath = replayFilePath(instanceId)
  try {
    if (!fs.existsSync(filePath)) return []
    const raw = fs.readFileSync(filePath, 'utf-8')
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed as ReplayEvent[]
  } catch {
    return []
  }
}

/** Append a replay event to the instance's replay file (capped at MAX_EVENTS). */
export function appendReplayEvent(instanceId: string, event: ReplayEvent): void {
  const dir = colonyPaths.sessions
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  } catch {
    return
  }
  const existing = readReplay(instanceId)
  existing.push(event)
  // Cap at MAX_EVENTS
  const capped = existing.length > MAX_EVENTS ? existing.slice(-MAX_EVENTS) : existing
  try {
    fs.writeFileSync(replayFilePath(instanceId), JSON.stringify(capped, null, 2), 'utf-8')
  } catch { /* ignore write errors */ }
}

function replayFilePath(instanceId: string): string {
  return path.join(colonyPaths.sessions, `${instanceId}.replay.json`)
}

// ---- Per-instance parse state ----
// Track pending tool-call state per instance (last seen ● line awaiting ⎿)
interface PendingTool {
  tool: string
  inputSummary: string
}

const _pending = new Map<string, PendingTool>()

/**
 * Process a chunk of PTY output for an instance.
 * Detects ● and ⎿ patterns and writes replay events.
 */
export function processOutput(instanceId: string, rawData: string): void {
  const clean = stripAnsi(rawData)
  const lines = clean.split(/\r?\n/)
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue

    // Check for tool call line
    const toolParsed = parseToolLine(trimmed)
    if (toolParsed) {
      // Store as pending — waiting for output line
      _pending.set(instanceId, toolParsed)
      continue
    }

    // Check for output line
    const outputSummary = parseOutputLine(trimmed)
    if (outputSummary !== null) {
      const pending = _pending.get(instanceId)
      if (pending) {
        _pending.delete(instanceId)
        appendReplayEvent(instanceId, {
          ts: new Date().toISOString(),
          tool: pending.tool,
          inputSummary: pending.inputSummary,
          outputSummary,
        })
      }
      continue
    }

    // Any other non-empty line cancels the pending state (tool output didn't follow)
    // but we keep it pending for a bit — some tool calls span multiple output lines.
    // We only flush pending if it's a brand new ● line (handled above) or a distinct
    // content line that isn't a continuation. For safety, if a second ● comes along,
    // the pending is already replaced by the new one above. Non-● lines just leave
    // pending as-is until the next ⎿ arrives (or the next ● replaces it).
  }
}

/** Clear pending state for an instance (e.g., on session exit). */
export function clearPending(instanceId: string): void {
  _pending.delete(instanceId)
}
