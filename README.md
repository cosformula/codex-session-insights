# codex-session-insights

Generate a report analyzing your Codex sessions.

`codex-session-insights` reads your local Codex thread registry and rollout logs, extracts per-session facets, and renders a narrative report as both JSON and HTML.

## What It Reads

- `~/.codex/state_*.sqlite` for the thread registry
- `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` for rollout events

## What It Writes

- `~/.codex/usage-data/report.json` by default
- `~/.codex/usage-data/report.html` by default

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
npx codex-session-insights report --estimate-only
```

For local development:

```bash
node ./bin/codex-insights.js report --estimate-only
```

## Recommended Flow

1. Estimate first

```bash
npx codex-session-insights report \
  --days 7 \
  --limit 20 \
  --facet-limit 8 \
  --preview 10 \
  --estimate-only
```

2. If the estimate looks reasonable, run the full report

```bash
npx codex-session-insights report \
  --days 7 \
  --limit 20 \
  --facet-limit 8 \
  --preview 10
```

## Common Usage

Default provider uses your logged-in Codex CLI:

```bash
npx codex-session-insights report
```

In an interactive terminal, the CLI now shows a lightweight confirmation flow first:

- it starts from a default plan
- shows the estimate before analysis
- lets you `Start`, `Adjust settings`, or `Exit`

It defaults the report language from a best-effort system locale check. Use `--lang en`, `--lang zh-CN`, or `CODEX_REPORT_LANG=...` to override it.

After generation, the CLI will try to open `report.html` in your browser. Use `--no-open` to suppress that, or `--open` to force it.

A few useful variants:

```bash
npx codex-session-insights report --days 90 --limit 200
npx codex-session-insights report --out-dir ./insights-output
npx codex-session-insights report --stdout-json
npx codex-session-insights report --include-archived
npx codex-session-insights report --provider openai --api-key $OPENAI_API_KEY
```

Model overrides:

```bash
npx codex-session-insights report \
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

The pipeline uses a two-stage session analysis flow:

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
npm install
npm test
npm run check
npm run typecheck
npm run generate:test-report
node ./bin/codex-insights.js report --help
```

`npm run generate:test-report` writes a deterministic sample report page to `test-artifacts/sample-report/` so you can visually inspect the HTML without using live local Codex data.

TypeScript migration status:

- Runtime code remains JavaScript for now
- `tsconfig.json` enables `checkJs` so the project can adopt TypeScript incrementally
- Core report/session shapes live in [lib/types.d.ts](/Users/zhaoyiqun/Projects/claude-code-main/codex-insights/lib/types.d.ts)
- Interactive CLI design lives in [docs/interactive-flow.md](/Users/zhaoyiqun/Projects/claude-code-main/codex-insights/docs/interactive-flow.md)

## Publishing

If the npm package name `codex-session-insights` is available, publish flow is:

```bash
npm login
npm run check
npm pack --dry-run
npm publish
```

The package metadata points at `cosformula/codex-session-insights`:

- repository: `https://github.com/cosformula/codex-session-insights`
- issues: `https://github.com/cosformula/codex-session-insights/issues`

Internal design docs and local development overlays are intentionally outside the public package boundary.
