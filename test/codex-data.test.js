import test from 'node:test'
import assert from 'node:assert/strict'
import { filterSubstantiveThreads, summarizeThread } from '../lib/codex-data.js'

test('summarizeThread extracts tool, patch, git, and failure signals', () => {
  const thread = {
    id: 'thread-1',
    title: 'Fix rollout parser',
    firstUserMessage: 'Please fix the rollout parser and commit the change.',
    cwd: '/repo/project',
    model: 'gpt-5.4',
    modelProvider: 'openai',
    createdAt: Date.parse('2026-04-01T10:00:00Z') / 1000,
    updatedAt: Date.parse('2026-04-01T10:03:00Z') / 1000,
    tokensUsed: 999,
  }

  const patch = [
    '*** Begin Patch',
    '*** Update File: src/parser.js',
    '-const broken = true',
    '+const broken = false',
    '+export const fixed = true',
    '*** End Patch',
  ].join('\n')

  const events = [
    {
      timestamp: '2026-04-01T10:00:00Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: 'Please fix the rollout parser.' },
    },
    {
      timestamp: '2026-04-01T10:00:10Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        phase: 'commentary',
        content: [{ text: 'I am checking the parser flow.' }],
      },
    },
    {
      timestamp: '2026-04-01T10:00:20Z',
      type: 'response_item',
      payload: { type: 'function_call', name: 'apply_patch', arguments: patch },
    },
    {
      timestamp: '2026-04-01T10:00:30Z',
      type: 'response_item',
      payload: { type: 'function_call', name: 'spawn_agent', arguments: '{}' },
    },
    {
      timestamp: '2026-04-01T10:00:40Z',
      type: 'response_item',
      payload: { type: 'function_call', name: 'web.search_query', arguments: '{"q":"parser bug"}' },
    },
    {
      timestamp: '2026-04-01T10:01:00Z',
      type: 'event_msg',
      payload: {
        type: 'exec_command_end',
        parsed_cmd: [{ type: 'git_commit' }],
        command: ['git', 'commit', '-m', 'fix parser'],
        exit_code: 0,
        status: 'completed',
        duration: { secs: 1, nanos: 0 },
      },
    },
    {
      timestamp: '2026-04-01T10:02:00Z',
      type: 'event_msg',
      payload: {
        type: 'user_message',
        message: 'Push it too if tests pass.',
      },
    },
    {
      timestamp: '2026-04-01T10:03:00Z',
      type: 'event_msg',
      payload: {
        type: 'exec_command_end',
        parsed_cmd: [{ type: 'git_push' }],
        command: ['git', 'push'],
        exit_code: 1,
        status: 'failed',
        aggregated_output: 'remote rejected the push',
        duration: { secs: 2, nanos: 0 },
      },
    },
    {
      timestamp: '2026-04-01T10:03:00Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: 120,
            cached_input_tokens: 30,
            output_tokens: 20,
            reasoning_output_tokens: 5,
            total_tokens: 175,
          },
        },
      },
    },
  ]

  const summary = summarizeThread(thread, events)

  assert.equal(summary.userMessages, 2)
  assert.equal(summary.assistantMessages, 1)
  assert.equal(summary.totalToolCalls, 3)
  assert.equal(summary.totalCommandFailures, 1)
  assert.equal(summary.gitCommits, 1)
  assert.equal(summary.gitPushes, 1)
  assert.equal(summary.linesAdded, 2)
  assert.equal(summary.linesRemoved, 1)
  assert.equal(summary.filesModified, 1)
  assert.equal(summary.usesTaskAgent, true)
  assert.equal(summary.usesWebSearch, true)
  assert.deepEqual(summary.toolCounts, {
    apply_patch: 1,
    spawn_agent: 1,
    'web.search_query': 1,
  })
  assert.deepEqual(summary.toolFailures, { git_push: 1 })
  assert.match(summary.transcriptForAnalysis, /\[Tool: apply_patch\]/)
  assert.match(summary.transcriptForAnalysis, /\[Command failed: git_push\]/)
  assert.doesNotMatch(summary.transcriptForAnalysis, /I am checking the parser flow/)
  assert.deepEqual(summary.tokenUsage, {
    inputTokens: 120,
    cachedInputTokens: 30,
    outputTokens: 20,
    reasoningOutputTokens: 5,
    totalTokens: 175,
  })
})

test('filterSubstantiveThreads keeps only substantial threads and sorts by recency', () => {
  const threads = [
    { id: 'older', userMessages: 3, durationMinutes: 5, transcriptForAnalysis: 'ok', updatedAt: '2026-04-01T00:00:00.000Z' },
    { id: 'too-short', userMessages: 3, durationMinutes: 0.5, transcriptForAnalysis: 'ok', updatedAt: '2026-04-03T00:00:00.000Z' },
    { id: 'empty', userMessages: 3, durationMinutes: 5, transcriptForAnalysis: '   ', updatedAt: '2026-04-04T00:00:00.000Z' },
    { id: 'recent', userMessages: 2, durationMinutes: 1, transcriptForAnalysis: 'ok', updatedAt: '2026-04-05T00:00:00.000Z' },
  ]

  const filtered = filterSubstantiveThreads(threads)

  assert.deepEqual(
    filtered.map(thread => thread.id),
    ['recent', 'older'],
  )
})

test('summarizeThread compacts consecutive tool bursts in transcriptForAnalysis', () => {
  const thread = {
    id: 'thread-tools',
    title: 'Burst',
    firstUserMessage: 'Check the repo.',
    cwd: '/repo/project',
    model: 'gpt-5.4',
    modelProvider: 'openai',
    createdAt: Date.parse('2026-04-01T10:00:00Z') / 1000,
    updatedAt: Date.parse('2026-04-01T10:03:00Z') / 1000,
    tokensUsed: 100,
  }

  const events = [
    {
      timestamp: '2026-04-01T10:00:00Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: 'Check the repo.' },
    },
    {
      timestamp: '2026-04-01T10:00:05Z',
      type: 'response_item',
      payload: { type: 'function_call', name: 'exec_command', arguments: '{}' },
    },
    {
      timestamp: '2026-04-01T10:00:06Z',
      type: 'response_item',
      payload: { type: 'function_call', name: 'apply_patch', arguments: '{}' },
    },
    {
      timestamp: '2026-04-01T10:00:07Z',
      type: 'response_item',
      payload: { type: 'function_call', name: 'web.search_query', arguments: '{}' },
    },
  ]

  const summary = summarizeThread(thread, events)

  assert.match(summary.transcriptForAnalysis, /\[Tool: exec_command\]/)
  assert.match(summary.transcriptForAnalysis, /\[Tool: apply_patch\]/)
  assert.match(summary.transcriptForAnalysis, /\[Tool activity truncated: 1 more tool calls\]/)
})
