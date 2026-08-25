import { rm } from 'node:fs/promises'
import { resolve } from 'node:path'

for (const relative of ['dist', '.agentpack', '.runtime', 'coverage']) {
  await rm(resolve(process.cwd(), relative), { recursive: true, force: true })
}
