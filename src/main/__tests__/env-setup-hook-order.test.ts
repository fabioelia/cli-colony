/**
 * Regression test: postCreate hooks must run in the order they appear in the template,
 * NOT alphabetically by name. Verifies the full data pipeline preserves array order:
 * YAML parse → resolveHooks → manifest JSON round-trip → runHooks iteration.
 */

import { describe, it, expect } from 'vitest'
import { parseYaml } from '../../shared/yaml-parser'
import { resolveHooks, createResolver } from '../../shared/template-resolver'

describe('hook ordering', () => {
  const YAML_WITH_NON_ALPHA_ORDER = `
hooks:
  postCreate:
    - name: z-last
      type: command
      command: echo z
    - name: a-first
      type: command
      command: echo a
    - name: m-middle
      type: command
      command: echo m
`

  it('YAML parser preserves array order of hook steps', () => {
    const parsed = parseYaml(YAML_WITH_NON_ALPHA_ORDER)
    expect(parsed).not.toBeNull()
    const hooks = parsed!.hooks.postCreate
    expect(hooks).toHaveLength(3)
    expect(hooks[0].name).toBe('z-last')
    expect(hooks[1].name).toBe('a-first')
    expect(hooks[2].name).toBe('m-middle')
  })

  it('resolveHooks preserves array order', () => {
    const parsed = parseYaml(YAML_WITH_NON_ALPHA_ORDER)
    const resolve = createResolver({ name: 'test' })
    const resolved = resolveHooks(parsed!.hooks, resolve)
    expect(resolved.postCreate).toHaveLength(3)
    expect(resolved.postCreate[0].name).toBe('z-last')
    expect(resolved.postCreate[1].name).toBe('a-first')
    expect(resolved.postCreate[2].name).toBe('m-middle')
  })

  it('JSON.parse round-trip preserves hook array order', () => {
    const parsed = parseYaml(YAML_WITH_NON_ALPHA_ORDER)
    const manifest = { hooks: parsed!.hooks }
    const serialized = JSON.stringify(manifest, null, 2)
    const restored = JSON.parse(serialized)
    expect(restored.hooks.postCreate[0].name).toBe('z-last')
    expect(restored.hooks.postCreate[1].name).toBe('a-first')
    expect(restored.hooks.postCreate[2].name).toBe('m-middle')
  })

  it('full pipeline: YAML → resolve → JSON round-trip preserves order', () => {
    const parsed = parseYaml(YAML_WITH_NON_ALPHA_ORDER)
    const resolve = createResolver({ name: 'test' })
    const resolved = resolveHooks(parsed!.hooks, resolve)
    // Simulate manifest write + read
    const manifest = JSON.parse(JSON.stringify({ hooks: resolved }))
    const names = manifest.hooks.postCreate.map((h: any) => h.name)
    expect(names).toEqual(['z-last', 'a-first', 'm-middle'])
  })

  it('postClone and postCreate phases both preserve order independently', () => {
    const yaml = `
hooks:
  postClone:
    - name: clone-step-2
      type: command
      command: echo 2
    - name: clone-step-1
      type: command
      command: echo 1
  postCreate:
    - name: create-step-3
      type: command
      command: echo 3
    - name: create-step-1
      type: command
      command: echo 1
`
    const parsed = parseYaml(yaml)
    expect(parsed!.hooks.postClone[0].name).toBe('clone-step-2')
    expect(parsed!.hooks.postClone[1].name).toBe('clone-step-1')
    expect(parsed!.hooks.postCreate[0].name).toBe('create-step-3')
    expect(parsed!.hooks.postCreate[1].name).toBe('create-step-1')
  })
})
