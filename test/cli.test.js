import test from 'node:test'
import assert from 'node:assert/strict'
import { __test as cliTest } from '../lib/cli.js'

test('normalizeLang collapses zh variants and defaults to en', () => {
  assert.equal(cliTest.normalizeLang('zh'), 'zh-CN')
  assert.equal(cliTest.normalizeLang('zh-Hans'), 'zh-CN')
  assert.equal(cliTest.normalizeLang('zh_CN.UTF-8'), 'zh-CN')
  assert.equal(cliTest.normalizeLang('en'), 'en')
  assert.equal(cliTest.normalizeLang('anything-else'), 'en')
})

test('detectSystemLanguage follows locale environment', () => {
  const originalOverride = process.env.CODEX_REPORT_LANG
  process.env.CODEX_REPORT_LANG = 'zh-CN'
  try {
    assert.equal(cliTest.detectSystemLanguage(), 'zh-CN')
  } finally {
    if (originalOverride === undefined) delete process.env.CODEX_REPORT_LANG
    else process.env.CODEX_REPORT_LANG = originalOverride
  }
})

test('applyScopePreset maps standard presets to expected limits', () => {
  assert.deepEqual(cliTest.applyScopePreset({}, 'lite'), {
    days: 7,
    limit: 20,
    facetLimit: 8,
    preview: 10,
  })
  assert.deepEqual(cliTest.applyScopePreset({}, 'conservative'), {
    days: 7,
    limit: 20,
    facetLimit: 8,
    preview: 10,
  })
  assert.deepEqual(cliTest.applyScopePreset({}, 'standard'), {
    limit: 200,
    facetLimit: 50,
  })
  assert.deepEqual(cliTest.applyScopePreset({}, 'deep'), {
    limit: 400,
    facetLimit: 50,
  })
})

test('parseArgs keeps explicit scope flags over preset defaults', () => {
  const parsed = cliTest.parseArgs([
    '--preset',
    'lite',
    '--days',
    '14',
    '--limit',
    '30',
    '--preview',
    '12',
    '--facet-limit',
    '9',
  ])

  assert.equal(parsed.options.preset, 'lite')
  assert.equal(parsed.options.days, 14)
  assert.equal(parsed.options.limit, 30)
  assert.equal(parsed.options.preview, 12)
  assert.equal(parsed.options.facetLimit, 9)
})

test('applyQualityPreset maps balanced preset to default model plan', () => {
  assert.deepEqual(cliTest.applyQualityPreset({}, 'balanced'), {
    facetModel: 'gpt-5.4-mini',
    fastSectionModel: 'gpt-5.4-mini',
    insightModel: 'gpt-5.4',
    facetEffort: 'low',
    fastSectionEffort: 'low',
    insightEffort: 'high',
  })
})

test('buildEquivalentCommand emits a replayable command', () => {
  const command = cliTest.buildEquivalentCommand({
    days: 30,
    limit: 50,
    facetLimit: 20,
    lang: 'zh-CN',
    openReport: false,
    outDir: '/tmp/out dir',
    provider: 'codex-cli',
    facetModel: 'gpt-5.4-mini',
    fastSectionModel: 'gpt-5.4-mini',
    insightModel: 'gpt-5.4',
    facetEffort: 'low',
    fastSectionEffort: 'low',
    insightEffort: 'high',
  })

  assert.match(command, /^codex-session-insights report /)
  assert.match(command, /--lang zh-CN/)
  assert.match(command, /--no-open/)
  assert.match(command, /--out-dir '\/tmp\/out dir'/)
  assert.match(command, /--yes/)
})

test('buildEquivalentCommand omits open flags when using default behavior', () => {
  const command = cliTest.buildEquivalentCommand({
    days: 30,
    limit: 50,
    facetLimit: 20,
    lang: 'zh-CN',
    openReport: null,
    outDir: '/tmp/out',
    provider: 'codex-cli',
  })

  assert.doesNotMatch(command, /--open/)
  assert.doesNotMatch(command, /--no-open/)
})

test('buildEquivalentCommand includes include-subagents when explicitly enabled', () => {
  const command = cliTest.buildEquivalentCommand({
    days: 30,
    limit: 50,
    facetLimit: 20,
    lang: 'en',
    includeSubagents: true,
    provider: 'codex-cli',
  })

  assert.match(command, /--include-subagents/)
})
