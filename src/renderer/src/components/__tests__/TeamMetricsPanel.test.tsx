/**
 * Smoke test for TeamMetricsPanel.
 *
 * Catches the three classes of bugs that shipped in 6ac24ad/2c321d3:
 * 1. Missing module import (e.g. `./BarChart2`) — would throw at import time
 * 2. Shadowing global `window` state var — would throw TypeError on fetch
 * 3. Orphan component — not caught here (checked via TerminalView integration)
 *
 * Uses react-dom/server.renderToString in a node environment — no jsdom required.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { renderToString } from 'react-dom/server'

describe('TeamMetricsPanel', () => {
  beforeEach(() => {
    // Stub the `window.api.team` surface used by the component.
    // Without this, fetchMetrics would throw synchronously on mount.
    // The component renders the loading state on first render so the mocks
    // never actually resolve during renderToString — but we still need the
    // shape to exist so property access in fetchMetrics doesn't blow up.
    ;(globalThis as any).window = {
      api: {
        team: {
          getMetrics: vi.fn().mockResolvedValue({
            window: '7d',
            generatedAt: new Date().toISOString(),
            teamSuccessRate: 92.5,
            avgDurationMs: 45000,
            totalCostYtd: 12.34,
            activeWorkerCount: 3,
            workers: [],
          }),
          exportCsv: vi.fn().mockResolvedValue(''),
          getWorkerHistory: vi.fn().mockResolvedValue([]),
        },
      },
    }
  })

  it('module loads without missing-import errors', async () => {
    // Dynamic import so a missing module (e.g. ./BarChart2) surfaces as a test
    // failure rather than a load-time crash that masks the error.
    const mod = await import('../TeamMetricsPanel')
    expect(mod.TeamMetricsPanel).toBeDefined()
    expect(typeof mod.TeamMetricsPanel).toBe('function')
  })

  it('renders the loading state without throwing (no global window shadow)', async () => {
    const { TeamMetricsPanel } = await import('../TeamMetricsPanel')
    // If `window` is shadowed by a state var of the same name, this render
    // would throw a ReferenceError or TypeError before the loading JSX returns.
    // SSR renders the initial state, which is `loading = true`.
    const html = renderToString(React.createElement(TeamMetricsPanel, {}))
    expect(html).toContain('Loading metrics')
  })

  it('accepts an optional coordinatorSessionId prop', async () => {
    const { TeamMetricsPanel } = await import('../TeamMetricsPanel')
    const html = renderToString(
      React.createElement(TeamMetricsPanel, { coordinatorSessionId: 'sess-123' })
    )
    expect(html).toBeTruthy()
  })
})
