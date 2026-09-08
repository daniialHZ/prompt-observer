# Prompt Observer

Prompt Observer is a dependency-free observability kit for professional coding-agent workflows. It gives an agent a clear contract: after each task, evaluate the prompt, show a short insight, and save a privacy-safe structured event locally.

It is designed for Vibe Coding workflows and works without a browser extension, a local model, or an additional AI API. The agent already completing the task creates the observation.

[View the package on npm](https://www.npmjs.com/package/@onthink/prompt-observer)

## What it records

- Prompt-quality dimensions: clarity, context, scope, constraints, acceptance criteria, and verification plan
- Actionable weaknesses and improvement suggestions
- Observed execution signals: result status, changed files, and test outcomes
- Model, token, and cost information only when the platform explicitly provides it

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
  report.md                Generated analysis report
```

The generated log and report are excluded by the local `.prompt-observer/.gitignore`; the contract and schema can safely be committed.

## Commands

Run these commands inside an initialized project:

```powershell
# Check an event before saving it
node .prompt-observer/prompt-observer.mjs validate .prompt-observer/pending/example.json

# Validate and append an event to the local JSONL log
node .prompt-observer/prompt-observer.mjs log .prompt-observer/pending/example.json

# Generate the aggregate Markdown report
node .prompt-observer/prompt-observer.mjs report .
```

The report includes average prompt health, recurring weaknesses, ambiguity risk, execution outcomes, verification trends, and platform-reported usage totals.

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

`prepublishOnly` runs both checks automatically before `npm publish`. The package is published publicly under the `@onthink` scope. The project uses only Node.js built-ins; JSONL is the source of truth for v1, while SQLite export is intentionally deferred to a later release.

## License

[MIT](LICENSE)
