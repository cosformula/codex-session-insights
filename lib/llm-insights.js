import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { promises as fs } from 'node:fs'
import { buildReport } from './report.js'
import { callStructuredModel, callTextModel } from './model-provider.js'
import { filterSubstantiveThreads } from './codex-data.js'

/**
 * @typedef {Object} InsightRunOptions
 * @property {string=} provider
 * @property {string=} apiKey
 * @property {string=} apiBase
 * @property {string=} codexBin
 * @property {string=} cacheDir
 * @property {string=} facetModel
 * @property {string=} facetEffort
 * @property {string=} fastSectionModel
 * @property {string=} fastSectionEffort
 * @property {string=} insightModel
 * @property {string=} insightEffort
 * @property {number=} facetLimit
 * @property {string=} lang
 * @property {(usage: any) => void=} onUsage
 * @property {(event: any) => void=} onProgress
 * @property {string=} usageStage
 */

const DEFAULT_PROVIDER = 'codex-cli'
const DEFAULT_FACET_MODEL = 'gpt-5.4-mini'
const DEFAULT_FAST_SECTION_MODEL = 'gpt-5.4-mini'
const DEFAULT_INSIGHT_MODEL = 'gpt-5.4'
const DEFAULT_FACET_EFFORT = 'low'
const DEFAULT_FAST_SECTION_EFFORT = 'low'
const DEFAULT_INSIGHT_EFFORT = 'high'
const DEFAULT_FACET_LIMIT = 50
const MAX_FACET_EXTRACTIONS = 50
const LONG_TRANSCRIPT_THRESHOLD = 30000
const TRANSCRIPT_CHUNK_SIZE = 25000
const FACET_TRANSCRIPT_SUMMARY_DIRECTIVE =
  'Summarize this coding-session transcript segment into compact bullets (4-8 max). Keep only user goals, assistant outcomes, tool failures, and terminal failures that materially affect results. Do not include raw tool arguments or command output.'
const MAX_CONTEXT_FACETS = 24
const MAX_FRICTION_DETAILS = 12
const MAX_USER_INSTRUCTIONS = 8
const MAX_RECENT_THREADS = 8
const SECTION_CONCURRENCY = 3
const FACET_SCHEMA_VERSION = 2
const SECTION_SYSTEM_PROMPT =
  'You are generating a Codex session insights report. Use only the provided evidence. Be concrete, diagnostic, and concise. Use second person. Do not flatter. Do not speculate past the data. If evidence is weak or mixed, be conservative and say less.'
const AT_A_GLANCE_SYSTEM_PROMPT =
  'You are writing the At a Glance section for a Codex usage report. Use only the supplied report context and section digest. Be high-signal, specific, and coaching rather than promotional. Use second person. Do not mention exact token or usage numbers. Do not speculate.'

const FACET_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    underlying_goal: { type: 'string' },
    goal_categories: {
      type: 'object',
      additionalProperties: { type: 'number' },
    },
    outcome: { type: 'string' },
    user_satisfaction_counts: {
      type: 'object',
      additionalProperties: { type: 'number' },
    },
    assistant_helpfulness: { type: 'string' },
    session_type: { type: 'string' },
    friction_counts: {
      type: 'object',
      additionalProperties: { type: 'number' },
    },
    friction_detail: { type: 'string' },
    primary_success: { type: 'string' },
    brief_summary: { type: 'string' },
    user_instructions: {
      type: 'array',
      items: { type: 'string' },
    },
  },
  required: [
    'underlying_goal',
    'goal_categories',
    'outcome',
    'user_satisfaction_counts',
    'assistant_helpfulness',
    'session_type',
    'friction_counts',
    'friction_detail',
    'primary_success',
    'brief_summary',
    'user_instructions',
  ],
}

const PROJECT_AREAS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    areas: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string' },
          session_count: { type: 'number' },
          description: { type: 'string' },
        },
        required: ['name', 'session_count', 'description'],
      },
    },
  },
  required: ['areas'],
}

const INTERACTION_STYLE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    narrative: { type: 'string' },
    key_pattern: { type: 'string' },
  },
  required: ['narrative', 'key_pattern'],
}

const WHAT_WORKS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    intro: { type: 'string' },
    impressive_workflows: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string' },
          description: { type: 'string' },
        },
        required: ['title', 'description'],
      },
    },
  },
  required: ['intro', 'impressive_workflows'],
}

const FRICTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    intro: { type: 'string' },
    categories: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          category: { type: 'string' },
          description: { type: 'string' },
          examples: {
            type: 'array',
            items: { type: 'string' },
          },
        },
        required: ['category', 'description', 'examples'],
      },
    },
  },
  required: ['intro', 'categories'],
}

const SUGGESTIONS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    agents_md_additions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          addition: { type: 'string' },
          why: { type: 'string' },
          prompt_scaffold: { type: 'string' },
        },
        required: ['addition', 'why', 'prompt_scaffold'],
      },
    },
    features_to_try: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          feature: { type: 'string' },
          one_liner: { type: 'string' },
          why_for_you: { type: 'string' },
          example_code: { type: 'string' },
        },
        required: ['feature', 'one_liner', 'why_for_you', 'example_code'],
      },
    },
    usage_patterns: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string' },
          suggestion: { type: 'string' },
          detail: { type: 'string' },
          copyable_prompt: { type: 'string' },
        },
        required: ['title', 'suggestion', 'detail', 'copyable_prompt'],
      },
    },
  },
  required: ['agents_md_additions', 'features_to_try', 'usage_patterns'],
}

const HORIZON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    intro: { type: 'string' },
    opportunities: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string' },
          whats_possible: { type: 'string' },
          how_to_try: { type: 'string' },
          copyable_prompt: { type: 'string' },
        },
        required: ['title', 'whats_possible', 'how_to_try', 'copyable_prompt'],
      },
    },
  },
  required: ['intro', 'opportunities'],
}

const FUN_ENDING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    headline: { type: 'string' },
    detail: { type: 'string' },
  },
  required: ['headline', 'detail'],
}

const AT_A_GLANCE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    whats_working: { type: 'string' },
    whats_hindering: { type: 'string' },
    quick_wins: { type: 'string' },
    ambitious_workflows: { type: 'string' },
  },
  required: [
    'whats_working',
    'whats_hindering',
    'quick_wins',
    'ambitious_workflows',
  ],
}

