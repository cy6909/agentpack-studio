import { describe, expect, it } from 'vitest'
import { applyOpenAiToolPolicy } from '../../src/adapters/openai-policy-proxy.js'

describe('OpenAI model policy adapter', () => {
  it('forces a tool call while DSH advertises any tool', () => {
    const decision = applyOpenAiToolPolicy({
      model: 'qwen',
      tool_choice: 'auto',
      tools: [{ type: 'function', function: { name: 'read_domain_fact' } }],
    })

    expect(decision).toMatchObject({
      advertisedToolCount: 1,
      originalToolChoice: 'auto',
      effectiveToolChoice: 'required',
      body: { tool_choice: 'required' },
    })
  })

  it('forbids tool calls in the structured-output phase', () => {
    const decision = applyOpenAiToolPolicy({ model: 'qwen', messages: [] })

    expect(decision.advertisedToolCount).toBe(0)
    expect(decision.effectiveToolChoice).toBe('none')
    expect(decision.body.tool_choice).toBe('none')
  })

  it('rejects a non-object request body', () => {
    expect(() => applyOpenAiToolPolicy([])).toThrow(/JSON object/)
  })
})
