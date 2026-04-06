import { describe, it, expect } from 'vitest'
import {
  buildDiagnosePrompt,
  buildTemplateEditPrompt,
  buildTemplateAgentPrompt,
} from '../env-prompts'
import type { DiagnoseContext } from '../env-prompts'

// Minimal env object reused across tests
const BASE_ENV: DiagnoseContext['env'] = {
  name: 'my-feature',
  id: 'env-abc123',
  projectType: 'django',
  branch: 'develop',
  status: 'running',
  paths: { root: '/envs/my-feature' },
  services: [
    { name: 'backend', status: 'running', restarts: 0, port: 8030 },
    { name: 'frontend', status: 'running', restarts: 0, port: 3000 },
  ],
  ports: { backend: 8030, frontend: 3000 },
  urls: { backend: 'http://my-feature.localhost:8030', frontend: 'http://my-feature.localhost:3000' },
}

function makeCtx(overrides: Partial<DiagnoseContext> = {}): DiagnoseContext {
  return {
    env: BASE_ENV,
    isError: false,
    hasCrashedServices: false,
    ...overrides,
  }
}

describe('buildDiagnosePrompt — environment details', () => {
  it('always includes environment name and id', () => {
    const { systemPrompt } = buildDiagnosePrompt(makeCtx())
    expect(systemPrompt).toContain('my-feature')
    expect(systemPrompt).toContain('env-abc123')
  })

  it('always includes branch', () => {
    const { systemPrompt } = buildDiagnosePrompt(makeCtx())
    expect(systemPrompt).toContain('develop')
  })

  it('includes service list as name(status) format', () => {
    const { systemPrompt } = buildDiagnosePrompt(makeCtx())
    expect(systemPrompt).toContain('backend (running)')
    expect(systemPrompt).toContain('frontend (running)')
  })

  it('includes port list', () => {
    const { systemPrompt } = buildDiagnosePrompt(makeCtx())
    expect(systemPrompt).toContain('backend:8030')
    expect(systemPrompt).toContain('frontend:3000')
  })

  it('includes URL list', () => {
    const { systemPrompt } = buildDiagnosePrompt(makeCtx())
    expect(systemPrompt).toContain('http://my-feature.localhost:8030')
  })

  it('shows "none" for empty services/ports/urls', () => {
    const ctx = makeCtx({ env: { ...BASE_ENV, services: [], ports: {}, urls: {} } })
    const { systemPrompt } = buildDiagnosePrompt(ctx)
    // Should appear at least once for each empty list
    expect(systemPrompt.match(/\bnone\b/g)?.length).toBeGreaterThanOrEqual(3)
  })

  it('includes manifest path hint', () => {
    const { systemPrompt } = buildDiagnosePrompt(makeCtx())
    expect(systemPrompt).toContain('/envs/my-feature/instance.json')
  })
})

describe('buildDiagnosePrompt — isError branch', () => {
  const errorCtx = makeCtx({
    isError: true,
    manifest: {
      setup: {
        error: 'pip install failed',
        steps: [
          { name: 'Clone repos', status: 'ok' },
          { name: 'Install deps', status: 'error', error: 'pip: command not found' },
        ],
      },
    },
    setupLog: 'fatal: pip not found',
  })

  it('includes setup error section', () => {
    const { systemPrompt } = buildDiagnosePrompt(errorCtx)
    expect(systemPrompt).toContain('pip install failed')
  })

  it('includes step status list', () => {
    const { systemPrompt } = buildDiagnosePrompt(errorCtx)
    expect(systemPrompt).toContain('[ok] Clone repos')
    expect(systemPrompt).toContain('[error] Install deps')
  })

  it('includes failed step detail', () => {
    const { systemPrompt } = buildDiagnosePrompt(errorCtx)
    expect(systemPrompt).toContain('pip: command not found')
  })

  it('includes setup log', () => {
    const { systemPrompt } = buildDiagnosePrompt(errorCtx)
    expect(systemPrompt).toContain('fatal: pip not found')
  })

  it('initialPrompt says "failed during setup"', () => {
    const { initialPrompt } = buildDiagnosePrompt(errorCtx)
    expect(initialPrompt).toContain('failed during setup')
    expect(initialPrompt).toContain('my-feature')
  })

  it('does NOT include crashed services section when hasCrashedServices=false', () => {
    const { systemPrompt } = buildDiagnosePrompt(errorCtx)
    expect(systemPrompt).not.toContain('## Crashed Services')
  })
})

