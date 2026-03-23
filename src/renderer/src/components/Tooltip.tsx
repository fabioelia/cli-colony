import { useState, useRef, useCallback, useEffect, ReactNode } from 'react'

interface Props {
  text: string
  detail?: string
  shortcut?: string
  children: ReactNode
  position?: 'top' | 'bottom' | 'left' | 'right'
  delay?: number
}

export default function Tooltip({ text, detail, shortcut, children, position = 'top', delay = 400 }: Props) {
  const [visible, setVisible] = useState(false)
  const [rect, setRect] = useState<DOMRect | null>(null)
  const [style, setStyle] = useState<React.CSSProperties>({})
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const tooltipRef = useRef<HTMLDivElement>(null)

  const show = useCallback((e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setRect(r)
    timerRef.current = setTimeout(() => setVisible(true), delay)
  }, [delay])

  const hide = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    setVisible(false)
  }, [])

  // Position after render so we can measure the tooltip and clamp to viewport
  useEffect(() => {
    if (!visible || !rect || !tooltipRef.current) return
    const tt = tooltipRef.current.getBoundingClientRect()
    const pad = 8
    let x: number
    let y: number

    if (position === 'top') {
      x = rect.left + rect.width / 2 - tt.width / 2
      y = rect.top - tt.height - pad
    } else if (position === 'bottom') {
      x = rect.left + rect.width / 2 - tt.width / 2
      y = rect.bottom + pad
    } else if (position === 'left') {
      x = rect.left - tt.width - pad
      y = rect.top + rect.height / 2 - tt.height / 2
    } else {
      x = rect.right + pad
      y = rect.top + rect.height / 2 - tt.height / 2
    }

    // Clamp to viewport
    x = Math.max(pad, Math.min(x, window.innerWidth - tt.width - pad))
    y = Math.max(pad, Math.min(y, window.innerHeight - tt.height - pad))

    // If top would go off-screen, flip to bottom
    if (position === 'top' && y < pad) {
      y = rect.bottom + pad
    }

    setStyle({ left: x, top: y, transform: 'none' })
  }, [visible, rect, position])

  return (
    <div
      className="tooltip-wrapper"
      onMouseEnter={show}
      onMouseLeave={hide}
    >
      {children}
      {visible && (
        <div
          ref={tooltipRef}
          className="tooltip-popup"
          style={style}
        >
          <div className="tooltip-text">{text}</div>
          {detail && <div className="tooltip-detail">{detail}</div>}
          {shortcut && <div className="tooltip-shortcut">{shortcut}</div>}
        </div>
      )}
    </div>
  )
}
