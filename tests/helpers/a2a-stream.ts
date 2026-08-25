import { randomUUID } from 'node:crypto'
import type { JsonObject } from '../../src/core/json.js'

export interface RawA2aStream {
  taskId: Promise<string>
  events: JsonObject[]
  completed: Promise<void>
}

export function openRawA2aStream(endpoint: string, input: JsonObject, bearerToken?: string): RawA2aStream {
  const events: JsonObject[] = []
  const task = Promise.withResolvers<string>()
  const completed = (async () => {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        ...(bearerToken === undefined ? {} : { authorization: `Bearer ${bearerToken}` }),
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: randomUUID(), method: 'message/stream',
        params: { message: { kind: 'message', role: 'user', messageId: randomUUID(), parts: [{ kind: 'data', data: input }] } },
      }),
    })
    if (!response.ok || !response.body) throw new Error(`A2A stream HTTP ${response.status}: ${await response.text()}`)
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    while (true) {
      const { done, value } = await reader.read()
      buffer += decoder.decode(value, { stream: !done })
      const blocks = buffer.split(/\r?\n\r?\n/)
      buffer = blocks.pop() ?? ''
      for (const block of blocks) {
        const data = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n')
        if (!data) continue
        const envelope: unknown = JSON.parse(data)
        if (!isRecord(envelope)) continue
        events.push(envelope)
        const result = envelope.result
        if (isRecord(result)) {
          const id = result.kind === 'task' && typeof result.id === 'string'
            ? result.id
            : typeof result.taskId === 'string' ? result.taskId : undefined
          if (id) task.resolve(id)
        }
      }
      if (done) break
    }
  })()
  return { taskId: task.promise, events, completed }
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
