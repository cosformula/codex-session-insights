import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'

const DEFAULT_API_BASE = 'https://api.openai.com/v1'

/**
 * @typedef {Object} ModelCallOptions
 * @property {string=} apiKey
 * @property {string=} apiBase
 * @property {string=} codexBin
 * @property {string=} cwd
 * @property {(usage: any) => void=} onUsage
 * @property {string=} usageStage
 * @property {string=} reasoningEffort
 * @property {string=} facetEffort
 * @property {string[]=} fallbackModels
 * @property {(event: any) => void=} onProgress
 */

/**
 * @param {{
 *   provider: string,
 *   model: string,
 *   schemaName: string,
 *   schema: any,
 *   systemPrompt: string,
 *   userPrompt: string,
 *   options?: ModelCallOptions
 * }} param0
 */
export async function callStructuredModel({
  provider,
  model,
  schemaName,
  schema,
  systemPrompt,
  userPrompt,
  options = {},
}) {
  return callWithModelFallback({
    provider,
    model,
    options,
    invoke: async actualModel => {
      if (provider === 'codex-cli') {
        const result = await callCodexCli({
          model: actualModel,
          prompt: buildStructuredPrompt(systemPrompt, userPrompt, schema),
          schema: null,
          options,
        })
        emitUsage(options, provider, actualModel, result.usage)
        return parseFirstJsonObject(result.text)
      }

      if (provider === 'openai') {
        const apiKey = options.apiKey || process.env.OPENAI_API_KEY || ''
        if (!apiKey) {
          throw new Error('OPENAI_API_KEY is required for provider=openai.')
        }
        const data = /** @type {any} */ (await callResponsesApi({
          apiKey,
          apiBase: options.apiBase || DEFAULT_API_BASE,
          body: {
            model: actualModel,
            input: [
              { role: 'developer', content: systemPrompt },
              { role: 'user', content: userPrompt },
            ],
            text: {
              format: {
                type: 'json_schema',
                name: schemaName,
                strict: true,
                schema,
              },
            },
          },
        }))
        emitUsage(options, provider, actualModel, normalizeOpenAiUsage(data.usage))
        return JSON.parse(extractOutputText(data))
      }

      throw new Error(`Unsupported provider "${provider}".`)
    },
  })
}

/**
 * @param {{
 *   provider: string,
 *   model: string,
 *   systemPrompt: string,
 *   userPrompt: string,
 *   options?: ModelCallOptions
 * }} param0
 */
export async function callTextModel({
  provider,
  model,
  systemPrompt,
  userPrompt,
  options = {},
}) {
  return callWithModelFallback({
    provider,
    model,
    options,
    invoke: async actualModel => {
      if (provider === 'codex-cli') {
        const result = await callCodexCli({
          model: actualModel,
          prompt: buildPrompt(systemPrompt, userPrompt),
          schema: null,
          options,
        })
        emitUsage(options, provider, actualModel, result.usage)
        return result.text
      }

      if (provider === 'openai') {
        const apiKey = options.apiKey || process.env.OPENAI_API_KEY || ''
        if (!apiKey) {
          throw new Error('OPENAI_API_KEY is required for provider=openai.')
        }
        const data = /** @type {any} */ (await callResponsesApi({
          apiKey,
          apiBase: options.apiBase || DEFAULT_API_BASE,
          body: {
            model: actualModel,
            input: [
              { role: 'developer', content: systemPrompt },
              { role: 'user', content: userPrompt },
            ],
          },
        }))
        emitUsage(options, provider, actualModel, normalizeOpenAiUsage(data.usage))
        return extractOutputText(data)
      }

      throw new Error(`Unsupported provider "${provider}".`)
    },
  })
}

function buildPrompt(systemPrompt, userPrompt) {
  return `${systemPrompt.trim()}\n\n${userPrompt.trim()}`
}

function buildStructuredPrompt(systemPrompt, userPrompt, schema) {
  return `${systemPrompt.trim()}

${userPrompt.trim()}

RESPOND WITH ONLY A VALID JSON OBJECT matching this schema:
${JSON.stringify(schema, null, 2)}`
}

async function callWithModelFallback({ provider, model, options, invoke }) {
  const candidates = buildModelCandidates(model, options?.fallbackModels)
  let lastError = null

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index]
    try {
      if (candidate !== model) {
        emitModelFallback(options, provider, model, candidate, index)
      }
      return await invoke(candidate)
    } catch (error) {
      lastError = error
      if (index === candidates.length - 1 || !isRetryableModelError(error)) {
        throw error
      }
    }
  }

  throw lastError || new Error(`No model candidate succeeded for ${model}`)
}

