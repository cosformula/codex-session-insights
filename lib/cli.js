import path from 'node:path'
import { spawn } from 'node:child_process'
import { confirm, input, select } from '@inquirer/prompts'
import ora from 'ora'
import { collectThreadSummaries, resolveCodexHome } from './codex-data.js'
import { buildReport, renderTerminalSummary, writeReportFiles } from './report.js'
import { estimateLlmAnalysisCost, generateLlmInsights } from './llm-insights.js'

const DEFAULT_SCOPE_PRESET = 'standard'
const DEFAULT_QUALITY_PRESET = 'balanced'

export async function runCli(argv) {
  const parsed = parseArgs(argv)
  const progress = createProgressUi(parsed.options)

  if (parsed.help) {
    printHelp()
    return
  }

  const command = parsed.command ?? 'report'
  if (command !== 'report') {
    throw new Error(`Unsupported command "${command}". Only "report" is available in this build.`)
  }

  const codexHome = resolveCodexHome(parsed.options.codexHome)
  const outDir = path.resolve(parsed.options.outDir ?? path.join(codexHome, 'usage-data'))
  let threadSummaries
  let estimate

  if (shouldUseInteractiveMode(parsed.options)) {
    const wizardResult = await runInteractiveWizard({
      options: parsed.options,
      codexHome,
      defaultOutDir: outDir,
      progress,
    })
    if (!wizardResult) return
    parsed.options = wizardResult.options
    threadSummaries = wizardResult.threadSummaries
    estimate = wizardResult.estimate
  }

  const sinceEpochSeconds =
    parsed.options.days && parsed.options.days > 0
      ? Math.floor(Date.now() / 1000 - parsed.options.days * 24 * 60 * 60)
      : null
  const cacheDir = parsed.options.cacheDir
    ? path.resolve(parsed.options.cacheDir)
    : undefined

  if (!threadSummaries) {
    progress.startStage(parsed.options, getUiText(parsed.options.lang).loadingIndex)
    threadSummaries = await collectThreadSummaries({
      codexHome,
      sinceEpochSeconds,
      limit: parsed.options.limit,
      includeArchived: parsed.options.includeArchived,
      includeSubagents: parsed.options.includeSubagents,
      cacheDir,
    })
    progress.completeStage(parsed.options, getUiText(parsed.options.lang).loadingIndex)
  }

  if (!estimate) {
    progress.startStage(parsed.options, getUiText(parsed.options.lang).estimating)
    estimate = await estimateLlmAnalysisCost({
      threadSummaries,
      options: parsed.options,
    })
    progress.completeStage(parsed.options, getUiText(parsed.options.lang).estimating)
  }

  if (!parsed.options.stdoutJson) {
    process.stdout.write(`${renderEstimateSummary(estimate, parsed.options.lang)}\n\n`)
  }

  if (parsed.options.estimateOnly) {
    return
  }

  progress.startStage(parsed.options, getUiText(parsed.options.lang).generating)
  const llmResult = await generateLlmInsights({
    threadSummaries,
    options: {
      ...parsed.options,
      onProgress: event => progress.updateFromEvent(parsed.options, event),
    },
  })
  progress.completeStage(parsed.options, getUiText(parsed.options.lang).generating)

  const report = buildReport(llmResult.reportThreads, {
    codexHome,
    days: parsed.options.days,
    lang: parsed.options.lang,
    threadPreviewLimit: parsed.options.preview,
    insightsOverride: llmResult.insights,
    facets: llmResult.facets,
  })
  report.analysisMode = 'llm'
  report.provider = parsed.options.provider
  report.analysisEstimate = estimate
  report.analysisUsage = llmResult.analysisUsage

  progress.startStage(parsed.options, getUiText(parsed.options.lang).writingFiles)
  const { jsonPath, htmlPath } = await writeReportFiles(report, {
    outDir,
    jsonPath: parsed.options.jsonPath ? path.resolve(parsed.options.jsonPath) : undefined,
    htmlPath: parsed.options.htmlPath ? path.resolve(parsed.options.htmlPath) : undefined,
  })
  progress.completeStage(parsed.options, getUiText(parsed.options.lang).writingFiles)

  if (parsed.options.stdoutJson) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    return
  }

  process.stdout.write(`${renderTerminalSummary(report)}\n\n`)
  process.stdout.write(`JSON: ${jsonPath}\n`)
  process.stdout.write(`HTML: ${htmlPath}\n`)

  const shouldOpen = resolveShouldOpenReport(parsed.options)
  if (shouldOpen) {
    progress.startStage(parsed.options, getUiText(parsed.options.lang).openingBrowser)
    const opened = await openReportInBrowser(htmlPath)
    if (opened) {
      progress.completeStage(parsed.options, getUiText(parsed.options.lang).openingBrowser)
      process.stdout.write(`${getUiText(parsed.options.lang).openedInBrowser}\n`)
      return
    }
    progress.failStage(parsed.options, getUiText(parsed.options.lang).openingBrowser)
  }

  process.stdout.write(`${getUiText(parsed.options.lang).openHint}: ${formatOpenHint(htmlPath)}\n`)
}

