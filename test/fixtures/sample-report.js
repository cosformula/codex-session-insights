import { buildReport } from '../../lib/report.js'

function makeSummary(overrides = {}) {
  return {
    id: 'thread-1',
    title: 'Fix parser and publish package',
    firstUserMessage: 'Fix parser issue and get the package ready to publish.',
    cwd: '/repo/codex-session-insights',
    model: 'gpt-5.4',
    modelProvider: 'openai',
    createdAt: '2026-04-01T10:00:00.000Z',
    updatedAt: '2026-04-02T10:00:00.000Z',
    durationMinutes: 28,
    userMessages: 4,
    assistantMessages: 3,
    commentaryMessages: 2,
    finalMessages: 1,
    reasoningItems: 1,
    toolCounts: { apply_patch: 2, exec_command: 1 },
    commandKindCounts: { git_commit: 1 },
    toolFailures: { git_push: 1 },
    totalToolCalls: 3,
    totalCommandFailures: 1,
    commandFailures: [],
    commandSamples: [],
    averageCommandDurationMs: 1200,
    medianResponseTimeSeconds: 8,
    averageResponseTimeSeconds: 10,
    activeHours: [10, 11],
    userMessageTimestamps: ['2026-04-02T10:00:00.000Z'],
    transcriptForAnalysis: '[User] Fix parser',
    gitCommits: 1,
    gitPushes: 0,
    userInterruptions: 1,
    toolErrors: 1,
    toolErrorCategories: { git_push: 1 },
    usesTaskAgent: true,
    usesMcp: false,
    usesWebSearch: true,
    usesWebFetch: false,
    linesAdded: 12,
    linesRemoved: 4,
    filesModified: 2,
    tokenUsage: {
      inputTokens: 120,
      cachedInputTokens: 30,
      outputTokens: 22,
      reasoningOutputTokens: 5,
      totalTokens: 177,
    },
    ...overrides,
  }
}

