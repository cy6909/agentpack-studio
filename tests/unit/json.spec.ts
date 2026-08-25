import { describe, expect, it } from 'vitest'
import { extractUniqueJsonObject } from '../../src/core/json.js'

describe('model JSON normalization', () => {
  it('extracts one fenced object after non-JSON model analysis', () => {
    expect(extractUniqueJsonObject('analysis with {non-json}\n```json\n{"ok":true,"nested":{"value":"}"}}\n```', 'output'))
      .toEqual({ ok: true, nested: { value: '}' } })
  })

  it('rejects ambiguous model output containing multiple valid objects', () => {
    expect(() => extractUniqueJsonObject('{"first":true}\n{"second":true}', 'output'))
      .toThrow(/multiple JSON objects/)
  })

  it('rejects output without a valid object', () => {
    expect(() => extractUniqueJsonObject('analysis only {not-json}', 'output'))
      .toThrow(/does not contain a valid JSON object/)
  })
})
