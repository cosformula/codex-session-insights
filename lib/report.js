import os from 'node:os'
import path from 'node:path'
import { promises as fs } from 'node:fs'

export function buildReport(threadSummaries, options = {}) {
  const projectCounts = {}
  const modelCounts = {}
  const toolCounts = {}
  const commandKindCounts = {}
  const capabilityCounts = {}
  const outcomeCounts = {}
  const sessionTypeCounts = {}
  const toolFailureCounts = {}
  const activeHourCounts = {}
  const responseTimes = []
  const userMessageTimestamps = []
  let totalUserMessages = 0
  let totalAssistantMessages = 0
  let totalToolCalls = 0
  let totalFailures = 0
  let totalDurationMinutes = 0
  let totalTokens = 0
  let totalInputTokens = 0
  let totalCachedInputTokens = 0
  let totalOutputTokens = 0
  let totalReasoningOutputTokens = 0
  let totalGitCommits = 0
  let totalGitPushes = 0
  let totalInterruptions = 0
  let totalToolErrors = 0
  let totalLinesAdded = 0
  let totalLinesRemoved = 0
  let totalFilesModified = 0
  let sessionsUsingTaskAgent = 0
  let sessionsUsingMcp = 0
  let sessionsUsingWebSearch = 0
  let sessionsUsingWebFetch = 0
  const toolErrorCategoryCounts = {}

  for (const thread of threadSummaries) {
    increment(projectCounts, thread.cwd || '(unknown project)')
    increment(modelCounts, thread.model || '(unknown model)')

    for (const [name, count] of Object.entries(thread.toolCounts)) {
      increment(toolCounts, name, count)
    }
    for (const [name, count] of Object.entries(thread.commandKindCounts)) {
      increment(commandKindCounts, name, count)
    }
    for (const [name, count] of Object.entries(thread.toolFailures)) {
      increment(toolFailureCounts, name, count)
    }
    for (const [name, count] of Object.entries(thread.toolErrorCategories || {})) {
      increment(toolErrorCategoryCounts, name, count)
    }
    for (const hour of thread.activeHours) {
      increment(activeHourCounts, String(hour))
    }

    if (thread.averageResponseTimeSeconds > 0) {
      responseTimes.push(thread.averageResponseTimeSeconds)
    }
    for (const ts of thread.userMessageTimestamps) {
      userMessageTimestamps.push({ threadId: thread.id, ts: Date.parse(ts) })
    }

    totalUserMessages += thread.userMessages
    totalAssistantMessages += thread.assistantMessages
    totalToolCalls += thread.totalToolCalls
    totalFailures += thread.totalCommandFailures
    totalDurationMinutes += thread.durationMinutes
    totalTokens += thread.tokenUsage.totalTokens
    totalInputTokens += thread.tokenUsage.inputTokens
    totalCachedInputTokens += thread.tokenUsage.cachedInputTokens
    totalOutputTokens += thread.tokenUsage.outputTokens
    totalReasoningOutputTokens += thread.tokenUsage.reasoningOutputTokens
    totalGitCommits += thread.gitCommits
    totalGitPushes += thread.gitPushes
    totalInterruptions += thread.userInterruptions
    totalToolErrors += thread.toolErrors
    totalLinesAdded += thread.linesAdded
    totalLinesRemoved += thread.linesRemoved
    totalFilesModified += thread.filesModified
    if (thread.usesTaskAgent) sessionsUsingTaskAgent += 1
    if (thread.usesMcp) sessionsUsingMcp += 1
    if (thread.usesWebSearch) sessionsUsingWebSearch += 1
    if (thread.usesWebFetch) sessionsUsingWebFetch += 1
    if (thread.filesModified > 0) increment(capabilityCounts, 'Repo edits')
    if (thread.gitCommits > 0 || thread.gitPushes > 0) increment(capabilityCounts, 'Git activity')
  }

  for (const facet of options.facets || []) {
    if (facet.outcome) increment(outcomeCounts, facet.outcome)
    if (facet.session_type) increment(sessionTypeCounts, facet.session_type)
  }

  if (sessionsUsingTaskAgent > 0) increment(capabilityCounts, 'Sub-agents', sessionsUsingTaskAgent)
  if (sessionsUsingMcp > 0) increment(capabilityCounts, 'MCP servers', sessionsUsingMcp)
  if (sessionsUsingWebSearch > 0) increment(capabilityCounts, 'Web search', sessionsUsingWebSearch)
  if (sessionsUsingWebFetch > 0) increment(capabilityCounts, 'Web fetch', sessionsUsingWebFetch)

  const sortedThreads = [...threadSummaries].sort(
    (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
  )
  const dateRange = {
    start: sortedThreads.at(-1)?.createdAt.slice(0, 10) ?? '',
    end: sortedThreads[0]?.updatedAt.slice(0, 10) ?? '',
  }

  return {
    metadata: {
      generatedAt: new Date().toISOString(),
      codexHome: options.codexHome ?? '',
      language: options.lang ?? 'en',
      days: options.days ?? null,
      threadCount: threadSummaries.length,
      dateRange,
    },
    summary: {
      totalUserMessages,
      totalAssistantMessages,
      totalToolCalls,
      totalFailures,
      totalDurationHours: round(totalDurationMinutes / 60),
      totalTokens,
      totalInputTokens,
      totalCachedInputTokens,
      totalOutputTokens,
      totalReasoningOutputTokens,
      averageResponseTimeSeconds: round(average(responseTimes)),
      overlap: detectOverlaps(userMessageTimestamps),
      totalGitCommits,
      totalGitPushes,
      totalInterruptions,
      totalToolErrors,
      totalLinesAdded,
      totalLinesRemoved,
      totalFilesModified,
      sessionsUsingTaskAgent,
      sessionsUsingMcp,
      sessionsUsingWebSearch,
      sessionsUsingWebFetch,
    },
    charts: {
      projects: topEntries(projectCounts, 10),
      models: topEntries(modelCounts, 10),
      tools: topEntries(toolCounts, 12),
      commandKinds: topEntries(commandKindCounts, 12),
      capabilities: topEntries(capabilityCounts, 8),
      outcomes: topEntries(outcomeCounts, 8),
      sessionTypes: topEntries(sessionTypeCounts, 8),
      toolFailures: topEntries(toolFailureCounts, 8),
      toolErrorCategories: topEntries(toolErrorCategoryCounts, 8),
      activeHours: buildHourSeries(activeHourCounts),
    },
    threads: sortedThreads.slice(0, options.threadPreviewLimit ?? 50),
    insights: options.insightsOverride ?? null,
    facets: options.facets || [],
  }
}

export async function writeReportFiles(report, options) {
  if (!report.insights) {
    throw new Error('LLM insights are required before writing a report.')
  }

  const outDir = path.resolve(options.outDir)
  await fs.mkdir(outDir, { recursive: true })

  const jsonPath = options.jsonPath ?? path.join(outDir, 'report.json')
  const htmlPath = options.htmlPath ?? path.join(outDir, 'report.html')

  await fs.writeFile(jsonPath, JSON.stringify(report, null, 2), 'utf8')
  await fs.writeFile(htmlPath, renderHtmlReport(report), 'utf8')

  return { jsonPath, htmlPath }
}

export function renderTerminalSummary(report) {
  const text = getReportText(report.metadata.language)
  const estimateComparison = buildEstimateComparison(report)
  const lines = []
  lines.push(text.reportTitle)
  lines.push(
    `${report.metadata.threadCount} ${text.threadsShort} | ${report.summary.totalUserMessages} ${text.userMsgsShort} | ${report.summary.totalToolCalls} ${text.toolCallsShort} | ${report.summary.totalDurationHours}h`,
  )
  if (report.analysisUsage?.totalTokens) {
    lines.push(
      `${text.analysisCostLabel}: ${formatMillionTokens(report.analysisUsage.totalTokens)} ${text.across} ${report.analysisUsage.calls} ${text.modelCallsShort}`,
    )
    lines.push(
      `  ${text.inputLabel}=${formatMillionTokens(report.analysisUsage.inputTokens)} | ${text.cachedLabel}=${formatMillionTokens(report.analysisUsage.cachedInputTokens)} | ${text.outputLabel}=${formatMillionTokens(report.analysisUsage.outputTokens)}`,
    )
    if (estimateComparison) {
      lines.push(
        `  ${text.estimateVsActualLabel}: ${formatMillionTokens(estimateComparison.estimatedTotalTokens)} -> ${formatMillionTokens(estimateComparison.actualTotalTokens)} ${text.actualFreshSuffix} (${formatSignedMillionTokens(estimateComparison.deltaTokens)}, ${formatSignedPercent(estimateComparison.deltaPercent)})`,
      )
    }
  }
  if (report.metadata.dateRange.start && report.metadata.dateRange.end) {
    lines.push(`${report.metadata.dateRange.start} -> ${report.metadata.dateRange.end}`)
  }
  lines.push('')
  lines.push(`${text.topProjects}:`)
  for (const item of report.charts.projects.slice(0, 5)) {
    lines.push(`  ${formatProjectLabel(item.label)}: ${item.value}`)
  }
  lines.push('')
  lines.push(`${text.modelMix}:`)
  for (const item of report.charts.models.slice(0, 5)) {
    lines.push(`  ${item.label}: ${item.value}`)
  }
  return lines.join('\n')
}

function renderHtmlReport(report) {
  const text = getReportText(report.metadata.language)
  const insights = report.insights
  if (insights && !insights.__lang) insights.__lang = report.metadata.language
  const analysisUsage = report.analysisUsage || null
  const topProjects = renderBarList(report.charts.projects, { formatLabel: formatProjectLabel })
  const modelMix = renderBarList(report.charts.models)
  const sessionTypes = renderBarList(report.charts.sessionTypes, {
    formatLabel: value => formatSessionTypeLabel(value, report.metadata.language),
  })
  const outcomes = renderBarList(report.charts.outcomes, {
    formatLabel: value => formatOutcomeLabel(value, report.metadata.language),
  })
  const capabilitySignals = renderBarList(report.charts.capabilities)
  const toolFailures = renderBarList(report.charts.toolFailures)
  const toolErrorCategories = renderBarList(report.charts.toolErrorCategories)
  const activeHours = renderHourHistogram(report.charts.activeHours)
  const analysisByStage = renderBarList(
    (analysisUsage?.byStage || []).map(item => ({ label: item.label, value: item.totalTokens })),
  )
  const analysisByModel = renderBarList(
    (analysisUsage?.byModel || []).map(item => ({ label: item.label, value: item.totalTokens })),
  )

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(text.reportTitle)}</title>
    <style>
      :root {
        --bg: #f7f5ef;
        --paper: #fffdfa;
        --ink: #1d2433;
        --muted: #677084;
        --border: #e6dfd1;
        --accent: #2d5bff;
        --accent-soft: #edf2ff;
        --warm: #fbf0df;
        --green: #dff4e8;
        --shadow: 0 10px 40px rgba(21, 29, 46, 0.08);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        background:
          radial-gradient(circle at top left, rgba(253, 223, 166, 0.45), transparent 24%),
          radial-gradient(circle at top right, rgba(156, 198, 255, 0.35), transparent 30%),
          var(--bg);
        color: var(--ink);
        font-family: ui-serif, Georgia, "Times New Roman", serif;
      }
      main {
        max-width: 1180px;
        margin: 0 auto;
        padding: 32px 18px 72px;
      }
      .hero, .panel, .chart-panel, .thread-card {
        background: rgba(255, 253, 250, 0.92);
        border: 1px solid var(--border);
        border-radius: 24px;
        box-shadow: var(--shadow);
        backdrop-filter: blur(10px);
      }
      .hero {
        padding: 30px;
        margin-bottom: 18px;
      }
      .eyebrow {
        display: inline-block;
        padding: 6px 10px;
        border-radius: 999px;
        background: var(--accent-soft);
        color: var(--accent);
        font: 600 12px/1 ui-sans-serif, system-ui, sans-serif;
        letter-spacing: 0.04em;
        text-transform: uppercase;
      }
      h1, h2, h3, h4 {
        margin: 0;
      }
      h1 {
        margin-top: 14px;
        font-size: 42px;
        line-height: 1.05;
      }
      h2 {
        font-size: 28px;
        line-height: 1.1;
        margin-bottom: 12px;
      }
      h3 {
        font-size: 18px;
        line-height: 1.25;
      }
      p, li {
        font: 16px/1.6 ui-sans-serif, system-ui, sans-serif;
      }
      .meta {
        color: var(--muted);
      }
      .summary-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        gap: 12px;
        margin-top: 22px;
      }
      .report-nav {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        margin-top: 18px;
      }
      .report-nav a {
        display: inline-flex;
        align-items: center;
        padding: 8px 12px;
        border-radius: 999px;
        background: #fff;
        border: 1px solid var(--border);
        color: var(--ink);
        font: 600 13px/1 ui-sans-serif, system-ui, sans-serif;
        text-decoration: none;
      }
      .stat {
        border-radius: 18px;
        padding: 16px;
        background: linear-gradient(180deg, rgba(255,255,255,0.72), rgba(237,242,255,0.92));
        border: 1px solid rgba(45, 91, 255, 0.08);
      }
      .stat .value {
        font: 700 24px/1 ui-sans-serif, system-ui, sans-serif;
        margin-bottom: 6px;
      }
      .content-grid {
        display: grid;
        grid-template-columns: minmax(0, 1fr) 340px;
        gap: 18px;
        align-items: start;
      }
      .main-column {
        min-width: 0;
      }
      .side-column {
        display: grid;
        gap: 18px;
      }
      .panel, .chart-panel {
        padding: 24px;
        margin-bottom: 18px;
      }
      .at-a-glance {
        display: grid;
        gap: 12px;
      }
      .glance-section {
        padding: 14px 16px;
        border-radius: 18px;
        background: #fff;
        border: 1px solid var(--border);
        font: 15px/1.6 ui-sans-serif, system-ui, sans-serif;
      }
      .see-more {
        display: inline-block;
        margin-top: 8px;
        color: var(--accent);
        font-weight: 600;
        text-decoration: none;
      }
      .narrative p {
        margin: 0 0 12px;
      }
      .key-insight {
        margin-top: 16px;
        padding: 12px 14px;
        border-radius: 16px;
        background: var(--warm);
        font: 15px/1.5 ui-sans-serif, system-ui, sans-serif;
      }
      .project-areas, .insight-grid, .features-grid, .workflow-grid {
        display: grid;
        gap: 12px;
      }
      .project-area, .insight-card, .feature-card, .workflow-card, .agents-card {
        padding: 16px;
        border-radius: 18px;
        border: 1px solid var(--border);
        background: #fff;
      }
      .project-area .topline, .thread-topline {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        align-items: baseline;
      }
      .area-header {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        align-items: baseline;
        margin-bottom: 8px;
      }
      .area-name {
        font: 700 18px/1.3 ui-serif, Georgia, "Times New Roman", serif;
      }
      .area-count {
        color: var(--muted);
        font: 600 13px/1 ui-sans-serif, system-ui, sans-serif;
      }
      .area-desc {
        color: var(--ink);
      }
      .pill {
        display: inline-flex;
        align-items: center;
        border-radius: 999px;
        padding: 5px 10px;
        background: var(--accent-soft);
        color: var(--accent);
        font: 600 12px/1 ui-sans-serif, system-ui, sans-serif;
      }
      .examples {
        margin: 12px 0 0;
        padding-left: 18px;
      }
      .copy-block {
        margin-top: 12px;
        padding: 12px 14px;
        border-radius: 14px;
        background: #f5f7fb;
        border: 1px solid #dbe2f2;
        font: 13px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace;
        white-space: pre-wrap;
        word-break: break-word;
      }
      .section-intro {
        margin-top: 0;
        color: var(--muted);
      }
      .subsection {
        margin-top: 18px;
      }
      .subsection h3 {
        margin-bottom: 8px;
      }
      .subsection-intro {
        margin: 0 0 12px;
        color: var(--muted);
        font: 13px/1.6 ui-sans-serif, system-ui, sans-serif;
      }
      .copy-all-row {
        display: flex;
        justify-content: flex-end;
        margin-bottom: 12px;
      }
      .copy-btn, .copy-all-btn {
        border: 1px solid #cfd8eb;
        background: #fff;
        color: var(--ink);
        border-radius: 12px;
        padding: 8px 12px;
        font: 600 12px/1 ui-sans-serif, system-ui, sans-serif;
        cursor: pointer;
      }
      .copy-btn.copied, .copy-all-btn.copied {
        background: var(--accent);
        border-color: var(--accent);
        color: #fff;
      }
      .agents-item {
        display: grid;
        gap: 10px;
        padding: 16px;
        border-radius: 18px;
        border: 1px solid var(--border);
        background: #fff;
      }
      .agents-item-head {
        display: grid;
        grid-template-columns: 20px minmax(0, 1fr);
        gap: 12px;
        align-items: start;
      }
      .agents-item-head input {
        margin-top: 3px;
      }
      .agents-item-actions {
        display: flex;
        justify-content: space-between;
        gap: 10px;
        align-items: center;
      }
      .prompt-label, .why-label, .setup-label {
        display: block;
        margin-bottom: 8px;
        color: var(--muted);
        font: 600 12px/1 ui-sans-serif, system-ui, sans-serif;
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .copy-row {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 10px;
        align-items: start;
      }
      .copy-row code, .copy-row pre {
        margin: 0;
      }
      .copyable-code {
        padding: 12px 14px;
        border-radius: 14px;
        background: #f5f7fb;
        border: 1px solid #dbe2f2;
        font: 13px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace;
        white-space: pre-wrap;
        word-break: break-word;
      }
      .feature-why, .pattern-detail, .horizon-tip {
        margin-top: 10px;
      }
      .usage-grid, .usage-breakdown {
        display: grid;
        gap: 12px;
      }
      .usage-grid {
        grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
        margin-top: 16px;
      }
      .usage-detail {
        display: grid;
        gap: 12px;
      }
      .usage-card {
        padding: 16px;
        border-radius: 18px;
        border: 1px solid var(--border);
        background: #fff;
      }
      .usage-card .topline {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        align-items: baseline;
        margin-bottom: 10px;
      }
      .usage-card .meta-row {
        display: flex;
        flex-wrap: wrap;
        gap: 8px 14px;
        color: var(--muted);
        font: 13px/1.5 ui-sans-serif, system-ui, sans-serif;
      }
      .usage-card .token-row {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
        gap: 10px;
        margin-top: 12px;
      }
      .usage-card .token-box {
        padding: 10px 12px;
        border-radius: 14px;
        background: #faf8f2;
        border: 1px solid var(--border);
        font: 13px/1.4 ui-sans-serif, system-ui, sans-serif;
      }
      .bar-list {
        display: grid;
        gap: 10px;
      }
      .bar-row {
        display: grid;
        gap: 6px;
      }
      .bar-label {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        font: 14px/1.4 ui-sans-serif, system-ui, sans-serif;
      }
      .bar-track {
        height: 10px;
        border-radius: 999px;
        overflow: hidden;
        background: #edf0f6;
      }
      .bar-fill {
        height: 100%;
        background: linear-gradient(90deg, #2d5bff, #5c8bff);
      }
      .hour-grid {
        display: grid;
        gap: 10px;
      }
      .hour-bar {
        display: grid;
        grid-template-columns: 60px minmax(0, 1fr) 40px;
        gap: 10px;
        align-items: center;
        font: 13px/1.3 ui-sans-serif, system-ui, sans-serif;
      }
      .hour-track {
        height: 8px;
        border-radius: 999px;
        background: #ece7ff;
        overflow: hidden;
      }
      .hour-fill {
        height: 100%;
        background: linear-gradient(90deg, #7c52ff, #a58bff);
      }
      .thread-list {
        display: grid;
        gap: 14px;
      }
      .thread-card {
        padding: 18px;
      }
      .thread-metrics {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
        gap: 10px;
        margin-top: 14px;
      }
      .thread-metric {
        padding: 10px 12px;
        border-radius: 14px;
        background: #faf8f2;
        border: 1px solid var(--border);
        font: 13px/1.5 ui-sans-serif, system-ui, sans-serif;
      }
      .fun-ending {
        margin-top: 8px;
        padding-top: 16px;
        border-top: 1px dashed var(--border);
      }
      @media (max-width: 980px) {
        .content-grid {
          grid-template-columns: 1fr;
        }
      }
      @media (max-width: 720px) {
        main {
          padding: 18px 14px 48px;
        }
        h1 {
          font-size: 34px;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <section class="hero">
        <span class="eyebrow">${escapeHtml(text.eyebrow)}</span>
        <h1>${escapeHtml(text.reportTitle)}</h1>
        <p class="meta">${escapeHtml(text.generatedLabel)} ${escapeHtml(report.metadata.generatedAt)} ${escapeHtml(text.generatedFrom)} ${report.metadata.threadCount} ${escapeHtml(text.substantiveThreads)} ${escapeHtml(text.inCodexHome)} ${escapeHtml(formatCodexHome(report.metadata.codexHome))}.</p>
        <div class="summary-grid">
          ${renderStat(text.userMessages, formatNumber(report.summary.totalUserMessages))}
          ${renderStat(text.toolCalls, formatNumber(report.summary.totalToolCalls))}
          ${renderStat(text.duration, `${report.summary.totalDurationHours}h`)}
          ${renderStat(text.tokens, formatNumber(report.summary.totalTokens))}
          ${analysisUsage ? renderStat(text.analysisTokens, formatMillionTokens(analysisUsage.totalTokens)) : ''}
          ${renderStat(text.commits, formatNumber(report.summary.totalGitCommits))}
          ${renderStat(text.filesModified, formatNumber(report.summary.totalFilesModified))}
          ${renderStat(text.toolErrors, formatNumber(report.summary.totalToolErrors))}
          ${renderStat(text.avgResponse, formatSeconds(report.summary.averageResponseTimeSeconds))}
        </div>
        <nav class="report-nav">
          <a href="#section-work">${escapeHtml(text.whatYouWorkOn)}</a>
          <a href="#section-usage">${escapeHtml(text.howYouUseCodex)}</a>
          <a href="#section-wins">${escapeHtml(text.impressiveThings)}</a>
          <a href="#section-friction">${escapeHtml(text.whereThingsGoWrong)}</a>
          <a href="#section-features">${escapeHtml(text.featuresToTry)}</a>
          <a href="#section-patterns">${escapeHtml(text.newWaysToUseCodex)}</a>
          <a href="#section-horizon">${escapeHtml(text.onTheHorizon)}</a>
        </nav>
      </section>
      <div class="content-grid">
        <div class="main-column">
          ${renderAtAGlance(insights)}
          ${renderProjectAreas(insights)}
          ${renderInteractionStyle(insights)}
          ${renderWhatWorks(insights)}
          ${renderFriction(insights)}
          ${renderSuggestions(insights)}
          ${renderOnTheHorizon(insights)}
        </div>
        <aside class="side-column">
          <section class="chart-panel">
            <h2>${escapeHtml(text.topProjects)}</h2>
            ${topProjects}
          </section>
          <section class="chart-panel">
            <h2>${escapeHtml(text.modelMix)}</h2>
            ${modelMix}
          </section>
          <section class="chart-panel">
            <h2>${escapeHtml(text.sessionTypes)}</h2>
            ${sessionTypes}
          </section>
          <section class="chart-panel">
            <h2>${escapeHtml(text.outcomes)}</h2>
            ${outcomes}
          </section>
          <section class="chart-panel">
            <h2>${escapeHtml(text.capabilitySignals)}</h2>
            ${capabilitySignals}
          </section>
          <section class="chart-panel">
            <h2>${escapeHtml(text.failureHotspots)}</h2>
            ${toolFailures}
          </section>
          <section class="chart-panel">
            <h2>${escapeHtml(text.errorCategories)}</h2>
            ${toolErrorCategories}
          </section>
          <section class="chart-panel">
            <h2>${escapeHtml(text.timeOfDay)}</h2>
            ${activeHours}
          </section>
        </aside>
      </div>
      ${renderFunEnding(insights)}
      ${renderReportMeta(report, { analysisByStage, analysisByModel })}
    </main>
    <script>
      async function copyValue(btn, text) {
        try {
          await navigator.clipboard.writeText(text);
          const original = btn.textContent;
          btn.textContent = ${JSON.stringify(text.copied)};
          btn.classList.add('copied');
          setTimeout(() => {
            btn.textContent = original;
            btn.classList.remove('copied');
          }, 1800);
        } catch {}
      }

      window.copyText = function copyText(btn) {
        const value = btn?.dataset?.copy || '';
        if (!value) return;
        copyValue(btn, value);
      };

      window.copyAllCheckedAgentInstructions = function copyAllCheckedAgentInstructions(btn) {
        const values = Array.from(document.querySelectorAll('.agents-checkbox:checked'))
          .map(node => node.getAttribute('data-copy') || '')
          .filter(Boolean);
        if (!values.length) return;
        copyValue(btn, values.join('\\n\\n'));
      };
    </script>
  </body>
</html>`
}

function renderAtAGlance(insights) {
  const atAGlance = insights.at_a_glance
  if (!atAGlance) return ''
  const text = getReportText(insights.__lang)
  return `
    <section class="panel">
      <h2>${escapeHtml(text.atAGlance)}</h2>
      <div class="at-a-glance">
        <div class="glance-section"><strong>${escapeHtml(text.whatsWorking)}:</strong> ${escapeHtml(atAGlance.whats_working)} <a class="see-more" href="#section-wins">${escapeHtml(text.impressiveThingsLink)} →</a></div>
        <div class="glance-section"><strong>${escapeHtml(text.whatsHindering)}:</strong> ${escapeHtml(atAGlance.whats_hindering)} <a class="see-more" href="#section-friction">${escapeHtml(text.whereThingsGoWrongLink)} →</a></div>
        <div class="glance-section"><strong>${escapeHtml(text.quickWins)}:</strong> ${escapeHtml(atAGlance.quick_wins)} <a class="see-more" href="#section-features">${escapeHtml(text.featuresToTry)} →</a></div>
        <div class="glance-section"><strong>${escapeHtml(text.ambitiousWorkflows)}:</strong> ${escapeHtml(atAGlance.ambitious_workflows)} <a class="see-more" href="#section-horizon">${escapeHtml(text.onTheHorizon)} →</a></div>
      </div>
    </section>
  `
}

function renderProjectAreas(insights) {
  const projectAreas = insights.project_areas?.areas || []
  if (!projectAreas.length) return ''
  const text = getReportText(insights.__lang)
  return `
    <section class="panel">
      <h2 id="section-work">${escapeHtml(text.whatYouWorkOn)}</h2>
      <div class="project-areas">
        ${projectAreas
          .map(
            area => `
              <div class="project-area">
                <div class="area-header">
                  <span class="area-name">${escapeHtml(area.name)}</span>
                  <span class="area-count">${escapeHtml(text.workstreamBadge)}</span>
                </div>
                <div class="area-desc">${escapeHtml(area.description)}</div>
              </div>
            `,
          )
          .join('')}
      </div>
    </section>
  `
}

function renderInteractionStyle(insights) {
  const interactionStyle = insights.interaction_style
  if (!interactionStyle?.narrative) return ''
  const text = getReportText(insights.__lang)
  return `
    <section class="panel">
      <h2 id="section-usage">${escapeHtml(text.howYouUseCodex)}</h2>
      <div class="narrative">
        ${markdownToHtml(interactionStyle.narrative)}
        <div class="key-insight"><strong>${escapeHtml(text.keyPattern)}:</strong> ${escapeHtml(interactionStyle.key_pattern || '')}</div>
      </div>
    </section>
  `
}

function renderWhatWorks(insights) {
  const whatWorks = insights.what_works
  if (!whatWorks?.impressive_workflows?.length) return ''
  const text = getReportText(insights.__lang)
  return `
    <section class="panel">
      <h2 id="section-wins">${escapeHtml(text.impressiveThings)}</h2>
      <p class="section-intro">${escapeHtml(whatWorks.intro || '')}</p>
      <div class="insight-grid">
        ${whatWorks.impressive_workflows
          .map(
            workflow => `
              <div class="insight-card">
                <h3>${escapeHtml(workflow.title)}</h3>
                <p>${escapeHtml(workflow.description)}</p>
              </div>
            `,
          )
          .join('')}
      </div>
    </section>
  `
}

function renderFriction(insights) {
  const friction = insights.friction_analysis
  if (!friction?.categories?.length) return ''
  const text = getReportText(insights.__lang)
  return `
    <section class="panel">
      <h2 id="section-friction">${escapeHtml(text.whereThingsGoWrong)}</h2>
      <p class="section-intro">${escapeHtml(friction.intro || '')}</p>
      <div class="insight-grid">
        ${friction.categories
          .map(
            category => `
              <div class="insight-card">
                <h3>${escapeHtml(category.category)}</h3>
                <p>${escapeHtml(category.description)}</p>
                <ul class="examples">
                  ${(category.examples || []).map(example => `<li>${escapeHtml(example)}</li>`).join('')}
                </ul>
              </div>
            `,
          )
          .join('')}
      </div>
    </section>
  `
}

function renderSuggestions(insights) {
  const suggestions = insights.suggestions
  if (!suggestions) return ''
  const text = getReportText(insights.__lang)
  const agentItems = (suggestions.agents_md_additions || []).map(normalizeSuggestionTextItem)
  const featureItems = (suggestions.features_to_try || []).map(normalizeSuggestionTextItem)
  const patternItems = (suggestions.usage_patterns || []).map(normalizeSuggestionTextItem)

  return `
    <section class="panel">
      <h2 id="section-features">${escapeHtml(text.featuresToTry)}</h2>
      ${
        agentItems.length
          ? `<div class="subsection">
        <h3>${escapeHtml(text.suggestedAgentsAdditions)}</h3>
        <p class="subsection-intro">${escapeHtml(text.agentsSectionIntro)}</p>
        <div class="copy-all-row">
          <button class="copy-all-btn" onclick="copyAllCheckedAgentInstructions(this)">${escapeHtml(text.copyAllChecked)}</button>
        </div>
        <div class="workflow-grid">
          ${agentItems
            .map(
              (item, index) => `
                <div class="agents-item">
                  <div class="agents-item-head">
                    <input type="checkbox" checked class="agents-checkbox" id="agents-item-${index}" data-copy="${escapeAttribute(formatAgentInstruction(item))}">
                    <div>
                      <label for="agents-item-${index}"><strong>${escapeHtml(text.agentsAddition)}</strong></label>
                      <div class="meta">${escapeHtml(item.prompt_scaffold || '')}</div>
                    </div>
                  </div>
                  <div>
                    <span class="why-label">${escapeHtml(text.whyThisHelps)}</span>
                    <p>${escapeHtml(item.why || '')}</p>
                  </div>
                  ${renderCopyRow(formatAgentInstruction(item), text)}
                </div>
              `,
            )
            .join('')}
        </div>
      </div>`
          : ''
      }
      ${
        featureItems.length
          ? `<div class="subsection">
        <h3>${escapeHtml(text.existingFeaturesHeading)}</h3>
        <p class="subsection-intro">${escapeHtml(text.featuresSectionIntro)}</p>
        <div class="features-grid">
          ${featureItems
            .map(
              feature => `
                <div class="feature-card">
                  <div class="topline">
                    <h3>${escapeHtml(feature.feature)}</h3>
                    <span class="pill">${escapeHtml(feature.one_liner)}</span>
                  </div>
                  <div class="feature-why"><strong>${escapeHtml(text.whyForYou)}:</strong> ${escapeHtml(feature.why_for_you)}</div>
                  ${feature.example_code ? `<div class="setup-label">${escapeHtml(text.tryThis)}</div>${renderCopyRow(feature.example_code, text)}` : ''}
                </div>
              `,
            )
            .join('')}
        </div>
      </div>`
          : ''
      }
      ${
        patternItems.length
          ? `<div class="subsection">
        <h3 id="section-patterns">${escapeHtml(text.newWaysToUseCodex)}</h3>
        <p class="subsection-intro">${escapeHtml(text.patternsSectionIntro)}</p>
        <div class="workflow-grid">
          ${patternItems
            .map(
              pattern => `
                <div class="workflow-card">
                  <h3>${escapeHtml(pattern.title)}</h3>
                  <p><strong>${escapeHtml(pattern.suggestion)}</strong></p>
                  <p class="pattern-detail">${escapeHtml(pattern.detail)}</p>
                  ${pattern.copyable_prompt ? `<div class="prompt-label">${escapeHtml(text.pasteIntoCodex)}</div>${renderCopyRow(pattern.copyable_prompt, text)}` : ''}
                </div>
              `,
            )
            .join('')}
        </div>
      </div>`
          : ''
      }
    </section>
  `
}

function renderOnTheHorizon(insights) {
  const horizon = insights.on_the_horizon
  if (!horizon?.opportunities?.length) return ''
  const text = getReportText(insights.__lang)
  return `
    <section class="panel">
      <h2 id="section-horizon">${escapeHtml(text.onTheHorizon)}</h2>
      <p class="section-intro">${escapeHtml(horizon.intro || '')}</p>
      <div class="insight-grid">
        ${horizon.opportunities
          .map(
            item => `
              <div class="insight-card">
                <h3>${escapeHtml(item.title)}</h3>
                <p>${escapeHtml(item.whats_possible)}</p>
                <div class="horizon-tip"><strong>${escapeHtml(text.gettingStarted)}:</strong> ${escapeHtml(item.how_to_try || '')}</div>
                ${item.copyable_prompt ? `<div class="prompt-label">${escapeHtml(text.pasteIntoCodex)}</div>${renderCopyRow(item.copyable_prompt, text)}` : ''}
              </div>
            `,
          )
          .join('')}
      </div>
    </section>
  `
}

function renderReportMeta(report, context = {}) {
  const text = getReportText(report.metadata.language)
  const usage = report.analysisUsage
  const hasUsage = Boolean(usage?.totalTokens)
  const estimateComparison = buildEstimateComparison(report)
  const analysisByStage = context.analysisByStage || ''
  const analysisByModel = context.analysisByModel || ''

  const freshInputTokens = Math.max(0, usage.inputTokens - usage.cachedInputTokens)

  return `
    <section class="panel">
      <h2>${escapeHtml(text.aboutThisReport)}</h2>
      <p class="section-intro">${escapeHtml(text.aboutThisReportIntro)}</p>
      <div class="usage-grid">
        ${renderStat(text.threadsAnalyzed, formatNumber(report.metadata.threadCount))}
        ${renderStat(text.dateRange, `${escapeHtml(report.metadata.dateRange.start)} -> ${escapeHtml(report.metadata.dateRange.end)}`)}
        ${hasUsage ? renderStat(text.analysisTokens, formatMillionTokens(usage.totalTokens)) : ''}
        ${hasUsage ? renderStat(text.modelCalls, formatNumber(usage.calls)) : ''}
        ${hasUsage ? renderStat(text.cachedInput, formatMillionTokens(usage.cachedInputTokens)) : ''}
        ${estimateComparison ? renderStat(text.estimateDelta, `${formatSignedMillionTokens(estimateComparison.deltaTokens)} (${formatSignedPercent(estimateComparison.deltaPercent)})`) : ''}
        ${renderStat(text.historicalSessionTokens, formatNumber(report.summary.totalTokens))}
      </div>
      ${
        hasUsage
          ? `<div class="usage-detail" style="margin-top:18px;">
        <div class="usage-breakdown">
          <h3>${escapeHtml(text.analysisCostByStage)}</h3>
          ${analysisByStage}
        </div>
        <div class="usage-breakdown">
          <h3>${escapeHtml(text.analysisCostByModel)}</h3>
          ${analysisByModel}
        </div>
        <div class="usage-breakdown">
          <h3>${escapeHtml(text.usageDetails)}</h3>
          ${renderUsageCard({
            label: usage.provider || report.provider || 'unknown',
            calls: usage.calls,
            inputTokens: usage.inputTokens,
            cachedInputTokens: usage.cachedInputTokens,
            outputTokens: usage.outputTokens,
            totalTokens: usage.totalTokens,
          })}
          <p class="meta">${escapeHtml(text.freshInput)}: ${formatMillionTokens(freshInputTokens)}. ${escapeHtml(text.analysisCostFootnote)}</p>
        </div>
        ${
          estimateComparison
            ? `<div class="usage-breakdown">
          <h3>${escapeHtml(text.estimateVsActualHeading)}</h3>
          ${renderEstimateComparisonCard(estimateComparison, text)}
        </div>`
            : ''
        }
      </div>`
          : ''
      }
    </section>
  `
}

function renderFunEnding(insights) {
  const ending = insights.fun_ending
  if (!ending?.headline) return ''
  const text = getReportText(insights.__lang)
  return `
    <section class="panel fun-ending">
      <h2>${escapeHtml(text.oneMoreThing)}</h2>
      <h3>${escapeHtml(ending.headline)}</h3>
      <p>${escapeHtml(ending.detail || '')}</p>
    </section>
  `
}

function renderUsageCard(item) {
  const freshInputTokens = Math.max(0, Number(item.inputTokens || 0) - Number(item.cachedInputTokens || 0))
  return `
    <div class="usage-card">
      <div class="topline">
        <h3>${escapeHtml(item.label)}</h3>
        <span class="pill">${formatNumber(item.calls)} calls</span>
      </div>
      <div class="meta-row">
        <span>Total: ${formatMillionTokens(item.totalTokens)}</span>
        <span>Fresh input share: ${formatPercent(freshInputTokens, item.totalTokens)}</span>
        <span>Output share: ${formatPercent(item.outputTokens, item.totalTokens)}</span>
      </div>
      <div class="token-row">
        <div class="token-box"><strong>Total</strong><br>${formatMillionTokens(item.totalTokens)}</div>
        <div class="token-box"><strong>Input</strong><br>${formatMillionTokens(item.inputTokens)}</div>
        <div class="token-box"><strong>Cached Input</strong><br>${formatMillionTokens(item.cachedInputTokens)}</div>
        <div class="token-box"><strong>Fresh Input</strong><br>${formatMillionTokens(freshInputTokens)}</div>
        <div class="token-box"><strong>Output</strong><br>${formatMillionTokens(item.outputTokens)}</div>
      </div>
    </div>
  `
}

function renderEstimateComparisonCard(comparison, text) {
  return `
    <div class="usage-card">
      <div class="topline">
        <h3>${escapeHtml(text.estimateVsActualLabel)}</h3>
        <span class="pill">${escapeHtml(comparison.verdictLabel)}</span>
      </div>
      <div class="meta-row">
        <span>${escapeHtml(text.estimatedLabel)}: ${formatMillionTokens(comparison.estimatedTotalTokens)}</span>
        <span>${escapeHtml(text.actualFreshLabel)}: ${formatMillionTokens(comparison.actualTotalTokens)}</span>
        <span>${escapeHtml(text.estimateDelta)}: ${formatSignedMillionTokens(comparison.deltaTokens)} (${formatSignedPercent(comparison.deltaPercent)})</span>
      </div>
      <div class="token-row">
        <div class="token-box"><strong>${escapeHtml(text.estimatedLabel)}</strong><br>${formatMillionTokens(comparison.estimatedTotalTokens)}</div>
        <div class="token-box"><strong>${escapeHtml(text.actualFreshLabel)}</strong><br>${formatMillionTokens(comparison.actualTotalTokens)}</div>
        <div class="token-box"><strong>${escapeHtml(text.estimateRangeLabel)}</strong><br>${formatMillionTokens(comparison.lowEstimate)} -> ${formatMillionTokens(comparison.highEstimate)}</div>
        <div class="token-box"><strong>${escapeHtml(text.estimateDelta)}</strong><br>${formatSignedMillionTokens(comparison.deltaTokens)}</div>
        <div class="token-box"><strong>${escapeHtml(text.estimateError)}</strong><br>${formatSignedPercent(comparison.deltaPercent)}</div>
      </div>
    </div>
  `
}

function renderStat(label, value) {
  return `<div class="stat"><div class="value">${escapeHtml(String(value))}</div><div>${escapeHtml(label)}</div></div>`
}

function renderBarList(items, options = {}) {
  if (!items.length) return '<p class="meta">No data available.</p>'
  const formatLabel = options.formatLabel || (value => value)
  const maxValue = Math.max(...items.map(item => item.value), 1)
  return `<div class="bar-list">${items
    .map(
      item => `
        <div class="bar-row">
          <div class="bar-label">
            <span>${escapeHtml(formatLabel(item.label))}</span>
            <strong>${formatNumber(item.value)}</strong>
          </div>
          <div class="bar-track"><div class="bar-fill" style="width:${Math.max(6, (item.value / maxValue) * 100)}%"></div></div>
        </div>
      `,
    )
    .join('')}</div>`
}

function renderHourHistogram(hourSeries) {
  if (!hourSeries.length) return '<p class="meta">No data available.</p>'
  const grouped = [
    { label: 'Night', hours: [0, 1, 2, 3, 4, 5] },
    { label: 'Morning', hours: [6, 7, 8, 9, 10, 11] },
    { label: 'Afternoon', hours: [12, 13, 14, 15, 16, 17] },
    { label: 'Evening', hours: [18, 19, 20, 21, 22, 23] },
  ].map(group => ({
    label: group.label,
    value: group.hours.reduce((sum, hour) => sum + Number(hourSeries[hour]?.value || 0), 0),
  }))

  const maxValue = Math.max(...grouped.map(item => item.value), 1)
  return `<div class="hour-grid">${grouped
    .map(
      item => `
        <div class="hour-bar">
          <span>${escapeHtml(item.label)}</span>
          <div class="hour-track"><div class="hour-fill" style="width:${(item.value / maxValue) * 100}%"></div></div>
          <strong>${formatNumber(item.value)}</strong>
        </div>
      `,
    )
    .join('')}</div>`
}

function markdownToHtml(text) {
  return String(text || '')
    .split('\n\n')
    .filter(Boolean)
    .map(paragraph => `<p>${escapeHtml(paragraph).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>')}</p>`)
    .join('\n')
}

function renderCopyRow(value, text) {
  const content = String(value || '').trim()
  if (!content) return ''
  return `
    <div class="copy-row">
      <pre class="copyable-code"><code>${escapeHtml(content)}</code></pre>
      <button class="copy-btn" data-copy="${escapeAttribute(content)}" onclick="copyText(this)">${escapeHtml(text.copy)}</button>
    </div>
  `
}

function normalizeSuggestionTextItem(item) {
  if (!item || typeof item !== 'object') return item
  return Object.fromEntries(
    Object.entries(item).map(([key, value]) => [key, normalizeSuggestionText(value)]),
  )
}

function normalizeSuggestionText(value) {
  if (typeof value !== 'string') return value
  return value
    .replaceAll('CLAUDE.md / AGENTS.md', 'AGENTS.md')
    .replaceAll('CLAUDE.md', 'AGENTS.md')
}

function formatAgentInstruction(item) {
  const placement = String(item?.prompt_scaffold || '').trim()
  const addition = String(item?.addition || '').trim()
  if (placement && addition) {
    return `${placement}\n\n${addition}`
  }
  return addition || placement
}

function topEntries(map, limit) {
  return Object.entries(map)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([label, value]) => ({ label, value }))
}

function formatCodexHome(value) {
  return formatDisplayPath(value, { tailSegments: 2, preferHomeAlias: true, ellipsis: false })
}

function formatProjectLabel(value) {
  return formatDisplayPath(value, { tailSegments: 2, preferHomeAlias: false, ellipsis: true })
}

function formatSessionTypeLabel(value, lang) {
  const key = String(value || '')
  const zh = {
    iterative_refinement: '反复收敛',
    exploration: '探索调研',
    single_task: '单任务推进',
    multi_task: '多任务并行',
    quick_question: '快速提问',
  }
  const en = {
    iterative_refinement: 'Iterative refinement',
    exploration: 'Exploration',
    single_task: 'Single-task execution',
    multi_task: 'Multi-task coordination',
    quick_question: 'Quick question',
  }
  return lang === 'zh-CN' ? zh[key] || key : en[key] || key
}

function formatOutcomeLabel(value, lang) {
  const key = String(value || '')
  const zh = {
    fully_achieved: '完全达成',
    mostly_achieved: '基本达成',
    partially_achieved: '部分达成',
    not_achieved: '未达成',
    unclear_from_transcript: '从记录中无法判断',
  }
  const en = {
    fully_achieved: 'Fully achieved',
    mostly_achieved: 'Mostly achieved',
    partially_achieved: 'Partially achieved',
    not_achieved: 'Not achieved',
    unclear_from_transcript: 'Unclear from transcript',
  }
  return lang === 'zh-CN' ? zh[key] || key : en[key] || key
}

function formatDisplayPath(value, options = {}) {
  const text = String(value || '').trim()
  if (!text) return '(unknown)'

  const normalized = text.replace(/\\/g, '/')
  const home = os.homedir().replace(/\\/g, '/')
  if (options.preferHomeAlias !== false && normalized === home) return '~'
  if (options.preferHomeAlias !== false && normalized.startsWith(`${home}/`)) {
    return `~/${normalized.slice(home.length + 1)}`
  }

  const parts = normalized.split('/').filter(Boolean)
  const tailSegments = Math.max(1, Number(options.tailSegments || 2))
  if (parts.length <= tailSegments) {
    return normalized.startsWith('/') ? `/${parts.join('/')}` : parts.join('/')
  }

  const tail = parts.slice(-tailSegments).join('/')
  if (options.ellipsis === false) return tail
  return `…/${tail}`
}

function buildHourSeries(hourMap) {
  return Array.from({ length: 24 }, (_, hour) => ({
    hour,
    value: Number(hourMap[String(hour)] ?? 0),
  }))
}

function increment(map, key, amount = 1) {
  map[key] = (map[key] || 0) + amount
}

function round(value) {
  return Math.round(value * 10) / 10
}

function formatInteger(value) {
  return new Intl.NumberFormat('en-US').format(Math.round(Number(value || 0)))
}

function formatCompactTokens(value) {
  const number = Number(value || 0)
  if (number >= 1_000_000) return `${round(number / 1_000_000)}M`
  if (number >= 1_000) return `${round(number / 1_000)}k`
  return String(Math.round(number))
}

function formatMillionTokens(value) {
  const number = Number(value || 0)
  if (number >= 1_000_000) return `${round(number / 1_000_000)}M tokens`
  return `${round(number / 1_000)}K tokens`
}

function formatSignedMillionTokens(value) {
  const number = Number(value || 0)
  const prefix = number > 0 ? '+' : number < 0 ? '-' : ''
  return `${prefix}${formatMillionTokens(Math.abs(number))}`
}

function formatPercent(value, total) {
  const numerator = Number(value || 0)
  const denominator = Number(total || 0)
  if (!denominator) return '0%'
  return `${round((numerator / denominator) * 100)}%`
}

function formatSignedPercent(value) {
  const number = Number(value || 0)
  const prefix = number > 0 ? '+' : number < 0 ? '-' : ''
  return `${prefix}${round(Math.abs(number))}%`
}

function average(values) {
  if (!values.length) return 0
  return round(values.reduce((sum, value) => sum + value, 0) / values.length)
}

function formatNumber(value) {
  return new Intl.NumberFormat('en-US').format(Math.round(value))
}

function formatSeconds(value) {
  if (!value) return 'n/a'
  return `${round(value)}s`
}

function detectOverlaps(userMessageTimestamps) {
  const sorted = [...userMessageTimestamps].sort((a, b) => a.ts - b.ts)
  const windowMs = 30 * 60 * 1000
  const pairs = new Set()

  for (let i = 0; i < sorted.length; i += 1) {
    const current = sorted[i]
    for (let j = i + 1; j < sorted.length; j += 1) {
      const next = sorted[j]
      if (next.ts - current.ts > windowMs) break
      if (next.threadId === current.threadId) continue
      pairs.add([current.threadId, next.threadId].sort().join(':'))
    }
  }

  const threadsInvolved = new Set()
  for (const pair of pairs) {
    const [left, right] = pair.split(':')
    if (left) threadsInvolved.add(left)
    if (right) threadsInvolved.add(right)
  }

  return {
    overlapEvents: pairs.size,
    threadsInvolved: threadsInvolved.size,
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function escapeAttribute(value) {
  return escapeHtml(String(value)).replaceAll("'", '&#39;').replaceAll('\n', '&#10;')
}

function buildEstimateComparison(report) {
  const estimate = report.analysisEstimate
  const usage = report.analysisUsage
  if (!estimate?.estimatedTotalTokens || !usage?.totalTokens) return null

  const estimated = Number(estimate.estimatedTotalTokens || 0)
  const actualFresh =
    Math.max(0, Number(usage.inputTokens || 0) - Number(usage.cachedInputTokens || 0)) +
    Number(usage.outputTokens || 0)
  const delta = actualFresh - estimated
  const deltaPercent = estimated > 0 ? (delta / estimated) * 100 : 0

  return {
    estimatedTotalTokens: estimated,
    actualTotalTokens: actualFresh,
    lowEstimate: Number(estimate.estimatedRange?.low || estimated),
    highEstimate: Number(estimate.estimatedRange?.high || estimated),
    deltaTokens: delta,
    deltaPercent,
    verdictLabel: classifyEstimateDelta(deltaPercent, report.metadata.language),
  }
}

function classifyEstimateDelta(deltaPercent, lang) {
  const abs = Math.abs(Number(deltaPercent || 0))
  if (lang === 'zh-CN') {
    if (abs <= 10) return '估算接近'
    if (deltaPercent > 0) return '实际偏高'
    return '实际偏低'
  }
  if (abs <= 10) return 'Close estimate'
  if (deltaPercent > 0) return 'Actual higher'
  return 'Actual lower'
}

function getReportText(lang) {
  if (lang === 'zh-CN') {
    return {
      reportTitle: 'Codex Insights',
      eyebrow: 'Codex 会话报告',
      generatedLabel: '生成时间',
      generatedFrom: '，基于',
      substantiveThreads: '个有效线程',
      inCodexHome: '，Codex 目录',
      userMessages: '用户消息',
      toolCalls: '工具调用',
      duration: '时长',
      tokens: '历史 Tokens',
      analysisTokens: '分析 Tokens',
      commits: '提交数',
      filesModified: '修改文件',
      toolErrors: '工具错误',
      avgResponse: '平均响应',
      topProjects: '项目分布',
      modelMix: '模型分布',
      sessionTypes: '会话类型',
      outcomes: '结果分布',
      capabilitySignals: '能力信号',
      failureHotspots: '失败热点',
      errorCategories: '错误分类',
      timeOfDay: '活跃时段',
      atAGlance: '一眼看懂',
      whatsWorking: '目前顺的地方',
      whatsHindering: '阻碍你的地方',
      quickWins: '可以立刻尝试的优化',
      ambitiousWorkflows: '值得尝试的更强工作流',
      sessionsLabel: '次会话',
      workstreamBadge: '代表性工作流',
      impressiveThingsLink: '做得好的地方',
      whereThingsGoWrongLink: '容易出问题的地方',
      whatYouWorkOn: '你主要在做什么',
      howYouUseCodex: '你是怎么用 Codex 的',
      keyPattern: '关键模式',
      impressiveThings: '做得好的地方',
      whereThingsGoWrong: '容易出问题的地方',
      featuresToTry: '可以尝试的能力',
      existingFeaturesHeading: '现有 Codex 能力，建议你先试这些',
      newWaysToUseCodex: '新的 Codex 使用方式',
      suggestedAgentsAdditions: '建议补进 AGENTS.md 的内容',
      agentsSectionIntro: '勾选后可一起复制，再放进你的 AGENTS.md 或仓库规范里。',
      featuresSectionIntro: '下面这些是现成能力。不是抽象建议，而是你现在就可以直接试的配置、命令或片段。',
      patternsSectionIntro: '这些不是新功能，而是更适合你当前工作方式的用法。直接复制下面的提示词到 Codex 里试。',
      agentsAddition: 'AGENTS.md 建议补充',
      copyAllChecked: '复制所有勾选项',
      copy: '复制',
      copied: '已复制',
      whyThisHelps: '为什么这条值得加',
      whyForYou: '为什么适合你',
      tryThis: '可以直接试这个',
      pasteIntoCodex: '粘贴到 Codex：',
      gettingStarted: '开始方式',
      onTheHorizon: '下一步可以做什么',
      aboutThisReport: '关于这份报告',
      aboutThisReportIntro: '这里是这份报告的生成附录。上面的主体部分仍然聚焦在你的会话模式和协作习惯。',
      threadsAnalyzed: '分析线程数',
      dateRange: '时间范围',
      modelCalls: '模型调用',
      cachedInput: '缓存输入',
      estimatedLabel: '预估',
      actualLabel: '实际',
      actualFreshLabel: '实际（不含缓存）',
      actualFreshSuffix: '（不含缓存）',
      estimateRangeLabel: '预估区间',
      estimateVsActualHeading: '预估与实际',
      estimateVsActualLabel: '预估 vs 实际',
      estimateDelta: '偏差',
      estimateError: '偏差比例',
      historicalSessionTokens: '历史会话 Tokens',
      analysisCostByStage: '按阶段拆分的分析成本',
      analysisCostByModel: '按模型拆分的分析成本',
      usageDetails: '使用详情',
      freshInput: '新输入',
      analysisCostFootnote: '这是生成报告本身的额外消耗，不包含上面统计的历史 Codex 会话 tokens。',
      oneMoreThing: '最后一件事',
      threadsShort: 'threads',
      userMsgsShort: '用户消息',
      toolCallsShort: '工具调用',
      analysisCostLabel: '分析成本',
      across: '共',
      modelCallsShort: '次模型调用',
      inputLabel: '输入',
      cachedLabel: '缓存',
      outputLabel: '输出',
    }
  }

  return {
    reportTitle: 'Codex Insights',
    eyebrow: 'Codex Usage Report',
    generatedLabel: 'Generated',
    generatedFrom: 'from',
    substantiveThreads: 'substantive threads',
    inCodexHome: 'in',
    userMessages: 'User Messages',
    toolCalls: 'Tool Calls',
    duration: 'Duration',
    tokens: 'Historical Tokens',
    analysisTokens: 'Analysis Tokens',
    commits: 'Commits',
    filesModified: 'Files Modified',
    toolErrors: 'Tool Errors',
    avgResponse: 'Avg Response',
    topProjects: 'Top Projects',
    modelMix: 'Model Mix',
    sessionTypes: 'Session Types',
    outcomes: 'Outcomes',
    capabilitySignals: 'Capability Signals',
    failureHotspots: 'Failure Hotspots',
    errorCategories: 'Error Categories',
    timeOfDay: 'Time of Day',
    atAGlance: 'At a Glance',
    whatsWorking: "What's working",
    whatsHindering: "What's hindering you",
    quickWins: 'Quick wins to try',
    ambitiousWorkflows: 'Ambitious workflows',
    sessionsLabel: 'sessions',
    workstreamBadge: 'Representative workstream',
    impressiveThingsLink: 'Impressive Things You Did',
    whereThingsGoWrongLink: 'Where Things Go Wrong',
    whatYouWorkOn: 'What You Work On',
    howYouUseCodex: 'How You Use Codex',
    keyPattern: 'Key pattern',
    impressiveThings: 'Impressive Things You Did',
    whereThingsGoWrong: 'Where Things Go Wrong',
    featuresToTry: 'Features to Try',
    existingFeaturesHeading: 'Existing Codex Features to Try',
    newWaysToUseCodex: 'New Ways to Use Codex',
    suggestedAgentsAdditions: 'Suggested AGENTS.md Additions',
    agentsSectionIntro: 'Check the items you want, then copy them into your AGENTS.md or repo playbook.',
    featuresSectionIntro: 'These are existing Codex features worth trying now, not abstract advice.',
    patternsSectionIntro: 'These are concrete ways to use Codex differently based on how you already work.',
    agentsAddition: 'AGENTS.md Addition',
    copyAllChecked: 'Copy All Checked',
    copy: 'Copy',
    copied: 'Copied',
    whyThisHelps: 'Why this helps',
    whyForYou: 'Why for you',
    tryThis: 'Try this',
    pasteIntoCodex: 'Paste into Codex:',
    gettingStarted: 'Getting started',
    onTheHorizon: 'On the Horizon',
    aboutThisReport: 'About This Report',
    aboutThisReportIntro: 'A compact appendix for how this page was generated. The main report above stays focused on your session patterns.',
    threadsAnalyzed: 'Threads Analyzed',
    dateRange: 'Date Range',
    modelCalls: 'Model Calls',
    cachedInput: 'Cached Input',
    estimatedLabel: 'Estimated',
    actualLabel: 'Actual',
    actualFreshLabel: 'Actual (fresh)',
    actualFreshSuffix: '(fresh)',
    estimateRangeLabel: 'Estimate range',
    estimateVsActualHeading: 'Estimate vs Actual',
    estimateVsActualLabel: 'Estimate vs Actual',
    estimateDelta: 'Delta',
    estimateError: 'Error',
    historicalSessionTokens: 'Historical Session Tokens',
    analysisCostByStage: 'Analysis Cost by Stage',
    analysisCostByModel: 'Analysis Cost by Model',
    usageDetails: 'Usage Details',
    freshInput: 'Fresh input',
    analysisCostFootnote: 'This is the extra spend for generating the report, separate from the historical Codex session tokens above.',
    oneMoreThing: 'One More Thing',
    threadsShort: 'threads',
    userMsgsShort: 'user msgs',
    toolCallsShort: 'tool calls',
    analysisCostLabel: 'Analysis cost',
    across: 'across',
    modelCallsShort: 'model calls',
    inputLabel: 'input',
    cachedLabel: 'cached',
    outputLabel: 'output',
  }
}
