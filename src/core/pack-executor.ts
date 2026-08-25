import type { DshCompiledArtifact } from '../adapters/dsh-compiler.js'
import { A2aClient } from '../adapters/a2a-client.js'
import { readFile } from 'node:fs/promises'
import { AgentPackError, errorMessage } from './errors.js'
import { enforceCompositionVerifications, enforcePackInvariants } from './invariants.js'
import type { JsonObject, JsonValue } from './json.js'
import { isJsonObject, readJsonPointer, sha256 } from './json.js'
import { packIdentity } from './pack-ir.js'
import type { AgentRuntime, ChildInvocationResult } from './runtime-port.js'
import { JsonSchemaValidator } from './schema-validator.js'
import type { TraceSink } from './trace.js'

export interface PackProgress {
  phase: string
  [key: string]: JsonValue
}

export interface ExecutePackOptions {
  taskId: string
  input: JsonObject
  traceId: string
  signal: AbortSignal
  onProgress: (progress: PackProgress) => void | Promise<void>
}

export class PackExecutor {
  readonly #artifact: DshCompiledArtifact
  readonly #runtime: AgentRuntime
  readonly #trace: TraceSink
  readonly #a2a = new A2aClient()
  readonly #schema: JsonSchemaValidator

  constructor(options: { artifact: DshCompiledArtifact; runtime: AgentRuntime; trace: TraceSink }) {
    this.#artifact = options.artifact
    this.#runtime = options.runtime
    this.#trace = options.trace
    this.#schema = new JsonSchemaValidator(
      options.artifact.pack.spec.interface.inputSchema,
      options.artifact.pack.spec.interface.outputSchema,
    )
  }

  async execute(options: ExecutePackOptions): Promise<JsonObject> {
    const pack = this.#artifact.pack
    this.#schema.validateInput(options.input)
    await this.#trace.write({
      event: 'gateway.task.accepted',
      traceId: options.traceId,
      taskId: options.taskId,
      pack: packIdentity(pack),
      input: options.input,
    })
    await options.onProgress({ phase: 'accepted', traceId: options.traceId })

    const timeoutSignal = AbortSignal.timeout(pack.spec.policy.taskTimeoutMs)
    const signal = AbortSignal.any([options.signal, timeoutSignal])
    try {
      const childResults = await this.#invokeChildren(options, signal)
      const output = await this.#runtime.invoke(
        { input: options.input, traceId: options.traceId, childResults },
        signal,
        async event => {
          if (signal.aborted) return
          await this.#trace.write({
            event: event.type,
            traceId: options.traceId,
            taskId: options.taskId,
            pack: packIdentity(pack),
            sessionId: event.sessionId,
            ...(event.text === undefined ? {} : { bytes: Buffer.byteLength(event.text), contentDigest: `sha256:${sha256(event.text)}` }),
            ...(event.stopReason === undefined ? {} : { stopReason: event.stopReason }),
          })
          await options.onProgress({
            phase: event.type,
            sessionId: event.sessionId,
            ...(event.text === undefined ? {} : { committedBytes: Buffer.byteLength(event.text) }),
          })
        },
      )
      if (signal.aborted) throw new AgentPackError('CANCELLED', 'Task cancelled before output validation')
      const verifiedMcp = await verifyRequiredMcpCalls(this.#artifact, options.traceId)
      for (const call of verifiedMcp) {
        await this.#trace.write({
          event: 'mcp.tool.completed',
          traceId: options.traceId,
          taskId: options.taskId,
          pack: packIdentity(pack),
          ...call,
        })
      }
      await this.#trace.write({
        event: 'gateway.mcp.verified',
        traceId: options.traceId,
        taskId: options.taskId,
        pack: packIdentity(pack),
        calls: verifiedMcp,
      })
      this.#schema.validateOutput(output)
      enforcePackInvariants(output, pack.spec.eval.invariants)
      enforceCompositionVerifications(output, childResults, pack.spec.composition.verify)
      enforceChildProvenance(output, childResults)
      await this.#trace.write({
        event: 'gateway.output.validated',
        traceId: options.traceId,
        taskId: options.taskId,
        pack: packIdentity(pack),
        output,
        outputDigest: `sha256:${sha256(output)}`,
      })
      await options.onProgress({ phase: 'output-validated', outputDigest: `sha256:${sha256(output)}` })
      return output
    } catch (cause) {
      const translated = timeoutSignal.aborted && !options.signal.aborted
        ? new AgentPackError('RUNTIME_FAILED', `Pack task exceeded ${pack.spec.policy.taskTimeoutMs} ms`, undefined, { cause })
        : cause
      await this.#trace.write({
        event: translated instanceof AgentPackError && translated.code === 'CANCELLED'
          ? 'gateway.task.cancelled'
          : 'gateway.task.failed',
        traceId: options.traceId,
        taskId: options.taskId,
        pack: packIdentity(pack),
        error: errorMessage(translated),
        code: translated instanceof AgentPackError ? translated.code : 'UNKNOWN',
      })
      throw translated
    }
  }

  async #invokeChildren(options: ExecutePackOptions, signal: AbortSignal): Promise<Record<string, ChildInvocationResult>> {
    const children = this.#artifact.pack.spec.composition.children
    if (children.length === 0) return {}
    const siblingController = new AbortController()
    const childSignal = AbortSignal.any([signal, siblingController.signal])
    const bearerTokenEnv = this.#artifact.composition.bearerTokenEnv
    const bearerToken = bearerTokenEnv === undefined ? undefined : process.env[bearerTokenEnv]

    const promises = children.map(async child => {
      const contract = this.#artifact.composition.childContracts[child.id]
      if (!contract) throw new AgentPackError('CHILD_AGENT_FAILED', `Missing compiled child contract: ${child.id}`)
      const input = mapChildInput(options.input, child.inputMapping)
      new JsonSchemaValidator(contract.inputSchema, contract.outputSchema).validateInput(input)
      const endpoint = this.#artifact.composition.endpoints[child.id]
      if (!endpoint) throw new AgentPackError('CHILD_AGENT_FAILED', `Missing child endpoint: ${child.id}`)
      await this.#trace.write({
        event: 'composition.child.started',
        traceId: options.traceId,
        taskId: options.taskId,
        pack: this.#artifact.packIdentity,
        childId: child.id,
        childPack: `${child.pack}@${child.version}`,
        endpoint,
        route: this.#artifact.composition.route,
      })
      await options.onProgress({ phase: 'child-started', childId: child.id })
      const result = await this.#a2a.invoke({
        endpoint,
        input,
        signal: AbortSignal.any([childSignal, AbortSignal.timeout(child.timeoutMs)]),
        ...(bearerToken === undefined ? {} : { bearerToken }),
        onEvent: async event => {
          if (!childSignal.aborted) await options.onProgress({ phase: 'child-event', childId: child.id, kind: String(event.kind ?? 'unknown') })
        },
      })
      new JsonSchemaValidator(contract.inputSchema, contract.outputSchema).validateOutput(result.output)
      const childResult: ChildInvocationResult = {
        childId: child.id,
        pack: child.pack,
        version: child.version,
        taskId: result.taskId,
        route: this.#artifact.composition.route,
        outputDigest: `sha256:${sha256(result.output)}`,
        output: result.output,
      }
      await this.#trace.write({
        event: 'composition.child.completed',
        traceId: options.traceId,
        taskId: options.taskId,
        pack: this.#artifact.packIdentity,
        childId: child.id,
        childTaskId: result.taskId,
        childOutputDigest: `sha256:${sha256(result.output)}`,
        route: this.#artifact.composition.route,
      })
      await options.onProgress({ phase: 'child-completed', childId: child.id, childTaskId: result.taskId })
      return childResult
    })

    try {
      const results = await Promise.all(promises)
      return Object.fromEntries(results.map(result => [result.childId, result]))
    } catch (cause) {
      siblingController.abort(new Error('Sibling child agent failed'))
      await Promise.allSettled(promises)
      if (signal.aborted) throw new AgentPackError('CANCELLED', 'Pack composition was cancelled', undefined, { cause })
      throw cause instanceof AgentPackError
        ? cause
        : new AgentPackError('CHILD_AGENT_FAILED', `Pack composition failed: ${errorMessage(cause)}`, undefined, { cause })
    }
  }
}

