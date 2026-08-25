import { createRequire } from 'node:module'
import type { ErrorObject, ValidateFunction } from 'ajv/dist/2020.js'
import { AgentPackError } from './errors.js'
import type { JsonObject } from './json.js'

const require = createRequire(import.meta.url)
const Ajv2020 = require('ajv/dist/2020.js') as typeof import('ajv/dist/2020.js').default
const addFormats = require('ajv-formats') as typeof import('ajv-formats').default
const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  validateFormats: true,
})
addFormats(ajv)

export class JsonSchemaValidator {
  readonly #input: ValidateFunction
  readonly #output: ValidateFunction

  constructor(inputSchema: JsonObject, outputSchema: JsonObject) {
    this.#input = ajv.compile(inputSchema)
    this.#output = ajv.compile(outputSchema)
  }

  validateInput(value: unknown): asserts value is JsonObject {
    if (!this.#input(value)) {
      throw new AgentPackError('INPUT_INVALID', 'Agent Pack input schema validation failed', formatErrors(this.#input.errors))
    }
  }

  validateOutput(value: unknown): asserts value is JsonObject {
    if (!this.#output(value)) {
      throw new AgentPackError('OUTPUT_INVALID', 'Agent Pack output schema validation failed', formatErrors(this.#output.errors))
    }
  }
}

function formatErrors(errors: ErrorObject[] | null | undefined): JsonObject[] {
  return (errors ?? []).map(error => ({
    instancePath: error.instancePath,
    schemaPath: error.schemaPath,
    keyword: error.keyword,
    message: error.message ?? 'validation error',
  }))
}