async function callCodexCli({ model, prompt, schema, options }) {
  let tempDir = null
  const args = ['exec', '--json', '--skip-git-repo-check', '--ephemeral']

  if (model) {
    args.push('--model', model)
  }

  if (options.reasoningEffort) {
    args.push('-c', `model_reasoning_effort=${JSON.stringify(options.reasoningEffort)}`)
  }

  if (schema) {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-insights-schema-'))
    const schemaPath = path.join(tempDir, 'schema.json')
    await fs.writeFile(schemaPath, JSON.stringify(schema, null, 2), 'utf8')
    args.push('--output-schema', schemaPath)
  }

  args.push('-')

  try {
    const { stdout, stderr, code } = await runProcess(options.codexBin || 'codex', args, {
      cwd: options.cwd || process.cwd(),
      stdin: prompt,
      maxBuffer: 8 * 1024 * 1024,
    })
    if (code !== 0) {
      throw new Error(`codex exec failed (${code}): ${stderr || stdout}`)
    }
    const result = extractCodexExecResult(stdout)
    if (!result.text) {
      throw new Error('codex exec returned no final agent message.')
    }
    return result
  } finally {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true })
    }
  }
}

async function runProcess(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: 'pipe',
      env: process.env,
    })

    let stdout = ''
    let stderr = ''
    let stdoutBytes = 0
    let stderrBytes = 0
    const maxBuffer = options.maxBuffer || 1024 * 1024

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')

    child.stdout.on('data', chunk => {
      stdoutBytes += Buffer.byteLength(chunk)
      if (stdoutBytes > maxBuffer) {
        child.kill('SIGTERM')
        reject(new Error(`${command} stdout exceeded buffer limit`))
        return
      }
      stdout += chunk
    })

    child.stderr.on('data', chunk => {
      stderrBytes += Buffer.byteLength(chunk)
      if (stderrBytes > maxBuffer) {
        child.kill('SIGTERM')
        reject(new Error(`${command} stderr exceeded buffer limit`))
        return
      }
      stderr += chunk
    })

    child.on('error', reject)
    child.on('close', code => resolve({ stdout, stderr, code: code ?? 1 }))

    if (options.stdin) {
      child.stdin.write(options.stdin)
    }
    child.stdin.end()
  })
}

function extractCodexExecResult(stdout) {
  const lines = String(stdout).split('\n')
  let lastText = ''
  let usage = null

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    /** @type {any} */
    let parsed
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (parsed.type === 'item.completed' && parsed.item?.type === 'agent_message') {
      lastText = String(parsed.item.text || '')
      continue
    }
    if (parsed.type === 'turn.completed' && parsed.usage) {
      usage = normalizeCodexUsage(parsed.usage)
    }
  }

  return {
    text: lastText.trim(),
    usage,
  }
}

function parseFirstJsonObject(text) {
  const trimmed = String(text).trim()
  const candidates = []

  if (trimmed) {
    candidates.push(trimmed)
  }

  const extracted = extractFirstBalancedJsonObject(trimmed)
  if (extracted) {
    candidates.push(extracted)
  }

  let lastError = null
  for (const candidate of dedupeStrings(candidates)) {
    try {
      return JSON.parse(candidate)
    } catch (error) {
      lastError = error
    }

    const repaired = escapeControlCharsInJsonStrings(candidate)
    if (repaired !== candidate) {
      try {
        return JSON.parse(repaired)
      } catch (error) {
        lastError = error
      }
    }
  }

  const detail = lastError instanceof Error ? `: ${lastError.message}` : ''
  throw new Error(`Model provider returned no parseable JSON object${detail}`)
}

function extractFirstBalancedJsonObject(text) {
  const source = String(text || '')
  const start = source.indexOf('{')
  if (start === -1) return null

  let depth = 0
  let inString = false
  let escaped = false

  for (let i = start; i < source.length; i += 1) {
    const char = source[i]

    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }

    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{') {
      depth += 1
      continue
    }
    if (char === '}') {
      depth -= 1
      if (depth === 0) {
        return source.slice(start, i + 1)
      }
    }
  }

  return null
}

