#!/usr/bin/env node
import { z } from 'zod'
import { allowedTools, connectStdio, createDomainServer, executeDomainTool } from './domain-server.js'
import { applicableRules, PARENTING_RULES, PARENTING_SOURCE_VERSION } from './parenting-fixtures.js'

const server = createDomainServer('parenting')
const allow = allowedTools(['list_applicable_rules', 'get_rule_details'])
const activityId = z.enum(['boat-ride', 'waterfront-walk', 'taxi-transfer', 'garden-visit', 'museum-visit'])

if (allow.has('list_applicable_rules')) {
  server.registerTool('list_applicable_rules', {
    title: 'List applicable child safety rules',
    description: 'Read all safety rule ids applicable to a child age and planned activity ids. Call before making a parenting decision.',
    inputSchema: {
      childAge: z.number().int().min(0).max(17),
      activityIds: z.array(activityId).min(1),
      traceId: z.string().uuid(),
    },
    outputSchema: {
      ruleIds: z.array(z.string()),
      sourceVersion: z.literal(PARENTING_SOURCE_VERSION),
    },
  }, async (args, extra) => executeDomainTool({
    server: 'parenting',
    tool: 'list_applicable_rules',
    args,
    traceId: args.traceId,
    signal: extra.signal,
    run: () => ({
      ruleIds: applicableRules(args.childAge, args.activityIds).map(rule => rule.id),
      sourceVersion: PARENTING_SOURCE_VERSION,
    }),
  }))
}

if (allow.has('get_rule_details')) {
  server.registerTool('get_rule_details', {
    title: 'Get child safety rule details',
    description: 'Read severity, mandatory constraint and citation for rule ids. Every high-severity applicable rule must appear in the answer.',
    inputSchema: {
      ruleIds: z.array(z.string()).min(1),
      traceId: z.string().uuid(),
    },
    outputSchema: {
      rules: z.array(z.object({
        id: z.string(),
        severity: z.enum(['low', 'medium', 'high']),
        activityIds: z.array(z.string()),
        constraint: z.string(),
        citation: z.string(),
      })),
      sourceVersion: z.literal(PARENTING_SOURCE_VERSION),
    },
  }, async (args, extra) => executeDomainTool({
    server: 'parenting',
    tool: 'get_rule_details',
    args,
    traceId: args.traceId,
    signal: extra.signal,
    run: () => {
      const rules = args.ruleIds.map(id => PARENTING_RULES.find(rule => rule.id === id))
      const missing = args.ruleIds.filter((_, index) => !rules[index])
      if (missing.length > 0) throw new Error(`Parenting rule not found: ${missing.join(', ')}`)
      return {
        rules: rules.map(rule => ({
          id: rule!.id,
          severity: rule!.severity,
          activityIds: rule!.activityIds,
          constraint: rule!.constraint,
          citation: rule!.citation,
        })),
        sourceVersion: PARENTING_SOURCE_VERSION,
      }
    },
  }))
}

await connectStdio(server)
