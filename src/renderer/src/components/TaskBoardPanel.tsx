import { useState, useEffect, useCallback } from 'react'
import { ClipboardList, Plus, Trash2, Pencil, CheckCircle2, Circle, Clock, AlertTriangle, RefreshCw } from 'lucide-react'
import type { TaskBoardItem, TaskStatus } from '../types'
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

interface NewTaskDraft {
  title: string
  status: TaskStatus
  assignee: string
  notes: string
  tags: string
}

const EMPTY_DRAFT: NewTaskDraft = { title: '', status: 'todo', assignee: '', notes: '', tags: '' }

export default function TaskBoardPanel() {
  const [items, setItems] = useState<TaskBoardItem[]>([])
  const [loading, setLoading] = useState(true)
  const [showNew, setShowNew] = useState(false)
  const [draft, setDraft] = useState<NewTaskDraft>(EMPTY_DRAFT)
  const [saving, setSaving] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState<NewTaskDraft>(EMPTY_DRAFT)

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
    const unsub = window.api.tasksBoard.onUpdated((data) => setItems(data))
    return unsub
  }, [loadBoard])

  const handleSave = async () => {
    if (!draft.title.trim()) return
    setSaving(true)
    try {
      const newItem: TaskBoardItem = {
        id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        title: draft.title.trim(),
        status: draft.status,
        assignee: draft.assignee.trim() || undefined,
        notes: draft.notes.trim() || undefined,
        tags: draft.tags ? draft.tags.split(',').map(t => t.trim()).filter(Boolean) : undefined,
      }
      await window.api.tasksBoard.save(newItem)
      setDraft(EMPTY_DRAFT)
      setShowNew(false)
    } finally {
      setSaving(false)
    }
  }

  const handleStatusChange = async (item: TaskBoardItem, next: TaskStatus) => {
    await window.api.tasksBoard.save({ ...item, status: next })
  }

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this task?')) return
    await window.api.tasksBoard.delete(id)
  }

  const handleStartEdit = (e: React.MouseEvent, item: TaskBoardItem) => {
    e.stopPropagation()
    setExpandedId(item.id)
    setEditingId(item.id)
    setEditDraft({
      title: item.title,
      status: item.status,
      assignee: item.assignee || '',
      notes: item.notes || '',
      tags: item.tags?.join(', ') || '',
    })
  }

  const handleEditSave = async (item: TaskBoardItem) => {
    if (!editDraft.title.trim()) return
    setSaving(true)
    try {
      const updated: TaskBoardItem = {
        ...item,
        title: editDraft.title.trim(),
        status: editDraft.status,
        assignee: editDraft.assignee.trim() || undefined,
        notes: editDraft.notes.trim() || undefined,
        tags: editDraft.tags ? editDraft.tags.split(',').map(t => t.trim()).filter(Boolean) : undefined,
      }
      await window.api.tasksBoard.save(updated)
      setEditingId(null)
    } finally {
      setSaving(false)
    }
  }

  const grouped = STATUS_ORDER.reduce<Record<TaskStatus, TaskBoardItem[]>>((acc, s) => {
    acc[s] = items.filter(i => i.status === s)
    return acc
  }, { todo: [], in_progress: [], blocked: [], done: [] })

  const activeCount = items.filter(i => i.status !== 'done').length

  return (
    <div className="tasks-board-panel">
      <div className="panel-header">
        <h2><ClipboardList size={16} /> Shared Task Board</h2>
        {activeCount > 0 && <span className="tasks-board-count">{activeCount} active</span>}
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
            <Plus size={14} /> Add task
          </button>
        </div>
      </div>

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
            <input
              className="tasks-board-input tasks-board-input-sm"
              placeholder="Assignee (optional)"
              value={draft.assignee}
              onChange={e => setDraft(d => ({ ...d, assignee: e.target.value }))}
            />
          </div>
          <input
            className="tasks-board-input"
            placeholder="Tags (comma-separated, optional)"
            value={draft.tags}
            onChange={e => setDraft(d => ({ ...d, tags: e.target.value }))}
          />
          <textarea
            className="tasks-board-textarea"
            placeholder="Notes (optional)"
            rows={2}
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
              {saving ? 'Saving...' : 'Add task'}
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="tasks-board-empty">Loading…</div>
      ) : items.length === 0 ? (
        <div className="tasks-board-empty">
          <ClipboardList size={28} />
          <p>No tasks yet</p>
          <p className="tasks-board-empty-hint">
            Add tasks here or write to <code>~/.claude-colony/colony-tasks.json</code>
          </p>
        </div>
      ) : (
        <div className="tasks-board-columns">
          {STATUS_ORDER.filter(s => s !== 'done' || grouped.done.length > 0).map(status => (
            grouped[status].length > 0 && (
              <div key={status} className={`tasks-board-column tasks-board-column-${status}`}>
                <div className="tasks-board-column-header">
                  {STATUS_ICON[status]}
                  <span>{STATUS_LABEL[status]}</span>
                  <span className="tasks-board-column-count">{grouped[status].length}</span>
                </div>
                {grouped[status].map(item => (
                  <div
                    key={item.id}
                    className={`tasks-board-card${expandedId === item.id ? ' expanded' : ''}`}
                    onClick={() => setExpandedId(id => {
                      const next = id === item.id ? null : item.id
                      if (next === null) setEditingId(null)
                      return next
                    })}
                  >
                    <div className="tasks-board-card-title">
                      <span>{item.title}</span>
                      <div className="tasks-board-card-title-btns">
                        <button
                          className="tasks-board-card-edit"
                          title="Edit task"
                          onClick={e => handleStartEdit(e, item)}
                        >
                          <Pencil size={11} />
                        </button>
                        <button
                          className="tasks-board-card-delete"
                          title="Delete task"
                          onClick={e => { e.stopPropagation(); handleDelete(item.id) }}
                        >
                          <Trash2 size={11} />
                        </button>
                      </div>
                    </div>
                    {(item.assignee || item.tags?.length) && (
                      <div className="tasks-board-card-meta">
                        {item.assignee && <span className="tasks-board-assignee">{item.assignee}</span>}
                        {item.tags?.map(tag => (
                          <span key={tag} className="tasks-board-tag">{tag}</span>
                        ))}
                      </div>
                    )}
                    {expandedId === item.id && (
                      <div className="tasks-board-card-detail" onClick={e => e.stopPropagation()}>
                        {editingId === item.id ? (
                          <div className="tasks-board-edit-form">
                            <div className="tasks-board-edit-header">Edit task</div>
                            <input
                              className="tasks-board-input"
                              placeholder="Task title"
                              value={editDraft.title}
                              onChange={e => setEditDraft(d => ({ ...d, title: e.target.value }))}
                              autoFocus
                            />
                            <div className="tasks-board-new-row">
                              <select
                                className="tasks-board-select"
                                value={editDraft.status}
                                onChange={e => setEditDraft(d => ({ ...d, status: e.target.value as TaskStatus }))}
                              >
                                {STATUS_ORDER.map(s => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
                              </select>
                              <input
                                className="tasks-board-input tasks-board-input-sm"
                                placeholder="Assignee (optional)"
                                value={editDraft.assignee}
                                onChange={e => setEditDraft(d => ({ ...d, assignee: e.target.value }))}
                              />
                            </div>
                            <input
                              className="tasks-board-input"
                              placeholder="Tags (comma-separated, optional)"
                              value={editDraft.tags}
                              onChange={e => setEditDraft(d => ({ ...d, tags: e.target.value }))}
                            />
                            <textarea
                              className="tasks-board-textarea"
                              placeholder="Notes (optional)"
                              rows={2}
                              value={editDraft.notes}
                              onChange={e => setEditDraft(d => ({ ...d, notes: e.target.value }))}
                            />
                            <div className="tasks-board-new-actions">
                              <button className="tasks-board-btn-secondary" onClick={() => setEditingId(null)}>Cancel</button>
                              <button
                                className="tasks-board-btn-primary"
                                onClick={() => handleEditSave(item)}
                                disabled={saving || !editDraft.title.trim()}
                              >
                                {saving ? 'Saving...' : 'Save changes'}
                              </button>
                            </div>
                          </div>
                        ) : (
                          <>
                            {item.notes && <p className="tasks-board-notes">{item.notes}</p>}
                            {item.updated && (
                              <p className="tasks-board-updated">
                                Updated {new Date(item.updated).toLocaleString()}
                              </p>
                            )}
                            <div className="tasks-board-card-actions">
                              {STATUS_ORDER.filter(s => s !== item.status).map(s => (
                                <button
                                  key={s}
                                  className="tasks-board-status-btn"
                                  onClick={e => { e.stopPropagation(); handleStatusChange(item, s) }}
                                >
                                  {STATUS_ICON[s]} {STATUS_LABEL[s]}
                                </button>
                              ))}
                            </div>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )
          ))}
        </div>
      )}
    </div>
  )
}
