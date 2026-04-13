/**
 * Debug MCP Server — exposes DAP debugging tools via MCP (Model Context Protocol).
 *
 * Standalone Node.js process launched by Claude CLI as an MCP server.
 * Communicates with Claude via JSON-RPC 2.0 over stdio (NDJSON).
 * Connects to debug adapters (Node Inspector / debugpy) via DAP over TCP.
 *
 * Usage: node debug-mcp-server.js --config <path-to-debug-targets.json>
 *
 * Config format:
 * {
 *   "targets": [
 *     { "name": "backend", "language": "python", "host": "127.0.0.1", "port": 5678 },
 *     { "name": "frontend", "language": "node", "host": "127.0.0.1", "port": 9229 }
 *   ]
 * }
 */

import * as fs from 'fs'
import * as readline from 'readline'
import { DapClient, type DapResponse, type DapEvent } from './dap-client'

// ---- Types ----

interface DebugTarget {
  name: string
  language: 'node' | 'python'
  host: string
  port: number
}

interface DebugConfig {
  targets: DebugTarget[]
}

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: number | string
  method: string
  params?: Record<string, unknown>
}

// ---- State ----

const clients = new Map<string, DapClient>()      // target name → connected DAP client
const stoppedState = new Map<string, DapEvent>()   // target name → last 'stopped' event
let config: DebugConfig = { targets: [] }

// ---- MCP Protocol (JSON-RPC 2.0 over stdio, NDJSON) ----

function send(msg: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

function sendResult(id: number | string, result: unknown): void {
  send({ jsonrpc: '2.0', id, result })
}

function sendError(id: number | string, code: number, message: string): void {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

// ---- Tool Definitions ----

const TOOLS = [
  {
    name: 'debug_listTargets',
    description: 'List debuggable services in this environment (name, language, debug port, connected status)',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'debug_attach',
    description: 'Connect to a service\'s debug adapter. Must be called before other debug operations on that service.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Service name (from debug_listTargets)' },
      },
      required: ['target'],
    },
  },
  {
    name: 'debug_setBreakpoint',
    description: 'Set a breakpoint at a file and line number. Optionally add a condition expression.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Service name' },
        file: { type: 'string', description: 'Absolute file path' },
        line: { type: 'number', description: 'Line number (1-based)' },
        condition: { type: 'string', description: 'Optional condition expression' },
      },
      required: ['target', 'file', 'line'],
    },
  },
  {
    name: 'debug_breakOnException',
    description: 'Configure exception breakpoints. Break on uncaught exceptions, all exceptions, or none.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Service name' },
        mode: { type: 'string', enum: ['uncaught', 'all', 'none'], description: 'Exception breakpoint mode (default: uncaught)' },
      },
      required: ['target'],
    },
  },
  {
    name: 'debug_continue',
    description: 'Resume execution after hitting a breakpoint. IMPORTANT: Always call this when done inspecting — otherwise the service appears hung.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Service name' },
        threadId: { type: 'number', description: 'Thread ID (default: first stopped thread)' },
      },
      required: ['target'],
    },
  },
  {
    name: 'debug_stepOver',
    description: 'Step to the next line in the current function.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Service name' },
        threadId: { type: 'number', description: 'Thread ID' },
      },
      required: ['target'],
    },
  },
  {
    name: 'debug_stepIn',
    description: 'Step into a function call.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Service name' },
        threadId: { type: 'number', description: 'Thread ID' },
      },
      required: ['target'],
    },
  },
  {
    name: 'debug_stepOut',
    description: 'Step out of the current function.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Service name' },
        threadId: { type: 'number', description: 'Thread ID' },
      },
      required: ['target'],
    },
  },
  {
    name: 'debug_stackTrace',
    description: 'Get the call stack at the current stop point. Returns file, line, and function name for each frame.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Service name' },
        threadId: { type: 'number', description: 'Thread ID' },
      },
      required: ['target'],
    },
  },
  {
    name: 'debug_variables',
    description: 'Inspect variables in a stack frame. Returns local variables, arguments, and their values.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Service name' },
        frameId: { type: 'number', description: 'Frame ID from debug_stackTrace (default: top frame)' },
      },
      required: ['target'],
    },
  },
  {
    name: 'debug_evaluate',
    description: 'Evaluate an expression in the context of the current stack frame. Useful for testing fix hypotheses.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Service name' },
        expression: { type: 'string', description: 'Expression to evaluate' },
        frameId: { type: 'number', description: 'Frame ID context (default: top frame)' },
      },
      required: ['target', 'expression'],
    },
  },
  {
    name: 'debug_disconnect',
    description: 'Detach from a service\'s debug adapter. The service continues running.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Service name' },
      },
      required: ['target'],
    },
  },
]

// ---- Tool Handlers ----

function getClient(target: string): DapClient {
  const client = clients.get(target)
  if (!client || !client.isConnected()) {
    throw new Error(`Not attached to '${target}'. Call debug_attach first.`)
  }
  return client
}

function getTarget(name: string): DebugTarget {
  const t = config.targets.find(t => t.name === name)
  if (!t) throw new Error(`Unknown target '${name}'. Available: ${config.targets.map(t => t.name).join(', ')}`)
  return t
}