describe('buildDiagnosePrompt — hasCrashedServices branch', () => {
  const crashedEnv: DiagnoseContext['env'] = {
    ...BASE_ENV,
    services: [
      { name: 'backend', status: 'crashed', restarts: 3, port: 8030 },
      { name: 'frontend', status: 'running', restarts: 0, port: 3000 },
    ],
  }
  const crashCtx = makeCtx({ env: crashedEnv, hasCrashedServices: true })

  it('includes crashed services section', () => {
    const { systemPrompt } = buildDiagnosePrompt(crashCtx)
    expect(systemPrompt).toContain('## Crashed Services')
  })

  it('lists the crashed service name and restart count', () => {
    const { systemPrompt } = buildDiagnosePrompt(crashCtx)
    expect(systemPrompt).toContain('backend')
    expect(systemPrompt).toContain('3 restarts')
  })

  it('includes port in crashed service entry', () => {
    const { systemPrompt } = buildDiagnosePrompt(crashCtx)
    expect(systemPrompt).toContain('port 8030')
  })

  it('initialPrompt mentions crashed service names', () => {
    const { initialPrompt } = buildDiagnosePrompt(crashCtx)
    expect(initialPrompt).toContain('backend')
    expect(initialPrompt).toContain('crashed')
  })

  it('does NOT include setup error sections', () => {
    const { systemPrompt } = buildDiagnosePrompt(crashCtx)
    expect(systemPrompt).not.toContain('## Setup Error')
    expect(systemPrompt).not.toContain('## Failed Steps')
  })
})

describe('buildDiagnosePrompt — template section', () => {
  it('includes template section when template is present', () => {
    const ctx = makeCtx({ manifest: { meta: { templateId: 't1', templateName: 'Newton' } }, template: { name: 'Newton' } })
    const { systemPrompt } = buildDiagnosePrompt(ctx)
    expect(systemPrompt).toContain('## Template\n')
    expect(systemPrompt).toContain('Newton')
  })

  it('converts template name to kebab-case filename', () => {
    const ctx = makeCtx({ template: { name: 'Newton Stack v2' } })
    const { systemPrompt } = buildDiagnosePrompt(ctx)
    // "Newton Stack v2" → "newton-stack-v2.json"
    expect(systemPrompt).toContain('newton-stack-v2.json')
  })

  it('omits template section when template is null', () => {
    const ctx = makeCtx({ template: null })
    const { systemPrompt } = buildDiagnosePrompt(ctx)
    expect(systemPrompt).not.toContain('## Template\n')
  })
})

describe('buildDiagnosePrompt — default initialPrompt', () => {
  it('prompts the user to ask what they need when no errors', () => {
    const { initialPrompt } = buildDiagnosePrompt(makeCtx())
    expect(initialPrompt).toContain('ask me what I need')
    expect(initialPrompt).toContain('my-feature')
  })
})

describe('buildTemplateEditPrompt', () => {
  it('contains the template path in the output', () => {
    const result = buildTemplateEditPrompt('Newton', '/path/to/newton.json', '{"id":"t1"}')
    expect(result).toContain('/path/to/newton.json')
  })

  it('contains the template JSON in the output', () => {
    const result = buildTemplateEditPrompt('Newton', '/path/to/newton.json', '{"id":"t1"}')
    expect(result).toContain('{"id":"t1"}')
  })

  it('tells the agent to save to the provided path', () => {
    const result = buildTemplateEditPrompt('Newton', '/path/to/newton.json', '{"id":"t1"}')
    // Should mention saving to the file path
    expect(result).toContain('save')
    expect(result.toLowerCase()).toContain('/path/to/newton.json')
  })
})

describe('buildTemplateAgentPrompt', () => {
  it('returns a non-empty string', () => {
    const result = buildTemplateAgentPrompt()
    expect(result.length).toBeGreaterThan(100)
  })

  it('includes key discovery instructions', () => {
    const result = buildTemplateAgentPrompt()
    expect(result).toContain('~/.claude-colony/repos/')
    expect(result).toContain('environment-templates')
  })

  it('includes template variable reference', () => {
    const result = buildTemplateAgentPrompt()
    expect(result).toContain('${name}')
    expect(result).toContain('${ports.')
  })
})
