#!/usr/bin/env node
import { resolve } from 'node:path'
import { DshCompiler } from './adapters/dsh-compiler.js'
import { DshAcpRuntime } from './adapters/dsh-acp-runtime.js'
import { startA2aServer } from './adapters/a2a-server.js'
import { errorMessage } from './core/errors.js'
import { PackExecutor } from './core/pack-executor.js'
import { TraceSink } from './core/trace.js'

const args = parseArgs(process.argv.slice(2))
const packPath = requireArg(args, 'pack')
const targetPath = requireArg(args, 'target')
const port = Number(requireArg(args, 'port'))
if (!Number.isInteger(port) || port <= 0 || port > 65_535) throw new Error('--port must be a valid TCP port')

const projectRoot = resolve(args.get('project-root') ?? process.cwd())
const outputDirectory = resolve(args.get('output') ?? `.agentpack/runtime/${port}`)
const compiler = new DshCompiler()
const artifact = await compiler.compile({ packPath, targetPath, outputDirectory, projectRoot })
const tracePath = resolve(args.get('trace') ?? `${outputDirectory}/trace.jsonl`)
const trace = new TraceSink(tracePath)
const runtime = new DshAcpRuntime({
  artifact,
  cwd: projectRoot,
  onDiagnostic: line => { void trace.write({
    event: 'dsh.stderr',
    traceId: 'runtime',
    pack: artifact.packIdentity,
    line,
  }) },
})
await runtime.start()
await trace.write({
  event: 'runtime.ready',
  traceId: 'runtime',
  pack: artifact.packIdentity,
  readinessPath: artifact.runtime.readinessPath,
})
const executor = new PackExecutor({ artifact, runtime, trace })
const publicUrl = args.get('public-url') ?? `${artifact.target.spec.transport.publicBaseUrl.replace(/\/$/, '')}:${port}`
const server = await startA2aServer({
  artifact,
  executor,
  trace,
  host: artifact.target.spec.transport.host,
  port,
  publicUrl,
})

process.stdout.write(`${JSON.stringify({
  event: 'agentpack.server.ready',
  pack: artifact.packIdentity,
  packDigest: artifact.packDigest,
  url: server.url,
  agentCard: `${server.url}/.well-known/agent-card.json`,
  tracePath,
})}\n`)

let closing = false
const close = async (signal: string) => {
  if (closing) return
  closing = true
  try {
    await server.close()
    await runtime.close()
    process.stdout.write(`${JSON.stringify({ event: 'agentpack.server.closed', signal, pack: artifact.packIdentity })}\n`)
    process.exitCode = 0
  } catch (error) {
    process.stderr.write(`AgentPack server shutdown failed: ${errorMessage(error)}\n`)
    process.exitCode = 1
  }
}
process.once('SIGINT', () => { void close('SIGINT') })
process.once('SIGTERM', () => { void close('SIGTERM') })

function parseArgs(values: string[]): Map<string, string> {
  const result = new Map<string, string>()
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index]
    const value = values[index + 1]
    if (!key?.startsWith('--') || value === undefined) throw new Error(`Invalid argument near: ${key ?? '(end)'}`)
    result.set(key.slice(2), value)
  }
  return result
}

function requireArg(args: ReadonlyMap<string, string>, name: string): string {
  const value = args.get(name)
  if (!value) throw new Error(`Missing required --${name}`)
  return value
}