function getThreadId(target: string, explicit?: number): number {
  if (explicit != null) return explicit
  const evt = stoppedState.get(target)
  if (evt?.body?.threadId != null) return evt.body.threadId as number
  return 1 // default thread
}

async function handleTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'debug_listTargets': {
      return config.targets.map(t => ({
        name: t.name,
        language: t.language,
        host: t.host,
        port: t.port,
        connected: clients.has(t.name) && clients.get(t.name)!.isConnected(),
      }))
    }

    case 'debug_attach': {
      const target = getTarget(args.target as string)

      // Disconnect existing client if any
      const existing = clients.get(target.name)
      if (existing?.isConnected()) {
        try { await existing.request('disconnect', { restart: false }) } catch { /* */ }
        existing.disconnect()
      }

      const client = new DapClient(target.host, target.port)

      // Listen for 'stopped' events (breakpoint hit, exception, step)
      client.on('event', (evt: DapEvent) => {
        if (evt.event === 'stopped') {
          stoppedState.set(target.name, evt)
        } else if (evt.event === 'continued') {
          stoppedState.delete(target.name)
        }
      })

      await client.connect()
      clients.set(target.name, client)

      // DAP initialize
      const initResp = await client.request('initialize', {
        clientID: 'colony-debug-mcp',
        clientName: 'Colony Debug MCP',
        adapterID: target.language,
        linesStartAt1: true,
        columnsStartAt1: true,
        pathFormat: 'path',
        supportsVariableType: true,
      })

      // DAP attach (different for Node vs Python)
      if (target.language === 'node') {
        await client.request('attach', { type: 'node', restart: false })
      } else {
        await client.request('attach', {
          type: 'python',
          connect: { host: target.host, port: target.port },
          justMyCode: true,
        })
      }

      // Signal configuration done
      await client.request('configurationDone', {})

      return {
        attached: true,
        target: target.name,
        language: target.language,
        capabilities: initResp.body || {},
      }
    }

    case 'debug_setBreakpoint': {
      const client = getClient(args.target as string)
      const bp: Record<string, unknown> = { line: args.line as number }
      if (args.condition) bp.condition = args.condition as string

      const resp = await client.request('setBreakpoints', {
        source: { path: args.file as string },
        breakpoints: [bp],
      })

      const breakpoints = (resp.body?.breakpoints as Array<Record<string, unknown>>) || []
      return {
        breakpoints: breakpoints.map(b => ({
          verified: b.verified,
          line: b.line,
          message: b.message,
        })),
      }
    }

    case 'debug_breakOnException': {
      const client = getClient(args.target as string)
      const mode = (args.mode as string) || 'uncaught'
      const target = getTarget(args.target as string)

      let filters: string[]
      if (target.language === 'node') {
        filters = mode === 'all' ? ['all'] : mode === 'uncaught' ? ['uncaught'] : []
      } else {
        // Python debugpy uses 'raised' and 'uncaught'
        filters = mode === 'all' ? ['raised', 'uncaught'] : mode === 'uncaught' ? ['uncaught'] : []
      }

      await client.request('setExceptionBreakpoints', { filters })
      return { mode, filters }
    }

    case 'debug_continue': {
      const client = getClient(args.target as string)
      const threadId = getThreadId(args.target as string, args.threadId as number | undefined)
      await client.request('continue', { threadId })
      stoppedState.delete(args.target as string)
      return { continued: true, threadId }
    }

    case 'debug_stepOver': {
      const client = getClient(args.target as string)
      const threadId = getThreadId(args.target as string, args.threadId as number | undefined)
      await client.request('next', { threadId })
      return { stepped: true, threadId }
    }

    case 'debug_stepIn': {
      const client = getClient(args.target as string)
      const threadId = getThreadId(args.target as string, args.threadId as number | undefined)
      await client.request('stepIn', { threadId })
      return { stepped: true, threadId }
    }

    case 'debug_stepOut': {
      const client = getClient(args.target as string)
      const threadId = getThreadId(args.target as string, args.threadId as number | undefined)
      await client.request('stepOut', { threadId })
      return { stepped: true, threadId }
    }

    case 'debug_stackTrace': {
      const client = getClient(args.target as string)
      const threadId = getThreadId(args.target as string, args.threadId as number | undefined)

      const resp = await client.request('stackTrace', { threadId, levels: 20 })
      const frames = (resp.body?.stackFrames as Array<Record<string, unknown>>) || []

      return {
        threadId,
        frames: frames.map(f => ({
          id: f.id,
          name: f.name,
          file: (f.source as Record<string, unknown>)?.path || (f.source as Record<string, unknown>)?.name || '<unknown>',
          line: f.line,
          column: f.column,
        })),
      }
    }

    case 'debug_variables': {
      const client = getClient(args.target as string)
      let frameId = args.frameId as number | undefined

      // If no frameId, get the top frame
      if (frameId == null) {
        const threadId = getThreadId(args.target as string)
        const st = await client.request('stackTrace', { threadId, levels: 1 })
        const frames = (st.body?.stackFrames as Array<Record<string, unknown>>) || []
        if (frames.length === 0) throw new Error('No stack frames available')
        frameId = frames[0].id as number
      }

      // Get scopes for this frame
      const scopeResp = await client.request('scopes', { frameId })
      const scopes = (scopeResp.body?.scopes as Array<Record<string, unknown>>) || []

      // Fetch variables for each scope (limit to locals + arguments)
      const result: Array<{ scope: string; variables: Array<{ name: string; value: string; type?: string }> }> = []

      for (const scope of scopes) {
        const scopeName = scope.name as string
        // Skip expensive scopes (globals, etc.)
        if (/global/i.test(scopeName) || /module/i.test(scopeName)) continue

        const varResp = await client.request('variables', {
          variablesReference: scope.variablesReference as number,
        })
        const vars = (varResp.body?.variables as Array<Record<string, unknown>>) || []

        result.push({
          scope: scopeName,
          variables: vars.slice(0, 50).map(v => ({
            name: v.name as string,
            value: v.value as string,
            type: v.type as string | undefined,
          })),
        })
      }

      return { frameId, scopes: result }
    }

    case 'debug_evaluate': {
      const client = getClient(args.target as string)
      let frameId = args.frameId as number | undefined

      if (frameId == null) {
        const threadId = getThreadId(args.target as string)
        const st = await client.request('stackTrace', { threadId, levels: 1 })
        const frames = (st.body?.stackFrames as Array<Record<string, unknown>>) || []
        if (frames.length > 0) frameId = frames[0].id as number
      }

      const evalArgs: Record<string, unknown> = {
        expression: args.expression as string,
        context: 'repl',
      }
      if (frameId != null) evalArgs.frameId = frameId

      const resp = await client.request('evaluate', evalArgs)
      return {
        result: resp.body?.result,
        type: resp.body?.type,
        variablesReference: resp.body?.variablesReference,
      }
    }

    case 'debug_disconnect': {
      const targetName = args.target as string
      const client = clients.get(targetName)
      if (client?.isConnected()) {
        try { await client.request('disconnect', { restart: false }) } catch { /* */ }
        client.disconnect()
      }
      clients.delete(targetName)
      stoppedState.delete(targetName)
      return { disconnected: true, target: targetName }
    }

    default:
      throw new Error(`Unknown tool: ${name}`)
  }
}

