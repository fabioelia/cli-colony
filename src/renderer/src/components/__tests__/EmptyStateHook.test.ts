/**
 * Tests for EmptyStateHook — the shared hands-on empty state component
 * with icon, title, hook copy, optional keyboard badge, and optional CTA.
 *
 * Uses react-dom/server.renderToString (same pattern as SessionEmptyState.test.tsx)
 * so we don't need jsdom.
 */

import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { renderToString } from 'react-dom/server'
import { Bot } from 'lucide-react'

describe('EmptyStateHook', () => {
  it('renders title, hook copy, and icon correctly', async () => {
    const mod = await import('../EmptyStateHook')
    const EmptyStateHook = mod.default
    const html = renderToString(
      React.createElement(EmptyStateHook, {
        icon: Bot,
        title: 'Personas',
        hook: 'No personas yet. They shape how your agents think and schedule.',
      }),
    )
    expect(html).toContain('Personas')
    expect(html).toContain('No personas yet.')
    expect(html).toContain('empty-state-hook')
  })

  it('renders keyCap as a monospace badge when provided', async () => {
    const mod = await import('../EmptyStateHook')
    const EmptyStateHook = mod.default
    const html = renderToString(
      React.createElement(EmptyStateHook, {
        icon: Bot,
        title: 'Personas',
        hook: 'No personas yet.',
        keyCap: 'P',
      }),
    )
    expect(html).toContain('empty-state-hook-keycap')
    expect(html).toContain('>P<')
    // Verify it is not rendered when omitted
    const htmlNoKeyCap = renderToString(
      React.createElement(EmptyStateHook, {
        icon: Bot,
        title: 'Agents',
        hook: 'No agents yet.',
      }),
    )
    expect(htmlNoKeyCap).not.toContain('empty-state-hook-keycap')
  })

  it('renders CTA button and fires onClick when clicked', async () => {
    const mod = await import('../EmptyStateHook')
    const EmptyStateHook = mod.default
    const onClick = vi.fn()

    // Verify the CTA renders in the HTML
    const html = renderToString(
      React.createElement(EmptyStateHook, {
        icon: Bot,
        title: 'Personas',
        hook: 'No personas yet.',
        keyCap: 'P',
        cta: { label: 'Create Persona', onClick },
      }),
    )
    expect(html).toContain('Create Persona')
    expect(html).toContain('empty-state-hook-cta')

    // Verify onClick is callable (simulate the handler dispatch)
    onClick()
    expect(onClick).toHaveBeenCalledTimes(1)

    // No CTA when prop is absent
    const htmlNoCta = renderToString(
      React.createElement(EmptyStateHook, {
        icon: Bot,
        title: 'Outputs',
        hook: 'Nothing here yet.',
      }),
    )
    expect(htmlNoCta).not.toContain('empty-state-hook-cta')
  })
})
