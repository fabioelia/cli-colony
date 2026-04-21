import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

interface ActionShape {
  type: string
  target?: string
  stages?: ActionShape[]
}

interface PipelineInfo {
  name: string
  enabled: boolean
  running: boolean
  actionShape?: ActionShape
}

interface Props {
  pipelines: PipelineInfo[]
  onSelectPipeline?: (name: string) => void
}

const NODE_W = 180
const NODE_H = 52
const GAP_X = 180
const GAP_Y = 80
const PAD = 30
const ZOOM_KEY = 'pipeline-trigger-map-zoom'
const ZOOM_MIN = 0.5
const ZOOM_MAX = 3
const ZOOM_STEP = 0.1

interface MapNode {
  name: string
  label: string
  enabled: boolean
  running: boolean
  x: number
  y: number
}

interface MapEdge {
  from: string
  to: string
  cyclic: boolean
}

/** Collect all trigger_pipeline targets from an action tree (recursive) */
function collectTriggerTargets(shape: ActionShape | undefined): string[] {
  if (!shape) return []
  const targets: string[] = []
  if (shape.type === 'trigger_pipeline' && shape.target) targets.push(shape.target)
  for (const s of shape.stages || []) targets.push(...collectTriggerTargets(s))
  return targets
}

/** DFS cycle detection on directed pipeline→pipeline edges */
function findCyclicEdges(pipelines: PipelineInfo[], adjMap: Map<string, string[]>): Set<string> {
  const cyclicEdgeKeys = new Set<string>()
  const WHITE = 0, GRAY = 1, BLACK = 2
  const color = new Map<string, number>()
  const parent = new Map<string, string | null>()
  for (const p of pipelines) color.set(p.name, WHITE)

  function dfs(u: string) {
    color.set(u, GRAY)
    for (const v of adjMap.get(u) || []) {
      if (!color.has(v)) continue
      if (color.get(v) === GRAY) {
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

  for (const p of pipelines) {
    if (color.get(p.name) === WHITE) dfs(p.name)
  }
  return cyclicEdgeKeys
}

/** Topological sort → layers for layout */
function topoLayers(pipelines: PipelineInfo[], adjMap: Map<string, string[]>): string[][] {
  const names = new Set(pipelines.map(p => p.name))
  const inDegree = new Map<string, number>()
  for (const p of pipelines) inDegree.set(p.name, 0)

  for (const [, targets] of adjMap) {
    for (const t of targets) {
      if (names.has(t)) inDegree.set(t, (inDegree.get(t) || 0) + 1)
    }
  }

  const layers: string[][] = []
  const remaining = new Set(names)

  while (remaining.size > 0) {
    const layer: string[] = []
    for (const n of remaining) {
      if ((inDegree.get(n) || 0) === 0) layer.push(n)
    }
    if (layer.length === 0) {
      layers.push([...remaining])
      break
    }
    layer.sort()
    layers.push(layer)
    for (const n of layer) {
      remaining.delete(n)
      for (const t of adjMap.get(n) || []) {
        if (remaining.has(t)) inDegree.set(t, (inDegree.get(t) || 0) - 1)
      }
    }
  }

  return layers
}

function buildGraph(pipelines: PipelineInfo[]): {
  nodes: MapNode[]
  edges: MapEdge[]
  width: number
  height: number
} {
  // Build edge map — only include connected pipelines
  const adjMap = new Map<string, string[]>()
  const nameSet = new Set(pipelines.map(p => p.name))
  for (const p of pipelines) {
    const targets = collectTriggerTargets(p.actionShape).filter(t => nameSet.has(t))
    if (targets.length > 0) adjMap.set(p.name, targets)
  }

  // Find all connected nodes
  const connected = new Set<string>()
  for (const [src, tgts] of adjMap) {
    connected.add(src)
    for (const t of tgts) connected.add(t)
  }

  if (connected.size === 0) return { nodes: [], edges: [], width: 0, height: 0 }

  const connectedPipelines = pipelines.filter(p => connected.has(p.name))
  // Ensure adjMap has entries for nodes that are only targets
  for (const p of connectedPipelines) {
    if (!adjMap.has(p.name)) adjMap.set(p.name, [])
  }

  const cyclicEdges = findCyclicEdges(connectedPipelines, adjMap)
  const layers = topoLayers(connectedPipelines, adjMap)

  const nodes: MapNode[] = []
  const posMap = new Map<string, { x: number; y: number }>()
  const maxLayerWidth = Math.max(...layers.map(l => l.length))

  for (let row = 0; row < layers.length; row++) {
    const layer = layers[row]
    const layerWidth = layer.length * (NODE_W + GAP_X) - GAP_X
    const startX = PAD + (maxLayerWidth * (NODE_W + GAP_X) - GAP_X - layerWidth) / 2
    const y = PAD + row * (NODE_H + GAP_Y)

    for (let col = 0; col < layer.length; col++) {
      const name = layer[col]
      const p = connectedPipelines.find(pp => pp.name === name)!
      const x = startX + col * (NODE_W + GAP_X)
      posMap.set(name, { x, y })
      nodes.push({ name, label: p.name, enabled: p.enabled, running: p.running, x, y })
    }
  }

  const edges: MapEdge[] = []
  for (const [src, targets] of adjMap) {
    for (const tgt of targets) {
      if (posMap.has(tgt)) {
        edges.push({ from: src, to: tgt, cyclic: cyclicEdges.has(`${src}->${tgt}`) })
      }
    }
  }

  const totalWidth = maxLayerWidth * (NODE_W + GAP_X) - GAP_X + PAD * 2
  const totalHeight = layers.length * (NODE_H + GAP_Y) - GAP_Y + PAD * 2

  return { nodes, edges, width: Math.max(totalWidth, 200), height: Math.max(totalHeight, 100) }
}

function clampZoom(z: number): number {
  return Math.round(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z)) * 100) / 100
}

export default function PipelineTriggerMap({ pipelines, onSelectPipeline }: Props) {
  const { nodes, edges, width, height } = useMemo(() => buildGraph(pipelines), [pipelines])
  const containerRef = useRef<HTMLDivElement>(null)
  const [zoom, setZoom] = useState(() => {
    try { return clampZoom(parseFloat(localStorage.getItem(ZOOM_KEY) || '1') || 1) } catch { return 1 }
  })

  const persistZoom = useCallback((next: number) => {
    const clamped = clampZoom(next)
    try { localStorage.setItem(ZOOM_KEY, String(clamped)) } catch { /* Safari private */ }
    return clamped
  }, [])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const handler = (e: WheelEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return
      e.preventDefault()
      setZoom(z => persistZoom(z + (e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP)))
    }
    el.addEventListener('wheel', handler, { passive: false })
    return () => el.removeEventListener('wheel', handler)
  }, [persistZoom])

  if (nodes.length === 0) {
    return (
      <div className="trigger-map-hint" style={{ padding: '24px 16px' }}>
        No pipeline chains configured. Add a <code>trigger_pipeline</code> action to connect pipelines and visualize the topology here.
      </div>
    )
  }

  const hasCycles = edges.some(e => e.cyclic)
  const posMap = new Map<string, MapNode>()
  for (const n of nodes) posMap.set(n.name, n)

  const zoomIn = () => setZoom(z => persistZoom(z + ZOOM_STEP))
  const zoomOut = () => setZoom(z => persistZoom(z - ZOOM_STEP))

  return (
    <div className="pipeline-trigger-map trigger-map" ref={containerRef}>
      {hasCycles && (
        <div className="trigger-map-cycle-warning">
          Cycle detected in pipeline chain — highlighted in red
        </div>
      )}
      <div className="trigger-map-zoom-controls">
        <button className="panel-header-btn" onClick={zoomOut} title="Zoom out">−</button>
        <span className="trigger-map-zoom-label">{Math.round(zoom * 100)}%</span>
        <button className="panel-header-btn" onClick={zoomIn} title="Zoom in">+</button>
      </div>
      <div className="pipeline-flow-diagram">
        <svg width={width * zoom} height={height * zoom} viewBox={`0 0 ${width} ${height}`}>
          <defs>
            <marker id="pt-arrow" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
              <path d="M0,0 L8,3 L0,6" fill="var(--text-muted)" />
            </marker>
            <marker id="pt-arrow-cycle" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
              <path d="M0,0 L8,3 L0,6" fill="var(--danger)" />
            </marker>
          </defs>

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
            const marker = e.cyclic ? 'url(#pt-arrow-cycle)' : 'url(#pt-arrow)'
            const labelX = fromCx + dx / 2
            const labelY = fromBy + dy / 2 - 6

            if (Math.abs(dx) < 2) {
              return (
                <g key={i}>
                  <line
                    x1={fromCx} y1={fromBy} x2={toCx} y2={toTy - 4}
                    className={`trigger-edge${e.cyclic ? ' trigger-edge-cycle' : ''}`}
                    markerEnd={marker}
                  />
                  <text x={labelX + 8} y={labelY} className={`trigger-edge-label${e.cyclic ? ' trigger-edge-label-cycle' : ''}`}>triggers</text>
                </g>
              )
            }

            const midY = fromBy + dy * 0.5
            return (
              <g key={i}>
                <path
                  d={`M${fromCx},${fromBy} C${fromCx},${midY} ${toCx},${midY} ${toCx},${toTy - 4}`}
                  className={`trigger-edge${e.cyclic ? ' trigger-edge-cycle' : ''}`}
                  markerEnd={marker}
                />
                <text x={labelX} y={labelY} className={`trigger-edge-label${e.cyclic ? ' trigger-edge-label-cycle' : ''}`}>triggers</text>
              </g>
            )
          })}

          {nodes.map(n => (
            <g
              key={n.name}
              className={`trigger-map-node-group${!n.enabled ? ' trigger-map-node-disabled' : ''}`}
              onClick={() => onSelectPipeline?.(n.name)}
              style={{ cursor: onSelectPipeline ? 'pointer' : 'default' }}
            >
              <rect
                x={n.x} y={n.y}
                width={NODE_W} height={NODE_H}
                rx={8}
                className={`flow-node${n.running ? ' flow-node-active' : ''}`}
                style={{ stroke: n.enabled ? 'var(--accent)' : 'var(--border-subtle)' }}
              />
              <foreignObject x={n.x + 4} y={n.y + 2} width={NODE_W - 8} height={NODE_H - 4}>
                <div className="flow-node-content">
                  <span
                    className="trigger-map-dot"
                    style={{ background: n.running ? 'var(--success)' : n.enabled ? 'var(--accent)' : 'var(--text-muted)' }}
                  />
                  <span className="flow-node-label">{n.label}</span>
                </div>
              </foreignObject>
            </g>
          ))}
        </svg>
      </div>
    </div>
  )
}
