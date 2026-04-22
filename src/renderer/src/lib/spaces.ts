export interface Space {
  id: string
  name: string
  color: string
  createdAt: string
  archived?: boolean
}

const SPACE_COLORS = [
  '#6366f1', '#8b5cf6', '#ec4899', '#f97316', '#eab308',
  '#22c55e', '#14b8a6', '#3b82f6', '#ef4444', '#a855f7',
]

const SPACES_KEY = 'colony-spaces'
const ASSIGNMENTS_KEY = 'colony-space-assignments'

function loadSpaces(): Space[] {
  try { return JSON.parse(localStorage.getItem(SPACES_KEY) || '[]') } catch { return [] }
}

function saveSpaces(spaces: Space[]): void {
  localStorage.setItem(SPACES_KEY, JSON.stringify(spaces))
}

function loadAssignments(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(ASSIGNMENTS_KEY) || '{}') } catch { return {} }
}

function saveAssignments(a: Record<string, string>): void {
  localStorage.setItem(ASSIGNMENTS_KEY, JSON.stringify(a))
}

export function getSpaces(): Space[] {
  return loadSpaces().filter(s => !s.archived)
}

export function getAllSpaces(): Space[] {
  return loadSpaces()
}

export function createSpace(name: string): Space {
  const spaces = loadSpaces()
  const used = new Set(spaces.map(s => s.color))
  const color = SPACE_COLORS.find(c => !used.has(c)) ?? SPACE_COLORS[spaces.length % SPACE_COLORS.length]
  const space: Space = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2),
    name: name.trim(),
    color,
    createdAt: new Date().toISOString(),
  }
  saveSpaces([...spaces, space])
  return space
}

export function archiveSpace(id: string): void {
  saveSpaces(loadSpaces().map(s => s.id === id ? { ...s, archived: true } : s))
}

export function unarchiveSpace(id: string): void {
  saveSpaces(loadSpaces().map(s => s.id === id ? { ...s, archived: undefined } : s))
}

export function deleteSpace(id: string): void {
  saveSpaces(loadSpaces().filter(s => s.id !== id))
  const a = loadAssignments()
  for (const k of Object.keys(a)) { if (a[k] === id) delete a[k] }
  saveAssignments(a)
}

export function assignToSpace(instanceId: string, spaceId: string | null): void {
  const a = loadAssignments()
  if (spaceId === null) { delete a[instanceId] } else { a[instanceId] = spaceId }
  saveAssignments(a)
}

export function getSpaceForInstance(instanceId: string): string | null {
  return loadAssignments()[instanceId] ?? null
}

export function getAssignments(): Record<string, string> {
  return loadAssignments()
}

export function autoAssignPipelineSession(instanceId: string, pipelineName: string | undefined): void {
  if (!pipelineName) return
  const spaces = loadSpaces().filter(s => !s.archived)
  const match = spaces.find(s => s.name.toLowerCase() === pipelineName.toLowerCase())
  if (!match) return
  const a = loadAssignments()
  if (!a[instanceId]) {
    a[instanceId] = match.id
    saveAssignments(a)
  }
}
