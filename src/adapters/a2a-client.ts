import { randomUUID } from 'node:crypto'
import { AgentPackError, errorMessage } from '../core/errors.js'
import type { JsonObject } from '../core/json.js'
import { isJsonObject } from '../core/json.js'

export interface A2aInvocationOptions {
  endpoint: string
  input: JsonObject
  signal: AbortSignal
  bearerToken?: string
  onEvent?: (event: JsonObject) => void | Promise<void>
}

export interface A2aInvocationResult {
  taskId: string
  output: JsonObject
}

export class A2aClient {
  async invoke(options: A2aInvocationOptions): Promise<A2aInvocationResult> {
    let taskId: string | undefined
    let output: JsonObject | undefined
    let terminalState: string | undefined
    try {
      const response = await fetch(options.endpoint, {
        method: 'POST',
        headers: this.#headers(options.bearerToken, true),
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: randomUUID(),
          method: 'message/stream',
          params: {
            message: {
              kind: 'message',
              role: 'user',
              messageId: randomUUID(),
              parts: [{ kind: 'data', data: options.input }],
            },
          },
        }),
        signal: options.signal,
      })
      if (!response.ok) {
        throw new AgentPackError('CHILD_AGENT_FAILED', `Child A2A HTTP ${response.status}`, {
          endpoint: options.endpoint,
          body: await response.text(),
        })
      }
      if (!response.body) throw new AgentPackError('CHILD_AGENT_FAILED', 'Child A2A stream has no response body')

      for await (const envelope of readSseJson(response.body)) {
        if (!isJsonObject(envelope)) continue
        if (isJsonObject(envelope.error)) {
          const message = typeof envelope.error.message === 'string'
            ? `: ${envelope.error.message}`
            : ''
          throw new AgentPackError('CHILD_AGENT_FAILED', `Child A2A returned JSON-RPC error${message}`, envelope.error)
        }
        const result = envelope.result
        if (!isJsonObject(result)) continue
        taskId = taskId ?? readTaskId(result)
        output = readArtifactData(result) ?? output
        terminalState = readTerminalState(result) ?? terminalState
        await options.onEvent?.(result)
        if (terminalState === 'failed') {
          throw new AgentPackError('CHILD_AGENT_FAILED', readStatusMessage(result) ?? 'Child A2A task failed', { taskId, result })
        }
        if (terminalState === 'canceled') {
          throw new AgentPackError('CANCELLED', 'Child A2A task was canceled', { taskId })
        }
      }
      if (!taskId) throw new AgentPackError('CHILD_AGENT_FAILED', 'Child A2A stream never returned a task id')
      if (terminalState !== 'completed') {
        throw new AgentPackError('CHILD_AGENT_FAILED', `Child A2A stream ended without completion: ${terminalState ?? 'unknown'}`, { taskId })
      }
      if (!output) throw new AgentPackError('CHILD_AGENT_FAILED', 'Child A2A task completed without a structured artifact', { taskId })
      return { taskId, output }
    } catch (cause) {
      if (options.signal.aborted) {
        if (taskId) await this.cancel(options.endpoint, taskId, options.bearerToken).catch(() => undefined)
        throw new AgentPackError('CANCELLED', 'Child A2A invocation was cancelled', { taskId }, { cause })
      }
      if (cause instanceof AgentPackError) throw cause
      throw new AgentPackError('CHILD_AGENT_FAILED', `Child A2A invocation failed: ${errorMessage(cause)}`, { taskId }, { cause })
    }
  }

  async cancel(endpoint: string, taskId: string, bearerToken?: string): Promise<void> {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: this.#headers(bearerToken, false),
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: randomUUID(),
        method: 'tasks/cancel',
        params: { id: taskId },
      }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new Error(`Child A2A cancellation returned HTTP ${response.status}`)
  }

  #headers(bearerToken: string | undefined, streaming: boolean): Record<string, string> {
    return {
      'content-type': 'application/json',
      accept: streaming ? 'text/event-stream' : 'application/json',
      ...(bearerToken === undefined ? {} : { authorization: `Bearer ${bearerToken}` }),
    }
  }
}

async function* readSseJson(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      buffer += decoder.decode(value, { stream: !done })
      const events = buffer.split(/\r?\n\r?\n/)
      buffer = events.pop() ?? ''
      for (const event of events) {
        const data = event.split(/\r?\n/)
          .filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).trimStart())
          .join('\n')
        if (data) yield JSON.parse(data)
      }
      if (done) break
    }
    const trailing = buffer.split(/\r?\n/)
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trimStart())
      .join('\n')
    if (trailing) yield JSON.parse(trailing)
  } finally {
    reader.releaseLock()
  }
}

function readTaskId(result: JsonObject): string | undefined {
  if (typeof result.taskId === 'string') return result.taskId
  if (result.kind === 'task' && typeof result.id === 'string') return result.id
  return undefined
}

function readArtifactData(result: JsonObject): JsonObject | undefined {
  if (result.kind !== 'artifact-update' || !isJsonObject(result.artifact)) return undefined
  const parts = result.artifact.parts
  if (!Array.isArray(parts)) return undefined
  for (const part of parts) {
    if (isJsonObject(part) && part.kind === 'data' && isJsonObject(part.data)) return part.data
  }
  return undefined
}

function readTerminalState(result: JsonObject): string | undefined {
  if (result.kind !== 'status-update' || result.final !== true || !isJsonObject(result.status)) return undefined
  return typeof result.status.state === 'string' ? result.status.state : undefined
}

function readStatusMessage(result: JsonObject): string | undefined {
  if (!isJsonObject(result.status) || !isJsonObject(result.status.message)) return undefined
  const parts = result.status.message.parts
  if (!Array.isArray(parts)) return undefined
  const text = parts.find(part => isJsonObject(part) && part.kind === 'text' && typeof part.text === 'string')
  return isJsonObject(text) && typeof text.text === 'string' ? text.text : undefined
}
