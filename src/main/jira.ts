import { getSettings } from './settings'
import type { JiraTicket, JiraTicketSummary } from '../shared/types'

// TODO(jira-server): V1 targets Jira Cloud only. On-prem Jira Server uses /rest/api/2/
// and different auth. Add a `jiraType: 'cloud' | 'server'` setting to support it.

const MAX_DESCRIPTION_CHARS = 4000

/**
 * Recursively flatten Atlassian Document Format (ADF) to plain text.
 * Joins top-level blocks with double newlines; inline text nodes are concatenated.
 */
function adfToPlaintext(node: unknown): string {
  if (!node || typeof node !== 'object') return ''
  const n = node as Record<string, unknown>

  if (n.type === 'text' && typeof n.text === 'string') {
    return n.text
  }

  if (Array.isArray(n.content)) {
    const children = (n.content as unknown[]).map(adfToPlaintext)
    // Block-level nodes get double newlines; inline nodes are joined directly
    const blockTypes = new Set(['doc', 'paragraph', 'heading', 'bulletList', 'orderedList', 'listItem', 'blockquote', 'codeBlock', 'rule', 'panel'])
    const isBlock = typeof n.type === 'string' && blockTypes.has(n.type)
    return isBlock ? children.join('\n\n') : children.join('')
  }

  return ''
}

export async function fetchTicket(key: string): Promise<JiraTicket> {
  const settings = await getSettings()
  const domain = settings.jiraDomain?.trim()
  const email = settings.jiraEmail?.trim()
  const token = settings.jiraApiToken?.trim()

  if (!domain || !email || !token) {
    throw new Error('Jira not configured')
  }

  const credentials = Buffer.from(`${email}:${token}`).toString('base64')
  const url = `https://${domain}/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,description`

  let response: Response
  try {
    response = await fetch(url, {
      headers: {
        Authorization: `Basic ${credentials}`,
        Accept: 'application/json',
      },
    })
  } catch (err) {
    throw new Error(`Network error fetching Jira ticket: ${(err as Error).message}`)
  }

  if (response.status === 401 || response.status === 403) {
    throw new Error('Jira auth failed — check email/token')
  }
  if (response.status === 404) {
    throw new Error(`Ticket not found: ${key}`)
  }
  if (!response.ok) {
    throw new Error(`Jira request failed: ${response.status} ${response.statusText}`)
  }

  const data = await response.json() as {
    key: string
    fields: { summary: string; description: unknown }
  }

  const summary = data.fields?.summary || ''
  let description = ''

  if (data.fields?.description) {
    description = adfToPlaintext(data.fields.description).trim()
    if (description.length > MAX_DESCRIPTION_CHARS) {
      description = description.slice(0, MAX_DESCRIPTION_CHARS) + '\n…[truncated]'
    }
  }

  return {
    key: data.key || key,
    summary,
    description,
    url: `https://${domain}/browse/${data.key || key}`,
  }
}

/**
 * Fetch tickets assigned to the current user (resolution = Unresolved, sorted
 * by updated DESC, capped at 20). Used by the ticket picker in NewInstanceDialog.
 */
export async function searchMyTickets(): Promise<JiraTicketSummary[]> {
  const settings = await getSettings()
  const domain = settings.jiraDomain?.trim()
  const email = settings.jiraEmail?.trim()
  const token = settings.jiraApiToken?.trim()

  if (!domain || !email || !token) {
    throw new Error('Jira not configured')
  }

  const credentials = Buffer.from(`${email}:${token}`).toString('base64')
  const jql = encodeURIComponent('assignee=currentUser() AND resolution=Unresolved ORDER BY updated DESC')
  const url = `https://${domain}/rest/api/3/search?jql=${jql}&fields=summary,status&maxResults=20`

  let response: Response
  try {
    response = await fetch(url, {
      headers: {
        Authorization: `Basic ${credentials}`,
        Accept: 'application/json',
      },
    })
  } catch (err) {
    throw new Error(`Network error fetching tickets: ${(err as Error).message}`)
  }

  if (response.status === 401 || response.status === 403) {
    throw new Error('Jira auth failed — check email/token')
  }
  if (!response.ok) {
    throw new Error(`Jira request failed: ${response.status} ${response.statusText}`)
  }

  const data = await response.json() as {
    issues: Array<{
      key: string
      fields: { summary: string; status: { name: string } }
    }>
  }

  return (data.issues ?? []).map(issue => ({
    key: issue.key,
    summary: issue.fields?.summary ?? '',
    status: issue.fields?.status?.name ?? '',
  }))
}