async function verifyRequiredMcpCalls(artifact: DshCompiledArtifact, traceId: string): Promise<JsonObject[]> {
  const verified: JsonObject[] = []
  for (const binding of artifact.runtime.mcpBindings) {
    if (binding.requiredTools.length === 0) continue
    let text: string
    try {
      text = await readFile(binding.auditPath, 'utf8')
    } catch (cause) {
      throw new AgentPackError('POLICY_VIOLATION', `Required MCP audit is unavailable: ${binding.auditPath}`, undefined, { cause })
    }
    const records = text.split(/\r?\n/).filter(Boolean).map((line, index) => {
      try {
        return JSON.parse(line) as Record<string, unknown>
      } catch (cause) {
        throw new AgentPackError('POLICY_VIOLATION', `Malformed MCP audit record ${binding.auditPath}:${index + 1}`, undefined, { cause })
      }
    })
    for (const tool of binding.requiredTools) {
      const matches = records.filter(record =>
        record.event === 'mcp.tool.completed'
        && record.server === binding.server
        && record.tool === tool
        && record.traceId === traceId
        && record.outcome === 'ok')
      if (matches.length === 0) {
        throw new AgentPackError(
          'POLICY_VIOLATION',
          `No successful MCP audit record for ${binding.server}.${tool} and trace ${traceId}`,
        )
      }
      const latest = matches.at(-1)!
      verified.push({
        server: binding.server,
        tool,
        invocations: matches.length,
        auditPath: binding.auditPath,
        invocationId: typeof latest.invocationId === 'string' ? latest.invocationId : 'unknown',
        outcome: 'ok',
        startedAt: typeof latest.startedAt === 'string' ? latest.startedAt : 'unknown',
        endedAt: typeof latest.endedAt === 'string' ? latest.endedAt : 'unknown',
      })
    }
  }
  return verified
}

