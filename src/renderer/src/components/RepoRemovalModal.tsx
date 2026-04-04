import { useState } from 'react'
import { AlertTriangle, X, Trash2, FileText, User, Box, Zap, MessageSquare, HardDrive, Copy, Check, Play } from 'lucide-react'

interface PipelineFileImpact { fileName: string; filePath: string; matchingLines: string[] }
interface PersonaFileImpact { fileName: string; filePath: string; matchingLines: string[] }
interface EnvironmentImpact { name: string; branch: string; status: string }
interface RepoPipelineImpact { name: string; enabled: boolean }

export interface RemovalImpact {
  slug: string
  pipelineFiles: PipelineFileImpact[]
  personaFiles: PersonaFileImpact[]
  environments: EnvironmentImpact[]
  repoPipelines: RepoPipelineImpact[]
  prCommentFiles: number
  bareCloneExists: boolean
  bareClonePath: string
}

interface Props {
  repo: { owner: string; name: string }
  impact: RemovalImpact
  onConfirm: () => Promise<void>
  onCancel: () => void
  onLaunchSession: (prompt: string) => void
}

function buildPrompt(repo: { owner: string; name: string }, impact: RemovalImpact): string {
  const lines: string[] = [
    `I'm removing the GitHub repository **${impact.slug}** from Claude Colony.`,
    '',
    'Please audit and clean up all references to this repo across Colony config files.',
    '',
  ]

  if (impact.pipelineFiles.length > 0) {
    lines.push('## Pipeline files to update')
    for (const f of impact.pipelineFiles) {
      lines.push(`\n**${f.filePath}**`)
      lines.push('Matching lines:')
      for (const l of f.matchingLines) lines.push(`  ${l}`)
    }
    lines.push('')
    lines.push('For each pipeline above:')
    lines.push(`- Remove \`${impact.slug}\` from any \`repos:\` list`)
    lines.push('- If the pipeline only targets this repo and has no other purpose, consider disabling or deleting it')
    lines.push('- If `repos: auto` is used, no change needed (auto excludes removed repos automatically)')
    lines.push('')
  }

  if (impact.personaFiles.length > 0) {
    lines.push('## Persona files to update')
    for (const f of impact.personaFiles) {
      lines.push(`\n**${f.filePath}**`)
      lines.push('Matching lines:')
      for (const l of f.matchingLines) lines.push(`  ${l}`)
    }
    lines.push('')
    lines.push('For each persona above:')
    lines.push(`- Remove or replace references to \`${impact.slug}\` or \`${repo.name}\``)
    lines.push('- Update working_directory if it pointed to a worktree of this repo')
    lines.push('')
  }

  if (impact.environments.length > 0) {
    lines.push('## Environments using this repo')
    for (const e of impact.environments) {
      lines.push(`- **${e.name}** (branch: ${e.branch || 'unknown'}, status: ${e.status})`)
    }
    lines.push('')
    lines.push('These environments have worktrees from this repo. They will not work once the bare clone is removed.')
    lines.push('Consider tearing them down via the Environments panel, or note that they are now orphaned.')
    lines.push('')
  }

  if (impact.repoPipelines.length > 0) {
    lines.push('## Pipelines from .colony/ (will be unloaded)')
    for (const p of impact.repoPipelines) {
      lines.push(`- ${p.name}${p.enabled ? ' (was enabled)' : ''}`)
    }
    lines.push('')
    lines.push('These pipelines were sourced from this repo\'s .colony/pipelines/ directory.')
    lines.push('They will disappear from the Pipelines panel after removal. No action needed.')
    lines.push('')
  }

  lines.push('## What to do')
  lines.push('1. Review each file listed above')
  lines.push('2. Remove or update references to this repo')
  lines.push('3. Tell me what you changed and what (if anything) needs manual attention')
  lines.push('')
  lines.push(`Working directory: ~/.claude-colony`)

  return lines.join('\n')
}

