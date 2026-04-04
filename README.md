# codex-session-insights

Generate a report analyzing your Codex sessions.

`codex-session-insights` reads your local Codex history, extracts recurring patterns from your sessions, and renders a narrative report as both HTML and JSON.

![codex-session-insights screenshot](https://raw.githubusercontent.com/cosformula/codex-session-insights/main/assets/screenshot-1.png)

## Quick Start

Run it directly:

```bash
npx codex-session-insights
```

The default flow is:

1. Read your local Codex thread index
2. Estimate likely analysis token usage
3. Let you confirm the plan in an interactive terminal
4. Generate `report.html` and `report.json`
5. Try to open the HTML report in your browser

If you only want the estimate first:

```bash
npx codex-session-insights --estimate-only
```

If you already know what you want and do not want the confirmation flow:

```bash
npx codex-session-insights --yes
```

## What You Get

By default the tool writes:

- `~/.codex/usage-data/report.html`
- `~/.codex/usage-data/report.json`

The HTML report includes these sections:

- `At a Glance`
- `What You Work On`
- `How You Use Codex`
- `Impressive Things You Did`
- `Where Things Go Wrong`
- `Features to Try`
- `On the Horizon`
- `One More Thing`

## Typical Usage

Default run:

```bash
npx codex-session-insights
```

Lite local run for prompt and layout testing:

```bash
npx codex-session-insights --preset lite
```

Estimate first, then decide:

```bash
npx codex-session-insights --days 7 --limit 20 --facet-limit 8 --estimate-only
```

Use a custom output directory:

```bash
npx codex-session-insights --out-dir ./insights-output
```

Emit JSON to stdout instead of a terminal summary:

```bash
npx codex-session-insights --stdout-json
```

Include archived threads:

```bash
npx codex-session-insights --include-archived
```

Include sub-agent threads as well as main threads:

```bash
npx codex-session-insights --include-subagents
```

Choose the report language explicitly:

```bash
npx codex-session-insights --lang zh-CN
npx codex-session-insights --lang en
```

Use the OpenAI API instead of your local Codex CLI login:

```bash
npx codex-session-insights --provider openai --api-key $OPENAI_API_KEY
```

## Defaults

Current default analysis plan:

- `days`: `30`
- `limit`: `200`
- `facet-limit`: `50`
- `provider`: `codex-cli`
- `facet-model`: `gpt-5.4-mini`
- `fast-section-model`: `gpt-5.4-mini`
- `insight-model`: `gpt-5.4`
- `facet-effort`: `low`
- `fast-section-effort`: `low`
- `insight-effort`: `high`

Important behavior defaults:

- `--preset lite` maps to `days=7`, `limit=20`, `facet-limit=8`, `preview=10`
- `limit` means the target number of substantive threads to include in the report, not just the first 50 indexed threads
- `facet-limit` means the max number of uncached per-thread facet analyses to run in a single report
- Report language follows a best-effort system locale check
- Main-thread analysis is the default; sub-agent threads are excluded unless you pass `--include-subagents`
- The CLI shows an estimate before running in interactive terminals
- The CLI tries to open the generated HTML report in your browser after generation

## What It Reads

- `~/.codex/state_*.sqlite` for the thread index
- `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` for rollout events

## Requirements

- Node.js `>=18`
- `sqlite3` available on your system `PATH`
- Codex CLI installed if you use the default `codex-cli` provider

Supported platform status:

- macOS: expected to work
- Linux: expected to work if `sqlite3` and `codex` are installed
- Windows: not yet verified

## Privacy

The tool reads local Codex data from your machine.

- With `provider=codex-cli`, analysis is performed through your local Codex CLI session
- With `provider=openai`, prompts are sent through the OpenAI Responses API
- Generated reports may contain project paths, thread titles, summaries, and other local development context

Review `report.html` and `report.json` before sharing them.

## Limitations

- Rollout event schemas may drift across Codex versions
- Token estimates are conservative, not billing-accurate
- The tool is designed around Codex local storage layout and is not a generic agent log analyzer
- Windows support is not yet verified

## Advanced Overrides

If you want to override the default model split manually:

```bash
npx codex-session-insights \
  --facet-model gpt-5.4-mini \
  --fast-section-model gpt-5.4-mini \
  --insight-model gpt-5.4 \
  --facet-effort low \
  --fast-section-effort low \
  --insight-effort high
```

To suppress browser opening:

```bash
npx codex-session-insights --no-open
```

To force browser opening:

```bash
npx codex-session-insights --open
```

## For Contributors

Useful local commands:

```bash
npm install
npm test
npm run check
npm run report:lite
npm run generate:test-report
```

`npm run report:lite` runs a smaller local analysis preset for testing prompt and layout changes without paying the full 200/50 default cost.
`npm run generate:test-report` writes a deterministic sample report page to `test-artifacts/sample-report/`.