function mapChildInput(
  input: JsonObject,
  mapping: Record<string, { from: string } | { value: JsonValue }>,
): JsonObject {
  return Object.fromEntries(Object.entries(mapping).map(([field, binding]) => {
    const value = 'from' in binding ? readJsonPointer(input, binding.from) : binding.value
    if (value === undefined) throw new AgentPackError('INPUT_INVALID', `Child input mapping produced undefined: ${field}`)
    return [field, value]
  })) as JsonObject
}

function enforceChildProvenance(output: JsonObject, children: Readonly<Record<string, ChildInvocationResult>>): void {
  const values = Object.values(children)
  if (values.length === 0) return
  const rows = readJsonPointer(output, '/provenance/childAgents')
  if (!Array.isArray(rows)) {
    throw new AgentPackError('POLICY_VIOLATION', 'Composed Pack output must include /provenance/childAgents')
  }
  for (const child of values) {
    const row = rows.find(candidate => isJsonObject(candidate) && candidate.childId === child.childId)
    const expectedDigest = child.outputDigest
    if (!isJsonObject(row)
      || row.pack !== child.pack
      || row.version !== child.version
      || row.taskId !== child.taskId
      || row.route !== child.route
      || row.outputDigest !== expectedDigest) {
      throw new AgentPackError('POLICY_VIOLATION', `Child provenance mismatch: ${child.childId}`, {
        expected: {
          childId: child.childId,
          pack: child.pack,
          version: child.version,
          taskId: child.taskId,
          route: child.route,
          outputDigest: expectedDigest,
        },
        actual: row,
      })
    }
  }
}
