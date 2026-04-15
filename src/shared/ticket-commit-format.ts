/**
 * Utilities for seeding commit messages and branch names from a Jira ticket.
 * Used by CommitDialog to auto-fill subject, body footer, and branch name.
 */

export interface InstanceTicket {
  source: 'jira'
  key: string
  summary: string
}

/**
 * Build a conventional commit subject: "<type>: <summary>", capped at 72 chars.
 * Trailing period stripped from summary.
 */
export function buildCommitSubject(ticket: InstanceTicket, type = 'feat'): string {
  const prefix = `${type}: `
  const maxLen = 72 - prefix.length
  const summary = ticket.summary.trim().replace(/\.$/, '')
  return prefix + (summary.length > maxLen ? summary.slice(0, maxLen - 1) + '…' : summary)
}

/**
 * Build a git branch name from ticket key + summary.
 * Rule: lowercase, non-alnum → '-', collapse runs, trim edges, cap at 50 chars.
 * E.g. "NP-1234" + "Daily cost cap!" → "np-1234-daily-cost-cap"
 */
export function buildBranchName(ticket: InstanceTicket): string {
  const raw = `${ticket.key}-${ticket.summary}`
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug.slice(0, 50).replace(/-+$/, '')
}

/**
 * Append "Refs <key>" footer to a commit body, if not already present.
 * No-ops if the footer is already in the text (case-insensitive).
 */
export function buildCommitBody(body: string, ticket: InstanceTicket): string {
  if (new RegExp(`\\bRefs\\s+${ticket.key}\\b`, 'i').test(body)) return body
  const trimmed = body.trimEnd()
  return trimmed ? `${trimmed}\n\nRefs ${ticket.key}` : `Refs ${ticket.key}`
}