const SECTION_DEFS = [
  {
    name: 'project_areas',
    modelTier: 'fast',
    contextKind: 'project_areas',
    schemaName: 'codex_project_areas',
    schema: PROJECT_AREAS_SCHEMA,
    prompt: `Analyze this Codex usage data and identify the user's main workstreams.

RESPOND WITH ONLY A VALID JSON OBJECT:
{
  "areas": [
    {"name": "Area name", "session_count": 0, "description": "2-3 sentences describing the workstream, its recurring tasks, and why it matters."}
  ]
}

Include 3-4 areas. Skip Codex self-hosting/meta work unless it is a dominant project area.

Guardrails:
- Use concrete project or workstream names, not generic labels like "coding" or "development"
- Base areas on repeated evidence across summaries, not one-off threads
- Prefer project + task framing over tool-centric framing
- Group related tasks into a coherent long-running workstream instead of listing each task separately
- Prefer fewer, broader areas that still feel accurate over a more complete but fragmented list
- Do not turn recent sub-tasks, bugfixes, or cleanup passes into separate areas unless they clearly form their own repeated stream
- Each description should read like a workstream summary, not a changelog
- Mention representative tasks, artifacts, or decisions so the area feels concrete without enumerating every thread
- Keep the focus on what the user was trying to accomplish; mention Codex only lightly when it clarifies the shape of the work`,
  },
  {
    name: 'interaction_style',
    modelTier: 'full',
    contextKind: 'interaction_style',
    schemaName: 'codex_interaction_style',
    schema: INTERACTION_STYLE_SCHEMA,
    prompt: `Analyze this Codex usage data and describe the user's interaction style.

RESPOND WITH ONLY A VALID JSON OBJECT:
{
  "narrative": "2-3 paragraphs analyzing how the user interacts with Codex. Use second person. Focus on planning style, interruption pattern, trust in execution, and how they balance exploration vs edits.",
  "key_pattern": "One sentence summary of the most distinctive interaction pattern"
}

Guardrails:
- Focus on stable interaction patterns, not isolated moments
- Talk about how the user scopes work, redirects goals, sets acceptance bars, or trusts execution
- Prefer evidence from user requests, follow-up corrections, repeated constraints, and outcome patterns over implementation telemetry
- Do not infer user preference from Codex's default tool mix or harness behavior; high exec/tool usage can reflect the agent's operating style rather than the user's instructions
- Treat shell usage, file reads, and verification commands as weak evidence unless the user explicitly asked for that working style
- Do not infer style from repository type, documentation volume, or language mix alone
- Avoid turning a single repo's workflow shape into a personality claim about the user
- If evidence is mixed, describe the tension instead of forcing one clean story`,
  },
  {
    name: 'what_works',
    modelTier: 'fast',
    contextKind: 'what_works',
    schemaName: 'codex_what_works',
    schema: WHAT_WORKS_SCHEMA,
    prompt: `Analyze this Codex usage data and identify what is working well. Use second person.

RESPOND WITH ONLY A VALID JSON OBJECT:
{
  "intro": "1 sentence of context",
  "impressive_workflows": [
    {"title": "Short title", "description": "2-3 sentences describing the workflow or habit that works well."}
  ]
}

Include 3 impressive workflows.

Guardrails:
- Only include workflows supported by repeated evidence or clearly strong outcomes
- Prefer user habits and collaboration patterns over tool name lists
- Avoid generic praise; explain why the workflow works`,
  },
  {
    name: 'friction_analysis',
    modelTier: 'full',
    contextKind: 'friction_analysis',
    schemaName: 'codex_friction_analysis',
    schema: FRICTION_SCHEMA,
    prompt: `Analyze this Codex usage data and identify friction points. Use second person.

RESPOND WITH ONLY A VALID JSON OBJECT:
{
  "intro": "1 sentence summarizing the friction pattern",
  "categories": [
    {"category": "Concrete category name", "description": "1-2 sentences describing the pattern", "examples": ["specific example", "another example"]}
  ]
}

Include 3 friction categories with 2 examples each.

Guardrails:
- Separate model-side friction from user/workflow-side friction when useful
- Examples must be concrete and tied to the supplied evidence
- Treat overlap or concurrency metrics as weak supporting evidence unless the summaries or friction details also show real switching pain
- Do not invent root causes that are not visible in the data`,
  },
  {
    name: 'suggestions',
    modelTier: 'fast',
    contextKind: 'suggestions',
    schemaName: 'codex_suggestions',
    schema: SUGGESTIONS_SCHEMA,
    prompt: `Analyze this Codex usage data and suggest improvements that the user can immediately act on.

## CODEX FEATURES REFERENCE
1. **MCP Servers**
   - Good for databases, GitHub/Linear, internal APIs, external tools
2. **Skills**
   - Reusable local workflows triggered by intent or explicit skill usage
3. **codex exec**
   - Non-interactive Codex runs for scripts, CI, and repeatable workflows
4. **Sub-agents**
   - Split bounded work across focused agents when tasks can run independently
5. **AGENTS.md**
   - Persistent repo instructions so repeated context does not need to be restated

RESPOND WITH ONLY A VALID JSON OBJECT:
{
  "agents_md_additions": [
    {"addition": "A specific AGENTS.md addition", "why": "Why this would help based on repeated sessions", "prompt_scaffold": "Where to place it"}
  ],
  "features_to_try": [
    {"feature": "Feature name", "one_liner": "What it does", "why_for_you": "Why it helps this user", "example_code": "Copyable command, config, or snippet"}
  ],
  "usage_patterns": [
    {"title": "Short title", "suggestion": "1 sentence telling the user what to do", "detail": "2-4 sentences explaining why now and how it helps", "copyable_prompt": "Specific prompt to paste into Codex"}
  ]
}

Prioritize suggestions grounded in repeated patterns, not isolated sessions.

Guardrails:
- Suggest only actions that clearly connect to repeated evidence
- Avoid generic advice like "give more context" unless it is overwhelmingly justified
- Prefer changes with strong leverage: repo memory, repeatable workflows, automation, or parallelism
- Do not recommend first-time adoption of AGENTS.md, Skills, codex exec, Sub-agents, or MCP Servers when the capability_adoption evidence shows the user already uses them in a moderate or strong way
- When a capability is already adopted, suggest a deeper refinement or a tighter operating pattern instead of basic adoption
- Distinguish "you should start using this" from "you should formalize or deepen how you already use this"
- Use AGENTS.md as the canonical repo instruction filename in examples; do not mention CLAUDE.md
- Write AGENTS.md additions as directly pasteable instruction lines, not commentary about instructions
- Make feature examples immediately usable; avoid placeholders like "insert your repo path here" unless unavoidable
- Make usage pattern suggestions sound like concrete next actions the user can try today, not abstract best practices`,
  },
  {
    name: 'on_the_horizon',
    modelTier: 'full',
    contextKind: 'on_the_horizon',
    schemaName: 'codex_on_the_horizon',
    schema: HORIZON_SCHEMA,
    prompt: `Analyze this Codex usage data and identify future opportunities that are ambitious but still actionable.

RESPOND WITH ONLY A VALID JSON OBJECT:
{
  "intro": "1 sentence about how the user's workflows could evolve",
  "opportunities": [
    {"title": "Short title", "whats_possible": "2-3 ambitious sentences", "how_to_try": "1-2 sentences mentioning concrete tooling", "copyable_prompt": "Detailed prompt to try"}
  ]
}

Include 3 opportunities. Think in terms of stronger multi-step execution, persistent repo memory, and parallel work.

Guardrails:
- Stay adjacent to the user's actual workflows; do not jump to fantasies detached from evidence
- Push toward ambitious but plausible next-step workflows
- Mention concrete Codex capabilities when relevant, not vague future AI claims
- The "how_to_try" field should read like a getting-started instruction, not a vague observation
- The "copyable_prompt" should be detailed enough that the user could paste it into Codex with minimal edits`,
  },
  {
    name: 'fun_ending',
    modelTier: 'fast',
    contextKind: 'fun_ending',
    schemaName: 'codex_fun_ending',
    schema: FUN_ENDING_SCHEMA,
    prompt: `Analyze this Codex usage data and find one memorable qualitative moment.

RESPOND WITH ONLY A VALID JSON OBJECT:
{
  "headline": "A memorable moment from the sessions",
  "detail": "Brief context"
}

Pick something human, funny, or surprising, not a statistic.

Guardrails:
- Prefer a memorable pattern or moment visible in the supplied summaries
- Do not fabricate narrative detail that is not present in the data`,
  },
]

/**
 * @param {{ threadSummaries: any[], options?: InsightRunOptions }} param0
 */
