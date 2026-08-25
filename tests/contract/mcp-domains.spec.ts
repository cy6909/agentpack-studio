import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { afterEach, describe, expect, it } from 'vitest'

interface DomainClient {
  client: Client
  auditPath: string
  close(): Promise<void>
}

const clients: DomainClient[] = []
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(clients.splice(0).map(entry => entry.close()))
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('independent domain MCP programs', () => {
  it('exposes only Wardrobe tools and returns authoritative inventory facts', async () => {
    const domain = await startDomain('wardrobe', 'list_candidates,get_item_details')
    const tools = await domain.client.listTools()
    expect(tools.tools.map(tool => tool.name)).toEqual(['list_candidates', 'get_item_details'])
    const traceId = randomUUID()
    const candidates = await domain.client.callTool({
      name: 'list_candidates',
      arguments: { profileId: 'p-aria', occasion: 'client-meeting', climate: 'mild', traceId },
    })
    expect(candidates.structuredContent).toMatchObject({ sourceVersion: 'wardrobe-fixture@1' })
    const details = await domain.client.callTool({
      name: 'get_item_details', arguments: { itemIds: ['w-top-silk-01', 'w-bottom-trouser-01'], traceId },
    })
    expect(details.structuredContent).toMatchObject({ items: [{ id: 'w-top-silk-01' }, { id: 'w-bottom-trouser-01' }] })
  })

  it('executes Parenting safety rules and Travel facts through different processes', async () => {
    const parenting = await startDomain('parenting', 'list_applicable_rules,get_rule_details')
    const travel = await startDomain('travel', 'get_destination_facts,get_activity_facts')
    const parentingTrace = randomUUID()
    const travelTrace = randomUUID()
    const rules = await parenting.client.callTool({
      name: 'list_applicable_rules',
      arguments: { childAge: 5, activityIds: ['boat-ride', 'taxi-transfer'], traceId: parentingTrace },
    })
    expect(rules.structuredContent).toMatchObject({ ruleIds: ['rule-water-arm-reach', 'rule-vehicle-restraint'] })
    const facts = await travel.client.callTool({
      name: 'get_destination_facts', arguments: { destinationId: 'hangzhou-west-lake', traceId: travelTrace },
    })
    expect(facts.structuredContent).toMatchObject({ destination: { id: 'hangzhou-west-lake' }, sourceVersion: 'travel-facts@1' })
    expect((await parenting.client.listTools()).tools.map(tool => tool.name)).not.toContain('get_destination_facts')
    expect((await travel.client.listTools()).tools.map(tool => tool.name)).not.toContain('list_applicable_rules')
  })

  it('propagates abort into a delayed MCP request and records cancellation', async () => {
    const domain = await startDomain('wardrobe', 'list_candidates', { AGENTPACK_MCP_TEST_MODE: 'timeout' })
    const traceId = randomUUID()
    const controller = new AbortController()
    const call = domain.client.request(
      {
        method: 'tools/call',
        params: { name: 'list_candidates', arguments: { profileId: 'p-aria', occasion: 'commute', climate: 'cool', traceId } },
      },
      CallToolResultSchema,
      { signal: controller.signal, timeout: 30_000 },
    )
    setTimeout(() => controller.abort(), 100)
    await expect(call).rejects.toThrow()
    await waitForAudit(domain.auditPath, record => record.event === 'mcp.tool.cancelled' && record.traceId === traceId)
  })

  it('keeps concurrent traces isolated in the MCP audit', async () => {
    const domain = await startDomain('travel', 'get_destination_facts')
    const traces = [randomUUID(), randomUUID()]
    await Promise.all(traces.map(traceId => domain.client.callTool({
      name: 'get_destination_facts', arguments: { destinationId: 'hangzhou-west-lake', traceId },
    })))
    const records = await readAudit(domain.auditPath)
    for (const traceId of traces) {
      expect(records.filter(record => record.traceId === traceId && record.outcome === 'ok')).toHaveLength(1)
    }
  })
})

async function startDomain(
  name: 'wardrobe' | 'parenting' | 'travel',
  allow: string,
  extraEnvironment: Record<string, string> = {},
): Promise<DomainClient> {
  const directory = await mkdtemp(join(tmpdir(), `agentpack-mcp-${name}-`))
  temporaryDirectories.push(directory)
  const auditPath = join(directory, 'audit.jsonl')
  const environment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve(`dist/mcp/${name}-server.js`), '--allow', allow],
    env: { ...environment, AGENTPACK_MCP_AUDIT_PATH: auditPath, AGENTPACK_MCP_TEST_MODE: 'normal', ...extraEnvironment },
    cwd: process.cwd(),
    stderr: 'pipe',
  })
  const client = new Client({ name: 'agentpack-contract-test', version: '0.1.0' })
  await client.connect(transport)
  const domain: DomainClient = { client, auditPath, close: () => client.close() }
  clients.push(domain)
  return domain
}

async function readAudit(path: string): Promise<Array<Record<string, unknown>>> {
  return (await readFile(path, 'utf8')).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>)
}

async function waitForAudit(path: string, predicate: (record: Record<string, unknown>) => boolean): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    try {
      if ((await readAudit(path)).some(predicate)) return
    } catch {
      // The first audit append may not have created the file yet.
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 25))
  }
  throw new Error(`Timed out waiting for MCP audit predicate: ${path}`)
}