function parseArgs(argv) {
  let command = null
  const explicit = {
    days: false,
    limit: false,
    preview: false,
    facetLimit: false,
  }
  const options = {
    codexHome: null,
    outDir: null,
    jsonPath: null,
    htmlPath: null,
    preset: DEFAULT_SCOPE_PRESET,
    days: 30,
    limit: 200,
    preview: 50,
    provider: 'codex-cli',
    codexBin: null,
    apiBase: null,
    apiKey: null,
    facetModel: null,
    facetEffort: null,
    fastSectionModel: null,
    fastSectionEffort: null,
    insightModel: null,
    insightEffort: null,
    cacheDir: null,
    facetLimit: 50,
    lang: detectSystemLanguage(),
    includeArchived: false,
    includeSubagents: false,
    stdoutJson: false,
    estimateOnly: false,
    openReport: null,
    yes: false,
    nonInteractive: false,
  }
  let help = false

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]

    if (!arg.startsWith('-') && command === null) {
      command = arg
      continue
    }

    if (arg === '-h' || arg === '--help') {
      help = true
      continue
    }
    if (arg === '--codex-home') {
      options.codexHome = requireValue(argv, ++i, '--codex-home')
      continue
    }
    if (arg === '--out-dir') {
      options.outDir = requireValue(argv, ++i, '--out-dir')
      continue
    }
    if (arg === '--json-path') {
      options.jsonPath = requireValue(argv, ++i, '--json-path')
      continue
    }
    if (arg === '--html-path') {
      options.htmlPath = requireValue(argv, ++i, '--html-path')
      continue
    }
    if (arg === '--days') {
      explicit.days = true
      options.days = toPositiveInt(requireValue(argv, ++i, '--days'), '--days')
      continue
    }
    if (arg === '--preset') {
      options.preset = normalizeScopePreset(requireValue(argv, ++i, '--preset'))
      continue
    }
    if (arg === '--limit') {
      explicit.limit = true
      options.limit = toPositiveInt(requireValue(argv, ++i, '--limit'), '--limit')
      continue
    }
    if (arg === '--preview') {
      explicit.preview = true
      options.preview = toPositiveInt(requireValue(argv, ++i, '--preview'), '--preview')
      continue
    }
    if (arg === '--provider') {
      options.provider = requireValue(argv, ++i, '--provider')
      continue
    }
    if (arg === '--codex-bin') {
      options.codexBin = requireValue(argv, ++i, '--codex-bin')
      continue
    }
    if (arg === '--api-base') {
      options.apiBase = requireValue(argv, ++i, '--api-base')
      continue
    }
    if (arg === '--api-key') {
      options.apiKey = requireValue(argv, ++i, '--api-key')
      continue
    }
    if (arg === '--facet-model') {
      options.facetModel = requireValue(argv, ++i, '--facet-model')
      continue
    }
    if (arg === '--facet-effort') {
      options.facetEffort = requireValue(argv, ++i, '--facet-effort')
      continue
    }
    if (arg === '--fast-section-model') {
      options.fastSectionModel = requireValue(argv, ++i, '--fast-section-model')
      continue
    }
    if (arg === '--fast-section-effort') {
      options.fastSectionEffort = requireValue(argv, ++i, '--fast-section-effort')
      continue
    }
    if (arg === '--insight-model') {
      options.insightModel = requireValue(argv, ++i, '--insight-model')
      continue
    }
    if (arg === '--insight-effort') {
      options.insightEffort = requireValue(argv, ++i, '--insight-effort')
      continue
    }
    if (arg === '--cache-dir') {
      options.cacheDir = requireValue(argv, ++i, '--cache-dir')
      continue
    }
    if (arg === '--lang') {
      options.lang = normalizeLang(requireValue(argv, ++i, '--lang'))
      continue
    }
    if (arg === '--facet-limit') {
      explicit.facetLimit = true
      options.facetLimit = toPositiveInt(requireValue(argv, ++i, '--facet-limit'), '--facet-limit')
      continue
    }
    if (arg === '--include-archived') {
      options.includeArchived = true
      continue
    }
    if (arg === '--include-subagents') {
      options.includeSubagents = true
      continue
    }
    if (arg === '--stdout-json') {
      options.stdoutJson = true
      continue
    }
    if (arg === '--estimate-only') {
      options.estimateOnly = true
      continue
    }
    if (arg === '--open') {
      options.openReport = true
      continue
    }
    if (arg === '--no-open') {
      options.openReport = false
      continue
    }
    if (arg === '--yes') {
      options.yes = true
      continue
    }
    if (arg === '--non-interactive') {
      options.nonInteractive = true
      continue
    }

    throw new Error(`Unknown argument: ${arg}`)
  }

  if (!['codex-cli', 'openai'].includes(options.provider)) {
    throw new Error(`Invalid provider "${options.provider}". Expected codex-cli or openai.`)
  }

  options.preset = normalizeScopePreset(options.preset)
  const explicitValues = {
    days: options.days,
    limit: options.limit,
    preview: options.preview,
    facetLimit: options.facetLimit,
  }
  Object.assign(options, applyScopePreset(options, options.preset))
  if (explicit.days) options.days = explicitValues.days
  if (explicit.limit) options.limit = explicitValues.limit
  if (explicit.preview) options.preview = explicitValues.preview
  if (explicit.facetLimit) options.facetLimit = explicitValues.facetLimit

  return { command, options, help }
}