export async function generateLlmInsights({ threadSummaries, options = {} }) {
  const provider = options.provider || DEFAULT_PROVIDER
  const usageTracker = createUsageTracker(provider)
  const providerOptions = buildProviderOptions(options, provider, usage => usageTracker.add(usage))
  const facetModel = options.facetModel || DEFAULT_FACET_MODEL
  const fastSectionModel = options.fastSectionModel || DEFAULT_FAST_SECTION_MODEL
  const insightModel = options.insightModel || DEFAULT_INSIGHT_MODEL
  const facetEffort = options.facetEffort || DEFAULT_FACET_EFFORT
  const fastSectionEffort = options.fastSectionEffort || DEFAULT_FAST_SECTION_EFFORT
  const insightEffort = options.insightEffort || DEFAULT_INSIGHT_EFFORT
  const cacheRoot = resolveCacheRoot(options.cacheDir)
  const facetCacheDir = path.join(cacheRoot, 'facets')
  await fs.mkdir(facetCacheDir, { recursive: true })

  const candidateThreads = filterSubstantiveThreads(threadSummaries)
  const facetLimit = Math.min(
    Number(options.facetLimit ?? DEFAULT_FACET_LIMIT),
    MAX_FACET_EXTRACTIONS,
  )

  const facetJobs = await planFacetJobs(candidateThreads, {
    cacheDir: facetCacheDir,
    model: facetModel,
    uncachedLimit: facetLimit,
  })
  emitProgress(options, {
    kind: 'facets:planned',
    total: facetJobs.length,
    uncached: facetJobs.filter(job => !job.cachedFacet).length,
    cached: facetJobs.filter(job => Boolean(job.cachedFacet)).length,
  })

  let completedFacetJobs = 0
  const rawFacets = await mapLimit(facetJobs, 4, async job => {
    const facet =
      job.cachedFacet ||
      (await getFacetForThread(job.thread, {
        cacheDir: facetCacheDir,
        model: facetModel,
        provider,
        providerOptions,
      }))
    completedFacetJobs += 1
    emitProgress(options, {
      kind: 'facets:progress',
      completed: completedFacetJobs,
      total: facetJobs.length,
      cached: Boolean(job.cachedFacet),
    })
    return facet
  })

  const minimalThreadIds = new Set(
    rawFacets.filter(isWarmupMinimalFacet).map(facet => facet.threadId),
  )
  const reportThreads = candidateThreads.filter(thread => !minimalThreadIds.has(thread.id))
  const facets = rawFacets.filter(facet => !minimalThreadIds.has(facet.threadId))
  const report = buildReport(reportThreads, { threadPreviewLimit: 50 })
  const context = buildInsightContext(report, reportThreads, facets)

  emitProgress(options, {
    kind: 'sections:planned',
    total: SECTION_DEFS.length + 1,
  })

  let completedSections = 0
  const sectionResults = await mapLimit(SECTION_DEFS, SECTION_CONCURRENCY, async section => {
    const sectionContext = buildSectionContext(context, section.contextKind)
    const result = await callStructuredModel({
      provider,
      model: resolveSectionModel(section, { fastSectionModel, insightModel }),
      schemaName: section.schemaName,
      schema: section.schema,
      systemPrompt: `${SECTION_SYSTEM_PROMPT} ${getNarrativeLanguageInstruction(options.lang)}`.trim(),
      userPrompt: `${section.prompt}\n\n${getNarrativeLanguageInstruction(options.lang)}\n\nDATA:\n${compactJson(sectionContext)}`,
      options: {
        ...providerOptions,
        fallbackModels: resolveModelFallbacks(
          resolveSectionModel(section, { fastSectionModel, insightModel }),
        ),
        usageStage: `section:${section.name}`,
        reasoningEffort: resolveSectionEffort(section, { fastSectionEffort, insightEffort }),
      },
    })
    completedSections += 1
    emitProgress(options, {
      kind: 'sections:progress',
      completed: completedSections,
      total: SECTION_DEFS.length + 1,
      section: section.name,
    })
    return { name: section.name, result }
  })

  const insights = {}
  for (const section of sectionResults) {
    insights[section.name] = section.result
  }

  const atAGlance = await callStructuredModel({
    provider,
    model: insightModel,
    schemaName: 'codex_at_a_glance',
    schema: AT_A_GLANCE_SCHEMA,
    systemPrompt: `${AT_A_GLANCE_SYSTEM_PROMPT} ${getNarrativeLanguageInstruction(options.lang)}`.trim(),
    userPrompt: buildAtAGlancePrompt(buildSectionContext(context, 'at_a_glance'), insights),
    options: {
      ...providerOptions,
      fallbackModels: resolveModelFallbacks(insightModel),
      usageStage: 'section:at_a_glance',
      reasoningEffort: insightEffort,
    },
  })
  completedSections += 1
  emitProgress(options, {
    kind: 'sections:progress',
    completed: completedSections,
    total: SECTION_DEFS.length + 1,
    section: 'at_a_glance',
  })
  insights.at_a_glance = atAGlance

  return { insights, facets, reportThreads, analysisUsage: usageTracker.snapshot() }
}

/**
 * @param {{ threadSummaries: any[], options?: InsightRunOptions }} param0
 */
