import { describe, it, expect } from 'vitest'
import {
  buildCommitSubject,
  buildBranchName,
  buildCommitBody,
} from '../../shared/ticket-commit-format'
import type { InstanceTicket } from '../../shared/ticket-commit-format'

const ticket: InstanceTicket = {
  source: 'jira',
  key: 'NP-1234',
  summary: 'Daily cost cap',
}

describe('buildCommitSubject', () => {
  it('produces conventional commit format with default feat type', () => {
    expect(buildCommitSubject(ticket)).toBe('feat: Daily cost cap')
  })

  it('accepts a custom type', () => {
    expect(buildCommitSubject(ticket, 'fix')).toBe('fix: Daily cost cap')
  })

  it('strips trailing period from summary', () => {
    const t = { ...ticket, summary: 'Add export button.' }
    expect(buildCommitSubject(t)).toBe('feat: Add export button')
  })

  it('truncates long summary at 72 chars total with ellipsis', () => {
    const longSummary = 'A'.repeat(80)
    const result = buildCommitSubject({ ...ticket, summary: longSummary })
    expect(result.length).toBeLessThanOrEqual(72)
    expect(result.endsWith('…')).toBe(true)
  })

  it('handles empty summary without crash', () => {
    const result = buildCommitSubject({ ...ticket, summary: '' })
    expect(result).toBe('feat: ')
  })
})

describe('buildBranchName', () => {
  it('lowercases and slugifies key + summary', () => {
    expect(buildBranchName(ticket)).toBe('np-1234-daily-cost-cap')
  })

  it('replaces non-alnum characters with hyphens and collapses runs', () => {
    const t = { ...ticket, key: 'NP-7663', summary: 'Daily cost cap!!!' }
    expect(buildBranchName(t)).toBe('np-7663-daily-cost-cap')
  })

  it('trims leading and trailing hyphens', () => {
    const t = { ...ticket, key: 'NP-1', summary: '  spaces  ' }
    expect(buildBranchName(t)).not.toMatch(/^-|-$/)
  })

  it('caps result at 50 characters', () => {
    const t = { ...ticket, summary: 'A very very very very very very very long summary here' }
    const result = buildBranchName(t)
    expect(result.length).toBeLessThanOrEqual(50)
    expect(result.endsWith('-')).toBe(false)
  })
})

describe('buildCommitBody', () => {
  it('appends Refs footer to empty body', () => {
    expect(buildCommitBody('', ticket)).toBe('Refs NP-1234')
  })

  it('appends Refs footer separated by double newline', () => {
    const result = buildCommitBody('Some body text', ticket)
    expect(result).toBe('Some body text\n\nRefs NP-1234')
  })

  it('is a no-op if Refs footer already present (case-insensitive)', () => {
    const body = 'Fix the thing\n\nRefs NP-1234'
    expect(buildCommitBody(body, ticket)).toBe(body)
  })

  it('is a no-op if footer uses lowercase refs', () => {
    const body = 'Fix\n\nrefs NP-1234'
    expect(buildCommitBody(body, ticket)).toBe(body)
  })

  it('trims trailing whitespace from body before appending footer', () => {
    const result = buildCommitBody('Body   \n\n', ticket)
    expect(result).toBe('Body\n\nRefs NP-1234')
  })
})