function requireValue(argv, index, flag) {
  const value = argv[index]
  if (!value) {
    throw new Error(`${flag} requires a value`)
  }
  return value
}

function toPositiveInt(value, flag) {
  const number = Number.parseInt(value, 10)
  if (!Number.isFinite(number) || number < 0) {
    throw new Error(`${flag} must be a non-negative integer`)
  }
  return number
}

function printHelp() {
  process.stdout.write(`codex-session-insights

Usage:
  codex-session-insights report [options]
  codex-session-insights [options]

Options:
  --codex-home <path>       Override the Codex data directory (default: $CODEX_HOME or ~/.codex)
  --out-dir <path>          Directory for generated report files (default: ~/.codex/usage-data)
  --json-path <path>        Exact path for report.json
  --html-path <path>        Exact path for report.html
  --days <n>                Only include threads updated in the last N days (default: 30)
  --preset <name>           Scope preset: lite, standard, or deep (default: standard)
  --limit <n>               Target number of substantive threads to include (default: 200)
  --preview <n>             Number of threads to embed in the HTML report (default: 50)
  --provider <name>         Model provider: codex-cli or openai (default: codex-cli)
  --codex-bin <path>        Override the Codex CLI binary path for provider=codex-cli
  --api-key <key>           OpenAI API key override for provider=openai
  --api-base <url>          Responses API base URL override for provider=openai
  --facet-model <name>      Model for per-thread facet extraction
  --facet-effort <level>    Reasoning effort for facet extraction
  --fast-section-model <name>
                            Model for lower-risk report sections
  --fast-section-effort <level>
                            Reasoning effort for lower-risk sections
  --insight-model <name>    Model for final report generation
  --insight-effort <level>  Reasoning effort for higher-risk sections
  --facet-limit <n>         Max uncached thread facets to analyze (default: 50)
  --cache-dir <path>        Cache directory for session-meta and facet caches
  --lang <code>             Report language: en or zh-CN (default: system language)
  --include-archived        Include archived threads
  --include-subagents       Include sub-agent threads spawned from parent threads
  --estimate-only           Print estimated analysis token usage and exit
  --stdout-json             Print the JSON report to stdout instead of a terminal summary
  --open                    Force opening report.html in your browser after generation
  --no-open                 Do not auto-open report.html after generation
  --yes                     Run immediately without interactive confirmation
  --non-interactive         Disable TTY wizard mode
  -h, --help                Show this help
`)
}