export async function estimateLlmAnalysisCost({ threadSummaries, options = {} }) {
  const facetModel = options.facetModel || DEFAULT_FACET_MODEL
  const fastSectionModel = options.fastSectionModel || DEFAULT_FAST_SECTION_MODEL
  const insightModel = options.insightModel || DEFAULT_INSIGHT_MODEL
  const provider = options.provider || DEFAULT_PROVIDER
  const cacheRoot = resolveCacheRoot(options.cacheDir)
  const facetCacheDir = path.join(cacheRoot, 'facets')
  await fs.mkdir(facetCacheDir, { recursive: true })

  const candidateThreads = filterSubstantiveThreads(threadSummaries)
  const facetLimit = Math.min(
    Number(options.facetLimit ?? DEFAULT_FACET_LIMIT),
    MAX_FACET_EXTRACTIONS,
  )
  const facetJobs = await planFacetJobs(candidateThreads, {
    cacheDir: facetCacheDir,
    model: facetModel,
    uncachedLimit: facetLimit,
  })

  const uncachedFacetJobs = facetJobs.filter(job => !job.cachedFacet)
  const cachedFacetJobs = facetJobs.length - uncachedFacetJobs.length
  let chunkSummaryCalls = 0
  let combineSummaryCalls = 0
  let estimatedFacetInputTokens = 0
  let estimatedFacetOutputTokens = 0
  let estimatedChunkSummaryInputTokens = 0
  let estimatedChunkSummaryOutputTokens = 0
  let estimatedCombineSummaryInputTokens = 0
  let estimatedCombineSummaryOutputTokens = 0
  const facetSystemPrompt = buildFacetSystemPrompt(options.lang)

  for (const job of uncachedFacetJobs) {
    const transcript = String(job.thread.transcriptForAnalysis || '').trim()
    const transcriptChars = transcript.length
    if (!transcriptChars) {
      estimatedFacetInputTokens += estimateModelInputTokens({
        provider,
        systemPrompt: facetSystemPrompt,
        userPrompt: buildFacetExtractionPrompt(job.thread, `${job.thread.title || '(untitled)'}\n${job.thread.firstUserMessage || ''}`.trim(), options.lang),
        schema: FACET_SCHEMA,
        structured: true,
      })
      estimatedFacetOutputTokens += 350
      continue
    }

    if (transcriptChars <= LONG_TRANSCRIPT_THRESHOLD) {
      estimatedFacetInputTokens += estimateModelInputTokens({
        provider,
        systemPrompt: facetSystemPrompt,
        userPrompt: buildFacetExtractionPrompt(job.thread, transcript, options.lang),
        schema: FACET_SCHEMA,
        structured: true,
      })
      estimatedFacetOutputTokens += 350
      continue
    }

    const chunks = chunkText(transcript, TRANSCRIPT_CHUNK_SIZE)
    chunkSummaryCalls += chunks.length
    for (const chunk of chunks) {
      estimatedChunkSummaryInputTokens += estimateModelInputTokens({
        provider,
        systemPrompt: `${FACET_TRANSCRIPT_SUMMARY_DIRECTIVE}\n\nPreserve user goal, outcome, friction, command/tool issues, and what the assistant actually achieved.`,
        userPrompt: `Chunk 1 of ${chunks.length}\n\n${chunk}`,
        structured: false,
      })
      estimatedChunkSummaryOutputTokens += 260
    }
    const combinedSummaryChars = chunks.length * 1100
    if (combinedSummaryChars > LONG_TRANSCRIPT_THRESHOLD) {
      combineSummaryCalls += 1
      estimatedCombineSummaryInputTokens += estimateModelInputTokens({
        provider,
        systemPrompt:
          'Combine these coding-session chunk summaries into one compact transcript summary. Keep only material signal for later facet extraction. Do not carry boilerplate, stack traces, or command details.',
        userPrompt: makePlaceholderText(combinedSummaryChars, 'Chunk summaries'),
        structured: false,
      })
      estimatedCombineSummaryOutputTokens += 320
    }
    estimatedFacetInputTokens += estimateModelInputTokens({
      provider,
      systemPrompt: facetSystemPrompt,
      userPrompt: buildFacetExtractionPrompt(
        job.thread,
        makePlaceholderText(
          combinedSummaryChars > LONG_TRANSCRIPT_THRESHOLD ? 1200 : combinedSummaryChars,
          '[Long transcript summarized before facet extraction]',
        ),
        options.lang,
      ),
      schema: FACET_SCHEMA,
      structured: true,
    })
    estimatedFacetOutputTokens += 350
  }

  const estimatedSectionInputs = estimateSectionInputs(candidateThreads, facetJobs, options)
  const fastSectionCalls = SECTION_DEFS.filter(section => section.modelTier === 'fast').length
  const fullSectionCalls = SECTION_DEFS.filter(section => section.modelTier !== 'fast').length
  let estimatedFastSectionInputTokens = SECTION_DEFS.filter(section => section.modelTier === 'fast')
    .reduce((sum, section) => sum + estimatedSectionInputs[section.contextKind] + 500, 0)
  const estimatedFastSectionOutputTokens = fastSectionCalls * 500
  let estimatedFullSectionInputTokens = SECTION_DEFS.filter(section => section.modelTier !== 'fast')
    .reduce((sum, section) => sum + estimatedSectionInputs[section.contextKind] + 650, 0)
  const estimatedFullSectionOutputTokens = fullSectionCalls * 700
  let estimatedAtAGlanceInputTokens = estimatedSectionInputs.at_a_glance + 2200
  const estimatedAtAGlanceOutputTokens = 260
  const estimatedSummaryInputTokens =
    estimatedChunkSummaryInputTokens + estimatedCombineSummaryInputTokens
  const estimatedSummaryOutputTokens =
    estimatedChunkSummaryOutputTokens + estimatedCombineSummaryOutputTokens

  estimatedFacetInputTokens += estimateCodexCliFreshOverhead(provider, facetModel, uncachedFacetJobs.length)
  estimatedChunkSummaryInputTokens += estimateCodexCliFreshOverhead(provider, facetModel, chunkSummaryCalls)
  estimatedCombineSummaryInputTokens += estimateCodexCliFreshOverhead(provider, facetModel, combineSummaryCalls)
  estimatedFastSectionInputTokens += estimateCodexCliFreshOverhead(provider, fastSectionModel, fastSectionCalls)
  estimatedFullSectionInputTokens += estimateCodexCliFreshOverhead(provider, insightModel, fullSectionCalls)
  estimatedAtAGlanceInputTokens += estimateCodexCliFreshOverhead(provider, insightModel, 1)

  const byStage = [
    buildEstimateBucket(
      'facet_extraction',
      uncachedFacetJobs.length,
      estimatedFacetInputTokens,
      0,
      estimatedFacetOutputTokens,
    ),
    buildEstimateBucket(
      'transcript_summary:chunk',
      chunkSummaryCalls,
      estimatedChunkSummaryInputTokens,
      0,
      estimatedChunkSummaryOutputTokens,
    ),
    buildEstimateBucket(
      'transcript_summary:combine',
      combineSummaryCalls,
      estimatedCombineSummaryInputTokens,
      0,
      estimatedCombineSummaryOutputTokens,
    ),
    buildEstimateBucket(
      'section:fast',
      fastSectionCalls,
      estimatedFastSectionInputTokens,
      0,
      estimatedFastSectionOutputTokens,
    ),
    buildEstimateBucket(
      'section:full',
      fullSectionCalls,
      estimatedFullSectionInputTokens,
      0,
      estimatedFullSectionOutputTokens,
    ),
    buildEstimateBucket(
      'section:at_a_glance',
      1,
      estimatedAtAGlanceInputTokens,
      0,
      estimatedAtAGlanceOutputTokens,
    ),
  ].filter(bucket => bucket.calls > 0)

  const byModel = aggregateEstimateByModel([
    {
      label: facetModel,
      calls: uncachedFacetJobs.length + chunkSummaryCalls + combineSummaryCalls,
      inputTokens: estimatedFacetInputTokens + estimatedSummaryInputTokens,
      cachedInputTokens: 0,
      outputTokens: estimatedFacetOutputTokens + estimatedSummaryOutputTokens,
      totalTokens:
        estimatedFacetInputTokens +
        estimatedSummaryInputTokens +
        estimatedFacetOutputTokens +
        estimatedSummaryOutputTokens,
    },
    {
      label: fastSectionModel,
      calls: fastSectionCalls,
      inputTokens: estimatedFastSectionInputTokens,
      cachedInputTokens: 0,
      outputTokens: estimatedFastSectionOutputTokens,
      totalTokens: estimatedFastSectionInputTokens + estimatedFastSectionOutputTokens,
    },
    {
      label: insightModel,
      calls: fullSectionCalls + 1,
      inputTokens: estimatedFullSectionInputTokens + estimatedAtAGlanceInputTokens,
      cachedInputTokens: 0,
      outputTokens: estimatedFullSectionOutputTokens + estimatedAtAGlanceOutputTokens,
      totalTokens:
        estimatedFullSectionInputTokens +
        estimatedAtAGlanceInputTokens +
        estimatedFullSectionOutputTokens +
        estimatedAtAGlanceOutputTokens,
    },
  ])

  const totalInputTokens =
    estimatedFacetInputTokens +
    estimatedSummaryInputTokens +
    estimatedFastSectionInputTokens +
    estimatedFullSectionInputTokens +
    estimatedAtAGlanceInputTokens
  const totalOutputTokens =
    estimatedFacetOutputTokens +
    estimatedSummaryOutputTokens +
    estimatedFastSectionOutputTokens +
    estimatedFullSectionOutputTokens +
    estimatedAtAGlanceOutputTokens
  const totalTokens = totalInputTokens + totalOutputTokens

  return {
    provider: options.provider || DEFAULT_PROVIDER,
    candidateThreads: candidateThreads.length,
    plannedFacetThreads: facetJobs.length,
    uncachedFacetThreads: uncachedFacetJobs.length,
    cachedFacetThreads: cachedFacetJobs,
    longTranscriptThreads: uncachedFacetJobs.filter(job => String(job.thread.transcriptForAnalysis || '').trim().length > LONG_TRANSCRIPT_THRESHOLD).length,
    estimatedCalls:
      uncachedFacetJobs.length +
      chunkSummaryCalls +
      combineSummaryCalls +
      fastSectionCalls +
      fullSectionCalls +
      1,
    estimatedInputTokens: Math.round(totalInputTokens),
    estimatedOutputTokens: Math.round(totalOutputTokens),
    estimatedTotalTokens: Math.round(totalTokens),
    estimatedRange: {
      low: Math.round(totalTokens * 0.8),
      high: Math.round(totalTokens * 1.35),
    },
    byStage,
    byModel,
  }
}

