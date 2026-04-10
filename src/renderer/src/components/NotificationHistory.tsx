import React, { useState, useEffect, useCallback } from 'react'
import { Zap, User, AlertCircle, Play, X, CheckCheck, Trash2, DollarSign, Monitor } from 'lucide-react'
import type { NotificationEntry } from '../../../shared/types'

interface NotificationHistoryProps {
  onClose: () => void
  onNavigate: (route: string | Record<string, unknown>) => void
}

const SOURCE_ICONS: Record<string, React.ReactNode> = {
  pipeline: <Zap size={14} />,
  persona: <User size={14} />,
  approval: <AlertCircle size={14} />,
  session: <Play size={14} />,
  budget: <DollarSign size={14} />,
  system: <Monitor size={14} />,
}

function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function getDateGroup(ts: number): string {
  const now = new Date()
  const date = new Date(ts)
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const yesterdayStart = todayStart - 86400000
  if (ts >= todayStart) return 'Today'
  if (ts >= yesterdayStart) return 'Yesterday'
  return 'Older'
}

function groupEntries(entries: NotificationEntry[]): Array<{ label: string; entries: NotificationEntry[] }> {
  const groups = new Map<string, NotificationEntry[]>()
  const order = ['Today', 'Yesterday', 'Older']
  for (const entry of entries) {
    const label = getDateGroup(entry.timestamp)
    if (!groups.has(label)) groups.set(label, [])
    groups.get(label)!.push(entry)
  }
  return order.filter(l => groups.has(l)).map(label => ({ label, entries: groups.get(label)! }))
}

export default function NotificationHistory({ onClose, onNavigate }: NotificationHistoryProps) {
  const [entries, setEntries] = useState<NotificationEntry[]>([])

  const loadHistory = useCallback(() => {
    window.api.notifications.history().then(setEntries).catch(() => {})
  }, [])

  useEffect(() => {
    loadHistory()
    const unsub = window.api.notifications.onNew(() => loadHistory())
    return unsub
  }, [loadHistory])

  const handleMarkAllRead = useCallback(() => {
    window.api.notifications.markAllRead().then(loadHistory).catch(() => {})
  }, [loadHistory])

  const handleClearAll = useCallback(() => {
    window.api.notifications.clearAll().then(() => setEntries([])).catch(() => {})
  }, [])

  const handleDismiss = useCallback((id: string) => {
    window.api.notifications.markRead(id).then(loadHistory).catch(() => {})
  }, [loadHistory])

  const handleClick = useCallback((entry: NotificationEntry) => {
    window.api.notifications.markRead(entry.id).catch(() => {})
    if (entry.route) {
      onNavigate(entry.route)
      onClose()
    }
  }, [onNavigate, onClose])

  const grouped = groupEntries(entries)
  const unreadCount = entries.filter(e => !e.read).length

  return (
    <div className="notification-history-popover" onClick={e => e.stopPropagation()}>
      <div className="notification-history-header">
        <span>Notifications{unreadCount > 0 ? ` (${unreadCount})` : ''}</span>
        <div className="notification-history-header-actions">
          {unreadCount > 0 && (
            <button onClick={handleMarkAllRead} title="Mark all read" className="notification-history-header-btn">
              <CheckCheck size={13} />
            </button>
          )}
          {entries.length > 0 && (
            <button onClick={handleClearAll} title="Clear all" className="notification-history-header-btn">
              <Trash2 size={13} />
            </button>
          )}
          <button onClick={onClose} title="Close" className="notification-history-header-btn">
            <X size={13} />
          </button>
        </div>
      </div>
      <div className="notification-history-body">
        {entries.length === 0 ? (
          <div className="notification-history-empty">No notifications yet</div>
        ) : (
          grouped.map(group => (
            <div key={group.label}>
              <div className="notification-history-group-label">{group.label}</div>
              {group.entries.map(entry => (
                <div
                  key={entry.id}
                  className={`notification-history-entry ${entry.read ? '' : 'unread'} ${entry.route ? 'clickable' : ''}`}
                  onClick={() => handleClick(entry)}
                >
                  <div className="notification-history-entry-icon" data-source={entry.source || 'system'}>
                    {SOURCE_ICONS[entry.source || 'system'] || SOURCE_ICONS.system}
                  </div>
                  <div className="notification-history-entry-content">
                    <div className="notification-history-entry-title">{entry.title}</div>
                    <div className="notification-history-entry-body">{entry.body}</div>
                    <div className="notification-history-entry-meta">
                      <span className="notification-history-entry-time">{formatRelativeTime(entry.timestamp)}</span>
                      {entry.source && <span className="notification-history-entry-source">{entry.source}</span>}
                    </div>
                  </div>
                  {!entry.read && (
                    <button
                      className="notification-history-entry-dismiss"
                      title="Mark read"
                      onClick={(e) => { e.stopPropagation(); handleDismiss(entry.id) }}
                    >
                      <X size={11} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