function renderEstimateSummary(estimate, lang = 'en') {
  const ui = getUiText(lang)
  const lines = []
  lines.push(ui.analysisEstimateTitle)
  lines.push(
    `${formatMillionTokens(estimate.estimatedRange.low)} ${ui.toWord} ${formatMillionTokens(estimate.estimatedRange.high)} ${ui.likelyWord}`,
  )
  lines.push(
    `${ui.plannedCallsLabel}=${formatInteger(estimate.estimatedCalls)} | ${ui.substantiveThreadsLabel}=${formatInteger(estimate.candidateThreads)} | ${ui.uncachedFacetsLabel}=${formatInteger(estimate.uncachedFacetThreads)} | ${ui.longTranscriptsLabel}=${formatInteger(estimate.longTranscriptThreads)}`,
  )
  lines.push(
    `${ui.inputEstimateLabel}≈${formatMillionTokens(estimate.estimatedInputTokens)} | ${ui.outputEstimateLabel}≈${formatMillionTokens(estimate.estimatedOutputTokens)}`,
  )
  return lines.join('\n')
}

function formatInteger(value) {
  return new Intl.NumberFormat('en-US').format(Math.round(Number(value || 0)))
}

function formatMillionTokens(value) {
  const millions = Number(value || 0) / 1_000_000
  if (millions >= 1) return `${millions.toFixed(2)}M tokens`
  return `${(Number(value || 0) / 1_000).toFixed(1)}K tokens`
}

function resolveShouldOpenReport(options) {
  if (options.stdoutJson || options.estimateOnly) return false
  if (typeof options.openReport === 'boolean') return options.openReport
  if (!process.stdout.isTTY) return false
  if (process.env.CI) return false
  return true
}

function shouldUseInteractiveMode(options) {
  if (options.yes || options.nonInteractive || options.estimateOnly || options.stdoutJson) return false
  if (process.env.CI) return false
  return Boolean(process.stdin.isTTY && process.stdout.isTTY)
}

async function openReportInBrowser(filePath) {
  const command = getOpenCommand(filePath)
  if (!command) return false

  return new Promise(resolve => {
    let settled = false
    const child = spawn(command.bin, command.args, {
      detached: true,
      stdio: 'ignore',
    })
    child.once('error', () => {
      if (settled) return
      settled = true
      resolve(false)
    })
    child.once('spawn', () => {
      if (settled) return
      settled = true
      child.unref()
      resolve(true)
    })
  })
}

function getOpenCommand(filePath) {
  if (process.platform === 'darwin') {
    return { bin: 'open', args: [filePath] }
  }
  if (process.platform === 'win32') {
    return { bin: 'cmd', args: ['/c', 'start', '', filePath] }
  }
  if (process.platform === 'linux') {
    return { bin: 'xdg-open', args: [filePath] }
  }
  return null
}

function formatOpenHint(filePath) {
  if (process.platform === 'darwin') return `open ${shellQuote(filePath)}`
  if (process.platform === 'win32') return `start "" ${shellQuote(filePath)}`
  if (process.platform === 'linux') return `xdg-open ${shellQuote(filePath)}`
  return filePath
}

