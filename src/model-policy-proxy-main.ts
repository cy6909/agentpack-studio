import { parseArgs } from 'node:util'
import { startOpenAiPolicyProxy } from './adapters/openai-policy-proxy.js'

const { values } = parseArgs({
  options: {
    host: { type: 'string', default: '127.0.0.1' },
    port: { type: 'string', default: '8299' },
    upstream: { type: 'string' },
    audit: { type: 'string', default: '.agentpack/evidence/model-policy-proxy.jsonl' },
    'request-timeout-ms': { type: 'string', default: '180000' },
  },
  strict: true,
})

if (!values.upstream) throw new Error('--upstream is required')
const port = positiveInteger(values.port, '--port')
const requestTimeoutMs = positiveInteger(values['request-timeout-ms'], '--request-timeout-ms')
const proxy = await startOpenAiPolicyProxy({
  host: values.host!,
  port,
  upstreamBaseUrl: values.upstream,
  auditPath: values.audit!,
  requestTimeoutMs,
})

process.stdout.write(`${JSON.stringify({ event: 'model-policy-proxy.ready', endpoint: proxy.endpoint })}\n`)
const shutdown = async (): Promise<void> => {
  await proxy.close()
  process.exitCode = 0
}
process.once('SIGINT', () => { void shutdown() })
process.once('SIGTERM', () => { void shutdown() })

function positiveInteger(value: string | undefined, name: string): number {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${name} must be a positive integer`)
  return number
}
