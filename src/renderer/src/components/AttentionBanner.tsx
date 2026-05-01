import { useState, useEffect, useCallback } from 'react'
import { Bell, X, Send, ChevronUp, ChevronDown } from 'lucide-react'
import type { PersonaAttentionRequest } from '../../../shared/types'
import MarkdownViewer from './MarkdownViewer'

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const s = Math.floor(diff / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

interface AttentionCardProps {
  item: PersonaAttentionRequest
  onResolve: (personaId: string, attnId: string, response?: string) => void
  onDismiss: (personaId: string, attnId: string) => void
}

function AttentionCard({ item, onResolve, onDismiss }: AttentionCardProps) {
  const [replyOpen, setReplyOpen] = useState(false)
  const [replyText, setReplyText] = useState('')

  function handleSend() {
    if (!replyText.trim()) return
    onResolve(item.personaId, item.id, replyText.trim())
  }

  return (
    <div className="attention-card">
      <div className="attention-card-header">
        <span className="attention-card-persona">{item.personaName}</span>
        <span className="attention-card-time">{timeAgo(item.createdAt)}</span>
        <button className="attention-card-dismiss" onClick={() => onDismiss(item.personaId, item.id)} title="Dismiss">
          <X size={12} />
        </button>
      </div>
      <MarkdownViewer content={item.message} className="attention-card-message" />
      <div className="attention-card-actions">
        <button className="attention-reply-btn" onClick={() => setReplyOpen(v => !v)}>Reply</button>
      </div>
      {replyOpen && (
        <div className="attention-reply-area">
          <textarea
            className="attention-reply-input"
            value={replyText}
            onChange={e => setReplyText(e.target.value)}
            placeholder="Your reply becomes a whisper for the next run… (⌘↵ to send)"
            onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleSend() }}
            autoFocus
          />
          <button className="attention-send-btn" onClick={handleSend} disabled={!replyText.trim()}>
            <Send size={12} /> Send
          </button>
        </div>
      )}
    </div>
  )
}

export default function AttentionBanner() {
  const [items, setItems] = useState<PersonaAttentionRequest[]>([])
  const [expanded, setExpanded] = useState(false)

  const refresh = useCallback(async () => {
    const result = await window.api.persona.getAllAttention()
    setItems(result)
  }, [])

  useEffect(() => {
    refresh()
    const off1 = window.api.persona.onStatus(() => refresh())
    const off2 = window.api.persona.onRun(() => refresh())
    return () => { off1(); off2() }
  }, [refresh])

  async function handleResolve(personaId: string, attnId: string, response?: string) {
    await window.api.persona.resolveAttention(personaId, attnId, response)
    setItems(prev => prev.filter(a => a.id !== attnId))
  }

  async function handleDismiss(personaId: string, attnId: string) {
    await window.api.persona.dismissAttention(personaId, attnId)
    setItems(prev => prev.filter(a => a.id !== attnId))
  }

  if (items.length === 0) return null

  return (
    <div className="attention-banner">
      <div className="attention-banner-collapsed" onClick={() => setExpanded(v => !v)}>
        <Bell size={13} className="attention-banner-icon" />
        <span className="attention-banner-count">{items.length}</span>
        <span>{items.length === 1 ? 'persona needs' : 'personas need'} attention</span>
        {expanded ? <ChevronUp size={11} className="attention-banner-chevron" /> : <ChevronDown size={11} className="attention-banner-chevron" />}
      </div>
      {expanded && (
        <div className="attention-banner-list">
          {items.map(item => (
            <AttentionCard
              key={item.id}
              item={item}
              onResolve={handleResolve}
              onDismiss={handleDismiss}
            />
          ))}
        </div>
      )}
    </div>
  )
}
