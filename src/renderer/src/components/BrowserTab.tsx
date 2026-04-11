import { useEffect, useRef, useState } from 'react'
import { ChevronUp, RotateCw, ExternalLink, Bug, AlertTriangle } from 'lucide-react'
import type { EnvStatus } from '../../../shared/types'

interface BrowserTabProps {
  envStatus: EnvStatus
  instanceId: string
}

export default function BrowserTab({ envStatus, instanceId }: BrowserTabProps) {
  const [browserService, setBrowserService] = useState<string | null>(null)
  const [browserUrl, setBrowserUrl] = useState<string | null>(null)
  const [browserUrlInput, setBrowserUrlInput] = useState<string>('')
  const [browserError, setBrowserError] = useState<string | null>(null)
  const webviewRef = useRef<Electron.WebviewTag>(null)
  const browserUrlIntentRef = useRef<string | null>(null)
  const [webviewContextMenu, setWebviewContextMenu] = useState<{
    x: number; y: number; editFlags: Record<string, boolean>
  } | null>(null)

  // Auto-select first URL when browser tab opens or urls change
  useEffect(() => {
    if (!envStatus?.urls) return
    const entries = Object.entries(envStatus.urls)
    if (entries.length === 0) return
    if (!browserService || !envStatus.urls[browserService]) {
      const stored = localStorage.getItem(`colony:browserUrl:${instanceId}`)
      if (stored) {
        try {
          const { service, url, ts } = JSON.parse(stored)
          if (Date.now() - ts < 20 * 60 * 1000 && envStatus.urls[service]) {
            browserUrlIntentRef.current = url
            setBrowserService(service)
            setBrowserUrl(url)
            setBrowserUrlInput(url)
            return
          }
        } catch { /* ignore corrupt data */ }
        localStorage.removeItem(`colony:browserUrl:${instanceId}`)
      }
      browserUrlIntentRef.current = entries[0][1]
      setBrowserService(entries[0][0])
      setBrowserUrl(entries[0][1])
    }
  }, [envStatus?.urls, browserService, instanceId])

  // Imperatively set webview src and handle navigation events
  useEffect(() => {
    const wv = webviewRef.current
    if (!wv || !browserUrl) return

    if (browserUrlIntentRef.current) {
      wv.src = browserUrlIntentRef.current
      browserUrlIntentRef.current = null
    }
    if (wv.src && wv.src !== 'about:blank') {
      try {
        const currentUrl = wv.getURL?.() || wv.src
        if (currentUrl && currentUrl !== 'about:blank') {
          setBrowserUrlInput(currentUrl)
        }
      } catch { /* webview not ready yet */ }
    }
    setBrowserError(null)

    const handleNavigation = (e: { url: string }) => {
      setBrowserUrl(e.url)
      setBrowserUrlInput(e.url)
      if (e.url && e.url !== 'about:blank' && browserService) {
        localStorage.setItem(`colony:browserUrl:${instanceId}`, JSON.stringify({
          service: browserService, url: e.url, ts: Date.now()
        }))
      }
    }
    const handleFailLoad = (e: Electron.DidFailLoadEvent) => {
      if (e.errorCode === -3) return
      setBrowserError(`Failed to load: ${e.errorDescription || 'Unknown error'}`)
    }
    const handleContextMenu = (e: any) => {
      e.preventDefault()
      const params = e.params || {}
      const wvRect = wv.getBoundingClientRect()
      setWebviewContextMenu({
        x: Math.min((params.x ?? 0) + wvRect.left, window.innerWidth - 200),
        y: Math.min((params.y ?? 0) + wvRect.top, window.innerHeight - 300),
        editFlags: params.editFlags ?? {}
      })
    }

    wv.addEventListener('did-navigate', handleNavigation)
    wv.addEventListener('did-navigate-in-page', handleNavigation)
    wv.addEventListener('did-fail-load', handleFailLoad)
    wv.addEventListener('context-menu', handleContextMenu)
    return () => {
      wv.removeEventListener('did-navigate', handleNavigation)
      wv.removeEventListener('did-navigate-in-page', handleNavigation)
      wv.removeEventListener('did-fail-load', handleFailLoad)
      wv.removeEventListener('context-menu', handleContextMenu)
    }
  }, [browserUrl, instanceId, browserService])

  return (
    <div className="browser-panel">
      <div className="browser-panel-tabs">
        {Object.entries(envStatus.urls).map(([name, url]) => (
          <button
            key={name}
            className={`browser-panel-tab ${browserService === name ? 'active' : ''}`}
            onClick={() => { browserUrlIntentRef.current = url; setBrowserService(name); setBrowserUrl(url); setBrowserUrlInput(url); setBrowserError(null) }}
          >
            {name}
          </button>
        ))}
        <div style={{ flex: 1 }} />
        <button className="browser-panel-nav-btn" onClick={() => webviewRef.current?.goBack()} title="Back">
          <ChevronUp size={12} style={{ transform: 'rotate(-90deg)' }} />
        </button>
        <button className="browser-panel-nav-btn" onClick={() => webviewRef.current?.goForward()} title="Forward">
          <ChevronUp size={12} style={{ transform: 'rotate(90deg)' }} />
        </button>
        <button className="browser-panel-nav-btn" onClick={() => webviewRef.current?.reload()} title="Reload">
          <RotateCw size={12} />
        </button>
        <input
          className="browser-panel-url"
          value={browserUrlInput}
          onChange={(e) => setBrowserUrlInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && browserUrlInput) {
              const url = browserUrlInput.startsWith('http') ? browserUrlInput : `http://${browserUrlInput}`
              browserUrlIntentRef.current = url
              setBrowserUrl(url)
              setBrowserUrlInput(url)
              setBrowserError(null)
            }
          }}
          onFocus={(e) => e.target.select()}
          spellCheck={false}
          placeholder="Enter URL..."
        />
        <button
          className="browser-panel-nav-btn"
          onClick={() => browserUrl && window.api.shell.openExternal(browserUrl)}
          title="Open in external browser"
        >
          <ExternalLink size={12} />
        </button>
        <button
          className="browser-panel-nav-btn"
          onClick={() => webviewRef.current?.openDevTools()}
          title="Open DevTools"
        >
          <Bug size={12} />
        </button>
      </div>
      {browserError ? (
        <div className="browser-panel-error">
          <AlertTriangle size={16} />
          <span>{browserError}</span>
          <button className="browser-panel-retry-btn" onClick={() => { setBrowserError(null); webviewRef.current?.reload() }}>
            Retry
          </button>
        </div>
      ) : (
        <webview
          ref={webviewRef as any}
          className="browser-panel-webview"
          partition={`persist:env-${envStatus.id}`}
        />
      )}
      {webviewContextMenu && (
        <>
          <div className="context-menu-overlay" onClick={() => setWebviewContextMenu(null)} />
          <div
            className="context-menu"
            style={{ top: webviewContextMenu.y, left: webviewContextMenu.x }}
          >
            <button className="context-menu-item" onClick={() => { webviewRef.current?.goBack(); setWebviewContextMenu(null) }}>Back</button>
            <button className="context-menu-item" onClick={() => { webviewRef.current?.goForward(); setWebviewContextMenu(null) }}>Forward</button>
            <button className="context-menu-item" onClick={() => { webviewRef.current?.reload(); setWebviewContextMenu(null) }}>Reload</button>
            <div className="context-menu-separator" />
            <button className="context-menu-item" disabled={!webviewContextMenu.editFlags.canCut} onClick={() => { webviewRef.current?.cut(); setWebviewContextMenu(null) }}>Cut</button>
            <button className="context-menu-item" disabled={!webviewContextMenu.editFlags.canCopy} onClick={() => { webviewRef.current?.copy(); setWebviewContextMenu(null) }}>Copy</button>
            <button className="context-menu-item" disabled={!webviewContextMenu.editFlags.canPaste} onClick={() => { webviewRef.current?.paste(); setWebviewContextMenu(null) }}>Paste</button>
            <button className="context-menu-item" disabled={!webviewContextMenu.editFlags.canSelectAll} onClick={() => { webviewRef.current?.selectAll(); setWebviewContextMenu(null) }}>Select All</button>
            <div className="context-menu-separator" />
            <button className="context-menu-item" onClick={() => { webviewRef.current?.openDevTools(); setWebviewContextMenu(null) }}>Inspect Element</button>
          </div>
        </>
      )}
    </div>
  )
}
