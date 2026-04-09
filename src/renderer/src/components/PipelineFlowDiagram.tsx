import {
  Play, GitCompare, Users, GitBranch, Clock, Zap, FileText, Eye,
} from 'lucide-react'
import { describeCron } from '../../../shared/cron'

interface ActionShape {
  type: string
  name?: string
  stages?: ActionShape[]
}

interface StageTrace {
  index: number
  actionType: string
  success: boolean
  subStages?: StageTrace[]
}

interface HistoryEntry {
  success: boolean
  stages?: StageTrace[]
}

interface Props {
  actionShape?: ActionShape
  triggerType: string
  cron: string | null
  running: boolean
  lastHistory?: HistoryEntry
}

// Layout constants
const NODE_W = 140
const NODE_H = 44
const GAP_Y = 60
const GAP_X = 160
const DIAMOND = 16

interface FlowNode {
  id: string
  label: string
  type: string
  x: number
  y: number
  w: number
  h: number
  status?: 'success' | 'failure' | 'none'
  active?: boolean
  isDiamond?: boolean
}

interface FlowEdge {
  from: string
  to: string
  fromX: number
  fromY: number
  toX: number
  toY: number
}

const ACTION_ICONS: Record<string, typeof Play> = {
  'launch-session': Play,
  'route-to-session': Play,
  'diff_review': GitCompare,
  'maker-checker': Users,
  'parallel': GitBranch,
  'wait_for_session': Clock,
  'plan': FileText,
}

function actionLabel(action: ActionShape): string {
  return action.name || action.type.replace(/_/g, ' ').replace(/-/g, ' ')
}

function triggerLabel(type: string, cron: string | null): string {
  if (cron) return describeCron(cron)
  if (type === 'git-poll') return 'Git Poll'
  if (type === 'file-poll') return 'File Poll'
  if (type === 'webhook') return 'Webhook'
  return type
}

