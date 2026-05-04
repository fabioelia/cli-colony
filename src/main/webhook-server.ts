/**
 * Webhook + REST API HTTP server for Colony.
 *
 * Webhook routes: POST /webhook/<slug> → fire matching pipeline
 * REST API routes: /api/* → session/pipeline management + SSE event stream
 *
 * GitHub source: verifies X-Hub-Signature-256 (HMAC-SHA256 of raw body)
 * Generic source: verifies Authorization: Bearer <secret> or X-Colony-Token: <secret>
 * API routes: Bearer/X-Colony-Token required when `apiToken` setting is configured
 */

import { app } from 'electron'
import { createServer, IncomingMessage, ServerResponse, Server } from 'http'
import { createHmac, timingSafeEqual } from 'crypto'
import { fireWebhookPipeline, getWebhookTriggers, getPipelineList, triggerPollNow, getHistory, previewPipeline, validatePipelineYaml, getPresets } from './pipeline-engine'
import { getAllInstances, createInstance, killInstance } from './instance-manager'
import { getDaemonRouter } from './daemon-router'
import { getSetting } from './settings'
import { addBroadcastListener } from './broadcast'
import { getPersonaList, runPersona, addWhisper } from './persona-manager'

const PREFIX = '[webhook-server]'

let server: Server | null = null
let serverUrl: string | null = null
const serverStartMs = Date.now()

/** Extract structured template vars from a GitHub webhook payload. Returns a flat Record<string, string>. */
function extractGitHubVars(eventType: string, payload: unknown): Record<string, string> {
  const vars: Record<string, string> = {}
  if (!payload || typeof payload !== 'object') return vars
  const p = payload as Record<string, unknown>

  // All events
  if (eventType) vars.github_event = eventType
  const repo = p.repository as Record<string, unknown> | undefined
  if (repo?.full_name) vars.github_repo = String(repo.full_name)
  const sender = p.sender as Record<string, unknown> | undefined
  if (sender?.login) vars.github_sender = String(sender.login)

  try {
    if (eventType === 'push') {
      const ref = typeof p.ref === 'string' ? p.ref : ''
      if (ref.startsWith('refs/tags/')) {
        vars.github_branch = `tag:${ref.replace('refs/tags/', '')}`
      } else {
        vars.github_branch = ref.replace('refs/heads/', '')
      }
      const head = p.head_commit as Record<string, unknown> | undefined
      if (head?.id) vars.github_commit = String(head.id)
      if (typeof head?.message === 'string') {
        vars.github_commit_message = head.message.slice(0, 200)
      }
      const pusher = p.pusher as Record<string, unknown> | undefined
      if (pusher?.name) vars.github_pusher = String(pusher.name)
    } else if (eventType === 'pull_request') {
      const action = typeof p.action === 'string' ? p.action : ''
      if (action) vars.github_action = action
      const pr = p.pull_request as Record<string, unknown> | undefined
      if (pr) {
        if (pr.number !== undefined) vars.github_pr_number = String(pr.number)
        if (typeof pr.title === 'string') vars.github_pr_title = pr.title
        const head = pr.head as Record<string, unknown> | undefined
        if (head?.ref) vars.github_pr_branch = String(head.ref)
        const base = pr.base as Record<string, unknown> | undefined
        if (base?.ref) vars.github_pr_base = String(base.ref)
        const user = pr.user as Record<string, unknown> | undefined
        if (user?.login) vars.github_pr_author = String(user.login)
        if (typeof pr.html_url === 'string') vars.github_pr_url = pr.html_url
      }
    } else if (eventType === 'issues') {
      const action = typeof p.action === 'string' ? p.action : ''
      if (action) vars.github_action = action
      const issue = p.issue as Record<string, unknown> | undefined
      if (issue) {
        if (issue.number !== undefined) vars.github_issue_number = String(issue.number)
        if (typeof issue.title === 'string') vars.github_issue_title = issue.title
        const user = issue.user as Record<string, unknown> | undefined
        if (user?.login) vars.github_issue_author = String(user.login)
      }
    } else if (eventType === 'workflow_run') {
      const action = typeof p.action === 'string' ? p.action : ''
      if (action) vars.github_action = action
      const wf = p.workflow_run as Record<string, unknown> | undefined
      if (wf) {
        if (typeof wf.name === 'string') vars.github_workflow_name = wf.name
        if (typeof wf.conclusion === 'string') vars.github_workflow_conclusion = wf.conclusion
        if (typeof wf.head_branch === 'string') vars.github_branch = wf.head_branch
      }
    }
  } catch {
    // If extraction fails, return whatever we extracted so far — don't crash
  }

  return vars
}

// SSE client tracking
const MAX_SSE_CLIENTS = 5
const _sseClients = new Set<ServerResponse>()

// Per-session SSE stream tracking: sessionId → Set of response objects
const MAX_STREAM_CLIENTS_PER_SESSION = 5
const _streamClients = new Map<string, Set<ServerResponse>>()

// Rate limiting for POST /api/sessions (5 per minute)
const _sessionCreateTimestamps: number[] = []
const SESSION_CREATE_RATE_LIMIT = 5
const SESSION_CREATE_WINDOW_MS = 60_000

// Relay all broadcast events to global SSE clients and per-session stream clients
addBroadcastListener((channel, ...args) => {
  if (_sseClients.size === 0 && _streamClients.size === 0) return
  if (_sseClients.size > 0) {
    const event = JSON.stringify({ channel, data: args.length === 1 ? args[0] : args })
    for (const res of _sseClients) {
      try {
        res.write(`data: ${event}\n\n`)
      } catch { /* client disconnected */ }
    }
  }
  if (channel === 'instance:output' && _streamClients.size > 0) {
    const payload = args[0] as { id: string; data: string }
    const clients = _streamClients.get(payload.id)
    if (clients && clients.size > 0) {
      const msg = `event: output\ndata: ${JSON.stringify({ text: payload.data })}\n\n`
      for (const res of clients) {
        try { res.write(msg) } catch { /* client disconnected */ }
      }
    }
  }
  if (channel === 'instance:exited' && _streamClients.size > 0) {
    const payload = args[0] as { id: string; exitCode?: number }
    const clients = _streamClients.get(payload.id)
    if (clients && clients.size > 0) {
      const msg = `event: exit\ndata: ${JSON.stringify({ code: payload.exitCode ?? null })}\n\n`
      for (const res of clients) {
        try { res.write(msg) } catch { /* already closed */ }
        try { res.end() } catch { /* already closed */ }
      }
      _streamClients.delete(payload.id)
    }
  }
})

function log(msg: string): void {
  console.log(`${PREFIX} ${msg}`)
}

const MAX_BODY_BYTES = 1_048_576 // 1 MB

