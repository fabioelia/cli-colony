import { useState, useEffect, useCallback, useMemo } from 'react'
import { ClipboardList, Plus, Trash2, Pencil, CheckCircle2, Circle, Clock, AlertTriangle, RefreshCw, Search, X, ChevronRight } from 'lucide-react'
import type { TaskBoardItem, TaskStatus, TaskPriority } from '../types'
import HelpPopover from './HelpPopover'

const STATUS_ORDER: TaskStatus[] = ['todo', 'in_progress', 'blocked', 'done']

const STATUS_LABEL: Record<TaskStatus, string> = {
  todo: 'To Do',
  in_progress: 'In Progress',
  blocked: 'Blocked',
  done: 'Done',
}

const STATUS_ICON: Record<TaskStatus, React.ReactNode> = {
  todo: <Circle size={13} />,
  in_progress: <Clock size={13} className="status-icon-progress" />,
  blocked: <AlertTriangle size={13} className="status-icon-blocked" />,
  done: <CheckCircle2 size={13} className="status-icon-done" />,
}

const PRIORITY_ORDER: TaskPriority[] = ['critical', 'high', 'medium', 'low']

const PRIORITY_LABEL: Record<TaskPriority, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
}

const PRIORITY_COLOR: Record<TaskPriority, string> = {
  critical: '#ef4444',
  high: '#f97316',
  medium: '#eab308',
  low: '#60a5fa',
}

/** Rank for sorting: lower = higher priority */
const PRIORITY_RANK: Record<TaskPriority, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
}

function relativeTime(iso: string | undefined): string {
  if (!iso) return ''
  const now = Date.now()
  const then = new Date(iso).getTime()
  if (isNaN(then)) return ''
  const diffMs = now - then
  if (diffMs < 0) return 'just now'
  const seconds = Math.floor(diffMs / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days === 1) return 'yesterday'
  if (days < 7) return `${days}d ago`
  const date = new Date(iso)
  const month = date.toLocaleString('en-US', { month: 'short' })
  return `${month} ${date.getDate()}`
}

function effectivePriority(item: TaskBoardItem): TaskPriority {
  return item.priority || 'medium'
}

interface TaskDraft {
  title: string
  status: TaskStatus
  priority: TaskPriority
  assignee: string
  notes: string
  tags: string
}

const EMPTY_DRAFT: TaskDraft = { title: '', status: 'todo', priority: 'medium', assignee: '', notes: '', tags: '' }

function draftFromItem(item: TaskBoardItem): TaskDraft {
  return {
    title: item.title,
    status: item.status,
    priority: effectivePriority(item),
    assignee: item.assignee || '',
    notes: item.notes || '',
    tags: item.tags?.join(', ') || '',
  }
}

