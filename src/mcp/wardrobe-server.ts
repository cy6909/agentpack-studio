#!/usr/bin/env node
import { z } from 'zod'
import { allowedTools, connectStdio, createDomainServer, executeDomainTool } from './domain-server.js'
import { WARDROBE_ITEMS, WARDROBE_SOURCE_VERSION, wardrobeCandidates } from './wardrobe-fixtures.js'

const server = createDomainServer('wardrobe')
const allow = allowedTools(['list_candidates', 'get_item_details'])

if (allow.has('list_candidates')) {
  server.registerTool('list_candidates', {
    title: 'List wardrobe candidates',
    description: 'Read the authoritative candidate item ids for one profile, occasion and climate. Call before selecting an outfit.',
    inputSchema: {
      profileId: z.string().min(1),
      occasion: z.enum(['commute', 'client-meeting', 'family-trip']),
      climate: z.enum(['cool', 'mild', 'warm']),
      traceId: z.string().uuid(),
    },
    outputSchema: {
      candidateIds: z.array(z.string()).min(1),
      sourceVersion: z.literal(WARDROBE_SOURCE_VERSION),
    },
  }, async (args, extra) => executeDomainTool({
    server: 'wardrobe',
    tool: 'list_candidates',
    args,
    traceId: args.traceId,
    signal: extra.signal,
    run: () => ({
      candidateIds: wardrobeCandidates(args.occasion, args.climate),
      sourceVersion: WARDROBE_SOURCE_VERSION,
    }),
  }))
}

if (allow.has('get_item_details')) {
  server.registerTool('get_item_details', {
    title: 'Get wardrobe item details',
    description: 'Read authoritative details and availability for candidate wardrobe item ids. Never recommend an unavailable item.',
    inputSchema: {
      itemIds: z.array(z.string()).min(1).max(12),
      traceId: z.string().uuid(),
    },
    outputSchema: {
      items: z.array(z.object({
        id: z.string(),
        category: z.enum(['top', 'bottom', 'outerwear', 'shoes']),
        color: z.string(),
        warmth: z.enum(['light', 'medium', 'warm']),
        formality: z.enum(['casual', 'smart', 'formal']),
        material: z.string(),
        available: z.boolean(),
      })),
      sourceVersion: z.literal(WARDROBE_SOURCE_VERSION),
    },
  }, async (args, extra) => executeDomainTool({
    server: 'wardrobe',
    tool: 'get_item_details',
    args,
    traceId: args.traceId,
    signal: extra.signal,
    run: () => {
      const missing = args.itemIds.filter(id => !WARDROBE_ITEMS[id])
      if (missing.length > 0) throw new Error(`Wardrobe item not found: ${missing.join(', ')}`)
      return {
        items: args.itemIds.map(id => WARDROBE_ITEMS[id]!),
        sourceVersion: WARDROBE_SOURCE_VERSION,
      }
    },
  }))
}

await connectStdio(server)
