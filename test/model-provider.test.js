import test from 'node:test'
import assert from 'node:assert/strict'
import { __test as providerTest } from '../lib/model-provider.js'

test('parseFirstJsonObject extracts and repairs wrapped JSON', () => {
  const parsed = providerTest.parseFirstJsonObject(
    'preamble\n{"headline":"Line 1\nLine 2","detail":"ok"}\ntrailer',
  )

  assert.deepEqual(parsed, {
    headline: 'Line 1\nLine 2',
    detail: 'ok',
  })
})

test('extractCodexExecResult returns final agent text and normalized usage', () => {
  const stdout = [
    '{"type":"item.completed","item":{"type":"agent_message","text":"draft"}}',
    '{"type":"item.completed","item":{"type":"agent_message","text":"final answer"}}',
    '{"type":"turn.completed","usage":{"input_tokens":120,"cached_input_tokens":30,"output_tokens":12}}',
  ].join('\n')

  const result = providerTest.extractCodexExecResult(stdout)

  assert.equal(result.text, 'final answer')
  assert.deepEqual(result.usage, {
    inputTokens: 120,
    cachedInputTokens: 30,
    outputTokens: 12,
    totalTokens: 162,
  })
})

test('buildModelCandidates dedupes primary and fallback models', () => {
  assert.deepEqual(
    providerTest.buildModelCandidates('gpt-5.3-codex-spark', [
      'gpt-5.4-mini',
      'gpt-5.4',
      'gpt-5.4-mini',
    ]),
    ['gpt-5.3-codex-spark', 'gpt-5.4-mini', 'gpt-5.4'],
  )
})

test('isRetryableModelError matches unavailable model failures', () => {
  assert.equal(
    providerTest.isRetryableModelError(
      new Error('Model gpt-5.3-codex-spark not available for this account'),
    ),
    true,
  )
  assert.equal(
    providerTest.isRetryableModelError(new Error('Unexpected JSON parse failure')),
    false,
  )
})
