import type { LucideIcon } from 'lucide-react'

interface EmptyStateHookProps {
  icon: LucideIcon
  title: string
  hook: string
  keyCap?: string
  cta?: { label: string; onClick: () => void }
}

export default function EmptyStateHook({ icon: Icon, title, hook, keyCap, cta }: EmptyStateHookProps) {
  return (
    <div className="empty-state-hook">
      <Icon size={32} className="empty-state-hook-icon" />
      {keyCap && (
        <span className="empty-state-hook-keycap">{keyCap}</span>
      )}
      <h3 className="empty-state-hook-title">{title}</h3>
      <p className="empty-state-hook-copy">{hook}</p>
      {cta && (
        <button className="panel-header-btn primary empty-state-hook-cta" onClick={cta.onClick}>
          {cta.label}
        </button>
      )}
    </div>
  )
}
