/**
 * Shared utility functions used across main process, daemon, and renderer.
 */

/** Generate a pseudo-random hex ID in the format xxxxxxxx-xxxxxxxx-xxxxxxxx */
export function genId(): string {
  const hex = () => Math.random().toString(16).substring(2, 10)
  return `${hex()}${hex()}-${hex()}-${hex()}`
}

/** Convert a user-provided string to a filesystem/DB-safe slug */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')   // non-alphanumeric -> hyphens
    .replace(/^-|-$/g, '')           // trim leading/trailing hyphens
    .slice(0, 60)                    // cap length
    || 'unnamed'                     // fallback
}

/**
 * Parse YAML frontmatter from a markdown file.
 * Returns key-value pairs as strings; callers handle type coercion.
 */
/**
 * Resolve {{mustache}} templates by walking dot-separated paths into a context object.
 * Arrays are joined with ', '. Null/undefined values resolve to ''.
 */
export function resolveMustacheTemplate(template: string, context: Record<string, unknown>): string {
  return template.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (_match, key: string) => {
    let val: unknown = context
    for (const part of key.split('.')) {
      if (val == null) return ''
      val = (val as Record<string, unknown>)[part]
    }
    if (Array.isArray(val)) return val.join(', ')
    return val != null ? String(val) : ''
  })
}

export function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\n([\s\S]*?)\n---/)
  if (!match) return {}
  const meta: Record<string, string> = {}
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':')
    if (idx > 0) {
      const key = line.slice(0, idx).trim()
      const value = line.slice(idx + 1).trim()
      meta[key] = value
    }
  }
  return meta
}
