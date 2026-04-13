import { useState } from 'react'
import { Play, Square, FolderOpen, Stethoscope, RefreshCw, MessageSquare, AlertTriangle, CheckCircle, X, ExternalLink, ScrollText, Activity, RotateCcw } from 'lucide-react'
import type { EnvStatus } from '../../../shared/types'
import { buildDiagnosePrompt } from '../../../shared/env-prompts'
import type { ClaudeInstance } from '../types'

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  return m > 0 ? `${h}h ${m}m` : `${h}h`
}

interface ServicesTabProps {
  envStatus: EnvStatus
  instance: ClaudeInstance
}

export default function ServicesTab({ envStatus, instance }: ServicesTabProps) {
  const [envLogs, setEnvLogs] = useState<{ service: string; content: string } | null>(null)
  const [fixMenuOpen, setFixMenuOpen] = useState(false)
  const [fixResult, setFixResult] = useState<{ lines: string[]; isError?: boolean } | null>(null)
  const [fixInProgress, setFixInProgress] = useState(false)

  return (
    <div className="services-panel">
      {/* Header: name, status, actions */}
      <div className="services-panel-header">
        <span className="services-panel-env-name">{envStatus.displayName || envStatus.name}</span>
        <span className={`services-panel-env-status ${envStatus.status}`}>{envStatus.status}</span>
        <div className="services-panel-actions">
          {(envStatus.status === 'stopped' || envStatus.status === 'partial' || envStatus.services.some(s => s.status === 'crashed' || s.status === 'stopped')) && (
            <button className="services-panel-btn" onClick={() => window.api.env.start(envStatus.id)} title="Start all services">
              <Play size={12} /> Start All
            </button>
          )}
          {(envStatus.status === 'running' || envStatus.status === 'partial') && (
            <button className="services-panel-btn" onClick={() => window.api.env.stop(envStatus.id)} title="Stop all services">
              <Square size={10} /> Stop All
            </button>
          )}
          {envStatus.paths?.root && (
            <button className="services-panel-btn" onClick={() => window.api.shell.openExternal(`file://${envStatus.paths.root}`)} title="Open environment folder in Finder">
              <FolderOpen size={12} />
            </button>
          )}
          <div className="services-panel-fix-wrap">
            <button
              className={`services-panel-btn ${fixMenuOpen ? 'active' : ''}`}
              onClick={() => setFixMenuOpen(!fixMenuOpen)}
              title="Fix / diagnose environment"
            >
              <Stethoscope size={12} />
            </button>
            {fixMenuOpen && (
              <div className="services-panel-fix-dropdown" onClick={(e) => e.stopPropagation()}>
                <button className="services-panel-fix-item" onClick={async () => {
                  setFixMenuOpen(false)
                  try {
                    setFixInProgress(true)
                    setFixResult(null)
                    await window.api.env.stop(envStatus.id).catch(() => {})
                    const result = await window.api.env.fix(envStatus.id)
                    setFixResult({ lines: result.fixed })
                    setTimeout(() => setFixResult(prev => prev && !prev.isError ? null : prev), 8000)
                  } catch (err: any) {
                    setFixResult({ lines: [err.message || String(err)], isError: true })
                    setTimeout(() => setFixResult(prev => prev?.isError ? null : prev), 8000)
                  } finally {
                    setFixInProgress(false)
                  }
                }}>
                  <RefreshCw size={12} />
                  <div>
                    <div className="services-panel-fix-title">Quick Fix</div>
                    <div className="services-panel-fix-desc">Re-resolve ports and variables from template</div>
                  </div>
                </button>
                <button className="services-panel-fix-item" onClick={async () => {
                  setFixMenuOpen(false)
                  try {
                    const [manifest, setupLog] = await Promise.all([
                      window.api.env.manifest(envStatus.id),
                      window.api.env.logs(envStatus.id, 'setup', 200).catch(() => '(no setup log)'),
                    ])
                    const templateId = manifest?.meta?.templateId as string | undefined
                    const template = templateId ? await window.api.env.getTemplate(templateId).catch(() => null) : null
                    const hasCrashedServices = envStatus.services.some(s => s.status === 'crashed')
                    const { systemPrompt, initialPrompt } = buildDiagnosePrompt({
                      env: envStatus, manifest, setupLog, template,
                      isError: envStatus.status === 'error', hasCrashedServices,
                    })
                    let promptArgs: string[]
                    try {
                      const promptFile = await window.api.fs.writeTempFile(`env-${envStatus.name}`, systemPrompt)
                      promptArgs = ['--append-system-prompt-file', promptFile]
                    } catch {
                      promptArgs = ['--append-system-prompt', systemPrompt]
                    }
                    await window.api.instance.create({
                      name: `Fix: ${envStatus.displayName || envStatus.name}`,
                      workingDirectory: envStatus.paths.root || instance.workingDirectory,
                      color: '#ef4444',
                      args: [...promptArgs, initialPrompt],
                    })
                  } catch (err: any) {
                    setFixResult({ lines: [err.message || String(err)], isError: true })
                    setTimeout(() => setFixResult(prev => prev?.isError ? null : prev), 8000)
                  }
                }}>
                  <MessageSquare size={12} />
                  <div>
                    <div className="services-panel-fix-title">Diagnose with AI</div>
                    <div className="services-panel-fix-desc">Launch AI agent with logs and manifest context</div>
                  </div>
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Fix result banner */}
      {fixResult && (
        <div className={`services-panel-fix-result ${fixResult.isError ? 'error' : 'success'}`}>
          <div className="services-panel-fix-result-header">
            {fixResult.isError ? <AlertTriangle size={13} /> : <CheckCircle size={13} />}
            <span>{fixResult.isError ? 'Fix failed' : 'Environment fixed'}</span>
            <button onClick={() => setFixResult(null)}><X size={11} /></button>
          </div>
          <div className="services-panel-fix-result-items">
            {fixResult.lines.map((line, i) => <div key={i}>{line}</div>)}
          </div>
        </div>
      )}

      {/* URLs — prominent, at top */}
      {Object.keys(envStatus.urls).length > 0 && (
        <div className="services-panel-urls">
          <div className="services-panel-section-label">URLs</div>
          <div className="services-panel-url-list">
            {Object.entries(envStatus.urls).map(([name, url]) => (
              <button key={name} className="services-panel-url" onClick={() => window.api.shell.openExternal(url)} title={url}>
                <ExternalLink size={11} /> <span className="services-panel-url-name">{name}</span> <span className="services-panel-url-value">{url}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Services list */}
      <div className="services-panel-list">
        <div className="services-panel-section-label">Services</div>
        {envStatus.services.map((svc) => {
          const isActive = envLogs?.service === svc.name
          const matchingUrl = Object.entries(envStatus.urls).find(([k]) => k.toLowerCase() === svc.name.toLowerCase())?.[1]
            || (svc.port ? `http://localhost:${svc.port}` : null)
          return (
            <div key={svc.name} className={`services-panel-row ${isActive ? 'active' : ''} ${svc.status === 'crashed' ? 'crashed' : ''}`}>
              <div className="services-panel-row-main">
                <div className="services-panel-row-left">
                  <span className={`services-panel-status-dot ${svc.status}`} />
                  <span className="services-panel-svc-name">{svc.name}</span>
                  <span className={`services-panel-svc-badge ${svc.status}`}>{svc.status}</span>
                </div>
                <div className="services-panel-row-meta">
                  {svc.port && <span className="services-panel-port">:{svc.port}</span>}
                  {svc.status === 'running' && svc.uptime > 0 && (
                    <span className="services-panel-uptime"><Activity size={10} /> {formatUptime(svc.uptime)}</span>
                  )}
                  {svc.restarts > 0 && (
                    <span className="services-panel-restarts" title={`${svc.restarts} restart${svc.restarts > 1 ? 's' : ''}`}>
                      <AlertTriangle size={10} /> {svc.restarts}
                    </span>
                  )}
                </div>
                <div className="services-panel-row-actions">
                  {matchingUrl && svc.status === 'running' && (
                    <button title={`Open ${matchingUrl}`} onClick={() => window.api.shell.openExternal(matchingUrl)}>
                      <ExternalLink size={12} />
                    </button>
                  )}
                  <button
                    title="View logs"
                    className={isActive ? 'active' : ''}
                    onClick={() => {
                      if (isActive) { setEnvLogs(null) }
                      else { window.api.env.logs(envStatus.id, svc.name, 200).then((content) => setEnvLogs({ service: svc.name, content })) }
                    }}
                  >
                    <ScrollText size={13} />
                  </button>
                  <button title={`Restart ${svc.name}`} onClick={() => window.api.env.restartService(envStatus.id, svc.name)}>
                    <RotateCcw size={13} />
                  </button>
                  {svc.status === 'running' ? (
                    <button title={`Stop ${svc.name}`} onClick={() => window.api.env.stop(envStatus.id, [svc.name])}>
                      <Square size={11} />
                    </button>
                  ) : (
                    <button title={`Start ${svc.name}`} onClick={() => window.api.env.start(envStatus.id, [svc.name])}>
                      <Play size={13} />
                    </button>
                  )}
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {/* Inline log viewer */}
      {envLogs && (
        <div className="services-panel-logs">
          <div className="services-panel-logs-header">
            <span><ScrollText size={11} /> {envLogs.service} logs</span>
            <div className="services-panel-logs-actions">
              <button title="Refresh" onClick={() => window.api.env.logs(envStatus.id, envLogs.service, 200).then((content) => setEnvLogs({ service: envLogs.service, content }))}><RefreshCw size={11} /></button>
              <button title="Close" onClick={() => setEnvLogs(null)}><X size={12} /></button>
            </div>
          </div>
          <pre className="services-panel-logs-content">{envLogs.content}</pre>
        </div>
      )}

      {/* Ports & Paths */}
      {(Object.keys(envStatus.ports).length > 0 || Object.keys(envStatus.paths).length > 0) && (
        <div className="services-panel-meta">
          {Object.keys(envStatus.ports).length > 0 && (
            <div className="services-panel-meta-group">
              <div className="services-panel-section-label">Ports</div>
              <div className="services-panel-badges">
                {Object.entries(envStatus.ports).map(([name, port]) => (
                  <span key={name} className="services-panel-badge">{name}: {port}</span>
                ))}
              </div>
            </div>
          )}
          {Object.keys(envStatus.paths).length > 0 && (
            <div className="services-panel-meta-group">
              <div className="services-panel-section-label">Paths</div>
              <div className="services-panel-paths">
                {Object.entries(envStatus.paths).map(([name, path]) => (
                  <div key={name} className="services-panel-path-row">
                    <span className="services-panel-path-label">{name}</span>
                    <span className="services-panel-path-value" title={path}>{path}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
