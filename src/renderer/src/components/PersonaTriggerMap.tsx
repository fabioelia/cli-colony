import { useMemo } from 'react'
import type { PersonaInfo } from '../../../shared/types'

interface Props {
  personas: PersonaInfo[]
  onSelectPersona?: (id: string) => void
}

// Layout constants — similar to PipelineFlowDiagram
const NODE_W = 150
const NODE_H = 44
const GAP_X = 180
const GAP_Y = 80
const PAD = 30
const DOT_R = 5

interface TriggerNode {
  id: string
  label: string
  color: string
  enabled: boolean
  running: boolean
  x: number
  y: number
}

interface TriggerEdge {
  from: string
  to: string
  type: 'always' | 'may-trigger'
  /** True if this edge participates in a cycle */
  cyclic: boolean
}

/** Detect cycles in the onCompleteRun (always-fire) directed graph using DFS */
function findCyclicEdges(personas: PersonaInfo[]): Set<string> {
  const cyclicEdgeKeys = new Set<string>()
  const adjMap = new Map<string, string[]>()
  for (const p of personas) {
    adjMap.set(p.id, p.onCompleteRun || [])
  }

  const WHITE = 0, GRAY = 1, BLACK = 2
  const color = new Map<string, number>()
  const parent = new Map<string, string | null>()
  for (const p of personas) color.set(p.id, WHITE)

  function dfs(u: string) {
    color.set(u, GRAY)
    for (const v of adjMap.get(u) || []) {
      if (!color.has(v)) continue // target not in persona list
      if (color.get(v) === GRAY) {
        // Back edge → cycle. Walk from u back to v marking edges
        cyclicEdgeKeys.add(`${u}->${v}`)
        let cur = u
        while (cur !== v) {
          const p = parent.get(cur)
          if (!p) break
          cyclicEdgeKeys.add(`${p}->${cur}`)
          cur = p
        }
      } else if (color.get(v) === WHITE) {
        parent.set(v, u)
        dfs(v)
      }
    }
    color.set(u, BLACK)
  }

  for (const p of personas) {
    if (color.get(p.id) === WHITE) dfs(p.id)
  }
  return cyclicEdgeKeys
}

/** Topological sort on onCompleteRun edges. Returns layers (arrays of persona IDs). */
function topoLayers(personas: PersonaInfo[]): string[][] {
  const ids = new Set(personas.map(p => p.id))
  const inDegree = new Map<string, number>()
  for (const p of personas) inDegree.set(p.id, 0)

  for (const p of personas) {
    for (const target of p.onCompleteRun || []) {
      if (ids.has(target)) {
        inDegree.set(target, (inDegree.get(target) || 0) + 1)
      }
    }
  }

  const layers: string[][] = []
  const remaining = new Set(ids)

  while (remaining.size > 0) {
    // Collect nodes with in-degree 0 among remaining
    const layer: string[] = []
    for (const id of remaining) {
      if ((inDegree.get(id) || 0) === 0) layer.push(id)
    }
    if (layer.length === 0) {
      // Cycle — add remaining as a single layer
      layers.push([...remaining])
      break
    }
    // Sort layer alphabetically for stability
    layer.sort((a, b) => {
      const pa = personas.find(p => p.id === a)
      const pb = personas.find(p => p.id === b)
      return (pa?.name || a).localeCompare(pb?.name || b)
    })
    layers.push(layer)
    for (const id of layer) {
      remaining.delete(id)
      const p = personas.find(pp => pp.id === id)
      for (const target of p?.onCompleteRun || []) {
        if (remaining.has(target)) {
          inDegree.set(target, (inDegree.get(target) || 0) - 1)
        }
      }
    }
  }

  return layers
}

function buildGraph(personas: PersonaInfo[]): {
  nodes: TriggerNode[]
  edges: TriggerEdge[]
  width: number
  height: number
} {
  if (personas.length === 0) return { nodes: [], edges: [], width: 0, height: 0 }

  const cyclicEdges = findCyclicEdges(personas)
  const layers = topoLayers(personas)

  // Position nodes by layer
  const nodes: TriggerNode[] = []
  const posMap = new Map<string, { x: number; y: number }>()

  // Find the widest layer to center others
  const maxLayerWidth = Math.max(...layers.map(l => l.length))

  for (let row = 0; row < layers.length; row++) {
    const layer = layers[row]
    const layerWidth = layer.length * (NODE_W + GAP_X) - GAP_X
    const startX = PAD + (maxLayerWidth * (NODE_W + GAP_X) - GAP_X - layerWidth) / 2
    const y = PAD + row * (NODE_H + GAP_Y)

    for (let col = 0; col < layer.length; col++) {
      const id = layer[col]
      const p = personas.find(pp => pp.id === id)!
      const x = startX + col * (NODE_W + GAP_X)
      posMap.set(id, { x, y })
      nodes.push({
        id,
        label: p.name,
        color: p.color || 'var(--accent)',
        enabled: p.enabled,
        running: !!p.activeSessionId,
        x,
        y,
      })
    }
  }

  // Build edges
  const edges: TriggerEdge[] = []
  for (const p of personas) {
    for (const target of p.onCompleteRun || []) {
      if (posMap.has(target)) {
        edges.push({
          from: p.id,
          to: target,
          type: 'always',
          cyclic: cyclicEdges.has(`${p.id}->${target}`),
        })
      }
    }
    for (const target of p.canInvoke || []) {
      if (posMap.has(target)) {
        // Don't duplicate if already an onCompleteRun edge
        const alreadyAlways = (p.onCompleteRun || []).includes(target)
        if (!alreadyAlways) {
          edges.push({
            from: p.id,
            to: target,
            type: 'may-trigger',
            cyclic: false,
          })
        }
      }
    }
  }

  const totalWidth = maxLayerWidth * (NODE_W + GAP_X) - GAP_X + PAD * 2
  const totalHeight = layers.length * (NODE_H + GAP_Y) - GAP_Y + PAD * 2

  return {
    nodes,
    edges,
    width: Math.max(totalWidth, 200),
    height: Math.max(totalHeight, 100),
  }
}

