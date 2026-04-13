import { useEffect } from 'react'

/**
 * Adds 'modifier-held' class to document.body when Cmd/Ctrl is held
 * for 400ms without pressing any other key. This enables CSS-driven
 * shortcut hint badges on UI elements.
 *
 * Cancel conditions: any other key pressed, modifier released, window blur.
 */
export function useModifierHeld(): void {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    let active = false

    const show = () => {
      active = true
      document.body.classList.add('modifier-held')
    }

    const hide = () => {
      if (timer) { clearTimeout(timer); timer = null }
      if (active) {
        active = false
        document.body.classList.remove('modifier-held')
      }
    }

    const onKeyDown = (e: KeyboardEvent) => {
      // Start timer on bare Meta/Control press
      if ((e.key === 'Meta' || e.key === 'Control') && !e.shiftKey && !e.altKey) {
        if (!timer && !active) {
          timer = setTimeout(show, 400)
        }
        return
      }
      // Any other key while modifier held → cancel (user is doing Cmd+C etc.)
      hide()
    }

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Meta' || e.key === 'Control') hide()
    }

    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('keyup', onKeyUp, true)
    window.addEventListener('blur', hide)
    return () => {
      hide()
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('keyup', onKeyUp, true)
      window.removeEventListener('blur', hide)
    }
  }, [])
}
