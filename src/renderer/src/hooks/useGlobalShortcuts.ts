import { useEffect } from 'react'

type SidebarView = 'instances' | 'agents' | 'github' | 'sessions' | 'settings' | 'logs' | 'tasks' | 'pipelines' | 'environments' | 'personas'

interface ShortcutHandlers {
  onNewSession: () => void
  onNavigate: (view: SidebarView) => void
  currentView: SidebarView
}

/**
 * Global keyboard shortcuts for Colony.
 *
 * Cmd+N  — open New Session dialog
 * Cmd+Shift+P — navigate to Personas panel (or trigger first enabled persona if already there)
 *
 * Guards: ignores events inside terminal inputs, text inputs, and textareas.
 */
export function useGlobalShortcuts({ onNewSession, onNavigate, currentView }: ShortcutHandlers): void {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey
      if (!meta) return

      // Don't steal from terminal helper textareas or regular inputs
      const target = e.target as HTMLElement | null
      if (target) {
        const tag = target.tagName.toLowerCase()
        if (tag === 'input' || tag === 'textarea') return
        if (target.closest('.xterm-helper-textarea, .xterm-screen, .terminal-container')) return
      }

      if (e.key === 'n' && !e.shiftKey && !e.altKey) {
        e.preventDefault()
        onNewSession()
        return
      }

      if (e.key === 'P' && e.shiftKey && !e.altKey) {
        e.preventDefault()
        if (currentView === 'personas') {
          // Already on personas — trigger first enabled non-running persona
          window.api.persona.list().then((personas) => {
            const target = personas.find(p => p.enabled && !p.activeSessionId)
            if (target) window.api.persona.run(target.id)
          }).catch(() => { /* silently ignore */ })
        } else {
          onNavigate('personas')
        }
        return
      }

      // Cmd+Shift+F is handled by the Electron menu accelerator (Global Search)
    }

    // Use capture phase so we get events before child components
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [onNewSession, onNavigate, currentView])
}
