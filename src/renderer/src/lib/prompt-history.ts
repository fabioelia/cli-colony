export interface PromptEntry {
  prompt: string
  timestamp: number
}

const KEY = 'session-prompt-history'
const MAX = 20

export function getHistory(): PromptEntry[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    return JSON.parse(raw) as PromptEntry[]
  } catch {
    return []
  }
}

export function addToHistory(prompt: string): void {
  const trimmed = prompt.trim()
  if (!trimmed) return
  const entries = getHistory().filter(e => e.prompt !== trimmed)
  entries.unshift({ prompt: trimmed, timestamp: Date.now() })
  if (entries.length > MAX) entries.length = MAX
  localStorage.setItem(KEY, JSON.stringify(entries))
}

export function clearHistory(): void {
  localStorage.removeItem(KEY)
}
