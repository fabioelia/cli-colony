import { useState, useEffect, useMemo, useCallback } from 'react'
import { ChevronLeft, ChevronRight, Copy, GitCommit } from 'lucide-react'
import type { ClaudeInstance } from '../../../preload'
import type { SessionArtifact } from '../../../shared/types'

interface Props {
  instances: ClaudeInstance[]
  onFocusInstance: (id: string) => void
}

interface TimelineBar {
  id: string
  name: string
  personaName?: string
  color: string
  startMinute: number   // minutes since midnight
  endMinute: number     // minutes since midnight (clamped to day)
  running: boolean
  costUsd: number
  commitCount: number
  filesChanged: number
  insertions: number
  deletions: number
  durationMs: number
  parentBarId?: string
  childBarIds: string[]
}

/** Format date as "Wed, Apr 9" */
function fmtDate(d: Date): string {
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
}

function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

function fmtDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000)
  if (totalSec < 60) return `${totalSec}s`
  const mins = Math.floor(totalSec / 60)
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  const rem = mins % 60
  return rem > 0 ? `${hrs}h ${rem}m` : `${hrs}h`
}

function fmtCost(cost: number): string {
  if (cost <= 0) return ''
  if (cost < 0.01) return '<$0.01'
  return `$${cost.toFixed(2)}`
}

function minuteToTime(m: number): string {
  const h = Math.floor(m / 60)
  const mm = Math.floor(m % 60)
  return `${h.toString().padStart(2, '0')}:${mm.toString().padStart(2, '0')}`
}

/** Deterministic persona color from name hash → HSL */
function personaColor(name: string): string {
  let hash = 0
  for (let i = 0; i < name.length; i++) hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0
  const hue = ((hash % 360) + 360) % 360
  return `hsl(${hue}, 55%, 55%)`
}

const HOUR_WIDTH = 40
const ROW_HEIGHT = 28
const LABEL_WIDTH = 160
const HEADER_HEIGHT = 24
const SVG_PADDING_TOP = 4
const BAR_HEIGHT = 16
const BAR_RADIUS = 3
const MIN_BAR_WIDTH = 4

