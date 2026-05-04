import { useState } from 'react'
import { X, FlaskConical, CheckCircle2, XCircle, ChevronRight, ChevronDown, Play } from 'lucide-react'

interface TestResult {
  type: string
  passed: boolean
  detail?: string
  children?: TestResult[]
}

interface PipelineRef {
  name: string
  fileName: string
  triggerType: string
}

interface Props {
  pipeline: PipelineRef
  onClose: () => void
}

function ResultNode({ node, depth = 0 }: { node: TestResult; depth?: number }) {
  const [open, setOpen] = useState(true)
  const isComposite = node.type === 'all-of' || node.type === 'any-of'
  const hasChildren = isComposite && Array.isArray(node.children) && node.children.length > 0
  const label = node.type === 'none' ? 'No Condition' :
    node.type === 'all-of' ? 'all-of (AND)' :
    node.type === 'any-of' ? 'any-of (OR)' :
    node.type

  return (
    <div className="ct-node" style={{ marginLeft: depth * 16 }}>
      <div
        className={`ct-node-row${hasChildren ? ' ct-node-expandable' : ''}`}
        onClick={() => hasChildren && setOpen(o => !o)}
      >
        {hasChildren ? (
          open ? <ChevronDown size={12} className="ct-node-chevron" /> : <ChevronRight size={12} className="ct-node-chevron" />
        ) : (
          <span style={{ width: 12, display: 'inline-block' }} />
        )}
        {node.passed
          ? <CheckCircle2 size={13} className="ct-pass-icon" />
          : <XCircle size={13} className="ct-fail-icon" />
        }
        <span className="ct-node-type">{label}</span>
        {node.detail && <span className="ct-node-detail">{node.detail}</span>}
      </div>
      {hasChildren && open && node.children!.map((child, i) => (
        <ResultNode key={i} node={child} depth={depth + 1} />
      ))}
    </div>
  )
}