/** Return raw body bytes from an incoming request. Rejects if body exceeds 1 MB. */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let totalBytes = 0
    req.on('data', (chunk: Buffer) => {
      totalBytes += chunk.length
      if (totalBytes > MAX_BODY_BYTES) {
        req.destroy()
        reject(new Error('Body exceeds maximum size'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/**
 * Verify GitHub HMAC-SHA256 signature.
 * Header: X-Hub-Signature-256: sha256=<hex>
 */
export function verifyGitHubSignature(secret: string, body: Buffer, header: string | undefined): boolean {
  if (!header || !header.startsWith('sha256=')) return false
  const expected = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
  // Constant-time comparison to prevent timing attacks
  try {
    const a = Buffer.from(expected, 'utf8')
    const b = Buffer.from(header, 'utf8')
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  } catch {
    return false
  }
}

/** Constant-time string comparison. Returns false for different lengths (no timing leak on length). */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8')
  const bufB = Buffer.from(b, 'utf8')
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

/**
 * Verify generic bearer token.
 * Accepts: Authorization: Bearer <secret>  or  X-Colony-Token: <secret>
 */
export function verifyGenericToken(secret: string, req: IncomingMessage): boolean {
  const authHeader = req.headers['authorization']
  if (authHeader) {
    if (safeEqual(authHeader, `Bearer ${secret}`)) return true
  }
  const colonyToken = req.headers['x-colony-token']
  if (typeof colonyToken === 'string' && safeEqual(colonyToken, secret)) return true
  return false
}

function sendJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
  res.end(payload)
}

/** Check API auth — required only when `apiToken` setting is configured.
 *  Also accepts ?token= query param for GET requests (needed for EventSource). */
async function checkApiAuth(req: IncomingMessage): Promise<boolean> {
  const token = await getSetting('apiToken')
  if (!token) return true
  if (verifyGenericToken(token, req)) return true
  // EventSource can't send headers — accept token via query param for GET requests only
  if (req.method === 'GET' && req.url) {
    try {
      const params = new URL(req.url, 'http://localhost').searchParams
      const qToken = params.get('token')
      if (qToken && safeEqual(qToken, token)) return true
    } catch { /* invalid URL */ }
  }
  return false
}

function buildDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Colony Dashboard</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0d0d1a;color:#e0e0e0;font:13px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:0}
a{color:#3b82f6;text-decoration:none}
#header{background:#111128;border-bottom:1px solid #222244;padding:12px 20px;display:flex;align-items:center;gap:12px;flex-wrap:wrap}
#header h1{font-size:16px;font-weight:600;color:#e0e0e0;flex:1}
#uptime{font-size:11px;color:#888;margin-left:auto}
#health-dot{width:10px;height:10px;border-radius:50%;background:#22c55e;flex-shrink:0}
#health-dot.warn{background:#f59e0b}
#health-dot.err{background:#ef4444}
#auth-bar{background:#0d0d1a;border-bottom:1px solid #1a1a3a;padding:8px 20px;display:flex;align-items:center;gap:8px}
#auth-bar label{font-size:11px;color:#888}
#token-input{padding:4px 8px;border:1px solid #333;border-radius:4px;background:#111128;color:#e0e0e0;font:12px monospace;width:260px}
#apply-btn{padding:4px 12px;background:#3b82f6;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:12px}
#apply-btn:hover{background:#2563eb}
main{padding:20px;display:grid;gap:20px;max-width:1200px;margin:0 auto}
@media(min-width:800px){main{grid-template-columns:1fr 1fr}}
section{background:#111128;border:1px solid #1a1a3a;border-radius:8px;padding:16px}
section h2{font-size:13px;font-weight:600;color:#aaa;text-transform:uppercase;letter-spacing:.05em;margin-bottom:12px;display:flex;align-items:center;gap:8px}
.badge{display:inline-block;padding:1px 7px;border-radius:10px;font-size:11px;font-weight:500}
.badge.green{background:rgba(34,197,94,.15);color:#22c55e}
.badge.red{background:rgba(239,68,68,.15);color:#ef4444}
.badge.blue{background:rgba(59,130,246,.15);color:#3b82f6}
.badge.amber{background:rgba(245,158,11,.15);color:#f59e0b}
.stat-row{display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap}
.stat{background:#0d0d1a;border:1px solid #1a1a3a;border-radius:6px;padding:8px 14px;text-align:center}
.stat-val{font-size:20px;font-weight:700;color:#e0e0e0}
.stat-lbl{font-size:10px;color:#666;margin-top:2px}
table{width:100%;border-collapse:collapse;font-size:12px}
th{color:#666;font-weight:500;text-align:left;padding:4px 8px;border-bottom:1px solid #1a1a3a}
td{padding:5px 8px;border-bottom:1px solid rgba(255,255,255,.04);vertical-align:top}
tr:last-child td{border-bottom:none}
.name{color:#e0e0e0;font-weight:500}
.muted{color:#666}
.cost{font-variant-numeric:tabular-nums}
#sessions-stat,#pipelines-stat,#personas-stat{font-size:11px;color:#666;margin-bottom:8px}
#last-updated{font-size:10px;color:#444;text-align:right;margin-top:4px}
.act-btn{padding:2px 8px;border:none;border-radius:3px;cursor:pointer;font-size:11px;font-weight:500;color:#fff;margin-left:4px}
.act-btn:disabled{opacity:.4;cursor:not-allowed}
.act-btn.red{background:#ef4444}.act-btn.red:hover:not(:disabled){background:#dc2626}
.act-btn.blue{background:#3b82f6}.act-btn.blue:hover:not(:disabled){background:#2563eb}
.act-btn.gray{background:#4b5563}.act-btn.gray:hover:not(:disabled){background:#374151}
.act-btn.green{background:#22c55e;color:#111}.act-btn.green:hover:not(:disabled){background:#16a34a}
#new-session-form{display:none;background:#0d0d1a;border:1px solid #222244;border-radius:6px;padding:12px;margin-bottom:12px}
#new-session-form h3{font-size:12px;color:#aaa;margin-bottom:8px}
.form-row{display:flex;gap:8px;margin-bottom:6px;flex-wrap:wrap}
.form-row input,.form-row select{flex:1;min-width:120px;padding:4px 8px;background:#111128;border:1px solid #333;border-radius:4px;color:#e0e0e0;font-size:12px}
.form-actions{display:flex;gap:6px;margin-top:8px}
#new-session-btn{padding:4px 12px;background:#3b82f6;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:12px;margin-bottom:8px}
#new-session-btn:hover{background:#2563eb}
.whisper-row{display:flex;gap:6px;padding:4px 0}
.whisper-row input{flex:1;padding:3px 7px;background:#111128;border:1px solid #333;border-radius:4px;color:#e0e0e0;font-size:11px}
.trigger-params{display:none;background:#111128;border:1px solid #1a1a3a;border-radius:4px;padding:8px;margin-top:6px}
.trigger-params input,.trigger-params select{width:100%;margin-bottom:4px;padding:3px 7px;background:#0d0d1a;border:1px solid #333;border-radius:3px;color:#e0e0e0;font-size:11px}
#toast-container{position:fixed;bottom:20px;right:20px;display:flex;flex-direction:column;gap:6px;z-index:999;pointer-events:none}
.toast{padding:8px 14px;border-radius:6px;font-size:12px;opacity:1;transition:opacity .3s}
.toast.ok{background:#166534;color:#bbf7d0}
.toast.err{background:#7f1d1d;color:#fecaca}
</style>
</head>
<body>
<div id="toast-container"></div>
<div id="header">
  <div id="health-dot"></div>
  <h1>Colony Dashboard</h1>
  <span id="uptime" class="muted">—</span>
</div>
<div id="auth-bar">
  <label for="token-input">API Token:</label>
  <input id="token-input" type="password" placeholder="Leave empty if no auth configured" />
  <button id="apply-btn">Connect</button>
</div>
<main>
  <section>
    <h2>Sessions <span id="sessions-stat"></span></h2>
    <div class="stat-row">
      <div class="stat"><div class="stat-val" id="s-running">—</div><div class="stat-lbl">Running</div></div>
      <div class="stat"><div class="stat-val" id="s-waiting">—</div><div class="stat-lbl">Waiting</div></div>
      <div class="stat"><div class="stat-val" id="s-stopped">—</div><div class="stat-lbl">Stopped</div></div>
    </div>
    <button id="new-session-btn" onclick="document.getElementById('new-session-form').style.display=document.getElementById('new-session-form').style.display==='none'?'block':'none'">+ New Session</button>
    <div id="new-session-form">
      <h3>New Session</h3>
      <div class="form-row">
        <input id="ns-name" placeholder="Name (required)" />
        <input id="ns-dir" placeholder="Working directory (~/ default)" />
      </div>
      <div class="form-row">
        <input id="ns-prompt" placeholder="Initial prompt (optional)" />
        <select id="ns-model">
          <option value="">Default model</option>
          <option value="claude-opus-4-7">Opus 4.7</option>
          <option value="claude-sonnet-4-6">Sonnet 4.6</option>
          <option value="claude-haiku-4-5-20251001">Haiku 4.5</option>
        </select>
      </div>
      <div class="form-row">
        <select id="ns-perm">
          <option value="">Default permission</option>
          <option value="default">default</option>
          <option value="acceptEdits">acceptEdits</option>
          <option value="bypassPermissions">bypassPermissions</option>
        </select>
      </div>
      <div class="form-actions">
        <button class="act-btn green" onclick="createSession()">Create</button>
        <button class="act-btn gray" onclick="document.getElementById('new-session-form').style.display='none'">Cancel</button>
      </div>
    </div>
    <table id="sessions-table"><thead><tr><th>Name</th><th>Status</th><th>Cost</th><th>Idle</th><th></th></tr></thead><tbody></tbody></table>
  </section>
  <section>
    <h2>Pipelines <span id="pipelines-stat"></span></h2>
    <table id="pipelines-table"><thead><tr><th>Name</th><th>Next Fire</th><th>Last Run</th><th></th></tr></thead><tbody></tbody></table>
  </section>
  <section>
    <h2>Personas <span id="personas-stat"></span></h2>
    <table id="personas-table"><thead><tr><th>Name</th><th>Runs</th><th>Last Run</th><th></th></tr></thead><tbody></tbody></table>
  </section>
  <section>
    <h2>Health</h2>
    <table id="health-table"><thead><tr><th>Check</th><th>Status</th></tr></thead><tbody></tbody></table>
    <div id="last-updated"></div>
  </section>
</main>
<script>
(function() {
  var token = sessionStorage.getItem('colony-dash-token') || '';
  if (token) document.getElementById('token-input').value = token;

  function headers() {
    return token ? { 'Authorization': 'Bearer ' + token } : {};
  }

  function fmt(ms) {
    if (ms < 60000) return Math.round(ms/1000) + 's';
    if (ms < 3600000) return Math.round(ms/60000) + 'm';
    return (ms/3600000).toFixed(1) + 'h';
  }
  function fmtDate(ts) {
    if (!ts) return '—';
    var d = new Date(ts), now = Date.now(), diff = now - d.getTime();
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return Math.round(diff/60000) + 'm ago';
    if (diff < 86400000) return Math.round(diff/3600000) + 'h ago';
    return d.toLocaleDateString();
  }

  function setTbody(id, rows) {
    document.querySelector('#' + id + ' tbody').innerHTML = rows.join('');
  }

  async function load() {
    try {
      var [status, sessions, pipelines, personas, health] = await Promise.all([
        fetch('/api/status', {headers: headers()}).then(r => r.ok ? r.json() : null),
        fetch('/api/sessions', {headers: headers()}).then(r => r.ok ? r.json() : null),
        fetch('/api/pipelines', {headers: headers()}).then(r => r.ok ? r.json() : null),
        fetch('/api/personas', {headers: headers()}).then(r => r.ok ? r.json() : null),
        fetch('/api/health', {headers: headers()}).then(r => r.ok ? r.json() : null),
      ]);

      if (status) {
        document.getElementById('uptime').textContent = 'v' + status.version + ' · up ' + fmt(status.uptime * 1000);
      }

      if (sessions) {
        var list = sessions.sessions || [];
        var running = list.filter(function(s){return s.status==='running';}).length;
        var waiting = list.filter(function(s){return s.status==='waiting';}).length;
        var stopped = list.filter(function(s){return s.status==='stopped';}).length;
        document.getElementById('s-running').textContent = running;
        document.getElementById('s-waiting').textContent = waiting;
        document.getElementById('s-stopped').textContent = stopped;
        document.getElementById('sessions-stat').innerHTML = '<span class="badge blue">' + list.length + ' total</span>';
        var active = list.filter(function(s){return s.status!=='stopped';}).slice(0,20);
        var stopped = list.filter(function(s){return s.status==='stopped';}).slice(0,10);
        var allShown = active.concat(stopped);
        setTbody('sessions-table', allShown.map(function(s) {
          var badge = s.status === 'running' ? 'green' : s.status === 'waiting' ? 'blue' : 'amber';
          var cost = s.cost != null ? '$' + s.cost.toFixed(3) : '—';
          var idle = s.idleSince ? fmt(Date.now() - new Date(s.idleSince).getTime()) : '—';
          var sid = escHtml(s.id);
          var sname = escHtml(s.name);
          var actions = '';
          if (s.status !== 'stopped') {
            actions += '<button class="act-btn red" onclick="stopSession(\'' + sid + '\',this)">Stop</button>';
            actions += '<button class="act-btn gray" onclick="whisperSession(\'' + sid + '\',this)">Whisper</button>';
          } else {
            actions += '<button class="act-btn red" onclick="removeSession(\'' + sid + '\',this)">Remove</button>';
          }
          var whisperRow = s.status !== 'stopped' ? '<tr id="wr-' + sid + '" style="display:none"><td colspan="5"><div class="whisper-row"><input id="wi-' + sid + '" placeholder="Message to send…" /><button class="act-btn blue" onclick="sendWhisper(\'' + sid + '\')">Send</button><button class="act-btn gray" onclick="cancelWhisper(\'' + sid + '\')">Cancel</button></div></td></tr>' : '';
          return '<tr><td class="name">' + sname + '</td><td><span class="badge ' + badge + '">' + s.status + '</span></td><td class="cost muted">' + cost + '</td><td class="muted">' + idle + '</td><td>' + actions + '</td></tr>' + whisperRow;
        }));
      }

      if (pipelines) {
        var plist = pipelines.pipelines || [];
        var enabled = plist.filter(function(p){return p.enabled;}).length;
        document.getElementById('pipelines-stat').innerHTML = '<span class="badge blue">' + enabled + ' enabled</span>';
        setTbody('pipelines-table', plist.slice(0,20).map(function(p) {
          var next = p.nextFireAt ? fmtDate(p.nextFireAt) : '—';
          var last = p.lastRunAt ? ('<span class="badge ' + (p.lastRunSuccess ? 'green' : 'red') + '">' + fmtDate(p.lastRunAt) + '</span>') : '<span class="muted">never</span>';
          var pname = escHtml(p.name);
          var penc = encodeURIComponent(p.name);
          var actions = '<button class="act-btn blue" onclick="triggerPipeline(\'' + pname + '\',\'' + penc + '\',this)">Trigger</button>';
          actions += '<button class="act-btn gray" onclick="toggleTriggerParams(\'' + penc + '\')">▾</button>';
          var paramsDiv = '<tr id="pp-' + penc + '" style="display:none"><td colspan="4"><div class="trigger-params">'
            + '<input id="pp-prompt-' + penc + '" placeholder="Prompt override (optional)" />'
            + '<select id="pp-model-' + penc + '"><option value="">Default model</option><option>claude-opus-4-7</option><option>claude-sonnet-4-6</option><option>claude-haiku-4-5-20251001</option></select>'
            + '<input id="pp-budget-' + penc + '" type="number" placeholder="Max budget USD" min="0.01" step="0.01" />'
            + '<button class="act-btn blue" onclick="triggerPipelineWithParams(\'' + pname + '\',\'' + penc + '\',this)">Trigger with params</button>'
            + '</div></td></tr>';
          return '<tr><td class="name">' + pname + '</td><td class="muted">' + next + '</td><td>' + last + '</td><td>' + actions + '</td></tr>' + paramsDiv;
        }));
      }

      if (personas) {
        var perlist = personas.personas || [];
        var active2 = perlist.filter(function(p){return p.enabled;}).length;
        document.getElementById('personas-stat').innerHTML = '<span class="badge blue">' + active2 + ' active</span>';
        setTbody('personas-table', perlist.slice(0,20).map(function(p) {
          var pid = escHtml(p.id);
          var actions = '<button class="act-btn blue" onclick="runPersona(\'' + pid + '\',this)">Run Now</button>';
          return '<tr><td class="name">' + pid + '</td><td class="muted">' + (p.runCount||0) + '</td><td class="muted">' + fmtDate(p.lastRunAt) + '</td><td>' + actions + '</td></tr>';
        }));
      }

      if (health) {
        var dot = document.getElementById('health-dot');
        dot.className = health.healthy ? '' : 'err';
        var checks = health.checks || [];
        setTbody('health-table', checks.map(function(c) {
          var badge = c.ok ? 'green' : 'red';
          return '<tr><td class="name">' + escHtml(c.name) + '</td><td><span class="badge ' + badge + '">' + (c.ok ? 'ok' : 'fail') + '</span></td></tr>';
        }));
      }

      document.getElementById('last-updated').textContent = 'Updated ' + new Date().toLocaleTimeString();
    } catch(e) { /* network error */ }
  }

  function escHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  function toast(msg, ok) {
    var t = document.createElement('div');
    t.className = 'toast ' + (ok ? 'ok' : 'err');
    t.textContent = msg;
    document.getElementById('toast-container').appendChild(t);
    setTimeout(function(){ t.style.opacity='0'; setTimeout(function(){ t.remove(); },300); }, 3000);
  }

  async function apiCall(method, path, body, btn) {
    if (btn) btn.disabled = true;
    try {
      var opts = { method: method, headers: Object.assign({'Content-Type':'application/json'}, headers()) };
      if (body) opts.body = JSON.stringify(body);
      var r = await fetch(path, opts);
      var ok = r.ok;
      var text = await r.text().catch(function(){return '';});
      var msg = ''; try { msg = JSON.parse(text).error || JSON.parse(text).message || ''; } catch(e) {}
      toast(ok ? 'Done' : (msg || 'Error ' + r.status), ok);
      if (ok) setTimeout(load, 800);
    } catch(e) { toast('Network error', false); }
    if (btn) btn.disabled = false;
  }

  function stopSession(id, btn) {
    if (!confirm('Stop session?')) return;
    apiCall('POST', '/api/sessions/' + id + '/stop', null, btn);
  }
  function removeSession(id, btn) {
    if (!confirm('Remove session?')) return;
    apiCall('DELETE', '/api/sessions/' + id, null, btn);
  }
  function whisperSession(id, btn) {
    var row = document.getElementById('wr-' + id);
    if (row) row.style.display = row.style.display === 'none' ? 'table-row' : 'none';
  }
  function sendWhisper(id) {
    var inp = document.getElementById('wi-' + id);
    var msg = inp ? inp.value.trim() : '';
    if (!msg) return;
    apiCall('POST', '/api/sessions/' + id + '/steer', { message: msg }, null);
    var row = document.getElementById('wr-' + id);
    if (row) row.style.display = 'none';
  }
  function cancelWhisper(id) {
    var row = document.getElementById('wr-' + id);
    if (row) row.style.display = 'none';
  }
  function triggerPipeline(name, enc, btn) {
    apiCall('POST', '/api/pipelines/' + encodeURIComponent(name) + '/trigger', {}, btn);
  }
  function toggleTriggerParams(enc) {
    var row = document.getElementById('pp-' + enc);
    if (row) row.style.display = row.style.display === 'none' ? 'table-row' : 'none';
  }
  function triggerPipelineWithParams(name, enc, btn) {
    var body = {};
    var p = document.getElementById('pp-prompt-' + enc); if (p && p.value) body.prompt = p.value;
    var m = document.getElementById('pp-model-' + enc); if (m && m.value) body.model = m.value;
    var b = document.getElementById('pp-budget-' + enc); if (b && b.value) body.maxBudget = parseFloat(b.value);
    apiCall('POST', '/api/pipelines/' + encodeURIComponent(name) + '/trigger', body, btn);
  }
  function runPersona(id, btn) {
    apiCall('POST', '/api/personas/' + encodeURIComponent(id) + '/trigger', {}, btn);
  }
  async function createSession() {
    var name = document.getElementById('ns-name').value.trim();
    if (!name) { toast('Name is required', false); return; }
    var body = { name: name };
    var d = document.getElementById('ns-dir').value.trim(); if (d) body.workingDirectory = d;
    var p = document.getElementById('ns-prompt').value.trim(); if (p) body.prompt = p;
    var mo = document.getElementById('ns-model').value; if (mo) body.model = mo;
    var pe = document.getElementById('ns-perm').value; if (pe) body.permissionMode = pe;
    await apiCall('POST', '/api/sessions', body, null);
    document.getElementById('new-session-form').style.display = 'none';
    ['ns-name','ns-dir','ns-prompt'].forEach(function(id){ var el=document.getElementById(id); if(el) el.value=''; });
  }

  document.getElementById('apply-btn').onclick = function() {
    token = document.getElementById('token-input').value.trim();
    sessionStorage.setItem('colony-dash-token', token);
    connectSSE();
    load();
  };

  var evtSrc = null;
  function connectSSE() {
    if (evtSrc) evtSrc.close();
    var sseUrl = '/api/events' + (token ? '?token=' + encodeURIComponent(token) : '');
    evtSrc = new EventSource(sseUrl);
    evtSrc.onmessage = function(e) {
      try {
        var evt = JSON.parse(e.data);
        var ch = evt.channel || '';
        if (ch === 'instance:exited' || ch === 'instance:started' || ch === 'pipeline:status' || ch.startsWith('persona:')) {
          load();
        }
      } catch(ex) {}
    };
    evtSrc.onerror = function() { /* will retry automatically */ };
  }

  // Initial load
  load();
  connectSSE();
  // Fallback polling every 30s in case SSE misses events
  setInterval(load, 30000);
})();
</script>
</body>
</html>`
}

async function handleApiRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = req.url || '/'
  const method = req.method || 'GET'
  const urlPath = url.split('?')[0]

  // GET /api/dashboard — serve before auth check (page prompts for token itself)
  if (method === 'GET' && urlPath === '/api/dashboard') {
    const html = buildDashboardHtml()
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html) })
    res.end(html)
    return
  }

  if (!await checkApiAuth(req)) {
    sendJson(res, 401, { error: 'Unauthorized' })
    return
  }

  // GET /api/events — SSE stream (also matches /api/events?token=xxx)
  if (method === 'GET' && (url === '/api/events' || url.startsWith('/api/events?'))) {
    if (_sseClients.size >= MAX_SSE_CLIENTS) {
      sendJson(res, 503, { error: 'Too many SSE connections' })
      return
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    res.write('data: {"channel":"connected"}\n\n')
    _sseClients.add(res)
    req.on('close', () => _sseClients.delete(res))
    return
  }

  // GET /api/status
  if (method === 'GET' && url === '/api/status') {
    sendJson(res, 200, { ok: true, version: app.getVersion(), uptime: Math.floor(process.uptime()) })
    return
  }

  // GET /api/sessions
  if (method === 'GET' && url === '/api/sessions') {
    const instances = await getAllInstances()
    const now = Date.now()
    const sessions = instances.map((i) => ({
      id: i.id,
      name: i.name,
      status: i.status,
      cost: i.tokenUsage.cost,
      uptime: i.createdAt ? now - new Date(i.createdAt).getTime() : 0,
    }))
    sendJson(res, 200, { sessions })
    return
  }

  // POST /api/sessions/:id/steer — must be checked before GET /api/sessions/:id
  const steerMatch = url.match(/^\/api\/sessions\/([^/?#]+)\/steer$/)
  if (method === 'POST' && steerMatch) {
    const idOrName = decodeURIComponent(steerMatch[1])
    let body: Buffer
    try {
      body = await readBody(req)
    } catch (err) {
      const status = (err as Error).message?.includes('maximum size') ? 413 : 400
      sendJson(res, status, { error: status === 413 ? 'Request body too large' : 'Failed to read request body' })
      return
    }
    let parsed: { prompt?: unknown } = {}
    try {
      parsed = JSON.parse(body.toString('utf8'))
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' })
      return
    }
    const prompt = parsed.prompt
    if (typeof prompt !== 'string' || !prompt.trim()) {
      sendJson(res, 400, { error: 'Missing required field: prompt' })
      return
    }
    const instances = await getAllInstances()
    const inst = instances.find((i) => i.id === idOrName || i.name === idOrName)
    if (!inst) {
      sendJson(res, 404, { error: 'Session not found' })
      return
    }
    const ok = await getDaemonRouter().steerInstance(inst.id, prompt)
    sendJson(res, ok ? 200 : 500, { ok })
    return
  }

  // GET /api/sessions/:id/stream — SSE stream of PTY output for a specific session
  const streamMatch = url.match(/^\/api\/sessions\/([^/?#]+)\/stream$/)
  if (method === 'GET' && streamMatch) {
    const idOrName = decodeURIComponent(streamMatch[1])
    const instances = await getAllInstances()
    const inst = instances.find((i) => i.id === idOrName || i.name === idOrName)
    if (!inst) {
      sendJson(res, 404, { error: 'Session not found' })
      return
    }
    const existing = _streamClients.get(inst.id)
    if (existing && existing.size >= MAX_STREAM_CLIENTS_PER_SESSION) {
      sendJson(res, 503, { error: 'Too many stream connections for this session' })
      return
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    // Send current buffer as initial burst
    let initialBuffer = ''
    try {
      initialBuffer = await getDaemonRouter().getInstanceBuffer(inst.id)
    } catch { /* no buffer — ok */ }
    const MAX_INITIAL_CHUNK = 65_536
    if (initialBuffer.length > 0) {
      let offset = 0
      while (offset < initialBuffer.length) {
        const chunk = initialBuffer.slice(offset, offset + MAX_INITIAL_CHUNK)
        res.write(`event: output\ndata: ${JSON.stringify({ text: chunk })}\n\n`)
        offset += MAX_INITIAL_CHUNK
      }
    }
    if (!_streamClients.has(inst.id)) _streamClients.set(inst.id, new Set())
    _streamClients.get(inst.id)!.add(res)
    // Keepalive ping every 30s
    const keepalive = setInterval(() => {
      try { res.write(': ping\n\n') } catch { clearInterval(keepalive) }
    }, 30_000)
    req.on('close', () => {
      clearInterval(keepalive)
      const set = _streamClients.get(inst.id)
      if (set) {
        set.delete(res)
        if (set.size === 0) _streamClients.delete(inst.id)
      }
    })
    return
  }

  // GET /api/sessions/:id
  const sessionMatch = url.match(/^\/api\/sessions\/([^/?#]+)$/)
  if (method === 'GET' && sessionMatch) {
    const idOrName = decodeURIComponent(sessionMatch[1])
    const instances = await getAllInstances()
    const inst = instances.find((i) => i.id === idOrName || i.name === idOrName)
    if (!inst) {
      sendJson(res, 404, { error: 'Session not found' })
      return
    }
    sendJson(res, 200, { session: inst })
    return
  }

  // GET /api/pipelines
  if (method === 'GET' && url === '/api/pipelines') {
    const pipelines = getPipelineList()
    sendJson(res, 200, { pipelines })
    return
  }

  // POST /api/pipelines/validate — exact match, must be before /:name/ routes
  if (method === 'POST' && url === '/api/pipelines/validate') {
    let body: Buffer
    try { body = await readBody(req) } catch { sendJson(res, 400, { error: 'Failed to read body' }); return }
    let yaml: string
    try {
      const parsed = JSON.parse(body.toString('utf8')) as Record<string, unknown>
      if (typeof parsed.yaml !== 'string') { sendJson(res, 400, { error: 'Body must be { yaml: string }' }); return }
      yaml = parsed.yaml
    } catch { sendJson(res, 400, { error: 'Invalid JSON body' }); return }
    const result = validatePipelineYaml(yaml)
    if (result.valid) {
      const def = result.def!
      sendJson(res, 200, {
        valid: true,
        pipeline: { name: def.name, trigger: { type: def.trigger.type }, actionType: def.action?.type ?? 'launch-session' },
        warnings: result.warnings,
      })
    } else {
      sendJson(res, 200, { valid: false, errors: result.errors, warnings: result.warnings, pipeline: null })
    }
    return
  }

  // GET /api/pipelines/:name/preview — before /trigger to avoid regex shadowing
  const previewMatch = url.match(/^\/api\/pipelines\/([^/?#]+)\/preview$/)
  if (method === 'GET' && previewMatch) {
    const name = decodeURIComponent(previewMatch[1])
    const pipelines = getPipelineList()
    if (!pipelines.find((p) => p.name === name)) {
      sendJson(res, 404, { error: `Pipeline not found: ${name}` })
      return
    }
    try {
      const result = await previewPipeline(name)
      sendJson(res, 200, { pipeline: name, ...result })
    } catch (err) {
      sendJson(res, 500, { error: `Preview failed: ${String(err)}` })
    }
    return
  }

  // POST /api/pipelines/:name/trigger
  const pipelineMatch = url.match(/^\/api\/pipelines\/([^/?#]+)\/trigger$/)
  if (method === 'POST' && pipelineMatch) {
    const name = decodeURIComponent(pipelineMatch[1])
    let overrides: import('./pipeline-engine').RunOverrides | undefined
    try {
      const body = await readBody(req)
      if (body.length > 0) {
        const parsed = JSON.parse(body.toString('utf8')) as Record<string, unknown>
        overrides = {}
        if (typeof parsed.prompt === 'string') overrides.prompt = parsed.prompt
        if (typeof parsed.model === 'string') overrides.model = parsed.model
        if (typeof parsed.workingDirectory === 'string') overrides.workingDirectory = parsed.workingDirectory
        if (typeof parsed.maxBudget === 'number') {
          overrides.maxBudget = Math.min(100, Math.max(0.01, parsed.maxBudget))
        }
        if (parsed.preset !== undefined) {
          if (typeof parsed.preset !== 'string') {
            sendJson(res, 400, { error: 'preset must be a string (preset name)' })
            return
          }
          const presets = getPresets(name)
          const found = presets.find(p => p.name === parsed.preset)
          if (!found) {
            sendJson(res, 404, { error: `Preset not found: ${parsed.preset}` })
            return
          }
          overrides.templateVarOverrides = { ...found.vars }
        }
        if (parsed.vars !== undefined) {
          if (typeof parsed.vars !== 'object' || parsed.vars === null || Array.isArray(parsed.vars)) {
            sendJson(res, 400, { error: 'vars must be an object with string values' })
            return
          }
          const vars = parsed.vars as Record<string, unknown>
          for (const [k, v] of Object.entries(vars)) {
            if (typeof v !== 'string') {
              sendJson(res, 400, { error: `vars.${k} must be a string` })
              return
            }
          }
          overrides.templateVarOverrides = { ...(overrides.templateVarOverrides ?? {}), ...vars as Record<string, string> }
        }
        if (Object.keys(overrides).length === 0) overrides = undefined
      }
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' })
      return
    }
    const ok = overrides ? triggerPollNow(name, overrides) : triggerPollNow(name)
    if (!ok) {
      sendJson(res, 404, { error: `Pipeline not found: ${name}` })
      return
    }
    sendJson(res, 200, { ok: true, pipeline: name, overrides: overrides ?? {} })
    return
  }

  // GET /api/personas
  if (method === 'GET' && url === '/api/personas') {
    const personas = getPersonaList().map((p) => ({
      id: p.id,
      name: p.name,
      enabled: p.enabled,
      model: p.model,
      schedule: p.schedule,
      lastRun: p.lastRun,
      runCount: p.runCount,
      active: p.activeSessionId !== null,
    }))
    sendJson(res, 200, { personas })
    return
  }

  // POST /api/personas/:id/trigger
  const personaTriggerMatch = url.match(/^\/api\/personas\/([^/?#]+)\/trigger$/)
  if (method === 'POST' && personaTriggerMatch) {
    const idOrName = decodeURIComponent(personaTriggerMatch[1])
    const personas = getPersonaList()
    const persona = personas.find((p) => p.id === idOrName || p.name === idOrName)
    if (!persona) {
      sendJson(res, 404, { error: `Persona not found: ${idOrName}` })
      return
    }
    let message: string | undefined
    try {
      const body = await readBody(req)
      if (body.length > 0) {
        const parsed = JSON.parse(body.toString('utf8')) as { message?: unknown }
        if (typeof parsed.message === 'string') message = parsed.message
      }
    } catch { /* empty body or non-JSON — run without message */ }
    runPersona(persona.id, { type: 'manual' }, message).catch((err) => {
      log(`runPersona(${persona.id}) failed: ${err}`)
    })
    sendJson(res, 202, { ok: true, persona: persona.id })
    return
  }

  // POST /api/sessions — create a new session
  if (method === 'POST' && url === '/api/sessions') {
    const now = Date.now()
    _sessionCreateTimestamps.splice(0, _sessionCreateTimestamps.length,
      ..._sessionCreateTimestamps.filter(t => now - t < SESSION_CREATE_WINDOW_MS))
    if (_sessionCreateTimestamps.length >= SESSION_CREATE_RATE_LIMIT) {
      sendJson(res, 429, { error: 'Rate limit exceeded: max 5 sessions per minute' })
      return
    }
    let body: Buffer
    try {
      body = await readBody(req)
    } catch (err) {
      const status = (err as Error).message?.includes('maximum size') ? 413 : 400
      sendJson(res, status, { error: status === 413 ? 'Request body too large' : 'Failed to read request body' })
      return
    }
    let parsed: { prompt?: unknown; model?: unknown; permissionMode?: unknown; workingDirectory?: unknown; name?: unknown } = {}
    try {
      if (body.length > 0) parsed = JSON.parse(body.toString('utf8'))
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' })
      return
    }
    const prompt = typeof parsed.prompt === 'string' ? parsed.prompt.trim() : undefined
    const model = typeof parsed.model === 'string' ? parsed.model : undefined
    const permissionMode = typeof parsed.permissionMode === 'string' ? parsed.permissionMode as 'autonomous' | 'auto' | 'supervised' : undefined
    const workingDirectory = typeof parsed.workingDirectory === 'string' ? parsed.workingDirectory : undefined
    const name = typeof parsed.name === 'string' ? parsed.name : undefined
    let inst
    try {
      const opts: Parameters<typeof createInstance>[0] = { name, model, permissionMode, workingDirectory }
      if (prompt) opts.args = ['-p', prompt]
      inst = await createInstance(opts)
    } catch (err) {
      sendJson(res, 400, { error: (err as Error).message || 'Failed to create session' })
      return
    }
    _sessionCreateTimestamps.push(now)
    sendJson(res, 201, { id: inst.id, name: inst.name })
    return
  }

  // POST /api/sessions/:id/stop — stop a running session
  const stopMatch = url.match(/^\/api\/sessions\/([^/?#]+)\/stop$/)
  if (method === 'POST' && stopMatch) {
    const idOrName = decodeURIComponent(stopMatch[1])
    const instances = await getAllInstances()
    const inst = instances.find((i) => i.id === idOrName || i.name === idOrName)
    if (!inst) {
      sendJson(res, 404, { error: 'Session not found' })
      return
    }
    await killInstance(inst.id)
    sendJson(res, 200, { ok: true })
    return
  }

  // GET /api/sessions/:id/output — return PTY buffer content (last 100KB)
  const outputMatch = url.match(/^\/api\/sessions\/([^/?#]+)\/output$/)
  if (method === 'GET' && outputMatch) {
    const idOrName = decodeURIComponent(outputMatch[1])
    const instances = await getAllInstances()
    const inst = instances.find((i) => i.id === idOrName || i.name === idOrName)
    if (!inst) {
      sendJson(res, 404, { error: 'Session not found' })
      return
    }
    let output = ''
    try {
      output = await getDaemonRouter().getInstanceBuffer(inst.id)
    } catch { /* return empty if buffer unavailable */ }
    const MAX_OUTPUT_BYTES = 100_000
    if (Buffer.byteLength(output) > MAX_OUTPUT_BYTES) {
      output = output.slice(-MAX_OUTPUT_BYTES)
    }
    sendJson(res, 200, { output })
    return
  }

  // DELETE /api/sessions/:id — remove a stopped session
  const deleteSessionMatch = url.match(/^\/api\/sessions\/([^/?#]+)$/)
  if (method === 'DELETE' && deleteSessionMatch) {
    const idOrName = decodeURIComponent(deleteSessionMatch[1])
    const instances = await getAllInstances()
    const inst = instances.find((i) => i.id === idOrName || i.name === idOrName)
    if (!inst) {
      sendJson(res, 404, { error: 'Session not found' })
      return
    }
    if (inst.status === 'running') {
      sendJson(res, 409, { error: 'Session is still running — stop it first' })
      return
    }
    try {
      await getDaemonRouter().removeInstance(inst.id)
    } catch (err) {
      sendJson(res, 500, { error: (err as Error).message || 'Failed to remove session' })
      return
    }
    sendJson(res, 200, { ok: true })
    return
  }

  // POST /api/sessions/:id/whisper — alias for steer; also writes to persona Notes if session is a persona
  const whisperMatch = url.match(/^\/api\/sessions\/([^/?#]+)\/whisper$/)
  if (method === 'POST' && whisperMatch) {
    const idOrName = decodeURIComponent(whisperMatch[1])
    let body: Buffer
    try {
      body = await readBody(req)
    } catch (err) {
      const status = (err as Error).message?.includes('maximum size') ? 413 : 400
      sendJson(res, status, { error: status === 413 ? 'Request body too large' : 'Failed to read request body' })
      return
    }
    let parsed: { prompt?: unknown } = {}
    try {
      parsed = JSON.parse(body.toString('utf8'))
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' })
      return
    }
    const prompt = parsed.prompt
    if (typeof prompt !== 'string' || !prompt.trim()) {
      sendJson(res, 400, { error: 'Missing required field: prompt' })
      return
    }
    const instances = await getAllInstances()
    const inst = instances.find((i) => i.id === idOrName || i.name === idOrName)
    if (!inst) {
      sendJson(res, 404, { error: 'Session not found' })
      return
    }
    const ok = await getDaemonRouter().steerInstance(inst.id, prompt)
    sendJson(res, ok ? 200 : 500, { ok })
    return
  }

  // GET /api/pipelines/:name/runs/latest — must match before bare /runs
  const runsLatestMatch = url.match(/^\/api\/pipelines\/([^/?#]+)\/runs\/latest$/)
  if (method === 'GET' && runsLatestMatch) {
    const name = decodeURIComponent(runsLatestMatch[1])
    const pipelines = getPipelineList()
    if (!pipelines.find((p) => p.name === name)) {
      sendJson(res, 404, { error: `Pipeline not found: ${name}` })
      return
    }
    const history = await getHistory(name)
    if (history.length === 0) {
      sendJson(res, 404, { error: 'No runs recorded for this pipeline' })
      return
    }
    sendJson(res, 200, { pipeline: name, run: history[history.length - 1] })
    return
  }

  // GET /api/pipelines/:name/runs
  const runsMatch = url.match(/^\/api\/pipelines\/([^/?#]+)\/runs(?:\?.*)?$/)
  if (method === 'GET' && runsMatch) {
    const name = decodeURIComponent(runsMatch[1])
    const pipelines = getPipelineList()
    if (!pipelines.find((p) => p.name === name)) {
      sendJson(res, 404, { error: `Pipeline not found: ${name}` })
      return
    }
    const history = await getHistory(name)
    const reversed = [...history].reverse()
    const limitParam = new URL(`http://x${url}`).searchParams.get('limit')
    const limit = limitParam ? Math.min(20, Math.max(1, parseInt(limitParam, 10) || 20)) : reversed.length
    sendJson(res, 200, { pipeline: name, runs: reversed.slice(0, limit) })
    return
  }

  // GET /api/health
  if (method === 'GET' && url === '/api/health') {
    const instances = await getAllInstances()
    const running = instances.filter((i) => i.status === 'running').length
    const stopped = instances.filter((i) => i.status === 'exited').length
    const errored = 0 // exitCode not exposed on InstanceInfo; derive from history if needed

    const personaList = getPersonaList()
    const personaDetails = personaList.map((p) => ({
      id: p.id,
      name: p.name,
      enabled: p.enabled,
      active: p.activeSessionId !== null,
      lastRun: p.lastRun ?? null,
      runCount: p.runCount,
      consecutiveFailures: p.healthScore?.consecutiveFailures ?? 0,
    }))

    const pipelineList = getPipelineList()
    const pipelineDetails = await Promise.all(pipelineList.map(async (pl) => {
      let lastSuccess: boolean | null = null
      try {
        const hist = await getHistory(pl.name)
        if (hist.length > 0) lastSuccess = hist[hist.length - 1].success
      } catch { /* ignore */ }
      return {
        name: pl.name,
        enabled: pl.enabled,
        lastFired: pl.lastFiredAt ?? null,
        fireCount: pl.fireCount,
        lastSuccess,
      }
    }))

    // Compute overall status
    const maxConsecutiveFailures = personaDetails
      .filter((p) => p.enabled)
      .reduce((max, p) => Math.max(max, p.consecutiveFailures), 0)
    let status: 'healthy' | 'degraded' | 'unhealthy'
    if (maxConsecutiveFailures >= 3) {
      status = 'unhealthy'
    } else if (maxConsecutiveFailures >= 1) {
      status = 'degraded'
    } else {
      status = 'healthy'
    }

    const body = {
      status,
      uptime_seconds: Math.floor((Date.now() - serverStartMs) / 1000),
      sessions: { running, stopped, errored },
      personas: { total: personaList.length, enabled: personaList.filter((p) => p.enabled).length, active: personaList.filter((p) => p.activeSessionId !== null).length, details: personaDetails },
      pipelines: { total: pipelineList.length, enabled: pipelineList.filter((p) => p.enabled).length, details: pipelineDetails },
      version: app.getVersion(),
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=10', 'Access-Control-Allow-Origin': '*' })
    res.end(JSON.stringify(body))
    return
  }

  // GET /api/openapi.json — OpenAPI 3.0 spec (update this when adding new endpoints)
  if (method === 'GET' && url === '/api/openapi.json') {
    const port = serverUrl ? new URL(serverUrl).port : '7474'
    const spec = {
      openapi: '3.0.3',
      info: { title: 'Colony API', version: app.getVersion(), description: 'REST API for Colony session, pipeline, and persona management.' },
      servers: [
        { url: `http://127.0.0.1:${port}`, description: 'Local Colony server' },
        { url: `http://0.0.0.0:${port}`, description: 'All interfaces' },
      ],
      components: {
        securitySchemes: {
          BearerToken: { type: 'http', scheme: 'bearer', description: 'API token configured in Colony Settings → Webhook & API' },
          ColonyToken: { type: 'apiKey', in: 'header', name: 'X-Colony-Token' },
        },
        schemas: {
          Session: {
            type: 'object',
            properties: {
              id: { type: 'string' }, name: { type: 'string' },
              status: { type: 'string', enum: ['running', 'waiting', 'stopped'] },
              cost: { type: 'number' }, uptime: { type: 'number', description: 'Milliseconds since session start' },
            },
          },
          Pipeline: {
            type: 'object',
            properties: {
              name: { type: 'string' }, enabled: { type: 'boolean' },
              schedule: { type: 'string' }, lastFired: { type: 'string', nullable: true },
            },
          },
          Persona: {
            type: 'object',
            properties: {
              id: { type: 'string' }, name: { type: 'string' }, enabled: { type: 'boolean' },
              model: { type: 'string' }, schedule: { type: 'string', nullable: true },
              lastRun: { type: 'string', nullable: true }, runCount: { type: 'number' }, active: { type: 'boolean' },
            },
          },
          Error: { type: 'object', properties: { error: { type: 'string' } } },
          WebhookDeliveryResult: {
            type: 'object',
            properties: {
              url: { type: 'string' },
              status: { type: 'string', enum: ['success', 'error', 'timeout'] },
              httpStatus: { type: 'number', nullable: true },
              error: { type: 'string', nullable: true },
              attemptMs: { type: 'number' },
              attempt: { type: 'number', description: '1-based attempt number' },
            },
          },
          PipelineRunEntry: {
            type: 'object',
            properties: {
              ts: { type: 'string', description: 'ISO timestamp of run' },
              trigger: { type: 'string' },
              actionExecuted: { type: 'boolean' },
              success: { type: 'boolean' },
              durationMs: { type: 'number' },
              totalCost: { type: 'number', nullable: true },
              sessionIds: { type: 'array', items: { type: 'string' } },
              webhookFired: { type: 'boolean' },
              webhookDeliveries: { type: 'array', items: { $ref: '#/components/schemas/WebhookDeliveryResult' }, nullable: true },
              triggerContext: { type: 'object', properties: { githubEvent: { type: 'string' }, githubAction: { type: 'string' } } },
              diffStats: { type: 'object', nullable: true, description: 'Git diff stats across all sessions in this run', properties: { filesChanged: { type: 'number' }, insertions: { type: 'number' }, deletions: { type: 'number' } } },
            },
          },
          HealthReport: {
            type: 'object',
            properties: {
              status: { type: 'string', enum: ['healthy', 'degraded', 'unhealthy'] },
              uptime_seconds: { type: 'number' },
              sessions: { type: 'object', properties: { running: { type: 'number' }, stopped: { type: 'number' }, errored: { type: 'number' } } },
              personas: { type: 'object', properties: { total: { type: 'number' }, enabled: { type: 'number' }, active: { type: 'number' }, details: { type: 'array', items: { type: 'object' } } } },
              pipelines: { type: 'object', properties: { total: { type: 'number' }, enabled: { type: 'number' }, details: { type: 'array', items: { type: 'object' } } } },
              version: { type: 'string' },
            },
          },
        },
      },
      security: [{ BearerToken: [] }, { ColonyToken: [] }],
      paths: {
        '/api/status': {
          get: {
            summary: 'Health check', operationId: 'getStatus', tags: ['System'],
            responses: { '200': { description: 'OK', content: { 'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean' }, version: { type: 'string' }, uptime: { type: 'number' } } } } } } },
          },
        },
        '/api/openapi.json': {
          get: { summary: 'OpenAPI spec', operationId: 'getOpenApiSpec', tags: ['System'], responses: { '200': { description: 'OpenAPI 3.0 JSON spec' } } },
        },
        '/api/docs': {
          get: { summary: 'Interactive API docs (Swagger UI)', operationId: 'getDocs', tags: ['System'], responses: { '200': { description: 'HTML page' } } },
        },
        '/api/dashboard': {
          get: { summary: 'Web status dashboard', operationId: 'getDashboard', tags: ['System'], description: 'Self-contained HTML dashboard. No auth required for the page — prompts for token inline. Auto-refreshes via SSE.', responses: { '200': { description: 'HTML dashboard page', content: { 'text/html': {} } } } },
        },
        '/api/events': {
          get: {
            summary: 'Global SSE event stream', operationId: 'getEvents', tags: ['Events'],
            description: 'Server-Sent Events stream. Each event is a JSON object: `{ channel: string, data: any }`. Max 5 concurrent connections.',
            responses: {
              '200': { description: 'SSE stream', content: { 'text/event-stream': { schema: { type: 'string', example: 'data: {"channel":"instance:output","data":{"id":"abc","data":"hello"}}\n\n' } } } },
              '503': { description: 'Too many connections', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
            },
          },
        },
        '/api/sessions': {
          get: {
            summary: 'List sessions', operationId: 'listSessions', tags: ['Sessions'],
            responses: { '200': { description: 'Session list', content: { 'application/json': { schema: { type: 'object', properties: { sessions: { type: 'array', items: { $ref: '#/components/schemas/Session' } } } } } } } },
          },
          post: {
            summary: 'Create session', operationId: 'createSession', tags: ['Sessions'],
            description: 'Rate limited to 5 per minute.',
            requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { prompt: { type: 'string', description: 'Prompt to run with -p flag' }, model: { type: 'string' }, permissionMode: { type: 'string', enum: ['autonomous', 'auto', 'supervised'] }, workingDirectory: { type: 'string' }, name: { type: 'string' } } } } } },
            responses: {
              '201': { description: 'Created', content: { 'application/json': { schema: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } } } } } },
              '429': { description: 'Rate limit exceeded' },
            },
          },
        },
        '/api/sessions/{id}': {
          get: {
            summary: 'Get session', operationId: 'getSession', tags: ['Sessions'],
            parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'Session ID or name' }],
            responses: { '200': { description: 'Session detail' }, '404': { description: 'Not found' } },
          },
          delete: {
            summary: 'Delete stopped session', operationId: 'deleteSession', tags: ['Sessions'],
            parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
            responses: { '200': { description: 'Deleted' }, '409': { description: 'Session still running' } },
          },
        },
        '/api/sessions/{id}/stop': {
          post: {
            summary: 'Stop session', operationId: 'stopSession', tags: ['Sessions'],
            parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
            responses: { '200': { description: 'Stopped' } },
          },
        },
        '/api/sessions/{id}/steer': {
          post: {
            summary: 'Send prompt to session (steer)', operationId: 'steerSession', tags: ['Sessions'],
            parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
            requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['prompt'], properties: { prompt: { type: 'string' } } } } } },
            responses: { '200': { description: 'OK' } },
          },
        },
        '/api/sessions/{id}/whisper': {
          post: {
            summary: 'Whisper to session (alias for steer)', operationId: 'whisperSession', tags: ['Sessions'],
            parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
            requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['prompt'], properties: { prompt: { type: 'string' } } } } } },
            responses: { '200': { description: 'OK' } },
          },
        },
        '/api/sessions/{id}/output': {
          get: {
            summary: 'Get session PTY output (last 100KB)', operationId: 'getSessionOutput', tags: ['Sessions'],
            parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
            responses: { '200': { description: 'Output buffer', content: { 'application/json': { schema: { type: 'object', properties: { output: { type: 'string' } } } } } } },
          },
        },
        '/api/sessions/{id}/stream': {
          get: {
            summary: 'Stream session output (SSE)', operationId: 'streamSession', tags: ['Sessions'],
            description: 'Server-Sent Events. Events: `output` (text chunks), `exit` (session ended). Sends buffered output on connect. Max 5 connections per session.',
            parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
            responses: { '200': { description: 'SSE stream', content: { 'text/event-stream': { schema: { type: 'string', example: 'event: output\ndata: {"text":"hello"}\n\nevent: exit\ndata: {"code":0}\n\n' } } } } },
          },
        },
        '/api/pipelines': {
          get: {
            summary: 'List pipelines', operationId: 'listPipelines', tags: ['Pipelines'],
            responses: { '200': { description: 'Pipeline list', content: { 'application/json': { schema: { type: 'object', properties: { pipelines: { type: 'array', items: { $ref: '#/components/schemas/Pipeline' } } } } } } } },
          },
        },
        '/api/pipelines/validate': {
          post: {
            summary: 'Validate pipeline YAML', operationId: 'validatePipelineYaml', tags: ['Pipelines'],
            description: 'Validate pipeline YAML structure. Returns structured errors and warnings without writing to disk.',
            requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['yaml'], properties: { yaml: { type: 'string', description: 'Pipeline YAML content to validate' } } } } } },
            responses: {
              '200': {
                description: 'Validation result (HTTP 200 for both valid and invalid YAML)',
                content: { 'application/json': { schema: { type: 'object', properties: {
                  valid: { type: 'boolean' },
                  pipeline: { type: 'object', nullable: true, properties: { name: { type: 'string' }, trigger: { type: 'object' }, actionType: { type: 'string' } } },
                  errors: { type: 'array', items: { type: 'string' } },
                  warnings: { type: 'array', items: { type: 'string' } },
                } } } },
              },
            },
          },
        },
        '/api/pipelines/{name}/preview': {
          get: {
            summary: 'Preview pipeline (dry-run)', operationId: 'previewPipeline', tags: ['Pipelines'],
            description: 'Evaluate a pipeline\'s trigger and conditions without firing. May make GitHub API calls for git-poll triggers.',
            parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }],
            responses: {
              '200': { description: 'Preview result', content: { 'application/json': { schema: { type: 'object', properties: {
                pipeline: { type: 'string' },
                wouldFire: { type: 'boolean' },
                matches: { type: 'array', items: { type: 'object', properties: { description: { type: 'string' }, resolvedVars: { type: 'object' }, wouldBeDeduped: { type: 'boolean' } } } },
                conditionLog: { type: 'array', items: { type: 'string' } },
              } } } } },
              '404': { description: 'Pipeline not found' },
            },
          },
        },
        '/api/pipelines/{name}/trigger': {
          post: {
            summary: 'Trigger pipeline', operationId: 'triggerPipeline', tags: ['Pipelines'],
            parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }],
            requestBody: {
              description: 'All fields optional. Empty body triggers with defaults.',
              content: { 'application/json': { schema: { type: 'object', properties: {
                prompt: { type: 'string', description: 'Override the pipeline action prompt' },
                model: { type: 'string', description: 'Override the model (e.g. claude-opus-4-7)' },
                workingDirectory: { type: 'string', description: 'Override the working directory' },
                maxBudget: { type: 'number', description: 'Override max budget in USD (clamped 0.01–100)' },
                vars: { type: 'object', additionalProperties: { type: 'string' }, description: 'Template variable overrides for {{varName}} placeholders in pipeline YAML' },
              } } } },
            },
            responses: {
              '200': { description: 'Triggered', content: { 'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean' }, pipeline: { type: 'string' }, overrides: { type: 'object' } } } } } },
              '404': { description: 'Pipeline not found' },
            },
          },
        },
        '/api/pipelines/{name}/runs': {
          get: {
            summary: 'Get pipeline run history', operationId: 'getPipelineRuns', tags: ['Pipelines'],
            parameters: [
              { name: 'name', in: 'path', required: true, schema: { type: 'string' } },
              { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 20 }, description: 'Max number of runs to return (default: all, max: 20)' },
            ],
            responses: {
              '200': { description: 'Run history (newest first)', content: { 'application/json': { schema: { type: 'object', properties: { pipeline: { type: 'string' }, runs: { type: 'array', items: { $ref: '#/components/schemas/PipelineRunEntry' } } } } } } },
              '404': { description: 'Pipeline not found' },
            },
          },
        },
        '/api/pipelines/{name}/runs/latest': {
          get: {
            summary: 'Get most recent pipeline run', operationId: 'getLatestPipelineRun', tags: ['Pipelines'],
            parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }],
            responses: {
              '200': { description: 'Most recent run entry', content: { 'application/json': { schema: { type: 'object', properties: { pipeline: { type: 'string' }, run: { $ref: '#/components/schemas/PipelineRunEntry' } } } } } },
              '404': { description: 'Pipeline not found or no runs recorded' },
            },
          },
        },
        '/api/health': {
          get: {
            summary: 'Colony fleet health', operationId: 'getHealth', tags: ['System'],
            description: 'Comprehensive health report: session counts, persona health, pipeline status. Cached for 10 seconds.',
            responses: {
              '200': {
                description: 'Health report',
                headers: { 'Cache-Control': { schema: { type: 'string' }, description: 'max-age=10' } },
                content: { 'application/json': { schema: { $ref: '#/components/schemas/HealthReport' } } },
              },
            },
          },
        },
        '/api/personas': {
          get: {
            summary: 'List personas', operationId: 'listPersonas', tags: ['Personas'],
            responses: { '200': { description: 'Persona list', content: { 'application/json': { schema: { type: 'object', properties: { personas: { type: 'array', items: { $ref: '#/components/schemas/Persona' } } } } } } } },
          },
        },
        '/api/personas/{id}/trigger': {
          post: {
            summary: 'Trigger persona', operationId: 'triggerPersona', tags: ['Personas'],
            parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
            requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { message: { type: 'string', description: 'Optional whisper message to inject' } } } } } },
            responses: { '202': { description: 'Accepted (runs async)' }, '404': { description: 'Persona not found' } },
          },
        },
      },
    }
    const payload = JSON.stringify(spec, null, 2)
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'Access-Control-Allow-Origin': '*' })
    res.end(payload)
    return
  }

  // GET /api/docs — Swagger UI interactive docs
  if (method === 'GET' && url === '/api/docs') {
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Colony API Docs</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css">
<style>
  body { margin: 0; }
  #auth-bar { padding: 10px 20px; background: #1a1a2e; display: flex; align-items: center; gap: 10px; }
  #auth-bar label { color: #ccc; font: 13px monospace; }
  #token-input { flex: 1; max-width: 400px; padding: 6px 10px; border: 1px solid #444; border-radius: 4px; background: #0d0d1a; color: #fff; font: 13px monospace; }
  #apply-btn { padding: 6px 14px; background: #4CAF50; color: #fff; border: none; border-radius: 4px; cursor: pointer; font-size: 13px; }
</style>
</head>
<body>
<div id="auth-bar">
  <label>API Token:</label>
  <input id="token-input" type="password" placeholder="Leave empty if no auth configured" />
  <button id="apply-btn">Apply</button>
</div>
<div id="swagger-ui"></div>
<script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
<script>
  const ui = SwaggerUIBundle({
    url: '/api/openapi.json',
    dom_id: '#swagger-ui',
    presets: [SwaggerUIBundle.presets.apis, SwaggerUIBundle.SwaggerUIStandalonePreset],
    layout: 'BaseLayout',
    requestInterceptor(req) {
      const token = document.getElementById('token-input').value.trim();
      if (token) req.headers['Authorization'] = 'Bearer ' + token;
      return req;
    }
  });
  document.getElementById('apply-btn').onclick = () => ui.authActions.logout([]);
</script>
</body>
</html>`
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html) })
    res.end(html)
    return
  }

  sendJson(res, 404, { error: 'Not Found' })
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = req.url || '/'
  log(`${req.method} ${url}`)

  // Route /api/* to the REST API handler
  if (url.startsWith('/api/')) {
    await handleApiRequest(req, res)
    return
  }

  // Only handle POST /webhook/<slug>
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method Not Allowed' })
    return
  }

  const match = url.match(/^\/webhook\/([^/?#]+)/)
  if (!match) {
    sendJson(res, 404, { error: 'Not Found' })
    return
  }

  const slug = match[1]

  // Find the matching webhook trigger
  const triggers = getWebhookTriggers()
  const triggerEntry = triggers.find((t) => t.slug === slug)

  if (!triggerEntry) {
    log(`Unknown slug: ${slug}`)
    sendJson(res, 404, { error: `No webhook pipeline found for slug: ${slug}` })
    return
  }

  const { trigger } = triggerEntry
  const secret = trigger.secret || ''
  const source = trigger.source || 'generic'

  // Read raw body BEFORE signature verification
  let body: Buffer
  try {
    body = await readBody(req)
  } catch (err) {
    const status = (err as Error).message?.includes('maximum size') ? 413 : 400
    log(`Failed to read body: ${err}`)
    sendJson(res, status, { error: status === 413 ? 'Request body too large' : 'Failed to read request body' })
    return
  }

  // Verify signature / token
  let verified = false
  if (source === 'github') {
    const sigHeader = req.headers['x-hub-signature-256'] as string | undefined
    verified = verifyGitHubSignature(secret, body, sigHeader)
    if (!verified) {
      log(`GitHub signature verification failed for ${slug}`)
      sendJson(res, 400, { error: 'Invalid signature' })
      return
    }
  } else {
    // generic: bearer or x-colony-token
    if (secret) {
      verified = verifyGenericToken(secret, req)
      if (!verified) {
        log(`Generic token verification failed for ${slug}`)
        sendJson(res, 400, { error: 'Invalid token' })
        return
      }
    } else {
      // No secret configured — allow all (warn)
      verified = true
      log(`Warning: no secret configured for ${slug} — allowing unauthenticated request`)
    }
  }

  // Parse payload
  let payload: unknown = null
  try {
    const bodyStr = body.toString('utf8')
    if (bodyStr.trim()) {
      payload = JSON.parse(bodyStr)
    }
  } catch {
    // Non-JSON body — pass as raw string
    payload = body.toString('utf8')
  }

  // Extract GitHub enrichment vars when source is GitHub
  let overrides: import('./pipeline-engine').RunOverrides | undefined
  if (source === 'github') {
    const eventType = (req.headers['x-github-event'] as string | undefined) || ''
    const vars = extractGitHubVars(eventType, payload)
    if (Object.keys(vars).length > 0) {
      overrides = { templateVarOverrides: vars }
    }
  }

  // Fire the pipeline — pass slug (not name) to satisfy fireWebhookPipeline's slug lookup
  const result = fireWebhookPipeline(slug, payload, overrides)
  if (result.ok) {
    log(`Fired pipeline: ${triggerEntry.name}`)
    sendJson(res, 200, { ok: true, pipeline: triggerEntry.name })
  } else {
    log(`Failed to fire pipeline: ${triggerEntry.name}: ${result.error}`)
    sendJson(res, 400, { ok: false, error: result.error })
  }
}

export function startWebhookServer(port: number): void {
  if (server) {
    log('Server already running')
    return
  }

  server = createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      log(`Unhandled error: ${err}`)
      try {
        sendJson(res, 500, { error: 'Internal Server Error' })
      } catch { /* response already sent */ }
    })
  })

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      log(`Port ${port} already in use — webhook server NOT started. Use a different port in Settings.`)
    } else {
      log(`Server error: ${err.message}`)
    }
    server = null
    serverUrl = null
  })

  server.listen(port, '127.0.0.1', () => {
    serverUrl = `http://127.0.0.1:${port}`
    log(`Listening at ${serverUrl}`)
  })
}

export function stopWebhookServer(): void {
  if (!server) return
  server.close(() => {
    log('Server stopped')
  })
  server = null
  serverUrl = null
}

/** Returns the current server URL if running, or null. */
export function getWebhookServerUrl(): string | null {
  return serverUrl
}
