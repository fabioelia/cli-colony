/**
 * Cron expression matching.
 * Supports: "min hour dom month dow" (5 fields)
 * Each field: number, *, N step, N-M range, comma-separated, named days (mon-sun)
 */

const DAY_NAMES: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }

export function cronFieldMatches(field: string, value: number): boolean {
  if (field === '*') return true
  for (const part of field.split(',')) {
    const t = part.trim().toLowerCase()
    // */N step
    if (t.startsWith('*/')) {
      const step = parseInt(t.slice(2))
      if (!isNaN(step) && step > 0 && value % step === 0) return true
      continue
    }
    // N-M range
    if (t.includes('-')) {
      const [s, e] = t.split('-')
      const start = DAY_NAMES[s] ?? parseInt(s)
      const end = DAY_NAMES[e] ?? parseInt(e)
      if (!isNaN(start) && !isNaN(end) && value >= start && value <= end) return true
      continue
    }
    // Named day
    if (DAY_NAMES[t] !== undefined) {
      if (DAY_NAMES[t] === value) return true
      continue
    }
    // Exact number
    const num = parseInt(t)
    if (!isNaN(num) && num === value) return true
  }
  return false
}

export function cronMatches(expression: string, date?: Date): boolean {
  const d = date || new Date()
  const fields = expression.trim().split(/\s+/)
  if (fields.length < 5) return false
  const [minute, hour, dom, month, dow] = fields
  return (
    cronFieldMatches(minute, d.getMinutes()) &&
    cronFieldMatches(hour, d.getHours()) &&
    cronFieldMatches(dom, d.getDate()) &&
    cronFieldMatches(month, d.getMonth() + 1) &&
    cronFieldMatches(dow, d.getDay())
  )
}
