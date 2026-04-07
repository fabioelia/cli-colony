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

/**
 * Parse a shell-style argument string, respecting single and double quotes.
 * Handles: "arg with spaces", 'single quoted', unquoted, and mixed.
 * Example: `parseShellArgs('-y @mcp/fs "/path/with spaces"')` returns `['-y', '@mcp/fs', '/path/with spaces']`
 */
export function parseShellArgs(argsStr: string): string[] {
  const args: string[] = []
  let current = ''
  let inSingleQuote = false
  let inDoubleQuote = false
  let i = 0

  while (i < argsStr.length) {
    const ch = argsStr[i]

    if (inSingleQuote) {
      if (ch === "'") {
        inSingleQuote = false
      } else {
        current += ch
      }
    } else if (inDoubleQuote) {
      if (ch === '"') {
        inDoubleQuote = false
      } else if (ch === '\\' && i + 1 < argsStr.length) {
        // Handle escape sequences in double quotes
        const nextCh = argsStr[i + 1]
        if (nextCh === '"' || nextCh === '\\' || nextCh === '$') {
          current += nextCh
          i++
        } else {
          current += ch
        }
      } else {
        current += ch
      }
    } else {
      if (ch === "'") {
        inSingleQuote = true
      } else if (ch === '"') {
        inDoubleQuote = true
      } else if (/\s/.test(ch)) {
        if (current.length > 0) {
          args.push(current)
          current = ''
        }
      } else {
        current += ch
      }
    }

    i++
  }

  if (current.length > 0) {
    args.push(current)
  }

  return args
}

/**
 * Expand environment variables in a string.
 * Supports: $VAR and ${VAR} syntax.
 * Falls back to empty string if variable is not set.
 * Example: `expandEnvVars('$HOME/data')` with HOME=/Users/foo returns '/Users/foo/data'
 */
export function expandEnvVars(text: string, env: Record<string, string> = process.env as Record<string, string>): string {
  return text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_match, p1, p2) => {
    const varName = p1 || p2
    return env[varName] ?? ''
  })
}
