import React from 'react'

interface SparkEntry {
  durationMs: number
  success: boolean
  ts: string
}

export function PipelineSparkline({ entries }: { entries: SparkEntry[] }) {
  const last10 = entries.slice(-10)
  if (last10.length < 3) return null

  const maxMs = Math.max(...last10.map(e => e.durationMs), 1)
  const W = 80
  const H = 20
  const BAR_W = 6
  const GAP = 2
  const totalW = last10.length * (BAR_W + GAP) - GAP

  return (
    <svg
      className="pipeline-sparkline"
      width={W}
      height={H}
      viewBox={`0 0 ${totalW} ${H}`}
      style={{ overflow: 'visible' }}
    >
      {last10.map((e, i) => {
        const barH = Math.max(2, Math.round((e.durationMs / maxMs) * H))
        const x = i * (BAR_W + GAP)
        const y = H - barH
        const color = e.success ? 'var(--green, #3fb950)' : 'var(--danger, #f85149)'
        const dur = e.durationMs < 1000
          ? `${e.durationMs}ms`
          : e.durationMs < 60000
          ? `${(e.durationMs / 1000).toFixed(1)}s`
          : `${Math.floor(e.durationMs / 60000)}m ${Math.round((e.durationMs % 60000) / 1000)}s`
        return (
          <rect key={i} x={x} y={y} width={BAR_W} height={barH} fill={color} rx={1}>
            <title>{`${new Date(e.ts).toLocaleString()} — ${e.success ? 'success' : 'failed'} — ${dur}`}</title>
          </rect>
        )
      })}
    </svg>
  )
}
