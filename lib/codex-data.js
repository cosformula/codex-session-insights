import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { promises as fs } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const MAX_TRANSCRIPT_CHARS = 30000
const USER_TRANSCRIPT_LIMIT = 500
const ASSISTANT_TRANSCRIPT_LIMIT = 180
const FAILURE_SUMMARY_LIMIT = 120
const TASK_AGENT_TOOLS = new Set([
  'spawn_agent',
  'send_input',
  'wait_agent',
  'resume_agent',
  'close_agent',
])

export function resolveCodexHome(explicitHome) {
  if (explicitHome) return path.resolve(explicitHome)
  if (process.env.CODEX_HOME) return path.resolve(process.env.CODEX_HOME)
  return path.join(os.homedir(), '.codex')
}

export async function findStateDatabase(codexHome) {
  const entries = await fs.readdir(codexHome, { withFileTypes: true })
  const matches = []

  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (!/^state_\d+\.sqlite$/.test(entry.name)) continue
    const filePath = path.join(codexHome, entry.name)
    const stat = await fs.stat(filePath)
    matches.push({ filePath, mtimeMs: stat.mtimeMs })
  }

  matches.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return matches[0]?.filePath ?? null
}

export async function loadThreads({
  codexHome,
  sinceEpochSeconds,
  limit,
  includeArchived,
  includeSubagents,
}) {
  const dbPath = await findStateDatabase(codexHome)
  if (!dbPath) {
    throw new Error(`No state_*.sqlite database found in ${codexHome}`)
  }

  const where = []
  if (!includeArchived) where.push('archived = 0')
  if (!includeSubagents) where.push("(agent_role is null or agent_role = '')")
  if (sinceEpochSeconds) where.push(`updated_at >= ${Number(sinceEpochSeconds)}`)

  const sql = [
    'select',
    'id, rollout_path, created_at, updated_at, source, model_provider, cwd,',
    'title, tokens_used, archived, git_branch, cli_version,',
    'first_user_message, model, reasoning_effort, agent_role, agent_nickname, agent_path',
    'from threads',
    where.length ? `where ${where.join(' and ')}` : '',
    'order by updated_at desc',
    limit ? `limit ${Number(limit)}` : '',
    ';',
  ]
    .filter(Boolean)
    .join(' ')

  const { stdout } = await execFileAsync('sqlite3', ['-json', dbPath, sql], {
    maxBuffer: 16 * 1024 * 1024,
  })

  const rows = stdout.trim() ? JSON.parse(stdout) : []
  return rows.map(row => ({
    id: String(row.id),
    rolloutPath: String(row.rollout_path),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    source: String(row.source ?? ''),
    modelProvider: String(row.model_provider ?? ''),
    cwd: String(row.cwd ?? ''),
    title: String(row.title ?? ''),
    tokensUsed: Number(row.tokens_used ?? 0),
    archived: Number(row.archived ?? 0) === 1,
    gitBranch: row.git_branch ? String(row.git_branch) : '',
    cliVersion: row.cli_version ? String(row.cli_version) : '',
    firstUserMessage: row.first_user_message ? String(row.first_user_message) : '',
    model: row.model ? String(row.model) : '',
    reasoningEffort: row.reasoning_effort ? String(row.reasoning_effort) : '',
    agentRole: row.agent_role ? String(row.agent_role) : '',
    agentNickname: row.agent_nickname ? String(row.agent_nickname) : '',
    agentPath: row.agent_path ? String(row.agent_path) : '',
  }))
}

export async function loadRolloutEvents(rolloutPath) {
  const raw = await fs.readFile(rolloutPath, 'utf8')
  const lines = raw.split('\n')
  const events = []

  for (const line of lines) {
    if (!line.trim()) continue
    try {
      events.push(JSON.parse(line))
    } catch {
      // Ignore malformed lines and keep processing the rest of the rollout.
    }
  }

  return events
}

