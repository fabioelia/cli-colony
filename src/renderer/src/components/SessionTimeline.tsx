import { useState, useEffect, useMemo, useCallback } from 'react'
import { ChevronLeft, ChevronRight, GitCommit } from 'lucide-react'
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
  const [now, setNow] = useState(Date.now())

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
        color: 'var(--accent)',
        startMinute: startDate.getHours() * 60 + startDate.getMinutes() + startDate.getSeconds() / 60,
        endMinute: endDate.getHours() * 60 + endDate.getMinutes() + endDate.getSeconds() / 60,
        running: false,
        costUsd: art.costUsd ?? 0,
        commitCount: art.commits.length,
        filesChanged: art.changes.length,
        insertions: art.totalInsertions,
        deletions: art.totalDeletions,
        durationMs: art.durationMs,
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
        })
      }
    }

    // Sort by start time
    result.sort((a, b) => a.startMinute - b.startMinute)
    return result
  }, [artifacts, instances, selectedDate, isToday, now])

  // Summary stats
  const summary = useMemo(() => {
    const totalMs = bars.reduce((s, b) => s + b.durationMs, 0)
    const totalCost = bars.reduce((s, b) => s + b.costUsd, 0)
    const totalCommits = bars.reduce((s, b) => s + b.commitCount, 0)
    const hrs = totalMs / 3600000
    return {
      count: bars.length,
      hours: hrs < 1 ? `${Math.round(hrs * 60)}m` : `${hrs.toFixed(1)}h`,
      cost: fmtCost(totalCost),
      commits: totalCommits,
    }
  }, [bars])

  // Pick persona color or session color
  const barColor = useCallback((bar: TimelineBar) => {
    // If there's a persona, try to use its color
    return bar.color
  }, [])

  const svgWidth = LABEL_WIDTH + 24 * HOUR_WIDTH
  const rowCount = Math.max(bars.length, 1)
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

          {/* Session bars */}
          {bars.length === 0 ? (
            <text
              x={svgWidth / 2}
              y={HEADER_HEIGHT + 40}
              textAnchor="middle"
              className="session-timeline-empty-text"
            >
              No sessions on this day
            </text>
          ) : bars.map((bar, i) => {
            const y = HEADER_HEIGHT + SVG_PADDING_TOP + i * ROW_HEIGHT
            const x1 = LABEL_WIDTH + (bar.startMinute / 60) * HOUR_WIDTH
            const x2 = LABEL_WIDTH + (bar.endMinute / 60) * HOUR_WIDTH
            const barWidth = Math.max(x2 - x1, MIN_BAR_WIDTH)
            const isHovered = hoveredBar === bar.id

            return (
              <g
                key={bar.id}
                className="session-timeline-row"
                onClick={() => onFocusInstance(bar.id)}
                onMouseEnter={() => setHoveredBar(bar.id)}
                onMouseLeave={() => setHoveredBar(null)}
                style={{ cursor: 'pointer' }}
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
                      fill="rgba(255,255,255,0.6)"
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
        <span className="schedule-legend-item"><span className="session-timeline-legend-bar" /> Session</span>
        <span className="schedule-legend-item"><span className="session-timeline-legend-bar running" /> Running</span>
        <span className="schedule-legend-item"><span className="session-timeline-legend-now" /> Now</span>
      </div>
    </div>
  )
}
