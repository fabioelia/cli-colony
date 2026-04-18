/**
 * persona-triggers — immediate trigger_persona tool for colony personas.
 *
 * Personas call `~/.claude-colony/bin/trigger_persona <from> <to> "<note>"` during
 * their session. The script drops a JSON file into ~/.claude-colony/triggers/.
 * This module watches that directory, validates can_invoke, and fires runPersona immediately.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, watch, writeFileSync } from 'fs'
import { basename, join } from 'path'
import { colonyPaths } from '../shared/colony-paths'
import { parseFrontmatter as parseRawFrontmatter } from '../shared/utils'

// Imported lazily via a setter to avoid circular deps with persona-manager
type RunPersonaFn = (id: string, trigger: { type: 'handoff'; from: string }, note?: string, parentId?: string) => Promise<string>
type GetPersonaListFn = () => Array<{ id: string; enabled: boolean; activeSessionId: string | null }>
type AddWhisperFn = (id: string, text: string) => boolean

let _runPersona: RunPersonaFn | null = null
let _getPersonaList: GetPersonaListFn | null = null
let _addWhisper: AddWhisperFn | null = null

export function setPersonaRuntime(run: RunPersonaFn, list: GetPersonaListFn, whisper: AddWhisperFn): void {
  _runPersona = run
  _getPersonaList = list
  _addWhisper = whisper
}

// ---- Helpers ----

/** Parse an inline YAML array like `["a", "b"]` or `[a, b]` into string[]. */
function parseStringArray(val: string): string[] {
  if (!val) return []
  const match = val.match(/^\[(.+)\]$/)
  if (!match) return []
  return match[1].split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
}

