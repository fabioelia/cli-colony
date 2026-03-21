export const COLORS = [
  '#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6',
  '#ec4899', '#06b6d4', '#f97316', '#14b8a6', '#6366f1',
]

export const COLOR_MAP: Record<string, string> = {
  red: '#ef4444',
  green: '#10b981',
  blue: '#3b82f6',
  purple: '#8b5cf6',
  orange: '#f97316',
  yellow: '#f59e0b',
  cyan: '#06b6d4',
  pink: '#ec4899',
  teal: '#14b8a6',
  indigo: '#6366f1',
}

export function formatTime(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60000) return 'now'
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h`
  if (diff < 604800000) return `${Math.floor(diff / 86400000)}d`
  return new Date(ts).toLocaleDateString('en', { month: 'short', day: 'numeric' })
}