function draftToItem(draft: TaskDraft, base?: TaskBoardItem): TaskBoardItem {
  return {
    id: base?.id || `task-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    title: draft.title.trim(),
    status: draft.status,
    priority: draft.priority,
    assignee: draft.assignee.trim() || undefined,
    notes: draft.notes.trim() || undefined,
    tags: draft.tags ? draft.tags.split(',').map(t => t.trim()).filter(Boolean) : undefined,
    created: base?.created,
    updated: base?.updated,
  }
}

function sortTasks(tasks: TaskBoardItem[]): TaskBoardItem[] {
  return [...tasks].sort((a, b) => {
    const pa = PRIORITY_RANK[effectivePriority(a)]
    const pb = PRIORITY_RANK[effectivePriority(b)]
    if (pa !== pb) return pa - pb
    const ta = a.updated || a.created || ''
    const tb = b.updated || b.created || ''
    return tb.localeCompare(ta)
  })
}

/** Priority dot badge */
function PriorityBadge({ priority }: { priority: TaskPriority }) {
  return (
    <span
      className="tasks-board-priority-badge"
      style={{ background: PRIORITY_COLOR[priority] }}
      title={PRIORITY_LABEL[priority]}
    />
  )
}

export default function TaskBoardPanel() {
  const [items, setItems] = useState<TaskBoardItem[]>([])
  const [loading, setLoading] = useState(true)

  // New task form (global)
  const [showNew, setShowNew] = useState(false)
  const [draft, setDraft] = useState<TaskDraft>(EMPTY_DRAFT)
  const [saving, setSaving] = useState(false)

  // Quick-add per column
  const [quickAddCol, setQuickAddCol] = useState<TaskStatus | null>(null)
  const [quickAddTitle, setQuickAddTitle] = useState('')

  // Filter state
  const [filterText, setFilterText] = useState('')
  const [filterPriority, setFilterPriority] = useState<'all' | TaskPriority>('all')
  const [filterAssignee, setFilterAssignee] = useState('all')

  // Detail panel
  const [detailItem, setDetailItem] = useState<TaskBoardItem | null>(null)
  const [editDraft, setEditDraft] = useState<TaskDraft | null>(null)

  const loadBoard = useCallback(async () => {
    setLoading(true)
    try {
      const data = await window.api.tasksBoard.list()
      setItems(data)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadBoard()
    const unsub = window.api.tasksBoard.onUpdated((data) => {
      setItems(data)
      // Update detail panel if the viewed item changed
      setDetailItem(prev => {
        if (!prev) return null
        return data.find(d => d.id === prev.id) || null
      })
    })
    return unsub
  }, [loadBoard])

  // Unique assignees for filter dropdown
  const assignees = useMemo(() => {
    const set = new Set<string>()
    items.forEach(i => { if (i.assignee) set.add(i.assignee) })
    return Array.from(set).sort()
  }, [items])

  // Filter + sort
  const filtered = useMemo(() => {
    let result = items
    if (filterText) {
      const q = filterText.toLowerCase()
      result = result.filter(i =>
        i.title.toLowerCase().includes(q) ||
        (i.notes && i.notes.toLowerCase().includes(q))
      )
    }
    if (filterPriority !== 'all') {
      result = result.filter(i => effectivePriority(i) === filterPriority)
    }
    if (filterAssignee !== 'all') {
      result = result.filter(i => i.assignee === filterAssignee)
    }
    return result
  }, [items, filterText, filterPriority, filterAssignee])

  const grouped = useMemo(() => {
    const g: Record<TaskStatus, TaskBoardItem[]> = { todo: [], in_progress: [], blocked: [], done: [] }
    filtered.forEach(i => g[i.status].push(i))
    // Sort within each column
    for (const s of STATUS_ORDER) g[s] = sortTasks(g[s])
    return g
  }, [filtered])

  const activeFilterCount = (filterText ? 1 : 0) + (filterPriority !== 'all' ? 1 : 0) + (filterAssignee !== 'all' ? 1 : 0)
  const activeCount = items.filter(i => i.status !== 'done').length

  // Handlers
  const handleSave = async () => {
    if (!draft.title.trim()) return
    setSaving(true)
    try {
      await window.api.tasksBoard.save(draftToItem(draft))
      setDraft(EMPTY_DRAFT)
      setShowNew(false)
    } finally {
      setSaving(false)
    }
  }

  const handleQuickAdd = async (status: TaskStatus) => {
    if (!quickAddTitle.trim()) return
    const newItem: TaskBoardItem = {
      id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      title: quickAddTitle.trim(),
      status,
      priority: 'medium',
    }
    await window.api.tasksBoard.save(newItem)
    setQuickAddTitle('')
    setQuickAddCol(null)
  }

  const handleStatusChange = async (item: TaskBoardItem, next: TaskStatus) => {
    await window.api.tasksBoard.save({ ...item, status: next })
  }

  const handleDelete = async (id: string) => {
    await window.api.tasksBoard.delete(id)
    if (detailItem?.id === id) {
      setDetailItem(null)
      setEditDraft(null)
    }
  }

  const handleEditSave = async () => {
    if (!editDraft || !detailItem || !editDraft.title.trim()) return
    setSaving(true)
    try {
      await window.api.tasksBoard.save(draftToItem(editDraft, detailItem))
      setEditDraft(null)
    } finally {
      setSaving(false)
    }
  }

  const openDetail = (item: TaskBoardItem) => {
    setDetailItem(item)
    setEditDraft(null)
  }

  const clearFilters = () => {
    setFilterText('')
    setFilterPriority('all')
    setFilterAssignee('all')
  }

  return (
    <div className="tasks-board-panel">
      <div className="panel-header">
        <h2><ClipboardList size={16} /> Task Board</h2>
        {activeCount > 0 && <span className="tasks-board-count">{activeCount}</span>}
        <div className="panel-header-spacer" />
        <HelpPopover topic="tasksBoard" align="right" />
        <div className="panel-header-actions">
          <button className="panel-header-btn" title="Refresh" onClick={loadBoard}>
            <RefreshCw size={14} />
          </button>
          <button
            className={`panel-header-btn${showNew ? '' : ' primary'}`}
            onClick={() => { setShowNew(v => !v); setDraft(EMPTY_DRAFT) }}
          >
            <Plus size={14} /> New
          </button>
        </div>
      </div>

      {/* Filter bar */}
      <div className="tasks-board-filter-bar">
        <div className="tasks-board-search-wrapper">
          <Search size={12} className="tasks-board-search-icon" />
          <input
            className="tasks-board-search"
            type="text"
            placeholder="Search tasks..."
            value={filterText}
            onChange={e => setFilterText(e.target.value)}
          />
          {filterText && (
            <button className="tasks-board-search-clear" onClick={() => setFilterText('')}>
              <X size={10} />
            </button>
          )}
        </div>
        <select
          className="tasks-board-filter-select"
          value={filterPriority}
          onChange={e => setFilterPriority(e.target.value as 'all' | TaskPriority)}
        >
          <option value="all">All priorities</option>
          {PRIORITY_ORDER.map(p => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
        </select>
        {assignees.length > 0 && (
          <select
            className="tasks-board-filter-select"
            value={filterAssignee}
            onChange={e => setFilterAssignee(e.target.value)}
          >
            <option value="all">All assignees</option>
            {assignees.map(a => <option key={a} value={a}>{a}</option>)}
          </select>
        )}
        {activeFilterCount > 0 && (
          <button className="tasks-board-filter-clear" onClick={clearFilters}>
            Clear ({activeFilterCount})
          </button>
        )}
      </div>

      {/* New task form */}
      {showNew && (
        <div className="tasks-board-new-form">
          <input
            className="tasks-board-input"
            placeholder="Task title"
            value={draft.title}
            onChange={e => setDraft(d => ({ ...d, title: e.target.value }))}
            autoFocus
            onKeyDown={e => { if (e.key === 'Enter') handleSave() }}
          />
          <div className="tasks-board-new-row">
            <select
              className="tasks-board-select"
              value={draft.status}
              onChange={e => setDraft(d => ({ ...d, status: e.target.value as TaskStatus }))}
            >
              {STATUS_ORDER.map(s => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
            </select>
            <select
              className="tasks-board-select"
              value={draft.priority}
              onChange={e => setDraft(d => ({ ...d, priority: e.target.value as TaskPriority }))}
            >
              {PRIORITY_ORDER.map(p => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
            </select>
            <input
              className="tasks-board-input tasks-board-input-sm"
              placeholder="Assignee"
              value={draft.assignee}
              onChange={e => setDraft(d => ({ ...d, assignee: e.target.value }))}
            />
          </div>
          <input
            className="tasks-board-input"
            placeholder="Tags (comma-separated)"
            value={draft.tags}
            onChange={e => setDraft(d => ({ ...d, tags: e.target.value }))}
          />
          <textarea
            className="tasks-board-textarea"
            placeholder="Description"
            rows={5}
            value={draft.notes}
            onChange={e => setDraft(d => ({ ...d, notes: e.target.value }))}
          />
          <div className="tasks-board-new-actions">
            <button className="tasks-board-btn-secondary" onClick={() => setShowNew(false)}>Cancel</button>
            <button
              className="tasks-board-btn-primary"
              onClick={handleSave}
              disabled={saving || !draft.title.trim()}
            >
              {saving ? 'Saving...' : 'Create task'}
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="tasks-board-empty">Loading tasks...</div>
      ) : items.length === 0 && !showNew ? (
        <div className="tasks-board-empty">
          <ClipboardList size={28} />
          <p>No tasks yet</p>
          <p className="tasks-board-empty-hint">
            Add tasks here or write to <code>~/.claude-colony/colony-tasks.json</code>
          </p>
        </div>
      ) : (
        <div className="tasks-board-body">
          <div className={`tasks-board-columns${detailItem ? ' has-detail' : ''}`}>
            {STATUS_ORDER.map(status => (
              <div key={status} className={`tasks-board-column tasks-board-column-${status}`}>
                <div className="tasks-board-column-header">
                  {STATUS_ICON[status]}
                  <span>{STATUS_LABEL[status]}</span>
                  <span className="tasks-board-column-count">{grouped[status].length}</span>
                  <button
                    className="tasks-board-column-add"
                    title={`Add task to ${STATUS_LABEL[status]}`}
                    onClick={e => { e.stopPropagation(); setQuickAddCol(c => c === status ? null : status); setQuickAddTitle('') }}
                  >
                    <Plus size={11} />
                  </button>
                </div>

                {/* Quick add */}
                {quickAddCol === status && (
                  <div className="tasks-board-quick-add">
                    <input
                      className="tasks-board-input"
                      placeholder="Task title..."
                      value={quickAddTitle}
                      onChange={e => setQuickAddTitle(e.target.value)}
                      autoFocus
                      onKeyDown={e => {
                        if (e.key === 'Enter') handleQuickAdd(status)
                        if (e.key === 'Escape') { setQuickAddCol(null); setQuickAddTitle('') }
                      }}
                    />
                  </div>
                )}

                {/* Cards */}
                {grouped[status].map(item => (
                  <div
                    key={item.id}
                    className={`tasks-board-card${detailItem?.id === item.id ? ' selected' : ''}`}
                    onClick={() => openDetail(item)}
                  >
                    {/* Header row: priority + title + assignee */}
                    <div className="tasks-board-card-header">
                      <PriorityBadge priority={effectivePriority(item)} />
                      <span className="tasks-board-card-title">{item.title}</span>
                      {item.assignee && (
                        <span className="tasks-board-card-assignee">{item.assignee.slice(0, 8)}</span>
                      )}
                    </div>
                    {/* Body: notes preview (2 lines max) */}
                    {item.notes && (
                      <div className="tasks-board-card-notes">{item.notes}</div>
                    )}
                    {/* Footer: relative time + tags */}
                    <div className="tasks-board-card-footer">
                      {(item.updated || item.created) && (
                        <span className="tasks-board-card-time">{relativeTime(item.updated || item.created)}</span>
                      )}
                      {item.tags?.map(tag => (
                        <span key={tag} className="tasks-board-tag">{tag}</span>
                      ))}
                    </div>
                  </div>
                ))}

                {/* Empty column placeholder */}
                {grouped[status].length === 0 && (
                  <div className="tasks-board-column-empty">No tasks</div>
                )}
              </div>
            ))}
          </div>

          {/* Detail panel (sidebar overlay) */}
          {detailItem && (
            <div className="tasks-board-detail">
              <div className="tasks-board-detail-header">
                <span className="tasks-board-detail-title-text">
                  {editDraft ? 'Edit Task' : 'Task Details'}
                </span>
                <div className="tasks-board-detail-header-btns">
                  {!editDraft && (
                    <button
                      className="tasks-board-detail-btn"
                      title="Edit"
                      onClick={() => setEditDraft(draftFromItem(detailItem))}
                    >
                      <Pencil size={12} />
                    </button>
                  )}
                  <button
                    className="tasks-board-detail-btn danger"
                    title="Delete"
                    onClick={() => { if (confirm('Delete this task?')) handleDelete(detailItem.id) }}
                  >
                    <Trash2 size={12} />
                  </button>
                  <button
                    className="tasks-board-detail-btn"
                    title="Close"
                    onClick={() => { setDetailItem(null); setEditDraft(null) }}
                  >
                    <X size={12} />
                  </button>
                </div>
              </div>

              {editDraft ? (
                <div className="tasks-board-detail-body">
                  <label className="tasks-board-detail-label">Title</label>
                  <input
                    className="tasks-board-input"
                    value={editDraft.title}
                    onChange={e => setEditDraft(d => d && ({ ...d, title: e.target.value }))}
                    autoFocus
                  />

                  <div className="tasks-board-new-row">
                    <div className="tasks-board-detail-field">
                      <label className="tasks-board-detail-label">Status</label>
                      <select
                        className="tasks-board-select"
                        value={editDraft.status}
                        onChange={e => setEditDraft(d => d && ({ ...d, status: e.target.value as TaskStatus }))}
                      >
                        {STATUS_ORDER.map(s => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
                      </select>
                    </div>
                    <div className="tasks-board-detail-field">
                      <label className="tasks-board-detail-label">Priority</label>
                      <select
                        className="tasks-board-select"
                        value={editDraft.priority}
                        onChange={e => setEditDraft(d => d && ({ ...d, priority: e.target.value as TaskPriority }))}
                      >
                        {PRIORITY_ORDER.map(p => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
                      </select>
                    </div>
                  </div>

                  <label className="tasks-board-detail-label">Assignee</label>
                  <input
                    className="tasks-board-input"
                    placeholder="Assignee"
                    value={editDraft.assignee}
                    onChange={e => setEditDraft(d => d && ({ ...d, assignee: e.target.value }))}
                  />

                  <label className="tasks-board-detail-label">Tags</label>
                  <input
                    className="tasks-board-input"
                    placeholder="Comma-separated"
                    value={editDraft.tags}
                    onChange={e => setEditDraft(d => d && ({ ...d, tags: e.target.value }))}
                  />

                  <label className="tasks-board-detail-label">Description</label>
                  <textarea
                    className="tasks-board-textarea"
                    placeholder="Describe the task..."
                    rows={5}
                    value={editDraft.notes}
                    onChange={e => setEditDraft(d => d && ({ ...d, notes: e.target.value }))}
                  />

                  <div className="tasks-board-new-actions">
                    <button className="tasks-board-btn-secondary" onClick={() => setEditDraft(null)}>Cancel</button>
                    <button
                      className="tasks-board-btn-primary"
                      onClick={handleEditSave}
                      disabled={saving || !editDraft.title.trim()}
                    >
                      {saving ? 'Saving...' : 'Save'}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="tasks-board-detail-body">
                  {/* Priority + status row */}
                  <div className="tasks-board-detail-meta-row">
                    <span
                      className="tasks-board-detail-priority-pill"
                      style={{ background: PRIORITY_COLOR[effectivePriority(detailItem)], color: '#fff' }}
                    >
                      {PRIORITY_LABEL[effectivePriority(detailItem)]}
                    </span>
                    <span className="tasks-board-detail-status-pill">
                      {STATUS_ICON[detailItem.status]} {STATUS_LABEL[detailItem.status]}
                    </span>
                  </div>

                  {/* Title */}
                  <h3 className="tasks-board-detail-title">{detailItem.title}</h3>

                  {/* Assignee */}
                  {detailItem.assignee && (
                    <div className="tasks-board-detail-field-row">
                      <span className="tasks-board-detail-field-label">Assignee</span>
                      <span>{detailItem.assignee}</span>
                    </div>
                  )}

                  {/* Tags */}
                  {detailItem.tags && detailItem.tags.length > 0 && (
                    <div className="tasks-board-detail-tags">
                      {detailItem.tags.map(tag => (
                        <span key={tag} className="tasks-board-tag">{tag}</span>
                      ))}
                    </div>
                  )}

                  {/* Description */}
                  {detailItem.notes ? (
                    <div className="tasks-board-detail-description">
                      <span className="tasks-board-detail-field-label">Description</span>
                      <p className="tasks-board-detail-notes-text">{detailItem.notes}</p>
                    </div>
                  ) : (
                    <div className="tasks-board-detail-description">
                      <span className="tasks-board-detail-field-label">Description</span>
                      <p className="tasks-board-detail-notes-empty">No description</p>
                    </div>
                  )}

                  {/* Timestamps */}
                  <div className="tasks-board-detail-timestamps">
                    {detailItem.created && (
                      <span>Created {relativeTime(detailItem.created)}</span>
                    )}
                    {detailItem.updated && (
                      <span>Updated {relativeTime(detailItem.updated)}</span>
                    )}
                  </div>

                  {/* Status change buttons */}
                  <div className="tasks-board-detail-actions">
                    <span className="tasks-board-detail-field-label">Move to</span>
                    <div className="tasks-board-card-actions">
                      {STATUS_ORDER.filter(s => s !== detailItem.status).map(s => (
                        <button
                          key={s}
                          className="tasks-board-status-btn"
                          onClick={() => handleStatusChange(detailItem, s)}
                        >
                          {STATUS_ICON[s]} <ChevronRight size={10} /> {STATUS_LABEL[s]}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
