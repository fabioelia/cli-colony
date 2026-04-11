export interface PromptSnippet {
  name: string
  prompt: string
  createdAt: number
}

const KEY = 'session-prompt-snippets'

export function getSnippets(): PromptSnippet[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    return JSON.parse(raw) as PromptSnippet[]
  } catch {
    return []
  }
}

export function saveSnippet(name: string, prompt: string): void {
  const snippets = getSnippets().filter(s => s.name !== name)
  snippets.unshift({ name: name.trim(), prompt: prompt.trim(), createdAt: Date.now() })
  localStorage.setItem(KEY, JSON.stringify(snippets))
}

export function updateSnippet(name: string, prompt: string): void {
  const snippets = getSnippets().map(s =>
    s.name === name ? { ...s, prompt: prompt.trim() } : s
  )
  localStorage.setItem(KEY, JSON.stringify(snippets))
}

export function deleteSnippet(name: string): void {
  const snippets = getSnippets().filter(s => s.name !== name)
  localStorage.setItem(KEY, JSON.stringify(snippets))
}