function buildGraph(
  action: ActionShape,
  triggerType: string,
  cron: string | null,
  running: boolean,
  lastHistory?: HistoryEntry,
): { nodes: FlowNode[]; edges: FlowEdge[]; width: number; height: number } {
  const nodes: FlowNode[] = []
  const edges: FlowEdge[] = []

  // Trigger node
  const triggerNode: FlowNode = {
    id: 'trigger',
    label: triggerLabel(triggerType, cron),
    type: 'trigger',
    x: 0,
    y: 0,
    w: NODE_W,
    h: NODE_H,
    status: 'none',
  }
  nodes.push(triggerNode)

  let nextY = NODE_H + GAP_Y
  let maxWidth = NODE_W
  let stageIdx = 0

  function getStageStatus(idx: number): 'success' | 'failure' | 'none' {
    if (!lastHistory?.stages) return 'none'
    const stage = lastHistory.stages[idx]
    if (!stage) return 'none'
    return stage.success ? 'success' : 'failure'
  }

  function addAction(a: ActionShape, parentId: string, x: number, y: number): { bottomId: string; bottomY: number; maxX: number } {
    if (a.type === 'parallel' && a.stages && a.stages.length > 0) {
      const forkId = `fork-${stageIdx}`
      const joinId = `join-${stageIdx}`
      const parentStageIdx = stageIdx
      stageIdx++

      // Fork diamond
      const forkNode: FlowNode = {
        id: forkId,
        label: '',
        type: 'fork',
        x,
        y,
        w: DIAMOND * 2,
        h: DIAMOND * 2,
        isDiamond: true,
        status: getStageStatus(parentStageIdx),
      }
      nodes.push(forkNode)
      edges.push({
        from: parentId,
        to: forkId,
        fromX: getCenter(parentId, nodes).x,
        fromY: getBottom(parentId, nodes),
        toX: x + DIAMOND,
        toY: y,
      })

      const branchCount = a.stages.length
      const totalWidth = (branchCount - 1) * GAP_X
      const startX = x + DIAMOND - totalWidth / 2

      let maxBranchY = y + DIAMOND * 2 + GAP_Y
      let maxBranchX = x

      const branchBottoms: { id: string; y: number; cx: number }[] = []

      a.stages.forEach((sub, i) => {
        const bx = startX + i * GAP_X - NODE_W / 2 + (branchCount > 1 ? 0 : 0)
        const centerBx = startX + i * GAP_X
        const by = y + DIAMOND * 2 + GAP_Y
        const subId = `stage-${stageIdx}`
        const subStatus = lastHistory?.stages?.[parentStageIdx]?.subStages?.[i]
          ? (lastHistory.stages[parentStageIdx].subStages![i].success ? 'success' : 'failure')
          : 'none'
        stageIdx++

        const subNode: FlowNode = {
          id: subId,
          label: actionLabel(sub),
          type: sub.type,
          x: centerBx - NODE_W / 2,
          y: by,
          w: NODE_W,
          h: NODE_H,
          status: subStatus,
          active: running && subStatus === 'none',
        }
        nodes.push(subNode)

        // Edge from fork to sub
        edges.push({
          from: forkId,
          to: subId,
          fromX: x + DIAMOND,
          fromY: y + DIAMOND * 2,
          toX: centerBx,
          toY: by,
        })

        branchBottoms.push({ id: subId, y: by + NODE_H, cx: centerBx })
        if (by + NODE_H > maxBranchY) maxBranchY = by + NODE_H
        if (centerBx + NODE_W / 2 > maxBranchX) maxBranchX = centerBx + NODE_W / 2
        if (centerBx - NODE_W / 2 < 0) {
          // We'll shift everything later
        }
      })

      // Join diamond
      const joinY = maxBranchY + GAP_Y
      const joinNode: FlowNode = {
        id: joinId,
        label: '',
        type: 'join',
        x,
        y: joinY,
        w: DIAMOND * 2,
        h: DIAMOND * 2,
        isDiamond: true,
      }
      nodes.push(joinNode)

      for (const b of branchBottoms) {
        edges.push({
          from: b.id,
          to: joinId,
          fromX: b.cx,
          fromY: b.y,
          toX: x + DIAMOND,
          toY: joinY,
        })
      }

      return {
        bottomId: joinId,
        bottomY: joinY + DIAMOND * 2,
        maxX: Math.max(maxBranchX, x + DIAMOND * 2),
      }
    }

    // Regular (non-parallel) action node
    const nodeId = `stage-${stageIdx}`
    const status = getStageStatus(stageIdx)
    stageIdx++

    const node: FlowNode = {
      id: nodeId,
      label: actionLabel(a),
      type: a.type,
      x: x - NODE_W / 2,
      y,
      w: NODE_W,
      h: NODE_H,
      status,
      active: running && status === 'none',
    }
    nodes.push(node)

    edges.push({
      from: parentId,
      to: nodeId,
      fromX: getCenter(parentId, nodes).x,
      fromY: getBottom(parentId, nodes),
      toX: x,
      toY: y,
    })

    return { bottomId: nodeId, bottomY: y + NODE_H, maxX: x + NODE_W / 2 }
  }

  // Center x for the main column
  const centerX = NODE_W / 2
  triggerNode.x = centerX - NODE_W / 2

  const result = addAction(action, 'trigger', centerX, nextY)
  maxWidth = Math.max(maxWidth, result.maxX * 2)

  // Normalize: shift all nodes so min x = 0, then center
  let minX = Infinity
  let maxX = -Infinity
  for (const n of nodes) {
    if (n.isDiamond) {
      if (n.x < minX) minX = n.x
      if (n.x + n.w > maxX) maxX = n.x + n.w
    } else {
      if (n.x < minX) minX = n.x
      if (n.x + n.w > maxX) maxX = n.x + n.w
    }
  }

  const shiftX = minX < 20 ? 20 - minX : 0
  for (const n of nodes) {
    n.x += shiftX
  }
  for (const e of edges) {
    e.fromX += shiftX
    e.toX += shiftX
  }

  const totalWidth = (maxX - minX) + shiftX + 40
  const totalHeight = result.bottomY + 30

  return { nodes, edges, width: Math.max(totalWidth, 200), height: totalHeight }
}