/** Return the can_invoke list for a given persona slug, or [] if not found/invalid. */
export function getCanInvoke(personaId: string): string[] {
  const filePath = join(colonyPaths.personas, `${personaId}.md`)
  if (!existsSync(filePath)) return []
  try {
    const raw = parseRawFrontmatter(readFileSync(filePath, 'utf-8'))
    const val = (raw['can_invoke'] || '').replace(/^["']|["']$/g, '')
    return parseStringArray(val)
  } catch {
    return []
  }
}

// ---- Trigger file processing ----

export interface TriggerPayload {
  from: string
  to: string
  note?: string
}

export type TriggerResult =
  | { ok: true }
  | { ok: false; busy: true; reason: string }
  | { ok: false; busy: false; reason: string }

/** Pure validation — does not call runPersona. */
export function validateTrigger(
  payload: TriggerPayload,
  allowedTargets: string[],
  runningSessionId: string | null,
  targetEnabled: boolean,
): TriggerResult {
  if (!payload.from || !payload.to) {
    return { ok: false, busy: false, reason: 'trigger missing from/to fields' }
  }
  if (!allowedTargets.includes(payload.to)) {
    return { ok: false, busy: false, reason: `"${payload.from}" may not invoke "${payload.to}" — can_invoke: [${allowedTargets.join(', ')}]` }
  }
  if (!targetEnabled) {
    return { ok: false, busy: false, reason: `target persona "${payload.to}" is disabled` }
  }
  if (runningSessionId) {
    return { ok: false, busy: true, reason: `target persona "${payload.to}" already has a running session` }
  }
  return { ok: true }
}

async function processTriggerFile(filePath: string): Promise<void> {
  let payload: TriggerPayload
  try {
    payload = JSON.parse(readFileSync(filePath, 'utf-8')) as TriggerPayload
  } catch {
    console.warn(`[triggers] malformed trigger file: ${basename(filePath)} — removing`)
    try { unlinkSync(filePath) } catch { /* best effort */ }
    return
  }

  // Delete before processing to prevent double-fire on watcher re-fire
  try { unlinkSync(filePath) } catch { /* already gone */ }

  const canInvoke = getCanInvoke(payload.from)
  const personas = _getPersonaList?.() ?? []
  const target = personas.find(p => p.id === payload.to)

  const result = validateTrigger(
    payload,
    canInvoke,
    target?.activeSessionId ?? null,
    target?.enabled ?? false,
  )

  if (!result.ok) {
    if (result.busy) {
      // Target is running — fall back to a whisper so the note lands in its next session
      const note = `Trigger from ${payload.from}${payload.note ? `: ${payload.note}` : ' (no note provided)'}`
      const whispered = _addWhisper?.(payload.to, note) ?? false
      if (whispered) {
        console.log(`[triggers] ${payload.to} busy — converted to whisper from ${payload.from}`)
      } else {
        console.warn(`[triggers] ${payload.to} busy and whisper failed — trigger lost`)
      }
    } else {
      console.warn(`[triggers] rejected: ${result.reason}`)
    }
    return
  }

  console.log(`[triggers] ${payload.from} → ${payload.to}${payload.note ? ' (with note)' : ''}`)
  // Pass the invoker's current session as parent so the child appears in the Trigger Chain
  const fromPersona = personas.find(p => p.id === payload.from)
  const parentId = fromPersona?.activeSessionId ?? undefined
  try {
    await _runPersona!(payload.to, { type: 'handoff', from: payload.from }, payload.note, parentId)
  } catch (err: unknown) {
    console.warn(`[triggers] failed to launch "${payload.to}": ${err instanceof Error ? err.message : String(err)}`)
  }
}

// ---- Trigger scripts ----

const TRIGGER_SCRIPT_SH = [
  '#!/bin/bash',
  '# trigger_persona — invoke a colony persona with a context note.',
  '#',
  '# Usage:',
  '#   trigger_persona <from-persona-id> <to-persona-id> "<note>"',
  '#',
  '# Example:',
  '#   trigger_persona arch-auditor colony-developer "Arch audit done: 3 HIGH findings in arch-audit.md."',
  '#',
  'set -euo pipefail',
  '',
  'if [ $# -lt 2 ]; then',
  '  echo "Usage: trigger_persona <from-persona-id> <to-persona-id> [note]" >&2',
  '  exit 1',
  'fi',
  '',
  'FROM_ID="$1"',
  'TO_ID="$2"',
  'NOTE="${3:-}"',
  '',
  "python3 - \"$FROM_ID\" \"$TO_ID\" \"$NOTE\" <<'PYEOF'",
  'import json, sys, uuid, os',
  'from_id = sys.argv[1]',
  'to_id   = sys.argv[2]',
  "note    = sys.argv[3] if len(sys.argv) > 3 else ''",
  "triggers_dir = os.path.join(os.environ['HOME'], '.claude-colony', 'triggers')",
  'os.makedirs(triggers_dir, exist_ok=True)',
  "path = os.path.join(triggers_dir, str(uuid.uuid4()) + '.json')",
  'with open(path, \'w\') as f:',
  "    json.dump({'from': from_id, 'to': to_id, 'note': note}, f)",
  "print(f'Colony: queued trigger {from_id} -> {to_id}')",
  'PYEOF',
].join('\n') + '\n'

const TRIGGER_SCRIPT_BAT = [
  '@echo off',
  'setlocal enabledelayedexpansion',
  '',
  'if "%~1"=="" goto usage',
  'if "%~2"=="" goto usage',
  '',
  'set FROM_ID=%~1',
  'set TO_ID=%~2',
  'set NOTE=%~3',
  '',
  'python3 -c "import json,sys,uuid,os;h=os.environ.get(\'USERPROFILE\',os.path.expanduser(\'~\'));d=os.path.join(h,\'.claude-colony\',\'triggers\');os.makedirs(d,exist_ok=True);p=os.path.join(d,str(uuid.uuid4())+\'.json\');open(p,\'w\').write(json.dumps({\'from\':sys.argv[1],\'to\':sys.argv[2],\'note\':sys.argv[3] if len(sys.argv)>3 else \'\'}));print(f\'Colony: queued trigger {sys.argv[1]} -> {sys.argv[2]}\')" "%FROM_ID%" "%TO_ID%" "%NOTE%"',
  'goto end',
  '',
  ':usage',
  'echo Usage: trigger_persona ^<from-persona-id^> ^<to-persona-id^> [note] 1>&2',
  'exit /b 1',
  '',
  ':end',
  'endlocal',
].join('\r\n') + '\r\n'

function installTriggerScript(): void {
  mkdirSync(colonyPaths.bin, { recursive: true })
  if (process.platform === 'win32') {
    writeFileSync(join(colonyPaths.bin, 'trigger_persona.bat'), TRIGGER_SCRIPT_BAT)
  } else {
    writeFileSync(join(colonyPaths.bin, 'trigger_persona'), TRIGGER_SCRIPT_SH, { mode: 0o755 })
  }
}

// ---- Pending trigger index (for UI) ----

/**
 * Returns a map of persona ID → pending trigger payload for all trigger files
 * currently sitting in the triggers directory.
 */
export function getPendingTriggers(): Map<string, TriggerPayload> {
  const result = new Map<string, TriggerPayload>()
  if (!existsSync(colonyPaths.triggers)) return result
  for (const f of readdirSync(colonyPaths.triggers)) {
    if (!f.endsWith('.json')) continue
    try {
      const payload = JSON.parse(readFileSync(join(colonyPaths.triggers, f), 'utf-8')) as TriggerPayload
      if (payload.to) result.set(payload.to, payload)
    } catch { /* skip malformed */ }
  }
  return result
}

// ---- Watcher ----

let triggerWatcher: ReturnType<typeof watch> | null = null

/** Drain any trigger files that arrived while the app was not running. */
function drainExisting(): void {
  if (!existsSync(colonyPaths.triggers)) return
  const files = readdirSync(colonyPaths.triggers).filter(f => f.endsWith('.json'))
  if (files.length > 0) {
    console.log(`[triggers] draining ${files.length} pending trigger file(s)`)
    for (const f of files) {
      processTriggerFile(join(colonyPaths.triggers, f)).catch(err => {
        console.warn(`[triggers] drain error for ${f}: ${err}`)
      })
    }
  }
}

export function initTriggerWatcher(run: RunPersonaFn, list: GetPersonaListFn, whisper: AddWhisperFn): void {
  setPersonaRuntime(run, list, whisper)
  mkdirSync(colonyPaths.triggers, { recursive: true })
  installTriggerScript()

  if (triggerWatcher) return
  triggerWatcher = watch(colonyPaths.triggers, (event, filename) => {
    if (event === 'rename' && filename?.endsWith('.json')) {
      const filePath = join(colonyPaths.triggers, filename)
      if (existsSync(filePath)) {
        processTriggerFile(filePath).catch(err => {
          console.warn(`[triggers] error processing ${filename}: ${err}`)
        })
      }
    }
  })
  console.log('[triggers] watcher started')

  // Process any files that arrived while the app was closed
  drainExisting()
}

export function stopTriggerWatcher(): void {
  triggerWatcher?.close()
  triggerWatcher = null
}
