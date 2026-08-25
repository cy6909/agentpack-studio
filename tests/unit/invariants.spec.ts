import { describe, expect, it } from 'vitest'
import { AgentPackError } from '../../src/core/errors.js'
import { enforcePackInvariants } from '../../src/core/invariants.js'
import type { JsonObject } from '../../src/core/json.js'
import type { PackInvariant } from '../../src/core/pack-ir.js'

describe('generic Pack invariants', () => {
  it('accepts subset, required values, coverage and exclusions together', () => {
    const output: JsonObject = {
      selected: ['a'],
      candidates: ['a', 'b'],
      slots: ['top', 'bottom'],
      facts: [{ id: 'a', severity: 'high', available: true }, { id: 'b', severity: 'low', available: false }],
      constraints: [{ ruleId: 'a' }],
    }
    expect(() => enforcePackInvariants(output, invariants())).not.toThrow()
  })

  it('fails closed when forbidden evidence is selected', () => {
    const output: JsonObject = {
      selected: ['b'], candidates: ['a', 'b'], slots: ['top', 'bottom'],
      facts: [{ id: 'a', severity: 'high', available: true }, { id: 'b', severity: 'low', available: false }],
      constraints: [{ ruleId: 'a' }],
    }
    expect(() => enforcePackInvariants(output, invariants())).toThrow(AgentPackError)
  })
})

function invariants(): PackInvariant[] {
  return [
    { id: 'subset', type: 'subset', subsetPath: '/selected', supersetPath: '/candidates' },
    { id: 'slots', type: 'required-values', path: '/slots', values: ['top', 'bottom'] },
    {
      id: 'coverage', type: 'filtered-coverage', sourcePath: '/facts', sourceKeyPath: '/id',
      filterPath: '/severity', equals: 'high', targetPath: '/constraints', targetKeyPath: '/ruleId',
    },
    {
      id: 'exclusion', type: 'filtered-exclusion', sourcePath: '/facts', sourceKeyPath: '/id',
      filterPath: '/available', equals: false, targetPath: '/selected',
    },
  ]
}
