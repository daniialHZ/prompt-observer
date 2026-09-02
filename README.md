# Prompt Observer

Prompt Observer is a dependency-free observability kit for professional coding-agent workflows. It gives an agent a clear contract: after each task, evaluate the prompt, show a short insight, and save a privacy-safe structured event locally.

It is designed for Vibe Coding workflows and works without a browser extension, a local model, or an additional AI API. The agent already completing the task creates the observation.

## What it records

- Prompt-quality dimensions: clarity, context, scope, constraints, acceptance criteria, and verification plan
- Actionable weaknesses and improvement suggestions
- Observed execution signals: result status, changed files, and test outcomes
- Model, token, and cost information only when the platform explicitly provides it

Raw prompts, raw responses, private reasoning, system instructions, and secrets are prohibited from the event format.

## Requirements

- Node.js 20 or newer
- A coding agent that can read project instructions
- Filesystem access by the agent for automatic event persistence

## Quick start

Clone this repository and initialize Prompt Observer in a target project:

```powershell
git clone <your-repository-url>
cd prompt-observer
node bin/prompt-observer.mjs init "E:\path\to\your-project"
```

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

## npm package — coming soon

The project is configured for npm packaging, but it is **not published yet**. The final package name will be chosen before release, preferably as a scoped name such as `@your-npm-username/prompt-observer`.

After publication, the intended installation flow will be:

```powershell
npx @your-npm-username/prompt-observer init .
```

Before publishing, replace `@your-npm-username` with your real npm scope and configure the repository URL in `package.json`.

## Development

```powershell
npm run check
npm test
```

`prepublishOnly` runs both checks automatically before `npm publish`. The package uses only Node.js built-ins; JSONL is the source of truth for v1, while SQLite export is intentionally deferred to a later release.

## License

[MIT](LICENSE)
