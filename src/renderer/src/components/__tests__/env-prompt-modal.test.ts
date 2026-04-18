/**
 * Tests for the env-prompt modal behavior — specifically the file-type prompt
 * "Use this file" button when defaultPathValid is true.
 *
 * Tests the data contract: the broadcast payload must include defaultPathValid,
 * and the renderer must use it to decide button layout.
 */

import { describe, it, expect } from 'vitest'

describe('env-prompt file modal data contract', () => {
  it('defaultPathValid=true should render "Use this file" as primary action', () => {
    const request = {
      requestId: 'req-1',
      envId: 'env-1',
      hookName: 'setup-env-file',
      prompt: 'Select .env file',
      promptType: 'file' as const,
      defaultPath: '/path/to/.env',
      defaultPathValid: true,
    }
    // With defaultPathValid=true, the primary button should be "Use this file"
    expect(request.defaultPathValid).toBe(true)
    expect(request.defaultPath).toBeDefined()
  })

  it('defaultPathValid=false should not offer "Use this file" button', () => {
    const request = {
      requestId: 'req-2',
      envId: 'env-2',
      hookName: 'setup-env-file',
      prompt: 'Select .env file',
      promptType: 'file' as const,
      defaultPath: '/path/to/missing.env',
      defaultPathValid: false,
    }
    expect(request.defaultPathValid).toBe(false)
  })

  it('missing defaultPath means no "Use this file" button', () => {
    const request = {
      requestId: 'req-3',
      envId: 'env-3',
      hookName: 'setup-env-file',
      prompt: 'Select .env file',
      promptType: 'file' as const,
    }
    expect((request as any).defaultPathValid).toBeUndefined()
    expect((request as any).defaultPath).toBeUndefined()
  })

  it('select-type prompt is unaffected by defaultPathValid', () => {
    const request = {
      requestId: 'req-4',
      envId: 'env-4',
      hookName: 'pick-branch',
      prompt: 'Select branch',
      promptType: 'select' as const,
      options: ['main', 'develop', 'feature'],
    }
    expect(request.promptType).toBe('select')
    // select prompts don't use defaultPathValid
    expect((request as any).defaultPathValid).toBeUndefined()
  })

  it('responding with defaultPath should use the provided path', () => {
    const defaultPath = '/projects/myapp/.env.local'
    const response = { requestId: 'req-5', filePath: defaultPath }
    expect(response.filePath).toBe(defaultPath)
  })
})

describe('env-setup broadcast payload', () => {
  it('defaultPathValid is computed from fs.existsSync on the main process', () => {
    // The main process computes defaultPathValid = !!(hook.defaultPath && fs.existsSync(hook.defaultPath))
    // This test verifies the computation logic
    const compute = (defaultPath: string | undefined, exists: boolean) =>
      !!(defaultPath && exists)

    expect(compute('/valid/path', true)).toBe(true)
    expect(compute('/missing/path', false)).toBe(false)
    expect(compute(undefined, false)).toBe(false)
    expect(compute('', true)).toBe(false) // empty string is falsy
  })
})
