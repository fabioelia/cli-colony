import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Play, X, MessageSquare, User, Bot, Loader2, Terminal } from 'lucide-react'

interface ExternalSession {
  pid: number
  name: string
  cwd: string
  sessionId: string | null
  args: string
}

interface Message {
  role: string
  text: string
  timestamp?: string
  type?: string
}

interface Props {
  session: ExternalSession
  anchorRect: { top: number; left: number; bottom: number; right: number }
  onClose: () => void
  onTakeover: (session: ExternalSession) => void
}

export default function ExternalSessionPopover({ session, anchorRect, onClose, onTakeover }: Props) {
  const [messages, setMessages] = useState<Message[]>([])
  const [loading, setLoading] = useState(true)
  const [project, setProject] = useState<string | null>(null)
  const [takingOver, setTakingOver] = useState(false)
  const popoverRef = useRef<HTMLDivElement>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  // Fetch messages on mount
  useEffect(() => {
    if (!session.sessionId) {
      setLoading(false)
      return
    }
    setLoading(true)
    window.api.sessions.messages(session.sessionId, 30).then((result) => {
      setMessages(result.messages)
      setProject(result.project)
      setLoading(false)
    }).catch(() => {
      setLoading(false)
    })
  }, [session.sessionId])

  // Scroll to bottom when messages load
  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'auto' })
    }
  }, [messages])

  // Close on click outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    // Delay to avoid closing from the click that opened it
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handler)
    }, 50)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('mousedown', handler)
    }
  }, [onClose])

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  // Position the popover: to the right of the sidebar, clamped to viewport
  const popoverStyle: React.CSSProperties = {
    position: 'fixed',
    left: `var(--sidebar-width)`,
    top: Math.max(8, Math.min(anchorRect.top, window.innerHeight - 480)),
    zIndex: 10000,
  }

  const handleTakeover = async () => {
    setTakingOver(true)
    onTakeover(session)
  }

  const formatTimestamp = (ts?: string) => {
    if (!ts) return ''
    try {
      const d = new Date(ts)
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    } catch {
      return ''
    }
  }

  const truncateText = (text: string, maxLen: number) => {
    if (text.length <= maxLen) return text
    return text.slice(0, maxLen) + '...'
  }

  return createPortal(
    <div className="ext-session-popover" ref={popoverRef} style={popoverStyle} onClick={(e) => e.stopPropagation()}>
      {/* Header */}
      <div className="ext-session-popover-header">
        <div className="ext-session-popover-title">
          <Terminal size={14} />
          <span>{session.name}</span>
        </div>
        <button className="ext-session-popover-close" onClick={onClose} aria-label="Close">
          <X size={14} />
        </button>
      </div>

      {/* Meta info */}
      <div className="ext-session-popover-meta">
        <div className="ext-session-popover-meta-row">
          <span className="ext-session-popover-meta-label">Directory</span>
          <span className="ext-session-popover-meta-value">{session.cwd || '(unknown)'}</span>
        </div>
        <div className="ext-session-popover-meta-row">
          <span className="ext-session-popover-meta-label">PID</span>
          <span className="ext-session-popover-meta-value">{session.pid}</span>
        </div>
        {session.sessionId && (
          <div className="ext-session-popover-meta-row">
            <span className="ext-session-popover-meta-label">Session</span>
            <span className="ext-session-popover-meta-value">{session.sessionId.slice(0, 12)}...</span>
          </div>
        )}
      </div>

      {/* Messages */}
      <div className="ext-session-popover-messages">
        {loading ? (
          <div className="ext-session-popover-loading">
            <Loader2 size={16} className="spinning" />
            <span>Loading messages...</span>
          </div>
        ) : messages.length === 0 ? (
          <div className="ext-session-popover-empty">
            <MessageSquare size={16} />
            <span>{session.sessionId ? 'No messages found' : 'No session ID detected — cannot preview messages'}</span>
          </div>
        ) : (
          <>
            {messages.map((msg, i) => (
              <div key={i} className={`ext-session-msg ext-session-msg-${msg.role}`}>
                <div className="ext-session-msg-header">
                  {msg.role === 'human' ? <User size={12} /> : <Bot size={12} />}
                  <span className="ext-session-msg-role">{msg.role === 'human' ? 'You' : 'Claude'}</span>
                  {msg.timestamp && (
                    <span className="ext-session-msg-time">{formatTimestamp(msg.timestamp)}</span>
                  )}
                </div>
                <div className="ext-session-msg-text">
                  {truncateText(msg.text, 500)}
                </div>
              </div>
            ))}
            <div ref={messagesEndRef} />
          </>
        )}
      </div>

      {/* Actions */}
      <div className="ext-session-popover-actions">
        <button
          className="ext-session-takeover-btn"
          onClick={handleTakeover}
          disabled={takingOver}
          title={session.sessionId
            ? 'Terminate the external process and resume this session in Colony'
            : 'Start a new Colony session in the same directory'}
        >
          {takingOver ? (
            <Loader2 size={14} className="spinning" />
          ) : (
            <Play size={14} />
          )}
          {takingOver ? 'Taking over...' : 'Take Over Session'}
        </button>
      </div>
    </div>,
    document.body
  )
}