export function filterSubstantiveThreads(threadSummaries) {
  return [...threadSummaries]
    .filter(thread => thread.userMessages >= 2)
    .filter(thread => thread.durationMinutes >= 1)
    .filter(thread => Boolean(String(thread.transcriptForAnalysis || '').trim()))
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
}

function extractAssistantText(messagePayload) {
  if (!messagePayload || !Array.isArray(messagePayload.content)) return ''
  return messagePayload.content
    .map(part => {
      if (typeof part?.text === 'string') return part.text
      if (typeof part?.content === 'string') return part.content
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function extractTokenSnapshot(payload) {
  const total = payload?.info?.total_token_usage
  if (!total) return null
  return {
    inputTokens: Number(total.input_tokens ?? 0),
    cachedInputTokens: Number(total.cached_input_tokens ?? 0),
    outputTokens: Number(total.output_tokens ?? 0),
    reasoningOutputTokens: Number(total.reasoning_output_tokens ?? 0),
    totalTokens: Number(total.total_tokens ?? 0),
  }
}

export function summarizeThread(thread, events) {
  const toolCounts = {}
  const commandKindCounts = {}
  const toolFailures = {}
  const toolErrorCategories = {}
  const userMessageTimestamps = []
  const responseTimesSeconds = []
  const commandFailures = []
  const commandDurationsMs = []
  const commandSamples = []
  const transcriptLines = []
  const filesModified = new Set()
  let userMessages = 0
  let assistantMessages = 0
  let reasoningItems = 0
  let commentaryMessages = 0
  let finalMessages = 0
  let userInterruptions = 0
  let toolErrors = 0
  let usesTaskAgent = false
  let usesMcp = false
  let usesWebSearch = false
  let usesWebFetch = false
  let gitCommits = 0
  let gitPushes = 0
  let linesAdded = 0
  let linesRemoved = 0
  let lastAssistantTimestampMs = null
  let latestTokenSnapshot = null
  let activeToolRun = false
  let lastTranscriptLine = ''

  for (const event of events) {
    const ts = Date.parse(event.timestamp)

    if (event.type === 'event_msg' && event.payload?.type === 'user_message') {
      userMessages += 1
      appendTranscriptLine(
        transcriptLines,
        `[User] ${sanitizeTranscriptText(event.payload.message, USER_TRANSCRIPT_LIMIT)}`,
        value => {
          lastTranscriptLine = value
        },
        lastTranscriptLine,
      )
      if (Number.isFinite(ts)) {
        userMessageTimestamps.push(ts)
        const gapSeconds =
          lastAssistantTimestampMs === null ? null : (ts - lastAssistantTimestampMs) / 1000
        if (gapSeconds !== null && gapSeconds > 2 && gapSeconds < 3600) {
          responseTimesSeconds.push(gapSeconds)
        }
        if (activeToolRun && gapSeconds !== null && gapSeconds < 180) {
          userInterruptions += 1
        }
      }
      activeToolRun = false
      continue
    }

    if (event.type === 'event_msg' && event.payload?.type === 'token_count') {
      const snapshot = extractTokenSnapshot(event.payload)
      if (snapshot) latestTokenSnapshot = snapshot
      continue
    }

    if (event.type === 'event_msg' && event.payload?.type === 'exec_command_end') {
      const payload = event.payload
      const parsed = Array.isArray(payload.parsed_cmd) ? payload.parsed_cmd[0] : null
      const key =
        typeof parsed?.type === 'string'
          ? parsed.type
          : Array.isArray(payload.command)
            ? payload.command[2] ?? payload.command[0]
            : 'exec_command'
      const commandText = Array.isArray(payload.command) ? payload.command.join(' ') : ''
      commandKindCounts[key] = (commandKindCounts[key] || 0) + 1
      if (/\bgit\s+commit\b/.test(commandText)) gitCommits += 1
      if (/\bgit\s+push\b/.test(commandText)) gitPushes += 1
      if (Number(payload.exit_code ?? 0) !== 0) {
        toolFailures[key] = (toolFailures[key] || 0) + 1
        toolErrorCategories[key] = (toolErrorCategories[key] || 0) + 1
        toolErrors += 1
        const failureSummary =
          sanitizeTranscriptText(payload.aggregated_output, FAILURE_SUMMARY_LIMIT) ||
          sanitizeTranscriptText(commandText, FAILURE_SUMMARY_LIMIT)
        commandFailures.push({
          command: commandText,
          exitCode: Number(payload.exit_code ?? 0),
          output: failureSummary,
        })
      }
      const duration = payload.duration
      if (duration) {
        const ms = Number(duration.secs ?? 0) * 1000 + Number(duration.nanos ?? 0) / 1e6
        if (ms > 0) commandDurationsMs.push(ms)
      }
      if (commandSamples.length < 8) {
        commandSamples.push({
          command: commandText,
          status: String(payload.status ?? ''),
          exitCode: Number(payload.exit_code ?? 0),
        })
      }
      if (Number(payload.exit_code ?? 0) !== 0) {
        appendTranscriptLine(
          transcriptLines,
          `[Command failed: ${key}] exit=${Number(payload.exit_code ?? 0)}`,
          value => {
            lastTranscriptLine = value
          },
          lastTranscriptLine,
        )
      }
      activeToolRun = true
      continue
    }

    if (event.type !== 'response_item') continue
    const payload = event.payload

    if (payload?.type === 'function_call') {
      const name = String(payload.name ?? 'function_call')
      toolCounts[name] = (toolCounts[name] || 0) + 1
      markToolUsage(name, {
        usesTaskAgent: value => {
          if (value) usesTaskAgent = true
        },
        usesMcp: value => {
          if (value) usesMcp = true
        },
        usesWebSearch: value => {
          if (value) usesWebSearch = true
        },
        usesWebFetch: value => {
          if (value) usesWebFetch = true
        },
      })
      appendTranscriptLine(
        transcriptLines,
        `[Tool: ${name}]`,
        value => {
          lastTranscriptLine = value
        },
        lastTranscriptLine,
      )
      activeToolRun = true

      if (name === 'apply_patch') {
        const patchStats = parseApplyPatchStats(payload.arguments)
        linesAdded += patchStats.linesAdded
        linesRemoved += patchStats.linesRemoved
        for (const filePath of patchStats.filesModified) {
          filesModified.add(filePath)
        }
      }
      continue
    }

    if (payload?.type === 'custom_tool_call') {
      const name = String(payload.name ?? 'custom_tool_call')
      toolCounts[name] = (toolCounts[name] || 0) + 1
      if (payload.status && payload.status !== 'completed') {
        toolFailures[name] = (toolFailures[name] || 0) + 1
        toolErrorCategories[name] = (toolErrorCategories[name] || 0) + 1
        toolErrors += 1
      }
      if (name === 'apply_patch') {
        const patchStats = parseApplyPatchStats(payload.input)
        linesAdded += patchStats.linesAdded
        linesRemoved += patchStats.linesRemoved
        for (const filePath of patchStats.filesModified) {
          filesModified.add(filePath)
        }
      }
      appendTranscriptLine(
        transcriptLines,
        `[Tool: ${name}]`,
        value => {
          lastTranscriptLine = value
        },
        lastTranscriptLine,
      )
      if (payload.status && payload.status !== 'completed') {
        appendTranscriptLine(
          transcriptLines,
          `[Tool failed: ${name}] status=${sanitizeTranscriptText(payload.status, 40)}`,
          value => {
            lastTranscriptLine = value
          },
          lastTranscriptLine,
        )
      }
      activeToolRun = true
      continue
    }

    if (payload?.type === 'function_call_output') {
      activeToolRun = true
      continue
    }

    if (payload?.type === 'reasoning') {
      reasoningItems += 1
      continue
    }

    if (payload?.type === 'message' && payload.role === 'assistant') {
      assistantMessages += 1
      const phase = String(payload.phase ?? 'assistant')
      if (phase === 'commentary') commentaryMessages += 1
      if (phase === 'final_answer') finalMessages += 1
      if (Number.isFinite(ts)) {
        lastAssistantTimestampMs = ts
      }
      const text = extractAssistantText(payload)
      if (text) {
        appendTranscriptLine(
          transcriptLines,
          `[Assistant] ${sanitizeTranscriptText(text, ASSISTANT_TRANSCRIPT_LIMIT)}`,
          value => {
            lastTranscriptLine = value
          },
          lastTranscriptLine,
        )
      }
      activeToolRun = phase !== 'final_answer'
    }
  }

  const startedAtMs = events.length ? Date.parse(events[0].timestamp) : thread.createdAt * 1000
  const endedAtMs = events.length
    ? Date.parse(events[events.length - 1].timestamp)
    : thread.updatedAt * 1000
  const durationMinutes = Math.max(
    0,
    Math.round(((endedAtMs - startedAtMs) / 1000 / 60) * 10) / 10,
  )

  const sortedUserTs = [...userMessageTimestamps].sort((a, b) => a - b)
  const activeHours = sortedUserTs.map(tsMs => new Date(tsMs).getHours())

  return {
    id: thread.id,
    title: thread.title,
    firstUserMessage: sanitizeTranscriptText(thread.firstUserMessage, 1200),
    cwd: thread.cwd,
    model: thread.model,
    modelProvider: thread.modelProvider,
    createdAt: new Date(thread.createdAt * 1000).toISOString(),
    updatedAt: new Date(thread.updatedAt * 1000).toISOString(),
    durationMinutes,
    userMessages,
    assistantMessages,
    commentaryMessages,
    finalMessages,
    reasoningItems,
    toolCounts,
    commandKindCounts,
    toolFailures,
    totalToolCalls: Object.values(toolCounts).reduce((sum, count) => sum + count, 0),
    totalCommandFailures: commandFailures.length,
    commandFailures: commandFailures.slice(0, 8),
    commandSamples,
    averageCommandDurationMs: average(commandDurationsMs),
    medianResponseTimeSeconds: median(responseTimesSeconds),
    averageResponseTimeSeconds: average(responseTimesSeconds),
    activeHours,
    userMessageTimestamps: sortedUserTs.map(tsMs => new Date(tsMs).toISOString()),
    transcriptForAnalysis: clampTranscript(transcriptLines.join('\n')),
    gitCommits,
    gitPushes,
    userInterruptions,
    toolErrors,
    toolErrorCategories,
    usesTaskAgent,
    usesMcp,
    usesWebSearch,
    usesWebFetch,
    linesAdded,
    linesRemoved,
    filesModified: filesModified.size,
    tokenUsage: latestTokenSnapshot ?? {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: thread.tokensUsed,
    },
  }
}

export async function collectThreadSummaries(options) {
  const threads = await loadThreads(options)
  const cacheDir = resolveSessionMetaCacheDir(options.cacheDir)
  await fs.mkdir(cacheDir, { recursive: true })

  const summaries = []
  for (const thread of threads) {
    const summary = await loadCachedOrFreshSummary(thread, cacheDir)
    summaries.push(summary)
  }
  return summaries
}

async function loadCachedOrFreshSummary(thread, cacheDir) {
  const cachePath = path.join(cacheDir, `${thread.id}.json`)
  const versionKey = hashObject({
    id: thread.id,
    rolloutPath: thread.rolloutPath,
    updatedAt: thread.updatedAt,
    tokensUsed: thread.tokensUsed,
    model: thread.model,
    firstUserMessage: thread.firstUserMessage,
  })
  const cached = await readJson(cachePath)
  if (cached?.versionKey === versionKey && cached?.summary) {
    return cached.summary
  }

  let summary
  try {
    const events = await loadRolloutEvents(thread.rolloutPath)
    summary = summarizeThread(thread, events)
  } catch (error) {
    summary = buildFallbackSummary(thread, error)
  }

  await fs.writeFile(cachePath, JSON.stringify({ versionKey, summary }, null, 2), 'utf8')
  return summary
}

function buildFallbackSummary(thread, error) {
  return {
    id: thread.id,
    title: thread.title,
    firstUserMessage: sanitizeTranscriptText(thread.firstUserMessage, 1200),
    cwd: thread.cwd,
    model: thread.model,
    modelProvider: thread.modelProvider,
    createdAt: new Date(thread.createdAt * 1000).toISOString(),
    updatedAt: new Date(thread.updatedAt * 1000).toISOString(),
    durationMinutes: 0,
    userMessages: 0,
    assistantMessages: 0,
    commentaryMessages: 0,
    finalMessages: 0,
    reasoningItems: 0,
    toolCounts: {},
    commandKindCounts: {},
    toolFailures: {},
    totalToolCalls: 0,
    totalCommandFailures: 0,
    commandFailures: [
      {
        command: 'rollout_read',
        exitCode: 1,
        output: error instanceof Error ? error.message : String(error),
      },
    ],
    commandSamples: [],
    averageCommandDurationMs: 0,
    medianResponseTimeSeconds: 0,
    averageResponseTimeSeconds: 0,
    activeHours: [],
    userMessageTimestamps: [],
    transcriptForAnalysis: '',
    gitCommits: 0,
    gitPushes: 0,
    userInterruptions: 0,
    toolErrors: 1,
    toolErrorCategories: { rollout_read: 1 },
    usesTaskAgent: false,
    usesMcp: false,
    usesWebSearch: false,
    usesWebFetch: false,
    linesAdded: 0,
    linesRemoved: 0,
    filesModified: 0,
    tokenUsage: {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: thread.tokensUsed,
    },
  }
}

function parseApplyPatchStats(rawPatch) {
  const filesModified = new Set()
  let linesAdded = 0
  let linesRemoved = 0

  const patch = String(rawPatch ?? '')
  for (const line of patch.split('\n')) {
    if (
      line.startsWith('*** Update File: ') ||
      line.startsWith('*** Add File: ') ||
      line.startsWith('*** Delete File: ')
    ) {
      const filePath = line.replace(/^\*\*\* (?:Update|Add|Delete) File: /, '').trim()
      if (filePath) filesModified.add(filePath)
      continue
    }
    if (line.startsWith('+') && !line.startsWith('+++')) {
      linesAdded += 1
      continue
    }
    if (line.startsWith('-') && !line.startsWith('---')) {
      linesRemoved += 1
    }
  }

  return { filesModified, linesAdded, linesRemoved }
}

function markToolUsage(name, setters) {
  if (TASK_AGENT_TOOLS.has(name)) {
    setters.usesTaskAgent(true)
  }
  if (name.startsWith('mcp__')) {
    setters.usesMcp(true)
  }
  if (name.startsWith('web.')) {
    if (name.includes('search_query') || name.includes('image_query')) {
      setters.usesWebSearch(true)
    }
    if (
      name.includes('open') ||
      name.includes('click') ||
      name.includes('find') ||
      name.includes('screenshot')
    ) {
      setters.usesWebFetch(true)
    }
  }
}

function clampTranscript(text) {
  const clean = String(text).trim()
  if (clean.length <= MAX_TRANSCRIPT_CHARS) return clean
  return `${clean.slice(0, MAX_TRANSCRIPT_CHARS)}\n[Transcript truncated]`
}

function appendTranscriptLine(lines, line, setLastLine, lastLine) {
  const clean = String(line ?? '').trim()
  if (!clean || clean === lastLine) return
  lines.push(clean)
  setLastLine(clean)
}

function sanitizeTranscriptText(value, limit) {
  const text = String(value ?? '')
    .replace(/<system_instruction>[\s\S]*?<\/system_instruction>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!text) return ''
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}...`
}

function resolveSessionMetaCacheDir(explicitRoot) {
  const root = explicitRoot
    ? path.resolve(explicitRoot)
    : path.join(os.homedir(), '.codex-insights-cache')
  return path.join(root, 'session-meta')
}

function hashObject(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'))
  } catch {
    return null
  }
}

function average(values) {
  if (!values.length) return 0
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function median(values) {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}
