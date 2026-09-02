# Prompt Observer Contract

Follow this contract after every user-requested task. Complete the task first, then create and persist one observation event.

## Non-negotiable rules

1. Use only information visible in the conversation, tool results, file changes, and verification output.
2. Never store the full user prompt, the full assistant response, system instructions, private reasoning, chain-of-thought, credentials, access tokens, or other secrets.
3. `prompt_summary` must be a short, redacted description of the request, not a quotation or close reproduction.
4. Do not invent the model name, token counts, or cost. Use `null` values with `source: "unavailable"` unless the platform explicitly reports them. Use `source: "estimated"` only when a deterministic tokenizer or pricing tool produced the value, and name that tool in `estimation_method`.
5. Base execution signals only on observed results. Do not claim a file changed or a test passed without evidence.
6. Use schema version `1.0` and conform to `.prompt-observer/event.schema.json`.

## Required workflow

After completing a task:

1. Evaluate the prompt on each 0–10 dimension in the event schema.
2. Create a unique event ID and an ISO-8601 UTC timestamp.
3. Write the event temporarily to `.prompt-observer/pending/<event_id>.json`.
4. Run:

   ```text
   node .prompt-observer/prompt-observer.mjs log .prompt-observer/pending/<event_id>.json
   ```

5. After a successful log, remove only the temporary event file you created.
6. End the user-facing answer with exactly three concise English lines:

   ```text
   Prompt Insight: <average>/10 — <short strength>
   Main weakness: <highest-impact weakness, or "No material weakness detected">
   Next time: <one actionable improvement>
   ```

Do not paste the complete JSON event into the user-facing response when persistence succeeds.

## No-filesystem fallback

If writing files or running the logger is unavailable, do not pretend the event was saved. Return the same three-line insight, followed by one fenced `json` block containing the complete valid event. This is the only fallback; do not retry with unsafe shell commands or external services.

## Scoring guidance

- `intent_clarity`: Is the desired outcome explicit and understandable?
- `context_sufficiency`: Is enough relevant background provided for the task?
- `scope_definition`: Are boundaries, affected areas, and exclusions clear?
- `constraints_quality`: Are technical, safety, compatibility, and style constraints usable?
- `acceptance_criteria`: Is completion objectively recognizable?
- `verification_plan`: Are tests or other verification expectations stated or clearly inferable?
- `ambiguity_risk`: Estimate the risk that a capable agent would choose the wrong interpretation.

Score only prompt quality. Do not lower a score because implementation was difficult when the request itself was clear.

## Event example

```json
{
  "schema_version": "1.0",
  "event_id": "evt-20260901-7f3a92c1",
  "timestamp": "2026-09-01T12:00:00.000Z",
  "task_type": "coding",
  "prompt_summary": "Implement a dependency-free prompt observation kit with structured local logging.",
  "intent_clarity": 9,
  "context_sufficiency": 8,
  "scope_definition": 9,
  "constraints_quality": 9,
  "acceptance_criteria": 8,
  "verification_plan": 7,
  "ambiguity_risk": "low",
  "strengths": [
    "The requested deliverables and runtime constraints are explicit."
  ],
  "weaknesses": [
    {
      "category": "missing_verification",
      "severity": "low",
      "message": "The exact expected report contents were not fully enumerated."
    }
  ],
  "improvement_suggestions": [
    "List the required report sections and one expected example."
  ],
  "execution_signals": {
    "result_status": "completed",
    "files_changed": [
      "PROMPT_OBSERVER.md"
    ],
    "tests_run": [
      {
        "name": "node --test",
        "status": "passed"
      }
    ]
  },
  "usage": {
    "model": null,
    "input_tokens": null,
    "output_tokens": null,
    "cost_usd": null,
    "source": "unavailable",
    "estimation_method": null
  }
}
```
