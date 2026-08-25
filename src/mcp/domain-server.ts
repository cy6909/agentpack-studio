import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { isJsonObject } from '../core/json.js'
import { errorMessage } from '../core/errors.js'

export type McpTestMode = 'normal' | 'error' | 'malformed' | 'not-found' | 'timeout'

export interface DomainToolExecution<T> {
  server: string
  tool: string
  args: unknown
  traceId: string
  signal: AbortSignal
  run: () => Promise<T> | T
}

export type McpToolResponse = CallToolResult

export function createDomainServer(name: string): McpServer {
  return new McpServer(
    { name: `agentpack-${name}-mcp`, version: '0.1.0' },
    { capabilities: { tools: { listChanged: false } } },
  )
}

export async function connectStdio(server: McpServer): Promise<void> {
  await server.connect(new StdioServerTransport())
}

export function allowedTools(known: readonly string[]): ReadonlySet<string> {
  const index = process.argv.indexOf('--allow')
  const configured = index >= 0 ? process.argv[index + 1]?.split(',').filter(Boolean) : [...known]
  if (!configured || configured.length === 0) throw new Error('MCP --allow must name at least one tool')
  const unknown = configured.filter(name => !known.includes(name))
  if (unknown.length > 0) throw new Error(`MCP --allow contains unknown tools: ${unknown.join(', ')}`)
  return new Set(configured)
}

export async function executeDomainTool<T>(execution: DomainToolExecution<T>): Promise<McpToolResponse> {
  const invocationId = randomUUID()
  const startedAt = new Date().toISOString()
  const mode = readMode()
  await audit({
    event: 'mcp.tool.started',
    invocationId,
    server: execution.server,
    tool: execution.tool,
    traceId: execution.traceId,
    args: execution.args,
    mode,
    startedAt,
    pid: process.pid,
  })

  try {
    const configuredDelay = readDelay(mode)
    if (configuredDelay > 0) await abortableDelay(configuredDelay, execution.signal)
    if (mode === 'error') {
      const response: McpToolResponse = {
        content: [{ type: 'text', text: `Injected ${execution.server} MCP error` }],
        isError: true,
      }
      await auditCompletion(execution, invocationId, startedAt, mode, 'error', response)
      return response
    }
    if (mode === 'not-found') {
      const response: McpToolResponse = {
        content: [{ type: 'text', text: `Injected ${execution.server} business record not found` }],
        isError: true,
      }
      await auditCompletion(execution, invocationId, startedAt, mode, 'not-found', response)
      return response
    }
    if (mode === 'malformed') {
      const response: McpToolResponse = {
        content: [{ type: 'text', text: 'Injected malformed structured content' }],
        structuredContent: { malformed: true },
      }
      await auditCompletion(execution, invocationId, startedAt, mode, 'malformed', response)
      return response
    }

    const result = await execution.run()
    if (!isJsonObject(result)) throw new Error(`${execution.server}.${execution.tool} returned a non-object result`)
    const response: McpToolResponse = {
      content: [{ type: 'text', text: JSON.stringify(result) }],
      structuredContent: result,
    }
    await auditCompletion(execution, invocationId, startedAt, mode, 'ok', result)
    return response
  } catch (error) {
    await audit({
      event: execution.signal.aborted ? 'mcp.tool.cancelled' : 'mcp.tool.failed',
      invocationId,
      server: execution.server,
      tool: execution.tool,
      traceId: execution.traceId,
      mode,
      startedAt,
      endedAt: new Date().toISOString(),
      error: errorMessage(error),
      pid: process.pid,
    })
    throw error
  }
}

function readMode(): McpTestMode {
  const mode = process.env.AGENTPACK_MCP_TEST_MODE ?? 'normal'
  if (!['normal', 'error', 'malformed', 'not-found', 'timeout'].includes(mode)) {
    throw new Error(`Unknown AGENTPACK_MCP_TEST_MODE: ${mode}`)
  }
  return mode as McpTestMode
}

function readDelay(mode: McpTestMode): number {
  if (mode === 'timeout') return 300_000
  const parsed = Number(process.env.AGENTPACK_MCP_DELAY_MS ?? '0')
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error('AGENTPACK_MCP_DELAY_MS must be a non-negative number')
  return parsed
}

async function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolveDelay, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error('MCP call cancelled'))
      return
    }
    const timer = setTimeout(resolveDelay, milliseconds)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(signal.reason ?? new Error('MCP call cancelled'))
    }, { once: true })
  })
}

async function auditCompletion<T>(
  execution: DomainToolExecution<T>,
  invocationId: string,
  startedAt: string,
  mode: McpTestMode,
  outcome: string,
  result: unknown,
): Promise<void> {
  await audit({
    event: 'mcp.tool.completed',
    invocationId,
    server: execution.server,
    tool: execution.tool,
    traceId: execution.traceId,
    mode,
    outcome,
    startedAt,
    endedAt: new Date().toISOString(),
    result,
    pid: process.pid,
  })
}

async function audit(record: Record<string, unknown>): Promise<void> {
  const path = process.env.AGENTPACK_MCP_AUDIT_PATH
  if (!path) return
  await mkdir(dirname(path), { recursive: true })
  await appendFile(path, `${JSON.stringify(record)}\n`, 'utf8')
}
