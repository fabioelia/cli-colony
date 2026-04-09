import { describe, it, expect } from 'vitest'
import { helpContent } from '../help-content'

describe('help-content — Onboarding', () => {
  it('settings topic has an Onboarding Section zone', () => {
    const settings = helpContent['settings']
    expect(settings).toBeDefined()
    const zone = settings.zones?.find(z => z.name === 'Onboarding Section')
    expect(zone).toBeDefined()
    expect(zone!.items.length).toBeGreaterThanOrEqual(3)
  })

  it('onboarding zone includes replay, checklist, and reset items', () => {
    const zone = helpContent['settings'].zones?.find(z => z.name === 'Onboarding Section')!
    const labels = zone.items.map(i => i.label)
    expect(labels).toContain('Replay welcome screen')
    expect(labels).toContain('Activation checklist')
    expect(labels).toContain('Reset all onboarding state')
  })
})