export default function PersonaTriggerMap({ personas, onSelectPersona }: Props) {
  const { nodes, edges, width, height } = useMemo(() => buildGraph(personas), [personas])

  if (personas.length === 0) {
    return <div className="flow-empty">No personas defined.</div>
  }

  // Check if any trigger relationships exist
  const hasEdges = edges.length > 0
  const hasCycles = edges.some(e => e.cyclic)

  // Build a position lookup for edge drawing
  const posMap = new Map<string, TriggerNode>()
  for (const n of nodes) posMap.set(n.id, n)

  return (
    <div className="trigger-map">
      {hasCycles && (
        <div className="trigger-map-cycle-warning">
          Cycle detected in always-fire chain — highlighted in red
        </div>
      )}
      <div className="pipeline-flow-diagram">
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
          <defs>
            <marker id="trigger-arrow" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
              <path d="M0,0 L8,3 L0,6" fill="var(--text-muted)" />
            </marker>
            <marker id="trigger-arrow-cycle" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
              <path d="M0,0 L8,3 L0,6" fill="var(--danger)" />
            </marker>
            <marker id="trigger-arrow-dashed" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
              <path d="M0,0 L8,3 L0,6" fill="var(--text-muted)" opacity="0.4" />
            </marker>
          </defs>

          {/* Edges */}
          {edges.map((e, i) => {
            const from = posMap.get(e.from)
            const to = posMap.get(e.to)
            if (!from || !to) return null

            const fromCx = from.x + NODE_W / 2
            const fromBy = from.y + NODE_H
            const toCx = to.x + NODE_W / 2
            const toTy = to.y

            const dx = toCx - fromCx
            const dy = toTy - fromBy

            const isCyclic = e.cyclic
            const isDashed = e.type === 'may-trigger'
            const marker = isCyclic ? 'url(#trigger-arrow-cycle)' : isDashed ? 'url(#trigger-arrow-dashed)' : 'url(#trigger-arrow)'

            // Label
            const label = e.type === 'always' ? 'always' : 'may trigger'
            const labelX = fromCx + dx / 2
            const labelY = fromBy + dy / 2 - 6

            if (Math.abs(dx) < 2) {
              // Straight vertical
              return (
                <g key={i}>
                  <line
                    x1={fromCx} y1={fromBy}
                    x2={toCx} y2={toTy - 4}
                    className={`trigger-edge${isCyclic ? ' trigger-edge-cycle' : ''}${isDashed ? ' trigger-edge-dashed' : ''}`}
                    markerEnd={marker}
                  />
                  {hasEdges && <text x={labelX + 8} y={labelY} className={`trigger-edge-label${isCyclic ? ' trigger-edge-label-cycle' : ''}`}>{label}</text>}
                </g>
              )
            }

            // Curved bezier
            const midY = fromBy + dy * 0.5
            return (
              <g key={i}>
                <path
                  d={`M${fromCx},${fromBy} C${fromCx},${midY} ${toCx},${midY} ${toCx},${toTy - 4}`}
                  className={`trigger-edge${isCyclic ? ' trigger-edge-cycle' : ''}${isDashed ? ' trigger-edge-dashed' : ''}`}
                  markerEnd={marker}
                />
                <text x={labelX} y={labelY} className={`trigger-edge-label${isCyclic ? ' trigger-edge-label-cycle' : ''}`}>{label}</text>
              </g>
            )
          })}

          {/* Nodes */}
          {nodes.map(n => (
            <g
              key={n.id}
              className={`trigger-map-node-group${!n.enabled ? ' trigger-map-node-disabled' : ''}`}
              onClick={() => onSelectPersona?.(n.id)}
              style={{ cursor: onSelectPersona ? 'pointer' : 'default' }}
            >
              <rect
                x={n.x} y={n.y}
                width={NODE_W} height={NODE_H}
                rx={8}
                className={`flow-node${n.running ? ' flow-node-active' : ''}`}
                style={{ stroke: n.enabled ? n.color : 'var(--border-muted)' }}
              />
              <foreignObject x={n.x + 4} y={n.y + 2} width={NODE_W - 8} height={NODE_H - 4}>
                <div className="flow-node-content">
                  <span
                    className="trigger-map-dot"
                    style={{ background: n.running ? 'var(--success)' : n.enabled ? n.color : 'var(--text-muted)' }}
                  />
                  <span className="flow-node-label">{n.label}</span>
                </div>
              </foreignObject>
            </g>
          ))}
        </svg>
      </div>
      {!hasEdges && (
        <div className="trigger-map-hint">
          No trigger relationships defined. Add <code>on_complete_run</code> or <code>can_invoke</code> to persona files to see chains.
        </div>
      )}
    </div>
  )
}