// ---- Request Handler ----

async function handleRequest(req: JsonRpcRequest): Promise<void> {
  try {
    switch (req.method) {
      case 'initialize': {
        sendResult(req.id, {
          protocolVersion: '2024-11-05',
          serverInfo: { name: 'colony-debug-mcp', version: '1.0.0' },
          capabilities: { tools: {} },
        })
        // Send initialized notification
        send({ jsonrpc: '2.0', method: 'notifications/initialized' })
        break
      }

      case 'tools/list': {
        sendResult(req.id, { tools: TOOLS })
        break
      }

      case 'tools/call': {
        const params = req.params || {}
        const toolName = params.name as string
        const toolArgs = (params.arguments || {}) as Record<string, unknown>

        try {
          const result = await handleTool(toolName, toolArgs)
          sendResult(req.id, {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          })
        } catch (err) {
          sendResult(req.id, {
            content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
            isError: true,
          })
        }
        break
      }

      case 'ping': {
        sendResult(req.id, {})
        break
      }

      default: {
        // Unknown method — respond with method not found
        if (req.id != null) {
          sendError(req.id, -32601, `Method not found: ${req.method}`)
        }
      }
    }
  } catch (err) {
    if (req.id != null) {
      sendError(req.id, -32603, (err as Error).message)
    }
  }
}

// ---- Main ----

function loadConfig(): DebugConfig {
  const configArg = process.argv.indexOf('--config')
  if (configArg === -1 || !process.argv[configArg + 1]) {
    process.stderr.write('[debug-mcp] --config <path> required\n')
    process.exit(1)
  }
  const configPath = process.argv[configArg + 1]
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf-8')) as DebugConfig
  } catch (err) {
    process.stderr.write(`[debug-mcp] failed to read config: ${err}\n`)
    process.exit(1)
  }
}

config = loadConfig()
process.stderr.write(`[debug-mcp] started with ${config.targets.length} targets: ${config.targets.map(t => `${t.name}(${t.language}:${t.port})`).join(', ')}\n`)

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  if (!line.trim()) return
  try {
    const msg = JSON.parse(line) as JsonRpcRequest
    handleRequest(msg).catch(err => {
      process.stderr.write(`[debug-mcp] unhandled error: ${err}\n`)
    })
  } catch {
    process.stderr.write(`[debug-mcp] malformed JSON: ${line.slice(0, 100)}\n`)
  }
})

rl.on('close', () => {
  // Disconnect all DAP clients on exit
  for (const [, client] of clients) {
    if (client.isConnected()) client.disconnect()
  }
  process.exit(0)
})

// Prevent unhandled promise rejections from crashing the server
process.on('unhandledRejection', (err) => {
  process.stderr.write(`[debug-mcp] unhandled rejection: ${err}\n`)
})