function estimateCodexCliFreshOverhead(provider, model, calls) {
  if (provider !== 'codex-cli' || !calls) return 0
  const normalized = String(model || '').trim()
  if (normalized === 'gpt-5.4') return calls * 25_000
  if (normalized === 'gpt-5.4-mini' || normalized === 'gpt-5.3-codex-spark') return calls * 4_500
  return calls * 8_000
}

async function planFacetJobs(threadSummaries, { cacheDir, model, uncachedLimit }) {
  const jobs = []
  let uncachedCount = 0

  for (const thread of threadSummaries) {
    const cachedFacet = await readCachedFacet(thread, { cacheDir, model })
    if (cachedFacet) {
      jobs.push({ thread, cachedFacet })
      continue
    }
    if (uncachedCount >= uncachedLimit) continue
    uncachedCount += 1
    jobs.push({ thread, cachedFacet: null })
  }

  return jobs
}

async function readCachedFacet(thread, { cacheDir, model }) {
  const cachePath = path.join(cacheDir, `${thread.id}.json`)
  const cached = await readJson(cachePath)
  if (!cached?.facet || cached.versionKey !== buildFacetVersionKey(thread, model)) {
    return null
  }
  return cached.facet
}

async function getFacetForThread(thread, { cacheDir, model, provider, providerOptions }) {
  const cachePath = path.join(cacheDir, `${thread.id}.json`)
  const versionKey = buildFacetVersionKey(thread, model)
  const cached = await readJson(cachePath)
  if (cached?.versionKey === versionKey && cached?.facet) {
    return cached.facet
  }

  const transcript = await prepareTranscriptForFacetExtraction(thread, {
    model,
    provider,
    providerOptions,
  })
  const prompt = buildFacetExtractionPrompt(thread, transcript, langFromProviderOptions(providerOptions))

  const rawFacet = await callStructuredModel({
    provider,
    model,
    schemaName: 'codex_session_facet',
    schema: FACET_SCHEMA,
    systemPrompt: buildFacetSystemPrompt(langFromProviderOptions(providerOptions)),
    userPrompt: prompt,
      options: {
        ...providerOptions,
        fallbackModels: resolveModelFallbacks(model),
        usageStage: 'facet_extraction',
        reasoningEffort: provider === 'codex-cli' ? providerOptions.facetEffort : undefined,
      },
    })

  const facet = {
    threadId: thread.id,
    title: thread.title,
    cwd: thread.cwd,
    updatedAt: thread.updatedAt,
    durationMinutes: thread.durationMinutes,
    userMessages: thread.userMessages,
    assistantMessages: thread.assistantMessages,
    totalToolCalls: thread.totalToolCalls,
    totalCommandFailures: thread.totalCommandFailures,
    ...rawFacet,
  }

  await fs.writeFile(cachePath, JSON.stringify({ versionKey, facet }, null, 2), 'utf8')
  return facet
}

async function prepareTranscriptForFacetExtraction(thread, { model, provider, providerOptions }) {
  const transcript = String(thread.transcriptForAnalysis || '').trim()
  if (!transcript) {
    return `${thread.title || '(untitled)'}\n${thread.firstUserMessage || ''}`.trim()
  }
  if (transcript.length <= LONG_TRANSCRIPT_THRESHOLD) {
    return transcript
  }

  const chunks = chunkText(transcript, TRANSCRIPT_CHUNK_SIZE)
  const chunkSummaries = await mapLimit(chunks, 3, async (chunk, index) =>
    callTextModel({
      provider,
      model,
      systemPrompt:
      `${FACET_TRANSCRIPT_SUMMARY_DIRECTIVE}\n\nPreserve user goal, outcome, friction, command/tool issues, and what the assistant actually achieved.`,
      userPrompt: `Chunk ${index + 1} of ${chunks.length}\n\n${chunk}`,
      options: {
        ...providerOptions,
        fallbackModels: resolveModelFallbacks(model),
        usageStage: 'transcript_summary:chunk',
        reasoningEffort: provider === 'codex-cli' ? providerOptions.facetEffort : undefined,
      },
    }),
  )

  const combined = chunkSummaries
    .map((summary, index) => `Chunk ${index + 1} summary:\n${summary.trim()}`)
    .join('\n\n')

  if (combined.length <= LONG_TRANSCRIPT_THRESHOLD) {
    return `[Long transcript summarized before facet extraction]\n${combined}`
  }

  const finalSummary = await callTextModel({
    provider,
    model,
    systemPrompt:
      'Combine these coding-session chunk summaries into one compact transcript summary. Keep only material signal for later facet extraction. Do not carry boilerplate, stack traces, or command details.',
    userPrompt: combined,
    options: {
      ...providerOptions,
      fallbackModels: resolveModelFallbacks(model),
      usageStage: 'transcript_summary:combine',
      reasoningEffort: provider === 'codex-cli' ? providerOptions.facetEffort : undefined,
    },
  })

  return `[Long transcript summarized before facet extraction]\n${finalSummary.trim()}`
}

function buildInsightContext(report, threadSummaries, facets) {
  const goalCategories = {}
  const outcomes = {}
  const satisfaction = {}
  const sessionTypes = {}
  const friction = {}
  const success = {}

  for (const facet of facets) {
    addCounts(goalCategories, facet.goal_categories)
    addCounts(satisfaction, facet.user_satisfaction_counts)
    addCounts(friction, facet.friction_counts)
    if (facet.session_type) {
      sessionTypes[facet.session_type] = (sessionTypes[facet.session_type] || 0) + 1
    }
    if (facet.outcome) outcomes[facet.outcome] = (outcomes[facet.outcome] || 0) + 1
    if (facet.primary_success && facet.primary_success !== 'none') {
      success[facet.primary_success] = (success[facet.primary_success] || 0) + 1
    }
  }

  const sortedFacets = [...facets].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
  const frictionDetails = sortedFacets
    .filter(facet => facet.friction_detail && facet.friction_detail !== 'none')
    .slice(0, MAX_FRICTION_DETAILS)
    .map(facet => ({
      threadId: facet.threadId,
      title: facet.title,
      cwd: facet.cwd,
      friction_counts: facet.friction_counts,
      friction_detail: facet.friction_detail,
      outcome: facet.outcome,
    }))

  const userInstructions = Array.from(
    new Set(
      sortedFacets
        .flatMap(facet => facet.user_instructions || [])
        .map(sanitizeContextText)
        .filter(Boolean),
    ),
  ).slice(0, MAX_USER_INSTRUCTIONS)

  const capabilityAdoption = summarizeCapabilityAdoption(report, threadSummaries, facets)

  return {
    metadata: {
      generated_at: report.metadata.generatedAt,
      thread_count: report.metadata.threadCount,
      date_range: report.metadata.dateRange,
    },
    summary: {
      total_user_messages: report.summary.totalUserMessages,
      total_tool_calls: report.summary.totalToolCalls,
      total_failures: report.summary.totalFailures,
      total_duration_hours: report.summary.totalDurationHours,
      total_tokens: report.summary.totalTokens,
      average_response_time_seconds: report.summary.averageResponseTimeSeconds,
      total_git_commits: report.summary.totalGitCommits,
      total_tool_errors: report.summary.totalToolErrors,
      total_files_modified: report.summary.totalFilesModified,
      total_lines_added: report.summary.totalLinesAdded,
      total_lines_removed: report.summary.totalLinesRemoved,
      overlap: report.summary.overlap,
    },
    charts: {
      projects: report.charts.projects.slice(0, 6),
      models: report.charts.models.slice(0, 4),
      tools: report.charts.tools.slice(0, 8),
      tool_failures: report.charts.toolFailures.slice(0, 6),
      active_hours: compressActiveHours(report.charts.activeHours),
    },
    aggregate_facets: {
      sessions_with_facets: facets.length,
      goal_categories: goalCategories,
      outcomes,
      satisfaction,
      session_types: sessionTypes,
      friction,
      success,
    },
    capability_adoption: capabilityAdoption,
    session_summaries: sortedFacets.slice(0, MAX_CONTEXT_FACETS).map(facet => ({
      thread_id: facet.threadId,
      title: truncateForContext(facet.title, 80),
      project: compactProjectPath(facet.cwd),
      goal: truncateForContext(facet.underlying_goal, 120),
      outcome: facet.outcome,
      session_type: facet.session_type,
      primary_success: facet.primary_success,
      summary: truncateForContext(facet.brief_summary, 160),
      friction: compactCountObject(facet.friction_counts, 2),
      failures: facet.totalCommandFailures,
    })),
    friction_details: frictionDetails,
    user_instructions: userInstructions,
    recent_threads: threadSummaries.slice(0, MAX_RECENT_THREADS).map(thread => ({
      id: thread.id,
      title: truncateForContext(thread.title, 80),
      project: compactProjectPath(thread.cwd),
      duration_minutes: thread.durationMinutes,
      user_messages: thread.userMessages,
      tool_calls: thread.totalToolCalls,
      files_modified: thread.filesModified,
    })),
  }
}

