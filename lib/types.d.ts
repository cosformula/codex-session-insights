export interface CountMap {
  [key: string]: number
}

export interface SessionSummary {
  id: string
  title: string
  cwd: string
  model?: string
  archived?: boolean
  updatedAt: string
  durationMinutes: number
  userMessages: number
  assistantMessages: number
  totalToolCalls: number
  totalCommandFailures: number
  totalTokens: number
  totalGitCommits: number
  totalToolErrors: number
  filesModified: number
  linesAdded: number
  linesRemoved: number
  userInterruptions: number
  usesTaskAgent: boolean
  usesMcp: boolean
  usesWebSearch: boolean
  usesWebFetch: boolean
  toolCounts: CountMap
  toolFailures: CountMap
  firstUserMessage?: string
  transcriptForAnalysis?: string
}

export interface SessionFacet {
  threadId: string
  title: string
  cwd: string
  updatedAt: string
  durationMinutes: number
  userMessages: number
  assistantMessages: number
  totalToolCalls: number
  totalCommandFailures: number
  underlying_goal: string
  goal_categories: CountMap
  outcome: string
  user_satisfaction_counts: CountMap
  assistant_helpfulness: string
  session_type: string
  friction_counts: CountMap
  friction_detail: string
  primary_success: string
  brief_summary: string
  user_instructions: string[]
}

export interface UsageCounter {
  calls: number
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  totalTokens: number
}

export interface AnalysisUsage {
  total: UsageCounter
  byModel: Array<UsageCounter & { label: string }>
  byStage: Array<UsageCounter & { label: string }>
}

export interface AtAGlance {
  whats_working: string
  whats_hindering: string
  quick_wins: string
  ambitious_workflows: string
}

export interface InsightsSections {
  at_a_glance: AtAGlance
  project_areas: unknown
  interaction_style: unknown
  what_works: unknown
  friction_analysis: unknown
  suggestions: unknown
  on_the_horizon: unknown
  fun_ending: unknown
}
