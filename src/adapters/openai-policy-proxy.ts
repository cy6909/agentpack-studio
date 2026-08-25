import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http'
import { appendFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { isJsonObject, type JsonObject } from '../core/json.js'

export interface OpenAiPolicyDecision {
  body: JsonObject
  advertisedToolCount: number
  originalToolChoice?: unknown
  effectiveToolChoice: 'required' | 'none'
}

export interface OpenAiPolicyProxyOptions {
  host: string
  port: number
  upstreamBaseUrl: string
  auditPath: string
  requestTimeoutMs: number
}

/**
 * Apply the PoC's provider-specific execution policy without leaking it into
 * Pack IR. DSH currently exposes tools but not provider-neutral tool_choice;
 * this adapter boundary makes every advertised phase mandatory and makes the
 * output phase explicitly tool-free.
 */
export function applyOpenAiToolPolicy(value: unknown): OpenAiPolicyDecision {
  if (!isJsonObject(value)) throw new Error('OpenAI request body must be a JSON object')
  const tools = Array.isArray(value.tools) ? value.tools : []
  const advertisedToolCount = tools.length
  const effectiveToolChoice = advertisedToolCount > 0 ? 'required' : 'none'
  return {
    body: { ...value, tool_choice: effectiveToolChoice },
    advertisedToolCount,
    ...(value.tool_choice === undefined ? {} : { originalToolChoice: value.tool_choice }),
    effectiveToolChoice,
  }
}

export async function startOpenAiPolicyProxy(options: OpenAiPolicyProxyOptions): Promise<{
  endpoint: string
  close: () => Promise<void>
}> {
  const upstream = new URL(options.upstreamBaseUrl)
  await mkdir(dirname(resolve(options.auditPath)), { recursive: true })
  const server = createServer((request, response) => {
    void proxyRequest(request, response, upstream, options).catch(async (cause: unknown) => {
      if (!response.headersSent) response.writeHead(502, { 'content-type': 'application/json' })
      if (!response.writableEnded) response.end(JSON.stringify({ error: errorMessage(cause) }))
    })
  })
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(options.port, options.host, () => {
      server.off('error', reject)
      resolveListen()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('OpenAI policy proxy did not bind a TCP address')
  return {
    endpoint: `http://${options.host}:${address.port}`,
    close: async () => {
      server.close()
      await once(server, 'close')
    },
  }
}

async function proxyRequest(
  request: IncomingMessage,
  response: ServerResponse,
  upstreamBaseUrl: URL,
  options: OpenAiPolicyProxyOptions,
): Promise<void> {
  const requestId = randomUUID()
  const startedAt = new Date()
  if (request.url === '/healthz') {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ ok: true, policy: 'required-while-tools' }))
    return
  }

  const upstreamUrl = new URL(request.url ?? '/', upstreamBaseUrl)
  const method = request.method ?? 'GET'
  const abort = new AbortController()
  const abortOnDisconnect = (): void => abort.abort(new Error('downstream disconnected'))
  request.once('aborted', abortOnDisconnect)
  response.once('close', () => {
    if (!response.writableEnded) abortOnDisconnect()
  })

  let decision: OpenAiPolicyDecision | undefined
  let status = 0
  let outcome: 'ok' | 'error' | 'aborted' = 'error'
  try {
    const rawBody = await readBody(request, 10 * 1024 * 1024)
    let body: string | undefined = rawBody.length === 0 ? undefined : rawBody
    if (method === 'POST' && upstreamUrl.pathname.endsWith('/chat/completions')) {
      decision = applyOpenAiToolPolicy(JSON.parse(rawBody) as unknown)
      body = JSON.stringify(decision.body)
    }
    const headers = forwardHeaders(request.headers)
    if (body !== undefined) headers.set('content-length', String(Buffer.byteLength(body)))
    const upstreamResponse = await fetch(upstreamUrl, {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(options.requestTimeoutMs)]),
      redirect: 'manual',
    })
    status = upstreamResponse.status
    const responseHeaders: Record<string, string> = {}
    upstreamResponse.headers.forEach((value, key) => {
      if (!['connection', 'content-length', 'content-encoding', 'transfer-encoding'].includes(key.toLowerCase())) {
        responseHeaders[key] = value
      }
    })
    response.writeHead(upstreamResponse.status, responseHeaders)
    if (upstreamResponse.body) {
      for await (const chunk of upstreamResponse.body) {
        if (!response.write(Buffer.from(chunk))) await once(response, 'drain')
      }
    }
    response.end()
    outcome = upstreamResponse.ok ? 'ok' : 'error'
  } catch (cause: unknown) {
    outcome = abort.signal.aborted ? 'aborted' : 'error'
    throw cause
  } finally {
    request.off('aborted', abortOnDisconnect)
    await appendAudit(options.auditPath, {
      event: 'model.policy.applied',
      requestId,
      method,
      path: upstreamUrl.pathname,
      advertisedToolCount: decision?.advertisedToolCount ?? 0,
      ...(decision?.originalToolChoice === undefined ? {} : { originalToolChoice: decision.originalToolChoice }),
      ...(decision === undefined ? {} : { effectiveToolChoice: decision.effectiveToolChoice }),
      status,
      outcome,
      startedAt: startedAt.toISOString(),
      endedAt: new Date().toISOString(),
    })
  }
}

async function readBody(request: IncomingMessage, maximumBytes: number): Promise<string> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > maximumBytes) throw new Error(`OpenAI policy proxy request exceeds ${maximumBytes} bytes`)
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function forwardHeaders(input: IncomingHttpHeaders): Headers {
  const headers = new Headers()
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || ['host', 'connection', 'content-length', 'transfer-encoding'].includes(key.toLowerCase())) continue
    headers.set(key, Array.isArray(value) ? value.join(', ') : value)
  }
  headers.set('accept-encoding', 'identity')
  return headers
}

async function appendAudit(path: string, record: Record<string, unknown>): Promise<void> {
  await appendFile(resolve(path), `${JSON.stringify(record)}\n`, 'utf8')
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}
