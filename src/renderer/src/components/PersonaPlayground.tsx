import { useState, useEffect, useRef } from 'react'
import { X, Terminal, Play, Save, RotateCcw, CheckCircle2, XCircle } from 'lucide-react'

interface PersonaRef {
  id: string
  name: string
  model?: string
  filePath: string
}

interface Props {
  persona: PersonaRef
  onClose: () => void
}

function extractRoleSection(content: string): string {
  const match = content.match(/^## Role\n([\s\S]*?)(?=\n## |\n---\n|$)/m)
  return match ? match[1].trim() : ''
}

function replaceRoleSection(fullContent: string, newRole: string): string {
  const before = fullContent.match(/^([\s\S]*?^## Role\n)/m)
  const after = fullContent.match(/\n## (?!Role)[\s\S]*$/)
  if (!before) return fullContent
  return before[1] + newRole + '\n' + (after ? after[0].trimStart() : '')
}

function diffLines(original: string, modified: string): Array<{ type: 'same' | 'add' | 'remove'; text: string }> {
  const oLines = original.split('\n')
  const mLines = modified.split('\n')
  const result: Array<{ type: 'same' | 'add' | 'remove'; text: string }> = []
  const max = Math.max(oLines.length, mLines.length)
  for (let i = 0; i < max; i++) {
    const o = oLines[i]
    const m = mLines[i]
    if (o === m) {
      result.push({ type: 'same', text: o ?? '' })
    } else {
      if (o !== undefined) result.push({ type: 'remove', text: o })
      if (m !== undefined) result.push({ type: 'add', text: m })
    }
  }
  return result
}

export default function PersonaPlayground({ persona, onClose }: Props) {
  const [originalRole, setOriginalRole] = useState('')
  const [editedRole, setEditedRole] = useState('')
  const [originalContent, setOriginalContent] = useState('')
  const [output, setOutput] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [runError, setRunError] = useState<string | null>(null)
  const [runExitCode, setRunExitCode] = useState<number | null>(null)
  const [showDiff, setShowDiff] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveSuccess, setSaveSuccess] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    window.api.persona.getContent(persona.id).then(res => {
      if (res.content) {
        setOriginalContent(res.content)
        const role = extractRoleSection(res.content)
        setOriginalRole(role)
        setEditedRole(role)
      }
    })
  }, [persona.id])

  async function handleRun() {
    if (!editedRole.trim()) return
    setRunning(true)
    setOutput(null)
    setRunError(null)
    setRunExitCode(null)
    try {
      const result = await window.api.persona.testPrompt(persona.id, editedRole)
      setOutput(result.output)
      setRunExitCode(result.exitCode)
    } catch (e: any) {
      setRunError(String(e?.message ?? e))
    } finally {
      setRunning(false)
    }
  }

  async function handleSave() {
    if (!originalContent) return
    setSaving(true)
    const newContent = replaceRoleSection(originalContent, editedRole)
    try {
      await window.api.persona.saveContent(persona.id, newContent)
      setOriginalContent(newContent)
      setOriginalRole(editedRole)
      setShowDiff(false)
      setSaveSuccess(true)
      setTimeout(() => setSaveSuccess(false), 2000)
    } finally {
      setSaving(false)
    }
  }

  function handleReset() {
    setEditedRole(originalRole)
    setShowDiff(false)
  }

  const hasChanges = editedRole !== originalRole

  return (
    <div className="dialog-overlay" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="pp-modal">
        <div className="pp-header">
          <Terminal size={14} />
          <span>Prompt Playground — {persona.name}</span>
          {persona.model && <span className="pp-model-badge">{persona.model}</span>}
          <div style={{ flex: 1 }} />
          <button className="ct-close" onClick={onClose}><X size={14} /></button>
        </div>

        <div className="pp-body">
          <div className="pp-editor-section">
            <div className="pp-section-label">## Role — Edit and test before saving</div>
            <textarea
              ref={textareaRef}
              className="pp-editor"
              value={editedRole}
              onChange={e => { setEditedRole(e.target.value); setShowDiff(false) }}
              spellCheck={false}
              placeholder="Role section content…"
            />
            <div className="pp-editor-actions">
              <button className="pp-btn pp-btn-primary" onClick={handleRun} disabled={running || !editedRole.trim()}>
                <Play size={11} /> {running ? 'Running…' : 'Test Run'}
              </button>
              {hasChanges && (
                <>
                  <button className="pp-btn" onClick={() => setShowDiff(v => !v)}>
                    {showDiff ? 'Hide Diff' : 'Show Diff'}
                  </button>
                  <button className="pp-btn pp-btn-save" onClick={handleSave} disabled={saving}>
                    <Save size={11} /> {saving ? 'Saving…' : 'Save'}
                    {saveSuccess && <CheckCircle2 size={11} style={{ color: '#34d399' }} />}
                  </button>
                  <button className="pp-btn" onClick={handleReset}>
                    <RotateCcw size={11} /> Reset
                  </button>
                </>
              )}
            </div>
          </div>

          {showDiff && hasChanges && (
            <div className="pp-diff-section">
              <div className="pp-section-label">Changes</div>
              <div className="pp-diff">
                {diffLines(originalRole, editedRole).map((line, i) => (
                  <div key={i} className={`pp-diff-line pp-diff-${line.type}`}>
                    <span className="pp-diff-prefix">{line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' '}</span>
                    <span>{line.text}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="pp-output-section">
            <div className="pp-section-label">
              Test Output
              {runExitCode !== null && (
                runExitCode === 0
                  ? <CheckCircle2 size={12} style={{ color: '#34d399', marginLeft: 6 }} />
                  : <XCircle size={12} style={{ color: '#f87171', marginLeft: 6 }} />
              )}
            </div>
            {!output && !runError && !running && (
              <p className="pp-placeholder">Click "Test Run" to see how the model responds to your role definition.</p>
            )}
            {running && <p className="pp-placeholder">Running… (up to 60s)</p>}
            {runError && <p className="pp-run-error">{runError}</p>}
            {output && <pre className="pp-output">{output}</pre>}
          </div>
        </div>
      </div>
    </div>
  )
}