export function createSampleReport() {
  const report = buildReport(
    [
      makeSummary(),
      makeSummary({
        id: 'thread-2',
        title: 'Tighten prompts and add tests',
        cwd: '/repo/codex-session-insights',
        model: 'gpt-5.3-codex-spark',
        createdAt: '2026-04-03T10:00:00.000Z',
        updatedAt: '2026-04-04T10:00:00.000Z',
        totalCommandFailures: 0,
        toolFailures: {},
        toolErrorCategories: {},
        totalToolCalls: 1,
        toolCounts: { 'web.search_query': 1 },
        commandKindCounts: {},
        userMessageTimestamps: ['2026-04-04T10:00:00.000Z'],
        tokenUsage: {
          inputTokens: 80,
          cachedInputTokens: 0,
          outputTokens: 10,
          reasoningOutputTokens: 0,
          totalTokens: 90,
        },
      }),
    ],
    {
      codexHome: '/tmp/.codex',
      days: 30,
      threadPreviewLimit: 10,
      insightsOverride: {
        at_a_glance: {
          whats_working: 'You use Codex well for fast edit-review loops and multi-step cleanup tasks.',
          whats_hindering: 'Push failures and repeated context-setting still slow down the final mile.',
          quick_wins: 'Move recurring repo rules into AGENTS.md and reuse a publish checklist.',
          ambitious_workflows: 'Use sub-agents for bounded parallel cleanup and release preparation.',
        },
        project_areas: {
          areas: [
            {
              name: 'Parser hardening',
              session_count: 1,
              description: 'You use Codex to trace parser failures, patch code, and validate fixes quickly.',
            },
            {
              name: 'Release preparation',
              session_count: 1,
              description: 'You use Codex to tighten package metadata, README copy, and publish readiness.',
            },
          ],
        },
        interaction_style: {
          narrative:
            'You tend to work in short, directive loops. You tighten the brief as soon as the output drifts and you prefer concrete edits over open-ended exploration.',
          key_pattern: 'Short, corrective loops with fast scope tightening',
        },
        what_works: {
          intro: 'A few collaboration habits are already high leverage.',
          impressive_workflows: [
            {
              title: 'Fast edit-review loops',
              description: 'You use Codex well for finding a target file, patching it, and quickly reviewing the result.',
            },
            {
              title: 'Structured release cleanup',
              description: 'You break release prep into metadata, docs, naming, and publish checks instead of mixing them together.',
            },
            {
              title: 'Cost-aware analysis',
              description: 'You consistently push the tool toward lower-token, more controlled analysis runs.',
            },
          ],
        },
        friction_analysis: {
          intro: 'Most friction shows up near the end of otherwise good sessions.',
          categories: [
            {
              category: 'Final-mile publishing friction',
              description: 'The code and docs get cleaned up, but publish and repo metadata details still need extra passes.',
              examples: ['Package naming had to be revisited.', 'Publish readiness needed extra validation.'],
            },
            {
              category: 'Repeated context restatement',
              description: 'A few repo rules and workflow preferences were repeated across sessions instead of being captured once.',
              examples: ['Naming guidance had to be restated.', 'Public/private repo boundaries were re-explained.'],
            },
            {
              category: 'Tool-output cleanup',
              description: 'Model or tool output sometimes needed additional tightening before it matched your bar.',
              examples: ['Prompt wording had to be made more product-neutral.', 'Report cost presentation was tightened.'],
            },
          ],
        },
        suggestions: {
          agents_md_additions: [
            {
              addition: 'Add a release checklist section to AGENTS.md',
              why: 'You repeatedly refine naming, privacy, and publish readiness decisions.',
              prompt_scaffold: 'Place it under a Release section at the repo root.',
            },
            {
              addition:
                'Before release work, confirm package name, repository metadata, publish files, and privacy boundaries before editing docs or code.',
              why: 'You repeatedly revisit package naming and open-source boundaries late in the workflow.',
              prompt_scaffold: 'Add under the same Release section as a preflight checklist.',
            },
          ],
          features_to_try: [
            {
              feature: 'Sub-agents',
              one_liner: 'Split bounded implementation and docs work in parallel.',
              why_for_you: 'You often have separable cleanup tasks while preparing releases.',
              example_code: 'Use one worker for docs cleanup and one for tests while you handle package metadata.',
            },
            {
              feature: 'Skills',
              one_liner: 'Turn repeated repo-specific workflows into reusable local instructions.',
              why_for_you: 'You keep tightening the same publish and report-validation workflow across sessions.',
              example_code:
                'Create a release-readiness skill that runs checks, regenerates the sample report, and summarizes blockers before publish.',
            },
          ],
          usage_patterns: [
            {
              title: 'Snapshot report validation',
              suggestion: 'Keep a stable sample report fixture and regenerate it during changes.',
              detail: 'This gives you a visual regression target for the report page without needing live Codex session data.',
              copyable_prompt: 'Regenerate the sample report page and check that the HTML output is unchanged.',
            },
            {
              title: 'Front-load release constraints',
              suggestion: 'Start release-prep sessions by locking down naming, publish scope, and output paths first.',
              detail: 'Your sessions go smoother once the open-source boundary is explicit. Doing this at the top prevents late rewrites in package metadata, README wording, and publish commands.',
              copyable_prompt:
                'Before making any release changes, inspect package.json, README, publish files, and repository metadata. Summarize the current release boundary first, then propose only the minimum changes needed.',
            },
          ],
        },
        on_the_horizon: {
          intro: 'The next gains are in repeatability, not raw capability.',
          opportunities: [
            {
              title: 'Release lane automation',
              whats_possible: 'You can turn publish prep into a repeatable lane with stable prompts, checks, and output paths.',
              how_to_try: 'Use codex exec plus a checked-in checklist and generated fixture reports.',
              copyable_prompt: 'Prepare the package for release, run checks, regenerate the sample report page, and summarize anything still blocking publish.',
            },
            {
              title: 'Parallel polish before publish',
              whats_possible:
                'You can split docs polish, package validation, and report UX cleanup into parallel bounded passes instead of serial cleanup.',
              how_to_try:
                'Spawn one worker for docs and package metadata, another for report HTML/UI polish, then reconcile the final publish diff yourself.',
              copyable_prompt:
                'Spawn one worker to validate package metadata and README publish readiness, and another to review report HTML/UI polish for clarity and actionability. Merge both results, run checks, and produce a final release diff summary.',
            },
          ],
        },
        fun_ending: {
          headline: 'The report started testing itself',
          detail: 'Once the sample report fixture existed, the tool became able to visually regression-test its own output.',
        },
      },
      facets: [
        {
          threadId: 'thread-1',
          title: 'Fix parser and publish package',
          cwd: '/repo/codex-session-insights',
          updatedAt: '2026-04-02T10:00:00.000Z',
          durationMinutes: 28,
          userMessages: 4,
          assistantMessages: 3,
          totalToolCalls: 3,
          totalCommandFailures: 1,
          underlying_goal: 'Fix parser behavior and prepare the package for publishing.',
          goal_categories: { bugfix: 1, release_prep: 1 },
          outcome: 'mostly_achieved',
          user_satisfaction_counts: { satisfied: 1 },
          assistant_helpfulness: 'very_helpful',
          session_type: 'iterative_refinement',
          friction_counts: { tool_failed: 1 },
          friction_detail: 'A push failed near the end of the flow.',
          primary_success: 'multi_file_changes',
          brief_summary: 'Patched parser code, tightened package metadata, and prepared publish steps.',
          user_instructions: ['Keep the package boundary clean for open source.'],
        },
      ],
    },
  )

  report.metadata.generatedAt = '2026-04-04T12:00:00.000Z'
  report.analysisMode = 'llm'
  report.provider = 'codex-cli'
  report.analysisUsage = {
    calls: 7,
    inputTokens: 22000,
    cachedInputTokens: 3000,
    outputTokens: 1800,
    totalTokens: 26800,
    byModel: [
      { label: 'gpt-5.3-codex-spark', calls: 4, inputTokens: 12000, cachedInputTokens: 3000, outputTokens: 900, totalTokens: 15900 },
      { label: 'gpt-5.4', calls: 3, inputTokens: 10000, cachedInputTokens: 0, outputTokens: 900, totalTokens: 10900 },
    ],
    byStage: [
      { label: 'facet_extraction', calls: 2, inputTokens: 8000, cachedInputTokens: 3000, outputTokens: 500, totalTokens: 11500 },
      { label: 'section:project_areas', calls: 1, inputTokens: 2000, cachedInputTokens: 0, outputTokens: 200, totalTokens: 2200 },
      { label: 'section:at_a_glance', calls: 1, inputTokens: 1800, cachedInputTokens: 0, outputTokens: 220, totalTokens: 2020 },
    ],
  }

  return report
}
