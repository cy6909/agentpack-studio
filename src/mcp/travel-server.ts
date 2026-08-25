#!/usr/bin/env node
import { z } from 'zod'
import { allowedTools, connectStdio, createDomainServer, executeDomainTool } from './domain-server.js'
import { ACTIVITIES, DESTINATIONS, TRAVEL_SOURCE_VERSION } from './travel-fixtures.js'

const server = createDomainServer('travel')
const allow = allowedTools(['get_destination_facts', 'get_activity_facts'])
const destinationId = z.enum(['hangzhou-west-lake', 'sanya-bay'])
const activityId = z.enum(['boat-ride', 'waterfront-walk', 'taxi-transfer', 'garden-visit', 'museum-visit'])

if (allow.has('get_destination_facts')) {
  server.registerTool('get_destination_facts', {
    title: 'Get destination facts',
    description: 'Read authoritative destination climate, fact ids and operational notes for a family trip plan.',
    inputSchema: {
      destinationId,
      traceId: z.string().uuid(),
    },
    outputSchema: {
      destination: z.object({
        id: z.string(),
        name: z.string(),
        climate: z.enum(['mild', 'warm']),
        factIds: z.array(z.string()),
        notes: z.array(z.string()),
      }),
      sourceVersion: z.literal(TRAVEL_SOURCE_VERSION),
    },
  }, async (args, extra) => executeDomainTool({
    server: 'travel',
    tool: 'get_destination_facts',
    args,
    traceId: args.traceId,
    signal: extra.signal,
    run: () => ({ destination: DESTINATIONS[args.destinationId], sourceVersion: TRAVEL_SOURCE_VERSION }),
  }))
}

if (allow.has('get_activity_facts')) {
  server.registerTool('get_activity_facts', {
    title: 'Get activity facts',
    description: 'Read authoritative duration, indoor status and fact ids for requested trip activities.',
    inputSchema: {
      destinationId,
      activityIds: z.array(activityId).min(1),
      traceId: z.string().uuid(),
    },
    outputSchema: {
      destinationId: z.string(),
      activities: z.array(z.object({
        id: z.string(),
        durationMinutes: z.number().int().positive(),
        indoor: z.boolean(),
        factId: z.string(),
      })),
      sourceVersion: z.literal(TRAVEL_SOURCE_VERSION),
    },
  }, async (args, extra) => executeDomainTool({
    server: 'travel',
    tool: 'get_activity_facts',
    args,
    traceId: args.traceId,
    signal: extra.signal,
    run: () => ({
      destinationId: args.destinationId,
      activities: args.activityIds.map(id => ACTIVITIES[id]),
      sourceVersion: TRAVEL_SOURCE_VERSION,
    }),
  }))
}

await connectStdio(server)
