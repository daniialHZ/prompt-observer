# Prompt Observer

Prompt Observer is a dependency-free observability kit for professional coding-agent workflows. It gives an agent a clear contract: after each task, evaluate the prompt, show a short insight, and save a privacy-safe structured event locally.

It is designed for Vibe Coding workflows and works without a browser extension, a local model, or an additional AI API. The agent already completing the task creates the observation.

[View the package on npm](https://www.npmjs.com/package/@onthink/prompt-observer)

## What it records

- Prompt-quality dimensions: clarity, context, scope, constraints, acceptance criteria, and verification plan
- Structured strengths, actionable weaknesses, and improvement suggestions
- Observed execution signals: result status, changed files, and test outcomes
- Exact platform usage when available, otherwise clearly labeled token estimates and model-matched cost estimates

Raw prompts, raw responses, private reasoning, system instructions, and secrets are prohibited from the event format.

Prompt Observer does not force criticism. A clear, sufficient prompt receives no fabricated weakness or subjective style advice; its `weaknesses` and `improvement_suggestions` arrays remain empty.

## Requirements

- Node.js 20 or newer
- A coding agent that can read project instructions
- Filesystem access by the agent for automatic event persistence

## Quick start

Initialize Prompt Observer in any target project:

```powershell
cd "E:\path\to\your-project"
npx @onthink/prompt-observer init .
```

`init` adds a portable local CLI under `.prompt-observer`, so the target project can log events and generate reports without a global installation.

Then add the following one-line instruction to the target project's existing agent-instruction file:

```md
Read and follow `.prompt-observer/PROMPT_OBSERVER.md` after every user-requested task.
```

Prompt Observer does not modify vendor-specific instruction files in v1. Add the line to whichever project-instruction mechanism your agent already uses.

## How it works

```text
User request → Coding agent completes the task → Agent evaluates the prompt
              → Validated JSONL event → Local Markdown report
```

Each initialized project receives:

```text
.prompt-observer/
  PROMPT_OBSERVER.md       Agent contract
  event.schema.json        Versioned event schema
  prompt-observer.mjs      Portable local CLI
  events.jsonl             Generated append-only event log
  pricing.json             Versioned model-pricing snapshot
  report.md                Compact GitHub-friendly report
  report.html              Interactive offline dashboard
```

The generated log and reports are excluded by the local `.prompt-observer/.gitignore`; the contract, schema, and pricing snapshot can safely be committed.

## Automatic behavior

After the project instruction is added, the coding agent handles event creation and logging after each task. You do **not** need to run `validate` or `log` yourself during normal use.

The agent creates a temporary event, validates it, appends it to `.prompt-observer/events.jsonl`, and removes the temporary file after a successful save.

## View reports

Generate reports from the latest 50 events:

```powershell
node .prompt-observer/prompt-observer.mjs report .
```

This creates `.prompt-observer/report.md` and `.prompt-observer/report.html`. The Markdown report is a compact repository-friendly summary. The self-contained HTML dashboard adds KPI cards, quality and trend charts, filters, recurring strengths, weaknesses, improvement suggestions, verification results, and usage coverage. It embeds only the selected window's already-redacted analytical fields, not changed-file lists or test names.

Choose another bounded window or explicitly analyze all events:

```powershell
node .prompt-observer/prompt-observer.mjs report . --limit 100
node .prompt-observer/prompt-observer.mjs report . --all
```

The default reader streams the JSONL history and retains only the latest 50 events plus the previous 50-event comparison window. The complete append-only log remains available without making the generated reports grow forever.

## Usage accuracy and estimates

Prompt Observer uses this precedence:

1. Metrics explicitly reported by the Agent platform are stored as `platform_reported`.
2. When the platform exposes no usage but the Agent can see the input and final response, token counts are estimated with the documented `agent_text_heuristic_v1` method.
3. Estimated cost is calculated only when the runtime reports an exact model ID that exists in the local versioned `pricing.json` snapshot.
4. Unknown values remain `null` and are reported as unavailable.

The dashboard always separates exact, estimated, and unavailable values. Cost estimates exclude cached tokens, tools, subscription pricing, discounts, long-context premiums, and provider-specific charges, so they must not be treated as invoices.

## Manual event troubleshooting (advanced)

`validate` and `log` are diagnostic commands for a temporary event that an agent has already created. They are not part of the normal setup or daily workflow, and `example.json` is not created by `init`.

Use them only when inspecting a real pending event before it is logged:

```powershell
node .prompt-observer/prompt-observer.mjs validate .prompt-observer/pending/<event-id>.json
node .prompt-observer/prompt-observer.mjs log .prompt-observer/pending/<event-id>.json
```

## No-filesystem fallback

When an agent cannot write files, the contract requires it to show the three-line insight and return a complete valid JSON event in a fenced `json` block. It must state that the event was not persisted. A later extension or integration can capture that output automatically.

## npm package

Prompt Observer is published as [`@onthink/prompt-observer`](https://www.npmjs.com/package/@onthink/prompt-observer).

Use it without installing it globally:

```powershell
npx @onthink/prompt-observer init .
```

Running `init` again is safe: it preserves existing Prompt Observer files and adds only missing files.

## Development

```powershell
npm run check
npm test
```

`prepublishOnly` runs both checks automatically before `npm publish`. The package is published publicly under the `@onthink` scope. The project uses only Node.js built-ins; JSONL remains the source of truth, while SQLite export is intentionally deferred.

## License

[MIT](LICENSE)