function summarizeCapabilityAdoption(report, threadSummaries, facets) {
  const textByThread = new Map()
  for (const thread of threadSummaries) {
    textByThread.set(
      thread.id,
      [thread.title, thread.firstUserMessage]
        .map(value => String(value || ''))
        .join('\n')
        .toLowerCase(),
    )
  }

  for (const facet of facets) {
    const existing = textByThread.get(facet.threadId) || ''
    const facetText = [
      facet.underlying_goal,
      facet.brief_summary,
      ...(facet.user_instructions || []),
    ]
      .map(value => String(value || ''))
      .join('\n')
      .toLowerCase()
    textByThread.set(facet.threadId, `${existing}\n${facetText}`.trim())
  }

  const detectMentionedThreads = regex => {
    let count = 0
    for (const text of textByThread.values()) {
      if (regex.test(text)) count += 1
    }
    return count
  }

  const totalThreads = Math.max(1, Number(report.metadata.threadCount || threadSummaries.length || 0))
  const signals = {
    agents_md: detectMentionedThreads(/\bagents\.md\b/i),
    skills: detectMentionedThreads(/\bskills?\b/i),
    codex_exec: detectMentionedThreads(/\bcodex exec\b/i),
    subagents: Number(report.summary.sessionsUsingTaskAgent || 0),
    mcp_servers: Number(report.summary.sessionsUsingMcp || 0),
    web_search: Number(report.summary.sessionsUsingWebSearch || 0),
    web_fetch: Number(report.summary.sessionsUsingWebFetch || 0),
  }

  return Object.fromEntries(
    Object.entries(signals).map(([key, count]) => [
      key,
      {
        count,
        status: classifyCapabilityAdoption(count, totalThreads),
      },
    ]),
  )
}

function classifyCapabilityAdoption(count, totalThreads) {
  const share = Number(count || 0) / Math.max(1, Number(totalThreads || 0))
  if (count >= 10 || share >= 0.25) return 'strong'
  if (count >= 4 || share >= 0.1) return 'moderate'
  if (count > 0) return 'light'
  return 'none'
}

function buildAtAGlancePrompt(context, insights) {
  return `You are writing an "At a Glance" summary for a Codex usage insights report.

Use this 4-part structure:
1. What's working
2. What's hindering you
3. Quick wins to try
4. Ambitious workflows

Keep each field to 2-3 compact sentences. Be specific, not flattering.

Additional constraints:
- "What's working" should emphasize distinctive strengths, not generic success
- "What's hindering you" should include both model-side and workflow-side friction when supported
- "Quick wins" should be immediately actionable and high leverage
- "Ambitious workflows" should be plausible next-step workflows, not science fiction
- Do not repeat the same idea across multiple fields

REPORT CONTEXT:
${compactJson(context)}

SECTION DIGEST:
${compactJson(compactInsightDigest(insights))}

RESPOND WITH ONLY A VALID JSON OBJECT matching the schema.`
}

function buildFacetSystemPrompt(lang) {
  return `You extract structured coding-session facets from compressed transcripts. Use only transcript evidence. Be conservative when evidence is weak. Do not infer intent from tool activity alone. ${getStructuredLanguageInstruction(lang)}`.trim()
}

function buildFacetExtractionPrompt(thread, transcript, lang) {
  return `Analyze this Codex coding session and extract structured facets.

CRITICAL GUIDELINES:
1. goal_categories should count only what the user explicitly asked for.
2. user_satisfaction_counts should rely on explicit user signals or strong transcript evidence.
3. friction_counts should be specific: misunderstood_request, wrong_approach, buggy_code, user_rejected_action, excessive_changes, tool_failed, slow_or_verbose, user_unclear, external_issue.
4. If the session is mostly warmup, rehearsal, or cache-filling, use warmup_minimal as the only goal category.
5. If evidence is insufficient after transcript compression, use conservative values such as unclear_from_transcript rather than guessing.
6. Do not infer the user's goal from assistant or tool activity alone.
7. Do not count assistant-led exploration or extra implementation work unless the user clearly asked for it.

Allowed values:
- outcome: fully_achieved | mostly_achieved | partially_achieved | not_achieved | unclear_from_transcript
- assistant_helpfulness: unhelpful | slightly_helpful | moderately_helpful | very_helpful | essential
- session_type: single_task | multi_task | iterative_refinement | exploration | quick_question
- primary_success: none | fast_accurate_search | correct_code_edits | good_explanations | proactive_help | multi_file_changes | good_debugging

Language:
- Keep enum values and keys exactly as requested.
- Write free-text fields in ${describeLanguage(lang)}.

Transcript:
${transcript}

Summary stats:
${JSON.stringify(
    {
      title: thread.title,
      cwd: thread.cwd,
      durationMinutes: thread.durationMinutes,
      userMessages: thread.userMessages,
      assistantMessages: thread.assistantMessages,
      totalToolCalls: thread.totalToolCalls,
      totalCommandFailures: thread.totalCommandFailures,
      toolCounts: thread.toolCounts,
      toolFailures: thread.toolFailures,
      userInterruptions: thread.userInterruptions,
      usesTaskAgent: thread.usesTaskAgent,
      usesMcp: thread.usesMcp,
      usesWebSearch: thread.usesWebSearch,
      usesWebFetch: thread.usesWebFetch,
    },
    null,
    2,
  )}

RESPOND WITH ONLY A VALID JSON OBJECT matching the requested schema.`
}

