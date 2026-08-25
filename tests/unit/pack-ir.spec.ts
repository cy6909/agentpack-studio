import { describe, expect, it } from 'vitest'
import { agentPackSchema, loadAgentPack, packIdentity } from '../../src/core/pack-ir.js'

const packs = [
  'packs/stylemuse-wardrobe/pack.json',
  'packs/parenting-safety/pack.json',
  'packs/family-trip-planner/pack.json',
]

describe('Agent Pack IR', () => {
  it('loads all three versioned Packs and keeps their domain MCP boundaries disjoint', async () => {
    const loaded = await Promise.all(packs.map(loadAgentPack))
    expect(loaded.map(packIdentity)).toEqual([
      'stylemuse.wardrobe-advisor@0.1.0',
      'parenting.safety-advisor@0.1.0',
      'family-trip.planner@0.1.0',
    ])
    expect(loaded.map(pack => pack.spec.tools.mcp.map(binding => binding.server))).toEqual([
      ['wardrobe'],
      ['parenting'],
      ['travel'],
    ])
    expect(loaded[2]?.spec.composition.children.map(child => child.id)).toEqual(['wardrobe', 'parenting'])
  })

  it('rejects unknown fields instead of silently widening the IR', async () => {
    const pack = await loadAgentPack(packs[0]!)
    const result = agentPackSchema.safeParse({ ...pack, surpriseRuntime: 'coupled-to-dsh' })
    expect(result.success).toBe(false)
  })

  it('contains executable eval inputs and expected domain integrations', async () => {
    for (const path of packs) {
      const pack = await loadAgentPack(path)
      expect(pack.spec.eval.cases.length).toBeGreaterThan(0)
      expect(pack.spec.eval.cases[0]?.expected.requiredToolCalls.length).toBeGreaterThan(0)
    }
  })
})
