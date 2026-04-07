/**
 * Unit tests for the token-usage cost-parsing regex used in pty-daemon.ts.
 *
 * The logic under test is at pty-daemon.ts:~289.  We do NOT import the daemon
 * (it creates real PTY processes), so we replicate the exact regex here.
 * If the regex in the daemon changes, these tests MUST be updated to match.
 *
 * Fixed in b4dd43f: bare `$0.04` format now matched via last-line fallback.
 * DAEMON_VERSION bumped to 9.
 */

import { describe, it, expect } from 'vitest'

// ---- Replicate exact regex from pty-daemon.ts:289 ----
// Pattern 1: "$X.XX cost" / "$X.XX spent" / "$X.XX total"
const PATTERN_DOLLAR_KEYWORD = /\$(\d+\.?\d*)\s*(?:cost|spent|total)/i
// Pattern 2: "cost: $X.XX" / "cost $X.XX"
const PATTERN_KEYWORD_DOLLAR = /cost[:\s]*\$(\d+\.?\d*)/i
// Pattern 3 (fallback): bare "$X.XX" on last non-empty line (≥2 decimal places)
const PATTERN_BARE_LAST_LINE = /\$(\d+\.\d{2,4})(?:\s|$)/

/** Mimic the daemon's full cost-parsing logic (primary + last-line fallback) */
function parseCost(data: string): number | null {
  const m = data.match(PATTERN_DOLLAR_KEYWORD) || data.match(PATTERN_KEYWORD_DOLLAR)
  if (m) return parseFloat(m[1])
  // Fallback: bare dollar amount on last non-empty line
  const lastLine = data.split('\n').map(l => l.trim()).filter(Boolean).at(-1) ?? ''
  const bare = lastLine.match(PATTERN_BARE_LAST_LINE)
  return bare ? parseFloat(bare[1]) : null
}

// ---- Formats that currently work ----

describe('cost-parser: PATTERN_DOLLAR_KEYWORD — "$X.XX <keyword>"', () => {
  it('matches "$0.04 cost"', () => {
    expect(parseCost('$0.04 cost')).toBeCloseTo(0.04)
  })

  it('matches "$1.23 spent"', () => {
    expect(parseCost('$1.23 spent')).toBeCloseTo(1.23)
  })

  it('matches "$0.001 total"', () => {
    expect(parseCost('$0.001 total')).toBeCloseTo(0.001)
  })

  it('matches mid-sentence — "used $0.05 total for this run"', () => {
    expect(parseCost('used $0.05 total for this run')).toBeCloseTo(0.05)
  })

  it('is case-insensitive for keyword — "$0.10 Cost"', () => {
    expect(parseCost('$0.10 Cost')).toBeCloseTo(0.10)
  })

  it('matches with extra whitespace between amount and keyword — "$0.03  total"', () => {
    expect(parseCost('$0.03  total')).toBeCloseTo(0.03)
  })
})

describe('cost-parser: PATTERN_KEYWORD_DOLLAR — "cost: $X.XX"', () => {
  it('matches "cost: $0.07"', () => {
    expect(parseCost('cost: $0.07')).toBeCloseTo(0.07)
  })

  it('matches "Cost: $2.50"', () => {
    expect(parseCost('Cost: $2.50')).toBeCloseTo(2.50)
  })

  it('matches "cost $0.002" (no colon)', () => {
    expect(parseCost('cost $0.002')).toBeCloseTo(0.002)
  })

  it('matches multi-line output with cost label', () => {
    const chunk = `Tokens used: 1240 input, 432 output\ncost: $0.015\n`
    expect(parseCost(chunk)).toBeCloseTo(0.015)
  })
})

describe('cost-parser: no match cases', () => {
  it('returns null for empty string', () => {
    expect(parseCost('')).toBeNull()
  })

  it('returns null for output without any cost pattern', () => {
    expect(parseCost('Reading 3 files...')).toBeNull()
  })

  it('returns null for text with dollar sign but no cost context', () => {
    expect(parseCost('Found $HOME variable in config')).toBeNull()
  })
})

// ---- Bare dollar amount (fixed in b4dd43f) ----
// Claude CLI sometimes emits just a bare dollar amount with no adjacent keyword,
// e.g. a final status line that reads: "$0.04"
// Fixed by: last-line fallback regex /\$(\d+\.\d{2,4})(?:\s|$)/ in pty-daemon.ts
// DAEMON_VERSION bumped to 9.

describe('cost-parser: bare dollar amount on last line (fixed b4dd43f)', () => {
  it('matches bare "$0.04" on a single-line chunk', () => {
    expect(parseCost('$0.04')).toBeCloseTo(0.04)
  })

  it('matches bare "$0.04" as last line of a multi-line chunk', () => {
    const chunk = `Tool call: read_file\nReading src/index.ts\n$0.04\n`
    expect(parseCost(chunk)).toBeCloseTo(0.04)
  })

  it('does NOT match bare "$0.04" when it is not the last line', () => {
    // Guard: only the last line is checked for bare dollar amounts
    const chunk = `$0.04\nsome more output\n`
    expect(parseCost(chunk)).toBeNull()
  })

  it('requires ≥2 decimal places — does not match "$1" or "$1.5"', () => {
    expect(parseCost('$1')).toBeNull()
    expect(parseCost('$1.5')).toBeNull()
  })
})
