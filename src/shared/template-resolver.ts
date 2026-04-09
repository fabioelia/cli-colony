/**
 * Template variable resolution — single implementation shared by env-manager and env-daemon.
 *
 * Resolves ${...} variables in strings, using dot-notation to walk a context object.
 * e.g. "${ports.backend}" with context { ports: { backend: 8030 } } → "8030"
 *
 * Escape with backslash to output a literal: \${ports.backend} → "${ports.backend}"
 */

export interface ResolveOpts {
  /** What to do when a variable can't be resolved */
  onUnresolved?: 'warn-empty' | 'keep-original'
  /** Label for log messages */
  label?: string
}

/**
 * Create a resolver function bound to a context object.
 */
export function createResolver(context: Record<string, any>, opts: ResolveOpts = {}): (s: string) => string {
  const mode = opts.onUnresolved ?? 'warn-empty'
  const label = opts.label ?? 'template-resolver'

  // Only match ${...} where the key starts with a known context namespace.
  // This avoids clobbering bash syntax like ${VAR:-default} or ${var%%pattern}.
  const knownPrefixes = Object.keys(context).join('|')
  const pattern = new RegExp(`\\$\\{((?:${knownPrefixes})(?:\\.[a-zA-Z_][a-zA-Z0-9_-]*)*)\\}`, 'g')

  // Namespaces whose values are filesystem paths — shell-quote if they contain spaces
  const pathNamespaces = new Set(['paths', 'repos'])

  return (s: string): string => {
    // Preserve escaped template variables: \${...} → sentinel (restored as literal ${...} after resolution)
    const SENTINEL = '\x00ESC_TPL\x00'
    const escaped = s.replace(/\\\$\{/g, SENTINEL)

    const resolved = escaped.replace(pattern, (match, key: string) => {
      const parts = key.split('.')
      let val: any = context
      for (const p of parts) {
        if (val == null || typeof val !== 'object') { val = undefined; break }
        val = val[p]
      }
      if (val == null || val === '') {
        if (mode === 'keep-original') return match
        console.warn(`[${label}] unresolved template variable: ${match}`)
        return ''
      }
      let str = String(val)
      // Shell-quote path values that contain spaces so `cd ${paths.backend}` works
      if (pathNamespaces.has(parts[0]) && str.includes(' ') && !str.startsWith('"') && !str.startsWith("'")) {
        str = '"' + str + '"'
      }
      return str
    })

    // Restore escaped variables as literal ${
    return resolved.replaceAll(SENTINEL, '${')
  }
}

/**
 * Resolve all string values in a record (one level deep).
 * Mutates the record in place and returns it.
 */
export function resolveRecord(record: Record<string, any>, resolve: (s: string) => string): Record<string, any> {
  for (const [key, val] of Object.entries(record)) {
    if (typeof val === 'string' && val.includes('${')) {
      record[key] = resolve(val)
    }
  }
  return record
}

/**
 * Build the full resolution context from template + instance data.
 */
export function buildContext(opts: {
  name: string          // slug
  displayName?: string  // original user input
  ports: Record<string, number>
  paths: Record<string, string>
  resources: Record<string, any>
  repos: Record<string, any>
  branch: string
}): Record<string, any> {
  return {
    name: opts.name,
    displayName: opts.displayName || opts.name,
    safeName: opts.name.replace(/[^a-zA-Z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').toLowerCase(),
    ports: opts.ports,
    paths: opts.paths,
    resources: opts.resources,
    repos: opts.repos,
    branch: opts.branch,
  }
}

/**
 * Resolve all template variables in a service definition.
 */
export function resolveService(svc: any, resolve: (s: string) => string): any {
  const resolved = { ...svc }
  if (resolved.command) resolved.command = resolve(resolved.command)
  if (resolved.cwd) resolved.cwd = resolve(resolved.cwd)
  if (resolved.port && typeof resolved.port === 'string') {
    resolved.port = parseInt(resolve(resolved.port)) || resolved.port
  }
  if (resolved.logFile) resolved.logFile = resolve(resolved.logFile)
  if (resolved.env) {
    const newEnv: Record<string, string> = {}
    for (const [k, v] of Object.entries(resolved.env)) {
      newEnv[k] = resolve(String(v))
    }
    resolved.env = newEnv
  }
  if (resolved.healthCheck?.port && typeof resolved.healthCheck.port === 'string') {
    resolved.healthCheck = { ...resolved.healthCheck }
    resolved.healthCheck.port = parseInt(resolve(resolved.healthCheck.port)) || resolved.healthCheck.port
  }
  if (resolved.healthCheck?.url) {
    resolved.healthCheck = { ...resolved.healthCheck }
    resolved.healthCheck.url = resolve(resolved.healthCheck.url)
  }
  return resolved
}

/**
 * Resolve all template variables in hook steps.
 */
export function resolveHooks(
  hooks: Record<string, any[]>,
  resolve: (s: string) => string
): Record<string, any[]> {
  const result: Record<string, any[]> = {}
  for (const [hookName, steps] of Object.entries(hooks)) {
    result[hookName] = (steps as any[]).map((step: any) => ({
      ...step,
      command: step.command ? resolve(step.command) : undefined,
      cwd: step.cwd ? resolve(step.cwd) : undefined,
      prompt: step.prompt ? resolve(step.prompt) : undefined,
      promptType: step.promptType,
      defaultPath: step.defaultPath ? resolve(step.defaultPath) : undefined,
      target: step.target ? resolve(step.target) : undefined,
      optionsCommand: step.optionsCommand ? resolve(step.optionsCommand) : undefined,
    }))
  }
  return result
}

/**
 * Resolve an entire template against a context, returning resolved services, hooks, and resources.
 */
export function resolveTemplate(template: {
  services?: Record<string, any>
  hooks?: Record<string, any[]>
  resources?: Record<string, any>
}, context: Record<string, any>, label?: string): {
  services: Record<string, any>
  hooks: Record<string, any[]>
  resources: Record<string, any>
} {
  // Build resources from template
  const resources: Record<string, any> = {}
  if (template.resources) {
    for (const [key, res] of Object.entries(template.resources)) {
      resources[key] = { ...res }
    }
  }

  // Create resolver with the initial context (resources not yet resolved)
  context.resources = resources
  const resolve = createResolver(context, { onUnresolved: 'warn-empty', label: label ?? 'env-manager' })

  // Resolve resource values first (e.g. "database": "myapp_${safeName}")
  for (const [key, res] of Object.entries(resources)) {
    for (const [field, val] of Object.entries(res)) {
      if (typeof val === 'string' && val.includes('${')) {
        resources[key][field] = resolve(val)
      }
    }
  }
  // Update context with resolved resources so services/hooks see final values
  context.resources = resources

  // Resolve services
  const services: Record<string, any> = {}
  if (template.services) {
    for (const [svcName, svc] of Object.entries(template.services)) {
      services[svcName] = resolveService(svc, resolve)
    }
  }

  // Resolve hooks
  const hooks = resolveHooks(template.hooks || {}, resolve)

  return { services, hooks, resources }
}

/**
 * Scan a JSON string for unresolved ${...} variables.
 * Returns the unique variable names found, or empty array if all resolved.
 */
export function findUnresolved(json: string): string[] {
  const matches = json.match(/\$\{[^}]+\}/g)
  return matches ? [...new Set(matches)] : []
}
