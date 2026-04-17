import { useState, useEffect } from 'react'
import { ExternalLink } from 'lucide-react'
import type { JiraTicket } from '../../../shared/types'
import { extractTicketKey } from '../../../shared/ticket-commit-format'

interface Props {
  ticket?: { source: 'jira'; key: string; summary: string; url?: string }
  gitBranch: string | null
}

export default function JiraTab({ ticket, gitBranch }: Props) {
  const [data, setData] = useState<JiraTicket | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [pattern, setPattern] = useState('[A-Z]+-\\d+')

  useEffect(() => {
    window.api.settings.getAll().then(s => {
      if (s.jiraTicketKeyPattern?.trim()) setPattern(s.jiraTicketKeyPattern.trim())
    })
  }, [])

  const ticketKey = ticket?.key || extractTicketKey(gitBranch || '', pattern)

  useEffect(() => {
    if (!ticketKey) return
    setLoading(true)
    setError(null)
    window.api.jira.fetchTicket(ticketKey)
      .then(result => {
        if (result.ok) setData(result.ticket)
        else setError(result.error)
      })
      .catch(e => setError((e as Error).message))
      .finally(() => setLoading(false))
  }, [ticketKey])

  if (!ticketKey) return <div className="jira-tab-empty">No ticket detected</div>
  if (loading) return <div className="jira-tab-loading">Loading {ticketKey}…</div>
  if (error) return <div className="jira-tab-error">{error}</div>
  if (!data) return null

  return (
    <div className="jira-tab">
      <div className="jira-tab-header">
        <a
          className="jira-tab-key"
          href="#"
          onClick={e => { e.preventDefault(); window.api.shell.openExternal(data.url) }}
        >
          {data.key} <ExternalLink size={12} />
        </a>
        {data.status && <span className="jira-tab-status">{data.status}</span>}
      </div>
      <h3 className="jira-tab-summary">{data.summary}</h3>
      {data.description && <pre className="jira-tab-description">{data.description}</pre>}
    </div>
  )
}
