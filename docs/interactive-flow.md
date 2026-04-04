# Interactive Report Flow

This document defines the interactive CLI flow for `codex-session-insights`.

The goal is to make report generation feel controlled and reviewable before model spend begins.

## Product Goal

The current direct-run CLI is efficient for scripts, but weak for human-first usage:

- users do not know how much data will be analyzed
- users do not know likely token cost until after running flags manually
- users do not explicitly choose language, scope, or output behavior
- users have little confidence that the run matches their intent

The interactive flow should solve that.

## Core Principle

The default human flow should be:

1. configure scope
2. configure report behavior
3. show estimated cost
4. require explicit confirmation
5. run with visible progress

Non-interactive execution should still exist for scripts and automation.

## Command Strategy

Recommended CLI behavior:

- `codex-session-insights report`
  Default interactive flow when stdout is a TTY.
- `codex-session-insights report --yes`
  Run immediately using provided flags and defaults.
- `codex-session-insights report --non-interactive`
  Alias for script mode. No prompts.
- `codex-session-insights report --estimate-only`
  Print the estimate and exit.

TTY-aware default:

- TTY: interactive by default
- non-TTY / CI: non-interactive by default

This keeps shell pipelines stable while making direct human usage safer.

## Flow Overview

The recommended flow has five steps.

### 1. Scope

Choose time range:

- Last 7 days
- Last 30 days
- Last 90 days
- Custom days

Choose analysis depth:

- Conservative
  - `--limit 20`
  - `--facet-limit 8`
- Standard
  - `--limit 50`
  - `--facet-limit 20`
- Deep
  - `--limit 200`
  - `--facet-limit 50`
- Custom

Rationale:

- most users care about "how much history" and "how deep"
- these are easier to understand than raw thread and facet caps

### 2. Report Settings

Choose report language:

- English
- 简体中文

Choose output behavior:

- output directory
  - default: `~/.codex/usage-data`
- open report in browser after generation
  - yes
  - no

Optional:

- include archived threads

### 3. Analysis Plan

Choose model preset:

- Balanced
  - facet: `gpt-5.3-codex-spark`
  - fast sections: `gpt-5.3-codex-spark`
  - final sections: `gpt-5.4`
- Cheaper
  - push more section work to `gpt-5.3-codex-spark`
- Higher Quality
  - use `gpt-5.4` more aggressively

Choose reasoning preset:

- Low Cost
- Balanced
- Deeper

Advanced options should be hidden behind an explicit "advanced" branch instead of shown by default.

### 4. Estimate And Confirm

Show a human-readable summary before any analysis run:

- date range
- thread limit
- facet limit
- language
- provider
- output directory
- browser open behavior
- planned calls
- substantive threads
- uncached facets
- long transcripts
- estimated input tokens
- estimated output tokens
- estimated total range

Example:

```text
Plan Summary
30 days, Standard depth, English report
Output: ~/.codex/usage-data
Provider: codex-cli

Estimated Analysis Cost
0.16M to 0.27M tokens likely
planned calls=42 | substantive threads=11 | uncached facets=8 | long transcripts=6
input≈0.19M tokens | output≈0.01M tokens
```

Actions:

- Start analysis
- Adjust settings
- Exit

This is the most important screen in the flow.

### 5. Run

Show lightweight progress, not a full-screen dashboard.

Recommended progress stages:

- loading thread index
- reading cached session summaries
- planning facet extraction
- extracting facets `n / total`
- generating sections `n / total`
- writing report files
- opening browser

Do not build a complex ncurses-style UI.

## Equivalent Command

After the confirmation screen, print an equivalent command.

Example:

```bash
codex-session-insights report --days 30 --limit 50 --facet-limit 20 --lang zh-CN --no-open --yes
```

This helps:

- reproducibility
- scripts
- debugging
- user confidence

## Parameter Mapping

The interactive flow should map cleanly onto CLI flags.

Recommended flags:

- `--days <n>`
- `--limit <n>`
- `--facet-limit <n>`
- `--lang <code>`
- `--out-dir <path>`
- `--include-archived`
- `--open`
- `--no-open`
- `--provider <name>`
- `--facet-model <name>`
- `--fast-section-model <name>`
- `--insight-model <name>`
- `--facet-effort <level>`
- `--fast-section-effort <level>`
- `--insight-effort <level>`
- `--yes`
- `--non-interactive`

Recommended additions:

- `--preset conservative|standard|deep`
- `--quality cheaper|balanced|higher`

These are not required internally, but they make the CLI easier to explain.

## Language Behavior

Language should be an explicit report configuration.

Recommended values:

- `en`
- `zh-CN`

Language should affect:

- section generation prompts
- `At a Glance`
- HTML labels and section headings
- terminal summaries where appropriate

It should not change:

- internal cache keys except where prompt output changes materially
- event parsing
- estimation logic

## Default Behavior

Recommended defaults:

- TTY shell:
  - interactive by default
- CI / non-TTY:
  - non-interactive by default
- browser open:
  - yes for TTY
  - no for CI / non-TTY
- output path:
  - `~/.codex/usage-data`
- scope preset:
  - Standard
- quality preset:
  - Balanced

## Why Not A Full TUI

Do not start with a full-screen terminal UI.

Reasons:

- higher implementation cost
- harder testing
- worse scriptability
- more fragile on different terminals
- unnecessary for this job

The better initial implementation is a wizard-style prompt flow plus plain progress output.

## Suggested Implementation Order

1. Add `--yes`, `--non-interactive`, and `--lang`
2. Make TTY default to interactive mode
3. Implement wizard prompts for scope, language, output, and quality preset
4. Reuse existing estimate logic in the confirm step
5. Add equivalent command rendering
6. Add progress stage logging
7. Add tests for prompt-to-options mapping

## Testing Strategy

The interactive layer should be tested separately from report generation.

Recommended tests:

- preset -> option mapping
- language selection -> prompt option mapping
- TTY vs non-TTY default mode selection
- confirmation flow exits cleanly without analysis
- equivalent command rendering

The wizard should remain a thin wrapper around the existing analysis pipeline.

## Non-Goals

This flow should not:

- replace script mode
- hide all advanced flags
- become a terminal dashboard
- run analysis before the estimate screen
- make irreversible changes without confirmation

## Decision Summary

The preferred design is:

- interactive by default for humans
- non-interactive by default for automation
- estimate-before-run is mandatory in interactive mode
- use a prompt wizard, not a full TUI
- keep all decisions translatable back into normal CLI flags
