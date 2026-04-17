import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'fs'
import { join } from 'path'
import { colonyPaths } from '../shared/colony-paths'

export type PipelineNote = { createdAt: string; text: string }

function notesPath(fileName: string): string {
  const base = fileName.replace(/\.(yaml|yml)$/, '')
  return join(colonyPaths.pipelines, `${base}.notes.json`)
}

export function getPipelineNotes(fileName: string): PipelineNote[] {
  const p = notesPath(fileName)
  if (!existsSync(p)) return []
  try { return JSON.parse(readFileSync(p, 'utf-8')) } catch { return [] }
}

export function addPipelineNote(fileName: string, text: string): boolean {
  if (!text.trim()) return false
  const notes = getPipelineNotes(fileName)
  notes.push({ createdAt: new Date().toISOString(), text: text.trim() })
  writeFileSync(notesPath(fileName), JSON.stringify(notes, null, 2), 'utf-8')
  return true
}

export function deletePipelineNote(fileName: string, index: number): boolean {
  const notes = getPipelineNotes(fileName)
  if (index < 0 || index >= notes.length) return false
  notes.splice(index, 1)
  if (notes.length === 0) {
    try { unlinkSync(notesPath(fileName)) } catch { /* ok */ }
  } else {
    writeFileSync(notesPath(fileName), JSON.stringify(notes, null, 2), 'utf-8')
  }
  return true
}

export function clearPipelineNotes(fileName: string): void {
  try { unlinkSync(notesPath(fileName)) } catch { /* ok */ }
}