export default function RepoRemovalModal({ repo, impact, onConfirm, onCancel, onLaunchSession }: Props) {
  const [confirming, setConfirming] = useState(false)
  const [copied, setCopied] = useState(false)
  const prompt = buildPrompt(repo, impact)

  const totalIssues = impact.pipelineFiles.length + impact.personaFiles.length +
    impact.environments.length + impact.repoPipelines.length +
    (impact.prCommentFiles > 0 ? 1 : 0)

  const handleConfirm = async () => {
    setConfirming(true)
    try { await onConfirm() } finally { setConfirming(false) }
  }

  const handleCopy = async () => {
    await navigator.clipboard.writeText(prompt)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="removal-modal-overlay" onClick={onCancel}>
      <div className="removal-modal" onClick={e => e.stopPropagation()}>
        <div className="removal-modal-header">
          <AlertTriangle size={16} className="removal-modal-icon" />
          <h3>Remove {impact.slug}?</h3>
          <button className="removal-modal-close" onClick={onCancel}><X size={14} /></button>
        </div>

        {totalIssues === 0 ? (
          <p className="removal-modal-clean">No references found in pipelines, personas, or environments.</p>
        ) : (
          <div className="removal-modal-impacts">
            <p className="removal-modal-intro">
              The following may be affected. Review them or use the prompt below to have Claude clean up for you.
            </p>

            {impact.pipelineFiles.length > 0 && (
              <div className="removal-impact-section">
                <div className="removal-impact-heading">
                  <Zap size={12} /> Pipeline files ({impact.pipelineFiles.length})
                </div>
                {impact.pipelineFiles.map(f => (
                  <div key={f.filePath} className="removal-impact-item">
                    <span className="removal-impact-filename">{f.fileName}</span>
                    {f.matchingLines.map((l, i) => (
                      <code key={i} className="removal-impact-line">{l}</code>
                    ))}
                  </div>
                ))}
              </div>
            )}

            {impact.personaFiles.length > 0 && (
              <div className="removal-impact-section">
                <div className="removal-impact-heading">
                  <User size={12} /> Persona files ({impact.personaFiles.length})
                </div>
                {impact.personaFiles.map(f => (
                  <div key={f.filePath} className="removal-impact-item">
                    <span className="removal-impact-filename">{f.fileName}</span>
                    {f.matchingLines.map((l, i) => (
                      <code key={i} className="removal-impact-line">{l}</code>
                    ))}
                  </div>
                ))}
              </div>
            )}

            {impact.environments.length > 0 && (
              <div className="removal-impact-section">
                <div className="removal-impact-heading">
                  <Box size={12} /> Environments using this repo ({impact.environments.length})
                </div>
                {impact.environments.map((e, i) => (
                  <div key={i} className="removal-impact-item">
                    <span className="removal-impact-filename">{e.name}</span>
                    <span className="removal-impact-meta">{e.branch ? `branch: ${e.branch}` : ''} {e.status}</span>
                  </div>
                ))}
              </div>
            )}

            {impact.repoPipelines.length > 0 && (
              <div className="removal-impact-section">
                <div className="removal-impact-heading">
                  <FileText size={12} /> Repo pipelines that will unload ({impact.repoPipelines.length})
                </div>
                {impact.repoPipelines.map((p, i) => (
                  <div key={i} className="removal-impact-item">
                    <span className="removal-impact-filename">{p.name}</span>
                    {p.enabled && <span className="removal-impact-badge enabled">enabled</span>}
                  </div>
                ))}
              </div>
            )}

            {impact.prCommentFiles > 0 && (
              <div className="removal-impact-section">
                <div className="removal-impact-heading">
                  <MessageSquare size={12} /> PR comment files ({impact.prCommentFiles} files in pr-workspace/comments/)
                </div>
              </div>
            )}

            {impact.bareCloneExists && (
              <div className="removal-impact-section removal-impact-bare">
                <div className="removal-impact-heading">
                  <HardDrive size={12} /> Bare clone not deleted
                </div>
                <code className="removal-impact-path">{impact.bareClonePath}</code>
                <span className="removal-impact-note">Kept on disk — environments may reference it. Delete manually if no longer needed.</span>
              </div>
            )}
          </div>
        )}

        {totalIssues > 0 && (
          <div className="removal-modal-prompt">
            <div className="removal-prompt-header">
              <span>Cleanup prompt — launch a session to fix these automatically</span>
              <div className="removal-prompt-actions">
                <button className="removal-prompt-btn" onClick={handleCopy} title="Copy prompt">
                  {copied ? <Check size={11} /> : <Copy size={11} />}
                  {copied ? 'Copied' : 'Copy'}
                </button>
                <button className="removal-prompt-btn primary" onClick={() => onLaunchSession(prompt)} title="Launch a Claude session with this prompt">
                  <Play size={11} /> Launch Session
                </button>
              </div>
            </div>
            <pre className="removal-prompt-preview">{prompt.slice(0, 400)}{prompt.length > 400 ? '\n…' : ''}</pre>
          </div>
        )}

        <div className="removal-modal-footer">
          <button className="removal-modal-cancel" onClick={onCancel}>Cancel</button>
          <button className="removal-modal-confirm" onClick={handleConfirm} disabled={confirming}>
            <Trash2 size={12} />
            {confirming ? 'Removing…' : 'Remove Anyway'}
          </button>
        </div>
      </div>
    </div>
  )
}