function buildEstimatedFacet(thread) {
  return {
    threadId: thread.id,
    title: thread.title,
    cwd: thread.cwd,
    updatedAt: thread.updatedAt,
    durationMinutes: thread.durationMinutes,
    userMessages: thread.userMessages,
    assistantMessages: thread.assistantMessages,
    totalToolCalls: thread.totalToolCalls,
    totalCommandFailures: thread.totalCommandFailures,
    underlying_goal: truncateForContext(thread.firstUserMessage || thread.title, 160),
    goal_categories: {},
    outcome: thread.totalCommandFailures > 0 ? 'partially_achieved' : 'unclear_from_transcript',
    user_satisfaction_counts: {},
    assistant_helpfulness: 'moderately_helpful',
    session_type: thread.userMessages > 2 ? 'iterative_refinement' : 'single_task',
    friction_counts: thread.totalCommandFailures > 0 ? { tool_failed: 1 } : {},
    friction_detail: 'none',
    primary_success: 'none',
    brief_summary: truncateForContext(thread.firstUserMessage || thread.title, 180),
    user_instructions: [],
  }
}

function buildEstimatedInsightsPlaceholder(context) {
  return {
    project_areas: {
      areas: (context.session_summaries || []).slice(0, 3).map((item, index) => ({
        name: item.project || item.title || `Workstream ${index + 1}`,
        session_count: 1,
        description: truncateForContext(item.summary || item.goal || '', 120),
      })),
    },
    interaction_style: {
      key_pattern: 'Tight scope before execution',
      narrative: truncateForContext('You first align scope and constraints, then execute and verify against explicit acceptance bars.', 180),
    },
    what_works: {
      impressive_workflows: [
        { title: 'Scope first', description: 'You repeatedly tighten scope before execution.' },
        { title: 'Verification loop', description: 'You use evidence to confirm changes before closing.' },
      ],
    },
    friction_analysis: {
      categories: [
        { category: 'Direction drift', description: 'Some sessions need scope tightening.', examples: ['Scope had to be pulled back.'] },
      ],
    },
    suggestions: {
      features_to_try: [{ feature: 'AGENTS.md' }],
      usage_patterns: [{ title: 'Split review and execution' }],
      agents_md_additions: [{ addition: 'Read existing docs before editing.' }],
    },
    on_the_horizon: {
      opportunities: [{ title: 'Longer workflows', how_to_try: 'Add staged execution.' }],
    },
    fun_ending: {
      headline: 'Memorable moment',
      detail: 'A compact placeholder for estimate sizing.',
    },
  }
}

/**
 * @param {InsightRunOptions} options
 * @param {string} provider
 * @param {(usage: any) => void} onUsage
 */
function buildProviderOptions(options, provider, onUsage) {
  return {
    provider,
    lang: options.lang,
    apiKey: options.apiKey,
    apiBase: options.apiBase,
    codexBin: options.codexBin,
    cwd: process.cwd(),
    onUsage,
    facetEffort: options.facetEffort || DEFAULT_FACET_EFFORT,
  }
}

function estimateSectionInputs(candidateThreads, facetJobs, options = {}) {
  const provider = options.provider || DEFAULT_PROVIDER
  const lang = options.lang || 'en'
  const estimatedFacets = facetJobs.map(job => job.cachedFacet || buildEstimatedFacet(job.thread))
  const report = buildReport(candidateThreads, { facets: estimatedFacets })
  const context = buildInsightContext(report, candidateThreads, estimatedFacets)
  const estimated = {}

  for (const section of SECTION_DEFS) {
    const systemPrompt = `${SECTION_SYSTEM_PROMPT} ${getNarrativeLanguageInstruction(lang)}`.trim()
    const sectionContext = buildSectionContext(context, section.contextKind)
    const userPrompt = `${section.prompt}\n\n${getNarrativeLanguageInstruction(lang)}\n\nDATA:\n${compactJson(sectionContext)}`
    estimated[section.contextKind] = estimateModelInputTokens({
      provider,
      systemPrompt,
      userPrompt,
      schema: section.schema,
      structured: true,
    })
  }

  const placeholderInsights = buildEstimatedInsightsPlaceholder(context)
  estimated.at_a_glance = estimateModelInputTokens({
    provider,
    systemPrompt: `${AT_A_GLANCE_SYSTEM_PROMPT} ${getNarrativeLanguageInstruction(lang)}`.trim(),
    userPrompt: buildAtAGlancePrompt(buildSectionContext(context, 'at_a_glance'), placeholderInsights),
    schema: AT_A_GLANCE_SCHEMA,
    structured: true,
  })

  return estimated
}

function resolveSectionModel(section, { fastSectionModel, insightModel }) {
  return section.modelTier === 'fast' ? fastSectionModel : insightModel
}

function resolveSectionEffort(section, { fastSectionEffort, insightEffort }) {
  return section.modelTier === 'fast' ? fastSectionEffort : insightEffort
}

function resolveModelFallbacks(model) {
  if (model === 'gpt-5.3-codex-spark') {
    return ['gpt-5.4-mini', 'gpt-5.4']
  }
  if (model === 'gpt-5.4') {
    return ['gpt-5.4-mini']
  }
  return []
}

function buildEstimateBucket(label, calls, inputTokens, cachedInputTokens, outputTokens) {
  return {
    label,
    calls,
    inputTokens: Math.round(inputTokens),
    cachedInputTokens: Math.round(cachedInputTokens),
    outputTokens: Math.round(outputTokens),
    totalTokens: Math.round(inputTokens + cachedInputTokens + outputTokens),
  }
}

function aggregateEstimateByModel(items) {
  const buckets = {}
  for (const item of items) {
    if (!item.calls) continue
    if (!buckets[item.label]) buckets[item.label] = emptyUsageBucket()
    buckets[item.label].calls += item.calls
    buckets[item.label].inputTokens += Math.round(item.inputTokens)
    buckets[item.label].cachedInputTokens += Math.round(item.cachedInputTokens)
    buckets[item.label].outputTokens += Math.round(item.outputTokens)
    buckets[item.label].totalTokens += Math.round(item.totalTokens)
  }
  return sortBuckets(buckets)
}

function createUsageTracker(provider) {
  const totals = {
    provider,
    calls: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    byModel: {},
    byStage: {},
  }

  return {
    add(usage) {
      totals.calls += 1
      totals.inputTokens += Number(usage.inputTokens ?? 0)
      totals.cachedInputTokens += Number(usage.cachedInputTokens ?? 0)
      totals.outputTokens += Number(usage.outputTokens ?? 0)
      totals.totalTokens += Number(usage.totalTokens ?? 0)

      const modelKey = usage.model || '(unknown model)'
      if (!totals.byModel[modelKey]) totals.byModel[modelKey] = emptyUsageBucket()
      addToBucket(totals.byModel[modelKey], usage)

      const stageKey = usage.stage || 'unspecified'
      if (!totals.byStage[stageKey]) totals.byStage[stageKey] = emptyUsageBucket()
      addToBucket(totals.byStage[stageKey], usage)
    },
    snapshot() {
      return {
        provider: totals.provider,
        calls: totals.calls,
        inputTokens: totals.inputTokens,
        cachedInputTokens: totals.cachedInputTokens,
        outputTokens: totals.outputTokens,
        totalTokens: totals.totalTokens,
        byModel: sortBuckets(totals.byModel),
        byStage: sortBuckets(totals.byStage),
      }
    },
  }
}

function emptyUsageBucket() {
  return {
    calls: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  }
}

function addToBucket(bucket, usage) {
  bucket.calls += 1
  bucket.inputTokens += Number(usage.inputTokens ?? 0)
  bucket.cachedInputTokens += Number(usage.cachedInputTokens ?? 0)
  bucket.outputTokens += Number(usage.outputTokens ?? 0)
  bucket.totalTokens += Number(usage.totalTokens ?? 0)
}

