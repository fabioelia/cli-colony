/**
 * Minimal YAML parser for Colony config files.
 *
 * Supports:
 *   - Key: value pairs
 *   - Nested objects (via indentation)
 *   - Block scalars (key: |)
 *   - Dash-list arrays (- item)
 *   - Booleans, integers, quoted strings
 *   - Comments (#)
 *
 * Does NOT support:
 *   - Flow sequences [a, b]
 *   - Flow mappings {a: b}
 *   - Anchors/aliases
 *   - Multi-document (---)
 *   - Complex keys
 */

export function parseYaml(content: string): Record<string, any> | null {
  try {
    const lines = content.split('\n')
    const result: any = {}
    const stack: { obj: any; indent: number; key?: string }[] = [{ obj: result, indent: -1 }]

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].replace(/\r$/, '')
      if (!line.trim() || line.trim().startsWith('#')) continue

      const indent = line.search(/\S/)
      const trimmed = line.trim()

      // Pop stack to find parent at the right indent level
      while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
        stack.pop()
      }
      const parent = stack[stack.length - 1].obj

      // Array item: "- value" or "- key: value"
      if (trimmed.startsWith('- ')) {
        const itemContent = trimmed.slice(2).trim()
        const parentKey = stack[stack.length - 1].key

        // Ensure parent context is an array
        if (parentKey && !Array.isArray(parent[parentKey])) {
          // Convert to array if it was an empty object placeholder
          const grandparent = stack.length > 2 ? stack[stack.length - 2].obj : result
          if (grandparent && parentKey) {
            grandparent[parentKey] = []
          }
        }
        const arr = parentKey ? (stack.length > 2 ? stack[stack.length - 2].obj : result)[parentKey] : parent

        if (itemContent.includes(':')) {
          // Array of objects: "- key: value"
          const obj: any = {}
          const colonMatch = itemContent.match(/^([^:]+?):\s(.*)/) || itemContent.match(/^([^:]+?):$/)
          if (colonMatch) {
            const key = colonMatch[1].trim()
            const value = (colonMatch[2] || '').trim()
            obj[key] = parseValue(value)
            // Look ahead for more keys at deeper indent
            const itemIndent = indent + 2
            while (i + 1 < lines.length) {
              const nextLine = lines[i + 1].replace(/\r$/, '')
              if (!nextLine.trim() || nextLine.trim().startsWith('#')) { i++; continue }
              const nextIndent = nextLine.search(/\S/)
              if (nextIndent <= indent) break
              const nextTrimmed = nextLine.trim()
              const nextColon = nextTrimmed.match(/^([^:]+?):\s(.*)/) || nextTrimmed.match(/^([^:]+?):$/)
              if (nextColon) {
                obj[nextColon[1].trim()] = parseValue((nextColon[2] || '').trim())
                i++
              } else {
                break
              }
            }
          }
          if (Array.isArray(arr)) {
            arr.push(obj)
          }
        } else {
          // Simple array item: "- value"
          if (Array.isArray(arr)) {
            arr.push(parseValue(itemContent))
          }
        }
        continue
      }

      // Key: value pair
      if (trimmed.includes(':')) {
        const colonMatch = trimmed.match(/^([^:]+?):\s(.*)/) || trimmed.match(/^([^:]+?):$/)
        if (colonMatch) {
          const key = colonMatch[1].trim()
          let value = (colonMatch[2] || '').trim()

          if (!value) {
            // Block scalar (key: |) or nested object
            if (i + 1 < lines.length) {
              const nextLine = lines[i + 1]?.replace(/\r$/, '') || ''
              const nextTrimmed = nextLine.trim()
              if (nextTrimmed.startsWith('- ')) {
                // Array follows
                parent[key] = []
                stack.push({ obj: parent[key], indent: indent + 1, key })
              } else {
                // Nested object
                const child: any = {}
                parent[key] = child
                stack.push({ obj: child, indent, key })
              }
            } else {
              parent[key] = {}
              stack.push({ obj: parent[key], indent, key })
            }
          } else if (value === '|') {
            // Block scalar — collect indented lines
            const blockLines: string[] = []
            const baseIndent = (lines[i + 1]?.search(/\S/) ?? indent + 2)
            while (i + 1 < lines.length) {
              const nextLine = lines[i + 1].replace(/\r$/, '')
              if (nextLine.trim() === '') {
                blockLines.push('')
                i++
                continue
              }
              const nextIndent = nextLine.search(/\S/)
              if (nextIndent < baseIndent) break
              blockLines.push(nextLine.slice(baseIndent))
              i++
            }
            parent[key] = blockLines.join('\n').trim()
          } else {
            parent[key] = parseValue(value)
          }
        }
      }
    }

    return result
  } catch {
    return null
  }
}

function parseValue(value: string): any {
  if (!value) return ''
  // Remove quotes
  const unquoted = value.replace(/^["']|["']$/g, '')
  if (value === 'true') return true
  if (value === 'false') return false
  if (value === 'null') return null
  if (/^\d+$/.test(value)) return parseInt(value)
  if (/^\d+\.\d+$/.test(value)) return parseFloat(value)
  return unquoted
}

/**
 * Parse an array of YAML dash-list items from raw content.
 * Useful for extracting specific array fields.
 */
export function parseYamlArray(content: string, fieldPath: string): string[] | null {
  const regex = new RegExp(`${fieldPath}:\\s*\\n((?:\\s+-\\s+.+\\n?)+)`, 'm')
  const m = content.match(regex)
  if (!m) return null
  return m[1].split('\n')
    .map(l => l.trim())
    .filter(l => l.startsWith('- '))
    .map(l => l.slice(2).trim().replace(/^["']|["']$/g, ''))
}
