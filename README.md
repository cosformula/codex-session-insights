# codex-insights

Generate a Claude Code `/insights` style report from local Codex session data.

`codex-insights` reads your local Codex thread registry and rollout logs, extracts per-session facets, and renders a narrative usage report as both JSON and HTML.

## What It Reads

- `~/.codex/state_*.sqlite` for the thread registry
- `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` for rollout events

## What It Writes

- `report.json`
- `report.html`

## Requirements

- Node.js `>=18`
- `sqlite3` available on your system `PATH`
- Codex CLI installed if you use the default `codex-cli` provider

Supported platform status:

- macOS: expected to work
- Linux: expected to work if `sqlite3` and `codex` are installed
- Windows: not yet verified

## Install

After publishing:

```bash
npx codex-insights report --estimate-only
```

For local development:

```bash
node ./bin/codex-insights.js report --estimate-only
```

## Recommended Flow

1. Estimate first

```bash
npx codex-insights report \
  --days 7 \
  --limit 20 \
  --facet-limit 8 \
  --preview 10 \
  --estimate-only
```

2. If the estimate looks reasonable, run the full report

```bash
npx codex-insights report \
  --days 7 \
  --limit 20 \
  --facet-limit 8 \
  --preview 10
```

## Common Usage

Default provider uses your logged-in Codex CLI:

```bash
npx codex-insights report
```

A few useful variants:

```bash
npx codex-insights report --days 90 --limit 200
npx codex-insights report --out-dir ./insights-output
npx codex-insights report --stdout-json
npx codex-insights report --include-archived
npx codex-insights report --provider openai --api-key $OPENAI_API_KEY
```

Model overrides:

```bash
npx codex-insights report \
  --facet-model gpt-5.3-codex-spark \
  --fast-section-model gpt-5.3-codex-spark \
  --insight-model gpt-5.4 \
  --facet-effort low \
  --fast-section-effort low \
  --insight-effort medium
```

## Output

The HTML report currently generates these sections:

- `at_a_glance`
- `project_areas`
- `interaction_style`
- `what_works`
- `friction_analysis`
- `suggestions`
- `on_the_horizon`
- `fun_ending`

`report.json` also includes:

- aggregate usage stats
- thread summaries
- extracted facets
- actual analysis token usage
- analysis token estimate metadata

## Providers

- `codex-cli` (default): uses `codex exec --json ...` and your existing Codex login
- `openai`: uses the Responses API directly and requires `OPENAI_API_KEY`

Current default model split:

- `facet-model`: `gpt-5.3-codex-spark`
- `fast-section-model`: `gpt-5.3-codex-spark`
- `insight-model`: `gpt-5.4`

Current default reasoning split:

- `facet-effort`: `low`
- `fast-section-effort`: `low`
- `insight-effort`: `medium`

## How It Works

The pipeline follows the same broad shape as Claude Code `/insights`:

1. Load thread metadata from `state_*.sqlite`
2. Reuse cached session summaries from `~/.codex-insights-cache/session-meta`
3. Parse rollout JSONL only for uncached threads
4. Filter to substantive sessions before facet extraction
5. Reuse cached facets from `~/.codex-insights-cache/facets`
6. Analyze only uncached substantive sessions, capped by `--facet-limit`
7. Summarize long transcripts before facet extraction
8. Filter out `warmup_minimal` sessions after facets are available
9. Estimate likely analysis token usage before execution
10. Generate report sections in parallel
11. Generate `At a Glance` after the other sections are complete

## Privacy

The tool reads local Codex data from your machine.

- With `provider=codex-cli`, analysis is performed through your local Codex CLI session
- With `provider=openai`, prompts are sent through the OpenAI Responses API
- Generated reports may contain project paths, thread titles, summaries, and other local development context

Review `report.html` and `report.json` before sharing them.

## Limitations

- Rollout event schemas may drift across Codex versions
- Windows support is not yet verified
- Token estimates are intentionally conservative, not billing-accurate
- The tool is designed around Codex local storage layout and is not a generic agent log analyzer

## Development

Useful local commands:

```bash
npm run check
node ./bin/codex-insights.js report --help
```

Internal design docs and local development overlays are intentionally outside the public package boundary.
# codex-session-insights