export default function ConditionTester({ pipeline, onClose }: Props) {
  const triggerType = pipeline.triggerType ?? 'cron'

  const [prTitle, setPrTitle] = useState('')
  const [prBranch, setPrBranch] = useState('')
  const [prAuthor, setPrAuthor] = useState('')
  const [prLabels, setPrLabels] = useState('')
  const [prDraft, setPrDraft] = useState(false)
  const [prReviewers, setPrReviewers] = useState('')
  const [issueNumber, setIssueNumber] = useState('')
  const [issueTitle, setIssueTitle] = useState('')
  const [issueLabels, setIssueLabels] = useState('')
  const [issueAssignee, setIssueAssignee] = useState('')
  const [webhookPayload, setWebhookPayload] = useState('{}')
  const [githubUser, setGithubUser] = useState('')
  const [result, setResult] = useState<TestResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleTest() {
    setLoading(true)
    setError(null)
    setResult(null)
    try {
      const mockContext: Record<string, unknown> = { triggerType, githubUser: githubUser || undefined }
      if (triggerType === 'git-poll') {
        if (prBranch) mockContext.prBranch = prBranch
        if (prTitle) mockContext.prTitle = prTitle
        if (prAuthor) mockContext.prAuthor = prAuthor
        if (prLabels) mockContext.prLabels = prLabels
        mockContext.prDraft = prDraft
        if (prReviewers) mockContext.prReviewers = prReviewers
      } else if (triggerType === 'webhook') {
        mockContext.webhookPayload = webhookPayload
      } else if (triggerType === 'issue-assigned') {
        if (issueTitle) mockContext.issueTitle = issueTitle
        if (issueNumber) mockContext.issueNumber = parseInt(issueNumber, 10)
        if (issueLabels) mockContext.issueLabels = issueLabels
        if (issueAssignee) mockContext.issueAssignee = issueAssignee
      }
      const res = await window.api.pipeline.testConditions(pipeline.fileName, mockContext)
      if (!res) { setError('Could not load pipeline file'); return }
      setResult(res as TestResult)
    } catch (e: any) {
      setError(String(e?.message ?? e))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="dialog-overlay" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="ct-modal">
        <div className="ct-header">
          <FlaskConical size={14} />
          <span>Condition Tester — {pipeline.name}</span>
          <div style={{ flex: 1 }} />
          <button className="ct-close" onClick={onClose}><X size={14} /></button>
        </div>
        <div className="ct-body">
          <div className="ct-left">
            <div className="ct-section-title">Mock Context</div>
            {triggerType === 'cron' && (
              <p className="ct-cron-note">Cron pipelines fire on schedule — no context to test.</p>
            )}
            {triggerType === 'git-poll' && (
              <>
                <label className="ct-label">PR Branch
                  <input className="ct-input" value={prBranch} onChange={e => setPrBranch(e.target.value)} placeholder="feat/my-feature" />
                </label>
                <label className="ct-label">PR Title
                  <input className="ct-input" value={prTitle} onChange={e => setPrTitle(e.target.value)} placeholder="feat: add something" />
                </label>
                <label className="ct-label">PR Author
                  <input className="ct-input" value={prAuthor} onChange={e => setPrAuthor(e.target.value)} placeholder="octocat" />
                </label>
                <label className="ct-label">Labels (comma-separated)
                  <input className="ct-input" value={prLabels} onChange={e => setPrLabels(e.target.value)} placeholder="bug, enhancement" />
                </label>
                <label className="ct-label">Reviewers (comma-separated)
                  <input className="ct-input" value={prReviewers} onChange={e => setPrReviewers(e.target.value)} placeholder="alice, bob" />
                </label>
                <label className="ct-label ct-label-row">
                  <input type="checkbox" checked={prDraft} onChange={e => setPrDraft(e.target.checked)} />
                  Draft PR
                </label>
                <label className="ct-label">GitHub User (you)
                  <input className="ct-input" value={githubUser} onChange={e => setGithubUser(e.target.value)} placeholder="your-username" />
                </label>
              </>
            )}
            {triggerType === 'webhook' && (
              <label className="ct-label">Webhook Payload (JSON)
                <textarea
                  className="ct-textarea ct-payload"
                  value={webhookPayload}
                  onChange={e => setWebhookPayload(e.target.value)}
                  rows={10}
                  spellCheck={false}
                />
              </label>
            )}
            {triggerType === 'issue-assigned' && (
              <>
                <label className="ct-label">Issue Number
                  <input className="ct-input" type="number" value={issueNumber} onChange={e => setIssueNumber(e.target.value)} placeholder="42" />
                </label>
                <label className="ct-label">Issue Title
                  <input className="ct-input" value={issueTitle} onChange={e => setIssueTitle(e.target.value)} placeholder="Bug: something is broken" />
                </label>
                <label className="ct-label">Labels (comma-separated)
                  <input className="ct-input" value={issueLabels} onChange={e => setIssueLabels(e.target.value)} placeholder="bug, sprint-23" />
                </label>
                <label className="ct-label">Assignee
                  <input className="ct-input" value={issueAssignee} onChange={e => setIssueAssignee(e.target.value)} placeholder="your-username" />
                </label>
                <label className="ct-label">GitHub User (you)
                  <input className="ct-input" value={githubUser} onChange={e => setGithubUser(e.target.value)} placeholder="your-username" />
                </label>
              </>
            )}
            <button className="ct-run-btn" onClick={handleTest} disabled={loading}>
              <Play size={12} /> {loading ? 'Testing…' : 'Test Conditions'}
            </button>
          </div>
          <div className="ct-right">
            <div className="ct-section-title">Result</div>
            {!result && !error && <p className="ct-placeholder">Fill in mock context and click Test Conditions.</p>}
            {error && <p className="ct-error">{error}</p>}
            {result && (
              <>
                <div className={`ct-verdict ${result.passed ? 'pass' : 'fail'}`}>
                  {result.passed
                    ? <><CheckCircle2 size={14} /> Would fire</>
                    : <><XCircle size={14} /> Would NOT fire</>
                  }
                </div>
                <div className="ct-tree">
                  <ResultNode node={result} />
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
