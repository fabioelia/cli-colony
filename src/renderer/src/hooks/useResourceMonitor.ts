import { useState, useEffect } from 'react'

interface ResourceUsage {
  perInstance: Record<string, { cpu: number; memory: number }>
  total: { cpu: number; memory: number }
}

/** Polls resource usage every 15s, pausing when the window is hidden. */
export function useResourceMonitor(): ResourceUsage | null {
  const [resourceUsage, setResourceUsage] = useState<ResourceUsage | null>(null)

  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | null = null
    const poll = () => {
      if (document.hidden) return
      window.api.resources.getUsage().then(setResourceUsage).catch(() => {})
    }
    const start = () => {
      poll()
      if (interval) clearInterval(interval)
      interval = setInterval(poll, 15000)
    }
    const stop = () => { if (interval) { clearInterval(interval); interval = null } }
    const onVisChange = () => { document.hidden ? stop() : start() }
    document.addEventListener('visibilitychange', onVisChange)
    if (!document.hidden) start()
    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisChange)
    }
  }, [])

  return resourceUsage
}
