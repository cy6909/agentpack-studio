import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { AgentPackError } from '../core/errors.js'
import { isJsonObject, parseJsonObject, type JsonObject } from '../core/json.js'
import type { CompilationTarget } from '../core/target.js'

export interface ModelProbeEvidence {
  target: string
  endpoint: string
  model: string
  observedAt: string
  modelListed: boolean
  toolCalling: {
    passed: boolean
    toolName: string
    arguments: JsonObject
  }
  structuredOutput: {
    passed: boolean
    value: JsonObject
  }
}

export async function probeModel(target: CompilationTarget, evidencePath: string): Promise<ModelProbeEvidence> {
  const runtime = target.spec.runtime
  const apiKey = process.env[runtime.apiKeyEnv]
  if (!apiKey) throw new AgentPackError('RUNTIME_START_FAILED', `Missing ${runtime.apiKeyEnv} for model probe`)
  const baseUrl = runtime.baseUrl.replace(/\/$/, '')
  const headers = { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }

  const modelsResponse = await fetch(`${baseUrl}/models`, {
    headers,
    signal: AbortSignal.timeout(30_000),
  })
  if (!modelsResponse.ok) throw new AgentPackError('RUNTIME_START_FAILED', `GET /models returned HTTP ${modelsResponse.status}`)
  const models: unknown = await modelsResponse.json()
  const modelListed = isJsonObject(models)
    && Array.isArray(models.data)
    && models.data.some(entry => isJsonObject(entry) && entry.id === runtime.model)
  if (!modelListed) throw new AgentPackError('RUNTIME_START_FAILED', `Configured Qwen model is absent from GET /models: ${runtime.model}`, models)

  const probeToken = randomUUID()
  const toolResponse = await chatCompletion(baseUrl, headers, {
    model: runtime.model,
    messages: [{ role: 'user', content: `Call echo_probe with token exactly ${probeToken}. Do not answer in text.` }],
    tools: [{
      type: 'function',
      function: {
        name: 'echo_probe',
        description: 'Return an exact capability probe token.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['token'],
          properties: { token: { type: 'string' } },
        },
      },
    }],
    tool_choice: { type: 'function', function: { name: 'echo_probe' } },
    temperature: 0,
    max_tokens: 256,
    chat_template_kwargs: { enable_thinking: false },
  })
  const toolCall = firstToolCall(toolResponse)
  const toolArguments = parseJsonObject(toolCall.arguments, 'model probe tool arguments')
  if (toolCall.name !== 'echo_probe' || toolArguments.token !== probeToken) {
    throw new AgentPackError('RUNTIME_START_FAILED', 'Qwen tool-calling probe returned the wrong call', { toolCall, toolArguments })
  }

  const structuredResponse = await chatCompletion(baseUrl, headers, {
    model: runtime.model,
    messages: [{ role: 'user', content: `Return JSON with ok=true and token exactly ${probeToken}.` }],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'agentpack_probe',
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['ok', 'token'],
          properties: { ok: { const: true }, token: { const: probeToken } },
        },
      },
    },
    temperature: 0,
    max_tokens: 256,
    chat_template_kwargs: { enable_thinking: false },
  })
  const structuredText = firstAssistantText(structuredResponse)
  const structuredValue = parseJsonObject(structuredText, 'model probe structured output')
  if (structuredValue.ok !== true || structuredValue.token !== probeToken) {
    throw new AgentPackError('RUNTIME_START_FAILED', 'Qwen structured-output probe returned the wrong value', structuredValue)
  }

  const evidence: ModelProbeEvidence = {
    target: target.metadata.name,
    endpoint: baseUrl,
    model: runtime.model,
    observedAt: new Date().toISOString(),
    modelListed: true,
    toolCalling: { passed: true, toolName: toolCall.name, arguments: toolArguments },
    structuredOutput: { passed: true, value: structuredValue },
  }
  const absolutePath = resolve(evidencePath)
  await mkdir(dirname(absolutePath), { recursive: true })
  await writeFile(absolutePath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
  return evidence
}

async function chatCompletion(baseUrl: string, headers: Record<string, string>, body: unknown): Promise<JsonObject> {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  })
  const text = await response.text()
  if (!response.ok) {
    throw new AgentPackError('RUNTIME_START_FAILED', `POST /chat/completions returned HTTP ${response.status}`, { body: text })
  }
  return parseJsonObject(text, 'model probe HTTP response')
}

function firstToolCall(response: JsonObject): { name: string; arguments: string } {
  const choices = response.choices
  if (!Array.isArray(choices) || !isJsonObject(choices[0]) || !isJsonObject(choices[0].message)) {
    throw new AgentPackError('RUNTIME_START_FAILED', 'Tool probe response has no assistant message', response)
  }
  const calls = choices[0].message.tool_calls
  if (!Array.isArray(calls) || !isJsonObject(calls[0]) || !isJsonObject(calls[0].function)) {
    throw new AgentPackError('RUNTIME_START_FAILED', 'Tool probe response has no function tool call', response)
  }
  const fn = calls[0].function
  if (typeof fn.name !== 'string' || typeof fn.arguments !== 'string') {
    throw new AgentPackError('RUNTIME_START_FAILED', 'Tool probe function call is malformed', calls[0])
  }
  return { name: fn.name, arguments: fn.arguments }
}

function firstAssistantText(response: JsonObject): string {
  const choices = response.choices
  if (!Array.isArray(choices) || !isJsonObject(choices[0]) || !isJsonObject(choices[0].message)) {
    throw new AgentPackError('RUNTIME_START_FAILED', 'Structured probe response has no assistant message', response)
  }
  const content = choices[0].message.content
  if (typeof content !== 'string') throw new AgentPackError('RUNTIME_START_FAILED', 'Structured probe response has no text content', response)
  return content
}
