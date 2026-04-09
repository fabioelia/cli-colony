/**
 * Cron expression matching and description.
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

function fmtTime(h: number, m: number): string {
  const period = h >= 12 ? 'PM' : 'AM'
  const displayH = h % 12 || 12
  const displayM = m.toString().padStart(2, '0')
  return `${displayH}:${displayM} ${period}`
}

/** Human-readable description of a cron expression. Returns "Manual only" for empty string. */
export function describeCron(expr: string): string {
  if (!expr || !expr.trim()) return 'Manual only'
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5) return expr
  const [min, hour, dom, month, dow] = fields

  if (min === '*' && hour === '*' && dom === '*' && month === '*' && dow === '*') return 'Every minute'

  if (min.startsWith('*/') && hour === '*' && dom === '*' && month === '*' && dow === '*') {
    const n = parseInt(min.slice(2))
    if (!isNaN(n)) return `Every ${n} minute${n === 1 ? '' : 's'}`
  }
  if (min === '0' && hour === '*' && dom === '*' && month === '*' && dow === '*') return 'Every hour'
  if (min === '0' && hour.startsWith('*/') && dom === '*' && month === '*' && dow === '*') {
    const n = parseInt(hour.slice(2))
    if (!isNaN(n)) return `Every ${n} hours`
  }
  // Specific time, all days
  if (dom === '*' && month === '*' && dow === '*') {
    const h = parseInt(hour), m = parseInt(min)
    if (!isNaN(h) && !isNaN(m)) return `Daily at ${fmtTime(h, m)}`
  }
  // Specific time, weekdays
  if (dow === '1-5' && dom === '*' && month === '*') {
    const h = parseInt(hour), m = parseInt(min)
    if (!isNaN(h) && !isNaN(m)) return `Weekdays at ${fmtTime(h, m)}`
  }
  // Specific time, weekends
  if ((dow === '0,6' || dow === '6,0') && dom === '*' && month === '*') {
    const h = parseInt(hour), m = parseInt(min)
    if (!isNaN(h) && !isNaN(m)) return `Weekends at ${fmtTime(h, m)}`
  }
  return expr
}

/** Returns all fire times for a given day (minute-resolution). Returned as {hour, minute} pairs sorted chronologically. */
export function cronFireTimesForDay(expr: string, date?: Date): { hour: number; minute: number }[] {
  if (!expr?.trim()) return []
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5) return []
  const [minF, hourF, domF, monthF, dowF] = fields
  const d = date ? new Date(date) : new Date()
  // Check day-level fields (dom, month, dow)
  if (!cronFieldMatches(domF, d.getDate())) return []
  if (!cronFieldMatches(monthF, d.getMonth() + 1)) return []
  if (!cronFieldMatches(dowF, d.getDay())) return []
  const times: { hour: number; minute: number }[] = []
  for (let h = 0; h < 24; h++) {
    if (!cronFieldMatches(hourF, h)) continue
    for (let m = 0; m < 60; m++) {
      if (cronFieldMatches(minF, m)) times.push({ hour: h, minute: m })
    }
  }
  return times
}

/** Returns the next N timestamps when this cron expression will fire, starting from `from` (default now). */
export function nextRuns(expr: string, count: number, from?: Date): Date[] {
  if (!expr?.trim()) return []
  const results: Date[] = []
  const cursor = from ? new Date(from) : new Date()
  cursor.setSeconds(0, 0)
  cursor.setMinutes(cursor.getMinutes() + 1)
  const limit = new Date(cursor.getTime() + 8 * 24 * 60 * 60 * 1000)
  while (results.length < count && cursor < limit) {
    if (cronMatches(expr, cursor)) results.push(new Date(cursor))
    cursor.setMinutes(cursor.getMinutes() + 1)
  }
  return results
}
