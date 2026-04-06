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

/**
 * Strip ANSI / VT100 escape sequences from terminal output.
 * Handles CSI sequences (including DEC private like [?2026l), OSC sequences,
 * and bare ESC + letter codes. Safe to call on any string.
 */
export function stripAnsi(text: string): string {
  return text
    // CSI sequences: ESC [ <param bytes> <final byte>
    // param bytes: 0x20–0x3F (covers digits, ';', '?', '>', etc.)
    // final byte:  0x40–0x7E
    .replace(/\x1b\[[\x20-\x3f]*[\x40-\x7e]/g, '')
    // OSC sequences: ESC ] ... BEL  or  ESC ] ... ST (ESC \)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    // SS2 / SS3: ESC N/O + one character
    .replace(/\x1b[NO]./g, '')
    // Remaining bare ESC + single character (RIS, DECSC/7, DECRC/8, etc.)
    // Final bytes for 2-char sequences: 0x30–0x7E (digits, letters, punctuation)
    .replace(/\x1b[\x30-\x7e]/g, '')
    // Carriage returns
    .replace(/\r/g, '')
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