function escapeControlCharsInJsonStrings(text) {
  let result = ''
  let inString = false
  let escaped = false

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]

    if (inString) {
      if (escaped) {
        result += char
        escaped = false
        continue
      }
      if (char === '\\') {
        result += char
        escaped = true
        continue
      }
      if (char === '"') {
        result += char
        inString = false
        continue
      }

      const code = char.charCodeAt(0)
      if (code <= 0x1f) {
        switch (char) {
          case '\n':
            result += '\\n'
            break
          case '\r':
            result += '\\r'
            break
          case '\t':
            result += '\\t'
            break
          case '\b':
            result += '\\b'
            break
          case '\f':
            result += '\\f'
            break
          default:
            result += `\\u${code.toString(16).padStart(4, '0')}`
            break
        }
        continue
      }

      result += char
      continue
    }

    if (char === '"') {
      inString = true
    }
    result += char
  }

  return result
}

function dedupeStrings(values) {
  return Array.from(new Set(values.filter(Boolean)))
}

function buildModelCandidates(primaryModel, fallbackModels = []) {
  return dedupeStrings([primaryModel, ...fallbackModels])
}

function isRetryableModelError(error) {
  const message = String(error instanceof Error ? error.message : error).toLowerCase()
  return (
    message.includes('model') &&
    (message.includes('not found') ||
      message.includes('not available') ||
      message.includes('unsupported') ||
      message.includes('permission') ||
      message.includes('access') ||
      message.includes('entitled') ||
      message.includes('not allowed') ||
      message.includes('unknown'))
  )
}

function emitModelFallback(options, provider, fromModel, toModel, attempt) {
  if (typeof options?.onProgress === 'function') {
    options.onProgress({
      kind: 'model:fallback',
      provider,
      fromModel,
      toModel,
      attempt,
      stage: options.usageStage || 'unspecified',
    })
  }
}

/**
 * @param {ModelCallOptions} options
 * @param {string} provider
 * @param {string} model
 * @param {any} usage
 */
function emitUsage(options, provider, model, usage) {
  if (!usage || typeof options.onUsage !== 'function') return
  options.onUsage({
    provider,
    model,
    stage: options.usageStage || 'unspecified',
    inputTokens: Number(usage.inputTokens ?? 0),
    cachedInputTokens: Number(usage.cachedInputTokens ?? 0),
    outputTokens: Number(usage.outputTokens ?? 0),
    totalTokens:
      Number(usage.totalTokens ?? 0) ||
      Number(usage.inputTokens ?? 0) +
        Number(usage.cachedInputTokens ?? 0) +
        Number(usage.outputTokens ?? 0),
  })
}

/** @param {any} usage */
function normalizeCodexUsage(usage) {
  return {
    inputTokens: Number(usage.input_tokens ?? 0),
    cachedInputTokens: Number(usage.cached_input_tokens ?? 0),
    outputTokens: Number(usage.output_tokens ?? 0),
    totalTokens:
      Number(usage.total_tokens ?? 0) ||
      Number(usage.input_tokens ?? 0) +
        Number(usage.cached_input_tokens ?? 0) +
        Number(usage.output_tokens ?? 0),
  }
}

/** @param {any} usage */
function normalizeOpenAiUsage(usage) {
  if (!usage) return null
  const inputTokens = Number(
    usage.input_tokens ?? usage.inputTokens ?? usage.prompt_tokens ?? 0,
  )
  const cachedInputTokens = Number(
    usage.input_tokens_details?.cached_tokens ??
      usage.cached_input_tokens ??
      usage.cachedInputTokens ??
      0,
  )
  const outputTokens = Number(
    usage.output_tokens ?? usage.outputTokens ?? usage.completion_tokens ?? 0,
  )
  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    totalTokens:
      Number(usage.total_tokens ?? usage.totalTokens ?? 0) ||
      inputTokens + cachedInputTokens + outputTokens,
  }
}

/**
 * @param {{ apiKey: string, apiBase: string, body: any }} param0
 * @returns {Promise<any>}
 */
async function callResponsesApi({ apiKey, apiBase, body }) {
  const response = await fetch(`${apiBase}/responses`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    const bodyText = await response.text()
    throw new Error(`OpenAI Responses API failed (${response.status}): ${bodyText}`)
  }

  return response.json()
}

/** @param {any} data */
function extractOutputText(data) {
  if (typeof data.output_text === 'string' && data.output_text) {
    return data.output_text
  }

  if (Array.isArray(data.output)) {
    for (const item of data.output) {
      if (!Array.isArray(item.content)) continue
      for (const part of item.content) {
        if (typeof part.text === 'string' && part.text) {
          return part.text
        }
      }
    }
  }

  throw new Error('No output text returned from model provider')
}

export const __test = {
  extractCodexExecResult,
  parseFirstJsonObject,
  normalizeCodexUsage,
  normalizeOpenAiUsage,
  buildModelCandidates,
  isRetryableModelError,
}
