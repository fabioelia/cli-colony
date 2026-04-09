import { useState, useEffect, useMemo } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { cronFireTimesForDay, describeCron } from '../../../shared/cron'
import type { PersonaInfo, PersonaRunEntry } from '../../../shared/types'

interface Props {
  personas: PersonaInfo[]
}

/** Format date as "Wed, Apr 9" */
function fmtDate(d: Date): string {
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
}

/** Check if two dates are the same calendar day */
function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

const HOUR_WIDTH = 40
const ROW_HEIGHT = 28
const LABEL_WIDTH = 180
const HEADER_HEIGHT = 24
const SVG_PADDING_TOP = 4

export default function PersonaScheduleHeatmap({ personas }: Props) {
  const [dayOffset, setDayOffset] = useState(0)
  const [runHistory, setRunHistory] = useState<Record<string, PersonaRunEntry[]>>({})

  const selectedDate = useMemo(() => {
    const d = new Date()
    d.setDate(d.getDate() + dayOffset)
    d.setHours(0, 0, 0, 0)
    return d
  }, [dayOffset])

  const isToday = dayOffset === 0

  // Filter to personas with a schedule
  const scheduledPersonas = useMemo(
    () => personas.filter(p => p.schedule?.trim()).sort((a, b) => a.name.localeCompare(b.name)),
    [personas],
  )

  // Fetch run history for all scheduled personas
  useEffect(() => {
    let cancelled = false
    async function load() {
      const hist: Record<string, PersonaRunEntry[]> = {}
      await Promise.all(
        scheduledPersonas.map(async (p) => {
          try {
            const runs = await window.api.persona.getRunHistory(p.id)
            if (!cancelled) hist[p.id] = runs
          } catch { /* ignore */ }
        }),
      )
      if (!cancelled) setRunHistory(hist)
    }
    load()
    return () => { cancelled = true }
  }, [scheduledPersonas, dayOffset])

  // Pre-compute fire times per persona
  const fireTimes = useMemo(() => {
    const map: Record<string, { hour: number; minute: number }[]> = {}
    for (const p of scheduledPersonas) {
      map[p.id] = cronFireTimesForDay(p.schedule, selectedDate)
    }
    return map
  }, [scheduledPersonas, selectedDate])

  // Compute overlap counts per minute slot
  const overlapByMinute = useMemo(() => {
    const counts: number[] = new Array(1440).fill(0)
    for (const p of scheduledPersonas) {
      for (const t of (fireTimes[p.id] ?? [])) {
        counts[t.hour * 60 + t.minute]++
      }
    }
    return counts
  }, [scheduledPersonas, fireTimes])

  // Find minutes where 3+ overlap
  const overlapSlots = useMemo(() => {
    const slots: { minute: number; count: number }[] = []
    for (let i = 0; i < 1440; i++) {
      if (overlapByMinute[i] >= 3) slots.push({ minute: i, count: overlapByMinute[i] })
    }
    return slots
  }, [overlapByMinute])

  const svgWidth = LABEL_WIDTH + 24 * HOUR_WIDTH
  const svgHeight = HEADER_HEIGHT + SVG_PADDING_TOP + scheduledPersonas.length * ROW_HEIGHT + 4

  if (scheduledPersonas.length === 0) {
    return (
      <div className="schedule-heatmap-empty">
        No personas with cron schedules found.
      </div>
    )
  }

  return (
    <div className="schedule-heatmap">
      {/* Day selector */}
      <div className="schedule-heatmap-nav">
        <button onClick={() => setDayOffset(o => o - 1)} title="Previous day"><ChevronLeft size={14} /></button>
        <span className="schedule-heatmap-date">{fmtDate(selectedDate)}{isToday ? ' (Today)' : ''}</span>
        <button onClick={() => setDayOffset(o => o + 1)} title="Next day" disabled={dayOffset >= 0}><ChevronRight size={14} /></button>
        {!isToday && (
          <button className="schedule-heatmap-today" onClick={() => setDayOffset(0)}>Today</button>
        )}
      </div>

      <div className="schedule-heatmap-scroll">
        <svg width={svgWidth} height={svgHeight} className="schedule-heatmap-svg">
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

          {/* Overlap bands (3+ simultaneous) */}
          {overlapSlots.map(({ minute, count }) => {
            const x = LABEL_WIDTH + (minute / 60) * HOUR_WIDTH
            return (
              <rect
                key={`ov${minute}`}
                x={x}
                y={HEADER_HEIGHT}
                width={Math.max(2, HOUR_WIDTH / 60)}
                height={svgHeight - HEADER_HEIGHT}
                className="schedule-overlap-band"
              >
                <title>{count} personas fire at {Math.floor(minute / 60).toString().padStart(2, '0')}:{(minute % 60).toString().padStart(2, '0')}</title>
              </rect>
            )
          })}

          {/* Rows */}
          {scheduledPersonas.map((persona, i) => {
            const y = HEADER_HEIGHT + SVG_PADDING_TOP + i * ROW_HEIGHT
            const times = fireTimes[persona.id] ?? []
            const runs = (runHistory[persona.id] ?? []).filter(r => isSameDay(new Date(r.timestamp), selectedDate))

            return (
              <g key={persona.id}>
                {/* Row background */}
                {i % 2 === 0 && (
                  <rect x={LABEL_WIDTH} y={y} width={24 * HOUR_WIDTH} height={ROW_HEIGHT} className="schedule-row-bg" />
                )}

                {/* Persona label */}
                <text
                  x={4}
                  y={y + ROW_HEIGHT / 2 + 4}
                  className={`schedule-persona-label${!persona.enabled ? ' disabled' : ''}`}
                >
                  {persona.name.length > 22 ? persona.name.slice(0, 20) + '…' : persona.name}
                </text>

                {/* Cron chip */}
                <text
                  x={LABEL_WIDTH - 6}
                  y={y + ROW_HEIGHT / 2 + 3}
                  textAnchor="end"
                  className="schedule-cron-chip"
                >
                  {describeCron(persona.schedule).length > 14
                    ? describeCron(persona.schedule).slice(0, 12) + '…'
                    : describeCron(persona.schedule)}
                </text>

                {/* Scheduled fire times — thin bars */}
                {times.map((t, ti) => {
                  const x = LABEL_WIDTH + (t.hour + t.minute / 60) * HOUR_WIDTH
                  return (
                    <rect
                      key={`s${ti}`}
                      x={x}
                      y={y + 4}
                      width={2}
                      height={ROW_HEIGHT - 8}
                      className={`schedule-fire-bar${!persona.enabled ? ' disabled' : ''}`}
                    >
                      <title>{persona.name} — {t.hour.toString().padStart(2, '0')}:{t.minute.toString().padStart(2, '0')}</title>
                    </rect>
                  )
                })}

                {/* Actual run dots */}
                {runs.map((run, ri) => {
                  const rd = new Date(run.timestamp)
                  const x = LABEL_WIDTH + (rd.getHours() + rd.getMinutes() / 60) * HOUR_WIDTH
                  // Find the closest scheduled time to determine if late (>2min)
                  const runMinute = rd.getHours() * 60 + rd.getMinutes()
                  const closestScheduled = times.reduce((best, t) => {
                    const sm = t.hour * 60 + t.minute
                    const dist = Math.abs(runMinute - sm)
                    return dist < best ? dist : best
                  }, Infinity)
                  const late = closestScheduled > 2
                  return (
                    <circle
                      key={`r${ri}`}
                      cx={x}
                      cy={y + ROW_HEIGHT / 2}
                      r={3.5}
                      className={`schedule-run-dot${late ? ' late' : ''}`}
                    >
                      <title>
                        {run.success ? 'OK' : 'FAIL'} — {rd.getHours().toString().padStart(2, '0')}:{rd.getMinutes().toString().padStart(2, '0')}
                        {late ? ' (late)' : ''} — {Math.round(run.durationMs / 1000)}s
                      </title>
                    </circle>
                  )
                })}
              </g>
            )
          })}
        </svg>
      </div>

      {/* Legend */}
      <div className="schedule-heatmap-legend">
        <span className="schedule-legend-item"><span className="schedule-legend-bar" /> Scheduled</span>
        <span className="schedule-legend-item"><span className="schedule-legend-dot green" /> Ran on time</span>
        <span className="schedule-legend-item"><span className="schedule-legend-dot amber" /> Ran late (&gt;2min)</span>
        <span className="schedule-legend-item"><span className="schedule-legend-overlap" /> 3+ overlap</span>
      </div>
    </div>
  )
}
