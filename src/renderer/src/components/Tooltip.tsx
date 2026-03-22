import { useState, useRef, useCallback, ReactNode } from 'react'

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
  const [coords, setCoords] = useState({ x: 0, y: 0 })
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  const show = useCallback((e: React.MouseEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    let x = rect.left + rect.width / 2
    let y = rect.top

    if (position === 'bottom') y = rect.bottom
    if (position === 'left') { x = rect.left; y = rect.top + rect.height / 2 }
    if (position === 'right') { x = rect.right; y = rect.top + rect.height / 2 }

    setCoords({ x, y })
    timerRef.current = setTimeout(() => setVisible(true), delay)
  }, [position, delay])

  const hide = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    setVisible(false)
  }, [])

  return (
    <div
      ref={ref}
      className="tooltip-wrapper"
      onMouseEnter={show}
      onMouseLeave={hide}
    >
      {children}
      {visible && (
        <div
          className={`tooltip-popup tooltip-${position}`}
          style={{
            left: position === 'left' || position === 'right' ? undefined : coords.x,
            top: position === 'top' ? coords.y : position === 'bottom' ? coords.y : coords.y,
            ...(position === 'left' ? { right: window.innerWidth - coords.x + 8 } : {}),
            ...(position === 'right' ? { left: coords.x + 8 } : {}),
          }}
        >
          <div className="tooltip-text">{text}</div>
          {detail && <div className="tooltip-detail">{detail}</div>}
          {shortcut && <div className="tooltip-shortcut">{shortcut}</div>}
        </div>
      )}
    </div>
  )
}
