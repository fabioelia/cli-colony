import { useState, useRef, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import {
  HelpCircle, X, ChevronDown, ChevronRight,
  Plus, RotateCcw, Pin, Columns2, Settings, RefreshCw, Play, Pencil,
  Download, Upload, ArrowLeft, Brain, FileText, MessageSquare, Search,
  Filter, Zap, Square, Terminal, FolderOpen, Stethoscope, Trash2,
  GitBranch, GitMerge, Info, GitFork, User, Bell, BellRing, Eye, FileDown, StickyNote, Clock, Network, ArrowUpDown,
  AlertCircle, AlertTriangle, LayoutList, ShieldCheck, Shield, UserPlus, ClipboardList, GitCommit,
  Trophy, BarChart3, BarChart2, Globe, Navigation, ArrowRight, BookTemplate, Wand2, Hourglass, Undo2, EyeOff,
  Sparkles, DownloadCloud, TrendingUp, TerminalSquare, Wrench, Bug,
  Key, Github, LayoutGrid, Package, Rocket, Copy, GitCompare, CalendarClock, ChevronLeft,
  Circle, Users, Layers, CheckSquare, ListChecks, Gavel, ExternalLink, Palette, FileDiff, Send,
  Archive, DollarSign, Swords, Bot, Timer, Unlink, Link, ChevronsUp, ClipboardCopy, Activity,
  Home, Server, GitPullRequest, MoreHorizontal, ArrowLeftRight, ArrowDown, Bookmark,
  PauseCircle, PanelRight, PanelLeft, FolderTree, HardDrive, Ticket, CheckCircle2, Gauge,
  History, Cloud, ChevronsRight, Clipboard, ListOrdered, Crosshair, FileCode,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { helpContent, type HelpEntry, type HelpZone } from '../lib/help-content'

/** Map icon name strings to actual Lucide components */
const iconMap: Record<string, LucideIcon> = {
  Plus, RotateCcw, Pin, Columns2, Settings, RefreshCw, Play, Pencil,
  Download, Upload, ArrowLeft, Brain, FileText, MessageSquare, Search,
  Filter, Zap, Square, Terminal, FolderOpen, Stethoscope, Trash2,
  GitBranch, GitMerge, Info, GitFork, HelpCircle, ChevronDown, ChevronRight, User, Bell, BellRing, Eye, FileDown,
  StickyNote, Clock, Network, ArrowUpDown, AlertCircle, AlertTriangle, LayoutList, ShieldCheck, Shield, UserPlus,
  ClipboardList, GitCommit, Trophy, BarChart3, BarChart2, Globe, Navigation, ArrowRight, BookTemplate, Wand2, Hourglass, Undo2, EyeOff,
  Sparkles, DownloadCloud, TrendingUp, TerminalSquare, Wrench, Bug,
  Key, Github, LayoutGrid, Package, Rocket, Copy, GitCompare, CalendarClock, ChevronLeft,
  Circle, Users, Layers, CheckSquare, ListChecks, Gavel, ExternalLink, Palette, FileDiff, Send,
  Archive, DollarSign, Swords, Bot, Timer, Unlink, Link, ChevronsUp, ClipboardCopy, Activity,
  Home, Server, GitPullRequest, MoreHorizontal, ArrowLeftRight, ArrowDown, Bookmark,
  PauseCircle, PanelRight, PanelLeft, FolderTree, HardDrive, Ticket, CheckCircle2, Gauge, X,
  History, Cloud, ChevronsRight, Clipboard, ListOrdered, Crosshair, FileCode,
}

function HelpIcon({ name }: { name?: string }) {
  if (!name) return null
  const Icon = iconMap[name]
  if (!Icon) return null
  return <Icon size={12} className="help-item-icon" />
}

interface Props {
  topic: string
  align?: 'left' | 'right'
  position?: 'below' | 'above'
  /** Optional zone name — scopes the popover to show only that zone from the topic. */
  zone?: string
}

function Zone({ zone, defaultOpen }: { zone: HelpZone; defaultOpen: boolean }) {
  const [expanded, setExpanded] = useState(defaultOpen)
  return (
    <div className="help-zone">
      <button className="help-zone-header" onClick={() => setExpanded(!expanded)}>
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span className="help-zone-name">{zone.name}</span>
        <span className="help-zone-position">{zone.position}</span>
      </button>
      {expanded && (
        <ul className="help-zone-items">
          {zone.items.map((item, i) => (
            <li key={i}>
              <HelpIcon name={item.icon} />
              <strong>{item.label}</strong>
              <span>{item.detail}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export default function HelpPopover({ topic, align = 'left', position = 'below', zone }: Props) {
  const [open, setOpen] = useState(false)
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)

  const baseEntry: HelpEntry | undefined = helpContent[topic]
  if (!baseEntry) return null

  // If a zone is specified, filter the entry down to just that zone.
  // Match is case-insensitive and trims whitespace for resilience.
  const entry: HelpEntry = zone && baseEntry.zones
    ? (() => {
        const target = zone.trim().toLowerCase()
        const match = baseEntry.zones!.find(z => z.name.trim().toLowerCase() === target)
        if (!match) return baseEntry
        return {
          title: match.name,
          description: baseEntry.description,
          zones: [match],
          shortcuts: baseEntry.shortcuts,
        }
      })()
    : baseEntry

  const updatePosition = useCallback(() => {
    if (!btnRef.current) return
    const rect = btnRef.current.getBoundingClientRect()
    const popoverWidth = 400
    let top: number
    let left: number
    let pos = position

    if (pos === 'above') {
      top = rect.top - 6
    } else {
      top = rect.bottom + 6
    }

    if (align === 'right') {
      left = rect.left
    } else {
      left = rect.right - popoverWidth
    }

    // Clamp to viewport
    if (left < 8) left = 8
    if (left + popoverWidth > window.innerWidth - 8) left = window.innerWidth - popoverWidth - 8

    setCoords({ top, left })
  }, [align, position])

  useEffect(() => {
    if (!open) return
    updatePosition()
    const handleClick = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node) &&
          btnRef.current && !btnRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleKey)
    window.addEventListener('resize', updatePosition)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleKey)
      window.removeEventListener('resize', updatePosition)
    }
  }, [open, updatePosition])

  const hasZones = entry.zones && entry.zones.length > 0

  return (
    <div className="help-popover-anchor">
      <button
        ref={btnRef}
        className={`help-icon-btn ${open ? 'active' : ''}`}
        onClick={(e) => { e.stopPropagation(); setOpen(!open) }}
        title="Help"
      >
        <HelpCircle size={14} />
      </button>
      {open && coords && createPortal(
        <div
          ref={popoverRef}
          className={`help-popover ${position}`}
          style={{ top: coords.top, left: coords.left }}
        >
          <div className="help-popover-header">
            <h3>{entry.title}</h3>
            <button className="help-popover-close" onClick={() => setOpen(false)}>
              <X size={14} />
            </button>
          </div>
          <p className="help-popover-desc">{entry.description}</p>

          {hasZones ? (
            <div className="help-zones">
              {entry.zones!.map((zone, i) => (
                <Zone key={i} zone={zone} defaultOpen={i < 2} />
              ))}
            </div>
          ) : entry.items ? (
            <ul className="help-popover-items">
              {entry.items.map((item, i) => (
                <li key={i}>
                  <HelpIcon name={item.icon} />
                  <strong>{item.label}</strong>
                  <span>{item.detail}</span>
                </li>
              ))}
            </ul>
          ) : null}

          {entry.shortcuts && entry.shortcuts.length > 0 && (
            <div className="help-popover-shortcuts">
              <h4>Keyboard Shortcuts</h4>
              <div className="help-popover-shortcut-list">
                {entry.shortcuts.map((s, i) => (
                  <div key={i} className="help-shortcut-row">
                    <kbd>{s.keys}</kbd>
                    <span>{s.action}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>,
        document.body
      )}
    </div>
  )
}
