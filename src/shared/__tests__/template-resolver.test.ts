import { describe, it, expect, vi } from 'vitest'
import {
  createResolver,
  resolveRecord,
  buildContext,
  resolveService,
  resolveHooks,
  findUnresolved,
} from '../template-resolver'

describe('createResolver', () => {
  it('resolves known namespace variables', () => {
    const ctx = { name: 'myenv', ports: { backend: 8030 } }
    const resolve = createResolver(ctx)
    expect(resolve('Start on port ${ports.backend}')).toBe('Start on port 8030')
    expect(resolve('Name: ${name}')).toBe('Name: myenv')
  })

  it('does NOT resolve unknown namespaces (protects bash ${VAR:-default})', () => {
    const ctx = { name: 'myenv' }
    const resolve = createResolver(ctx)
    // ${UNKNOWN} should be left alone since 'UNKNOWN' is not a known prefix
    expect(resolve('${UNKNOWN_VAR}')).toBe('${UNKNOWN_VAR}')
  })

  it('handles backslash-escaped variables literally', () => {
    const ctx = { name: 'myenv' }
    const resolve = createResolver(ctx)
    expect(resolve('\\${name}')).toBe('${name}')
  })

  it('replaces unresolved known paths with empty string by default', () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ctx = { ports: {} as Record<string, number> }
    const resolve = createResolver(ctx)
    expect(resolve('port: ${ports.missing}')).toBe('port: ')
    consoleSpy.mockRestore()
  })

  it('keeps unresolved variables with keep-original mode', () => {
    const ctx = { ports: {} as Record<string, number> }
    const resolve = createResolver(ctx, { onUnresolved: 'keep-original' })
    expect(resolve('port: ${ports.missing}')).toBe('port: ${ports.missing}')
  })

  it('shell-quotes path values with spaces', () => {
    const ctx = { paths: { backend: '/my app/backend' } }
    const resolve = createResolver(ctx)
    expect(resolve('cd ${paths.backend}')).toBe('cd "/my app/backend"')
  })

  it('does not double-quote already-quoted path values', () => {
    const ctx = { paths: { backend: '"/already/quoted"' } }
    const resolve = createResolver(ctx)
    expect(resolve('cd ${paths.backend}')).toBe('cd "/already/quoted"')
  })

  it('handles multiple variables in one string', () => {
    const ctx = { name: 'env1', ports: { backend: 8030, frontend: 3000 } }
    const resolve = createResolver(ctx)
    expect(resolve('${ports.backend} ${ports.frontend}')).toBe('8030 3000')
  })
})

describe('resolveRecord', () => {
  it('resolves string values containing ${', () => {
    const ctx = { name: 'myenv' }
    const resolve = createResolver(ctx)
    const record = { db: 'myapp_${name}', static: 'no-template' }
    resolveRecord(record, resolve)
    expect(record.db).toBe('myapp_myenv')
    expect(record.static).toBe('no-template')
  })

  it('leaves non-string values alone', () => {
    const ctx = { name: 'x' }
    const resolve = createResolver(ctx)
    const record: Record<string, any> = { port: 8080, active: true }
    resolveRecord(record, resolve)
    expect(record.port).toBe(8080)
    expect(record.active).toBe(true)
  })

  it('mutates and returns the record', () => {
    const ctx = { name: 'e' }
    const resolve = createResolver(ctx)
    const record = { val: '${name}' }
    const returned = resolveRecord(record, resolve)
    expect(returned).toBe(record)
    expect(record.val).toBe('e')
  })
})

describe('buildContext', () => {
  it('builds a context with expected fields', () => {
    const ctx = buildContext({
      name: 'my-env',
      ports: { backend: 8030 },
      paths: { root: '/tmp/myenv' },
      resources: {},
      repos: {},
      branch: 'develop',
    })
    expect(ctx.name).toBe('my-env')
    expect(ctx.branch).toBe('develop')
    expect(ctx.ports.backend).toBe(8030)
    expect(ctx.paths.root).toBe('/tmp/myenv')
  })

  it('generates safeName by sanitizing slug', () => {
    const ctx = buildContext({
      name: 'my-env-123',
      ports: {},
      paths: {},
      resources: {},
      repos: {},
      branch: 'main',
    })
    expect(ctx.safeName).toBe('my_env_123')
  })

  it('uses name as displayName when not provided', () => {
    const ctx = buildContext({
      name: 'myenv',
      ports: {},
      paths: {},
      resources: {},
      repos: {},
      branch: 'main',
    })
    expect(ctx.displayName).toBe('myenv')
  })

  it('uses provided displayName', () => {
    const ctx = buildContext({
      name: 'myenv',
      displayName: 'My Environment',
      ports: {},
      paths: {},
      resources: {},
      repos: {},
      branch: 'main',
    })
    expect(ctx.displayName).toBe('My Environment')
  })
})

