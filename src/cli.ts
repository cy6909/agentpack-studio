#!/usr/bin/env node
import { readFile, readdir } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { DshCompiler } from './adapters/dsh-compiler.js'
import { A2aClient } from './adapters/a2a-client.js'
import { probeModel } from './adapters/model-probe.js'
import { errorMessage } from './core/errors.js'
import { isJsonObject } from './core/json.js'
import { loadAgentPack, packDigest, packIdentity } from './core/pack-ir.js'
import { loadCompilationTarget } from './core/target.js'
import { VERSION_LOCK } from './version-lock.js'

try {
  await main(process.argv.slice(2))
} catch (error) {
  process.stderr.write(`${JSON.stringify({ event: 'agentpack.cli.failed', error: errorMessage(error) })}\n`)
  process.exitCode = 1
}

async function main(argv: string[]): Promise<void> {
  const command = argv[0]
  const args = parseArgs(argv.slice(1))
  switch (command) {
    case 'validate':
      await validateCommand(args)
      return
    case 'compile':
      await compileCommand(args)
      return
    case 'probe-model':
      await probeCommand(args)
      return
    case 'call':
      await callCommand(args)
      return
    case 'versions':
      process.stdout.write(`${JSON.stringify(VERSION_LOCK, null, 2)}\n`)
      return
    default:
      throw new Error('Usage: agentpack <validate|compile|probe-model|call|versions> [options]')
  }
}

async function validateCommand(args: ReadonlyMap<string, string | true>): Promise<void> {
  const paths = args.has('all') ? await allPackPaths() : [requiredString(args, 'pack')]
  for (const path of paths) {
    const pack = await loadAgentPack(path)
    process.stdout.write(`${JSON.stringify({
      event: 'agentpack.pack.valid',
      path: resolve(path),
      identity: packIdentity(pack),
      digest: packDigest(pack),
      mcpServers: pack.spec.tools.mcp.map(binding => binding.server),
      children: pack.spec.composition.children.map(child => `${child.pack}@${child.version}`),
      evalCases: pack.spec.eval.cases.map(testCase => testCase.id),
    })}\n`)
  }
}

async function compileCommand(args: ReadonlyMap<string, string | true>): Promise<void> {
  const targetPath = requiredString(args, 'target')
  const packPaths = args.has('all') ? await allPackPaths() : [requiredString(args, 'pack')]
  const compiler = new DshCompiler()
  for (const packPath of packPaths) {
    const name = basename(resolve(packPath, '..'))
    const outputDirectory = resolve(stringArg(args, 'output') ?? join('.agentpack', 'compiled', name))
    const artifact = await compiler.compile({ packPath, targetPath, outputDirectory, projectRoot: process.cwd() })
    process.stdout.write(`${JSON.stringify({
      event: 'agentpack.pack.compiled',
      identity: artifact.packIdentity,
      digest: artifact.packDigest,
      outputDirectory,
      cordisConfigPath: artifact.runtime.cordisConfigPath,
      generatedFiles: artifact.generatedFiles,
    })}\n`)
  }
}

async function probeCommand(args: ReadonlyMap<string, string | true>): Promise<void> {
  const target = await loadCompilationTarget(requiredString(args, 'target'))
  const evidence = await probeModel(target, stringArg(args, 'output') ?? '.agentpack/evidence/model-probe.json')
  process.stdout.write(`${JSON.stringify({ event: 'agentpack.model.probe.passed', evidence })}\n`)
}

async function callCommand(args: ReadonlyMap<string, string | true>): Promise<void> {
  const endpoint = requiredString(args, 'url')
  const inputPath = requiredString(args, 'input')
  const parsed: unknown = JSON.parse(await readFile(resolve(inputPath), 'utf8'))
  if (!isJsonObject(parsed)) throw new Error('--input must contain one JSON object')
  const bearerEnv = stringArg(args, 'bearer-env')
  const bearerToken = bearerEnv === undefined ? undefined : process.env[bearerEnv]
  const result = await new A2aClient().invoke({
    endpoint,
    input: parsed,
    signal: AbortSignal.timeout(Number(stringArg(args, 'timeout-ms') ?? '300000')),
    ...(bearerToken === undefined ? {} : { bearerToken }),
    onEvent: event => {
      process.stdout.write(`${JSON.stringify({ event: 'agentpack.call.stream', payload: event })}\n`)
    },
  })
  process.stdout.write(`${JSON.stringify({ event: 'agentpack.call.completed', ...result })}\n`)
}

async function allPackPaths(): Promise<string[]> {
  const root = resolve('packs')
  const entries = await readdir(root, { withFileTypes: true })
  return entries
    .filter(entry => entry.isDirectory())
    .map(entry => join(root, entry.name, 'pack.json'))
    .sort()
}

function parseArgs(argv: string[]): Map<string, string | true> {
  const result = new Map<string, string | true>()
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token?.startsWith('--')) throw new Error(`Unexpected argument: ${token ?? '(end)'}`)
    const key = token.slice(2)
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) {
      result.set(key, true)
    } else {
      result.set(key, next)
      index += 1
    }
  }
  return result
}

function stringArg(args: ReadonlyMap<string, string | true>, name: string): string | undefined {
  const value = args.get(name)
  return typeof value === 'string' ? value : undefined
}

function requiredString(args: ReadonlyMap<string, string | true>, name: string): string {
  const value = stringArg(args, name)
  if (!value) throw new Error(`Missing required --${name}`)
  return value
}