function getCenter(id: string, nodes: FlowNode[]): { x: number; y: number } {
  const n = nodes.find(n => n.id === id)!
  if (n.isDiamond) return { x: n.x + DIAMOND, y: n.y + DIAMOND }
  return { x: n.x + n.w / 2, y: n.y + n.h / 2 }
}

function getBottom(id: string, nodes: FlowNode[]): number {
  const n = nodes.find(n => n.id === id)!
  return n.y + n.h
}

function NodeIcon({ type }: { type: string }) {
  const Icon = ACTION_ICONS[type] || Zap
  return <Icon size={14} />
}

function TriggerIcon({ type }: { type: string }) {
  if (type === 'webhook') return <Eye size={14} />
  if (type === 'cron') return <Clock size={14} />
  return <Zap size={14} />
}

function statusColor(status?: 'success' | 'failure' | 'none'): string {
  if (status === 'success') return 'var(--success)'
  if (status === 'failure') return 'var(--danger)'
  return 'var(--border-active)'
}

export default function PipelineFlowDiagram({ actionShape, triggerType, cron, running, lastHistory }: Props) {
  if (!actionShape) {
    return <div className="flow-empty">No action defined for this pipeline.</div>
  }

  const { nodes, edges, width, height } = buildGraph(actionShape, triggerType, cron, running, lastHistory)

  return (
    <div className="pipeline-flow-diagram">
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
        <defs>
          <marker id="flow-arrow" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
            <path d="M0,0 L8,3 L0,6" fill="var(--text-muted)" />
          </marker>
        </defs>

        {/* Edges */}
        {edges.map((e, i) => {
          const dx = e.toX - e.fromX
          const dy = e.toY - e.fromY
          if (Math.abs(dx) < 2) {
            // Straight vertical line
            return (
              <line
                key={i}
                x1={e.fromX}
                y1={e.fromY}
                x2={e.toX}
                y2={e.toY - 4}
                className="flow-edge"
                markerEnd="url(#flow-arrow)"
              />
            )
          }
          // Curved bezier for parallel branches
          const midY = e.fromY + dy * 0.5
          return (
            <path
              key={i}
              d={`M${e.fromX},${e.fromY} C${e.fromX},${midY} ${e.toX},${midY} ${e.toX},${e.toY - 4}`}
              className="flow-edge"
              markerEnd="url(#flow-arrow)"
            />
          )
        })}

        {/* Nodes */}
        {nodes.map(n => {
          if (n.isDiamond) {
            const cx = n.x + DIAMOND
            const cy = n.y + DIAMOND
            return (
              <g key={n.id}>
                <polygon
                  points={`${cx},${cy - DIAMOND} ${cx + DIAMOND},${cy} ${cx},${cy + DIAMOND} ${cx - DIAMOND},${cy}`}
                  className="flow-diamond"
                  style={{ stroke: statusColor(n.status) }}
                />
              </g>
            )
          }

          const borderColor = statusColor(n.status)
          const isTrigger = n.type === 'trigger'

          return (
            <g key={n.id}>
              <rect
                x={n.x}
                y={n.y}
                width={n.w}
                height={n.h}
                rx={8}
                className={`flow-node${n.active ? ' flow-node-active' : ''}${isTrigger ? ' flow-node-trigger' : ''}`}
                style={{ stroke: borderColor }}
              />
              <foreignObject x={n.x + 4} y={n.y + 2} width={n.w - 8} height={n.h - 4}>
                <div className="flow-node-content" title={n.label}>
                  <span className="flow-node-icon">
                    {isTrigger ? <TriggerIcon type={triggerType} /> : <NodeIcon type={n.type} />}
                  </span>
                  <span className="flow-node-label">{n.label}</span>
                </div>
              </foreignObject>
            </g>
          )
        })}
      </svg>
    </div>
  )
}