export default function SessionTimeline({ instances, onFocusInstance }: Props) {
  const [dayOffset, setDayOffset] = useState(0)
  const [artifacts, setArtifacts] = useState<SessionArtifact[]>([])
  const [hoveredBar, setHoveredBar] = useState<string | null>(null)
  const [hoveredChain, setHoveredChain] = useState<Set<string>>(new Set())
  const [now, setNow] = useState(Date.now())
  const [filterPersona, setFilterPersona] = useState<string>('all')

  const selectedDate = useMemo(() => {
    const d = new Date()
    d.setDate(d.getDate() + dayOffset)
    d.setHours(0, 0, 0, 0)
    return d
  }, [dayOffset])

  const isToday = dayOffset === 0

  // Load artifacts
  useEffect(() => {
    window.api.artifacts.list().then(setArtifacts).catch(() => {})
  }, [])

  // Tick "now" every 30s for running sessions
  useEffect(() => {
    if (!isToday) return
    const id = setInterval(() => setNow(Date.now()), 30000)
    return () => clearInterval(id)
  }, [isToday])

  // Build timeline bars
  const bars = useMemo(() => {
    const dayStart = selectedDate.getTime()
    const dayEnd = dayStart + 86400000
    const result: TimelineBar[] = []
    const seenIds = new Set<string>()

    // 1. Artifacts (historical sessions)
    for (const art of artifacts) {
      const startTs = new Date(art.sessionStartedAt).getTime()
      const endTs = startTs + art.durationMs
      // Session must overlap with selected day
      if (endTs < dayStart || startTs >= dayEnd) continue
      seenIds.add(art.sessionId)

      const clampedStart = Math.max(startTs, dayStart)
      const clampedEnd = Math.min(endTs, dayEnd)
      const startDate = new Date(clampedStart)
      const endDate = new Date(clampedEnd)

      result.push({
        id: art.sessionId,
        name: art.sessionName,
        personaName: art.personaName,
        color: art.personaName ? personaColor(art.personaName) : 'var(--accent)',
        startMinute: startDate.getHours() * 60 + startDate.getMinutes() + startDate.getSeconds() / 60,
        endMinute: endDate.getHours() * 60 + endDate.getMinutes() + endDate.getSeconds() / 60,
        running: false,
        costUsd: art.costUsd ?? 0,
        commitCount: art.commits.length,
        filesChanged: art.changes.length,
        insertions: art.totalInsertions,
        deletions: art.totalDeletions,
        durationMs: art.durationMs,
        childBarIds: [],
      })
    }

    // 2. Live instances (running now — only relevant if viewing today)
    if (isToday) {
      for (const inst of instances) {
        if (seenIds.has(inst.id)) continue
        const startTs = new Date(inst.createdAt).getTime()
        if (startTs >= dayEnd || startTs < dayStart) continue

        const clampedStart = Math.max(startTs, dayStart)
        const startDate = new Date(clampedStart)
        const nowDate = new Date(now)
        const isRunning = inst.status === 'running'

        const personaName = inst.name.startsWith('Persona: ')
          ? inst.name.slice('Persona: '.length)
          : undefined

        result.push({
          id: inst.id,
          name: inst.name,
          personaName,
          color: inst.color || 'var(--accent)',
          startMinute: startDate.getHours() * 60 + startDate.getMinutes() + startDate.getSeconds() / 60,
          endMinute: isRunning
            ? nowDate.getHours() * 60 + nowDate.getMinutes() + nowDate.getSeconds() / 60
            : startDate.getHours() * 60 + startDate.getMinutes() + 5, // exited without artifact — estimate 5 min
          running: isRunning,
          costUsd: inst.tokenUsage.cost ?? 0,
          commitCount: 0,
          filesChanged: 0,
          insertions: 0,
          deletions: 0,
          durationMs: now - startTs,
          childBarIds: [],
        })
      }
    }

    // Sort by start time
    result.sort((a, b) => a.startMinute - b.startMinute)

    // Link parent→child using live instance data
    const barById = new Map(result.map(b => [b.id, b]))
    if (isToday) {
      for (const inst of instances) {
        const bar = barById.get(inst.id)
        if (!bar) continue
        if (inst.parentId && barById.has(inst.parentId)) {
          bar.parentBarId = inst.parentId
        }
        bar.childBarIds = inst.childIds.filter(id => barById.has(id))
      }
    }

    return result
  }, [artifacts, instances, selectedDate, isToday, now])

  const handleCopyMarkdown = useCallback(() => {
    const fmtTime = (minute: number): string => {
      const clamped = Math.min(minute, 23 * 60 + 59)
      const h = Math.floor(clamped / 60)
      const m = Math.round(clamped % 60)
      return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`
    }
    const sorted = [...bars].sort((a, b) => a.startMinute - b.startMinute)
    const lines = [
      '| Session | Persona | Start | End | Duration | Cost | Commits | Files |',
      '|---------|---------|-------|-----|----------|------|---------|-------|',
    ]
    for (const bar of sorted) {
      const start = fmtTime(bar.startMinute)
      const end = bar.running ? 'running' : fmtTime(bar.endMinute)
      const dur = bar.durationMs > 0 ? `${Math.round(bar.durationMs / 60000)}m` : '-'
      const cost = bar.costUsd > 0 ? `$${bar.costUsd.toFixed(2)}` : '-'
      lines.push(`| ${bar.name} | ${bar.personaName || '-'} | ${start} | ${end} | ${dur} | ${cost} | ${bar.commitCount} | ${bar.filesChanged} |`)
    }
    lines.push('', `*Generated from Colony timeline — ${fmtDate(selectedDate)}*`)
    navigator.clipboard.writeText(lines.join('\n'))
  }, [bars, selectedDate])

  const personaNames = useMemo(() =>
    [...new Set(bars.filter(b => b.personaName).map(b => b.personaName!))].sort()
  , [bars])

  const filteredBars = useMemo(() => {
    if (filterPersona === 'all') return bars
    if (filterPersona === 'running') return bars.filter(b => b.running)
    if (filterPersona === 'manual') return bars.filter(b => !b.personaName)
    return bars.filter(b => b.personaName === filterPersona)
  }, [bars, filterPersona])

  // Summary stats (from filtered bars)
  const summary = useMemo(() => {
    const totalMs = filteredBars.reduce((s, b) => s + b.durationMs, 0)
    const totalCost = filteredBars.reduce((s, b) => s + b.costUsd, 0)
    const totalCommits = filteredBars.reduce((s, b) => s + b.commitCount, 0)
    const hrs = totalMs / 3600000
    return {
      count: filteredBars.length,
      hours: hrs < 1 ? `${Math.round(hrs * 60)}m` : `${hrs.toFixed(1)}h`,
      cost: fmtCost(totalCost),
      commits: totalCommits,
    }
  }, [filteredBars])

  // Pick persona color or session color
  const barColor = useCallback((bar: TimelineBar) => {
    // If there's a persona, try to use its color
    return bar.color
  }, [])

  /** Walk up to root ancestor, then DFS down to collect entire chain */
  const getChainIds = useCallback((barId: string): Set<string> => {
    const byId = new Map(bars.map(b => [b.id, b]))
    let root = byId.get(barId)
    if (!root) return new Set()
    // Walk up to root (cap at 5)
    for (let i = 0; i < 5 && root.parentBarId; i++) {
      const parent = byId.get(root.parentBarId)
      if (!parent) break
      root = parent
    }
    // DFS from root
    const ids = new Set<string>()
    const visit = (b: TimelineBar, depth: number) => {
      ids.add(b.id)
      if (depth >= 5) return
      for (const cid of b.childBarIds) {
        const child = byId.get(cid)
        if (child) visit(child, depth + 1)
      }
    }
    visit(root, 0)
    return ids
  }, [bars])

  const handleBarHover = useCallback((barId: string | null) => {
    setHoveredBar(barId)
    if (barId) {
      const chain = getChainIds(barId)
      setHoveredChain(chain.size > 1 ? chain : new Set())
    } else {
      setHoveredChain(new Set())
    }
  }, [getChainIds])

  const svgWidth = LABEL_WIDTH + 24 * HOUR_WIDTH
  const rowCount = Math.max(filteredBars.length, 1)
  const svgHeight = HEADER_HEIGHT + SVG_PADDING_TOP + rowCount * ROW_HEIGHT + 4

  return (
    <div className="session-timeline">
      {/* Day selector */}
      <div className="schedule-heatmap-nav">
        <button onClick={() => setDayOffset(o => o - 1)} title="Previous day"><ChevronLeft size={14} /></button>
        <span className="schedule-heatmap-date">{fmtDate(selectedDate)}{isToday ? ' (Today)' : ''}</span>
        <button onClick={() => setDayOffset(o => o + 1)} title="Next day" disabled={dayOffset >= 0}><ChevronRight size={14} /></button>
        {!isToday && (
          <button className="schedule-heatmap-today" onClick={() => setDayOffset(0)}>Today</button>
        )}
        <button className="panel-header-btn" onClick={handleCopyMarkdown} title="Copy timeline as markdown table" style={{ marginLeft: 'auto' }}>
          <Copy size={12} />
        </button>
        <select className="session-timeline-filter" value={filterPersona} onChange={e => setFilterPersona(e.target.value)}>
          <option value="all">All Sessions</option>
          <option value="running">Running Only</option>
          <option value="manual">Manual Only</option>
          {personaNames.map(n => <option key={n} value={n}>{n}</option>)}
        </select>
      </div>

      {/* Summary strip */}
      <div className="session-timeline-summary">
        <span>{summary.count} session{summary.count !== 1 ? 's' : ''}</span>
        <span className="session-timeline-summary-sep">·</span>
        <span>{summary.hours} compute</span>
        {summary.cost && (
          <>
            <span className="session-timeline-summary-sep">·</span>
            <span>{summary.cost}</span>
          </>
        )}
        {summary.commits > 0 && (
          <>
            <span className="session-timeline-summary-sep">·</span>
            <span><GitCommit size={11} style={{ verticalAlign: -1 }} /> {summary.commits} commit{summary.commits !== 1 ? 's' : ''}</span>
          </>
        )}
      </div>

      {/* SVG timeline */}
      <div className="session-timeline-scroll">
        <svg width={svgWidth} height={svgHeight} className="session-timeline-svg">
          {/* Hour labels */}
          {Array.from({ length: 24 }, (_, h) => (
            <text
              key={`h${h}`}
              x={LABEL_WIDTH + h * HOUR_WIDTH + HOUR_WIDTH / 2}
              y={HEADER_HEIGHT - 4}
              textAnchor="middle"
              className="schedule-hour-label"
            >
              {h.toString().padStart(2, '0')}
            </text>
          ))}

          {/* Hour grid lines */}
          {Array.from({ length: 25 }, (_, h) => (
            <line
              key={`gl${h}`}
              x1={LABEL_WIDTH + h * HOUR_WIDTH}
              y1={HEADER_HEIGHT}
              x2={LABEL_WIDTH + h * HOUR_WIDTH}
              y2={svgHeight}
              className="schedule-grid-line"
            />
          ))}

          {/* "Now" line (today only) */}
          {isToday && (() => {
            const nd = new Date(now)
            const nowMin = nd.getHours() * 60 + nd.getMinutes()
            const x = LABEL_WIDTH + (nowMin / 60) * HOUR_WIDTH
            return (
              <line
                x1={x} y1={HEADER_HEIGHT}
                x2={x} y2={svgHeight}
                className="session-timeline-now-line"
              />
            )
          })()}

          {/* Arrowhead marker for dependency arrows */}
          <defs>
            <marker id="dep-arrowhead" markerWidth="6" markerHeight="4" refX="6" refY="2" orient="auto">
              <polygon points="0 0, 6 2, 0 4" fill="var(--text-muted)" fillOpacity="0.6" />
            </marker>
          </defs>

          {/* Dependency arrows (behind bars in z-order) */}
          {filteredBars.map((bar, idx) => {
            if (!bar.parentBarId) return null
            const parentIdx = filteredBars.findIndex(b => b.id === bar.parentBarId)
            if (parentIdx < 0 || parentIdx === idx) return null
            const parent = filteredBars[parentIdx]

            const x1 = LABEL_WIDTH + (parent.endMinute / 60) * HOUR_WIDTH
            const y1 = HEADER_HEIGHT + SVG_PADDING_TOP + parentIdx * ROW_HEIGHT + ROW_HEIGHT / 2
            const x2 = LABEL_WIDTH + (bar.startMinute / 60) * HOUR_WIDTH
            const y2 = HEADER_HEIGHT + SVG_PADDING_TOP + idx * ROW_HEIGHT + ROW_HEIGHT / 2
            const midX = (x1 + x2) / 2

            return (
              <path
                key={`arrow-${bar.id}`}
                d={`M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`}
                stroke={parent.color}
                strokeOpacity={hoveredChain.size === 0 || hoveredChain.has(bar.id) ? 0.5 : 0.1}
                strokeWidth={1.5}
                fill="none"
                markerEnd="url(#dep-arrowhead)"
              />
            )
          })}

          {/* Session bars */}
          {filteredBars.length === 0 ? (
            <text
              x={svgWidth / 2}
              y={HEADER_HEIGHT + 40}
              textAnchor="middle"
              className="session-timeline-empty-text"
            >
              No sessions on this day
            </text>
          ) : filteredBars.map((bar, i) => {
            const y = HEADER_HEIGHT + SVG_PADDING_TOP + i * ROW_HEIGHT
            const x1 = LABEL_WIDTH + (bar.startMinute / 60) * HOUR_WIDTH
            const x2 = LABEL_WIDTH + (bar.endMinute / 60) * HOUR_WIDTH
            const barWidth = Math.max(x2 - x1, MIN_BAR_WIDTH)
            const isHovered = hoveredBar === bar.id
            const dimmed = hoveredChain.size > 0 && !hoveredChain.has(bar.id)

            return (
              <g
                key={bar.id}
                className="session-timeline-row"
                onClick={() => onFocusInstance(bar.id)}
                onMouseEnter={() => handleBarHover(bar.id)}
                onMouseLeave={() => handleBarHover(null)}
                style={{ cursor: 'pointer', opacity: dimmed ? 0.3 : 1 }}
              >
                {/* Row background (alternating) */}
                {i % 2 === 0 && (
                  <rect x={LABEL_WIDTH} y={y} width={24 * HOUR_WIDTH} height={ROW_HEIGHT} className="schedule-row-bg" />
                )}

                {/* Session label */}
                <text
                  x={4}
                  y={y + ROW_HEIGHT / 2 + 4}
                  className="session-timeline-label"
                >
                  {(bar.personaName || bar.name).length > 20
                    ? (bar.personaName || bar.name).slice(0, 18) + '…'
                    : (bar.personaName || bar.name)}
                </text>

                {/* Duration chip */}
                <text
                  x={LABEL_WIDTH - 6}
                  y={y + ROW_HEIGHT / 2 + 3}
                  textAnchor="end"
                  className="schedule-cron-chip"
                >
                  {fmtDuration(bar.durationMs)}
                </text>

                {/* Bar */}
                <rect
                  x={x1}
                  y={y + (ROW_HEIGHT - BAR_HEIGHT) / 2}
                  width={barWidth}
                  height={BAR_HEIGHT}
                  rx={BAR_RADIUS}
                  fill={barColor(bar)}
                  opacity={isHovered ? 1 : 0.75}
                  className={bar.running ? 'session-timeline-bar-running' : undefined}
                />

                {/* Commit dots on bar */}
                {bar.commitCount > 0 && barWidth > 20 && (
                  <g>
                    <circle
                      cx={x1 + barWidth / 2}
                      cy={y + ROW_HEIGHT / 2}
                      r={3}
                      style={{ fill: 'var(--text-muted)' }}
                    />
                    {bar.commitCount > 1 && barWidth > 40 && (
                      <text
                        x={x1 + barWidth / 2 + 6}
                        y={y + ROW_HEIGHT / 2 + 3}
                        className="session-timeline-commit-label"
                      >
                        {bar.commitCount}
                      </text>
                    )}
                  </g>
                )}

                {/* Persona badge on bar (if wide enough) */}
                {bar.personaName && barWidth > 80 && (
                  <text
                    x={x1 + 6}
                    y={y + ROW_HEIGHT / 2 + 3}
                    className="session-timeline-bar-text"
                  >
                    {bar.personaName.length > 12 ? bar.personaName.slice(0, 10) + '…' : bar.personaName}
                  </text>
                )}

                {/* Tooltip */}
                <title>
                  {bar.name}
                  {bar.personaName ? ` (${bar.personaName})` : ''}
                  {'\n'}Duration: {fmtDuration(bar.durationMs)}
                  {bar.costUsd > 0 ? `\nCost: ${fmtCost(bar.costUsd)}` : ''}
                  {bar.commitCount > 0 ? `\nCommits: ${bar.commitCount}` : ''}
                  {bar.filesChanged > 0 ? `\nFiles: ${bar.filesChanged} (+${bar.insertions} -${bar.deletions})` : ''}
                  {bar.running ? '\n⟳ Running' : ''}
                  {`\n${minuteToTime(bar.startMinute)} → ${bar.running ? 'now' : minuteToTime(bar.endMinute)}`}
                </title>
              </g>
            )
          })}
        </svg>
      </div>

      {/* Legend */}
      <div className="schedule-heatmap-legend">
        <span className="schedule-legend-item"><span className="session-timeline-legend-bar" /> Manual</span>
        <span className="schedule-legend-item"><span className="session-timeline-legend-bar running" /> Running</span>
        <span className="schedule-legend-item"><span className="session-timeline-legend-now" /> Now</span>
        {personaNames.slice(0, 3).map(n => (
          <span key={n} className="schedule-legend-item">
            <span className="session-timeline-legend-bar" style={{ background: personaColor(n) }} /> {n}
          </span>
        ))}
      </div>
    </div>
  )
}
