import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DshCompiler } from '../../src/adapters/dsh-compiler.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('DSH compiler', () => {
  it('emits a runtime config, a real DSH bundle and a profile without leaking other domain tools', async () => {
    process.env.QWEN_API_KEY = 'remote-test-key'
    const outputDirectory = await mkdtemp(join(tmpdir(), 'agentpack-compiler-'))
    temporaryDirectories.push(outputDirectory)
    const artifact = await new DshCompiler().compile({
      packPath: 'packs/stylemuse-wardrobe/pack.json',
      targetPath: 'targets/qwen-dsh.poc.json',
      outputDirectory,
      projectRoot: process.cwd(),
    })

    const cordis = await readFile(artifact.runtime.cordisConfigPath, 'utf8')
    expect(cordis).toContain('@deepseek-ai/dsh-llm-pi-ai')
    expect(cordis).toContain('@deepseek-ai/dsh-mcp-client')
    expect(cordis).toContain('wardrobe-server.js')
    expect(cordis).not.toContain('parenting-server.js')
    expect(cordis).not.toContain('travel-server.js')
    expect(cordis).toContain('toolBash: false')
    expect(cordis).toContain('enable_thinking: false')

    const bundle = JSON.parse(await readFile(join(outputDirectory, 'dsh/bundle/package.json'), 'utf8')) as Record<string, unknown>
    const profile = JSON.parse(await readFile(join(outputDirectory, 'dsh/profile/package.json'), 'utf8')) as Record<string, unknown>
    expect(bundle).toHaveProperty('dsh.bundle.patch', './cordis.patch.yml')
    expect(profile).toHaveProperty('dsh.profile.bundles.0', '@agentpack-studio/bundle-stylemuse-wardrobe-advisor')
    expect(artifact.runtime.dshCommit).toBe('b150a551b8d465e31e418e1b2eaf5e79bbb7d28e')
  })

  it('pins child Pack contracts into the composite artifact', async () => {
    process.env.QWEN_API_KEY = 'remote-test-key'
    const outputDirectory = await mkdtemp(join(tmpdir(), 'agentpack-composite-'))
    temporaryDirectories.push(outputDirectory)
    const artifact = await new DshCompiler().compile({
      packPath: 'packs/family-trip-planner/pack.json',
      targetPath: 'targets/qwen-dsh.poc.json',
      outputDirectory,
      projectRoot: process.cwd(),
    })
    expect(Object.keys(artifact.composition.childContracts).sort()).toEqual(['parenting', 'wardrobe'])
    expect(artifact.composition.childContracts.wardrobe?.pack).toBe('stylemuse.wardrobe-advisor')
    expect(artifact.runtime.mcpBindings.map(binding => binding.server)).toEqual(['travel'])
  })
})
