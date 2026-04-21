import { useState, useEffect, useMemo } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { cronFireTimesForDay, describeCron } from '../../../shared/cron'

interface PipelineInfo {
  name: string
  enabled: boolean
  cron: string | null
}

interface RunEntry {
  ts: string
  success: boolean
  durationMs: number
}

interface Props {
  pipelines: PipelineInfo[]
}

function fmtDate(d: Date): string {
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
}

function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

const HOUR_WIDTH = 40
const ROW_HEIGHT = 28
const LABEL_WIDTH = 180
const HEADER_HEIGHT = 24
const SVG_PADDING_TOP = 4

export default function PipelineScheduleHeatmap({ pipelines }: Props) {
  const [dayOffset, setDayOffset] = useState(0)
  const [runHistory, setRunHistory] = useState<Record<string, RunEntry[]>>({})

  const selectedDate = useMemo(() => {
    const d = new Date()
    d.setDate(d.getDate() + dayOffset)
    d.setHours(0, 0, 0, 0)
    return d
  }, [dayOffset])

  const isToday = dayOffset === 0

  const scheduledPipelines = useMemo(
    () => pipelines.filter(p => p.cron !== null).sort((a, b) => a.name.localeCompare(b.name)),
    [pipelines],
  )

  useEffect(() => {
    let cancelled = false
    async function load() {
      const hist: Record<string, RunEntry[]> = {}
      await Promise.all(
        scheduledPipelines.map(async (p) => {
          try {
            const runs = await window.api.pipeline.getHistory(p.name)
            if (!cancelled) hist[p.name] = runs
          } catch { /* ignore */ }
        }),
      )
      if (!cancelled) setRunHistory(hist)
    }
    load()
    return () => { cancelled = true }
  }, [scheduledPipelines, dayOffset])

  const fireTimes = useMemo(() => {
    const map: Record<string, { hour: number; minute: number }[]> = {}
    for (const p of scheduledPipelines) {
      map[p.name] = cronFireTimesForDay(p.cron!, selectedDate)
    }
    return map
  }, [scheduledPipelines, selectedDate])

  const overlapByMinute = useMemo(() => {
    const counts: number[] = new Array(1440).fill(0)
    for (const p of scheduledPipelines) {
      for (const t of (fireTimes[p.name] ?? [])) {
        counts[t.hour * 60 + t.minute]++
      }
    }
    return counts
  }, [scheduledPipelines, fireTimes])

  const overlapSlots = useMemo(() => {
    const slots: { minute: number; count: number }[] = []
    for (let i = 0; i < 1440; i++) {
      if (overlapByMinute[i] >= 3) slots.push({ minute: i, count: overlapByMinute[i] })
    }
    return slots
  }, [overlapByMinute])

  const now = new Date()
  const nowMinute = isToday ? now.getHours() * 60 + now.getMinutes() : -1

  const svgWidth = LABEL_WIDTH + 24 * HOUR_WIDTH
  const svgHeight = HEADER_HEIGHT + SVG_PADDING_TOP + scheduledPipelines.length * ROW_HEIGHT + 4

  if (scheduledPipelines.length === 0) {
    return (
      <div className="schedule-heatmap-empty">
        No cron-scheduled pipelines found. Git-poll and file-poll pipelines are not shown here.
      </div>
    )
  }

  return (
    <div className="schedule-heatmap pipeline-schedule-heatmap">
      <div className="schedule-heatmap-nav">
        <button onClick={() => setDayOffset(o => o - 1)} title="Previous day"><ChevronLeft size={14} /></button>
        <span className="schedule-heatmap-date">{fmtDate(selectedDate)}{isToday ? ' (Today)' : ''}</span>
        <button onClick={() => setDayOffset(o => o + 1)} title="Next day"><ChevronRight size={14} /></button>
        {!isToday && (
          <button className="schedule-heatmap-today" onClick={() => setDayOffset(0)}>Today</button>
        )}
      </div>

      <div className="schedule-heatmap-scroll">
        <svg width={svgWidth} height={svgHeight} className="schedule-heatmap-svg">
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
                <title>{count} pipelines fire at {Math.floor(minute / 60).toString().padStart(2, '0')}:{(minute % 60).toString().padStart(2, '0')}</title>
              </rect>
            )
          })}

          {scheduledPipelines.map((pipeline, i) => {
            const y = HEADER_HEIGHT + SVG_PADDING_TOP + i * ROW_HEIGHT
            const times = fireTimes[pipeline.name] ?? []
            const runs = (runHistory[pipeline.name] ?? []).filter(r => isSameDay(new Date(r.ts), selectedDate))

            return (
              <g key={pipeline.name}>
                {i % 2 === 0 && (
                  <rect x={LABEL_WIDTH} y={y} width={24 * HOUR_WIDTH} height={ROW_HEIGHT} className="schedule-row-bg" />
                )}

                <text
                  x={4}
                  y={y + ROW_HEIGHT / 2 + 4}
                  className={`schedule-persona-label${!pipeline.enabled ? ' disabled' : ''}`}
                >
                  {pipeline.name.length > 22 ? pipeline.name.slice(0, 20) + '…' : pipeline.name}
                </text>

                <text
                  x={LABEL_WIDTH - 6}
                  y={y + ROW_HEIGHT / 2 + 3}
                  textAnchor="end"
                  className="schedule-cron-chip"
                >
                  {describeCron(pipeline.cron!).length > 14
                    ? describeCron(pipeline.cron!).slice(0, 12) + '…'
                    : describeCron(pipeline.cron!)}
                </text>

                {times.map((t, ti) => {
                  const x = LABEL_WIDTH + (t.hour + t.minute / 60) * HOUR_WIDTH
                  return (
                    <rect
                      key={`s${ti}`}
                      x={x}
                      y={y + 4}
                      width={2}
                      height={ROW_HEIGHT - 8}
                      className={`schedule-fire-bar${!pipeline.enabled ? ' disabled' : ''}`}
                    >
                      <title>{pipeline.name} — {t.hour.toString().padStart(2, '0')}:{t.minute.toString().padStart(2, '0')}</title>
                    </rect>
                  )
                })}

                {runs.map((run, ri) => {
                  const rd = new Date(run.ts)
                  const x = LABEL_WIDTH + (rd.getHours() + rd.getMinutes() / 60) * HOUR_WIDTH
                  const runMinute = rd.getHours() * 60 + rd.getMinutes()
                  const closestScheduled = times.reduce((best, t) => {
                    const dist = Math.abs(runMinute - (t.hour * 60 + t.minute))
                    return dist < best ? dist : best
                  }, Infinity)
                  const late = closestScheduled > 2
                  return (
                    <circle
                      key={`r${ri}`}
                      cx={x}
                      cy={y + ROW_HEIGHT / 2}
                      r={3.5}
                      className={`schedule-run-dot${!run.success ? ' fail' : late ? ' late' : ''}`}
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

          {nowMinute >= 0 && (
            <line
              x1={LABEL_WIDTH + (nowMinute / 60) * HOUR_WIDTH}
              y1={HEADER_HEIGHT}
              x2={LABEL_WIDTH + (nowMinute / 60) * HOUR_WIDTH}
              y2={svgHeight}
              className="schedule-now-line"
            />
          )}
        </svg>
      </div>

      <div className="schedule-heatmap-legend">
        <span className="schedule-legend-item"><span className="schedule-legend-bar" /> Scheduled</span>
        <span className="schedule-legend-item"><span className="schedule-legend-dot green" /> Ran on time</span>
        <span className="schedule-legend-item"><span className="schedule-legend-dot amber" /> Ran late (&gt;2min)</span>
        <span className="schedule-legend-item"><span className="schedule-legend-dot red" /> Failed</span>
        <span className="schedule-legend-item"><span className="schedule-legend-overlap" /> 3+ overlap</span>
      </div>
    </div>
  )
}