describe('resolveService', () => {
  it('resolves command, cwd, and logFile', () => {
    const ctx = { name: 'myenv', paths: { root: '/tmp/myenv' } }
    const resolve = createResolver(ctx)
    const svc = {
      command: 'python manage.py runserver',
      cwd: '${paths.root}',
      logFile: '/tmp/${name}.log',
    }
    const resolved = resolveService(svc, resolve)
    expect(resolved.cwd).toBe('/tmp/myenv')
    expect(resolved.logFile).toBe('/tmp/myenv.log')
  })

  it('resolves string port to integer', () => {
    const ctx = { ports: { backend: 8030 } }
    const resolve = createResolver(ctx)
    const svc = { port: '${ports.backend}' }
    const resolved = resolveService(svc, resolve)
    expect(resolved.port).toBe(8030)
  })

  it('resolves env values', () => {
    const ctx = { name: 'myenv' }
    const resolve = createResolver(ctx)
    const svc = { env: { APP_NAME: '${name}', STATIC: 'value' } }
    const resolved = resolveService(svc, resolve)
    expect(resolved.env.APP_NAME).toBe('myenv')
    expect(resolved.env.STATIC).toBe('value')
  })

  it('resolves healthCheck url and port', () => {
    const ctx = { ports: { backend: 8030 } }
    const resolve = createResolver(ctx)
    const svc = {
      healthCheck: {
        port: '${ports.backend}',
        url: 'http://localhost:${ports.backend}/health',
      },
    }
    const resolved = resolveService(svc, resolve)
    expect(resolved.healthCheck.port).toBe(8030)
    expect(resolved.healthCheck.url).toBe('http://localhost:8030/health')
  })

  it('does not mutate the original service object', () => {
    const ctx = { name: 'x' }
    const resolve = createResolver(ctx)
    const original = { command: 'run ${name}', env: { VAR: '${name}' } }
    resolveService(original, resolve)
    expect(original.command).toBe('run ${name}')
    expect(original.env.VAR).toBe('${name}')
  })
})

describe('resolveHooks', () => {
  it('resolves command and cwd in hook steps', () => {
    const ctx = { name: 'myenv', paths: { root: '/tmp/myenv' } }
    const resolve = createResolver(ctx)
    const hooks = {
      onStart: [
        { command: 'echo ${name}', cwd: '${paths.root}' },
      ],
    }
    const resolved = resolveHooks(hooks, resolve)
    expect(resolved.onStart[0].command).toBe('echo myenv')
    expect(resolved.onStart[0].cwd).toBe('/tmp/myenv')
  })

  it('resolves prompt field', () => {
    const ctx = { name: 'myenv' }
    const resolve = createResolver(ctx)
    const hooks = {
      onSetup: [{ prompt: 'Setup ${name}', promptType: 'info' }],
    }
    const resolved = resolveHooks(hooks, resolve)
    expect(resolved.onSetup[0].prompt).toBe('Setup myenv')
    expect(resolved.onSetup[0].promptType).toBe('info')
  })

  it('returns empty object for empty hooks', () => {
    const resolve = createResolver({})
    expect(resolveHooks({}, resolve)).toEqual({})
  })
})

describe('findUnresolved', () => {
  it('returns empty array when no unresolved variables', () => {
    expect(findUnresolved('{"key": "value"}')).toEqual([])
  })

  it('finds unresolved variables', () => {
    const json = '{"cmd": "run ${name}", "port": "${ports.backend}"}'
    const found = findUnresolved(json)
    expect(found).toContain('${name}')
    expect(found).toContain('${ports.backend}')
  })

  it('deduplicates repeated variables', () => {
    const json = '{"a": "${name}", "b": "${name}"}'
    const found = findUnresolved(json)
    expect(found).toHaveLength(1)
    expect(found[0]).toBe('${name}')
  })

  it('returns empty array for string with no template syntax', () => {
    expect(findUnresolved('{"port": "8080"}')).toEqual([])
  })
})