function sortBuckets(buckets) {
  return Object.entries(buckets)
    .map(([label, value]) => ({ label, ...value }))
    .sort((a, b) => b.totalTokens - a.totalTokens)
}

function isWarmupMinimalFacet(facet) {
  const categories = Object.entries(facet.goal_categories || {}).filter(([, count]) => count > 0)
  return categories.length === 1 && categories[0][0] === 'warmup_minimal'
}

function addCounts(target, source) {
  for (const [key, value] of Object.entries(source || {})) {
    if (value > 0) target[key] = (target[key] || 0) + value
  }
}

function buildFacetVersionKey(thread, model) {
  return hashObject({
    schemaVersion: FACET_SCHEMA_VERSION,
    id: thread.id,
    updatedAt: thread.updatedAt,
    model,
    transcript: thread.transcriptForAnalysis,
  })
}

function resolveCacheRoot(explicitDir) {
  if (explicitDir) return path.resolve(explicitDir)
  return path.join(os.homedir(), '.codex-insights-cache')
}

function chunkText(text, chunkSize) {
  const chunks = []
  let start = 0
  while (start < text.length) {
    let end = Math.min(text.length, start + chunkSize)
    if (end < text.length) {
      const lastBreak = text.lastIndexOf('\n', end)
      if (lastBreak > start + chunkSize * 0.6) {
        end = lastBreak
      }
    }
    chunks.push(text.slice(start, end))
    start = end
  }
  return chunks
}

function estimateTokensFromChars(chars) {
  return Math.ceil(Number(chars || 0) / 4)
}

function estimateModelInputTokens({ provider, systemPrompt, userPrompt, schema = null, structured }) {
  const promptText =
    provider === 'codex-cli'
      ? structured
        ? buildStructuredEstimatePrompt(systemPrompt, userPrompt, schema)
        : buildPlainEstimatePrompt(systemPrompt, userPrompt)
      : buildApiEstimatePrompt(systemPrompt, userPrompt, schema, structured)
  return estimateTokensFromChars(promptText.length)
}

function buildPlainEstimatePrompt(systemPrompt, userPrompt) {
  return `${String(systemPrompt || '').trim()}\n\n${String(userPrompt || '').trim()}`
}

function buildStructuredEstimatePrompt(systemPrompt, userPrompt, schema) {
  return `${buildPlainEstimatePrompt(systemPrompt, userPrompt)}\n\nRESPOND WITH ONLY A VALID JSON OBJECT matching this schema:\n${JSON.stringify(schema, null, 2)}`
}

function buildApiEstimatePrompt(systemPrompt, userPrompt, schema, structured) {
  if (!structured) return buildPlainEstimatePrompt(systemPrompt, userPrompt)
  return `${buildPlainEstimatePrompt(systemPrompt, userPrompt)}\n\nJSON schema:\n${JSON.stringify(schema, null, 2)}`
}

function makePlaceholderText(length, prefix = '') {
  const target = Math.max(0, Number(length || 0))
  const seed = prefix ? `${prefix}\n` : ''
  if (seed.length >= target) return seed.slice(0, target)
  return `${seed}${'x'.repeat(Math.max(0, target - seed.length))}`
}

function getNarrativeLanguageInstruction(lang) {
  if (lang === 'zh-CN') {
    return 'Write all free-text narrative fields in Simplified Chinese.'
  }
  return 'Write all free-text narrative fields in English.'
}

function getStructuredLanguageInstruction(lang) {
  if (lang === 'zh-CN') {
    return 'Keep keys and enum values unchanged. Write only free-text fields in Simplified Chinese.'
  }
  return 'Keep keys and enum values unchanged. Write free-text fields in English.'
}

function langFromProviderOptions(options) {
  return options?.lang === 'zh-CN' ? 'zh-CN' : 'en'
}

function describeLanguage(lang) {
  return lang === 'zh-CN' ? 'Simplified Chinese' : 'English'
}

function emitProgress(options, event) {
  if (typeof options?.onProgress === 'function') {
    options.onProgress(event)
  }
}

function sanitizeContextText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

function truncateForContext(value, limit) {
  const text = sanitizeContextText(value)
  if (!text) return ''
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}...`
}

function compactProjectPath(value) {
  const text = String(value ?? '').trim()
  if (!text) return ''
  const parts = text.split('/').filter(Boolean)
  return parts.slice(-2).join('/')
}

function compactCountObject(value, limit) {
  return Object.fromEntries(
    Object.entries(value || {})
      .filter(([, count]) => Number(count) > 0)
      .sort((a, b) => Number(b[1]) - Number(a[1]))
      .slice(0, limit),
  )
}

function compressActiveHours(hourSeries) {
  return [
    { label: 'night', value: sumHours(hourSeries, [0, 1, 2, 3, 4, 5]) },
    { label: 'morning', value: sumHours(hourSeries, [6, 7, 8, 9, 10, 11]) },
    { label: 'afternoon', value: sumHours(hourSeries, [12, 13, 14, 15, 16, 17]) },
    { label: 'evening', value: sumHours(hourSeries, [18, 19, 20, 21, 22, 23]) },
  ]
}

function sumHours(hourSeries, hours) {
  return hours.reduce((sum, hour) => sum + Number(hourSeries[hour]?.value || 0), 0)
}

function compactJson(value) {
  return JSON.stringify(value)
}

function buildFullSectionContext(context) {
  return {
    metadata: context.metadata,
    summary: context.summary,
    charts: context.charts,
    aggregate_facets: context.aggregate_facets,
    session_summaries: context.session_summaries,
    friction_details: context.friction_details,
    user_instructions: context.user_instructions,
    recent_threads: context.recent_threads,
  }
}

function buildSectionContext(context, kind) {
  if (kind === 'at_a_glance') {
    return {
      metadata: context.metadata,
      summary: context.summary,
      aggregate_facets: context.aggregate_facets,
      charts: {
        projects: context.charts.projects,
        tools: context.charts.tools,
        tool_failures: context.charts.tool_failures,
      },
      friction_details: context.friction_details.slice(0, 8),
      recent_threads: context.recent_threads,
    }
  }

  return buildFullSectionContext(context)
}

function compactInsightDigest(insights) {
  return {
    project_areas: (insights.project_areas?.areas || []).slice(0, 4).map(item => ({
      name: item.name,
      sessions: item.session_count,
    })),
    interaction_style: {
      key_pattern: insights.interaction_style?.key_pattern || '',
      narrative: truncateForContext(insights.interaction_style?.narrative || '', 240),
    },
    what_works: (insights.what_works?.impressive_workflows || []).slice(0, 3).map(item => ({
      title: item.title,
      description: truncateForContext(item.description, 160),
    })),
    friction_analysis: (insights.friction_analysis?.categories || []).slice(0, 3).map(item => ({
      category: item.category,
      description: truncateForContext(item.description, 140),
    })),
    suggestions: {
      features: (insights.suggestions?.features_to_try || []).slice(0, 3).map(item => item.feature),
      usage_patterns: (insights.suggestions?.usage_patterns || []).slice(0, 2).map(item => item.title),
      agents_md_additions: (insights.suggestions?.agents_md_additions || []).slice(0, 2).map(item =>
        truncateForContext(item.addition, 120),
      ),
    },
    on_the_horizon: (insights.on_the_horizon?.opportunities || []).slice(0, 3).map(item => ({
      title: item.title,
      whats_possible: truncateForContext(item.whats_possible, 140),
    })),
  }
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

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length)
  let index = 0

  async function worker() {
    while (index < items.length) {
      const current = index
      index += 1
      results[current] = await fn(items[current], current)
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}