function shellQuote(value) {
  const text = String(value)
  if (/^[A-Za-z0-9_./:-]+$/.test(text)) return text
  return `'${text.replace(/'/g, `'\\''`)}'`
}

async function runInteractiveWizard({ options, codexHome, defaultOutDir, progress }) {
  let current = {
    ...options,
    outDir: options.outDir ? path.resolve(options.outDir) : defaultOutDir,
    lang: normalizeLang(options.lang),
  }
  let ui = getUiText(current.lang)

  if (!hasCustomModelOverrides(current)) {
    Object.assign(current, applyQualityPreset(current, DEFAULT_QUALITY_PRESET))
  }

  while (true) {
    ui = getUiText(current.lang)
    process.stdout.write(`${ui.wizardTitle}\n`)
    const { threadSummaries, estimate } = await collectEstimateForOptions({
      current,
      codexHome,
      ui,
      progress,
    })

    process.stdout.write(`\n${renderPlanSummary(current, estimate, ui)}\n`)
    process.stdout.write(`${ui.equivalentCommandLabel}\n${buildEquivalentCommand(current)}\n\n`)

    const action = await promptChoice(
      ui.confirmQuestion,
      [
        { key: 'start', label: ui.startAnalysis },
        { key: 'adjust', label: ui.adjustSettings },
        { key: 'exit', label: ui.exitAction },
      ],
      'start',
    )

    if (action === 'start') {
      current.yes = true
      return { options: current, threadSummaries, estimate }
    }
    if (action === 'exit') {
      process.stdout.write(`${ui.cancelled}\n`)
      return null
    }

    current = await runAdjustFlow(current, defaultOutDir, ui, {
      allowQualityAdjust: !hasCustomModelOverrides(options),
    })
    process.stdout.write(`\n`)
  }
}

async function collectEstimateForOptions({ current, codexHome, ui, progress }) {
  const sinceEpochSeconds =
    current.days && current.days > 0
      ? Math.floor(Date.now() / 1000 - current.days * 24 * 60 * 60)
      : null
  const cacheDir = current.cacheDir ? path.resolve(current.cacheDir) : undefined

  progress.startStage(current, ui.loadingIndex)
  const threadSummaries = await collectThreadSummaries({
    codexHome,
    sinceEpochSeconds,
    limit: current.limit,
    includeArchived: current.includeArchived,
    includeSubagents: current.includeSubagents,
    cacheDir,
  })
  progress.completeStage(current, ui.loadingIndex)

  progress.startStage(current, ui.estimating)
  const estimate = await estimateLlmAnalysisCost({
    threadSummaries,
    options: current,
  })
  progress.completeStage(current, ui.estimating)

  return { threadSummaries, estimate }
}

async function runAdjustFlow(current, defaultOutDir, ui, config = {}) {
  current.days = await promptScopeDays(current.days, ui)
  Object.assign(current, await promptDepthPreset(current, ui))
  current.lang = await promptLanguage(current.lang, ui)
  ui = getUiText(current.lang)
  current.outDir = await promptOutputDir(current.outDir, defaultOutDir, ui)
  current.openReport = await promptYesNo(
    ui.openBrowserQuestion,
    resolveShouldOpenReport(current),
  )

  if (config.allowQualityAdjust) {
    Object.assign(current, await promptQualityPreset(current, ui))
  }

  return current
}

async function promptScopeDays(currentDays, ui) {
  const preset = inferScopePreset(currentDays)
  const scope = await promptChoice(
    ui.scopeQuestion,
    [
      { key: '7', label: ui.scope7 },
      { key: '30', label: ui.scope30 },
      { key: '90', label: ui.scope90 },
      { key: 'custom', label: ui.scopeCustom },
    ],
    preset,
  )
  if (scope === 'custom') {
    return promptIntegerInput(ui.customDaysQuestion, currentDays || 30)
  }
  return Number(scope)
}

async function promptDepthPreset(current, ui) {
  const preset = inferDepthPreset(current)
  const choice = await promptChoice(
    ui.depthQuestion,
    [
      { key: 'conservative', label: ui.depthConservative },
      { key: 'standard', label: ui.depthStandard },
      { key: 'deep', label: ui.depthDeep },
      { key: 'custom', label: ui.depthCustom },
    ],
    preset,
  )
  if (choice === 'custom') {
    const limit = await promptIntegerInput(ui.limitQuestion, current.limit)
    const facetLimit = await promptIntegerInput(ui.facetLimitQuestion, current.facetLimit)
    return { limit, facetLimit, preset: 'custom' }
  }
  return { ...applyScopePreset(current, choice), preset: choice }
}

async function promptLanguage(currentLang, ui) {
  return promptChoice(
    ui.languageQuestion,
    [
      { key: 'en', label: 'English' },
      { key: 'zh-CN', label: '简体中文' },
    ],
    normalizeLang(currentLang),
  )
}

async function promptOutputDir(currentOutDir, defaultOutDir, ui) {
  const answer = await input({
    message: ui.outputDirQuestion,
    default: currentOutDir || defaultOutDir,
  })
  return answer?.trim() ? path.resolve(answer.trim()) : currentOutDir || defaultOutDir
}

async function promptQualityPreset(current, ui) {
  const preset = inferQualityPreset(current)
  const choice = await promptChoice(
    ui.qualityQuestion,
    [
      { key: 'cheaper', label: ui.qualityCheaper },
      { key: 'balanced', label: ui.qualityBalanced },
      { key: 'higher', label: ui.qualityHigher },
    ],
    preset,
  )
  return { ...applyQualityPreset(current, choice), qualityPreset: choice }
}

async function promptChoice(question, choices, defaultKey) {
  return select({
    message: question,
    default: defaultKey,
    choices: choices.map(choice => ({
      value: choice.key,
      name: choice.label,
    })),
  })
}

async function promptYesNo(question, defaultValue) {
  return confirm({
    message: question,
    default: defaultValue,
  })
}

async function promptIntegerInput(question, defaultValue) {
  const answer = await input({
    message: question,
    default: String(defaultValue),
    validate(value) {
      const number = Number.parseInt(String(value).trim(), 10)
      if (Number.isFinite(number) && number >= 0) return true
      return 'Please enter a non-negative integer.'
    },
  })
  return Number.parseInt(String(answer).trim(), 10)
}

function inferScopePreset(days) {
  if (days === 7) return '7'
  if (days === 90) return '90'
  if (days === 30) return '30'
  return 'custom'
}

function inferDepthPreset(options) {
  if (options.limit === 20 && options.facetLimit === 8) return 'conservative'
  if (options.limit === 200 && options.facetLimit === 50) return 'standard'
  if (options.limit === 400 && options.facetLimit === 50) return 'deep'
  return 'custom'
}

function inferQualityPreset(options) {
  if (
    options.facetModel === 'gpt-5.4-mini' &&
    options.fastSectionModel === 'gpt-5.4-mini' &&
    options.insightModel === 'gpt-5.4-mini'
  ) {
    return 'cheaper'
  }
  if (
    options.facetModel === 'gpt-5.4' &&
    options.fastSectionModel === 'gpt-5.4' &&
    options.insightModel === 'gpt-5.4'
  ) {
    return 'higher'
  }
  return 'balanced'
}

function applyScopePreset(options, preset) {
  if (preset === 'lite' || preset === 'conservative') {
    return { ...options, days: 7, limit: 20, facetLimit: 8, preview: 10 }
  }
  if (preset === 'deep') return { ...options, limit: 400, facetLimit: 50 }
  return { ...options, limit: 200, facetLimit: 50 }
}

function normalizeScopePreset(value) {
  const preset = String(value || '').trim().toLowerCase()
  if (preset === 'lite') return 'lite'
  if (preset === 'conservative') return 'conservative'
  if (preset === 'deep') return 'deep'
  if (preset === 'standard' || !preset) return 'standard'
  throw new Error(`Invalid preset "${value}". Expected lite, standard, or deep.`)
}

function applyQualityPreset(options, preset) {
  if (preset === 'cheaper') {
    return {
      ...options,
      facetModel: 'gpt-5.4-mini',
      fastSectionModel: 'gpt-5.4-mini',
      insightModel: 'gpt-5.4-mini',
      facetEffort: 'low',
      fastSectionEffort: 'low',
      insightEffort: 'low',
    }
  }
  if (preset === 'higher') {
    return {
      ...options,
      facetModel: 'gpt-5.4',
      fastSectionModel: 'gpt-5.4',
      insightModel: 'gpt-5.4',
      facetEffort: 'low',
      fastSectionEffort: 'medium',
      insightEffort: 'high',
    }
  }
  return {
    ...options,
    facetModel: 'gpt-5.4-mini',
    fastSectionModel: 'gpt-5.4-mini',
    insightModel: 'gpt-5.4',
    facetEffort: 'low',
    fastSectionEffort: 'low',
    insightEffort: 'high',
  }
}

function hasCustomModelOverrides(options) {
  return Boolean(
    options.facetModel ||
      options.fastSectionModel ||
      options.insightModel ||
      options.facetEffort ||
      options.fastSectionEffort ||
      options.insightEffort,
  )
}

function renderPlanSummary(options, estimate, ui) {
  const lines = []
  lines.push(ui.planSummaryTitle)
  lines.push(
    `${options.days} ${ui.daysLabel}, ${formatDepthPresetLabel(inferDepthPreset(options), ui)}, ${options.lang === 'zh-CN' ? '简体中文' : 'English'}`,
  )
  lines.push(`${ui.outputLabel}: ${options.outDir}`)
  lines.push(`${ui.providerLabel}: ${options.provider}`)
  lines.push('')
  lines.push(renderEstimateSummary(estimate, options.lang))
  return lines.join('\n')
}

function formatDepthPresetLabel(preset, ui) {
  if (preset === 'conservative') return ui.depthConservative
  if (preset === 'deep') return ui.depthDeep
  if (preset === 'custom') return ui.depthCustom
  return ui.depthStandard
}

function buildEquivalentCommand(options) {
  const args = [
    'codex-session-insights',
    'report',
    '--days',
    String(options.days),
    '--limit',
    String(options.limit),
    '--facet-limit',
    String(options.facetLimit),
    '--lang',
    normalizeLang(options.lang),
    '--yes',
  ]
  if (typeof options.openReport === 'boolean') {
    args.push(options.openReport ? '--open' : '--no-open')
  }
  if (options.includeArchived) args.push('--include-archived')
  if (options.includeSubagents) args.push('--include-subagents')
  if (options.outDir) args.push('--out-dir', shellQuote(options.outDir))
  if (options.provider !== 'codex-cli') args.push('--provider', options.provider)
  if (options.facetModel) args.push('--facet-model', options.facetModel)
  if (options.fastSectionModel) args.push('--fast-section-model', options.fastSectionModel)
  if (options.insightModel) args.push('--insight-model', options.insightModel)
  if (options.facetEffort) args.push('--facet-effort', options.facetEffort)
  if (options.fastSectionEffort) args.push('--fast-section-effort', options.fastSectionEffort)
  if (options.insightEffort) args.push('--insight-effort', options.insightEffort)
  return args.join(' ')
}

function normalizeLang(value) {
  if (!value) return 'en'
  const normalized = String(value).trim()
  if (
    normalized === 'zh' ||
    normalized === 'zh-CN' ||
    normalized === 'zh-Hans' ||
    normalized.startsWith('zh_') ||
    normalized.startsWith('zh-')
  ) {
    return 'zh-CN'
  }
  return 'en'
}

function detectSystemLanguage() {
  if (process.env.CODEX_REPORT_LANG) {
    return normalizeLang(process.env.CODEX_REPORT_LANG)
  }

  const intlLocale = Intl.DateTimeFormat().resolvedOptions().locale
  const normalizedIntl = normalizeLang(intlLocale)
  if (normalizedIntl === 'zh-CN') return normalizedIntl

  const candidates = [process.env.LC_ALL, process.env.LC_MESSAGES, process.env.LANG].filter(Boolean)

  for (const value of candidates) {
    const normalized = normalizeLang(String(value).split('.')[0])
    if (normalized === 'zh-CN') return normalized
  }

  return 'en'
}

function getUiText(lang) {
  if (normalizeLang(lang) === 'zh-CN') {
    return {
      wizardTitle: '\nCodex Session Insights 配置向导\n',
      loadingIndex: '正在读取线程索引...',
      estimating: '正在预估分析成本...',
      generating: '正在生成报告...',
      writingFiles: '正在写入报告文件...',
      openingBrowser: '正在打开浏览器...',
      openedInBrowser: '已在浏览器中打开报告。',
      openHint: '可用以下命令打开',
      scopeQuestion: '选择分析时间范围：',
      scope7: '最近 7 天',
      scope30: '最近 30 天',
      scope90: '最近 90 天',
      scopeCustom: '自定义天数',
      customDaysQuestion: '输入要分析的天数',
      depthQuestion: '选择分析深度：',
      depthConservative: '保守（20 个有效线程 / 8 个 facets）',
      depthStandard: '标准（200 个有效线程 / 50 个 facets）',
      depthDeep: '深度（400 个有效线程 / 50 个 facets）',
      depthCustom: '自定义',
      limitQuestion: '输入目标有效线程数',
      facetLimitQuestion: '输入最大新增 facet 数',
      languageQuestion: '选择报告语言：',
      outputDirQuestion: '输出目录',
      openBrowserQuestion: '生成后自动打开浏览器？',
      qualityQuestion: '选择分析质量预设：',
      qualityCheaper: '更省（尽量用 gpt-5.4-mini）',
      qualityBalanced: '平衡',
      qualityHigher: '更高质量（更多使用 gpt-5.4）',
      yesDefault: '[Y/n]',
      noDefault: '[y/N]',
      invalidYesNo: '输入无效，使用默认值。',
      confirmQuestion: '确认这次分析计划：',
      startAnalysis: '开始分析',
      adjustSettings: '重新调整设置',
      exitAction: '退出',
      cancelled: '已取消。',
      equivalentCommandLabel: '等价命令：',
      planSummaryTitle: '计划摘要',
      analysisEstimateTitle: '分析预估',
      toWord: '到',
      likelyWord: '左右',
      plannedCallsLabel: '预计调用数',
      substantiveThreadsLabel: '纳入报告线程',
      uncachedFacetsLabel: '未缓存 facets',
      longTranscriptsLabel: '长 transcript',
      inputEstimateLabel: '输入',
      outputEstimateLabel: '输出',
      daysLabel: '天',
      depthLabel: '深度',
      outputLabel: '输出目录',
      providerLabel: 'Provider',
      facetProgress: '提取 facets',
      sectionProgress: '生成 sections',
      modelFallback: '模型降级',
    }
  }

  return {
    wizardTitle: '\nCodex Session Insights Setup\n',
    loadingIndex: 'Loading thread index...',
    estimating: 'Estimating analysis cost...',
    generating: 'Generating report...',
    writingFiles: 'Writing report files...',
    openingBrowser: 'Opening browser...',
    openedInBrowser: 'Opened report in your browser.',
    openHint: 'Open it with',
    scopeQuestion: 'Choose analysis range:',
    scope7: 'Last 7 days',
    scope30: 'Last 30 days',
    scope90: 'Last 90 days',
    scopeCustom: 'Custom days',
    customDaysQuestion: 'Enter number of days to analyze',
    depthQuestion: 'Choose analysis depth:',
    depthConservative: 'Conservative (20 substantive threads / 8 facets)',
    depthStandard: 'Standard (200 substantive threads / 50 facets)',
    depthDeep: 'Deep (400 substantive threads / 50 facets)',
    depthCustom: 'Custom',
    limitQuestion: 'Enter target substantive thread count',
    facetLimitQuestion: 'Enter max new facet extraction count',
    languageQuestion: 'Choose report language:',
    outputDirQuestion: 'Output directory',
    openBrowserQuestion: 'Open the report in your browser after generation?',
    qualityQuestion: 'Choose quality preset:',
    qualityCheaper: 'Cheaper (more gpt-5.4-mini)',
    qualityBalanced: 'Balanced',
    qualityHigher: 'Higher quality (more gpt-5.4)',
    yesDefault: '[Y/n]',
    noDefault: '[y/N]',
    invalidYesNo: 'Invalid input, using default.',
    confirmQuestion: 'Confirm this analysis plan:',
    startAnalysis: 'Start analysis',
    adjustSettings: 'Adjust settings',
    exitAction: 'Exit',
    cancelled: 'Cancelled.',
    equivalentCommandLabel: 'Equivalent command:',
    planSummaryTitle: 'Plan Summary',
    analysisEstimateTitle: 'Analysis Estimate',
    toWord: 'to',
    likelyWord: 'likely',
    plannedCallsLabel: 'planned calls',
    substantiveThreadsLabel: 'threads in report',
    uncachedFacetsLabel: 'uncached facets',
    longTranscriptsLabel: 'long transcripts',
    inputEstimateLabel: 'input',
    outputEstimateLabel: 'output',
    daysLabel: 'days',
    depthLabel: 'depth',
    outputLabel: 'Output',
    providerLabel: 'Provider',
    facetProgress: 'Extracting facets',
    sectionProgress: 'Generating sections',
    modelFallback: 'Model fallback',
  }
}

function logStage(options, message) {
  if (options.stdoutJson) return
  process.stdout.write(`${message}\n`)
}

function createProgressUi(initialOptions = {}) {
  const spinner =
    process.stdout.isTTY && !initialOptions.stdoutJson && !process.env.CI
      ? ora({ isSilent: false })
      : null

  return {
    startStage(options, message) {
      if (spinner) {
        spinner.start(message)
        return
      }
      logStage(options, message)
    },
    completeStage(options, message) {
      if (spinner) {
        spinner.succeed(message)
        return
      }
      logStage(options, message)
    },
    failStage(options, message) {
      if (spinner) {
        spinner.fail(message)
        return
      }
      logStage(options, message)
    },
    updateFromEvent(options, event) {
      if (!spinner || !event) return
      const ui = getUiText(options.lang)
      if (event.kind === 'facets:planned') {
        spinner.text = `${ui.facetProgress}: 0/${event.total}`
        return
      }
      if (event.kind === 'facets:progress') {
        spinner.text = `${ui.facetProgress}: ${event.completed}/${event.total}`
        return
      }
      if (event.kind === 'sections:planned') {
        spinner.text = `${ui.sectionProgress}: 0/${event.total}`
        return
      }
      if (event.kind === 'sections:progress') {
        spinner.text = `${ui.sectionProgress}: ${event.completed}/${event.total} (${event.section})`
        return
      }
      if (event.kind === 'model:fallback') {
        spinner.text = `${ui.modelFallback}: ${event.fromModel} -> ${event.toModel}`
      }
    },
  }
}

export const __test = {
  shouldUseInteractiveMode,
  applyScopePreset,
  applyQualityPreset,
  buildEquivalentCommand,
  parseArgs,
  normalizeScopePreset,
  normalizeLang,
  detectSystemLanguage,
}
