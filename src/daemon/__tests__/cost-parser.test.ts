/**
 * Unit tests for the token-usage cost-parsing regex used in pty-daemon.ts.
 *
 * The logic under test is at pty-daemon.ts:~289.  We do NOT import the daemon
 * (it creates real PTY processes), so we replicate the exact regex here.
 * If the regex in the daemon changes, these tests MUST be updated to match.
 *
 * Open bug: bare `$0.04` format is not matched by the current regex.
 * Filed: qa-report.md — MEDIUM — "Daemon cost regex too narrow"
 * Backlog: [ready] UX: Cost Badge Threshold Mismatch + Parsing Regex
 */

import { describe, it, expect } from 'vitest'

// ---- Replicate exact regex from pty-daemon.ts:289 ----
// Pattern 1: "$X.XX cost" / "$X.XX spent" / "$X.XX total"
const PATTERN_DOLLAR_KEYWORD = /\$(\d+\.?\d*)\s*(?:cost|spent|total)/i
// Pattern 2: "cost: $X.XX" / "cost $X.XX"
const PATTERN_KEYWORD_DOLLAR = /cost[:\s]*\$(\d+\.?\d*)/i

/** Mimic the daemon's two-pattern OR lookup */
function parseCost(data: string): number | null {
  const m = data.match(PATTERN_DOLLAR_KEYWORD) || data.match(PATTERN_KEYWORD_DOLLAR)
  return m ? parseFloat(m[1]) : null
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

// ---- Known failing case (open bug) ----
// Claude CLI sometimes emits just a bare dollar amount with no adjacent keyword,
// e.g. a final status line that reads:  "$0.04"
// The current two-pattern regex does NOT match this format.
// The fix (from backlog spec): broaden to /\$(\d+\.\d{2,4})/ on the LAST line of a chunk.
//
// This test is marked `it.fails` to:
//  (a) document the known gap
//  (b) keep the suite green while the bug is open
//  (c) automatically surface "this test now passes unexpectedly" when the fix lands
//     → developer should remove `it.fails` and drop it into the normal describe block

describe('cost-parser: bare dollar amount (known bug — pty-daemon.ts:289)', () => {
  it.fails('does NOT match bare "$0.04" — fix: broaden regex or split last-line check', () => {
    // This assertion currently fails (parseCost returns null).
    // After the fix, it should return 0.04 — remove `it.fails` at that point.
    expect(parseCost('$0.04')).toBeCloseTo(0.04)
  })

  it.fails('does NOT match bare "$0.04\\n" at end of chunk', () => {
    const chunk = `Tool call: read_file\nReading src/index.ts\n$0.04\n`
    const lastLine = chunk.split('\n').filter(l => l.trim()).pop() || ''
    // Current parseCost(lastLine) returns null because neither pattern matches "$0.04"
    expect(parseCost(lastLine)).toBeCloseTo(0.04)
  })
})
